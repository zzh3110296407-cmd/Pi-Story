import { expect, test } from "vitest";
import {
	bookBudgetPreflight,
	interruptionDecision,
	nextBook,
	PRIMARY_BOOKS,
} from "../../../scripts/eval/p3r2/book-policy.ts";

test("BOOK capacity uses only planned targets in the fixed primary and reserve order", () => {
	const plans = PRIMARY_BOOKS.map((id, i) => ({ id, target: [7, 7, 8, 5, 8][i] }));
	expect(nextBook(plans.slice(0, 2)).id).toBe(1587);
	expect(nextBook(plans)).toMatchObject({ id: 378, plannedChapters: 35, reservesUsed: 0 });
	expect(nextBook([...plans, { id: 378, target: 10 }])).toMatchObject({
		id: null,
		plannedChapters: 45,
		capacityReached: true,
	});
	const short = [
		...plans.map((plan) => ({ ...plan, target: 1 })),
		{ id: 378, target: 1 },
		{ id: 886, target: 1 },
		{ id: 217, target: 1 },
	];
	expect(nextBook(short)).toMatchObject({ id: null, capacityReached: false, reservesUsed: 3 });
	expect(() => nextBook([{ id: 527, target: 7 }])).toThrow();
	expect(() => nextBook([{ id: 837, target: 0 }])).toThrow();
});

test("BOOK budget preflight includes unknown reservations and never silently reduces the sample", () => {
	expect(bookBudgetPreflight(1, 50)).toMatchObject({ estimateUsd: 4.5, projectedUsd: 5.5, allowed: true });
	expect(bookBudgetPreflight(2.1, 50)).toMatchObject({ remainingPlannedChapters: 50, allowed: false });
});

test("an unopened primary book preserves its unknown target while all five fixed primary prompts are attempted", () => {
	expect(nextBook([{ id: 837, target: null }])).toMatchObject({
		id: 527,
		plannedChapters: null,
		capacityReached: null,
	});
	const plans = PRIMARY_BOOKS.map((id, i) => ({ id, target: i === 0 ? null : 8 }));
	expect(nextBook(plans)).toMatchObject({ id: null, plannedChapters: null, capacityUnknown: true });
});

test("an external restart requires both known processes gone and no product error, timeout or cancellation", () => {
	const base = {
		parentPid: 101,
		rpcPid: 102,
		parentAlive: false,
		rpcAlive: false,
		productError: false,
		timedOut: false,
		cancelled: false,
		previousRestarts: 0,
	};
	expect(interruptionDecision(base)).toMatchObject({
		classification: "external_interruption",
		restart: true,
		qualityIncluded: false,
	});
	expect(interruptionDecision({ ...base, previousRestarts: 1 })).toMatchObject({
		restart: false,
		repeatedInterruptionIsMissing: true,
	});
	expect(interruptionDecision({ ...base, rpcAlive: true }).restart).toBe(false);
	expect(interruptionDecision({ ...base, rpcPid: undefined }).classification).toBe("insufficient_process_evidence");
	for (const flag of ["productError", "timedOut", "cancelled"] as const)
		expect(interruptionDecision({ ...base, [flag]: true })).toMatchObject({
			classification: "product_failure",
			restart: false,
			qualityIncluded: true,
		});
});
