import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { verifyDataset } from "../scripts/eval/datasets.mjs";
import { repository, sourceEvidence } from "../scripts/eval/paths.mjs";
import { classification, median, wilson } from "../scripts/eval/scorers/statistics.mjs";
import { compareSuiteMetrics, scoreSuite } from "../scripts/eval/scorers/suites.mjs";

test("evaluation: frozen dataset digest mismatch and missing datasets fail closed", () => {
	const root = path.join(process.env.PI_STORY_WORK_DIR ?? "D:/开源/test/pi-Story/p1", "eval-tools");
	mkdirSync(root, { recursive: true });
	const workspace = mkdtempSync(path.join(root, "dataset-"));
	const folder = path.join(workspace, "datasets/DS-test/v1");
	mkdirSync(folder, { recursive: true });
	writeFileSync(path.join(folder, "data.json"), "[]");
	writeFileSync(
		path.join(folder, "manifest.json"),
		JSON.stringify({
			schema: "story/dataset-manifest@1",
			version: "v1",
			frozenAt: "2026-10-28",
			files: [{ path: "data.json", sha256: createHash("sha256").update("[]").digest("hex") }],
		}),
	);
	assert.equal(verifyDataset(workspace, "DS-test").manifest.version, "v1");
	writeFileSync(path.join(folder, "extra.json"), "[]");
	assert.throws(() => verifyDataset(workspace, "DS-test"), /Unregistered dataset file/u);
	unlinkSync(path.join(folder, "extra.json"));
	writeFileSync(path.join(folder, "data.json"), "[1]");
	assert.throws(() => verifyDataset(workspace, "DS-test"), /digest mismatch/u);
	assert.throws(() => verifyDataset(workspace, "missing"), /ENOENT/u);
});
test("evaluation: precision recall F1 and Wilson use fixed independent arithmetic", () => {
	const score = classification(8, 2, 4);
	assert.equal(score.precision, 0.8);
	assert.equal(score.recall, 2 / 3);
	assert.ok(Math.abs(score.f1 - 8 / 11) < 1e-12);
	const interval = wilson(8, 10);
	assert.ok(interval && Math.abs(interval[0] - 0.49016247) < 1e-7 && Math.abs(interval[1] - 0.94331785) < 1e-7);
	assert.equal(wilson(0, 0), null);
	assert.equal(median([4, 1, 3, 2, 5]), 3);
	assert.equal(classification(0, 0, 1).precision, null);
});

test("evaluation: no data, skipped tests and missed violations cannot pass gates", () => {
	assert.equal(scoreSuite("P1-UNIT", { numPassedTests: 3, numTotalTests: 4 }, [])[0].passed, false);
	assert.equal(scoreSuite("P1-UNIT", { numPassedTests: 0, numTotalTests: 0 }, [])[0].passed, false);
	assert.equal(scoreSuite("P1-DELTA", {}, [])[0].passed, false);
	assert.equal(scoreSuite("P1-CHECK", {}, [])[0].passed, false);
	assert.equal(
		scoreSuite("P1-S0", {}, [{ kind: "boundaries", data: { negative: 2, passed: 2, skipped: true, exitCode: 0 } }])[0]
			.passed,
		false,
	);
	assert.equal(scoreSuite("P1-REPLAY", {}, [])[0].classificationGatePassed, false);
});

test("H14 uses raw medians for the gate and rounded values only for display", () => {
	const observation = [
		{ kind: "performance", data: { fullMs: [49, 50, 51, 52, 53], incrementalMs: [7, 8, 9, 10, 11] } },
	];
	const metrics = scoreSuite("P1-FOLD", {}, observation);
	assert.equal(metrics.find((item) => item.id === "H14").value, 0.051);
	assert.equal(metrics.find((item) => item.id === "H14").displayValue, 0.1);
	assert.equal(metrics.find((item) => item.id === "H14-O").value, 0.009);
	observation[0].data.fullMs = [999, 1000, 1000.01, 1001, 1002];
	assert.equal(scoreSuite("P1-FOLD", {}, observation).find((item) => item.id === "H14").passed, false);
});

test("P1 replay classifications must match independent judgments and retain later semantic findings", () => {
	const rows = Array.from({ length: 37 }, (_, i) => ({
		kind: "replay",
		data: {
			id: `source-${i}`,
			schemaOk: true,
			domainOk: false,
			classification: "subset_difference",
			expectedClassification: "subset_difference",
			semanticFindings: [],
		},
	}));
	rows[0].data.expectedClassification = "rule_finding";
	assert.equal(scoreSuite("P1-REPLAY", {}, rows)[0].classificationGatePassed, false);
	rows[0].data.expectedClassification = "subset_difference";
	rows[0].data.semanticFindings = [{ code: "future_estimate_as_recalled_past" }];
	const metric = scoreSuite("P1-REPLAY", {}, rows)[0];
	assert.equal(metric.classificationGatePassed, true);
	assert.equal(metric.value.judgmentMatches, 37);
	assert.deepEqual(metric.value.semanticFindingIds, ["source-0"]);
});

test("P1-R compares deterministic fields exactly and timings by the approved threshold", () => {
	assert.equal(
		compareSuiteMetrics({ suiteId: "P1-FOLD", metrics: [] }, { suiteId: "P1-FOLD", metrics: [] }).equal,
		false,
	);
	const measure = (ms) => ({
		suiteId: "P1-FOLD",
		metrics: scoreSuite("P1-FOLD", {}, [
			{ kind: "determinism", data: { hash1: "a", hash2: "a" } },
			{ kind: "performance", data: { fullMs: [ms, ms, ms, ms, ms], incrementalMs: [1, 2, 3, 4, 5] } },
		]),
	});
	const original = measure(50),
		rerun = measure(800);
	assert.equal(compareSuiteMetrics(original, rerun).equal, true);
	assert.equal(compareSuiteMetrics(original, measure(1001)).equal, false);
	rerun.metrics[0].n++;
	assert.deepEqual(compareSuiteMetrics(original, rerun).differences, ["H03"]);
});

test("archive provenance requires a real commit object and cannot hide checkout changes", () => {
	const evidence = sourceEvidence();
	const root = path.join(process.env.PI_STORY_WORK_DIR ?? "D:/开源/test/pi-Story/p1", "archive-evidence");
	mkdirSync(root, { recursive: true });
	const archive = mkdtempSync(path.join(root, "export-"));
	const env = {
		PI_STORY_ARCHIVE_COMMIT: evidence.commit,
		PI_STORY_GIT_SOURCE: process.env.PI_STORY_GIT_SOURCE ?? repository,
	};
	assert.deepEqual(sourceEvidence(archive, env), { commit: evidence.commit, dirty: false, archive: true });
	assert.throws(() => sourceEvidence(archive, {}), /explicit commit/u);
	assert.throws(() => sourceEvidence(archive, { ...env, PI_STORY_ARCHIVE_COMMIT: "x" }), /explicit commit/u);
	assert.throws(
		() => sourceEvidence(archive, { ...env, PI_STORY_ARCHIVE_COMMIT: "0".repeat(40) }),
		/evidence unavailable/u,
	);
	if (!evidence.archive) assert.throws(() => sourceEvidence(repository, env), /cannot override/u);
});
