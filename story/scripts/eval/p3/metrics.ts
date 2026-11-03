import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { FileEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { foldBranch } from "@pi-story/core";
import { schemas, validate } from "../../../packages/core/src/schema/index.ts";
import { wordCount } from "../../../packages/core/src/shared/text.ts";
import { translateBranch } from "../../../packages/pi-story/src/entries.ts";
import { readEvidence, sha256 } from "../p2/artifacts.ts";
import type { EvidenceRecord } from "../p2/metering.ts";
import { type HumanScore, scoreToolParameters } from "../p2/score.ts";
import { scoreEvidenceV3 } from "../p2/score-v3.ts";
import { wilson } from "../scorers/statistics.mjs";
import { scenarioChecks } from "./checks.ts";
import type { Scenario } from "./datasets.ts";
import { type CapturedAction, scoreActions } from "./scenario.ts";
import { scoreBooks } from "./score.ts";

export function measuredToolResults(folder: string) {
	const records = readEvidence(folder, true);
	if (records.find((row) => row.type === "meta")?.main !== "real")
		return { tools: [], excludedDriverCancellations: [] };
	const tools: ToolResultMessage[] = [];
	const excludedDriverCancellations: string[] = [];
	let boundary: unknown;
	let closed = false;
	for (const row of records) {
		if (row.type === "measurement_stop" && row.reason === "opening_complete") boundary = row.afterToolCallId;
		if (row.type !== "tool_result" || row.driverPhase !== "measurement") continue;
		const message = row.message as ToolResultMessage;
		if (closed) excludedDriverCancellations.push(message.toolCallId);
		else tools.push(message);
		if (boundary && message.toolCallId === boundary) closed = true;
	}
	if (boundary && !closed) throw new Error("Opening stop has no matching persisted tool result");
	return { tools, excludedDriverCancellations };
}
export function scoreAllToolParameters(folders: string[]) {
	const samples = folders.map((folder) => ({ folder, ...measuredToolResults(folder) }));
	return {
		metric: scoreToolParameters(samples.flatMap((sample) => sample.tools)),
		driverCancelled: samples.flatMap((sample) =>
			sample.excludedDriverCancellations.map((toolCallId) => ({ folder: sample.folder, toolCallId })),
		),
	};
}
export function scoreNativeInputs(records: EvidenceRecord[]) {
	const samples = records.filter(
		(row) =>
			row.type === "request" &&
			["showrunner", "compaction"].includes(String(row.role)) &&
			records.some((event) => event.type === "dispatch" && event.requestId === row.requestId),
	);
	const rows = samples.map((request) => {
		const terminal = records.find((row) => row.type === "response" && row.requestId === request.requestId);
		const response = terminal?.response as AssistantMessage | undefined;
		const usage = terminal?.usageKnown === true ? response?.usage : undefined;
		return {
			requestId: request.requestId,
			role: request.role,
			under: usage ? usage.input + usage.cacheRead + usage.cacheWrite > Number(request.inputTokensEstimate) : false,
			windowOverflow: Number(request.inputTokensEstimate) + Number(request.maxTokens) > Number(request.contextWindow),
			unknown: !usage,
			unclassified:
				!usage &&
				!["rejected", "transport_failure", "interrupted", "cancelled"].includes(String(terminal?.classification)),
		};
	});
	return {
		rows,
		dispatched: rows.length,
		under: rows.filter((row) => row.under).length,
		windowOverflow: rows.filter((row) => row.windowOverflow).length,
		unknown: rows.filter((row) => row.unknown).length,
		unclassified: rows.filter((row) => row.unclassified).length,
	};
}
export function scoreAllRealArchives(folders: string[]) {
	const all = folders.flatMap((folder) =>
		readEvidence(folder, true).filter((row) => row.driverPhase === "measurement"),
	);
	const internal: EvidenceRecord[] = folders.flatMap((folder) => {
		const records = readEvidence(folder, true);
		if (records.find((row) => row.type === "meta")?.internals !== "real") return [];
		return records
			.filter(
				(row) =>
					row.type !== "meta" &&
					row.driverPhase === "measurement" &&
					!["showrunner", "compaction"].includes(String(row.role)),
			)
			.map((row) => ({ ...row, caseId: `${row.runId}:${row.caseId}` }));
	});
	internal.unshift({
		type: "meta",
		suiteId: "P2-CHAP",
		runId: "P3-all-real",
		expectedCaseIds: [...new Set(internal.map((row) => row.caseId))],
	});
	const scored = scoreEvidenceV3(internal, [], true, { receivedOutputsOnly: true });
	const native = scoreNativeInputs(all);
	for (const metric of scored.metrics) {
		if (!["H09", "C05"].includes(metric.id)) continue;
		const additional = native.under + native.unclassified + (metric.id === "C05" ? native.windowOverflow : 0);
		metric.n += native.dispatched;
		metric.value = Number(metric.value) + additional;
		metric.confidence95 = wilson(Math.max(0, metric.n - Number(metric.value)), metric.n);
		metric.passed = metric.n ? metric.value === 0 && metric.passed !== false : null;
		metric.status = metric.passed === null ? "insufficient_evidence" : "measured";
		metric.nativeDispatched = native.dispatched;
		metric.nativeUnknown = native.unknown;
	}
	return {
		...scored,
		suiteId: "P3-all-real",
		scoringVersion: "p3-29@1",
		T01: scoreAllToolParameters(folders),
		nativeInputAudit: native,
	};
}
export function scoreOpeningArchives(folders: string[], judgments: HumanScore[] = []) {
	const records = folders
		.flatMap((folder) => readEvidence(folder, true))
		.filter(
			(row) =>
				row.type !== "meta" &&
				row.driverPhase === "measurement" &&
				["tool_result", "opening_result"].includes(row.type),
		);
	const ids = [...new Set(records.flatMap((row) => (typeof row.caseId === "string" ? [row.caseId] : [])))];
	const runId = path.basename(path.dirname(folders[0] ?? ""));
	const raw = [{ type: "meta", suiteId: "P2-OPEN", runId, expectedCaseIds: ids }, ...records];
	const scored = scoreEvidenceV3(raw, judgments, false, { receivedOutputsOnly: true, openingMinimum: 10 });
	const outcomes = records.filter((row) => row.type === "opening_result");
	const complete =
		folders.length === 12 &&
		ids.length === 12 &&
		outcomes.length === 12 &&
		new Set(outcomes.map((row) => row.caseId)).size === 12 &&
		outcomes.every((row) => row.measurementStatus === "measured");
	if (!complete)
		for (const metric of scored.metrics) {
			metric.passed = null;
			metric.status = "measurement_incomplete";
		}
	return {
		...scored,
		suiteId: "P3-OPEN",
		scoringVersion: "p3-29@1",
		metrics: scored.metrics.filter((metric) => ["T05", "T06", "T07"].includes(metric.id)),
		T01: { status: "aggregate_all_real_suites", minimum: 100 },
		expectedPrompts: 12,
		observedPrompts: ids.length,
		complete,
	};
}

export function rescoreScenarioArchive(
	scenario: Scenario,
	folder: string,
	protocol: "p3-29@1" | "p3r2-32@1" = scenario.schema === "story/p3-scenario@2" ? "p3r2-32@1" : "p3-29@1",
) {
	const records = readEvidence(folder, true);
	const probeFile = path.join(folder, "saved-showrunner-probe.json");
	if (existsSync(probeFile)) {
		const probe = JSON.parse(readFileSync(probeFile, "utf8")) as {
			schema: string;
			caseId: string;
			sourceSessionSha256: string;
			event: EvidenceRecord;
		};
		const checksums = JSON.parse(readFileSync(path.join(folder, "raw/checksums.json"), "utf8")) as {
			sessionSha256: string;
		};
		if (
			scenario.category !== "E09" ||
			probe.schema !== "story/p3-saved-showrunner-probe@1" ||
			probe.caseId !== scenario.id ||
			probe.sourceSessionSha256 !== checksums.sessionSha256 ||
			probe.event.type !== "driver_probe" ||
			probe.event.probe !== "showrunner_predispatch" ||
			probe.event.driverPhase !== "driver_probe" ||
			probe.event.modelRequests !== 0
		)
			throw new Error("Invalid saved-session guard probe");
		records.push(probe.event);
	}
	const result = records.find((row) => row.type === "scenario_result")?.result as
		| { actions: CapturedAction[]; firstMeasuredIndex: number; injected: boolean; stopReason?: string; status: string }
		| undefined;
	const prepared = records.find((row) => row.type === "prepared")?.entries;
	const entries = nativeEntries(folder);
	if (
		!result ||
		!Array.isArray(result.actions) ||
		!Array.isArray(prepared) ||
		!Number.isSafeInteger(result.firstMeasuredIndex) ||
		result.firstMeasuredIndex < 0 ||
		result.firstMeasuredIndex > entries.length
	)
		throw new Error("Scenario replay evidence missing");
	const missingScriptedReply = Boolean(
		scenario.execution.dialogResponses?.length &&
			records.filter((row) => row.type === "dialog_pause" && row.driverPhase === "measurement").length >
				records.filter((row) => row.type === "dialog_response" && row.driverPhase === "measurement").length,
	);
	return {
		schema: protocol === "p3r2-32@1" ? "story/p3-scenario-rescore@2" : "story/p3-scenario-rescore@1",
		scoringVersion: protocol,
		rawOutcomeRetained: result.status,
		measurementStatus: missingScriptedReply ? "incomplete" : result.status,
		measurementErrors: missingScriptedReply
			? ["Scripted author reply was not delivered after the observed dialog pause"]
			: [],
		...scoreActions(scenario, result.actions),
		programChecks: scenarioChecks(
			scenario,
			{
				before: foldBranch(translateBranch(prepared as SessionEntry[])),
				after: foldBranch(translateBranch(entries)),
				entries,
				firstMeasuredIndex: result.firstMeasuredIndex,
				actions: result.actions,
				observed: records,
				stopReason: result.stopReason,
				injected: result.injected,
			},
			protocol,
		),
	};
}

export function nativeEntries(folder: string): SessionEntry[] {
	const checksums = JSON.parse(readFileSync(path.join(folder, "raw/checksums.json"), "utf8")) as {
		sessionSha256?: string;
	};
	const bytes = readFileSync(path.join(folder, "raw/session.jsonl.gz"));
	if (!checksums.sessionSha256 || sha256(bytes) !== checksums.sessionSha256)
		throw new Error("Native session digest mismatch");
	const entries = gunzipSync(bytes)
		.toString("utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as FileEntry)
		.filter((entry): entry is SessionEntry => entry.type !== "session");
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	if (byId.size !== entries.length) throw new Error("Duplicate native session entry IDs");
	const branch: SessionEntry[] = [];
	let entry: SessionEntry | undefined = entries.at(-1);
	const seen = new Set<string>();
	while (entry) {
		if (seen.has(entry.id)) throw new Error("Cyclic native branch");
		seen.add(entry.id);
		branch.unshift(entry);
		const parent = entry.parentId;
		entry = parent ? byId.get(parent) : undefined;
		if (parent && !entry) throw new Error("Native branch parent missing");
	}
	return branch;
}
export function scoreBookArchives(folders: string[], judgments: HumanScore[] = []) {
	const regression: EvidenceRecord[] = [];
	const observations: unknown[] = [];
	const samples = folders.map((folder) => {
		const result = JSON.parse(readFileSync(path.join(folder, "result.json"), "utf8")) as {
			runId: string;
			target: number | null;
			askedAuthor: boolean;
			extraAuthorPrompts: number;
			stopMessages: unknown[];
			fees: unknown;
		};
		const records = readEvidence(folder, true);
		const entries = nativeEntries(folder);
		const model = foldBranch(translateBranch(entries));
		const requestCounts: { chapter: number; requests: number }[] = [];
		let requests = 0;
		for (const row of records) {
			if (row.type === "dispatch" && row.role === "showrunner") requests++;
			if (row.type === "tool_result" && row.message && typeof row.message === "object" && "details" in row.message) {
				const macro = validate(schemas.MacroDetails, row.message.details);
				if (macro.ok && macro.value.commit) {
					requestCounts.push({ chapter: macro.value.commit.chapter, requests });
					requests = 0;
				}
			}
			if (row.type === "meta" || row.driverPhase !== "measurement" || row.role === "compaction") continue;
			regression.push(row);
		}
		const retryIds = new Set(
			model.calls
				.filter((call) => call.retryOf)
				.flatMap((call) => (call.retryOf ? [call.id, call.retryOf] : [call.id])),
		);
		const retryCalls = model.calls.filter((call) => retryIds.has(call.id));
		observations.push({
			runId: result.runId,
			chapters: model.lastChapter,
			words: model.commits.reduce((sum, commit) => sum + wordCount(commit.text).value, 0),
			fees: result.fees,
			stopMessages: result.stopMessages,
			internalCallsByChapter: entries.flatMap((entry) => {
				if (entry.type !== "message" || entry.message.role !== "toolResult") return [];
				const macro = validate(schemas.MacroDetails, entry.message.details);
				return macro.ok
					? [
							{
								toolCallId: entry.message.toolCallId,
								chapter: macro.value.intent?.chapter,
								calls: macro.value.calls.length,
								committed: macro.value.ok,
							},
						]
					: [];
			}),
			transportFailures: model.calls.filter((call) => call.failure?.kind === "transport").length,
			retries: model.calls.filter((call) => call.retryOf).length,
			retryKnownUsd: retryCalls.reduce((sum, call) => sum + (call.usage?.cost.total ?? 0), 0),
			retryReservedUsd: retryCalls.reduce((sum, call) => sum + (call.usage ? 0 : (call.reservedCostUsd ?? 0)), 0),
		});
		return {
			runId: result.runId,
			entries,
			target: result.target,
			askedAuthor: result.askedAuthor,
			extraAuthorPrompts: result.extraAuthorPrompts,
			requestCounts,
		};
	});
	const ids = regression.flatMap((row) => (typeof row.caseId === "string" ? [row.caseId] : []));
	regression.unshift({
		type: "meta",
		suiteId: "P2-CHAP",
		runId: "P3-BOOK-aggregate",
		expectedCaseIds: [...new Set(ids)],
	});
	const measured = scoreEvidenceV3(regression, [], false, { receivedOutputsOnly: true });
	return {
		...scoreBooks(samples, judgments),
		regression: measured.metrics.filter((metric) =>
			["H12", "C04", "C02", "H09", "C05", "W01", "W02", "W05", "E01", "K01", "K02"].includes(metric.id),
		),
		bookObservations: observations,
	};
}
