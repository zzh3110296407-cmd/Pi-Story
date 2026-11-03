import type { P2Metric } from "./score.ts";

export interface ProgramRaw {
	suiteId: string;
	runId: string;
	payload: unknown;
	stage?: "P2" | "P2R" | "P2R3";
}
export function scoreProgram(raw: ProgramRaw) {
	let metric: P2Metric;
	if (raw.suiteId === "P2-Z") {
		const result = raw.payload as {
			scan: { files: number; hits: unknown[]; passed: boolean };
			fees: { totalUsd: number; knownUsd: number; reservedUsd: number; unknownCalls: number };
		};
		const maximumUsd = raw.stage === "P2R3" ? 8 : raw.stage === "P2R" ? 20 : 25;
		metric = {
			id: "P2-Z",
			n: result.scan.files,
			value: { hits: result.scan.hits.length, ...result.fees },
			threshold: { hits: 0, maximumUsd },
			confidence95: null,
			passed: result.scan.passed && Number.isFinite(result.fees.totalUsd) && result.fees.totalUsd <= maximumUsd,
			status: "measured",
		};
	} else if (raw.suiteId === "P2-RESCORE") {
		const results = raw.payload as { folder: string; equal: boolean }[];
		const successes = results.filter((result) => result.equal).length;
		metric = {
			id: "P2-R",
			n: results.length,
			value: results.length ? successes / results.length : null,
			threshold: 1,
			confidence95: null,
			passed: results.length > 0 && successes === results.length,
			status: "measured",
		};
	} else if (raw.suiteId === "P2-REG") {
		const results = raw.payload as {
			manifest: { status: string };
			metrics: { metrics: { passed: boolean | null }[] };
		}[];
		const successes = results.filter(
			(item) => item.manifest.status === "passed" && item.metrics.metrics.every((value) => value.passed !== false),
		).length;
		metric = {
			id: "H01-H08,H13",
			n: results.length,
			value: results.length ? successes / results.length : null,
			threshold: 1,
			confidence95: null,
			passed: results.length > 0 && successes === results.length,
			status: "measured",
		};
	} else {
		const report = raw.payload as {
			numTotalTests: number;
			numPassedTests: number;
			numFailedTests: number;
			numPendingTests: number;
			numTodoTests: number;
			success: boolean;
		};
		const skipped = report.numPendingTests + report.numTodoTests;
		metric = {
			id: raw.suiteId === "P2-UNIT" ? "H02" : raw.suiteId === "P2-GUARD" ? "H10" : "P2-F",
			n: report.numTotalTests,
			value: report.numTotalTests ? report.numPassedTests / report.numTotalTests : null,
			skipped,
			threshold: 1,
			confidence95: null,
			passed:
				report.success &&
				report.numFailedTests === 0 &&
				skipped === 0 &&
				report.numPassedTests === report.numTotalTests &&
				report.numTotalTests > 0,
			status: "measured",
		};
	}
	return { schema: "story/metrics@2", suiteId: raw.suiteId, runId: raw.runId, metrics: [metric] };
}
