import type { Static, TSchema } from "typebox";
import { settleCommit, writingEntrance } from "../canon/commit.ts";
import { type ValidatedDelta, validateDelta } from "../canon/delta.ts";
import type { CommandContext } from "../ports/index.ts";
import {
	checkCommitEligibility,
	createDraft,
	createReview,
	patchDraft,
	reviewContext,
	unavailableReview,
} from "../production/index.ts";
import {
	type Basis,
	type CommitDetails,
	type DeltaProposal,
	type DraftDetails,
	type Observation,
	type Patch,
	parsePatches,
	parseWriter,
	patchSchema,
	type ReviewDetails,
	schemas,
	validate,
} from "../schema/index.ts";
import { currentBasis, sameBasis } from "../shared/basis.ts";
import { batchGuard } from "../shared/commands.ts";
import { type CommandResult, failure, success } from "../shared/result.ts";
import { sumUsage } from "../usage/index.ts";
import { CallSession } from "./calls.ts";
import { editorInput, keeperInput, patchInput, writerInput } from "./inputs.ts";

export function parsedSchema<T extends TSchema>(schema: T, value: unknown): CommandResult<Static<T>> {
	const checked = validate(schema, value);
	return checked.ok
		? success(checked.value)
		: failure(
				"PARSE_FAILURE",
				"角色输出不符合格式",
				checked.errors.map((item) => `${item.path}: ${item.message}`),
			);
}
export async function generateDraft(
	ctx: CommandContext,
	session: CallSession,
	input: { chapter: number; brief?: string; reason?: string },
): Promise<CommandResult<DraftDetails>> {
	const original = writerInput(ctx.model, input.brief, ctx.settings.writerLengthFactor);
	let user = JSON.stringify(original);
	const start = session.calls.length;
	for (let attempt = 0; attempt < 2; attempt++) {
		const reply = await session.call("writer", ctx.ports.rules.get("writer"), user, { kind: "text" }, ctx.model);
		if (!reply.ok) return { ok: false, error: reply.error, receipt: reply.receipt };
		const parsed = parseWriter(reply.details.text);
		if (parsed.ok)
			return createDraft(ctx, {
				chapter: input.chapter,
				text: parsed.text,
				reason: input.reason,
				calls: session.calls.slice(start),
			});
		if (attempt === 1)
			return failure(
				"PARSE_FAILURE",
				"写手重试后仍没有返回正文",
				parsed.errors.map((item) => item.path),
			);
		user = JSON.stringify({ originalInput: original, invalidOutput: reply.details.text, formatErrors: parsed.errors });
	}
	throw new Error("Writer retry loop exhausted unexpectedly");
}
export async function generatePatch(
	ctx: CommandContext,
	session: CallSession,
	draft: DraftDetails,
	observations: Observation[],
): Promise<CommandResult<DraftDetails>> {
	const original = patchInput(ctx.model, draft, observations);
	let user = JSON.stringify(original);
	const start = session.calls.length;
	for (let attempt = 0; attempt < 2; attempt++) {
		const reply = await session.call(
			"writer",
			ctx.ports.rules.get("writer"),
			user,
			{
				kind: "json",
				schema: patchSchema,
			},
			ctx.model,
		);
		if (!reply.ok) return { ok: false, error: reply.error, receipt: reply.receipt };
		const parsed =
			reply.details.json !== undefined ? validate(patchSchema, reply.details.json) : parsePatches(reply.details.text);
		const patched = parsed.ok
			? await patchDraft(ctx, {
					draftId: draft.draftId,
					patches: parsed.value as Patch[],
					reason: "按程序检查和审稿观察进行一次局部修订",
					calls: session.calls.slice(start),
				})
			: failure<DraftDetails>(
					"PARSE_FAILURE",
					"局部补丁格式不合格",
					parsed.errors.map((item) => `${item.path}: ${item.message}`),
				);
		if (patched.ok || patched.error.code !== "PARSE_FAILURE" || attempt === 1) return patched;
		user = JSON.stringify({
			originalInput: original,
			invalidOutput: reply.details.text,
			patchErrors: patched.error.items ?? [patched.error.message],
		});
	}
	throw new Error("Patch retry loop exhausted unexpectedly");
}
export async function generateReview(
	ctx: CommandContext,
	session: CallSession,
	draft: DraftDetails,
	scope: ReviewDetails["scope"],
	observations: Observation[] = [],
): Promise<CommandResult<ReviewDetails>> {
	const start = session.calls.length;
	return session.json(
		"editor",
		ctx.ports.rules.get("review-matrix"),
		editorInput(ctx.model, draft, scope, observations),
		schemas.ReviewOutput,
		(output) => createReview(ctx, { draftId: draft.draftId, scope, output, calls: session.calls.slice(start) }),
		ctx.model,
	);
}
export async function keeperSettlement(
	ctx: CommandContext,
	session: CallSession,
	input: { draftId: string; startSeq: number; sourceBasis?: Basis },
): Promise<CommandResult<CommitDetails>> {
	const eligibility = checkCommitEligibility(ctx.model, input.draftId);
	if (!eligibility.ok)
		return { ok: false, error: eligibility.error, receipt: `${eligibility.error.code}：${eligibility.error.message}` };
	const draft = ctx.model.drafts.find((draft) => draft.draftId === input.draftId);
	if (!draft) return failure("DOMAIN_INVALID", "待结算草稿不存在", [input.draftId]);
	const start = session.calls.length;
	const proposed = await generateStateDelta(ctx, session, draft);
	if (!proposed.ok) return { ok: false, error: proposed.error, receipt: proposed.receipt };
	return settleCommit(ctx, { ...input, proposal: proposed.details.proposal, calls: session.calls.slice(start) });
}

// The evaluation adapter uses this same bounded keeper path without pretending
// that its synthetic chapters have passed review or may enter product canon.
export async function generateStateDelta(
	ctx: CommandContext,
	session: CallSession,
	draft: DraftDetails,
): Promise<CommandResult<{ proposal: DeltaProposal; validated: ValidatedDelta }>> {
	const original = keeperInput(ctx.model, draft);
	let user: unknown = original;
	for (let attempt = 0; attempt < 2; attempt++) {
		const proposal = await session.json(
			"keeper",
			ctx.ports.rules.get("state-projection"),
			user,
			schemas.DeltaProposal,
			(value) => parsedSchema(schemas.DeltaProposal, value),
			ctx.model,
		);
		if (!proposal.ok) return { ok: false, error: proposal.error, receipt: proposal.receipt };
		const validated = validateDelta(ctx.model, draft, proposal.details);
		if (validated.ok) return success({ proposal: proposal.details, validated: validated.details });
		if (validated.error.code !== "DOMAIN_INVALID" || attempt === 1)
			return { ok: false, error: validated.error, receipt: validated.receipt };
		user = {
			originalInput: original,
			previousProposal: proposal.details,
			domainErrors: { message: validated.error.message, items: validated.error.items },
		};
	}
	throw new Error("Keeper retry loop exhausted unexpectedly");
}

export async function writeDraft(
	ctx: CommandContext,
	input: { chapter: number; brief?: string; reason?: string },
): Promise<CommandResult<DraftDetails>> {
	const blocked = writingEntrance(ctx);
	if (blocked) return blocked;
	if (input.chapter !== ctx.model.lastChapter + 1 || !ctx.model.intents[input.chapter])
		return failure("DOMAIN_INVALID", "请先为下一章设定本章意图", [String(input.chapter)]);
	if (ctx.model.drafts.length && !input.reason?.trim())
		return failure("DOMAIN_INVALID", "整章重写必须说明理由", ["reason"]);
	const session = new CallSession(ctx);
	const result = await generateDraft(ctx, session, input);
	return { ...result, usage: sumUsage(session.calls) };
}
export async function reviewDraft(
	ctx: CommandContext,
	input: { draftId?: string; scope?: "auto" | ReviewDetails["scope"] } = {},
): Promise<CommandResult<ReviewDetails>> {
	const blocked = batchGuard(ctx);
	if (blocked) return blocked;
	const draft = input.draftId
		? ctx.model.drafts.find((draft) => draft.draftId === input.draftId)
		: ctx.model.drafts.at(-1);
	if (!draft) return failure("DOMAIN_INVALID", "待审草稿不存在", [input.draftId ?? "current"]);
	const context = reviewContext(ctx.model, draft);
	const scope =
		input.scope && input.scope !== "auto"
			? input.scope
			: !context.anchorReview ||
					!sameBasis(context.anchorReview.basis, currentBasis(ctx.model, draft.chapter)) ||
					context.anchor?.draftId === draft.draftId
				? "full"
				: {
						spans: context.changes.map((line) => ({ startLine: line, endLine: line })),
						forObservations: context.observations
							.filter((observation) => observation.scope === "local")
							.map((observation) => observation.id),
					};
	const session = new CallSession(ctx);
	const result = await generateReview(ctx, session, draft, scope, context.observations);
	if (!result.ok && result.error.code === "PARSE_FAILURE")
		return {
			...success(unavailableReview(ctx.model, draft, session.calls, scope), "审稿不可用，请重试"),
			usage: sumUsage(session.calls),
		};
	return { ...result, usage: sumUsage(session.calls) };
}
export async function commit(ctx: CommandContext, input: { draftId: string }): Promise<CommandResult<CommitDetails>> {
	const blocked = writingEntrance(ctx);
	const session = new CallSession(ctx);
	const result =
		blocked ??
		(await keeperSettlement(ctx, session, {
			draftId: input.draftId,
			startSeq: ctx.ports.interjections.seq(),
			sourceBasis: currentBasis(ctx.model, ctx.model.lastChapter + 1),
		}));
	if (!result.ok)
		return {
			ok: false,
			error: result.error,
			receipt: result.receipt,
			details: { schema: "story/commit-result@1", ok: false, error: result.error, calls: session.calls },
			usage: sumUsage(session.calls),
		};
	return { ...result, usage: sumUsage(session.calls) };
}
