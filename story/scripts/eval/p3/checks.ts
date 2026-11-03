import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { StoryModel } from "@pi-story/core";
import { schemas, validate } from "../../../packages/core/src/schema/index.ts";
import type { CallObservation } from "../../../packages/pi-story/src/ports.ts";
import type { EvidenceRecord } from "../p2/metering.ts";
import { decisiveAction } from "../p3r2/decisions.ts";
import type { Scenario } from "./datasets.ts";
import type { CapturedAction } from "./scenario.ts";

interface Facts {
	before: StoryModel;
	after: StoryModel;
	entries: readonly SessionEntry[];
	firstMeasuredIndex: number;
	actions: CapturedAction[];
	observed: EvidenceRecord[];
	stopReason?: string;
	injected: boolean;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown) => typeof value === "string" && value.trim().length > 0;
type CheckValue = boolean | "pending_judgment" | undefined;
function writerInput(user: unknown): Record<string, unknown> | undefined {
	if (typeof user !== "string") return undefined;
	try {
		const input: unknown = JSON.parse(user);
		if (!object(input)) return undefined;
		return object(input.originalInput) ? input.originalInput : input;
	} catch {
		return undefined;
	}
}
// A verbatim occurrence proves visibility. A paraphrase needs the independent
// judge to inspect the captured input; it is never an automatic pass or failure.
function visibleInput(user: string | undefined, text: unknown): CheckValue {
	if (!user || !nonempty(text)) return false;
	return user.includes(String(text)) ? true : "pending_judgment";
}
function nativeAuthorIndex(observed: EvidenceRecord[], text: unknown): number {
	if (typeof text !== "string" || !text.trim()) return -1;
	return observed.findIndex((row) => {
		if (
			row.type !== "session_event" ||
			row.driverPhase !== "measurement" ||
			!object(row.event) ||
			row.event.type !== "message_end" ||
			!object(row.event.message) ||
			row.event.message.role !== "user"
		)
			return false;
		const content = row.event.message.content;
		return (
			(typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter((part) => object(part) && part.type === "text")
							.map((part) => (object(part) ? part.text : ""))
							.join("\n")
					: undefined) === text
		);
	});
}
function authorEntryIndex(entries: readonly SessionEntry[], text: unknown): number {
	return entries.findIndex(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "user" &&
			(typeof entry.message.content === "string"
				? entry.message.content
				: entry.message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n")) === text,
	);
}
export function scenarioChecks(scenario: Scenario, facts: Facts, protocol: "p3-29@1" | "p3r2-32@1" = "p3-29@1") {
	const boundaryChecks = protocol === "p3r2-32@1";
	const { before, after, actions, observed } = facts;
	const measured = facts.entries.slice(facts.firstMeasuredIndex);
	const macro = measured.flatMap((entry) => {
		if (
			entry.type !== "message" ||
			entry.message.role !== "toolResult" ||
			entry.message.toolName !== "write_next_chapter"
		)
			return [];
		const value = validate(schemas.MacroDetails, entry.message.details);
		return value.ok ? [value.value] : [];
	});
	const controls = measured.flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== "story.control") return [];
		const value = validate(schemas.ControlEntry, entry.data);
		return value.ok ? [value.value] : [];
	});
	const calls = observed.filter(
		(row) => row.type === "role_call" && row.driverPhase === "measurement",
	) as unknown as CallObservation[];
	const checkpoints = observed.filter(
		(row) => row.type === "role_checkpoint" && row.driverPhase === "measurement" && row.phase === "completed",
	);
	const records = checkpoints.flatMap((row) => {
		const record = validate(schemas.CallRecord, row.record);
		return record.ok ? [record.value] : [];
	});
	const writers = observed.flatMap((row, index) => {
		if (
			row.type !== "role_checkpoint" ||
			row.driverPhase !== "measurement" ||
			row.phase !== "started" ||
			!object(row.request) ||
			row.request.role !== "writer" ||
			typeof row.request.user !== "string"
		)
			return [];
		return [{ index, user: row.request.user, input: writerInput(row.request.user) }];
	});
	const unchanged = before.commits.every((commit, i) => equal(commit, after.commits[i]));
	const noMutation =
		before.canonHead === after.canonHead &&
		equal(before.bibleHistory, after.bibleHistory) &&
		equal(before.outline, after.outline) &&
		equal(before.ledger, after.ledger);
	const noControlEdit =
		controls.length === 0 && before.authorIntent === after.authorIntent && before.currentFocus === after.currentFocus;
	const writing = actions.filter((action) => action.tool === "write_next_chapter");
	const decision =
		scenario.schema === "story/p3-scenario@2"
			? decisiveAction(actions, scenario.execution.maxReadOnlyCalls ?? 3)
			: undefined;
	const first = decision ? decision.action : actions[0];
	const stopActions = decision?.action ? actions.slice(actions.indexOf(decision.action)) : actions;
	const reason = nonempty(first?.args?.reason);
	const continued = measured.filter(
		(entry) => entry.type === "custom_message" && entry.customType === "story.continue",
	).length;
	const prepSafe = observed
		.filter((row) => row.type === "model_call" && row.driverPhase === "preparation")
		.every((row) => row.paid === false && String(row.model).startsWith("faux/"));
	const probe = observed.find((row) => row.type === "driver_probe");
	const probeError = object(probe?.result) && object(probe.result.error) ? probe.result.error.code : undefined;
	const diagnostic = {
		committedBefore: before.lastChapter,
		committedAfter: after.lastChapter,
		macroErrors: macro.map((result) => result.error?.code ?? null),
		roles: calls.map((call) => call.request.role),
		controlFields: controls.map((control) => control.field),
		continued,
		stopReason: facts.stopReason,
		probeError,
		...(decision ? { readOnlyCalls: decision.readOnlyCalls, readOnlyExceeded: decision.exceeded } : {}),
	};
	let values: CheckValue[];
	const kind = scenario.category.split("_")[0];
	if (scenario.id.startsWith("ds11-")) {
		values = [unchanged];
		if (kind === "A") {
			const changed = after.outline.filter((chapter, i) => !equal(chapter, before.outline[i]));
			const requested = scenario.expect.acceptable.flatMap((action) =>
				Object.entries(action.argsMatch ?? {})
					.filter(([key]) => /^chapters\[\d+\]\.n$/u.test(key))
					.map(([, n]) => n),
			);
			values.push(
				first?.tool === "patch_outline" &&
					reason &&
					changed.length > 0 &&
					changed.every(
						(chapter) => chapter.n > before.lastChapter && (!requested.length || requested.includes(chapter.n)),
					),
			);
			values.push(after.outline.every((chapter, i) => chapter.n === i + 1) && noControlEdit);
		} else if (kind === "B") {
			const changes = first?.args?.changes;
			const latest = after.authorMessages.at(-1)?.text ?? "";
			values.push(
				first?.tool === "update_bible" &&
					reason &&
					Array.isArray(changes) &&
					changes.length > 0 &&
					changes.every(
						(change) => object(change) && nonempty(change.authorQuote) && latest.includes(String(change.authorQuote)),
					),
			);
			values.push(
				after.bibleRev > before.bibleRev &&
					before.bibleHistory.every((revision, i) => equal(revision, after.bibleHistory[i])) &&
					after.bibleHistory
						.slice(before.bibleHistory.length)
						.every((revision) => revision.effectiveFromChapter === before.lastChapter + 1),
			);
		} else if (kind === "C") values.push(writing.length === 0 && noMutation && noControlEdit);
		else if (kind === "D")
			values.push(first?.tool === "ask_author" && nonempty(first.args?.question) && noMutation && noControlEdit);
		else if (kind === "E")
			values.push(
				Boolean(first?.tool && first.tool !== "ask_author" && actions.every((action) => action.tool !== "ask_author")),
			);
		else if (kind === "G") {
			const failed = scenario.setup.findLast((step) => step.step === "toolCall");
			values.push(
				failed?.step === "toolCall" && first?.tool === failed.tool && !equal(first.args, failed.args) && reason,
			);
			values.push(
				unchanged &&
					equal(before.ledger, after.ledger) &&
					noControlEdit &&
					after.outline.every((chapter, i) => chapter.n > before.lastChapter || equal(chapter, before.outline[i])),
			);
		} else if (kind === "H")
			values.push(
				(!decision || nonempty(first?.reply)) &&
					stopActions.every((action) => !action.tool) &&
					continued === 0 &&
					noMutation,
			);
		else if (kind === "I") values.push(writing.length === 0 && continued === 0 && noMutation);
		else if (kind === "J")
			values.push(
				unchanged &&
					macro[0]?.intent?.chapter === before.lastChapter + 1 &&
					(!macro[0].commit || macro[0].commit.chapter === before.lastChapter + 1) &&
					after.lastChapter <= before.lastChapter + 1,
			);
		else if (kind === "K") values.push(before.authorIntent === after.authorIntent && noControlEdit);
		else if (kind === "L")
			values.push(writing.length === 0 && continued === 0 && (before.failures[before.lastChapter + 1] ?? 0) >= 2);
	} else {
		values = [unchanged, prepSafe];
		if (kind === "E01")
			values = [
				after.authorMessages.length === 0 && after.controlRev === 0 && actions.length === 0,
				observed.some((row) => row.type === "ui_notice" && /先发出故事提示/u.test(String(row.message))),
				controls.length === 0 &&
					noMutation &&
					!observed.some((row) => row.type === "model_call" && row.driverPhase === "measurement"),
			];
		else if (kind === "E02")
			values.push(
				equal(
					after.commits.map((commit) => commit.chapter),
					[1, 2, 3],
				) &&
					after.authorMessages.length === before.authorMessages.length &&
					controls.length === 0,
				probeError === "GOAL_REACHED" &&
					after.lastChapter === 3 &&
					observed.filter((row) => row.type === "model_call" && row.driverPhase === "driver_probe").length === 0,
				facts.stopReason === "goal_reached" && actions.some((action) => nonempty(action.reply)),
			);
		else if (kind === "E03") {
			const off = measured.findIndex((entry) => entry.type === "custom" && entry.customType === "story.goal");
			values.push(
				off >= 0 && after.policy.targetChapter === undefined && equal(after.policy.budget, before.policy.budget),
				macro.some((result) => result.ok && result.commit?.chapter === 2) &&
					macro.every((result) => result.intent?.chapter === 2) &&
					!measured
						.slice(off + 1)
						.some(
							(entry) =>
								entry.type === "custom_message" && ["p3.continue", "story.continue"].includes(entry.customType),
						),
				after.lastChapter === 2 && after.commits.length === 2 && facts.stopReason === "goal_off",
			);
		} else if (kind === "E04") {
			values.push(
				facts.injected &&
					macro[0]?.error?.code === "INTERJECTED" &&
					!macro[0].commit &&
					macro[0].interjectionSeq.atCommit === macro[0].interjectionSeq.atStart + 1,
			);
			values.push(
				macro[1]?.ok === true &&
					macro[1].commit?.chapter === before.lastChapter + 1 &&
					after.commits.filter((commit) => commit.chapter === before.lastChapter + 1).length === 1 &&
					macro[0].drafts?.every((draft) => after.commits.every((commit) => commit.draftId !== draft.draftId)) === true,
			);
		} else if (kind === "E05") {
			const next = writers.find((writer) => writer.input?.chapter === 3 && writer.input.task === "draft");
			const nativeIndex = boundaryChecks ? nativeAuthorIndex(observed, scenario.trigger.text) : -1;
			const queued = after.authorMessages.find((message) => message.text === scenario.trigger.text);
			const secondCommit = measured.findIndex(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolName === "write_next_chapter" &&
					object(entry.message.details) &&
					entry.message.details.ok === true,
			);
			const queuedIndex = authorEntryIndex(measured, scenario.trigger.text);
			values.push(
				facts.injected &&
					macro[0]?.ok === true &&
					macro[0].interjectionSeq.atStart === macro[0].interjectionSeq.atCommit &&
					after.lastChapter === 3,
				queued &&
					secondCommit >= 0 &&
					queuedIndex > secondCommit &&
					(!boundaryChecks || (next && nativeIndex >= 0 && nativeIndex < next.index))
					? visibleInput(next?.user, scenario.trigger.text)
					: false,
			);
			if (boundaryChecks && scenario.split === "dev" && scenario.expect.programChecks.length === 6) {
				const first = writers.find((writer) => writer.input?.chapter === 2 && writer.input.task === "draft");
				values = [
					unchanged,
					prepSafe,
					facts.injected &&
						macro[0]?.ok === true &&
						macro[0].commit?.chapter === 2 &&
						macro[0].interjectionSeq.atStart === macro[0].interjectionSeq.atCommit &&
						macro.filter((result) => result.commit?.chapter === 2).length === 1,
					Boolean(
						queued &&
							secondCommit >= 0 &&
							queuedIndex > secondCommit &&
							first &&
							next &&
							nativeIndex > first.index &&
							nativeIndex < next.index,
					),
					visibleInput(next?.user, scenario.trigger.text),
					macro.filter((result) => result.commit?.chapter === 3).length === 1 &&
						after.lastChapter === 3 &&
						facts.stopReason === "goal_reached",
				];
			}
		} else if (kind === "E06" || kind === "E07") {
			const field = kind === "E06" ? "author_intent" : "current_focus";
			const value = kind === "E06" ? after.authorIntent : after.currentFocus;
			const notice = observed.findIndex(
				(row) =>
					row.type === "ui_notice" &&
					row.driverPhase === "measurement" &&
					String(row.message).startsWith(kind === "E06" ? "/intent 已更新" : "/focus 已更新"),
			);
			const next = writers.find((writer) => writer.index > notice);
			values.push(
				controls.some((control) => control.field === field) &&
					measured.some((entry) => entry.type === "custom_message" && entry.customType === "story.notice"),
			);
			values.push(
				notice >= 0 && next?.input?.[kind === "E06" ? "authorIntent" : "currentFocus"] === value,
				macro[0]?.error?.code === "STALE_OR_CONFLICT" &&
					!macro[0].commit &&
					macro
						.slice(1)
						.some(
							(result) =>
								result.ok &&
								result.commit?.chapter === before.lastChapter + 1 &&
								result.commit.basis.controlRev === after.controlRev,
						) &&
					macro.every((result) => !result.ok || result.commit?.basis.controlRev === after.controlRev),
			);
		} else if (kind === "E08") {
			values.push(
				controls.length === 3 &&
					controls.every((control) => control.field === "ledger_edit") &&
					controls[0].ledgerPatch?.[0]?.id === "L-4" &&
					controls[1].ledgerPatch?.[0]?.id === "L-1" &&
					controls[2].ledgerPatch?.[0]?.id === "L-3",
			);
			values.push(
				after.ledger.some((item) => item.id === "L-4") &&
					!after.ledger.some((item) => item.id === "L-3") &&
					equal(
						before.ledger.find((item) => item.id === "L-2"),
						after.ledger.find((item) => item.id === "L-2"),
					),
			);
			const edited = after.ledger.find((item) => item.id === "L-1");
			values.push(Boolean(edited?.authorEditEntryId) && edited?.sourceSpans.length === 0);
			const input = calls.find((call) => call.request.role === "writer")?.request.user;
			let writer: unknown;
			try {
				writer = input ? JSON.parse(input) : undefined;
			} catch {
				writer = undefined;
			}
			values.push(
				object(writer) &&
					equal(
						writer.ledger,
						after.ledger.map((item) => ({
							id: item.id,
							kind: item.kind,
							text: item.text,
							authorQuotes: item.sourceSpans.map((span) => ({ messageId: span.messageId, quote: span.quote })),
							authority: item.authorEditEntryId
								? { kind: "author_command", entryId: item.authorEditEntryId }
								: { kind: "author_quotes", establishes: "source_only" },
						})),
					),
			);
		} else if (kind === "E09") {
			const charged = measured.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.usage.cost.total > 0
					? [entry.message]
					: [],
			);
			const nativeProbe = observed.find((row) => row.type === "driver_probe" && row.probe === "showrunner_predispatch");
			const nativeError =
				object(nativeProbe?.result) && object(nativeProbe.result.error) ? nativeProbe.result.error.code : undefined;
			const reportedStop = measured.some(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "story.stop" &&
					String(entry.content).includes("budget_exhausted"),
			);
			const budgetReceipt = measured.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.isError &&
					object(entry.message.details) &&
					object(entry.message.details.error) &&
					entry.message.details.error.code === "BUDGET_EXHAUSTED",
			);
			values.push(
				scenario.mode === "faux" &&
					scenario.execution.fauxProfile?.id === "priced_calls" &&
					observed
						.filter((row) => row.type === "model_call" && row.driverPhase === "measurement")
						.every((row) => row.paid === false && String(row.model).startsWith("faux/")),
				charged.length === 1 &&
					charged[0].usage.cost.total === 0.006 &&
					after.policy.budget?.costUsd === 0.01 &&
					facts.stopReason === "budget_exhausted" &&
					probeError === "BUDGET_EXHAUSTED",
				nativeProbe ? nativeError === "BUDGET_EXHAUSTED" && nativeProbe.modelRequests === 0 : undefined,
				after.lastChapter === before.lastChapter &&
					facts.stopReason === "budget_exhausted" &&
					(reportedStop ? true : budgetReceipt ? "pending_judgment" : false),
			);
		} else if (kind === "E10")
			values.push(
				equal(
					calls.map((call) => call.request.role),
					["writer", "editor", "writer"],
				) &&
					macro[0]?.drafts?.length === 2 &&
					macro[0].reviews?.[0]?.observations.some(
						(observation) => observation.objective && observation.scope === "local",
					),
				macro[0]?.error?.code === "BUDGET_EXHAUSTED" &&
					macro[0].steps.some((step) => step.step === "recheck" && !step.ok),
				after.lastChapter === before.lastChapter &&
					!calls.some((call) => call.request.role === "keeper") &&
					!records.some((record) => record.retryOf),
			);
		else if (kind === "E11") {
			const answerIndex = observed.findIndex(
				(row) => row.type === "dialog_response" && row.driverPhase === "measurement",
			);
			const answer = observed[answerIndex]?.value;
			const scheduledChapter = scenario.trigger.at
				? /^write_next_chapter:chapter=(\d+):/u.exec(scenario.trigger.at)
				: undefined;
			const answeredChapter = scheduledChapter
				? Number(scheduledChapter[1]) + (scenario.trigger.type === "followUp" ? 1 : 0)
				: before.lastChapter + 1;
			const next = boundaryChecks
				? writers.find((writer) => writer.input?.chapter === answeredChapter && writer.input.task === "draft")
				: writers.find((writer) => writer.index > answerIndex);
			const nativeIndex = boundaryChecks ? nativeAuthorIndex(observed, answer) : -1;
			const pauseIndex = observed.findIndex((row) => row.type === "dialog_pause" && row.driverPhase === "measurement");
			values.push(
				observed.some(
					(row) => row.type === "dialog_pause" && row.waitingForAuthor === true && row.stopReason === "ask_author",
				),
				after.authorMessages.some((message) => message.text === answer) &&
					(!boundaryChecks ||
						(next &&
							answerIndex >= 0 &&
							nativeIndex >= 0 &&
							nativeIndex < next.index &&
							answerIndex < next.index &&
							!writers.some((writer) => writer.index > pauseIndex && writer.index < answerIndex)))
					? visibleInput(next?.user, answer)
					: false,
				after.lastChapter > before.lastChapter &&
					Boolean(next) &&
					after.authorMessages
						.slice(before.authorMessages.length)
						.every((message) => message.text === scenario.trigger.text || message.text === answer),
			);
			if (boundaryChecks && scenario.split === "dev" && scenario.expect.programChecks.length === 6) {
				const queuedIndex = authorEntryIndex(measured, scenario.trigger.text);
				const queuedEvent = nativeAuthorIndex(observed, scenario.trigger.text);
				const secondCommit = measured.findIndex(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolName === "write_next_chapter" &&
						object(entry.message.details) &&
						entry.message.details.ok === true,
				);
				const callsAfterActivation = measured
					.slice(queuedIndex + 1)
					.flatMap((entry) =>
						entry.type === "message" && entry.message.role === "assistant"
							? entry.message.content
									.filter((part) => part.type === "toolCall")
									.map((call) => ({ tool: call.name, args: call.arguments }))
							: [],
					);
				const decision = decisiveAction(callsAfterActivation, Number.POSITIVE_INFINITY).action;
				const answered = Boolean(
					answerIndex > pauseIndex &&
						pauseIndex >= 0 &&
						nativeIndex > answerIndex &&
						next &&
						nativeIndex < next.index &&
						!writers.some((writer) => writer.index > pauseIndex && writer.index < answerIndex),
				);
				values = [
					unchanged,
					prepSafe,
					Boolean(
						facts.injected &&
							secondCommit >= 0 &&
							queuedIndex > secondCommit &&
							queuedEvent >= 0 &&
							next &&
							queuedEvent < next.index,
					),
					decision?.tool === "ask_author" &&
						pauseIndex >= 0 &&
						observed[pauseIndex].waitingForAuthor === true &&
						observed[pauseIndex].stopReason === "ask_author" &&
						!writers.some((writer) => writer.input?.chapter === 3 && writer.index < answerIndex),
					answered &&
						observed[answerIndex]?.channel === "rpc_value" &&
						after.authorMessages.some((message) => message.text === answer),
					answered &&
					macro.filter((result) => result.commit?.chapter === 3).length === 1 &&
					after.lastChapter === 3 &&
					facts.stopReason === "goal_reached"
						? visibleInput(next?.user, answer)
						: false,
				];
			}
		} else if (kind === "E12") {
			const update = actions.find((action) => action.tool === "update_bible");
			const changes = update?.args?.changes;
			const latest = after.authorMessages.at(-1)?.text ?? "";
			const added = after.bibleHistory.slice(before.bibleHistory.length);
			const next = writers.find((writer) => writer.input?.chapter === before.lastChapter + 1);
			values.push(
				nonempty(update?.args?.reason) &&
					Array.isArray(changes) &&
					changes.length > 0 &&
					changes.every(
						(change) =>
							object(change) &&
							change.kind === "rule" &&
							change.source === "user" &&
							nonempty(change.authorQuote) &&
							latest.includes(String(change.authorQuote)),
					) &&
					added.length > 0,
				after.bibleRev > before.bibleRev &&
					before.bibleHistory.every((revision, i) => equal(revision, after.bibleHistory[i])) &&
					added.every((revision) => revision.effectiveFromChapter === before.lastChapter + 1),
				Boolean(
					next &&
						Array.isArray(next.input?.bible) &&
						added.length > 0 &&
						added
							.flatMap((revision) => revision.changes)
							.every(
								(change) =>
									Array.isArray(next.input?.bible) &&
									next.input.bible.some(
										(item) => object(item) && item.key === change.key && equal(item, after.bible[change.key]),
									),
							),
				),
			);
		} else if (kind === "E13") {
			const patch = actions.find((action) => action.tool === "patch_outline");
			values.push(
				after.outlineRev > before.outlineRev &&
					nonempty(patch?.args?.reason) &&
					after.outline.some((chapter, i) => !equal(chapter, before.outline[i])) &&
					after.outline.every((chapter, i) => chapter.n === 3 || equal(chapter, before.outline[i])),
				equal(
					after.outline.map((chapter) => chapter.n),
					[1, 2, 3],
				) && equal(before.outline[1], after.outline[1]),
			);
		} else if (kind === "E14")
			values.push(
				macro.length === 2 &&
					macro.every(
						(result) =>
							result.error?.code === "PARSE_FAILURE" &&
							result.calls.length === 2 &&
							result.calls.every((call) => call.role === "writer") &&
							!result.commit,
					) &&
					after.lastChapter === before.lastChapter,
				probeError === "DOMAIN_INVALID" &&
					after.authorMessages.length === before.authorMessages.length &&
					!observed.some((row) => row.type === "model_call" && row.driverPhase === "driver_probe"),
				writing.length === 2 &&
					(after.failures[after.lastChapter + 1] ?? 0) === 2 &&
					facts.stopReason === "consecutive_failures" &&
					actions.some((action) => nonempty(action.reply)),
			);
		else if (kind === "E15") {
			const writerCalls = calls.filter((call) => call.request.role === "writer");
			values.push(
				writerCalls[0]?.response.stopReason === "error" &&
					writerCalls[0].response.content.length > 0 &&
					writerCalls[0].response.usage.totalTokens === 0,
			);
			values.push(
				records.length === 4 &&
					records.filter((record) => record.retryOf).length === 1 &&
					records[1].retryOf === records[0].id &&
					records[1].id !== records[0].id,
			);
			values.push(
				macro[0]?.calls.length === 4 &&
					records[0]?.usage === null &&
					records[0].reservedInputTokens + records[0].reservedOutputTokens > 0 &&
					records.every((record, i) => equal(record, macro[0]?.calls[i])),
			);
			values.push(
				macro[0]?.ok === true &&
					macro[0].commit?.chapter === before.lastChapter + 1 &&
					after.lastChapter === before.lastChapter + 1,
			);
		}
	}
	return scenario.expect.programChecks.map((check, index) => ({
		index,
		check,
		status:
			values[index] === undefined
				? "incomplete"
				: values[index] === "pending_judgment"
					? "pending_judgment"
					: values[index]
						? "passed"
						: "failed",
		evidence: diagnostic,
	}));
}
