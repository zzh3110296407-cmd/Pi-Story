import { readFileSync } from "node:fs";
import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	BudgetGuard,
	type CallRecord,
	type EffectiveSettings,
	type ModelFailure,
	type ModelPort,
	type ModelRequest,
	type Ports,
	type PriceTable,
	type RuleSource,
	type StoryModel,
} from "@pi-story/core";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { estimateInputTokens } from "../../core/src/usage/index.ts";
import type { BranchSource } from "./entries.ts";
import { ProviderBudget } from "./provider-budget.ts";
import { classifyModelFailure, type HttpFailure, rejectedBeforeGeneration } from "./provider-errors.ts";

const roleSchema = Type.Object(
	{
		model: Type.String({ minLength: 1 }),
		thinking: Type.Literal("low"),
		maxTokens: Type.Integer({ minimum: 1 }),
		temperature: Type.Number({ minimum: 0, maximum: 2 }),
	},
	{ additionalProperties: false },
);
const globalSchema = Type.Object(
	{
		schema: Type.Literal("story/global-settings@1"),
		storiesDir: Type.String({ minLength: 1 }),
		defaultLevel: Type.Literal("L1"),
		localRevision: Type.Optional(Type.Boolean()),
		writerLengthFactor: Type.Optional(Type.Union([Type.Literal(0.8), Type.Literal(0.9)])),
		roles: Type.Object(
			{ writer: roleSchema, editor: roleSchema, keeper: roleSchema, verifier: roleSchema },
			{ additionalProperties: false },
		),
		defaultBudget: Type.Object(
			{
				tokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
				costUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
			},
			{ additionalProperties: false },
		),
		bridge: Type.Optional(
			Type.Object({ port: Type.Integer({ minimum: 0, maximum: 65535 }) }, { additionalProperties: false }),
		),
	},
	{ additionalProperties: false },
);
export interface Settings {
	global: Static<typeof globalSchema>;
	effective: EffectiveSettings;
}
export function effectiveBudget(model: StoryModel, settings: Settings): StoryModel["policy"]["budget"] {
	// A goal entry is a full policy snapshot: omitted budget means explicitly off.
	if (model.events.some((event) => event.type === "story.goal")) return model.policy.budget;
	return {
		...(settings.global.defaultBudget.tokens !== null ? { tokens: settings.global.defaultBudget.tokens } : {}),
		...(settings.global.defaultBudget.costUsd !== null ? { costUsd: settings.global.defaultBudget.costUsd } : {}),
	};
}
export function loadSettings(agentDir = process.env.PI_CODING_AGENT_DIR): Settings {
	if (!agentDir || !path.isAbsolute(agentDir))
		throw new Error("Set an absolute PI_CODING_AGENT_DIR before loading Story");
	const value: unknown = JSON.parse(readFileSync(path.join(agentDir, "story-forge.json"), "utf8"));
	if (!Check(globalSchema, value) || !path.isAbsolute(value.storiesDir))
		throw new Error("Invalid Story global settings");
	return {
		global: value,
		effective: {
			localRevision: value.localRevision ?? true,
			roles: value.roles,
			level: value.defaultLevel,
			...(value.writerLengthFactor !== undefined ? { writerLengthFactor: value.writerLengthFactor } : {}),
		},
	};
}

const ruleDirectories: Record<string, string> = {
	writer: "story-long-writing",
	"review-matrix": "story-review-matrix",
	"state-projection": "story-state-projection",
	showrunner: "story-showrunner",
};
export class FileRules implements RuleSource {
	get(name: string): string {
		const directory = ruleDirectories[name];
		if (!directory) throw new Error(`Unknown Story rule: ${name}`);
		return readFileSync(new URL(`../rules/${directory}/SKILL.md`, import.meta.url), "utf8");
	}
}

function findModel(registry: ModelRegistry, id: string) {
	const slash = id.indexOf("/");
	return slash > 0 ? registry.find(id.slice(0, slash), id.slice(slash + 1)) : undefined;
}
export class PiPrices implements PriceTable {
	private readonly registry: ModelRegistry;
	constructor(registry: ModelRegistry) {
		this.registry = registry;
	}
	price(id: string) {
		return findModel(this.registry, id)?.cost ?? null;
	}
}
export interface CallObservation {
	request: ModelRequest;
	toolCallId?: string;
	inputSources: { field: string; references: string[] }[];
	payload?: unknown;
	response: AssistantMessage;
	durationMs: number;
}
export type ObserveCall = (call: CallObservation) => void;
export type CallCheckpoint = { toolCallId?: string } & (
	| {
			phase: "started";
			reservationId: string;
			request: ModelRequest;
			reservedCostUsd: number | null;
			inputSources: CallObservation["inputSources"];
	  }
	| { phase: "completed"; reservationId: string; record: CallRecord }
);
export type ObserveCheckpoint = (checkpoint: CallCheckpoint) => void;

function inputSourcesFor(request: ModelRequest): CallObservation["inputSources"] {
	let input: unknown;
	try {
		input = JSON.parse(request.user);
	} catch {
		input = {};
	}
	while (input !== null && typeof input === "object" && "originalInput" in input) input = input.originalInput;
	return Object.entries(input !== null && typeof input === "object" ? input : {}).map(([field, value]) => {
		const references = new Set<string>();
		const visit = (item: unknown): void => {
			if (Array.isArray(item)) item.forEach(visit);
			else if (item !== null && typeof item === "object")
				for (const [key, child] of Object.entries(item)) {
					if (
						["id", "key", "messageId", "ref", "draftId", "chapter"].includes(key) &&
						(typeof child === "string" || typeof child === "number")
					)
						references.add(`${key}:${child}`);
					else visit(child);
				}
		};
		visit(value);
		return { field, references: [...references] };
	});
}

export function createCallJournal(checkpoint: ObserveCheckpoint): NonNullable<Ports["callJournal"]> {
	return {
		started: (reservationId, request, reservedCostUsd) =>
			checkpoint({ phase: "started", reservationId, request, reservedCostUsd, inputSources: inputSourcesFor(request) }),
		completed: (reservationId, record) => checkpoint({ phase: "completed", reservationId, record }),
	};
}
export class PiModelPort implements ModelPort {
	private readonly registry: ModelRegistry;
	private readonly settings: EffectiveSettings;
	private readonly observe?: ObserveCall;
	private fatal?: ModelFailure;
	constructor(registry: ModelRegistry, settings: EffectiveSettings, observe?: ObserveCall) {
		this.registry = registry;
		this.settings = settings;
		this.observe = observe;
	}
	async call(request: ModelRequest) {
		if (this.fatal) throw Object.assign(new Error("Provider refused; this run is stopped"), { failure: this.fatal });
		const model = findModel(this.registry, request.model);
		if (!model) throw new Error(`Story role model is absent from the pinned catalog: ${request.model}`);
		if (request.maxTokens > model.maxTokens) throw new Error("Role output limit exceeds the model output limit");
		if (estimateInputTokens(`${request.system}\n${request.user}`) + request.maxTokens > model.contextWindow)
			throw new Error("Role input reservation exceeds the model context window");
		const start = performance.now();
		let payload: unknown;
		let httpError: HttpFailure | undefined;
		const response = await this.registry
			.streamSimple(
				model,
				{
					systemPrompt: request.system,
					messages: [{ role: "user", content: request.user, timestamp: Date.now() }],
				},
				{
					maxTokens: request.maxTokens,
					temperature: request.temperature,
					reasoning: this.settings.roles[request.role].thinking === "low" ? "low" : undefined,
					signal: request.signal,
					maxRetries: 0,
					fetch: async (input, init) => {
						const reply = await globalThis.fetch(input, init);
						if (reply.status >= 400) {
							httpError = {
								status: reply.status,
								body: "",
								complete: false,
								retryAfter: reply.headers.get("retry-after"),
							};
							try {
								httpError.body = await reply.clone().text();
								httpError.complete = true;
							} catch {
								/* Remains unknown. */
							}
						}
						return reply;
					},
					timeoutMs: 120_000,
					...(request.output.kind === "json" ? { samplingParams: { response_format: { type: "json_object" } } } : {}),
					onPayload: (body) => {
						payload = body;
					},
				},
			)
			.result()
			.catch((error: unknown) => {
				throw Object.assign(new Error("Role transport failed"), {
					failure: { kind: request.signal?.aborted ? "aborted" : "transport" },
					...(error !== null && typeof error === "object" && "usage" in error ? { usage: error.usage } : {}),
				});
			});
		const durationMs = performance.now() - start;
		this.observe?.({ request, payload, response, durationMs, inputSources: inputSourcesFor(request) });
		const text = response.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		let json: unknown;
		if (request.output.kind === "json") {
			try {
				json = JSON.parse(text);
			} catch {
				/* Core owns format repair; preserve the original text. */
			}
		}
		const missing = ["error", "aborted"].includes(response.stopReason) && response.usage.totalTokens === 0;
		const rejection =
			httpError &&
			httpError.status !== 429 &&
			rejectedBeforeGeneration(httpError.status, httpError.body, httpError.complete, response)
				? { httpStatus: httpError.status }
				: undefined;
		const failure = classifyModelFailure(response, httpError, request.signal?.aborted);
		if (failure?.kind === "fatal") this.fatal = failure;
		return {
			text,
			...(json !== undefined ? { json } : {}),
			usage: rejection ? response.usage : missing ? null : response.usage,
			stopReason: rejection ? "rejected" : response.stopReason,
			...(rejection ? { rejection } : {}),
			...(failure ? { failure } : {}),
			durationMs,
		};
	}
}

export class SessionPorts {
	readonly ports: Ports;
	readonly guard: InstanceType<typeof BudgetGuard>;
	readonly providerBudget: ProviderBudget;
	private readonly source: BranchSource;
	private readonly getEntries: () => readonly SessionEntry[];
	private readonly pending = new Map<string, string[]>();
	constructor(
		source: BranchSource,
		getEntries: () => readonly SessionEntry[],
		registry: ModelRegistry,
		settings: Settings,
		observe?: ObserveCall,
		checkpoint?: ObserveCheckpoint,
		interjections: Ports["interjections"] = { seq: () => 0 },
	) {
		this.source = source;
		this.getEntries = getEntries;
		const prices = new PiPrices(registry);
		this.guard = new BudgetGuard(() => {
			const model = source.model();
			let tokens = 0;
			let costUsd = 0;
			for (const entry of getEntries()) {
				if (entry.type === "compaction" && entry.usage) {
					tokens += entry.usage.totalTokens;
					costUsd += entry.usage.cost.total;
				}
				if (entry.type !== "message" || !["assistant", "toolResult"].includes(entry.message.role)) continue;
				const message = entry.message;
				if ((message.role === "assistant" || message.role === "toolResult") && message.usage) {
					tokens += message.usage.totalTokens;
					costUsd += message.usage.cost.total;
				}
			}
			return {
				calls: model.calls,
				interruptions: model.interruptions,
				knownUsage: { tokens, costUsd },
				budget: effectiveBudget(model, settings),
			};
		}, prices);
		this.providerBudget = new ProviderBudget(this.guard);
		this.ports = {
			entries: source,
			prices,
			budget: this.guard,
			models: new PiModelPort(registry, settings.effective, observe),
			rules: new FileRules(),
			interjections,
			...(checkpoint ? { callJournal: createCallJournal(checkpoint) } : {}),
		};
	}
	begin(): ReadonlySet<string> {
		this.sync();
		return new Set(this.guard.settledReservations());
	}
	complete(toolCallId: string, before: ReadonlySet<string>): void {
		const ids = this.guard.settledReservations().filter((id) => !before.has(id));
		if (ids.length) this.pending.set(toolCallId, ids);
	}
	sync(): void {
		this.providerBudget.sync(this.getEntries());
		const model = this.source.model();
		for (const entry of this.getEntries()) {
			if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
			const ids = this.pending.get(entry.message.toolCallId);
			if (!ids) continue;
			// Only acknowledge after the same validated macro was folded into the
			// authoritative snapshot, including its CallRecords. A matching call ID
			// without a valid persisted result is not a persistence confirmation.
			if (!model.events.some((event) => event.entryId === entry.id && event.type === "story/macro-result@1")) continue;
			this.guard.acknowledge(ids);
			this.pending.delete(entry.message.toolCallId);
		}
	}
}
