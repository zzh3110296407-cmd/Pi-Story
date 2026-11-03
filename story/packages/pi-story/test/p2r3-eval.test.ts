import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { EvidenceArchive, readEvidence } from "../../../scripts/eval/p2/artifacts.ts";
import { openingPrompts, splitDataset } from "../../../scripts/eval/p2/datasets.ts";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { scoreProgram } from "../../../scripts/eval/p2/program-score.ts";
import { readJudgments } from "../../../scripts/eval/p2/rescore.ts";
import { evaluationRound } from "../../../scripts/eval/p2/round.ts";

test("round three selects independent fees and stops before exceeding 6.5 USD", () => {
	const round = evaluationRound(["--round3"]);
	expect(round).toEqual({ stage: "P2R3", limits: { stopUsd: 6.5, maximumUsd: 8 } });
	expect(() => evaluationRound(["--repair", "--round3"])).toThrow(/must not be mixed/u);
	const root = mkdtempSync(path.join(process.env.PI_STORY_WORK_DIR ?? "", "temp/p2r3-fees-"));
	const ledger = new UsageLedger(path.join(root, "fees.jsonl"), path.join(root, "reservations.jsonl"), round.limits);
	const request = {
		suiteId: "P2-KEEP",
		runId: "test",
		role: "keeper",
		model: "faux",
		reservedCostUsd: 6.4,
		reservedInputTokens: 1,
		reservedOutputTokens: 1,
		runLimitUsd: 8,
	};
	ledger.reserve(request);
	expect(() => ledger.reserve({ ...request, reservedCostUsd: 0.2 })).toThrow(/6.5/u);
	expect(ledger.snapshot().requests).toBe(1);
});

test("round-three scan enforces 8 USD without changing legacy raw scoring", () => {
	const payload = {
		scan: { files: 1, hits: [], passed: true },
		fees: { totalUsd: 8.1, knownUsd: 8.1, reservedUsd: 0, unknownCalls: 0 },
	};
	expect(scoreProgram({ suiteId: "P2-Z", runId: "test", stage: "P2R3", payload }).metrics[0]).toMatchObject({
		passed: false,
		threshold: { maximumUsd: 8 },
	});
	expect(scoreProgram({ suiteId: "P2-Z", runId: "old", payload }).metrics[0].passed).toBe(true);
});

test("round-three judgment NA is retained as NA and excluded from scored rows", () => {
	const root = mkdtempSync(path.join(process.env.PI_STORY_WORK_DIR ?? "", "temp/p2r3-judgments-"));
	mkdirSync(path.join(root, "judgments"));
	writeFileSync(path.join(root, "run-manifest.json"), JSON.stringify({ stage: "P2R3" }));
	const row = {
		metric: "K05",
		component: "correct",
		sampleId: "one",
		runId: "test",
		pass: false,
		status: "ai_preliminary",
	};
	writeFileSync(
		path.join(root, "judgments/K05.json"),
		JSON.stringify({
			schema: "story/p2-judgments@2",
			scores: [
				row,
				{ ...row, sampleId: "na", pass: null, applicability: "not_applicable", reason: "No attribution in this item" },
			],
		}),
	);
	expect(readJudgments(root)).toEqual([row]);
	writeFileSync(
		path.join(root, "judgments/K05.json"),
		JSON.stringify({
			schema: "story/p2-judgments@2",
			scores: [{ ...row, pass: false, applicability: "not_applicable", reason: "Must be null" }],
		}),
	);
	expect(() => readJudgments(root)).toThrow(/not.applicable/u);
});

test("J1 filenames are excluded only from historical scoring, while V3 judgments remain readable", () => {
	const root = mkdtempSync(path.join(process.env.PI_STORY_WORK_DIR ?? "", "temp/p2r3-judgment-stage-"));
	mkdirSync(path.join(root, "judgments"));
	const row = {
		metric: "T06",
		component: "precision",
		sampleId: "one",
		runId: "test",
		pass: true,
		status: "ai_preliminary",
	};
	for (const name of ["T06-coverage.json", "K04-rev20261031.json"]) {
		writeFileSync(
			path.join(root, "judgments", name),
			JSON.stringify({ schema: "story/p2-judgments@1", scores: [row] }),
		);
		writeFileSync(path.join(root, "run-manifest.json"), JSON.stringify({ stage: "P2R" }));
		expect(readJudgments(root)).toEqual([]);
		writeFileSync(path.join(root, "run-manifest.json"), JSON.stringify({ stage: "P2R3" }));
		expect(readJudgments(root)).toEqual([row]);
		writeFileSync(path.join(root, "judgments", name), JSON.stringify({ schema: "story/p2-judgments@1", scores: [] }));
	}
});

test("round-three development keeps CHAP at the three original train prompts while OPEN uses all twenty", () => {
	const root = path.resolve(import.meta.dirname, "../../../testing");
	expect(openingPrompts(splitDataset(root, "DS08-opening-prompts", "v1", "development", "E12"), true)).toHaveLength(3);
	expect(
		openingPrompts(splitDataset(root, "DS08-opening-prompts", "v1", "development", "E12", true), false),
	).toHaveLength(20);
});

test("round-three interrupted checkpoints remain explicitly archived before final scoring", () => {
	const root = mkdtempSync(path.join(process.env.PI_STORY_WORK_DIR ?? "", "temp/p2r3-checkpoints-"));
	const archive = new EvidenceArchive(path.join(root, "run"), path.join(root, "work"), {
		suiteId: "P2-KEEP",
		runId: "test",
		expectedCaseIds: ["one"],
		stage: "P2R3",
	});
	archive.emit({
		type: "role_checkpoint",
		phase: "started",
		caseId: "one",
		reservationId: "pending",
		request: { role: "keeper", system: "Extract", user: "{}" },
	});
	archive.finish();
	expect(
		readEvidence(path.join(root, "run"), true)
			.filter((row) => row.type === "role_checkpoint")
			.map((row) => row.phase),
	).toEqual(["started", "interrupted"]);
});
