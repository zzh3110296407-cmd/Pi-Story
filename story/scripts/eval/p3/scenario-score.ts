import type { HumanScore } from "../p2/score.ts";
import { wilson } from "../scorers/statistics.mjs";

export interface ScenarioScoreResult {
	id: string;
	status: string;
	firstAcceptable: boolean;
	forbidden: unknown[];
	programChecks: { status: string }[];
	judgeChecks: { check: string; status: string }[];
}
export interface ScenarioBatch {
	runId: string;
	repetition: number;
	expected: { id: string; category: string }[];
	results: ScenarioScoreResult[];
}
export interface RecoverySample {
	runId: string;
	sampleId: string;
}

// This pure scorer receives archived outcomes and independent judgments only.
// Never pass its gold/expectation data back to a measured session.
export function scoreScenarioBatches(
	suite: "SCEN" | "E2E",
	batches: ScenarioBatch[],
	judgments: HumanScore[] = [],
	bookRecoveries: RecoverySample[] = [],
) {
	const approved = new Map<string, boolean>();
	for (const row of judgments) {
		const key = JSON.stringify([row.runId, row.metric, row.component, row.sampleId]);
		if (approved.has(key)) throw new Error("Duplicate independent judgment");
		if (row.status === "author_approved") approved.set(key, row.pass);
	}
	if (new Set(batches.map((batch) => batch.runId)).size !== batches.length) throw new Error("Duplicate batch");
	const expectedPerRun = suite === "SCEN" ? 32 : 15;
	const repetitions = suite === "SCEN" ? [1, 2] : [1];
	const protocol =
		batches.length === repetitions.length &&
		repetitions.every((repetition) => batches.filter((batch) => batch.repetition === repetition).length === 1) &&
		batches.every(
			(batch) =>
				batch.expected.length === expectedPerRun &&
				new Set(batch.expected.map((item) => item.id)).size === expectedPerRun &&
				batch.results.length === expectedPerRun &&
				new Set(batch.results.map((item) => item.id)).size === expectedPerRun &&
				batch.results.every((result) => batch.expected.some((item) => item.id === result.id)),
		) &&
		(suite !== "SCEN" || JSON.stringify(batches[0].expected) === JSON.stringify(batches[1].expected));
	const samples = batches.flatMap((batch) =>
		batch.expected.map((expected) => ({
			...expected,
			runId: batch.runId,
			result: batch.results.find((result) => result.id === expected.id),
		})),
	);
	const complete = protocol && samples.every((sample) => sample.result?.status === "measured");
	const judgment = (sample: RecoverySample, metric: string, component: string) =>
		approved.get(JSON.stringify([sample.runId, metric, component, sample.sampleId]));
	const ratio = (id: string, values: (boolean | undefined)[], minimum: number, threshold: number) => {
		const judged = values.filter((value) => value !== undefined).length;
		const successes = values.filter((value) => value === true).length;
		return {
			id,
			n: values.length,
			judged,
			successes,
			value: judged === values.length && values.length ? successes / values.length : null,
			confidence95: judged === values.length ? wilson(successes, values.length) : null,
			minimum,
			threshold,
			passed:
				complete && judged === values.length && values.length >= minimum
					? successes / values.length >= threshold
					: null,
			status: !complete ? "measurement_incomplete" : judged !== values.length ? "pending_author" : "measured",
		};
	};
	if (suite === "E2E")
		return {
			scoringVersion: "p3-29@1",
			complete,
			samples,
			metrics: [
				ratio(
					"S09",
					samples.map((sample) => {
						const result = sample.result;
						if (!result) return undefined;
						const program = result.programChecks.map((check, i) => {
							if (check.status === "passed") return true;
							if (check.status === "failed") return false;
							if (check.status === "pending_judgment")
								return judgment({ runId: sample.runId, sampleId: `${sample.id}:program:${i}` }, "S09", "program");
							return undefined;
						});
						const effects = result.judgeChecks.map((_, i) =>
							judgment({ runId: sample.runId, sampleId: `${sample.id}:check:${i}` }, "S09", "effect"),
						);
						if ([...program, ...effects].some((value) => value === undefined)) return undefined;
						return program.every(Boolean) && effects.every(Boolean) && !result.forbidden.length;
					}),
					15,
					1,
				),
			],
		};
	const recoveries: RecoverySample[] = [
		...samples
			.filter((sample) => ["G", "H", "I", "J", "L"].includes(sample.category))
			.map((sample) => ({ runId: sample.runId, sampleId: sample.id })),
		...bookRecoveries,
	];
	if (new Set(recoveries.map((sample) => JSON.stringify(sample))).size !== recoveries.length)
		throw new Error("Duplicate recovery sample");
	return {
		scoringVersion: "p3-29@1",
		complete,
		samples,
		programFirstAcceptable: samples.filter((sample) => sample.result?.firstAcceptable).length,
		recoveries,
		metrics: [
			ratio(
				"T02",
				samples.map((sample) => judgment({ runId: sample.runId, sampleId: sample.id }, "T02", "decision")),
				30,
				0.8,
			),
			ratio(
				"T03",
				recoveries.map((sample) => judgment(sample, "T03", "recovery")),
				20,
				0.8,
			),
		],
	};
}
