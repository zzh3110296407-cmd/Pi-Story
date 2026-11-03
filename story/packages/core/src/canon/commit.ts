import { foldBranch } from "../fold/index.ts";
import type { CommandContext } from "../ports/index.ts";
import { checkCommitEligibility } from "../production/index.ts";
import type { Basis, CallRecord, CommitDetails } from "../schema/index.ts";
import { currentBasis, sameBasis } from "../shared/basis.ts";
import { batchGuard } from "../shared/commands.ts";
import { type CommandResult, failure, success } from "../shared/result.ts";
import { validateDelta } from "./delta.ts";

export function writingEntrance(ctx: CommandContext): CommandResult<never> | null {
	const blocked = batchGuard(ctx);
	if (blocked) return blocked;
	if (ctx.model.policy.targetChapter !== undefined && ctx.model.lastChapter >= ctx.model.policy.targetChapter)
		return failure("GOAL_REACHED", "已达到作者设定的写作目标");
	if ((ctx.model.failures[ctx.model.lastChapter + 1] ?? 0) >= 2)
		return failure("DOMAIN_INVALID", "同一章连续两次未能提交，请先问作者");
	if (!ctx.model.outline.some((item) => item.n === ctx.model.lastChapter + 1))
		return failure("DOMAIN_INVALID", "下一章不在大纲中，请先扩充大纲", [String(ctx.model.lastChapter + 1)]);
	return null;
}

export async function settleCommit(
	ctx: CommandContext,
	input: { draftId: string; proposal: unknown; startSeq: number; sourceBasis?: Basis; calls?: CallRecord[] },
): Promise<CommandResult<CommitDetails>> {
	const blocked = batchGuard(ctx);
	if (blocked) return blocked;
	const eligibility = checkCommitEligibility(ctx.model, input.draftId);
	if (!eligibility.ok)
		return { ok: false, error: eligibility.error, receipt: `${eligibility.error.code}：${eligibility.error.message}` };
	const draft = ctx.model.drafts.at(-1);
	if (!draft) throw new Error("Eligible draft missing");
	const validated = validateDelta(ctx.model, draft, input.proposal);
	if (!validated.ok) return { ok: false, error: validated.error, receipt: validated.receipt };
	if (ctx.ports.interjections.seq() !== input.startSeq) return failure("INTERJECTED", "作者已立即插话，本章未提交");
	// I12: compare persistent input state separately from the macro's ephemeral intent/workspace.
	const latest = foldBranch(ctx.ports.entries.branch());
	if (!sameBasis(currentBasis(latest, draft.chapter), input.sourceBasis ?? currentBasis(ctx.model, draft.chapter)))
		return failure("STALE_OR_CONFLICT", "记录员调用期间故事依据已变化", [input.draftId]);
	const details: CommitDetails = {
		schema: "story/commit-result@1",
		ok: true,
		calls: input.calls ?? [],
		commit: {
			schema: "story/commit@1",
			chapter: draft.chapter,
			draftId: draft.draftId,
			draftDigest: draft.digest,
			text: draft.text,
			sentenceRule: draft.sentenceRule,
			quality: eligibility.quality,
			basis: currentBasis(ctx.model, draft.chapter, draft.digest),
			delta: validated.details.delta,
			summary: validated.details.delta.summary,
			responses: eligibility.obligations.map((id) => {
				const response = ctx.model.responses.findLast((item) => item.observationId === id);
				if (!response) throw new Error("Eligible response missing");
				return { observationId: id, action: response.action };
			}),
		},
	};
	// Last synchronous gate, after all external ports and before marking success.
	if (ctx.signal?.aborted) return failure("TRANSPORT_FAILURE", "写作已停止，本章未提交");
	if (ctx.batch) ctx.batch.committed = true;
	return success(details, `第${draft.chapter}章已提交（${eligibility.quality === "clean" ? "无风险" : "带风险"}）`);
}
