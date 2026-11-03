import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { EvidenceArchive, readEvidence } from "../../../scripts/eval/p2/artifacts.ts";
import { createDriver } from "../../../scripts/eval/p2/driver.ts";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { RunControl } from "../../../scripts/eval/p2/run-control.ts";

test("a 402 stops the shared batch after one dispatch and records a rejected zero fee", async () => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("P2 workspace required");
	mkdirSync(path.join(work, "temp"), { recursive: true });
	const root = mkdtempSync(path.join(work, "temp/p2r-402-"));
	const archive = new EvidenceArchive(path.join(root, "run"), path.join(root, "archive"), {
		suiteId: "P2-OPEN",
		runId: "offline-402",
		expectedCaseIds: ["one", "two"],
		stage: "P2R",
	});
	const ledger = new UsageLedger(path.join(root, "usage.jsonl"), path.join(root, "reservations.jsonl"), {
		stopUsd: 16,
		maximumUsd: 20,
	});
	const control = new RunControl();
	const oldFetch = globalThis.fetch;
	let dispatched = 0;
	globalThis.fetch = async () => {
		dispatched++;
		return new Response(JSON.stringify({ error: { message: "synthetic balance refusal" } }), {
			status: 402,
			headers: { "content-type": "application/json" },
		});
	};
	const options = {
		work: path.join(root, "pi"),
		suiteId: "P2-OPEN" as const,
		runId: "offline-402",
		caseId: "one",
		archive,
		ledger,
		control,
		runLimitUsd: 1,
		phase: "faux" as const,
		model: "deepseek/deepseek-flash",
		configureRuntime: (runtime: Parameters<NonNullable<Parameters<typeof createDriver>[0]["configureRuntime"]>>[0]) =>
			runtime.registerProvider("deepseek", { apiKey: "fixture-local", baseUrl: "https://no-network.test" }),
	};
	let driver: Awaited<ReturnType<typeof createDriver>> | undefined;
	try {
		driver = await createDriver(options);
		await driver.session.prompt("Open a story.");
		expect(control.fatal).toEqual({ reason: "provider_rejected", httpStatus: 402 });
		await expect(createDriver({ ...options, caseId: "two", work: path.join(root, "second") })).rejects.toThrow(
			/HTTP 402/u,
		);
		expect(dispatched).toBe(1);
		expect(ledger.snapshot()).toMatchObject({ requests: 1, unknownCalls: 0, totalUsd: 0 });
	} finally {
		driver?.close();
		globalThis.fetch = oldFetch;
	}
	archive.finish();
	expect(readEvidence(archive.folder).find((row) => row.type === "response")).toMatchObject({
		classification: "rejected",
		httpStatus: 402,
		usageKnown: true,
	});
});

test("the repair ledger enforces its own 16 dollar stop and 20 dollar maximum", () => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("P2 workspace required");
	const root = mkdtempSync(path.join(work, "temp/p2r-budget-"));
	const ledger = new UsageLedger(path.join(root, "usage.jsonl"), path.join(root, "reservations.jsonl"), {
		stopUsd: 16,
		maximumUsd: 20,
	});
	const request = {
		suiteId: "P2-OPEN",
		runId: "repair",
		role: "showrunner",
		model: "fake",
		reservedCostUsd: 15.95,
		reservedInputTokens: 1,
		reservedOutputTokens: 1,
		runLimitUsd: 20,
	};
	ledger.reserve(request);
	expect(() => ledger.reserve({ ...request, reservedCostUsd: 0.1 })).toThrow(/16/u);
	expect(ledger.snapshot()).toMatchObject({ requests: 1, reservedUsd: 15.95 });
});
