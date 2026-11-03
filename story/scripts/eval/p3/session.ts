import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	type Api,
	type Context,
	getCurrentSystemPrompt,
	type Model,
	type SimpleStreamOptions,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	AgentSessionRuntime,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { BranchEntry } from "@pi-story/core";
import { schemas, validate } from "../../../packages/core/src/schema/index.ts";
import { wordCount } from "../../../packages/core/src/shared/text.ts";
import { installStory } from "../../../packages/pi-story/src/index.ts";
import type { StoryRuntime } from "../../../packages/pi-story/src/session.ts";
import { settingsTemplate } from "../../prepare-p2.mjs";
import { EvidenceArchive, sha256 } from "../p2/artifacts.ts";
import type { UsageLedger } from "../p2/ledger.ts";
import type { EvidenceRecord } from "../p2/metering.ts";
import { instrumentRuntime } from "../p2/metering.ts";
import type { RunControl } from "../p2/run-control.ts";
import { type LocalReply, scenarioProvider } from "./faux.ts";

export type Phase = "preparation" | "measurement" | "driver_probe";
export function requestRole(context: Context): "showrunner" | "writer" | "editor" | "keeper" {
	const system =
		"systemPrompt" in context && typeof context.systemPrompt === "string"
			? context.systemPrompt
			: getCurrentSystemPrompt(context.messages);
	return system.includes("name: story-long-writing\n")
		? "writer"
		: system.includes("name: story-review-matrix\n")
			? "editor"
			: system.includes("name: story-state-projection\n")
				? "keeper"
				: "showrunner";
}
export interface SessionOptions {
	stage?: "P3" | "P3R2";
	writerLengthFactor?: 0.8 | 0.9;
	work: string;
	archive: string;
	suiteId: string;
	runId: string;
	caseId: string;
	ledger: UsageLedger;
	control: RunControl;
	runLimitUsd: number;
	main: "real" | "faux";
	internals: "real" | "faux";
	reply: LocalReply;
	maxShowrunnerRequests: number;
	beforeRequest?: (
		role: ReturnType<typeof requestRole>,
		context: Context,
		options?: SimpleStreamOptions,
	) => Promise<void>;
	preparation?: boolean;
	price?: boolean;
	extension?: (pi: ExtensionAPI, story: StoryRuntime) => void;
	onEvidence?: (record: EvidenceRecord) => void;
	resume?: {
		sessionFile: string;
		sessionSha256: string;
		evidenceSha256: string;
		resumeReason?: "author_pause" | "measurement_timeout";
	};
}

// Sequential isolated sessions: the product loads its settings from this
// process-local agent directory. Never inspect the author's Pi auth directory.
export async function createMeasuredSession(options: SessionOptions) {
	const agentDir = path.join(options.work, "agent");
	mkdirSync(agentDir, { recursive: true });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const restoreEnvironment = () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	};
	let cleanup = restoreEnvironment;
	try {
		let phase: Phase = options.preparation === false ? "measurement" : "preparation";
		let closed = false;
		let compacting = false;
		let story: StoryRuntime | undefined;
		if (options.resume && sha256(readFileSync(options.resume.sessionFile)) !== options.resume.sessionSha256)
			throw new Error("Paused native session differs before resume");
		const priorRows: EvidenceRecord[] = options.resume
			? readFileSync(path.join(options.work, "evidence.jsonl"), "utf8")
					.split(/\r?\n/u)
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];
		let measuredMainRequests = priorRows.filter((row) => row.type === "model_call" && row.role === "showrunner").length;
		const evidence = new EvidenceArchive(
			options.archive,
			options.work,
			{
				suiteId: options.suiteId,
				runId: options.runId,
				expectedCaseIds: [options.caseId],
				stage: options.stage ?? "P3",
				main: options.main,
				internals: options.internals,
				maxShowrunnerRequests: options.maxShowrunnerRequests,
				perRunLimitUsd: options.runLimitUsd,
				simulatedPrices: options.price ?? false,
			},
			options.resume
				? { evidenceSha256: options.resume.evidenceSha256, resumeReason: options.resume.resumeReason }
				: undefined,
		);
		const emit = (record: EvidenceRecord) => {
			const row = {
				...record,
				caseId: options.caseId,
				driverPhase: phase,
				...(options.stage === "P3R2" ? { observedAt: Date.now() } : {}),
			};
			evidence.emit(row);
			options.onEvidence?.(row);
		};
		const settings = {
			...settingsTemplate(options.work),
			...(options.writerLengthFactor !== undefined ? { writerLengthFactor: options.writerLengthFactor } : {}),
		};
		writeFileSync(path.join(agentDir, "story-forge.json"), JSON.stringify(settings));
		const runtime = await ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
		});
		let fixture = scenarioProvider(options.reply, options.preparation === false && options.price);
		runtime.registerNativeProvider(fixture.provider);
		const real = runtime.getModel("deepseek", "deepseek-flash");
		if (!real && (options.main === "real" || options.internals === "real"))
			throw new Error("Frozen DeepSeek model unavailable");
		const directSimple = runtime.streamSimple.bind(runtime);
		runtime.streamSimple = (model, context, streamOptions) => {
			if (closed) throw new Error("P3 session has been finalized");
			const role = requestRole(context);
			if (model.provider !== "faux" && (role === "showrunner" ? options.main === "faux" : options.internals === "faux"))
				throw new Error("Faux measurement cannot dispatch a real provider");
			if (phase !== "measurement" && model.provider !== "faux") throw new Error("Non-measured calls must be faux");
			if (phase === "measurement" && role === "showrunner" && ++measuredMainRequests > options.maxShowrunnerRequests) {
				emit({
					type: "execution_bound",
					bound: "showrunner",
					requests: measuredMainRequests,
					maximum: options.maxShowrunnerRequests,
				});
				throw new Error("P3 showrunner bound exceeded");
			}
			emit({ type: "model_call", role, model: `${model.provider}/${model.id}`, paid: model.provider !== "faux" });
			return directSimple(model, context, {
				...streamOptions,
				onPayload: async (payload, actual) => {
					if (phase === "measurement") await options.beforeRequest?.(role, context, streamOptions);
					return streamOptions?.onPayload?.(payload, actual);
				},
			});
		};
		const restoreMeter = instrumentRuntime(runtime, {
			ledger: options.ledger,
			control: options.control,
			suiteId: options.suiteId,
			runId: options.runId,
			runLimitUsd: options.runLimitUsd,
			maxShowrunnerRequests: Number.MAX_SAFE_INTEGER,
			haltOnNonFatalHttp: false,
			compacting: () => compacting,
			measure: (model) => phase === "measurement" && model.provider !== "faux",
			emit,
		});
		cleanup = () => {
			restoreMeter();
			restoreEnvironment();
		};
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: true },
			retry: { enabled: options.main === "real", maxRetries: 3, baseDelayMs: 2000 },
		});
		const loader = new DefaultResourceLoader({
			cwd: options.work,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				(pi) => {
					story = installStory(pi, {
						observe: (call) => emit({ type: "role_call", ...call }),
						checkpoint: (checkpoint) => emit({ type: "role_checkpoint", ...checkpoint }),
					});
					pi.on("session_start", (_event, ctx) => {
						configureRoles();
						emit({
							type: "configuration",
							settings: story?.current()?.settings.effective,
							baseline: settings,
							retry: settingsManager.getRetrySettings(),
							compaction: settingsManager.getCompactionSettings(),
							mainModel: ctx.model
								? {
										provider: ctx.model.provider,
										id: ctx.model.id,
										contextWindow: ctx.model.contextWindow,
										maxTokens: ctx.model.maxTokens,
										cost: ctx.model.cost,
									}
								: null,
						});
					});
					pi.on("session_before_compact", () => {
						compacting = true;
					});
					pi.on("session_compact", () => {
						compacting = false;
					});
					pi.on("session_compact_failed", () => {
						compacting = false;
					});
					pi.registerCommand("__p3_continue", {
						description: "Measurement system continuation",
						handler: async (text) => {
							pi.sendMessage({ customType: "p3.continue", content: text, display: false }, { triggerTurn: true });
						},
					});
					options.extension?.(pi, story);
				},
			],
		});
		function configureRoles() {
			const state = story?.current();
			if (!state) throw new Error("Story session has not started");
			for (const [role, setting] of Object.entries(state.settings.effective.roles)) {
				setting.model =
					phase !== "measurement" || options.internals === "faux"
						? `faux/${fixture.model.id}`
						: settings.roles[role as keyof typeof settings.roles].model;
			}
		}
		await loader.reload();
		const manager = options.resume
			? SessionManager.open(options.resume.sessionFile)
			: SessionManager.create(options.work, path.join(options.work, "sessions"));
		const { session, extensionsResult } = await createAgentSession({
			cwd: options.work,
			agentDir,
			resourceLoader: loader,
			modelRuntime: runtime,
			settingsManager,
			sessionManager: manager,
			noTools: "builtin",
			model: phase === "measurement" && options.main === "real" ? real : fixture.model,
			thinkingLevel: "low",
		});
		cleanup = () => {
			session.dispose();
			restoreMeter();
			restoreEnvironment();
		};
		if (extensionsResult.errors.length) throw new Error("P3 extension loading failed");
		const starts = new Map<string, BranchEntry[]>();
		for (const row of priorRows)
			if (row.type === "tool_start" && typeof row.toolCallId === "string" && Array.isArray(row.entries))
				starts.set(row.toolCallId, row.entries as BranchEntry[]);
		const observeToolResult = (message: ToolResultMessage) => {
			emit({ type: "tool_result", message });
			const checked = validate(schemas.MacroDetails, message.details);
			if (!checked.ok) return;
			const draft = checked.value.drafts?.at(-1);
			const entries = [...(starts.get(message.toolCallId) ?? [])];
			if (checked.value.intent)
				entries.push({
					kind: "toolResult",
					entryId: `@evaluation:${message.toolCallId}:intent`,
					toolName: "set_chapter_intent",
					isError: false,
					details: checked.value.intent,
				});
			if (draft) emit({ type: "role_task", toolCallId: message.toolCallId, entries, draft });
			const commit = checked.value.commit;
			if (commit)
				emit({
					type: "chapter_result",
					toolCallId: message.toolCallId,
					chapter: commit.chapter,
					wordCount: wordCount(commit.text).value,
					targetWords: story
						?.current()
						?.source.model()
						.outline.find((chapter) => chapter.n === commit.chapter)?.targetWords,
				});
			starts.delete(message.toolCallId);
		};
		session.subscribe((event) => {
			if (event.type !== "message_update") emit({ type: "session_event", event });
			if (event.type === "tool_execution_start" && event.toolName === "write_next_chapter") {
				const entries = story?.current()?.source.branch();
				if (!entries) throw new Error("Tool start has no branch projection");
				starts.set(event.toolCallId, entries);
				emit({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, entries });
			}
			if (event.type === "message_end" && event.message.role === "toolResult") observeToolResult(event.message);
		});
		const host = new AgentSessionRuntime(
			session,
			{ cwd: options.work, agentDir, modelRuntime: runtime, settingsManager, resourceLoader: loader, diagnostics: [] },
			async () => {
				throw new Error("P3 measurements cannot replace sessions");
			},
		);
		return {
			session,
			manager,
			host,
			runtime,
			evidence,
			emit,
			fixture,
			appendRecoveredResult(
				input: Omit<ToolResultMessage, "details" | "isError"> & { details: unknown; isError?: boolean },
			) {
				const checked = validate(schemas.MacroDetails, input.details);
				if (!checked.ok) throw new Error("Recovered native result is not a validated macro");
				const message: ToolResultMessage = {
					...input,
					details: JSON.parse(JSON.stringify(checked.value)),
					isError: input.isError ?? false,
				};
				if (!options.resume || session.isStreaming || !starts.has(message.toolCallId))
					throw new Error("No paused native tool execution to complete");
				if (
					manager
						.getBranch()
						.some(
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "toolResult" &&
								entry.message.toolCallId === message.toolCallId,
						)
				)
					throw new Error("Paused tool result already persisted");
				const entryId = manager.appendMessage(message);
				session.agent.state.messages.push(message);
				emit({ type: "native_tool_result_recovered", entryId, toolCallId: message.toolCallId });
				observeToolResult(message);
			},
			get story() {
				if (!story) throw new Error("Story extension unavailable");
				return story;
			},
			get phase() {
				return phase;
			},
			async measure() {
				if (options.price) {
					fixture = scenarioProvider(options.reply, true);
					runtime.registerNativeProvider(fixture.provider);
				}
				phase = "measurement";
				configureRoles();
				await session.setModel(options.main === "real" ? (real as Model<Api>) : fixture.model);
				emit({ type: "measurement_start", settings: story?.current()?.settings.effective });
			},
			probe() {
				phase = "driver_probe";
				configureRoles();
			},
			finish() {
				if (session.isStreaming) throw new Error("Cannot finalize a streaming measurement");
				let file = manager.getSessionFile();
				const sessionSource = file && existsSync(file) ? "native_file" : "in_memory_snapshot";
				if (sessionSource === "in_memory_snapshot") {
					// Pi intentionally delays disk persistence until an assistant message.
					// E01 must retain its real header/entries without inventing a prompt.
					const header = manager.getHeader();
					if (!header) throw new Error("Native session header unavailable");
					file = path.join(options.work, "native-session-snapshot.jsonl");
					writeFileSync(
						file,
						`${[header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
						{ flag: "wx" },
					);
				}
				emit({ type: "native_session_archival", sessionSource });
				const digests = evidence.finish(file ?? undefined);
				closed = true;
				return { ...digests, sessionSource, fee: options.ledger.snapshot(options.runId), measuredMainRequests };
			},
			dispose() {
				cleanup();
			},
		};
	} catch (cause) {
		cleanup();
		throw cause;
	}
}
export type MeasuredSession = Awaited<ReturnType<typeof createMeasuredSession>>;
