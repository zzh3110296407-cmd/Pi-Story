import path from "node:path";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { instrumentRuntime } from "../../../scripts/eval/p2/metering.ts";
import { CallSession } from "../../core/src/flow/calls.ts";
import { BranchSource } from "../src/entries.ts";
import { loadSettings, SessionPorts } from "../src/ports.ts";
import { createTestSession } from "./fixture.ts";

test("P3 measurement preserves U7 after a nonfatal 500 and retains both independent fee attempts", async () => {
	const f = await createTestSession();
	const oldFetch = globalThis.fetch;
	let restore: (() => void) | undefined;
	try {
		f.runtime.registerProvider("deepseek", { apiKey: "fixture-local", baseUrl: "https://no-network.test" });
		const ledger = new UsageLedger(path.join(f.root, "usage.jsonl"), path.join(f.root, "reserves.jsonl"), {
			stopUsd: 12,
			maximumUsd: 15,
		});
		restore = instrumentRuntime(f.runtime, {
			ledger,
			suiteId: "P3-E2E",
			runId: "offline-500",
			runLimitUsd: 2,
			haltOnNonFatalHttp: false,
			emit: () => {},
		});
		let dispatched = 0;
		globalThis.fetch = async () => {
			if (++dispatched === 1) return new Response('{"error":{"message":"synthetic server failure"}}', { status: 500 });
			return new Response(
				`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "A valid draft." }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		};
		const source = new BranchSource(() => f.manager.getBranch());
		const settings = loadSettings(f.agentDir);
		settings.effective.roles.writer.model = "deepseek/deepseek-flash";
		settings.effective.roles.writer.maxTokens = 64;
		const services = new SessionPorts(source, () => f.manager.getBranch(), new ModelRegistry(f.runtime), settings);
		const calls = new CallSession({ model: source.model(), ports: services.ports, settings: settings.effective });
		expect((await calls.call("writer", "name: story-long-writing\nWrite.", "Input", { kind: "text" })).ok).toBe(true);
		expect(dispatched).toBe(2);
		expect(calls.calls[1].retryOf).toBe(calls.calls[0].id);
		expect(ledger.snapshot()).toMatchObject({ requests: 2, unknownCalls: 1 });
	} finally {
		restore?.();
		globalThis.fetch = oldFetch;
		f.cleanup();
	}
});
