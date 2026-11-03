import type { MacroDetails, StateDelta } from "@pi-story/core";
import { schemas, validate } from "../../../packages/core/src/schema/index.ts";
import { wilson } from "../scorers/statistics.mjs";
import type { EvidenceRecord } from "./metering.ts";
import type { HumanScore } from "./score.ts";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
interface Charge {
	requestId: string;
	role: string;
	knownUsd: number;
	reservedUsd: number;
	unknownCalls: number;
	networkRequests: number;
}
interface Frame {
	caseId: string;
	toolCallId: string;
	requests: string[];
	result?: MacroDetails;
	endedAt?: number;
	chapter?: number;
	internalCalls?: number;
}

// Accounting windows are defined by actual macro boundaries; their first window
// includes opening, and requests after the final macro remain explicit overhead.
export function executionObservations(records: EvidenceRecord[], judgments: HumanScore[] = []) {
	const runId = records.find((row) => row.type === "meta")?.runId;
	const approved = judgments.filter((row) => row.runId === runId && row.status === "author_approved");
	const relevant = approved.filter((row) => row.metric === "P2-O7" && row.component === "relevant");
	const requests = records.filter((row) => row.type === "request");
	const charges = new Map<string, Charge>();
	for (const request of requests) {
		const requestId = String(request.requestId);
		const terminal = records.find(
			(row) => ["response", "recording_failure"].includes(row.type) && row.requestId === requestId,
		);
		const normalized =
			terminal?.type === "response"
				? terminal.response
				: records.find((row) => row.type === "provider_response" && row.requestId === requestId)?.response;
		const response = object(normalized) ? normalized : undefined;
		const usage = object(response?.usage) ? response.usage : undefined;
		const known =
			usage &&
			(terminal?.classification === "rejected" ||
				!(["error", "aborted"].includes(String(response?.stopReason)) && usage.totalTokens === 0));
		const cost = known && object(usage.cost) && typeof usage.cost.total === "number" ? usage.cost.total : undefined;
		const noDispatch = cost === undefined && terminal?.networkAttempts === 0;
		charges.set(requestId, {
			requestId,
			role: String(request.role),
			knownUsd: noDispatch ? 0 : (cost ?? 0),
			reservedUsd: cost !== undefined || noDispatch ? 0 : Number(request.reservedCostUsd),
			unknownCalls: cost !== undefined || noDispatch ? 0 : 1,
			networkRequests: Number(terminal?.networkAttempts ?? 0),
		});
	}
	const pending = new Map<string, string[]>();
	const active = new Map<string, Frame>();
	const frames: Frame[] = [];
	for (const row of records) {
		const caseId = String(row.caseId ?? "direct");
		if (row.type === "request") {
			if (row.role === "showrunner") {
				const ids = pending.get(caseId) ?? [];
				ids.push(String(row.requestId));
				pending.set(caseId, ids);
			} else active.get(caseId)?.requests.push(String(row.requestId));
		} else if (row.type === "tool_start" || row.type === "evaluation_start") {
			const frame: Frame = {
				caseId,
				toolCallId: row.type === "evaluation_start" ? "direct" : String(row.toolCallId),
				requests: pending.get(caseId) ?? [],
				...(typeof row.chapter === "number" ? { chapter: row.chapter } : {}),
			};
			pending.set(caseId, []);
			active.set(caseId, frame);
			frames.push(frame);
		} else if (row.type === "tool_result" && object(row.message)) {
			const checked = validate(schemas.MacroDetails, row.message.details);
			const frame = active.get(caseId);
			if (checked.ok && frame && frame.toolCallId === row.message.toolCallId) {
				frame.result = checked.value;
				frame.endedAt = Number(row.message.timestamp);
				active.delete(caseId);
			}
		} else if (row.type === "keeper_result" || row.type === "edit_result") {
			const frame = active.get(caseId);
			if (frame?.toolCallId === "direct") {
				frame.internalCalls = Array.isArray(row.calls) ? row.calls.length : 0;
				if (typeof row.time === "number") frame.endedAt = row.time;
				active.delete(caseId);
			}
		}
	}
	const sum = (ids: string[]) =>
		ids.reduce(
			(total, id) => {
				const row = charges.get(id);
				if (!row) throw new Error("Missing request charge observation");
				total.knownUsd += row.knownUsd;
				total.reservedUsd += row.reservedUsd;
				total.unknownCalls += row.unknownCalls;
				total.networkRequests += row.networkRequests;
				if (row.role === "showrunner") {
					total.mainLogicalRequests++;
					total.mainNetworkRequests += row.networkRequests;
				}
				return total;
			},
			{
				knownUsd: 0,
				reservedUsd: 0,
				unknownCalls: 0,
				networkRequests: 0,
				mainLogicalRequests: 0,
				mainNetworkRequests: 0,
			},
		);
	const assigned = new Set(frames.flatMap((frame) => frame.requests));
	const deltas: StateDelta[] = [];
	for (const frame of frames) if (frame.result?.commit) deltas.push(frame.result.commit.delta);
	for (const row of records.filter((row) => row.type === "keeper_result")) {
		if (!object(row.result) || !row.result.ok || !object(row.result.details) || !object(row.result.details.validated))
			continue;
		const checked = validate(schemas.StateDelta, row.result.details.validated.delta);
		if (checked.ok) deltas.push(checked.value);
	}
	const items = deltas.flatMap((delta) => [
		...delta.factOps.upsert,
		...delta.cognitionOps.add,
		...delta.relationOps.upsert,
	]);
	const provisional = items.filter((item) => item.status === "provisional").length;
	const commits = frames.flatMap((frame) => (frame.result?.commit ? [frame.result.commit] : []));
	const withRisk = commits.filter((commit) => commit.quality === "with_risk").length;
	const reviews = frames.flatMap((frame) =>
		(frame.result?.reviews ?? []).map((review) => ({ caseId: frame.caseId, review })),
	);
	for (const row of records.filter((row) => row.type === "edit_result" && Array.isArray(row.reviews))) {
		for (const raw of row.reviews as unknown[]) {
			const checked = validate(schemas.ReviewDetails, raw);
			if (!checked.ok) throw new Error("Invalid archived editor review");
			reviews.push({ caseId: String(row.caseId), review: checked.value });
		}
	}
	const patchEffects = reviews
		.filter(({ review }) => typeof review.scope !== "string")
		.map(({ caseId, review }) => {
			const resolved = (review.rechecks ?? []).filter((row) => row.resolved).length;
			const newlyReportedObjective = review.observations.filter((row) => row.objective).length;
			const rows = approved.filter(
				(row) => row.metric === "P2-O6" && row.sampleId.startsWith(`${caseId}:${review.reviewId}:`),
			);
			const fixed = rows.filter((row) => row.component === "fixed");
			const introduced = rows.filter((row) => row.component === "introduced");
			const complete = fixed.length > 0 && introduced.length > 0;
			return {
				caseId,
				reviewId: review.reviewId,
				resolved,
				newlyReportedObjective,
				programProxyNet: resolved - newlyReportedObjective,
				actualNet: complete
					? fixed.filter((row) => row.pass).length - introduced.filter((row) => row.pass).length
					: null,
				status: complete ? "author_measured" : "pending_human",
			};
		});
	return {
		accounting:
			"Each macro includes requests since the previous macro; the first includes opening. Remaining requests are overhead. Fees use the frozen catalog prices.",
		total: { logicalRequests: requests.length, ...sum([...charges.keys()]) },
		chapters: frames.map((frame) => {
			const first = requests.find((row) => row.requestId === frame.requests[0]);
			const start = first && typeof first.time === "string" ? Date.parse(first.time) : undefined;
			return {
				caseId: frame.caseId,
				toolCallId: frame.toolCallId,
				chapter: frame.result?.intent?.chapter ?? frame.chapter ?? null,
				mode: frame.toolCallId === "direct" ? "direct" : "macro",
				committed: Boolean(frame.result?.commit),
				quality: frame.result?.commit?.quality ?? null,
				internalCalls: frame.result?.calls.length ?? frame.internalCalls ?? null,
				elapsedMs:
					start !== undefined && frame.endedAt !== undefined && frame.endedAt >= start ? frame.endedAt - start : null,
				...sum(frame.requests),
			};
		}),
		overhead: sum([...charges.keys()].filter((id) => !assigned.has(id))),
		risk: { n: commits.length, withRisk, rate: commits.length ? withRisk / commits.length : null },
		state: {
			n: items.length,
			provisional,
			provisionalRate: items.length ? provisional / items.length : null,
			issues: deltas.reduce((n, delta) => n + delta.issues.length, 0),
			scope: "fact/cognition/relation upserts; claims and hook lifecycle are separate",
		},
		relatedItemPrecision: relevant.length
			? {
					n: relevant.length,
					value: relevant.filter((row) => row.pass).length / relevant.length,
					confidence95: wilson(relevant.filter((row) => row.pass).length, relevant.length),
					status: "author_measured",
				}
			: { value: null, status: "pending_human" },
		patchEffects,
	};
}
