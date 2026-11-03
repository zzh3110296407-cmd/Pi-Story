import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { loadSettings, PiModelPort } from "../src/ports.ts";
import { createTestSession } from "./fixture.ts";

test.each([400, 401, 402, 403, 429, 500, 503])(
	"P3 ModelPort classifies HTTP %s without hidden provider retries",
	async (status) => {
		const fixture = await createTestSession();
		const original = globalThis.fetch;
		try {
			fixture.runtime.registerProvider("deepseek", { apiKey: "fixture-local", baseUrl: "https://no-network.test" });
			let count = 0;
			globalThis.fetch = async () => {
				count++;
				return new Response('{"error":{"message":"synthetic refusal"}}', {
					status,
					headers: { "content-type": "application/json", "retry-after": "3" },
				});
			};
			const port = new PiModelPort(new ModelRegistry(fixture.runtime), loadSettings(fixture.agentDir).effective);
			const result = await port.call({
				role: "writer",
				model: "deepseek/deepseek-flash",
				system: "write",
				user: "test",
				maxTokens: 64,
				output: { kind: "text" },
			});
			expect(result.failure).toMatchObject({
				kind: [401, 402, 403].includes(status) ? "fatal" : status === 429 || status >= 500 ? "transport" : "rejected",
				httpStatus: status,
			});
			if (status === 429) expect(result.failure?.retryAfterMs).toBe(3_000);
			if ([401, 402, 403].includes(status)) {
				await expect(
					port.call({
						role: "writer",
						model: "deepseek/deepseek-flash",
						system: "write",
						user: "test",
						maxTokens: 64,
						output: { kind: "text" },
					}),
				).rejects.toMatchObject({ failure: { kind: "fatal" } });
			}
			expect(count).toBe(1);
		} finally {
			globalThis.fetch = original;
			fixture.cleanup();
		}
	},
);
test.each(["connection", "timeout", "stream", "aborted"])(
	"P3 ModelPort classifies %s and preserves unknown usage",
	async (kind) => {
		const fixture = await createTestSession();
		const original = globalThis.fetch;
		try {
			fixture.runtime.registerProvider("deepseek", { apiKey: "fixture-local", baseUrl: "https://no-network.test" });
			const controller = new AbortController();
			globalThis.fetch = async () => {
				if (kind === "aborted") controller.abort();
				if (kind === "stream")
					return new Response(
						new ReadableStream({
							start(stream) {
								stream.error(new TypeError("synthetic stream interruption"));
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				throw kind === "timeout"
					? new DOMException("synthetic timeout", "TimeoutError")
					: new TypeError("synthetic connection error");
			};
			const port = new PiModelPort(new ModelRegistry(fixture.runtime), loadSettings(fixture.agentDir).effective);
			const result = await port.call({
				role: "writer",
				model: "deepseek/deepseek-flash",
				system: "write",
				user: "test",
				maxTokens: 64,
				signal: controller.signal,
				output: { kind: "text" },
			});
			expect(result.failure?.kind).toBe(kind === "aborted" ? "aborted" : "transport");
			expect(result.usage).toBeNull();
		} finally {
			globalThis.fetch = original;
			fixture.cleanup();
		}
	},
);
