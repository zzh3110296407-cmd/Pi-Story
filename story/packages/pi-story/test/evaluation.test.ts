import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { EvidenceArchive, readEvidence } from "../../../scripts/eval/p2/artifacts.ts";
import { scoreProgram } from "../../../scripts/eval/p2/program-score.ts";
import { aggregateScores, readJudgments, rescoreRun } from "../../../scripts/eval/p2/rescore.ts";
import { scoreEvidence } from "../../../scripts/eval/p2/score.ts";

test("raw archive supports deterministic offline scoring and missing human judgments stay pending", () => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("P2 workspace required");
	mkdirSync(path.join(work, "temp"), { recursive: true });
	const root = mkdtempSync(path.join(work, "temp/archive-"));
	const archive = new EvidenceArchive(path.join(root, "run"), path.join(root, "work"), {
		suiteId: "P2-OPEN",
		runId: "faux",
		expectedCaseIds: ["one", "two"],
	});
	archive.emit({
		type: "opening_result",
		caseId: "one",
		model: { controlRev: 1, bibleRev: 1, outlineRev: 1 },
		attempts: { submit_constraints: 1, submit_bible: 1, submit_outline: 1 },
	});
	archive.emit({
		type: "opening_result",
		caseId: "two",
		model: { controlRev: 0, bibleRev: 0, outlineRev: 0 },
		attempts: {},
	});
	archive.finish();
	const raw = readEvidence(path.join(root, "run"));
	const first = scoreEvidence(raw, []);
	expect(scoreEvidence(raw, [])).toEqual(first);
	expect(first.metrics.find((metric) => metric.id === "T05")).toMatchObject({ n: 2, value: 0.5, passed: null });
	expect(first.metrics.find((metric) => metric.id === "T06")).toMatchObject({
		value: null,
		passed: null,
		status: "pending_author",
	});
});

test("an AI preliminary judgment cannot silently satisfy a human gate", () => {
	const records = [{ type: "meta", suiteId: "P2-EDIT", runId: "faux", expectedCaseIds: [] }];
	const pending = scoreEvidence(records, [
		{ metric: "E03", component: "value", sampleId: "one", runId: "faux", pass: true, status: "ai_preliminary" },
	]);
	expect(pending.metrics.find((metric) => metric.id === "E03")).toMatchObject({ value: null, passed: null });
});

test("two repetitions use the arithmetic mean while retaining pooled sample counts", () => {
	const metric = (n: number, successes: number) => ({
		id: "T01",
		n,
		successes,
		failures: n - successes,
		value: successes / n,
		minimum: 100,
		threshold: 0.9,
		confidence95: null,
		passed: null,
		status: "insufficient_evidence",
	});
	const result = aggregateScores([
		{ runId: "a", repetition: 1, metrics: [metric(30, 30)] },
		{ runId: "b", repetition: 2, metrics: [metric(90, 72)] },
	]);
	expect(result.metrics[0]).toMatchObject({
		n: 120,
		value: 0.9,
		passed: true,
		perRepetition: [
			{ repetition: 1, n: 30, value: 1 },
			{ repetition: 2, n: 90, value: 0.8 },
		],
	});
});

test("offline rescore checks all referenced raw hashes and never makes a network request", () => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("P2 workspace required");
	const root = mkdtempSync(path.join(work, "temp/rescore-"));
	const run = path.join(root, "run");
	const archive = new EvidenceArchive(run, path.join(root, "work"), {
		suiteId: "P2-OPEN",
		runId: "one",
		expectedCaseIds: ["one"],
	});
	archive.emit({ type: "request_body", requestId: "12345678-1234-1234-1234-123456789012", body: { example: true } });
	archive.finish();
	const metrics = scoreEvidence(readEvidence(run), []);
	writeFileSync(path.join(run, "metrics.json"), JSON.stringify(metrics));
	expect(rescoreRun(run).equal).toBe(true);
	const file = path.join(run, "raw/request_body/12345678-1234-1234-1234-123456789012.jsonl.gz");
	const original = readFileSync(file);
	const bytes = Buffer.from(original);
	bytes[0] = bytes[0] ^ 1;
	try {
		writeFileSync(file, bytes);
		expect(() => rescoreRun(run)).toThrow(/digest/u);
	} finally {
		writeFileSync(file, original);
	}
	expect(rescoreRun(run).equal).toBe(true);
});

test("a skipped deterministic test cannot pass P2-UNIT when the remaining tests passed", () => {
	const result = scoreProgram({
		suiteId: "P2-UNIT",
		runId: "offline",
		payload: {
			numTotalTests: 3,
			numPassedTests: 2,
			numFailedTests: 0,
			numPendingTests: 1,
			numTodoTests: 0,
			success: true,
		},
	});
	expect(result.metrics[0]).toMatchObject({ n: 3, skipped: 1, passed: false });
});

test("context scoring counts missing cases and forbidden inputs as failures", () => {
	const result = scoreEvidence(
		[
			{ type: "meta", suiteId: "P2-CTX", runId: "offline", expectedCaseIds: ["one", "missing"] },
			{ type: "context_result", caseId: "one", must: [{ passed: true }], forbidden: [{ passed: false }] },
		],
		[],
	);
	expect(result.metrics.find((metric) => metric.id === "C01")).toMatchObject({ n: 2, value: 0.5, passed: false });
	expect(result.metrics.find((metric) => metric.id === "C02")).toMatchObject({ value: 2, passed: false });
});

test("aggregation cannot turn unknown input usage into a zero-underestimate pass", () => {
	const metric = {
		id: "H09",
		n: 1,
		value: 0,
		threshold: 0,
		confidence95: null,
		passed: null,
		status: "unknown_usage",
		unknownCalls: 1,
	};
	const result = aggregateScores([
		{ runId: "a", repetition: 1, metrics: [metric] },
		{ runId: "b", repetition: 2, metrics: [{ ...metric, unknownCalls: 0 }] },
	]);
	expect(result.metrics[0]).toMatchObject({ unknownCalls: 1, passed: null, status: "unknown_usage" });
});

test("aggregation rejects duplicate runs and exposes unfinished execution separately from measured ratios", () => {
	const metric = {
		id: "T05",
		n: 12,
		value: 1,
		successes: 12,
		threshold: 0.9,
		minimum: 24,
		confidence95: null,
		passed: null,
		status: "insufficient_evidence",
	};
	const one = { runId: "one", repetition: 1, metrics: [metric], executionComplete: false };
	expect(() => aggregateScores([one, one])).toThrow(/Duplicate/u);
	const result = aggregateScores([one, { ...one, runId: "two", repetition: 2, executionComplete: true }]);
	expect(result.metrics[0]).toMatchObject({ n: 24, value: 1, passed: true });
	expect(result.executionComplete).toBe(false);
});

test("persisted author judgments validate normalized IDs and preserve the original decision fields", () => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("P2 workspace required");
	const root = mkdtempSync(path.join(work, "temp/judgment-contract-"));
	mkdirSync(path.join(root, "judgments"));
	const file = path.join(root, "judgments/E03.json");
	const row = {
		metric: "E03",
		component: "value",
		sampleId: "one",
		itemId: "one",
		runId: "faux",
		pass: true,
		final: true,
		preJudge: false,
		authorVerdict: true,
		note: "Fixture correction",
		judgedBy: "AI 预判、作者核对",
		date: "2026-10-29",
		status: "author_approved",
	};
	const save = (score: unknown, evidence: unknown = "fixture approval") =>
		writeFileSync(file, JSON.stringify({ schema: "story/p2-judgments@1", approval: { evidence }, scores: [score] }));
	save(row);
	expect(readJudgments(root)).toMatchObject([{ sampleId: "one", pass: true, preJudge: false, authorVerdict: true }]);
	save({ ...row, sampleId: {} });
	expect(() => readJudgments(root)).toThrow(/Invalid P2 judgment row/u);
	save({ ...row, final: false });
	expect(() => readJudgments(root)).toThrow(/normalized score/u);
	save(row, 42);
	expect(() => readJudgments(root)).toThrow(/approval evidence/u);
});
