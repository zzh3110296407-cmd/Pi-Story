import { mkdtempSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { bookAllowance, plannedTarget } from "../../../scripts/eval/p3r2/books.ts";

test("BOOK restart retains known fees and unknown reservations inside the original two-dollar allowance", () => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("Project workspace required");
	const root = mkdtempSync(path.join(work, "temp/p3r2-book-budget-"));
	const ledger = new UsageLedger(path.join(root, "fees.jsonl"), path.join(root, "reserves.jsonl"));
	const request = (runId: string, reservedCostUsd: number) =>
		ledger.reserve({
			runId,
			reservedCostUsd,
			runLimitUsd: 2,
			suiteId: "P3R2-BOOK",
			role: "writer",
			model: "faux",
			reservedInputTokens: 1,
			reservedOutputTokens: 1,
		});
	const known = request("original", 0.2);
	ledger.complete(
		known,
		{
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
		},
		"stop",
	);
	request("original", 0.4);
	request("restart", 0.3);
	expect(bookAllowance(ledger, ["original", "restart"], "restart")).toEqual({
		priorUsd: 0.5,
		currentUsd: 0.3,
		runLimitUsd: 1.5,
		remainingUsd: 1.2,
	});
});

test("BOOK capacity requires the observed outline plan and never substitutes the completed chapter count", () => {
	expect(
		plannedTarget([
			{ type: "outline_plan", target: 9 },
			{ type: "heartbeat", lastChapter: 2 },
		]),
	).toBe(9);
	expect(plannedTarget([{ type: "heartbeat", lastChapter: 2 }])).toBeNull();
	expect(() => plannedTarget([{ type: "outline_plan", target: 11 }])).toThrow();
});
