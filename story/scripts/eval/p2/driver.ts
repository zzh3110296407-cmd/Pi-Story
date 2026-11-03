import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ModelRuntime as ModelRuntimeType } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { BranchEntry } from "@pi-story/core";
import { schemas, validate } from "../../../packages/core/src/schema/index.ts";
import { coreDetails } from "../../../packages/pi-story/src/entries.ts";
import { installStory } from "../../../packages/pi-story/src/index.ts";
import { piModelOverrides } from "../../prepare-p2.mjs";
import type { EvidenceArchive } from "./artifacts.ts";
import type { UsageLedger } from "./ledger.ts";
import { instrumentRuntime } from "./metering.ts";
import { evaluationSettings, type ModelSetting } from "./model-settings.ts";
import { RunControl } from "./run-control.ts";

interface DriverOptions {
	work: string;
	runId: string;
	caseId: string;
	suiteId: "P2-OPEN" | "P2-CHAP" | "P2-KEEP" | "P2-EDIT";
	archive: EvidenceArchive;
	ledger: UsageLedger;
	runLimitUsd: number;
	phase: "E12" | "E13" | "faux";
	model?: string;
	modelSetting?: ModelSetting;
	configureRuntime?: (runtime: ModelRuntimeType) => void;
	maxChapters?: number;
	control?: RunControl;
}
export async function createDriver(options: DriverOptions) {
	const control = options.control ?? new RunControl();
	control.assertActive();
	const cancellation = new AbortController();
	const agentDir = path.join(options.work, "agent");
	mkdirSync(agentDir, { recursive: true });
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const restoreEnvironment = () => {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
	};
	let cleanup = restoreEnvironment;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const configured = evaluationSettings(options.work, options.suiteId, options.modelSetting);
		const modelId = options.model ?? configured.showrunner.model;
		if (options.phase !== "faux" && !process.env.DEEPSEEK_API_KEY)
			throw new Error("DEEPSEEK_API_KEY is absent; no model request made");
		if (options.phase !== "faux" && options.model) throw new Error("Use an approved role model setting");
		const settings = configured.settings;
		settings.defaultBudget.costUsd = options.runLimitUsd;
		if (options.phase === "faux") for (const role of Object.values(settings.roles)) role.model = modelId;
		writeFileSync(path.join(agentDir, "story-forge.json"), `${JSON.stringify(settings, null, 2)}\n`);
		const modelsPath = path.join(agentDir, "models.json");
		writeFileSync(modelsPath, `${JSON.stringify(piModelOverrides(), null, 2)}\n`);
		const runtime = await ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
			modelsPath,
			allowModelNetwork: false,
		});
		options.configureRuntime?.(runtime);
		const model = runtime.getModel(modelId.slice(0, modelId.indexOf("/")), modelId.slice(modelId.indexOf("/") + 1));
		if (!model) throw new Error("Requested model missing from fixed Pi catalog");
		const emit = (record: { type: string; [key: string]: unknown }) =>
			options.archive.emit({ ...record, caseId: options.caseId });
		emit({
			type: "model",
			model: modelId,
			thinking: configured.showrunner.thinking,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			cost: model.cost,
			roles: settings.roles,
		});
		const restoreMeter = instrumentRuntime(runtime, {
			ledger: options.ledger,
			suiteId: options.suiteId,
			runId: options.runId,
			runLimitUsd: options.runLimitUsd,
			allowFaux: options.phase === "faux",
			control,
			roleSettings: {
				showrunner: { model: modelId, thinking: configured.showrunner.thinking },
				writer: { model: settings.roles.writer.model, thinking: "low" },
				editor: { model: settings.roles.editor.model, thinking: "low" },
				keeper: { model: settings.roles.keeper.model, thinking: "low" },
			},
			emit,
		});
		cleanup = () => {
			restoreMeter();
			restoreEnvironment();
		};
		const piSettings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		let app: ReturnType<typeof installStory> | undefined;
		const manager = SessionManager.create(options.work, path.join(options.work, "sessions"));
		const before = new Map<string, BranchEntry[]>();
		const resources = new DefaultResourceLoader({
			cwd: options.work,
			agentDir,
			settingsManager: piSettings,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				(pi) => {
					app = installStory(pi, {
						observe: ({ payload: _payload, ...call }) => emit({ type: "role_call", ...call }),
						checkpoint: (event) => emit({ type: "role_checkpoint", ...event }),
					});
					pi.on("message_end", (event, ctx) => {
						if (event.message.role !== "toolResult") return;
						const details = coreDetails(event.message.toolName, event.message.details);
						if (options.suiteId === "P2-OPEN" && validate(schemas.OutlineDetails, details).ok && !event.message.isError)
							ctx.abort();
						if (options.suiteId === "P2-CHAP" && options.maxChapters && !event.message.isError) {
							const macro = validate(schemas.MacroDetails, details);
							if (macro.ok && macro.value.ok && macro.value.commit && macro.value.commit.chapter >= options.maxChapters)
								ctx.abort();
						}
					});
				},
			],
		});
		await resources.reload();
		const { session, extensionsResult } = await createAgentSession({
			cwd: options.work,
			agentDir,
			modelRuntime: runtime,
			resourceLoader: resources,
			settingsManager: piSettings,
			sessionManager: manager,
			noTools: "builtin",
			model,
			thinkingLevel: configured.showrunner.thinking,
		});
		cleanup = () => {
			session.dispose();
			restoreMeter();
			restoreEnvironment();
		};
		if (extensionsResult.errors.length) throw new Error("Story extension failed to load");
		const errors: string[] = [];
		await session.bindExtensions({
			mode: "print",
			onError: (event) => {
				errors.push(event.error);
				emit({ type: "extension_error", diagnostic: event.error });
			},
		});
		if (!app) throw new Error("Story extension instance missing");
		const story = app;
		session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "write_next_chapter") {
				// Use the same neutral entries as the product's actual BranchSource.
				const branch = manager.getBranch();
				const translated = storyState().source.branch();
				before.set(event.toolCallId, translated);
				emit({
					type: "tool_start",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					entries: translated,
					piLeaf: branch.at(-1)?.id,
				});
			}
			if (event.type === "message_end" && event.message.role === "toolResult") {
				emit({ type: "tool_result", message: event.message });
				const checked = validate(schemas.MacroDetails, event.message.details);
				if (checked.ok) {
					const draft = checked.value.drafts?.at(-1);
					const entries = [...(before.get(event.message.toolCallId) ?? [])];
					if (checked.value.intent)
						entries.push({
							kind: "toolResult",
							entryId: `@evaluation:${event.message.toolCallId}:intent`,
							toolName: "set_chapter_intent",
							isError: false,
							details: checked.value.intent,
						});
					if (draft) emit({ type: "role_task", toolCallId: event.message.toolCallId, entries, draft });
				}
			}
		});
		// get() needs only the read-only manager and the registry already bound by session_start;
		// keep the actual state from that event rather than synthesizing an ExtensionContext.
		function storyState() {
			const state = story.current();
			if (!state) throw new Error("Story session has not started");
			return state;
		}
		return {
			session,
			manager,
			runtime,
			model,
			settings,
			errors,
			control,
			state: storyState,
			signal: cancellation.signal,
			cancel() {
				cancellation.abort();
				void session.abort();
			},
			close() {
				try {
					const file = manager.getSessionFile();
					if (file && existsSync(file)) options.archive.session(options.caseId, file);
				} finally {
					cleanup();
				}
			},
		};
	} catch (cause) {
		cleanup();
		throw cause;
	}
}
