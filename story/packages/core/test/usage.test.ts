import { expect, test } from "vitest";
import { CallSession } from "../src/flow/calls.ts";
import type { CallRecord, Usage } from "../src/schema/index.ts";
import {
	BudgetGuard,
	estimateCost,
	estimateInputTokens,
	interruptedMacro,
	sumUsage,
	usageSummary,
} from "../src/usage/index.ts";
import { context } from "./context.ts";

const prices = { price: () => ({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 3 }) };
const reported: Usage = {
	input: 10,
	output: 5,
	cacheRead: 2,
	cacheWrite: 3,
	totalTokens: 20,
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};
const call = (usage: Usage | null, status: CallRecord["status"] = "reported"): CallRecord => ({
	role: "writer",
	model: "fake",
	reservedInputTokens: 30,
	reservedOutputTokens: 40,
	reservedCostUsd: 0.1,
	usage,
	status,
});
test("U1 U2 exact token boundary includes all in-flight reservations", () => {
	const guard = new BudgetGuard(() => ({ calls: [], interruptions: [], budget: { tokens: 100 } }), prices);
	expect(guard.reserve({ role: "writer", model: "fake", inputTokensEstimate: 40, maxOutputTokens: 60 }).ok).toBe(true);
	expect(guard.inFlight().tokens).toBe(100);
	expect(guard.reserve({ role: "editor", model: "fake", inputTokensEstimate: 1, maxOutputTokens: 0 }).ok).toBe(false);
	expect(estimateInputTokens("汉あ한𠀀a")).toBe(Math.ceil(4 * 0.889 + 0.309 + 2048));
});
test("U2 money limit uses the most expensive input cache rate and preserves unknown prices", () => {
	expect(estimateCost(prices, "fake", 1_000_000, 1_000_000)).toBe(5);
	const guard = new BudgetGuard(() => ({ calls: [], interruptions: [], budget: { costUsd: 4.99 } }), prices);
	expect(
		guard.reserve({ role: "writer", model: "fake", inputTokensEstimate: 1_000_000, maxOutputTokens: 1_000_000 }).ok,
	).toBe(false);
	const unknown = new BudgetGuard(() => ({ calls: [], interruptions: [], budget: { tokens: 5 } }), {
		price: () => null,
	});
	expect(
		unknown.reserve({ role: "writer", model: "unknown", inputTokensEstimate: 2, maxOutputTokens: 3 }),
	).toMatchObject({ ok: true, costUsd: null });
	expect(unknown.reserve({ role: "writer", model: "unknown", inputTokensEstimate: 1, maxOutputTokens: 0 }).ok).toBe(
		false,
	);
});
test("U3 U4 A.7 missing, failed and interrupted calls remain reserved; known totals are not counted twice", () => {
	const interruptions = [
		{
			schema: "story/interrupted@1" as const,
			toolCallId: "pending",
			toolName: "write_next_chapter",
			reservedTokens: 50,
			reservedCostUsd: null,
			note: "possible_duplicate" as const,
		},
	];
	const summary = usageSummary({
		calls: [call(reported), call(null, "missing"), call(null, "failed"), call(reported, "failed")],
		interruptions,
		knownUsage: { tokens: 40, costUsd: 20 },
		budget: { tokens: 500 },
	});
	expect(summary).toMatchObject({
		knownTokens: 40,
		missingCalls: 2,
		reservedTokens: 190,
		possibleDuplicates: 1,
		estimatedCostUsd: null,
		budget: { remainingTokens: 270 },
	});
	expect(sumUsage([call(null)])).toBeUndefined();
	expect(sumUsage([call(reported), call(reported, "failed")])?.totalTokens).toBe(40);
	const roles = { writer: { model: "f" }, editor: { model: "f" }, keeper: { model: "f" }, verifier: { model: "f" } };
	expect(
		interruptedMacro({
			toolCallId: "x",
			roleInputs: { writer: "", editor: "", keeper: "", verifier: "" },
			roles,
			prices,
		}).reservedTokens,
	).toBe(28 * (2048 + 8192));
});
test("U4 settled usage is retained until authoritative persistence is acknowledged", () => {
	const persisted: CallRecord[] = [];
	const guard = new BudgetGuard(() => ({ calls: persisted, interruptions: [], budget: { tokens: 25 } }), {
		price: () => null,
	});
	const r = guard.reserve({ role: "writer", model: "fake", inputTokensEstimate: 10, maxOutputTokens: 10 });
	if (!r.ok) throw new Error("reservation");
	const record = { ...call(reported), reservedInputTokens: 10, reservedOutputTokens: 10, reservedCostUsd: null };
	guard.settle(r.reservationId, record);
	expect(guard.reserve({ role: "writer", model: "fake", inputTokensEstimate: 6, maxOutputTokens: 0 }).ok).toBe(false);
	persisted.push(record);
	guard.acknowledge([r.reservationId]);
	expect(guard.reserve({ role: "writer", model: "fake", inputTokensEstimate: 5, maxOutputTokens: 0 }).ok).toBe(true);
	expect(() => guard.settle(r.reservationId, record)).toThrow();
});
test("U4 aborted/transport failures settle once, retain known usage and suppress raw transport messages", async () => {
	const ctx = context();
	const settled: CallRecord[] = [];
	ctx.ports.budget.settle = (_id, record) => {
		settled.push(record);
	};
	ctx.ports.models.call = async () => {
		throw Object.assign(new Error("private upstream message"), { usage: reported });
	};
	const session = new CallSession(ctx);
	const result = await session.call("writer", "system", "input", { kind: "text" });
	expect(result.ok).toBe(false);
	expect(JSON.stringify(result)).not.toContain("private upstream");
	expect(settled).toHaveLength(1);
	expect(session.calls[0]).toMatchObject({ usage: reported, status: "failed" });
	const controller = new AbortController();
	controller.abort();
	ctx.signal = controller.signal;
	expect((await session.call("writer", "", "", { kind: "text" })).ok).toBe(false);
	expect(settled).toHaveLength(1);
});
