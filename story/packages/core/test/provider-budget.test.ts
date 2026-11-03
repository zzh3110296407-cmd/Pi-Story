import { expect, test } from "vitest";
import { BudgetGuard } from "../src/usage/index.ts";

test("U5 shared budget checks without reserving and settles a showrunner without disguising its role", () => {
	const guard = new BudgetGuard(() => ({ calls: [], interruptions: [], budget: { tokens: 100 } }), {
		price: () => null,
	});
	const request = { role: "showrunner", model: "fake", inputTokensEstimate: 40, maxOutputTokens: 50 };
	expect(guard.check(request).ok).toBe(true);
	expect(guard.inFlight().tokens).toBe(0);
	const reservation = guard.reserve(request);
	if (!reservation.ok) throw new Error("fixture");
	expect(guard.check({ ...request, role: "writer", inputTokensEstimate: 11, maxOutputTokens: 0 }).ok).toBe(false);
	guard.settle(reservation.reservationId, {
		id: reservation.reservationId,
		role: "showrunner",
		model: "fake",
		reservedInputTokens: 40,
		reservedOutputTokens: 50,
		reservedCostUsd: null,
		usage: null,
		status: "missing",
	});
	expect(guard.summary()).toMatchObject({
		knownTokens: 0,
		reservedTokens: 90,
		missingCalls: 1,
		budget: { remainingTokens: 10 },
	});
	expect(guard.reserve({ ...request, role: "writer", inputTokensEstimate: 11, maxOutputTokens: 0 }).ok).toBe(false);
});
