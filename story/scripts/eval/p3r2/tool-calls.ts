import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { foldBranch } from "@pi-story/core";
import { schemas, validate } from "../../../packages/core/src/schema/index.ts";
import { translateBranch } from "../../../packages/pi-story/src/entries.ts";
import type { HumanScore } from "../p2/score.ts";
import type { CapturedAction } from "../p3/scenario.ts";
import { wilson } from "../scorers/statistics.mjs";
import { decisiveAction } from "./decisions.ts";

export interface ToolCallSample {
	runId: string;
	suite: "BOOK" | "SCEN" | "E2E";
	sampleId: string;
	toolCallId: string;
	tool: string;
	args: unknown;
	basis: string;
	hostDeferred: boolean;
	invalid: boolean;
	repeated: boolean;
	resultObserved: boolean;
}
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

export function measuredToolCalls(sample: {
	runId: string;
	suite: ToolCallSample["suite"];
	mode: "real" | "faux";
	entries: readonly SessionEntry[];
	firstMeasuredIndex: number;
}): ToolCallSample[] {
	if (sample.mode !== "real") return [];
	if (
		!Number.isSafeInteger(sample.firstMeasuredIndex) ||
		sample.firstMeasuredIndex < 0 ||
		sample.firstMeasuredIndex > sample.entries.length
	)
		throw new Error("Invalid measurement boundary");
	const rows: ToolCallSample[] = [];
	for (const [index, entry] of sample.entries.entries()) {
		if (index < sample.firstMeasuredIndex || entry.type !== "message" || entry.message.role !== "assistant") continue;
		const before = foldBranch(translateBranch(sample.entries.slice(0, index)));
		const basis = JSON.stringify([
			before.canonHead,
			before.stateRev,
			before.controlRev,
			before.bibleRev,
			before.outlineRev,
			before.failures,
			before.authorMessages.at(-1)?.entryId,
		]);
		for (const call of entry.message.content.filter((block) => block.type === "toolCall")) {
			const result = sample.entries
				.slice(index + 1)
				.find(
					(candidate) =>
						candidate.type === "message" &&
						candidate.message.role === "toolResult" &&
						candidate.message.toolCallId === call.id,
				);
			const details =
				result?.type === "message" && result.message.role === "toolResult" ? result.message.details : undefined;
			const hostDeferred =
				object(details) && details.schema === "story/host-deferred@1" && details.code === "AUTHOR_MESSAGE_PENDING";
			const error = object(details) && object(details.error) ? details.error.code : undefined;
			const macro = validate(schemas.MacroDetails, details);
			const started = macro.ok && Boolean(macro.value.intent);
			const previous = rows.at(-1);
			rows.push({
				runId: sample.runId,
				suite: sample.suite,
				sampleId: `${entry.id}:${call.id}`,
				toolCallId: call.id,
				tool: call.name,
				args: call.arguments,
				basis,
				hostDeferred,
				invalid:
					!hostDeferred &&
					(Boolean(call.argumentsError) || error === "GOAL_REACHED" || (error === "DOMAIN_INVALID" && !started)),
				repeated:
					!hostDeferred &&
					Boolean(
						previous &&
							!previous.hostDeferred &&
							previous.tool === call.name &&
							previous.basis === basis &&
							JSON.stringify(previous.args) === JSON.stringify(call.arguments),
					),
				resultObserved: Boolean(result),
			});
		}
	}
	return rows;
}

export function scoreToolCalls(calls: ToolCallSample[], judgments: HumanScore[] = []) {
	const relevant = new Map<string, boolean>();
	for (const row of judgments.filter((row) => row.metric === "T04" && row.status === "author_approved")) {
		const key = JSON.stringify([row.runId, row.sampleId]);
		if (relevant.has(key)) throw new Error("Duplicate T04 relevance judgment");
		relevant.set(key, row.pass);
	}
	if (new Set(calls.map((call) => JSON.stringify([call.runId, call.sampleId]))).size !== calls.length)
		throw new Error("Duplicate actual tool sample");
	const rows = calls.map((call) => ({
		...call,
		relevant: call.hostDeferred ? true : relevant.get(JSON.stringify([call.runId, call.sampleId])),
	}));
	const metric = (selected: typeof rows) => {
		const n = selected.length;
		const invalid = selected.filter(
			(call) => !call.hostDeferred && (call.invalid || call.repeated || call.relevant === false),
		).length;
		const pending = selected.filter(
			(call) =>
				!call.hostDeferred && !call.invalid && !call.repeated && (call.relevant === undefined || !call.resultObserved),
		).length;
		return {
			id: "T04",
			n,
			invalid,
			hostDeferred: selected.filter((call) => call.hostDeferred).length,
			programInvalid: selected.filter((call) => call.invalid || call.repeated).length,
			pending,
			value: n && !pending ? invalid / n : null,
			confidence95: n && !pending ? wilson(invalid, n) : null,
			minimum: 100,
			threshold: 0.1,
			passed: n < 100 ? null : invalid / n > 0.1 ? false : pending ? null : true,
		};
	};
	return {
		scoringVersion: "p3r2-32@1",
		rows,
		combined: metric(rows),
		book: metric(rows.filter((call) => call.suite === "BOOK")),
	};
}

export function decisiveRecoveries(entries: readonly SessionEntry[], firstMeasuredIndex: number) {
	return entries.flatMap((entry, index) => {
		if (
			index < firstMeasuredIndex ||
			entry.type !== "message" ||
			entry.message.role !== "toolResult" ||
			!entry.message.isError
		)
			return [];
		const actions: CapturedAction[] = [];
		for (const next of entries.slice(index + 1)) {
			if (
				next.type !== "message" ||
				next.message.role !== "assistant" ||
				["error", "aborted"].includes(next.message.stopReason)
			)
				continue;
			const calls = next.message.content.filter((block) => block.type === "toolCall");
			if (calls.length) for (const call of calls) actions.push({ tool: call.name, args: call.arguments, id: call.id });
			else {
				const reply = next.message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				if (reply.trim()) actions.push({ reply });
			}
			if (decisiveAction(actions, 3).action) break;
		}
		const decision = decisiveAction(actions, 3);
		return [
			{
				sampleId: `${entry.id}:${entry.message.toolCallId}`,
				toolCallId: entry.message.toolCallId,
				error: entry.message.details,
				next: decision.action,
				readOnlyCalls: decision.readOnlyCalls,
				status: decision.action ? "pending_judgment" : "missing_next_decision",
			},
		];
	});
}
