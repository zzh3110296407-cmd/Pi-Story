import type { CommandContext } from "../ports/index.ts";
import { type IntentDetails, type OutlineDetails, schemas } from "../schema/index.ts";
import { batchGuard, validatedResult } from "../shared/commands.ts";
import { type CommandResult, failure } from "../shared/result.ts";

export type OutlineInput = Pick<OutlineDetails, "narration" | "chapters">;
export async function submitOutline(ctx: CommandContext, input: OutlineInput): Promise<CommandResult<OutlineDetails>> {
	const blocked = batchGuard(ctx);
	if (blocked) return blocked;
	if (ctx.model.outlineRev) return failure("DOMAIN_INVALID", "大纲已建立，请使用补丁", ["chapters"]);
	return outline(ctx, "submit", input);
}
export async function patchOutline(
	ctx: CommandContext,
	input: OutlineInput & { reason: string },
): Promise<CommandResult<OutlineDetails>> {
	const blocked = batchGuard(ctx);
	if (blocked) return blocked;
	if (!input.reason.trim()) return failure("DOMAIN_INVALID", "修改大纲必须说明理由", ["reason"]); // O2
	return outline(ctx, "patch", input);
}
function outline(
	ctx: CommandContext,
	op: "submit" | "patch",
	input: OutlineInput & { reason?: string },
): CommandResult<OutlineDetails> {
	const chapters = op === "submit" ? [] : [...ctx.model.outline];
	const seen = new Set<number>();
	const lastPlanned = Math.max(0, ...chapters.map((item) => item.n));
	for (const [changeIndex, change] of input.chapters.entries()) {
		if (change.n <= ctx.model.lastChapter || seen.has(change.n))
			return failure("DOMAIN_INVALID", "只能修改未提交且不重复的章节", [
				op === "submit" ? `chapters[${changeIndex}].n` : String(change.n),
			]); // O1
		seen.add(change.n);
		const index = chapters.findIndex((item) => item.n === change.n);
		if (change.remove) {
			if (index < 0) return failure("DOMAIN_INVALID", "待删除章节不存在", [String(change.n)]);
			chapters.splice(index, 1);
		} else if (index >= 0) chapters[index] = { ...chapters[index], ...change };
		else {
			if (op === "patch" && change.n <= lastPlanned)
				return failure("DOMAIN_INVALID", "只能在大纲末尾添加章节", [String(change.n)]);
			chapters.push(change);
		}
	}
	chapters.sort((a, b) => a.n - b.n);
	if (chapters.some((item, index) => item.n !== index + 1))
		return failure(
			"DOMAIN_INVALID",
			"大纲章号必须从一开始连续",
			op === "submit"
				? input.chapters.map((_item, index) => `chapters[${index}].n`)
				: chapters.map((item) => String(item.n)),
		);
	return validatedResult(schemas.OutlineDetails, {
		schema: "story/outline@1",
		rev: ctx.model.outlineRev + 1,
		op,
		...input,
	});
}
export async function setChapterIntent(
	ctx: CommandContext,
	input: Omit<IntentDetails, "schema" | "rev">,
): Promise<CommandResult<IntentDetails>> {
	const blocked = batchGuard(ctx);
	if (blocked) return blocked;
	// T1/T2/T3: plan changes do not create canon or hooks.
	if (input.chapter <= ctx.model.lastChapter || !ctx.model.outline.some((item) => item.n === input.chapter))
		return failure("DOMAIN_INVALID", "章节未在未提交的大纲中", [String(input.chapter)]);
	return validatedResult(schemas.IntentDetails, {
		...input,
		schema: "story/intent@1",
		rev: (ctx.model.intents[input.chapter]?.rev ?? 0) + 1,
	});
}
export async function assembleIntent(
	ctx: CommandContext,
	input: { brief?: string },
): Promise<CommandResult<IntentDetails>> {
	const blocked = batchGuard(ctx);
	if (blocked) return blocked;
	const chapter = ctx.model.lastChapter + 1;
	const entry = ctx.model.outline.find((item) => item.n === chapter);
	if (!entry) return failure("DOMAIN_INVALID", "下一章不在大纲中，请先扩充大纲", [String(chapter)]);
	const relevant = ctx.model.ledger.filter((item) => ["global", "story", "continuation_start"].includes(item.kind));
	return setChapterIntent(ctx, {
		chapter,
		mustKeep: relevant.map((item) => item.text),
		mustAvoid: [],
		beats: [entry.purpose, entry.turn].filter((item): item is string => item !== undefined),
		hookOps: (entry.hookSeeds ?? []).map((seed) => ({ hookId: seed, op: "plant" })),
		cast: Object.values(ctx.model.bible)
			.filter((item) => item.kind === "character" && item.effectiveFromChapter <= chapter)
			.map((item) => item.key)
			.sort(),
		brief: input.brief ?? entry.purpose ?? "",
	});
}
