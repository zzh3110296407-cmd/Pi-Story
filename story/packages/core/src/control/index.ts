import type { StoryModel } from "../fold/index.ts";
import type { CommandContext } from "../ports/index.ts";
import { type ConstraintsDetails, type ControlEntry, type GoalEntry, schemas } from "../schema/index.ts";
import { batchGuard, validatedResult } from "../shared/commands.ts";
import { type CommandResult, failure } from "../shared/result.ts";
import { locateQuote } from "../shared/text.ts";

type LedgerKind = ConstraintsDetails["items"][number]["kind"];
export interface ConstraintsInput {
	op: "submit" | "append";
	items: { kind: LedgerKind; text: string; quotes: string[] }[];
}
export async function submitConstraints(
	ctx: CommandContext,
	input: ConstraintsInput,
): Promise<CommandResult<ConstraintsDetails>> {
	const blocked = batchGuard(ctx);
	if (blocked) return blocked;
	// 11 C2/C3/C4: the quoted initial ledger is immutable to the model in v1.0.
	if (input.op !== "submit") return failure("DOMAIN_INVALID", "追加台账从v1.1启用", ["op"]);
	if (ctx.model.ledger.length) return failure("DOMAIN_INVALID", "台账已存在，请由作者修改", ["items"]);
	const items: ConstraintsDetails["items"] = [];
	for (const [index, item] of input.items.entries()) {
		const id = `L-${ctx.model.ledgerSequence + index + 1}`;
		const sourceSpans = item.quotes.map((quote) => locateQuote(ctx.model.authorMessages, quote));
		if (!sourceSpans.length || sourceSpans.some((span) => span === null))
			return failure(
				"DOMAIN_INVALID",
				"台账引文不在当前分支的作者消息中",
				sourceSpans.length
					? sourceSpans.flatMap((span, quoteIndex) => (span === null ? [`items[${index}].quotes[${quoteIndex}]`] : []))
					: [`items[${index}].quotes`],
			);
		items.push({ id, kind: item.kind, text: item.text, sourceSpans: sourceSpans.filter((span) => span !== null) });
	}
	return validatedResult(schemas.ConstraintsDetails, {
		schema: "story/constraints@1",
		rev: ctx.model.controlRev + 1,
		op: "submit",
		items,
	});
}
export type ControlChange =
	| { field: "author_intent" | "current_focus"; text: string }
	| { field: "ledger_edit"; ledgerPatch: { id?: string; op: "set" | "remove"; text?: string; kind?: LedgerKind }[] };
export function authorControl(m: StoryModel, change: ControlChange): CommandResult<ControlEntry> {
	// 11 C1/C3, 15 A.4: this API is exposed only to the adapter's author-command route.
	if (!m.authorMessages.length) return failure("DOMAIN_INVALID", "先发出故事提示");
	if (change.field !== "ledger_edit")
		return validatedResult(schemas.ControlEntry, { schema: "story/control@1", rev: m.controlRev + 1, ...change });
	let sequence = m.ledgerSequence;
	const seen = new Set<string>();
	const ledgerPatch = [];
	for (const patch of change.ledgerPatch) {
		const id = patch.id ?? `L-${++sequence}`;
		if (seen.has(id)) return failure("DOMAIN_INVALID", "同一台账条目不能重复修改", [id]);
		seen.add(id);
		const old = m.ledger.find((item) => item.id === id);
		if (patch.id && !old) return failure("DOMAIN_INVALID", "台账条目不存在", [id]);
		if (patch.op === "remove" && !old) return failure("DOMAIN_INVALID", "台账条目不存在", [id]);
		if (patch.op === "set" && !patch.text?.trim()) return failure("DOMAIN_INVALID", "台账内容不能为空", [id]);
		ledgerPatch.push({ ...patch, id });
	}
	return validatedResult(schemas.ControlEntry, {
		schema: "story/control@1",
		rev: m.controlRev + 1,
		field: "ledger_edit",
		ledgerPatch,
	});
}
export function authorGoal(
	m: StoryModel,
	change: { targetChapter?: number | null; budget?: GoalEntry["budget"] | null },
): CommandResult<GoalEntry> {
	// 11 R1/R2: complete policy snapshots preserve the other field when one is turned off.
	if (!m.authorMessages.length) return failure("DOMAIN_INVALID", "先发出故事提示");
	const next: GoalEntry = { schema: "story/goal@1", ...m.policy };
	if (change.targetChapter === null) delete next.targetChapter;
	else if (change.targetChapter !== undefined) next.targetChapter = change.targetChapter;
	if (change.budget === null) delete next.budget;
	else if (change.budget !== undefined) next.budget = { ...next.budget, ...change.budget };
	return validatedResult(schemas.GoalEntry, next);
}
