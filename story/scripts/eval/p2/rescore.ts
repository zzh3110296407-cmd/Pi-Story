import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { wilson } from "../scorers/statistics.mjs";
import { publicEvidence, readEvidence } from "./artifacts.ts";
import { type ProgramRaw, scoreProgram } from "./program-score.ts";
import { type HumanScore, hardMetricIds, type P2Metric, scoreEvidence } from "./score.ts";
import { scoreEvidenceV2 } from "./score-v2.ts";
import { scoreEvidenceV3 } from "./score-v3.ts";

export function readJudgments(folder: string, stage?: "P3"): HumanScore[] {
	const directory = path.join(folder, "judgments");
	if (!existsSync(directory)) return [];
	const result: HumanScore[] = [];
	const ids = new Set<string>();
	const manifest = path.join(folder, "run-manifest.json");
	const round3 =
		stage === "P3" || (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).stage === "P2R3");
	for (const file of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
		// 25 J1 adds new interpretations; they must not alter historical scoring.
		if (!round3 && ["T06-coverage.json", "K04-rev20261031.json"].includes(file)) continue;
		const text = readFileSync(path.join(directory, file), "utf8");
		publicEvidence(text);
		const document = JSON.parse(text) as { schema: string; scores: HumanScore[]; approval?: { evidence: string } };
		const version2 = document.schema === "story/p2-judgments@2" && round3;
		if ((!version2 && document.schema !== "story/p2-judgments@1") || !Array.isArray(document.scores))
			throw new Error("Unknown P2 judgment schema");
		for (const row of document.scores) {
			const notApplicable = version2 && object(row) && row.applicability === "not_applicable";
			if (notApplicable && (row.pass !== null || typeof row.reason !== "string" || !row.reason.trim()))
				throw new Error("A not-applicable judgment requires null pass and an explicit reason");
			if (
				!object(row) ||
				[row.metric, row.component, row.sampleId, row.runId].some(
					(value) => typeof value !== "string" || !value.trim(),
				) ||
				(!notApplicable && typeof row.pass !== "boolean") ||
				!["ai_preliminary", "author_approved"].includes(row.status)
			)
				throw new Error("Invalid P2 judgment row");
			const evidence = document.approval?.evidence;
			if (row.status === "author_approved" && (typeof evidence !== "string" || !evidence.trim()))
				throw new Error("Author judgment has no approval evidence");
			if (("final" in row && row.final !== row.pass) || ("itemId" in row && row.itemId !== row.sampleId))
				throw new Error("Original judgment fields disagree with the normalized score");
			if (
				(row.metric === "P2-O6" && !["fixed", "introduced"].includes(row.component)) ||
				(row.metric === "P2-O7" && row.component !== "relevant")
			)
				throw new Error("Invalid P2 observation component");
			const id = `${row.runId}:${row.metric}:${row.component}:${row.sampleId}`;
			if (ids.has(id)) throw new Error("Duplicate P2 judgment sample");
			ids.add(id);
			if (!notApplicable) result.push(row);
		}
	}
	return result;
}

export function rescoreRun(folder: string, update = false) {
	const program = path.join(folder, "raw/program.json");
	const stage = existsSync(path.join(folder, "run-manifest.json"))
		? JSON.parse(readFileSync(path.join(folder, "run-manifest.json"), "utf8")).stage
		: "P2";
	const metrics = existsSync(program)
		? scoreProgram(JSON.parse(readFileSync(program, "utf8")) as ProgramRaw)
		: stage === "P2R3"
			? scoreEvidenceV3(readEvidence(folder, true), readJudgments(folder))
			: stage === "P2R"
				? scoreEvidenceV2(readEvidence(folder, true), readJudgments(folder))
				: scoreEvidence(readEvidence(folder), readJudgments(folder));
	const file = path.join(folder, "metrics.json");
	const previous: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
	const equal = isDeepStrictEqual(previous, metrics);
	if (update) writeFileSync(file, `${JSON.stringify(metrics, null, 2)}\n`);
	return { equal, metrics };
}

interface RunScore {
	runId: string;
	repetition: number;
	metrics: P2Metric[];
	executionComplete?: boolean;
}
type Counts = { n: number; successes: number };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
function tally(rows: P2Metric[], reference = rows[0]) {
	const n = rows.reduce((sum, row) => sum + row.n, 0);
	const threshold = reference.threshold;
	if (object(threshold)) {
		const counts: Record<string, Counts> = {};
		for (const component of Object.keys(threshold)) {
			counts[component] = { n: 0, successes: 0 };
			for (const row of rows) {
				if (object(row.components) && object(row.components[component])) {
					counts[component].n += Number(row.components[component].n);
					counts[component].successes += Number(row.components[component].successes);
				} else if (object(row.successes)) {
					counts[component].n += row.n;
					counts[component].successes += Number(row.successes[component]);
				}
			}
		}
		return {
			n,
			value: Object.fromEntries(
				Object.entries(counts).map(([key, count]) => [key, count.n ? count.successes / count.n : null]),
			),
			counts,
			confidence95: Object.fromEntries(
				Object.entries(counts).map(([key, count]) => [key, wilson(count.successes, count.n)]),
			),
		};
	}
	if (threshold === 0) {
		const failures = rows.reduce((sum, row) => sum + (typeof row.value === "number" ? row.value : 0), 0);
		return {
			n,
			value: n ? failures : null,
			counts: { n, successes: n - failures },
			confidence95: wilson(n - failures, n),
		};
	}
	const successes = rows.reduce((sum, row) => sum + (typeof row.successes === "number" ? row.successes : 0), 0);
	return { n, value: n ? successes / n : null, counts: { n, successes }, confidence95: wilson(successes, n) };
}
function meets(value: unknown, threshold: unknown): boolean {
	if (object(threshold))
		return object(value) && Object.entries(threshold).every(([key, limit]) => meets(value[key], limit));
	return (
		typeof value === "number" && typeof threshold === "number" && (threshold === 0 ? value === 0 : value >= threshold)
	);
}

export function allRealScores(root: string, freeze?: string, stage: "P2R" | "P2R3" = "P2R") {
	if (freeze !== undefined) return allRealScoresAtFreeze(root, freeze, stage);
	const reservations = readFileSync(path.join(root, "request-reservations.jsonl"), "utf8")
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { runId: string; role: string });
	const expected = new Set(reservations.map((row) => row.runId));
	const found = new Set<string>();
	const runs: {
		runId: string;
		suiteId: string;
		internalRequests: number;
		missingObservations: number;
		metrics: P2Metric[];
	}[] = [];
	for (const suite of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()))
		for (const run of readdirSync(path.join(root, suite.name), { withFileTypes: true }).filter((entry) =>
			entry.isDirectory(),
		)) {
			if (!expected.has(run.name)) continue;
			if (found.has(run.name)) throw new Error("Duplicate real run evidence");
			const records = readEvidence(path.join(root, suite.name, run.name));
			const metrics = scoreEvidence(records, [], true).metrics;
			const internalRequests = reservations.filter((row) => row.runId === run.name && row.role !== "showrunner").length;
			const missingObservations = Math.max(
				0,
				internalRequests - records.filter((row) => row.type === "role_call").length,
			);
			for (const metric of metrics) {
				if ((metric.id === "H12" || metric.id === "C04") && metric.n < internalRequests) {
					metric.n = internalRequests;
					metric.failures = internalRequests - Number(metric.successes);
					metric.value = Number(metric.successes) / internalRequests;
					metric.confidence95 = wilson(Number(metric.successes), internalRequests);
					metric.passed = metric.successes === internalRequests;
					metric.status = "measured";
				}
				if (["H09", "C02", "C05"].includes(metric.id) && missingObservations) {
					metric.unknownCalls = Number(metric.unknownCalls ?? 0) + missingObservations;
					metric.passed = Number(metric.value) > 0 ? false : null;
					metric.status = metric.passed === false ? "measured_failure_with_unknown_usage" : "unknown_usage";
				}
			}
			found.add(run.name);
			runs.push({ runId: run.name, suiteId: suite.name, internalRequests, missingObservations, metrics });
		}
	if ([...expected].some((id) => !found.has(id))) throw new Error("A paid reservation has no archived raw evidence");
	const metrics: P2Metric[] = hardMetricIds.map((id) => {
		const rows = runs.flatMap((run) => run.metrics.filter((metric) => metric.id === id));
		if (!rows.length)
			return {
				id,
				n: 0,
				value: null,
				threshold: id === "H12" || id === "C04" ? 1 : 0,
				confidence95: null,
				passed: null,
				status: "insufficient_evidence",
			};
		const pooled = tally(rows);
		const unknownCalls = rows.reduce((sum, row) => sum + Number(row.unknownCalls ?? 0), 0);
		const observedFailure = rows.some((row) => row.passed === false);
		const passed = observedFailure ? false : unknownCalls || !pooled.n ? null : meets(pooled.value, rows[0].threshold);
		return {
			id,
			...pooled,
			threshold: rows[0].threshold,
			unknownCalls,
			passed,
			status: passed === null ? (unknownCalls ? "unknown_usage" : "insufficient_evidence") : "measured",
		};
	});
	return { schema: "story/p2-all-real@1", runs, metrics };
}

function allRealScoresAtFreeze(root: string, freeze: string, stage: "P2R" | "P2R3") {
	if (!/^[a-f0-9]{40}$/u.test(freeze)) throw new Error("A full frozen commit is required");
	const reservations = readFileSync(path.join(root, "request-reservations.jsonl"), "utf8")
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { runId: string; requestId: string; role: string });
	const expected = new Set(reservations.map((row) => row.runId));
	const found = new Set<string>();
	const runs: {
		runId: string;
		suiteId: string;
		internalRequests: number;
		missingObservations: number;
		metrics: P2Metric[];
	}[] = [];
	for (const suite of readdirSync(root, { withFileTypes: true }).filter(
		(entry) => entry.isDirectory() && entry.name.startsWith("P2-"),
	)) {
		for (const run of readdirSync(path.join(root, suite.name), { withFileTypes: true }).filter((entry) =>
			entry.isDirectory(),
		)) {
			const folder = path.join(root, suite.name, run.name);
			const file = path.join(folder, "run-manifest.json");
			if (!expected.has(run.name) && !["P2-OPEN", "P2-CHAP", "P2-KEEP", "P2-EDIT"].includes(suite.name)) continue;
			if (!expected.has(run.name) && !existsSync(file)) continue;
			if (found.has(run.name)) throw new Error("Duplicate real run evidence");
			if (!existsSync(file)) throw new Error("A paid run has no archived provenance");
			const manifest = JSON.parse(readFileSync(file, "utf8"));
			if (
				manifest.runId !== run.name ||
				manifest.suiteId !== suite.name ||
				typeof manifest.repositoryCommit !== "string"
			)
				throw new Error("Invalid paid run provenance");
			found.add(run.name);
			if (manifest.repositoryCommit !== freeze) continue;
			if (manifest.stage !== stage || manifest.dirty !== false)
				throw new Error("Paid run differs from clean frozen source (dirty or wrong stage)");
			const records = readEvidence(folder, true);
			const configuration = records.find((row) => row.type === "configuration");
			if (configuration?.repositoryCommit !== freeze || configuration.dirty !== false)
				throw new Error("Archived configuration differs from frozen provenance");
			const runReservations = reservations.filter((row) => row.runId === run.name);
			const dispatches = records.filter((row) => row.type === "dispatch");
			for (const dispatch of dispatches) {
				const reservation = runReservations.find((row) => row.requestId === dispatch.requestId);
				const request = records.find((row) => row.type === "request" && row.requestId === dispatch.requestId);
				if (!reservation || !request || request.role !== reservation.role)
					throw new Error("A dispatched request has no matching reservation and input evidence");
			}
			const metrics = scoreEvidenceV2(records, [], true).metrics.filter((metric) =>
				hardMetricIds.some((id) => id === metric.id),
			);
			const internalRequests = dispatches.filter((dispatch) =>
				records.some(
					(row) => row.type === "request" && row.requestId === dispatch.requestId && row.role !== "showrunner",
				),
			).length;
			const h12 = metrics.find((metric) => metric.id === "H12");
			runs.push({
				runId: run.name,
				suiteId: suite.name,
				internalRequests,
				missingObservations: internalRequests - Number(h12?.successes ?? 0),
				metrics,
			});
		}
	}
	if ([...expected].some((id) => !found.has(id))) throw new Error("A paid reservation has no archived provenance");
	const metrics: P2Metric[] = hardMetricIds.map((id) => {
		const rows = runs.flatMap((run) => run.metrics.filter((metric) => metric.id === id));
		const threshold = id === "H12" || id === "C04" ? 1 : 0;
		if (!rows.length)
			return { id, n: 0, value: null, threshold, confidence95: null, passed: null, status: "insufficient_evidence" };
		const pooled = tally(rows);
		const unknownCalls = rows.reduce((sum, row) => sum + Number(row.unknownCalls ?? 0), 0);
		const unclassified = rows.reduce((sum, row) => sum + Number(row.unclassified ?? 0), 0);
		const enough = pooled.n > 0 || (id === "H09" && unknownCalls > 0 && unclassified === 0);
		const passed =
			rows.some((row) => row.passed === false) || unclassified > 0
				? false
				: enough
					? pooled.n
						? meets(pooled.value, threshold)
						: true
					: null;
		return {
			id,
			...pooled,
			threshold,
			unknownCalls,
			unclassified,
			passed,
			status: unclassified ? "unclassified_usage" : passed === null ? "insufficient_evidence" : "measured",
		};
	});
	return { schema: "story/p2r-all-real@1", scoringVersion: "p2r-24@1", repositoryCommit: freeze, runs, metrics };
}

export function aggregateScores(runs: RunScore[], scoringVersion?: "p2r-24@1" | "p2r3-26@1") {
	const repairScoring = scoringVersion !== undefined;
	if (new Set(runs.map((run) => run.runId)).size !== runs.length) throw new Error("Duplicate aggregate run");
	const grouped = new Map<string, { repetition: number; metric: P2Metric }[]>();
	for (const run of runs) {
		if (run.repetition !== 1 && run.repetition !== 2) throw new Error("Acceptance needs repetition 1 or 2");
		for (const metric of run.metrics) {
			const selected = grouped.get(metric.id) ?? [];
			selected.push({ repetition: run.repetition, metric });
			grouped.set(metric.id, selected);
		}
	}
	const metrics = [...grouped.entries()].map(([id, values]) => {
		const rows = values.map(({ metric }) => metric);
		const pooled = tally(rows);
		const perRepetition = [1, 2].map((repetition) => ({
			repetition,
			...tally(
				values.filter((row) => row.repetition === repetition).map((row) => row.metric),
				rows[0],
			),
		}));
		const threshold = rows[0].threshold;
		const minimum = Math.max(1, ...rows.map((row) => (typeof row.minimum === "number" ? row.minimum : 1)));
		let value: unknown = pooled.value;
		if (!rows[0].manual) {
			if (object(threshold))
				value = Object.fromEntries(
					Object.keys(threshold).map((key) => [
						key,
						perRepetition.every((row) => object(row.value) && typeof row.value[key] === "number")
							? perRepetition.reduce((sum, row) => sum + Number(object(row.value) ? row.value[key] : 0), 0) / 2
							: null,
					]),
				);
			else
				value = perRepetition.every((row) => typeof row.value === "number")
					? perRepetition.reduce((sum, row) => sum + Number(row.value), 0) / 2
					: null;
		}
		const unknownCalls = rows.reduce((sum, row) => sum + Number(row.unknownCalls ?? 0), 0);
		const unclassified = rows.reduce((sum, row) => sum + Number(row.unclassified ?? 0), 0);
		const classifiedUsage = repairScoring && ["H09", "C05"].includes(id) && unclassified === 0;
		const noBilledComparisons =
			repairScoring &&
			id === "H09" &&
			pooled.n === 0 &&
			unknownCalls > 0 &&
			unclassified === 0 &&
			rows.every((row) => row.passed === true);
		if (noBilledComparisons) value = 0;
		const componentsEnough =
			!repairScoring ||
			id !== "K08" ||
			Object.values(pooled.counts).every((count) => object(count) && Number(count.n) >= minimum);
		const enough =
			noBilledComparisons ||
			(pooled.n >= minimum &&
				componentsEnough &&
				(rows[0].manual || perRepetition.every((row) => row.n > 0)) &&
				(unknownCalls === 0 || classifiedUsage));
		let passed =
			(repairScoring &&
				hardMetricIds.some((hard) => hard === id) &&
				(unclassified > 0 || rows.some((row) => row.passed === false))) ||
			(threshold === 0 && rows.some((row) => typeof row.value === "number" && row.value > 0))
				? false
				: enough
					? meets(value, threshold)
					: null;
		const unavailable =
			id === "E01"
				? perRepetition.map((group) => {
						const selected = values.filter((row) => row.repetition === group.repetition);
						return group.n
							? selected.reduce((sum, row) => sum + Number(row.metric.unavailable ?? 0) * row.metric.n, 0) / group.n
							: null;
					})
				: undefined;
		if (
			passed &&
			unavailable?.every((item) => item !== null) &&
			unavailable.reduce<number>((sum, item) => sum + Number(item), 0) / 2 > 0.03
		)
			passed = false;
		return {
			id,
			n: pooled.n,
			value,
			threshold,
			minimum,
			confidence95: pooled.confidence95,
			counts: pooled.counts,
			perRepetition: perRepetition.map(({ repetition, n, value }) => ({ repetition, n, value })),
			passed,
			...(unknownCalls ? { unknownCalls } : {}),
			...(repairScoring && hardMetricIds.some((hard) => hard === id) ? { unclassified } : {}),
			status:
				passed === null
					? unknownCalls
						? "unknown_usage"
						: rows.some((row) => row.status === "pending_author")
							? "pending_author"
							: "insufficient_evidence"
					: "measured",
			...(unavailable ? { unavailable } : {}),
		};
	});
	return {
		schema: "story/p2-aggregate@1",
		...(scoringVersion ? { scoringVersion } : {}),
		executionComplete: runs.length > 0 && runs.every((run) => run.executionComplete === true),
		runs: runs.map(({ runId, repetition }) => ({ runId, repetition })),
		metrics,
	};
}
