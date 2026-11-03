import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";

function ledger() {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("P2 workspace required");
	mkdirSync(path.join(work, "temp"), { recursive: true });
	const root = mkdtempSync(path.join(work, "temp/ledger-"));
	return new UsageLedger(path.join(root, "usage.jsonl"), path.join(root, "reservations.jsonl"));
}
const request = (runId = "test") => ({
	suiteId: "P2-OPEN",
	runId,
	role: "showrunner",
	model: "deepseek/deepseek-flash",
	reservedCostUsd: 2,
	reservedInputTokens: 10,
	reservedOutputTokens: 20,
	runLimitUsd: 25,
});

test("unknown and unfinished requests retain their durable reservations across restarts", () => {
	const book = ledger();
	const id = book.reserve(request());
	expect(book.snapshot()).toMatchObject({ knownUsd: 0, reservedUsd: 2, unknownCalls: 1, totalUsd: 2 });
	const resumed = new UsageLedger(book.ledgerFile, book.reservationsFile);
	expect(resumed.snapshot()).toEqual(book.snapshot());
	resumed.complete(id, null, "transport_failure");
	expect(resumed.snapshot().totalUsd).toBe(2);
});

test("reported costs replace their own reservation and identical legitimate calls stay separate", () => {
	const book = ledger();
	const usage = {
		input: 1,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 3,
		cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0, total: 0.5 },
	};
	for (let i = 0; i < 2; i++) book.complete(book.reserve(request()), usage, "stop");
	expect(book.snapshot()).toMatchObject({ knownUsd: 1, reservedUsd: 0, unknownCalls: 0, requests: 2, totalUsd: 1 });
	expect(() => book.complete("absent", usage, "stop")).toThrow();
});

test("the next request cannot cross the twenty-dollar stop or its run allowance", () => {
	const book = ledger();
	book.complete(book.reserve({ ...request(), reservedCostUsd: 19 }), null, "missing");
	expect(() => book.reserve({ ...request(), reservedCostUsd: 1.01 })).toThrow(/20/u);
	expect(() => book.reserve({ ...request("other"), reservedCostUsd: 0.2, runLimitUsd: 0.1 })).toThrow(/run/u);
	expect(book.snapshot().requests).toBe(1);
});

test("a confirmed pre-dispatch cancellation is known zero rather than unknown billed usage", () => {
	const book = ledger();
	book.complete(book.reserve(request()), null, "aborted_before_dispatch", true);
	expect(book.snapshot()).toMatchObject({ requests: 1, totalUsd: 0, unknownCalls: 0, reservedUsd: 0 });
});
