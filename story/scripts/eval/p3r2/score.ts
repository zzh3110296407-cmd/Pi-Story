import type { HumanScore } from "../p2/score.ts";
import { nativeEntries, scoreBookArchives } from "../p3/metrics.ts";
import { type RecoverySample, type ScenarioBatch, scoreScenarioBatches } from "../p3/scenario-score.ts";
import { decisiveRecoveries, measuredToolCalls } from "./tool-calls.ts";

export interface V5ScenarioBatch extends ScenarioBatch {
	results: (ScenarioBatch["results"][number] & {
		readOnlyCalls?: number;
		readOnlyExceeded?: boolean;
		decisionLimitReached?: boolean;
	})[];
}
export function scoreV5Scenarios(
	suite: "SCEN" | "E2E",
	batches: V5ScenarioBatch[],
	judgments: HumanScore[] = [],
	bookRecoveries: (RecoverySample & { hasNextDecision: boolean })[] = [],
) {
	const forced = batches.flatMap((batch) =>
		batch.results
			.filter((result) => result.readOnlyExceeded || result.decisionLimitReached)
			.map((result) => ({ runId: batch.runId, sampleId: result.id })),
	);
	const effective = judgments
		.filter(
			(row) =>
				!(
					row.metric === "T03" &&
					bookRecoveries.some(
						(sample) => !sample.hasNextDecision && sample.runId === row.runId && sample.sampleId === row.sampleId,
					)
				),
		)
		.map((row) => {
			const exceeded = forced.some((sample) => sample.runId === row.runId && sample.sampleId === row.sampleId);
			const result = batches
				.find((batch) => batch.runId === row.runId)
				?.results.find((result) => result.id === row.sampleId);
			const invalidDecision =
				result?.status === "measured" &&
				(!result.firstAcceptable ||
					result.forbidden.length > 0 ||
					result.programChecks.some((check) => check.status === "failed"));
			return (exceeded && ["T02", "T03"].includes(row.metric)) || (row.metric === "T02" && invalidDecision)
				? { ...row, pass: false }
				: row;
		});
	// The legacy statistics helper expects category letters. Keep the full
	// category names in the observations and raw manifests.
	const normalized = batches.map((batch) => ({
		...batch,
		expected: batch.expected.map((sample) => ({ ...sample, category: sample.category.split("_")[0] })),
	}));
	const score = scoreScenarioBatches(
		suite,
		normalized,
		effective,
		bookRecoveries.map(({ runId, sampleId }) => ({ runId, sampleId })),
	);
	return {
		...score,
		scoringVersion: "p3r2-32@1",
		programForcedFailures: forced,
		missingBookRecoveries: bookRecoveries.filter((sample) => !sample.hasNextDecision),
		readOnlyObservations: batches.flatMap((batch) =>
			batch.expected.map((sample) => ({
				runId: batch.runId,
				...sample,
				reads: batch.results.find((result) => result.id === sample.id)?.readOnlyCalls ?? null,
			})),
		),
	};
}

export function scoreV5Books(books: { runId: string; folder: string }[], judgments: HumanScore[] = []) {
	const scored = scoreBookArchives(
		books.map((book) => book.folder),
		judgments,
	);
	return {
		...scored,
		scoringVersion: "p3r2-32@1",
		metrics: scored.metrics.filter((metric) => metric.id !== "T04"),
		rows: scored.rows.map((row, i) => {
			const entries = nativeEntries(books[i].folder);
			return {
				...row,
				toolCalls: measuredToolCalls({
					runId: books[i].runId,
					suite: "BOOK",
					mode: "real",
					entries,
					firstMeasuredIndex: 0,
				}),
				recoveries: decisiveRecoveries(entries, 0),
			};
		}),
		T04: { status: "aggregate_BOOK_SCEN_E2E", scoringVersion: "p3r2-32@1" },
	};
}
