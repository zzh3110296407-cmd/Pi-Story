import { expect, test } from "vitest";
import type { HumanScore } from "../../../scripts/eval/p2/score.ts";
import { type ScenarioBatch, scoreScenarioBatches } from "../../../scripts/eval/p3/scenario-score.ts";

function batches(): ScenarioBatch[] {
	return [1, 2].map((repetition) => ({
		runId: `run-${repetition}`,
		repetition,
		expected: Array.from({ length: 32 }, (_, i) => ({ id: `case-${i}`, category: i < 12 ? "H" : "A" })),
		results: Array.from({ length: 32 }, (_, i) => ({
			id: `case-${i}`,
			status: "measured",
			firstAcceptable: true,
			forbidden: [],
			programChecks: [],
			judgeChecks: [],
		})),
	}));
}
function judgments(runs: ScenarioBatch[]): HumanScore[] {
	return runs.flatMap((run) =>
		run.expected.flatMap((sample) => [
			{
				metric: "T02",
				component: "decision",
				sampleId: sample.id,
				runId: run.runId,
				pass: true,
				status: "author_approved" as const,
			},
			...(sample.category === "H"
				? [
						{
							metric: "T03",
							component: "recovery",
							sampleId: sample.id,
							runId: run.runId,
							pass: true,
							status: "author_approved" as const,
						},
					]
				: []),
		]),
	);
}
test("P3 requires both full rounds and independent judgments, retaining a blocked measurement", () => {
	const runs = batches();
	expect(scoreScenarioBatches("SCEN", runs).metrics.every((metric) => metric.passed === null)).toBe(true);
	expect(
		scoreScenarioBatches("SCEN", runs, judgments(runs)).metrics.map((metric) => [metric.n, metric.passed]),
	).toEqual([
		[64, true],
		[24, true],
	]);
	runs[0].results[0].status = "incomplete";
	const blocked = scoreScenarioBatches("SCEN", runs, judgments(runs));
	expect(blocked.complete).toBe(false);
	expect(blocked.metrics.map((metric) => metric.passed)).toEqual([null, null]);
	expect(blocked.metrics[0].n).toBe(64);
	expect(scoreScenarioBatches("SCEN", [runs[1]], judgments(runs)).complete).toBe(false);
});
test("S09 requires every expected result including independent prose checks", () => {
	const run: ScenarioBatch = {
		runId: "e2e",
		repetition: 1,
		expected: Array.from({ length: 15 }, (_, i) => ({ id: `e${i}`, category: "E" })),
		results: [],
	};
	run.results = run.expected.map((sample) => ({
		id: sample.id,
		status: "measured",
		firstAcceptable: true,
		forbidden: [],
		programChecks: [{ status: "passed" }],
		judgeChecks: [],
	}));
	run.results[0].judgeChecks = [{ check: "Prose reflects author input", status: "pending" }];
	expect(scoreScenarioBatches("E2E", [run]).metrics[0].passed).toBeNull();
	const judged: HumanScore[] = [
		{
			runId: run.runId,
			metric: "S09",
			component: "effect",
			sampleId: "e0:check:0",
			pass: true,
			status: "author_approved",
		},
	];
	expect(scoreScenarioBatches("E2E", [run], judged).metrics[0]).toMatchObject({ n: 15, passed: true });
	// Paraphrased input visibility requires its own approved judgment; a prose
	// effect judgment does not waive this separate, predeclared input condition.
	run.results[0].programChecks[0].status = "pending_judgment";
	expect(scoreScenarioBatches("E2E", [run], judged).metrics[0].passed).toBeNull();
	judged.push({ ...judged[0], component: "program", sampleId: "e0:program:0", status: "ai_preliminary" });
	expect(scoreScenarioBatches("E2E", [run], judged).metrics[0].passed).toBeNull();
	judged[1].status = "author_approved";
	expect(scoreScenarioBatches("E2E", [run], judged).metrics[0].passed).toBe(true);
	run.results[0].programChecks[0].status = "incomplete";
	expect(scoreScenarioBatches("E2E", [run], judged).metrics[0].passed).toBeNull();
	run.results[0].programChecks[0].status = "failed";
	expect(scoreScenarioBatches("E2E", [run], judged).metrics[0].passed).toBe(false);
	run.results[0].programChecks[0].status = "passed";
	run.results[1].programChecks[0].status = "failed";
	expect(scoreScenarioBatches("E2E", [run], judged).metrics[0]).toMatchObject({ n: 15, passed: false });
});
