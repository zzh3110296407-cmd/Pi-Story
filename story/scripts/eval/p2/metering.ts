import { createHash } from "node:crypto";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	type Model,
	type ModelsApiStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { estimateInputTokens } from "../../../packages/core/src/usage/index.ts";
import { rejectedBeforeGeneration } from "../../../packages/pi-story/src/provider-errors.ts";
import type { UsageLedger } from "./ledger.ts";
import type { RunControl } from "./run-control.ts";

export interface EvidenceRecord {
	type: string;
	[key: string]: unknown;
}
export const P2_LIMITS = { authorRounds: 12, showrunnerRequests: 48 } as const;
interface MeterOptions {
	ledger: UsageLedger;
	suiteId: string;
	runId: string;
	runLimitUsd: number;
	allowFaux?: boolean;
	emit: (record: EvidenceRecord) => void;
	maxShowrunnerRequests?: number;
	control?: RunControl;
	roleSettings?: Record<"showrunner" | "writer" | "editor" | "keeper", { model: string; thinking: "low" | "off" }> & {
		compaction?: { model: string; thinking: "low" | "off" };
	};
	// Defaults preserve frozen P2 behavior; P3's U7 must survive nonfatal HTTPs.
	haltOnNonFatalHttp?: boolean;
	measure?: (model: Model<Api>) => boolean;
	compacting?: () => boolean;
}
type Hooks = Pick<StreamOptions, "onPayload" | "fetch" | "maxRetries">;

// This belongs to the measurement driver, not the product's P3 budget hook.
// Both the SDK and role port use streamSimple, which translates neutral thinking
// levels to the selected provider. Cover the API-specific stream entry as well.
export function instrumentRuntime(runtime: ModelRuntime, config: MeterOptions): () => void {
	const direct = runtime.stream.bind(runtime);
	const simple = runtime.streamSimple.bind(runtime);
	let halted = false;
	let showrunnerRequests = 0;
	const emit = (record: EvidenceRecord): void => {
		try {
			config.emit(record);
		} catch (cause) {
			halted = true;
			throw cause;
		}
	};
	function track(
		model: Model<Api>,
		context: Context,
		options: StreamOptions & { reasoning?: string },
		showrunner: boolean,
		start: (hooks: Hooks) => AssistantMessageEventStream,
	) {
		config.control?.assertActive();
		if (halted) throw new Error("P2 measurement stopped after a recording or dispatch failure");
		const system =
			"systemPrompt" in context && typeof context.systemPrompt === "string"
				? context.systemPrompt
				: getCurrentSystemPrompt(context.messages);
		const role = system.includes("name: story-long-writing\n")
			? "writer"
			: system.includes("name: story-review-matrix\n")
				? "editor"
				: system.includes("name: story-state-projection\n")
					? "keeper"
					: config.compacting?.()
						? "compaction"
						: showrunner
							? "showrunner"
							: undefined;
		if (!role) throw new Error("Unrecognized internal role request");
		const expected = config.roleSettings?.[role] ?? { model: "deepseek/deepseek-flash", thinking: "low" };
		if (
			!config.allowFaux &&
			(`${model.provider}/${model.id}` !== expected.model || (options.reasoning ?? "off") !== expected.thinking)
		)
			throw new Error("Request differs from the declared role model setting");
		if (
			role === "showrunner" &&
			!options.signal?.aborted &&
			++showrunnerRequests > (config.maxShowrunnerRequests ?? P2_LIMITS.showrunnerRequests)
		) {
			halted = true;
			throw new Error("P2 showrunner request limit reached before dispatch");
		}
		const input = estimateInputTokens(JSON.stringify(context));
		const output = options.maxTokens ?? model.maxTokens;
		const inputPrice = Math.max(model.cost.input, model.cost.cacheRead, model.cost.cacheWrite);
		const reservedCostUsd = (input * inputPrice + output * model.cost.output) / 1_000_000;
		const requestId = config.ledger.reserve({
			suiteId: config.suiteId,
			runId: config.runId,
			role,
			model: `${model.provider}/${model.id}`,
			reservedCostUsd,
			reservedInputTokens: input,
			reservedOutputTokens: output,
			runLimitUsd: config.runLimitUsd,
			maximumCostUsd: (model.contextWindow * inputPrice + model.maxTokens * model.cost.output) / 1_000_000,
		});
		emit({
			type: "request",
			...(role !== "showrunner" &&
			context.messages[0]?.role === "user" &&
			typeof context.messages[0].content === "string"
				? {
						inputDigest: createHash("sha256")
							.update(JSON.stringify({ system, user: context.messages[0].content }))
							.digest("hex"),
					}
				: {}),
			requestId,
			role,
			model: `${model.provider}/${model.id}`,
			thinking: options.reasoning ?? "off",
			inputTokensEstimate: input,
			contextWindow: model.contextWindow,
			maxTokens: output,
			reservedCostUsd,
			time: new Date().toISOString(),
		});
		const outer = createAssistantMessageEventStream();
		let recorded = false;
		let response: AssistantMessage | undefined;
		let httpBody: Promise<{ complete: boolean; status: number; body: string }> | undefined;
		let fetchCount = 0;
		const begin = performance.now();
		void (async () => {
			try {
				const source = start({
					maxRetries: 0,
					onPayload: async (payload, actualModel) => {
						const replacement = await options.onPayload?.(payload, actualModel);
						emit({ type: "request_body", requestId, body: replacement ?? payload });
						return replacement;
					},
					fetch: async (input, init) => {
						if (++fetchCount > 1) throw new Error("Unexpected provider retry blocked before dispatch");
						// Forward authentication in memory; never record URL/headers or fetch options.
						emit({ type: "dispatch", requestId, role });
						const reply = await (options.fetch ?? globalThis.fetch)(input, init);
						if (config.control?.reject(reply.status)) emit({ type: "fatal_provider_error", ...config.control.fatal });
						const copy = reply.clone();
						httpBody = (async () => {
							const chunks: Uint8Array[] = [];
							let size = 0;
							let complete = true;
							try {
								if (copy.body)
									for await (const chunk of copy.body) {
										size += chunk.byteLength;
										if (size > 64 * 1024 * 1024) throw new Error("HTTP evidence exceeds the capture limit");
										chunks.push(chunk);
									}
							} catch {
								complete = false;
							}
							const body = Buffer.concat(chunks).toString("utf8");
							emit({ type: "http_response", requestId, status: reply.status, body, complete });
							return { complete, status: reply.status, body };
						})();
						return reply;
					},
				});
				let terminal: AssistantMessageEvent | undefined;
				for await (const event of source) {
					if (event.type === "done" || event.type === "error") terminal = event;
					else outer.push(event);
				}
				response = await source.result();
				emit({ type: "provider_response", requestId, role, response, durationMs: performance.now() - begin });
				const captured = await httpBody;
				if (captured && !captured.complete && !["error", "aborted"].includes(response.stopReason)) {
					response = {
						...response,
						stopReason: "error",
						errorMessage: "HTTP response interrupted after provider completion; received bytes retained",
					};
					terminal = { type: "error", reason: "error", error: response };
				}
				if (captured && captured.status >= 400 && config.haltOnNonFatalHttp !== false) halted = true;
				const rejected =
					captured !== undefined &&
					rejectedBeforeGeneration(captured.status, captured.body, captured.complete, response);
				const usage = rejected
					? response.usage
					: ["error", "aborted"].includes(response.stopReason) && response.usage.totalTokens === 0
						? null
						: response.usage;
				const classification = rejected
					? "rejected"
					: usage !== null
						? "reported"
						: response.stopReason === "aborted"
							? "cancelled"
							: captured && !captured.complete
								? "interrupted"
								: "transport_failure";
				config.ledger.complete(
					requestId,
					usage,
					rejected ? "rejected" : response.stopReason,
					usage === null && fetchCount === 0,
					classification,
				);
				recorded = true;
				emit({
					type: "response",
					classification,
					requestId,
					role,
					response,
					durationMs: performance.now() - begin,
					networkAttempts: fetchCount,
					usageKnown: usage !== null,
					...(captured ? { httpComplete: captured.complete, httpStatus: captured.status } : {}),
				});
				if (!terminal) throw new Error("Provider stream ended without its terminal event");
				outer.push(terminal);
				outer.end(response);
			} catch (cause) {
				halted = true;
				const diagnostic = cause instanceof Error ? cause.message : String(cause);
				const safeDiagnostic = /sk-[A-Za-z0-9_-]{20,}|Bearer\s|authorization|api[-_]?key/iu.test(diagnostic)
					? "Sensitive diagnostic omitted"
					: diagnostic;
				let ledgerFailure = false;
				try {
					if (!recorded)
						config.ledger.complete(
							requestId,
							response?.usage.totalTokens ? response.usage : null,
							"transport_failure",
							fetchCount === 0,
						);
				} catch {
					ledgerFailure = true;
				} // The durable reservation remains charged; dispatch stays stopped.
				const failure: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: response?.content ?? [],
					stopReason: "error",
					errorMessage: `P2 measurement stopped: ${safeDiagnostic}${ledgerFailure ? "; fee completion could not be saved; reservation retained" : ""}`,
					usage: response?.usage ?? {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				};
				try {
					emit({
						type: "recording_failure",
						requestId,
						role,
						networkAttempts: fetchCount,
						diagnostic: safeDiagnostic,
						ledgerFailure,
					});
				} catch {
					/* Stream still terminates with the explicit failure below. */
				}
				outer.push({ type: "error", reason: "error", error: failure });
				outer.end(failure);
			}
		})();
		return outer;
	}
	runtime.stream = (model, context, options) => {
		if (config.measure && !config.measure(model)) {
			if (model.provider !== "faux") throw new Error("Preparation may only use faux models");
			return direct(model, context, options);
		}
		return track(model, context, options ?? {}, false, (hooks) =>
			direct(model, context, { ...options, ...hooks } as ModelsApiStreamOptions<typeof model.api>),
		);
	};
	runtime.streamSimple = (model, context, options) => {
		if (config.measure && !config.measure(model)) {
			if (model.provider !== "faux") throw new Error("Preparation may only use faux models");
			return simple(model, context, options);
		}
		return track(model, context, options ?? {}, true, (hooks) => simple(model, context, { ...options, ...hooks }));
	};
	return () => {
		runtime.stream = direct;
		runtime.streamSimple = simple;
	};
}
