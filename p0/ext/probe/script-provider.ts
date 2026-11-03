/** Reproduce: set PROBE_SCRIPT and load this directory with the P0 pi.ps1 launcher. */
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ScriptTurn {
	text?: string;
	content?: AssistantMessage["content"];
	delayMs?: number;
}

interface ProbeScript {
	turns: ScriptTurn[];
	repeatLast?: boolean;
}

export function registerScriptProvider(pi: ExtensionAPI, log: (type: string, data: unknown) => void): void {
	let requestIndex = 0;
	const scriptFile = process.env.PROBE_SCRIPT;
	const script: ProbeScript = scriptFile
		? (JSON.parse(readFileSync(scriptFile, "utf8")) as ProbeScript)
		: { turns: [{ text: "done" }] };
	if (!Array.isArray(script.turns)) throw new Error("PROBE_SCRIPT must contain a turns array");

	const streamSimple = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => {
		const stream = createAssistantMessageEventStream();
		const index = requestIndex++;
		const turn = script.turns[index] ?? (script.repeatLast ? script.turns.at(-1) : undefined) ?? { text: "done" };
		const content = turn.content ?? [{ type: "text" as const, text: turn.text ?? "done" }];
		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content,
			stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		void (async () => {
			try {
				const request = {
					messages: context.messages.map((item) => item.role === "toolResult" ? {
						role: item.role,
						toolCallId: item.toolCallId,
						toolName: item.toolName,
						content: item.content,
						isError: item.isError,
						timestamp: item.timestamp,
					} : item),
					tools: getCurrentTools(context.messages),
					systemPrompt: getCurrentSystemPrompt(context.messages),
				};
				const replacement = await options?.onPayload?.(request, model);
				log("provider_request", { index, payload: replacement ?? request });
				if (turn.delayMs) await setTimeout(turn.delayMs, undefined, { signal: options?.signal });
				if (options?.signal?.aborted) throw new Error("aborted");
				log("provider_dispatch", { index });
				await options?.onResponse?.({ status: 200, headers: {} }, model);
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
				stream.end(message);
			} catch (error) {
				message.content = [];
				message.stopReason = options?.signal?.aborted ? "aborted" : "error";
				message.errorMessage = error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason: message.stopReason, error: message });
				stream.end(message);
			}
		})();
		return stream;
	};

	pi.registerProvider("probe-faux", {
		api: "probe-faux",
		apiKey: "probe-local-no-secret",
		baseUrl: "http://127.0.0.1:0",
		streamSimple,
		models: [{
			id: "script",
			name: "P0 scripted offline model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 32768,
		}],
	});
}
