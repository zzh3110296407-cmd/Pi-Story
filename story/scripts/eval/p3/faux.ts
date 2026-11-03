import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	createProvider,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
	type StreamFunction,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

export type LocalReply = (
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
) => Promise<AssistantMessage> | AssistantMessage;

// Unlike the stock faux provider, this measurement fixture invokes onPayload
// and preserves explicit unknown usage. This exercises the real U5/U7 paths.
export function scenarioProvider(reply: LocalReply, price = false) {
	const model: Model<"p3-faux"> = {
		id: price ? "priced" : "script",
		name: "P3 local fixture",
		api: "p3-faux",
		provider: "faux",
		baseUrl: "http://localhost:0",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 32768,
		cost: { input: 0, output: price ? (0.006 * 1_000_000) / 32768 : 0, cacheRead: 0, cacheWrite: 0 },
	};
	const stream: StreamFunction<"p3-faux", SimpleStreamOptions> = (actual, context, options) => {
		const outer = createAssistantMessageEventStream();
		void (async () => {
			let message = fauxAssistantMessage("");
			try {
				await options?.onPayload?.(
					{ messages: context.messages, max_tokens: options?.maxTokens ?? actual.maxTokens },
					actual,
				);
				if (options?.signal?.aborted) throw new Error("Fixture request aborted before generation");
				message = await reply(context, options);
				message = { ...message, api: actual.api, model: actual.id, provider: actual.provider };
				if (!["error", "aborted"].includes(message.stopReason)) {
					const input = Math.max(1, Math.ceil(JSON.stringify(context).length / 4));
					const output = Math.max(1, Math.ceil(JSON.stringify(message.content).length / 4));
					message.usage = {
						input,
						output,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: input + output,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					};
				}
				if (price && message.stopReason !== "error")
					message.usage = {
						input: 0,
						output: 32768,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 32768,
						cost: { input: 0, output: 0.006, cacheRead: 0, cacheWrite: 0, total: 0.006 },
					};
				outer.push({ type: "start", partial: message });
				for (let i = 0; i < message.content.length; i++) {
					const block = message.content[i];
					if (block.type === "text")
						outer.push({ type: "text_delta", contentIndex: i, delta: block.text, partial: message });
				}
				if (options?.signal?.aborted) message = { ...message, stopReason: "aborted" };
			} catch {
				message = {
					...message,
					api: actual.api,
					model: actual.id,
					provider: actual.provider,
					stopReason: options?.signal?.aborted ? "aborted" : "error",
					errorMessage: "Local fixture dispatch failed",
				};
			}
			if (message.stopReason === "pending") throw new Error("Pending replies are outside P3 fixtures");
			if (message.stopReason === "error" || message.stopReason === "aborted")
				outer.push({ type: "error", reason: message.stopReason, error: message });
			else outer.push({ type: "done", reason: message.stopReason, message });
			outer.end(message);
		})();
		return outer;
	};
	return {
		model,
		provider: createProvider({
			id: "faux",
			models: [model],
			auth: { apiKey: { name: "Local only", resolve: async () => ({ auth: {} }) } },
			api: { stream, streamSimple: stream },
		}),
	};
}
