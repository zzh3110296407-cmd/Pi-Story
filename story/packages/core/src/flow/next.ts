import { writingEntrance } from "../canon/commit.ts";
import { type BranchEntry, foldBranch } from "../fold/index.ts";
import { assembleIntent } from "../plan/index.ts";
import type { CommandContext } from "../ports/index.ts";
import {
	autoDispositions,
	checkCommitEligibility,
	checkDraft,
	respondObservations,
	unavailableReview,
} from "../production/index.ts";
import type { DraftDetails, MacroDetails, ReviewDetails } from "../schema/index.ts";
import { currentBasis } from "../shared/basis.ts";
import type { CommandResult, DomainError } from "../shared/result.ts";
import { changedLines } from "../shared/text.ts";
import { sumUsage } from "../usage/index.ts";
import { CallSession } from "./calls.ts";
import { generateDraft, generatePatch, generateReview, keeperSettlement } from "./commands.ts";

export async function writeNextChapter(
	ctx: CommandContext,
	input: { brief?: string } = {},
): Promise<CommandResult<MacroDetails>> {
	const branch = [...ctx.ports.entries.branch()];
	const local: BranchEntry[] = [];
	let working: CommandContext = { ...ctx, model: foldBranch(branch) };
	const session = new CallSession(working);
	const startSeq = ctx.ports.interjections.seq();
	const sourceBasis = currentBasis(working.model, working.model.lastChapter + 1);
	const details: MacroDetails = {
		schema: "story/macro-result@1",
		ok: false,
		revision: ctx.settings.localRevision !== false,
		interjectionSeq: { atStart: startSeq },
		steps: [],
		drafts: [],
		checks: [],
		reviews: [],
		responses: [],
		calls: session.calls,
	};
	const fail = (error: DomainError, step?: MacroDetails["steps"][number]["step"]): CommandResult<MacroDetails> => {
		details.error = error;
		if (step) details.steps.push({ step, ok: false });
		return { ok: false, error, details, receipt: `${error.code}：${error.message}`, usage: sumUsage(session.calls) };
	};
	const append = (toolName: string, value: unknown) => {
		let id = `@macro:${branch.at(-1)?.entryId ?? "root"}:${local.length + 1}`;
		while (branch.some((entry) => entry.entryId === id) || local.some((entry) => entry.entryId === id)) id += ":next";
		local.push({ kind: "toolResult", entryId: id, toolName, isError: false, details: value });
		working = { ...working, model: foldBranch([...branch, ...local]) };
	};
	const draftPreview = (draft: DraftDetails) =>
		ctx.progress?.("draft", { chapter: draft.chapter, draftId: draft.draftId, text: draft.text });
	const blocked = writingEntrance(working);
	if (blocked && !blocked.ok) return fail(blocked.error);

	ctx.progress?.("intent");
	const intent = await assembleIntent(working, input);
	if (!intent.ok) return fail(intent.error, "intent");
	details.intent = intent.details;
	append("set_chapter_intent", intent.details);
	details.steps.push({ step: "intent", ref: String(intent.details.chapter), ok: true });
	ctx.progress?.("draft");
	const drafted = await generateDraft(working, session, {
		chapter: intent.details.chapter,
		brief: input.brief,
		...(working.model.drafts.length ? { reason: "标准流程重新起草本章" } : {}),
	});
	if (!drafted.ok) return fail(drafted.error, "draft");
	let draft = drafted.details;
	details.drafts?.push(draft);
	append("write_draft", draft);
	details.steps.push({ step: "draft", ref: draft.draftId, ok: true });
	draftPreview(draft);
	ctx.progress?.("check");
	const checked = await checkDraft(working, { draftId: draft.draftId });
	if (!checked.ok) return fail(checked.error, "check");
	details.checks?.push(checked.details);
	append("check_draft", checked.details);
	details.steps.push({ step: "check", ref: checked.details.checkId, ok: true });
	let fullReview: ReviewDetails | undefined;
	ctx.progress?.("review");
	for (let attempt = 0; attempt < 2; attempt++) {
		const start = session.calls.length;
		const reviewed = await generateReview(working, session, draft, "full");
		if (reviewed.ok) {
			fullReview = reviewed.details;
			details.reviews?.push(fullReview);
			append("review_draft", fullReview);
			details.steps.push({ step: "review", ref: fullReview.reviewId, ok: true });
			break;
		}
		if (reviewed.error.code !== "PARSE_FAILURE") return fail(reviewed.error, "review");
		const unavailable = unavailableReview(working.model, draft, session.calls.slice(start));
		details.reviews?.push(unavailable);
		append("review_draft", unavailable);
		details.steps.push({ step: "review", ref: unavailable.reviewId, ok: false });
	}
	if (!fullReview)
		return fail({ code: "REVIEW_REQUIRED", message: "全章审稿重试后仍不可用", hint: "请作者决定是否重新尝试本章" });
	const localIssues = [...checked.details.observations, ...fullReview.observations].filter(
		(observation) => observation.objective && observation.severity !== "minor" && observation.scope === "local",
	);
	if (details.revision && localIssues.length) {
		ctx.progress?.("patch");
		const original = draft;
		const patched = await generatePatch(working, session, draft, localIssues);
		if (!patched.ok) return fail(patched.error, "patch");
		draft = patched.details;
		details.drafts?.push(draft);
		append("patch_draft", draft);
		details.steps.push({ step: "patch", ref: draft.draftId, ok: true });
		draftPreview(draft);
		ctx.progress?.("check");
		const rechecked = await checkDraft(working, { draftId: draft.draftId });
		if (!rechecked.ok) return fail(rechecked.error, "check");
		details.checks?.push(rechecked.details);
		append("check_draft", rechecked.details);
		details.steps.push({ step: "check", ref: rechecked.details.checkId, ok: true });
		const scope: ReviewDetails["scope"] = {
			spans: changedLines(original.text, draft.text).map((line) => ({ startLine: line, endLine: line })),
			forObservations: localIssues.map((observation) => observation.id),
		};
		ctx.progress?.("recheck");
		const start = session.calls.length;
		const reviewed = await generateReview(working, session, draft, scope, localIssues);
		if (!reviewed.ok) {
			if (reviewed.error.code !== "PARSE_FAILURE") return fail(reviewed.error, "recheck");
			const unavailable = unavailableReview(working.model, draft, session.calls.slice(start), scope);
			details.reviews?.push(unavailable);
			append("review_draft", unavailable);
			return fail(
				{ code: "REVIEW_REQUIRED", message: "局部复查不可用", items: reviewed.error.items, hint: "请重试审稿" },
				"recheck",
			);
		}
		details.reviews?.push(reviewed.details);
		append("review_draft", reviewed.details);
		details.steps.push({ step: "recheck", ref: reviewed.details.reviewId, ok: true });
	}
	ctx.progress?.("dispose");
	const disposed = await respondObservations(working, { responses: autoDispositions(working.model) });
	if (!disposed.ok) return fail(disposed.error, "dispose");
	details.responses = disposed.details;
	for (const response of disposed.details) append("respond_observation", response);
	details.steps.push({ step: "dispose", ok: true });
	const eligible = checkCommitEligibility(working.model, draft.draftId);
	if (!eligible.ok) return fail(eligible.error, "commit");
	details.interjectionSeq.atCommit = ctx.ports.interjections.seq();
	if (details.interjectionSeq.atCommit !== startSeq)
		return fail({ code: "INTERJECTED", message: "作者已立即插话，本章未提交" }, "commit");
	ctx.progress?.("commit");
	const settled = await keeperSettlement(working, session, { draftId: draft.draftId, startSeq, sourceBasis });
	details.interjectionSeq.atCommit = ctx.ports.interjections.seq();
	if (!settled.ok) return fail(settled.error, "commit");
	if (!settled.details.commit) throw new Error("Successful settlement missing commit");
	details.ok = true;
	details.commit = settled.details.commit;
	details.interjectionSeq.atCommit = ctx.ports.interjections.seq();
	details.steps.push({ step: "commit", ref: draft.draftId, ok: true });
	return { ok: true, details, receipt: settled.receipt, usage: sumUsage(session.calls) };
}
