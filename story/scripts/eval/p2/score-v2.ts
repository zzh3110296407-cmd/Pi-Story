import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CallRecord, ModelRequest } from "@pi-story/core";
import { schemas, validate } from "../../../packages/core/src/schema/index.ts";
import { estimateInputTokens, sumUsage } from "../../../packages/core/src/usage/index.ts";
import { wilson } from "../scorers/statistics.mjs";
import type { EvidenceRecord } from "./metering.ts";
import { type HumanScore, type P2Metric, type ScoreOptions, scoreEvidence, scoreToolParameters } from "./score.ts";

const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
interface Started extends EvidenceRecord {
	caseId: string;
	reservationId: string;
	toolCallId?: string;
	request: ModelRequest;
	reservedCostUsd: number | null;
}
const key = (row: EvidenceRecord) => JSON.stringify([row.caseId, row.toolCallId ?? "direct", row.reservationId]);
function ratio(id: string, successes: number, n: number, threshold = 1, minimum = 1): P2Metric {
	return {
		id,
		n,
		successes,
		failures: n - successes,
		value: n ? successes / n : null,
		threshold,
		minimum,
		confidence95: wilson(successes, n),
		passed: n >= minimum ? successes / n >= threshold : null,
		status: n >= minimum ? "measured" : "insufficient_evidence",
	};
}
function zero(id: string, failures: number, n: number): P2Metric {
	return {
		id,
		n,
		failures,
		value: failures,
		threshold: 0,
		confidence95: n ? wilson(n - failures, n) : null,
		passed: n ? failures === 0 : null,
		status: n ? "measured" : "not_applicable",
	};
}

// 24's changes are an explicit scoring version. The original scorer remains the
// source of unchanged metrics and continues to reproduce the historical files.
export function scoreEvidenceV2(
	records: EvidenceRecord[],
	judgments: HumanScore[],
	hardOnly = false,
	options: ScoreOptions = {},
) {
	const base = scoreEvidence(records, judgments, hardOnly, options);
	const resumed = records.some((row) => row.type === "measurement_resumed");
	if (base.suiteId === "P2-CTX") return base;
	const starts = new Map<string, Started>(),
		completed = new Map<string, CallRecord>(),
		interrupted = new Map<string, EvidenceRecord>();
	const bound = new Set<string>();
	const requests: { row: EvidenceRecord; start?: Started }[] = [];
	for (const row of records) {
		if (row.type === "role_checkpoint") {
			if (
				row.phase === "started" &&
				object(row.request) &&
				typeof row.request.system === "string" &&
				typeof row.request.user === "string"
			) {
				if (starts.has(key(row))) throw new Error("Duplicate started checkpoint");
				starts.set(key(row), row as Started);
			} else if (row.phase === "completed") {
				const checked = validate(schemas.CallRecord, row.record);
				if (!checked.ok) throw new Error("Invalid completed CallRecord");
				if (completed.has(key(row))) throw new Error("Duplicate completed checkpoint");
				completed.set(key(row), checked.value);
			} else if (row.phase === "interrupted") interrupted.set(key(row), row);
		} else if (row.type === "request" && row.role !== "showrunner") {
			const candidate = [...starts.entries()].findLast(
				([id, start]) =>
					!bound.has(id) &&
					start.caseId === row.caseId &&
					start.request.role === row.role &&
					start.request.model === row.model &&
					start.request.inputSources?.inputDigest === row.inputDigest,
			);
			if (candidate) bound.add(candidate[0]);
			requests.push({ row, ...(candidate ? { start: candidate[1] } : {}) });
		}
	}
	let accounted = 0,
		dispatched = 0,
		sources = 0,
		forbidden = 0,
		missingInputs = 0,
		known = 0,
		under = 0,
		windowOverflow = 0,
		unknown = 0,
		unclassified = 0;
	const details: EvidenceRecord[] = [];
	for (const { row, start } of requests) {
		const terminal = records.find((x) => x.type === "response" && x.requestId === row.requestId);
		const wasDispatched =
			records.some((x) => x.type === "dispatch" && x.requestId === row.requestId) ||
			Number(terminal?.networkAttempts ?? 0) > 0;
		if (!wasDispatched) continue;
		dispatched++;
		const record = start ? completed.get(key(start)) : undefined;
		const interruption = start ? interrupted.get(key(start)) : undefined;
		const inputTrace = start?.request.inputSources;
		const digest = start
			? createHash("sha256")
					.update(JSON.stringify({ system: start.request.system, user: start.request.user }))
					.digest("hex")
			: undefined;
		const traceValid =
			inputTrace?.inputDigest === digest &&
			Array.isArray(inputTrace?.entries) &&
			inputTrace.entries.every(
				(x) => typeof x.entryId === "string" && x.entryId.length > 0 && typeof x.type === "string" && x.type.length > 0,
			);
		const conservative =
			interruption?.classification === "interrupted" &&
			interruption.accounting === "reserved" &&
			interruption.reservedCostUsd === start?.reservedCostUsd;
		const matchingRecord =
			record &&
			start &&
			record.role === start.request.role &&
			record.model === start.request.model &&
			record.reservedOutputTokens === start.request.maxTokens &&
			record.reservedCostUsd === start.reservedCostUsd;
		if (start && (matchingRecord || conservative)) accounted++;
		if (start) {
			let input: unknown;
			try {
				input = JSON.parse(start.request.user);
			} catch {
				input = {};
			}
			const visit = (value: unknown): boolean =>
				Array.isArray(value)
					? value.some(visit)
					: object(value) &&
						Object.entries(value).some(
							([field, child]) =>
								["outline", "intent", "chapterIntent", "authorIntent", "currentFocus", "ledger", "brief"].includes(
									field,
								) || visit(child),
						);
			if (
				(start.request.role === "keeper" && visit(input)) ||
				/\bsk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{8,}/u.test(`${start.request.system}\n${start.request.user}`)
			)
				forbidden++;
			if (
				estimateInputTokens(`${start.request.system}\n${start.request.user}`) + start.request.maxTokens >
				Number(row.contextWindow)
			)
				windowOverflow++;
		} else missingInputs++;
		const usage = record?.usage;
		let classification =
			record?.status === "rejected" ? "rejected" : (terminal?.classification ?? interruption?.classification);
		if (record && usage !== undefined && usage !== null && record.status !== "rejected") {
			known++;
			if (usage.input + usage.cacheRead + usage.cacheWrite > record.reservedInputTokens) under++;
		} else if (record?.status !== "rejected") {
			unknown++;
			if (!["transport_failure", "interrupted", "cancelled"].includes(String(classification))) unclassified++;
		}
		if (record?.status === "rejected" && (!record.rejection || usage?.totalTokens !== 0 || usage.cost.total !== 0)) {
			classification = "invalid_rejection";
			unclassified++;
		}
		details.push({
			type: "call_audit",
			requestId: row.requestId,
			caseId: row.caseId,
			reservationId: start?.reservationId,
			started: Boolean(start),
			completed: Boolean(record),
			interrupted: Boolean(conservative),
			classification,
			productSources: Boolean(record?.inputSources && traceValid),
			reservedCostUsd: start?.reservedCostUsd,
		});
	}
	let aggregateMismatches = 0;
	const productRecords = new Map(completed);
	for (const row of records) {
		let calls: unknown, usage: unknown;
		if (
			row.type === "tool_result" &&
			object(row.message) &&
			object(row.message.details) &&
			row.message.details.schema === "story/macro-result@1"
		) {
			calls = row.message.details.calls;
			usage = row.message.usage;
		} else if (row.type === "keeper_result" || row.type === "edit_result") {
			calls = row.calls;
			usage = row.usage;
		} else continue;
		if (!Array.isArray(calls) || !isDeepStrictEqual(usage, sumUsage(calls as CallRecord[]))) aggregateMismatches++;
		if (Array.isArray(calls)) {
			const toolId = row.type === "tool_result" && object(row.message) ? row.message.toolCallId : "direct";
			const group = [...starts.entries()].filter(
				([, start]) => start.caseId === row.caseId && (start.toolCallId ?? "direct") === toolId,
			);
			calls.forEach((call, index) => {
				const checked = validate(schemas.CallRecord, call);
				if (!checked.ok) {
					aggregateMismatches++;
					return;
				}
				const id =
					(resumed ? group.find(([, start]) => start.reservationId === checked.value.id)?.[0] : group[index]?.[0]) ??
					`unlinked:${row.caseId}:${String(toolId)}:${index}`;
				if (productRecords.has(id) && !isDeepStrictEqual(productRecords.get(id), checked.value)) aggregateMismatches++;
				productRecords.set(id, checked.value);
			});
		}
	}
	for (const [id, record] of productRecords) {
		const start = starts.get(id);
		if (
			start &&
			record.inputSources &&
			isDeepStrictEqual(record.inputSources, start.request.inputSources) &&
			record.inputSources.inputDigest ===
				createHash("sha256")
					.update(JSON.stringify({ system: start.request.system, user: start.request.user }))
					.digest("hex")
		)
			sources++;
	}
	const h12 = {
		...ratio("H12", Math.max(0, accounted - aggregateMismatches), dispatched),
		usageAggregateMismatches: aggregateMismatches,
	};
	const h09 = { ...zero("H09", under, known), unknownCalls: unknown, unclassified };
	if (!known && dispatched && !unclassified) {
		h09.passed = true;
		h09.status = "no_billed_comparisons_all_classified";
	}
	if (unclassified) {
		h09.passed = false;
		h09.status = "unclassified_usage";
	}
	const c02 = { ...zero("C02", forbidden + missingInputs, dispatched), missingInputs };
	const c05 = {
		...zero("C05", windowOverflow + under, dispatched),
		windowOverflow,
		actualInputUnderestimates: under,
		unknownCalls: unknown,
		unclassified,
	};
	if (unclassified) {
		c05.passed = false;
		c05.status = "unclassified_usage";
	}
	const hard = [
		h12,
		h09,
		c02,
		{ ...ratio("C04", sources, productRecords.size), missingProductRecords: productRecords.size - sources },
		c05,
	];
	const metrics = base.metrics.filter((metric) => !hard.some((x) => x.id === metric.id));
	metrics.push(...hard);
	const tools = records
		.filter((x) => x.type === "tool_result" && object(x.message))
		.map((x) => x.message as Record<string, unknown>);
	const repaired = tools.filter((x) => object(x.details) && object(x.details.argumentsRepair));
	const t01 = metrics.find((x) => x.id === "T01");
	if (t01) {
		Object.assign(t01, scoreToolParameters(tools as unknown as Parameters<typeof scoreToolParameters>[0]));
		const successes = Number(t01.successes);
		const categories: Record<string, number> = {};
		const syntaxIds = new Set<string>();
		for (const row of records)
			if (row.type === "provider_response" && object(row.response) && Array.isArray(row.response.content))
				for (const block of row.response.content)
					if (
						object(block) &&
						block.type === "toolCall" &&
						typeof block.argumentsError === "string" &&
						typeof block.id === "string"
					)
						syntaxIds.add(block.id);
		for (const tool of tools.filter(
			(x) =>
				repaired.includes(x) ||
				(x.isError && !(object(x.details) && x.details.schema === "story/macro-result@1" && object(x.details.intent))),
		)) {
			const error = object(tool.details) && object(tool.details.error) ? tool.details.error : undefined;
			const fields = Array.isArray(error?.items) ? error.items.join(" ") : "";
			const category =
				object(tool.details) && tool.details.argumentsRepair
					? "json_syntax_repaired"
					: syntaxIds.has(String(tool.toolCallId))
						? "json_syntax"
						: fields.includes("quotes") || fields.includes("authorQuote")
							? "author_quote"
							: fields.includes("key")
								? "bible_key"
								: String(error?.message ?? "").includes("重复")
									? "duplicate_initial_submission"
									: String(error?.code ?? "domain_or_execution");
			categories[category] = (categories[category] ?? 0) + 1;
		}
		t01.failureCategories = categories;
		t01.afterRepairUsability = { n: t01.n, successes: successes + repaired.filter((x) => !x.isError).length };
	}
	const k08 = metrics.find((x) => x.id === "K08");
	if (k08) {
		const parts = ["precision", "recall"].map((component) => {
			const rows = judgments.filter(
				(x) =>
					x.runId === base.runId && x.status === "author_approved" && x.metric === "K08" && x.component === component,
			);
			return ratio(
				component,
				rows.filter((x) => x.pass).length,
				rows.length,
				component === "precision" ? 0.7 : 0.5,
				20,
			);
		});
		Object.assign(k08, {
			n: parts[1].n,
			components: Object.fromEntries(parts.map((x) => [x.id, { n: x.n, successes: x.successes }])),
			value: Object.fromEntries(parts.map((x) => [x.id, x.value])),
			confidence95: Object.fromEntries(parts.map((x) => [x.id, x.confidence95])),
			passed: parts.every((x) => x.n >= 20) ? parts.every((x) => x.passed) : null,
			status: parts.every((x) => x.n >= 20) ? "author_measured" : "insufficient_evidence",
			precisionBasis: "qualified judgment of each output operation; recall remains one-to-one gold matching",
		});
	}
	return { ...base, scoringVersion: "p2r-24@1", metrics, observations: { ...base.observations, callAudit: details } };
}
