import { type StoryModel, stateAt } from "../fold/index.ts";
import type { CommandContext } from "../ports/index.ts";
import {
	type CallRecord,
	type CheckDetails,
	type DraftDetails,
	type Observation,
	type Patch,
	type ResponseDetails,
	type ReviewDetails,
	schemas,
	validate,
} from "../schema/index.ts";
import { currentBasis } from "../shared/basis.ts";
import { batchGuard, validatedResult } from "../shared/commands.ts";
import { type CommandResult, type DomainError, failure, success } from "../shared/result.ts";
import {
	changedLines,
	chapterId,
	digest,
	normalizeLines,
	normalizeQuote,
	numberedLines,
	wordCount,
} from "../shared/text.ts";

export function productionId(m: StoryModel, chapter: number, kind: "d" | "p" | "r"): string {
	const prefix = `${chapterId(chapter)}-${kind}`;
	return `${prefix}${String((m.sequences[prefix] ?? 0) + 1).padStart(2, "0")}`;
}

// W1/W2/W3: role output becomes an immutable proposal; the adapter persists the result.
export function createDraft(
	ctx: CommandContext,
	input: { chapter: number; text: string; reason?: string; author?: "writer" | "showrunner"; calls?: CallRecord[] },
): CommandResult<DraftDetails> {
	const blocked = batchGuard(ctx);
	if (blocked) return blocked;
	if (input.chapter !== ctx.model.lastChapter + 1)
		return failure("DOMAIN_INVALID", "只能为下一章生成草稿", [String(input.chapter)]);
	if (ctx.model.drafts.length && !input.reason?.trim())
		return failure("DOMAIN_INVALID", "整章重写必须说明理由", ["reason"]);
	if (!input.text.trim()) return failure("PARSE_FAILURE", "写手没有返回正文", ["text"]);
	const text = normalizeLines(input.text);
	return validatedResult(schemas.DraftDetails, {
		schema: "story/draft@1",
		draftId: productionId(ctx.model, input.chapter, "d"),
		chapter: input.chapter,
		author: input.author ?? "writer",
		text,
		digest: digest(text),
		sentenceRule: "s2",
		basis: currentBasis(ctx.model, input.chapter),
		wordCount: wordCount(text),
		calls: input.calls ?? [],
		...(input.reason ? { reason: input.reason } : {}),
	});
}

export async function patchDraft(
	ctx: CommandContext,
	input: { draftId: string; patches: Patch[]; reason: string; calls?: CallRecord[] },
): Promise<CommandResult<DraftDetails>> {
	const blocked = batchGuard(ctx);
	if (blocked) return blocked;
	const parent = ctx.model.drafts.at(-1);
	if (!parent || parent.draftId !== input.draftId || parent.chapter !== ctx.model.lastChapter + 1)
		return failure("DOMAIN_INVALID", "只能修订下一章的当前草稿", [input.draftId]);
	if (!input.reason.trim() || !input.patches.length)
		return failure("DOMAIN_INVALID", "修订需要补丁和理由", [input.draftId]);
	let text = parent.text;
	for (const [index, patch] of input.patches.entries()) {
		const first = patch.find ? text.indexOf(patch.find) : -1;
		if (first < 0 || text.indexOf(patch.find, first + 1) >= 0)
			return failure("PARSE_FAILURE", "补丁的查找内容必须恰好出现一次", [`patches[${index}].find`]);
		text = text.slice(0, first) + patch.replace + text.slice(first + patch.find.length);
	}
	if (!text.trim()) return failure("PARSE_FAILURE", "修订后的正文不能为空", [input.draftId]);
	text = normalizeLines(text);
	return validatedResult(schemas.DraftDetails, {
		schema: "story/draft@1",
		draftId: productionId(ctx.model, parent.chapter, "d"),
		chapter: parent.chapter,
		parentDraftId: parent.draftId,
		author: "writer",
		text,
		digest: digest(text),
		sentenceRule: parent.sentenceRule,
		basis: parent.basis,
		wordCount: wordCount(text),
		patches: input.patches,
		reason: input.reason,
		calls: input.calls ?? [],
	});
}

function findDraft(m: StoryModel, id?: string): DraftDetails | undefined {
	return id === undefined ? m.drafts.at(-1) : m.drafts.find((item) => item.draftId === id);
}

export async function checkDraft(
	ctx: CommandContext,
	input: { draftId?: string } = {},
): Promise<CommandResult<CheckDetails>> {
	const blocked = batchGuard(ctx);
	if (blocked) return blocked;
	const draft = findDraft(ctx.model, input.draftId);
	if (!draft || draft.chapter !== ctx.model.lastChapter + 1)
		return failure("DOMAIN_INVALID", "草稿不存在于下一章工作区", [input.draftId ?? "current"]);
	const checkId = productionId(ctx.model, draft.chapter, "p");
	const observations: Observation[] = [];
	const add = (severity: Observation["severity"], scope: Observation["scope"], lines: number[], impact: string) =>
		observations.push({
			id: `${checkId}-o${String(observations.length + 1).padStart(2, "0")}`,
			by: "check",
			category: "格式与篇幅",
			severity,
			objective: true,
			evidence: { lines },
			impact,
			scope,
		});
	const target = ctx.model.outline.find((item) => item.n === draft.chapter)?.targetWords;
	const lines = numberedLines(draft.text);
	// 15 A.2: thresholds are independent; a very short body also deviates from the length range.
	if (target !== undefined && draft.wordCount.value < target * 0.2)
		add("blocking", "structural", [1], "正文过短，低于大纲目标20%");
	if (target !== undefined && (draft.wordCount.value < target * 0.5 || draft.wordCount.value > target * 2))
		add("minor", "structural", [1], "正文篇幅不在大纲目标50%至200%之间");
	const markers = lines.filter((line) =>
		/<<<写手说明>>>|```|^\s*(?:作为(?:AI|写手)[，,:：\s]|写手说明[:：]|以下是(?:正文|章节)[:：])/u.test(line.text),
	);
	if (markers.length)
		add(
			"blocking",
			"local",
			markers.map((line) => line.n),
			"正文残留写手标记、角色提示语或代码围栏",
		);
	const groups = new Map<string, number[]>();
	for (const line of lines) {
		const paragraph = normalizeQuote(line.text);
		const han = paragraph.match(/\p{Script=Han}/gu)?.length ?? 0;
		const words =
			paragraph.replace(/\p{Script=Han}/gu, " ").match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
		if (han < 20 && words < 10) continue;
		const occurrences = groups.get(paragraph) ?? [];
		occurrences.push(line.n);
		groups.set(paragraph, occurrences);
	}
	for (const occurrences of groups.values())
		if (occurrences.length >= 2) add("major", "local", occurrences, "正文出现规范化后相同的重复段落");
	return success({ schema: "story/check@1", checkId, draftId: draft.draftId, draftDigest: draft.digest, observations });
}

export function createReview(
	ctx: CommandContext,
	input: { draftId?: string; scope: ReviewDetails["scope"]; output: unknown; calls?: CallRecord[] },
): CommandResult<ReviewDetails> {
	const blocked = batchGuard(ctx);
	if (blocked) return blocked;
	const draft = findDraft(ctx.model, input.draftId);
	if (!draft || draft.chapter !== ctx.model.lastChapter + 1)
		return failure("DOMAIN_INVALID", "审稿草稿不存在于下一章工作区", [input.draftId ?? "current"]);
	const checked = validate(schemas.ReviewOutput, input.output);
	if (!checked.ok)
		return failure(
			"PARSE_FAILURE",
			"审稿输出格式不合格",
			checked.errors.map((item) => `${item.path}: ${item.message}`),
		);
	const length = numberedLines(draft.text).length;
	const items: string[] = [];
	for (const [index, observation] of checked.value.observations.entries()) {
		if (observation.objective && !observation.lines.length) items.push(`observations[${index}].lines`);
		if (observation.lines.some((line) => line < 1 || line > length)) items.push(`observations[${index}].lines`);
	}
	if (input.scope !== "full") {
		if (input.scope.spans.some((span) => span.startLine < 1 || span.endLine < span.startLine || span.endLine > length))
			items.push("scope.spans");
		const required = new Set(input.scope.forObservations);
		const rechecks = checked.value.rechecks ?? [];
		if (
			new Set(rechecks.map((item) => item.observationId)).size !== rechecks.length ||
			rechecks.some((item) => !required.has(item.observationId)) ||
			[...required].some((id) => !rechecks.some((item) => item.observationId === id))
		)
			items.push("rechecks");
	}
	if (items.length) return failure("PARSE_FAILURE", "审稿的证据行或复查结论不合格", [...new Set(items)]);
	const reviewId = productionId(ctx.model, draft.chapter, "r");
	return success({
		schema: "story/review@1",
		reviewId,
		draftId: draft.draftId,
		draftDigest: draft.digest,
		basis: currentBasis(ctx.model, draft.chapter),
		scope: input.scope,
		observations: checked.value.observations.map(({ lines, stateRefs, ...observation }, index) => ({
			...observation,
			id: `${reviewId}-o${String(index + 1).padStart(2, "0")}`,
			by: "editor",
			evidence: { lines, ...(stateRefs ? { stateRefs } : {}) },
		})),
		...(checked.value.rechecks ? { rechecks: checked.value.rechecks } : {}),
		calls: input.calls ?? [],
	});
}

export function unavailableReview(
	m: StoryModel,
	draft: DraftDetails,
	calls: CallRecord[],
	scope: ReviewDetails["scope"] = "full",
): ReviewDetails {
	// W5: unavailable reviews are audit records, never review coverage.
	return {
		schema: "story/review@1",
		reviewId: productionId(m, draft.chapter, "r"),
		draftId: draft.draftId,
		draftDigest: draft.digest,
		basis: currentBasis(m, draft.chapter),
		scope,
		unavailable: true,
		observations: [],
		calls,
	};
}

interface ReviewContext {
	draft: DraftDetails;
	lineage: DraftDetails[];
	anchor?: DraftDetails;
	anchorReview?: ReviewDetails;
	covering: ReviewDetails[];
	changes: number[];
	observations: Observation[];
}
export function reviewContext(m: StoryModel, draft: DraftDetails): ReviewContext {
	const lineage: DraftDetails[] = [];
	const visited = new Set<string>();
	let next: DraftDetails | undefined = draft;
	while (next && !visited.has(next.draftId)) {
		visited.add(next.draftId);
		lineage.unshift(next);
		next = next.parentDraftId ? m.drafts.find((item) => item.draftId === next?.parentDraftId) : undefined;
	}
	let anchor: DraftDetails | undefined;
	let anchorReview: ReviewDetails | undefined;
	let reviewIndex = -1;
	for (let i = lineage.length - 1; i >= 0; i--) {
		const candidate = lineage[i];
		const index = m.reviews.findLastIndex(
			(review) => !review.unavailable && review.scope === "full" && review.draftDigest === candidate.digest,
		);
		if (index >= 0) {
			anchor = candidate;
			anchorReview = m.reviews[index];
			reviewIndex = index;
			break;
		}
	}
	const changes = anchor ? changedLines(anchor.text, draft.text) : [];
	const covering = m.reviews.filter(
		(review) =>
			!review.unavailable &&
			review.draftDigest === draft.digest &&
			(review.scope === "full" ||
				changes.every(
					(line) =>
						review.scope !== "full" &&
						review.scope.spans.some((span) => span.startLine <= line && span.endLine >= line),
				)),
	);
	const relevant = new Set(lineage.slice(anchor ? lineage.indexOf(anchor) : 0).map((item) => item.digest));
	const reviews = m.reviews
		.slice(Math.max(0, reviewIndex))
		.filter((review) => !review.unavailable && relevant.has(review.draftDigest));
	const check = m.checks.findLast((item) => item.draftDigest === draft.digest);
	const observations = [...reviews.flatMap((review) => review.observations), ...(check?.observations ?? [])];
	return { draft, lineage, anchor, anchorReview, covering, changes, observations };
}

function fixed(m: StoryModel, context: ReviewContext, observation: Observation, response: ResponseDetails): boolean {
	if (observation.scope !== "local" || !observation.evidence.lines.length) return false;
	const sourceRecord = [...m.reviews, ...m.checks].find((record) =>
		record.observations.some((item) => item.id === observation.id),
	);
	const source = sourceRecord ? m.drafts.find((draft) => draft.draftId === sourceRecord.draftId) : undefined;
	if (
		!source ||
		!response.patchDraftId ||
		context.lineage.findIndex((draft) => draft.draftId === response.patchDraftId) <=
			context.lineage.findIndex((draft) => draft.draftId === source.draftId)
	)
		return false;
	const removed = new Set(changedLines(context.draft.text, source.text));
	if (!observation.evidence.lines.every((line) => removed.has(line))) return false;
	return context.covering.some(
		(review) =>
			review.reviewId === response.verifiedByReviewId &&
			review.scope !== "full" &&
			review.scope.forObservations.includes(observation.id) &&
			review.rechecks?.some((item) => item.observationId === observation.id && item.resolved),
	);
}

function validResponse(
	m: StoryModel,
	context: ReviewContext,
	observation: Observation,
	response: ResponseDetails,
): boolean {
	if (!response.reason.trim()) return false;
	if (response.action === "declined") return !observation.objective;
	if (response.action === "accepted_risk") return true;
	if (response.action === "fixed") return fixed(m, context, observation, response);
	const lines = response.evidence?.lines ?? [];
	const refs = response.evidence?.stateRefs ?? [];
	const state = stateAt(m);
	const known = new Set([
		...Object.keys(m.bible),
		...state.facts.map((item) => item.id),
		...state.claims.map((item) => item.id),
		...state.cognitions.map((item) => item.id),
		...state.hooks.map((item) => item.id),
		...state.relations.map((item) => item.key),
	]);
	return (
		(lines.length > 0 &&
			lines.every((line) => Number.isInteger(line) && line > 0 && line <= numberedLines(context.draft.text).length)) ||
		(refs.length > 0 && refs.every((ref) => known.has(ref)))
	);
}

export function unresolvedObservations(m: StoryModel, draft: DraftDetails): string[] {
	const context = reviewContext(m, draft);
	return context.observations
		.filter((observation) => {
			const response = m.responses.findLast((item) => item.observationId === observation.id);
			return !response || !validResponse(m, context, observation, response);
		})
		.map((observation) => observation.id);
}

export type Eligibility =
	| { ok: true; quality: "clean" | "with_risk"; obligations: string[]; anchorDraftId: string; changedLines: number[] }
	| { ok: false; error: DomainError; obligations: string[] };
export function checkCommitEligibility(m: StoryModel, draftId: string): Eligibility {
	const reject = (code: DomainError["code"], message: string, items: string[] = []): Eligibility => ({
		ok: false,
		error: { code, message, items, hint: "请按提示补充检查、审稿或观察处置" },
		obligations: items,
	});
	const draft = m.drafts.at(-1);
	if (!draft || draft.draftId !== draftId || draft.chapter !== m.lastChapter + 1)
		return reject("DOMAIN_INVALID", "提交对象必须是下一章的当前草稿", [draftId]); // E1
	if (!m.checks.some((check) => check.draftDigest === draft.digest))
		return reject("REVIEW_REQUIRED", "当前正文缺少程序检查", [draftId]); // E2
	const context = reviewContext(m, draft);
	if (
		!context.anchor ||
		!context.anchorReview ||
		(context.anchor.draftId !== draftId && !context.covering.some((review) => review.scope !== "full"))
	)
		return reject("REVIEW_REQUIRED", "全章审稿或改动行复查尚未覆盖正文", [draftId]); // E3
	const unresolved: string[] = [];
	let risk = false;
	for (const observation of context.observations) {
		const response = m.responses.findLast((item) => item.observationId === observation.id);
		if (!response || !validResponse(m, context, observation, response))
			unresolved.push(observation.id); // E4/E5/E6
		else if (response.action === "accepted_risk" && observation.objective && observation.severity !== "minor")
			risk = true;
	}
	if (unresolved.length) return reject("OBSERVATION_UNRESOLVED", "观察仍有未完成的有效处置", unresolved);
	const now = currentBasis(m, draft.chapter);
	const reviewed = context.anchorReview.basis;
	if (
		draft.basis.canonHead !== now.canonHead ||
		reviewed.controlRev !== now.controlRev ||
		reviewed.bibleRev !== now.bibleRev ||
		reviewed.intentRev !== now.intentRev ||
		reviewed.stateRev !== now.stateRev
	)
		return reject("STALE_OR_CONFLICT", "正文生成依据或全章审稿依据已变化", [draftId]); // E7
	return {
		ok: true,
		quality: risk ? "with_risk" : "clean",
		obligations: context.observations.map((item) => item.id),
		anchorDraftId: context.anchor.draftId,
		changedLines: context.changes,
	};
}

export function autoDispositions(m: StoryModel): ResponseDetails[] {
	const draft = m.drafts.at(-1);
	if (!draft) return [];
	const context = reviewContext(m, draft);
	return context.observations.map((observation) => {
		const review = context.covering.findLast(
			(review) =>
				review.scope !== "full" &&
				review.scope.forObservations.includes(observation.id) &&
				review.rechecks?.some((item) => item.observationId === observation.id && item.resolved),
		);
		const candidate: ResponseDetails = {
			schema: "story/response@1",
			observationId: observation.id,
			action: "fixed",
			reason: "局部改动已由复查确认解决",
			patchDraftId: draft.draftId,
			...(review ? { verifiedByReviewId: review.reviewId } : {}),
		};
		if (review && fixed(m, context, observation, candidate)) return candidate;
		return {
			schema: "story/response@1",
			observationId: observation.id,
			action: observation.objective ? "accepted_risk" : "declined",
			reason: observation.objective ? "标准流程保留此客观观察，供作者复核" : "标准流程不采纳此非客观建议",
		};
	});
}

export async function respondObservations(
	ctx: CommandContext,
	input: { responses: Omit<ResponseDetails, "schema">[] },
): Promise<CommandResult<ResponseDetails[]>> {
	const blocked = batchGuard(ctx);
	if (blocked) return blocked;
	const draft = ctx.model.drafts.at(-1);
	if (!draft) return failure("DOMAIN_INVALID", "当前没有可处置观察的草稿");
	const context = reviewContext(ctx.model, draft);
	const details: ResponseDetails[] = [];
	const failed: string[] = [];
	for (const response of input.responses) {
		const observation = [...ctx.model.reviews, ...ctx.model.checks]
			.flatMap((record) => record.observations)
			.find((item) => item.id === response.observationId);
		const checked = validate(schemas.ResponseDetails, { ...response, schema: "story/response@1" });
		if (!observation || !checked.ok || !validResponse(ctx.model, context, observation, checked.value))
			failed.push(response.observationId);
		else details.push(checked.value);
	}
	if (!failed.length) return success(details);
	return { ...failure<ResponseDetails[]>("OBSERVATION_UNRESOLVED", "部分观察处置不合格", failed), details };
}
