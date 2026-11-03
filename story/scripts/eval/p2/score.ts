import { isDeepStrictEqual } from "node:util";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { BranchEntry, CallRecord, DraftDetails, MacroDetails, Usage } from "@pi-story/core";
import { foldBranch } from "@pi-story/core";
import { validateDelta } from "../../../packages/core/src/canon/delta.ts";
import { parseWriter, patchSchema, schemas, validate } from "../../../packages/core/src/schema/index.ts";
import { estimateInputTokens, sumUsage } from "../../../packages/core/src/usage/index.ts";
import type { CallObservation } from "../../../packages/pi-story/src/ports.ts";
import { median, wilson } from "../scorers/statistics.mjs";
import type { EvidenceRecord } from "./metering.ts";
import { executionObservations } from "./observations.ts";

export interface HumanScore {
	metric: string;
	component: string;
	sampleId: string;
	runId: string;
	pass: boolean;
	status: "ai_preliminary" | "author_approved";
}
export interface P2Metric {
	id: string;
	n: number;
	value: unknown;
	threshold: unknown;
	confidence95: unknown;
	passed: boolean | null;
	status: string;
	[key: string]: unknown;
}
export const hardMetricIds = ["H12", "H09", "C02", "C04", "C05"] as const;
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const text = (response: AssistantMessage) =>
	response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
const parsed = (value: string): unknown => {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
};
function original(value: unknown): Record<string, unknown> {
	while (object(value) && "originalInput" in value) value = value.originalInput;
	if (!object(value)) throw new Error("Role input is not a JSON object");
	return value;
}
function ratio(id: string, successes: number, n: number, threshold: number, minimum = 1): P2Metric {
	return {
		id,
		n,
		value: n ? successes / n : null,
		successes,
		failures: n - successes,
		threshold,
		minimum,
		confidence95: wilson(successes, n),
		passed: n >= minimum ? successes / n >= threshold : null,
		status: n >= minimum ? "measured" : "insufficient_evidence",
	};
}
function pair(
	id: string,
	first: number,
	final: number,
	n: number,
	thresholds: [number, number],
	minimum: number,
): P2Metric {
	return {
		id,
		n,
		value: n ? { first: first / n, final: final / n } : null,
		successes: { first, final },
		threshold: { first: thresholds[0], final: thresholds[1] },
		minimum,
		confidence95: { first: wilson(first, n), final: wilson(final, n) },
		passed: n >= minimum ? first / n >= thresholds[0] && final / n >= thresholds[1] : null,
		status: n >= minimum ? "measured" : "insufficient_evidence",
	};
}
function zero(id: string, failures: number, n: number): P2Metric {
	return {
		id,
		n,
		value: failures,
		threshold: 0,
		confidence95: wilson(n - failures, n),
		passed: n ? failures === 0 : null,
		status: n ? "measured" : "insufficient_evidence",
	};
}
const manual: Record<string, { threshold: number | { precision: number; recall: number }; minimum: number }> = {
	T06: { threshold: { precision: 0.85, recall: 0.8 }, minimum: 60 },
	T07: { threshold: 0.9, minimum: 50 },
	W03: { threshold: 0.9, minimum: 60 },
	W04: { threshold: 0.8, minimum: 20 },
	E02: { threshold: 0.6, minimum: 30 },
	E03: { threshold: 0.6, minimum: 50 },
	E04: { threshold: 0.7, minimum: 50 },
	E05: { threshold: 0.85, minimum: 50 },
	E06: { threshold: 0.8, minimum: 20 },
	K03: { threshold: 0.85, minimum: 100 },
	K04: { threshold: 0.6, minimum: 60 },
	K05: { threshold: 0.9, minimum: 100 },
	K06: { threshold: 0.85, minimum: 100 },
	K07: { threshold: 0.9, minimum: 100 },
	K08: { threshold: { precision: 0.7, recall: 0.5 }, minimum: 20 },
};

export interface ScoreOptions {
	receivedOutputsOnly?: boolean;
	openingMinimum?: number;
}
export function scoreToolParameters(messages: ToolResultMessage[], strictFirstAttempt = true): P2Metric {
	let valid = messages.filter(
		(message) =>
			!message.isError ||
			(object(message.details) && message.details.schema === "story/macro-result@1" && object(message.details.intent)),
	).length;
	if (strictFirstAttempt)
		valid -= messages.filter(
			(message) => !message.isError && object(message.details) && object(message.details.argumentsRepair),
		).length;
	return ratio("T01", valid, messages.length, 0.9, 100);
}
export function scoreEvidence(
	records: EvidenceRecord[],
	judgments: HumanScore[],
	hardOnly = false,
	options: ScoreOptions = {},
) {
	const meta = records.find((row) => row.type === "meta");
	if (
		!meta ||
		typeof meta.suiteId !== "string" ||
		typeof meta.runId !== "string" ||
		!Array.isArray(meta.expectedCaseIds)
	)
		throw new Error("Missing raw measurement metadata");
	if (meta.suiteId === "P2-CTX") {
		const contexts = records.filter((row) => row.type === "context_result") as (EvidenceRecord & {
			caseId: string;
			must: { passed: boolean }[];
			forbidden: { passed: boolean }[];
			error?: string;
		})[];
		const successes = meta.expectedCaseIds.filter((id) =>
			contexts.some((row) => row.caseId === id && !row.error && row.must.every((item) => item.passed)),
		).length;
		const missing = meta.expectedCaseIds.filter(
			(id) => !contexts.some((row) => row.caseId === id && !row.error),
		).length;
		const forbidden =
			contexts.reduce((sum, row) => sum + row.forbidden.filter((item) => !item.passed).length, 0) + missing;
		return {
			schema: "story/metrics@2",
			suiteId: meta.suiteId,
			runId: meta.runId,
			metrics: [
				ratio("C01", successes, meta.expectedCaseIds.length, 1),
				zero("C02", forbidden, meta.expectedCaseIds.length),
			],
			observations: { exemptions: ["P3 controlled working-set switch is exempt under 21 section 1.2"] },
		};
	}
	const metrics: P2Metric[] = [];
	const tools = records.filter((row) => row.type === "tool_result") as (EvidenceRecord & {
		caseId: string;
		message: ToolResultMessage;
	})[];
	if (meta.suiteId === "P2-OPEN" || meta.suiteId === "P2-CHAP") {
		metrics.push(
			scoreToolParameters(
				tools.map((row) => row.message),
				false,
			),
		);
	}
	if (meta.suiteId === "P2-OPEN") {
		const outcomes = records.filter((row) => row.type === "opening_result") as (EvidenceRecord & {
			caseId: string;
			model: { controlRev: number; bibleRev: number; outlineRev: number };
			attempts: Record<string, number>;
		})[];
		const successes = meta.expectedCaseIds.filter((id) =>
			outcomes.some(
				(row) =>
					row.caseId === id &&
					row.model.controlRev > 0 &&
					row.model.bibleRev > 0 &&
					row.model.outlineRev > 0 &&
					["submit_constraints", "submit_bible", "submit_outline"].every(
						(name) => row.attempts[name] > 0 && row.attempts[name] <= 3,
					),
			),
		).length;
		metrics.push(ratio("T05", successes, meta.expectedCaseIds.length, 0.9, options.openingMinimum ?? 24));
	}
	const calls = records.filter((row) => row.type === "role_call") as (EvidenceRecord &
		CallObservation & { caseId: string })[];
	const groups = new Map<string, typeof calls>();
	for (const call of calls) {
		const input = original(parsed(call.request.user));
		const draftId = object(input.draft) ? input.draft.draftId : "";
		const key = `${call.caseId}:${call.toolCallId ?? "direct"}:${call.request.role}:${String(input.task)}:${String(draftId)}`;
		const group = groups.get(key) ?? [];
		group.push(call);
		groups.set(key, group);
	}
	for (const [role, task, id, schema, thresholds, minimum] of [
		["writer", "draft", "W01", undefined, [0.95, 0.99], 30],
		["editor", undefined, "E01", schemas.ReviewOutput, [0.8, 0.95], 30],
		["keeper", "settle", "K01", schemas.DeltaProposal, [0.7, 0.95], 30],
	] as const) {
		const selected = [...groups.values()]
			.map((group) =>
				options.receivedOutputsOnly && (id === "W01" || id === "E01")
					? group.filter((call) => text(call.response).length > 0)
					: group,
			)
			.filter(
				(group) =>
					group.length > 0 &&
					group[0].request.role === role &&
					(task === undefined || original(parsed(group[0].request.user)).task === task),
			);
		const flags = selected.map((group) =>
			group.map((call) =>
				schema ? validate(schema, parsed(text(call.response))).ok : parseWriter(text(call.response)).ok,
			),
		);
		metrics.push(
			pair(
				id,
				flags.filter((items) => items[0]).length,
				flags.filter((items) => items.some(Boolean)).length,
				flags.length,
				[...thresholds],
				minimum,
			),
		);
		if (id === "E01")
			metrics[metrics.length - 1].unavailable = flags.length
				? flags.filter((items) => !items.some(Boolean)).length / flags.length
				: null;
		if (
			id === "E01" &&
			flags.length >= minimum &&
			flags.filter((items) => !items.some(Boolean)).length / flags.length > 0.03
		)
			metrics[metrics.length - 1].passed = false;
	}
	const chapters = records.filter((row) => row.type === "chapter_result") as (EvidenceRecord & {
		targetWords: number;
		wordCount: number;
	})[];
	metrics.push(
		ratio(
			"W02",
			chapters.filter((row) => row.wordCount >= row.targetWords * 0.7 && row.wordCount <= row.targetWords * 1.3).length,
			chapters.length,
			0.8,
			20,
		),
	);
	const patches = [...groups.values()].filter(
		(group) => group[0].request.role === "writer" && original(parsed(group[0].request.user)).task === "patch",
	);
	const macros = tools.filter(
		(row) =>
			row.message.toolName === "write_next_chapter" &&
			object(row.message.details) &&
			row.message.details.schema === "story/macro-result@1",
	);
	const edits = records.filter((row) => row.type === "edit_result") as (EvidenceRecord & {
		caseId: string;
		patchApplied: boolean;
	})[];
	metrics.push(
		ratio(
			"W05",
			patches.filter(
				(group) =>
					macros.some(
						(row) =>
							row.message.toolCallId === group[0].toolCallId &&
							(row.message.details as MacroDetails).drafts?.some((draft) => draft.patches?.length),
					) || edits.some((row) => row.caseId === group[0].caseId && row.patchApplied),
			).length,
			patches.length,
			0.9,
			20,
		),
	);
	const contexts = records.filter((row) => row.type === "role_task") as (EvidenceRecord & {
		caseId: string;
		toolCallId?: string;
		entries: BranchEntry[];
		draft: DraftDetails;
	})[];
	const keepers = [...groups.values()].filter((group) => group[0].request.role === "keeper");
	let firstDelta = 0,
		finalDelta = 0;
	for (const group of keepers) {
		const context = contexts.find((row) => row.caseId === group[0].caseId && row.toolCallId === group[0].toolCallId);
		if (!context) throw new Error(`Missing raw keeper context: ${group[0].caseId}`);
		const proposals = group
			.map((call) => parsed(text(call.response)))
			.filter((value) => validate(schemas.DeltaProposal, value).ok);
		const flags = proposals.map((proposal) => validateDelta(foldBranch(context.entries), context.draft, proposal).ok);
		if (flags[0]) firstDelta++;
		if (flags.some(Boolean)) finalDelta++;
	}
	metrics.push(pair("K02", firstDelta, finalDelta, keepers.length, [0.7, 0.9], 30));
	let under = 0,
		contextOverflow = 0,
		forbidden = 0;
	const multiples: number[] = [];
	for (const call of calls) {
		const estimate = estimateInputTokens(
			`${call.request.system}\n${call.request.user}${call.request.output.kind === "json" ? JSON.stringify(call.request.output.schema) : ""}`,
		);
		const actual = call.response.usage.input + call.response.usage.cacheRead + call.response.usage.cacheWrite;
		if (actual > estimate) under++;
		if (actual > 0) multiples.push(estimate / actual);
		const input = original(parsed(call.request.user));
		const visit = (value: unknown): boolean =>
			Array.isArray(value)
				? value.some(visit)
				: object(value) &&
					Object.entries(value).some(
						([key, child]) =>
							[
								"outline",
								"intent",
								"ledger",
								"brief",
								"authorIntent",
								"currentFocus",
								"summary",
								"mustKeep",
								"beats",
							].includes(key) || visit(child),
					);
		if (
			(call.request.role === "keeper" && visit(input)) ||
			/\bsk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{8,}/u.test(`${call.request.system}\n${call.request.user}`)
		)
			forbidden++;
		const request = records.find(
			(row) => row.type === "request" && row.model === call.request.model && typeof row.contextWindow === "number",
		);
		if (!request) throw new Error("Missing raw model context limit");
		if (typeof request.contextWindow === "number" && actual > request.contextWindow) contextOverflow++;
	}
	const recorded = new Map<string, { calls: CallRecord[]; usage?: Usage }>();
	for (const row of macros)
		recorded.set(`${row.caseId}:${row.message.toolCallId}`, {
			calls: (row.message.details as MacroDetails).calls,
			usage: row.message.usage,
		});
	for (const row of records.filter((row) => row.type === "keeper_result" || row.type === "edit_result")) {
		if (!Array.isArray(row.calls)) throw new Error("Missing direct evaluation CallRecords");
		recorded.set(`${row.caseId}:direct`, { calls: row.calls as CallRecord[], usage: row.usage as Usage | undefined });
	}
	let accounted = 0,
		accountable = 0,
		usageMismatches = 0;
	for (const [key, saved] of recorded) {
		const observed = calls.filter((call) => `${call.caseId}:${call.toolCallId ?? "direct"}` === key);
		const n = Math.max(saved.calls.length, observed.length);
		accountable += n;
		for (let i = 0; i < n; i++) {
			const record = saved.calls[i],
				observedCall = observed[i];
			if (!record || !observedCall || !validate(schemas.CallRecord, record).ok) continue;
			const missing =
				["error", "aborted"].includes(observedCall.response.stopReason) &&
				observedCall.response.usage.totalTokens === 0;
			if (
				record.role === observedCall.request.role &&
				record.model === observedCall.request.model &&
				isDeepStrictEqual(record.usage, missing ? null : observedCall.response.usage)
			)
				accounted++;
		}
		if (!isDeepStrictEqual(saved.usage, sumUsage(saved.calls))) usageMismatches++;
	}
	const extraObserved = calls.filter((call) => !recorded.has(`${call.caseId}:${call.toolCallId ?? "direct"}`)).length;
	accountable += extraObserved;
	metrics.push({
		...ratio("H12", Math.max(0, accounted - usageMismatches), accountable, 1),
		usageAggregateMismatches: usageMismatches,
	});
	const unknownInputs = calls.filter(
		(call) => ["error", "aborted"].includes(call.response.stopReason) && call.response.usage.totalTokens === 0,
	).length;
	const estimateMetric = zero("H09", under, calls.length - unknownInputs);
	const contextMetric = zero("C05", contextOverflow + under, calls.length - unknownInputs);
	for (const metric of [estimateMetric, contextMetric])
		if (unknownInputs) {
			metric.unknownCalls = unknownInputs;
			metric.passed = metric.value === 0 ? null : false;
			metric.status = metric.passed === false ? "measured_failure_with_unknown_usage" : "unknown_usage";
		}
	metrics.push(
		estimateMetric,
		zero("C02", forbidden, calls.length),
		ratio("C04", calls.filter((call) => call.inputSources?.length > 0).length, Math.max(accountable, calls.length), 1),
		contextMetric,
	);
	for (const [id, spec] of Object.entries(manual)) {
		const rows = judgments.filter(
			(row) => row.metric === id && row.status === "author_approved" && row.runId === meta.runId,
		);
		if (!rows.length) {
			metrics.push({
				id,
				n: 0,
				value: null,
				threshold: spec.threshold,
				minimum: spec.minimum,
				confidence95: null,
				passed: null,
				status: "pending_author",
				manual: true,
			});
			continue;
		}
		if (typeof spec.threshold === "number")
			metrics.push({
				...ratio(id, rows.filter((row) => row.pass).length, rows.length, spec.threshold, spec.minimum),
				manual: true,
			});
		else {
			const parts = Object.entries(spec.threshold).map(([name, threshold]) => {
				const subset = rows.filter((row) => row.component === name);
				return ratio(name, subset.filter((row) => row.pass).length, subset.length, threshold);
			});
			const n = parts.find((part) => part.id === "recall")?.n ?? 0;
			metrics.push({
				id,
				n,
				value: Object.fromEntries(parts.map((part) => [part.id, part.value])),
				threshold: spec.threshold,
				minimum: spec.minimum,
				manual: true,
				components: Object.fromEntries(parts.map((part) => [part.id, { n: part.n, successes: part.successes }])),
				confidence95: Object.fromEntries(parts.map((part) => [part.id, part.confidence95])),
				passed: n >= spec.minimum ? parts.every((part) => part.passed === true) : null,
				status: n >= spec.minimum ? "author_measured" : "insufficient_evidence",
			});
		}
	}
	const relevant: Record<string, string[]> = {
		"P2-OPEN": ["T01", "T05", "T06", "T07"],
		"P2-CHAP": [
			"T01",
			"H12",
			"H09",
			"C02",
			"C04",
			"C05",
			"W01",
			"W02",
			"W03",
			"W04",
			"W05",
			"E01",
			"E03",
			"E04",
			"E05",
			"E06",
			"K01",
			"K02",
			"K03",
			"K05",
			"K06",
			"K07",
		],
		"P2-KEEP": ["H12", "H09", "C02", "C04", "C05", "K01", "K02", "K03", "K04", "K05", "K06", "K07", "K08"],
		"P2-EDIT": ["H12", "H09", "C02", "C04", "C05", "W05", "E01", "E02", "E03", "E04", "E05", "E06"],
	};
	return {
		schema: "story/metrics@2",
		suiteId: meta.suiteId,
		runId: meta.runId,
		metrics: metrics.filter((metric) =>
			(hardOnly ? ([...hardMetricIds] as string[]) : (relevant[String(meta.suiteId)] ?? [])).includes(metric.id),
		),
		observations: {
			execution: executionObservations(records, judgments),
			ruleTexts: records.find((row) => row.type === "configuration")?.rules ?? null,
			inputEstimateMultiples: {
				n: multiples.length,
				median: median(multiples),
				max: multiples.length ? Math.max(...multiples) : null,
			},
			writerOutputTokens: calls
				.filter((call) => call.request.role === "writer" && original(parsed(call.request.user)).task === "draft")
				.map((call) => call.response.usage.output),
			truncations: calls.filter((call) => call.response.stopReason === "length").length,
			formatFailures: calls.filter(
				(call) =>
					call.request.output.kind === "json" &&
					!(call.request.role === "writer"
						? validate(patchSchema, parsed(text(call.response))).ok
						: validate(
								call.request.role === "keeper" ? schemas.DeltaProposal : schemas.ReviewOutput,
								parsed(text(call.response)),
							).ok),
			).length,
		},
	};
}
