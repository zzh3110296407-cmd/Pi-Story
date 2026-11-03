import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { CallSession } from "../../core/src/flow/calls.ts";
import { BudgetGuard, usageSummary } from "../../core/src/usage/index.ts";
import { context } from "../../core/test/context.ts";
import { BranchSource } from "../src/entries.ts";
import { loadSettings, PiModelPort } from "../src/ports.ts";
import { createTestSession, draftText, keeperReply, openingCalls } from "./fixture.ts";

test("ordinary terminal sessions persist core input provenance without measurement observers", async () => {
	const fixture = await createTestSession();
	try {
		fixture.faux.setResponses([
			fauxAssistantMessage([...openingCalls(), fauxToolCall("write_next_chapter", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(draftText),
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(keeperReply)),
			fauxAssistantMessage("Committed."),
		]);
		await fixture.session.prompt("Ada must survive.");
		const model = new BranchSource(() => fixture.manager.getBranch()).model();
		expect(model.commits).toHaveLength(1);
		expect(model.calls).toHaveLength(3);
		for (const record of model.calls) {
			expect(record.inputSources).toMatchObject({
				inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
				entries: expect.any(Array),
			});
			expect(record.inputSources?.entries.some((entry) => entry.type === "story/bible@1")).toBe(true);
		}
		expect(model.calls[1].inputSources?.entries.some((entry) => entry.type === "story/draft@1")).toBe(true);
		const keeperTypes = model.calls[2].inputSources?.entries.map((entry) => entry.type);
		expect(keeperTypes).not.toContain("story/constraints@1");
		expect(keeperTypes).not.toContain("story/outline@1");
		expect(keeperTypes).not.toContain("story/intent@1");
	} finally {
		fixture.cleanup();
	}
});

test.each(["402", "400", "500", "malformed_400", "timeout", "cancelled"])(
	"generation rejection is zero usage; uncertain failure retains its reservation: %s",
	async (scenario) => {
		const fixture = await createTestSession();
		const originalFetch = globalThis.fetch;
		try {
			fixture.runtime.registerProvider("deepseek", { apiKey: "fixture-local", baseUrl: "https://no-network.test" });
			const controller = new AbortController();
			let requests = 0;
			globalThis.fetch = async () => {
				requests++;
				if (scenario === "timeout") throw new DOMException("synthetic timeout", "TimeoutError");
				if (scenario === "cancelled") {
					controller.abort();
					throw new DOMException("synthetic cancellation", "AbortError");
				}
				return new Response(
					scenario === "malformed_400"
						? "<html>intermediary error</html>"
						: JSON.stringify({ error: { message: "synthetic refusal", type: "invalid_request_error" } }),
					{
						status: scenario === "malformed_400" ? 400 : Number(scenario),
						headers: { "content-type": "application/json" },
					},
				);
			};
			const ctx = context();
			ctx.settings = loadSettings(fixture.agentDir).effective;
			ctx.settings.roles.writer.model = "deepseek/deepseek-flash";
			ctx.signal = controller.signal;
			ctx.ports.models = new PiModelPort(new ModelRegistry(fixture.runtime), ctx.settings);
			const guard = new BudgetGuard(() => ({ calls: [], interruptions: [], budget: { tokens: 12000 } }), {
				price: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
			});
			ctx.ports.budget = guard;
			const session = new CallSession(ctx);
			expect((await session.call("writer", "Write", "{}", { kind: "text" })).ok).toBe(false);
			expect(requests).toBe(1);
			const record = session.calls[0];
			const rejected = ["400", "402"].includes(scenario);
			expect(record).toMatchObject({
				status: rejected ? "rejected" : "failed",
				usage: rejected ? { totalTokens: 0, cost: { total: 0 } } : null,
			});
			const summary = usageSummary({ calls: session.calls, interruptions: [] });
			expect(summary.missingCalls).toBe(rejected ? 0 : 1);
			expect(summary.reservedTokens).toBe(rejected ? 0 : record.reservedInputTokens + record.reservedOutputTokens);
			expect(
				guard.reserve({
					role: "writer",
					model: record.model,
					inputTokensEstimate: record.reservedInputTokens,
					maxOutputTokens: record.reservedOutputTokens,
				}).ok,
			).toBe(rejected);
		} finally {
			globalThis.fetch = originalFetch;
			fixture.cleanup();
		}
	},
);
