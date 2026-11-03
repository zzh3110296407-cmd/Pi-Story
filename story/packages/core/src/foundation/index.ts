import type { BibleItem } from "../fold/index.ts";
import type { CommandContext } from "../ports/index.ts";
import { type BibleChange, type BibleDetails, schemas } from "../schema/index.ts";
import { batchGuard, validatedResult } from "../shared/commands.ts";
import { type CommandResult, failure } from "../shared/result.ts";
import { locateQuote, validId } from "../shared/text.ts";

export interface BibleItemInput {
	kind: BibleChange["kind"];
	key: string;
	name?: string;
	source: "user" | "model";
	authorQuote?: string;
	value?: unknown;
}
const prefixes = {
	character: "char:",
	place: "place:",
	rule: "rule:",
	conflictLine: "line:",
	frameworkChoice: "fw:",
	relationBaseline: "rel:",
};
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
function merge(before: unknown, patch: unknown): unknown {
	if (!record(before) || !record(patch)) return patch;
	const result = { ...before };
	for (const [key, value] of Object.entries(patch)) result[key] = key in before ? merge(before[key], value) : value;
	return result;
}
function onlyAdds(before: unknown, patch: unknown): boolean {
	if (!record(before) || !record(patch)) return JSON.stringify(before) === JSON.stringify(patch);
	return Object.entries(patch).every(([key, value]) => !(key in before) || onlyAdds(before[key], value));
}
async function bible(
	ctx: CommandContext,
	op: "submit" | "update",
	inputs: (BibleItemInput & { op?: "set" | "remove" })[],
	reason?: string,
): Promise<CommandResult<BibleDetails>> {
	const blocked = batchGuard(ctx);
	if (blocked) return blocked;
	const m = ctx.model;
	if (op === "submit" && m.bibleRev) return failure("DOMAIN_INVALID", "圣经已建立，请使用补充操作", ["items"]);
	if (op === "update" && !reason?.trim()) return failure("DOMAIN_INVALID", "修改圣经必须说明理由", ["reason"]); // B4
	const changes: BibleChange[] = [];
	const seen = new Set<string>();
	for (const [index, input] of inputs.entries()) {
		const errorItem = (field: string) => (op === "submit" ? `items[${index}].${field}` : input.key);
		const operation = input.op ?? "set";
		if (!validId(input.key) || !input.key.startsWith(prefixes[input.kind]) || seen.has(input.key))
			return failure("DOMAIN_INVALID", "圣经键格式或种类不正确", [errorItem("key")]);
		seen.add(input.key);
		const old: BibleItem | undefined = m.bible[input.key];
		if (old?.source === "user" && input.source !== "user")
			return failure("DOMAIN_INVALID", "不能用模型来源改写作者设定", [input.key]); // B2/B3
		const span = input.source === "user" ? locateQuote(m.authorMessages, input.authorQuote ?? "") : null;
		if (input.source === "user" && !span)
			return failure("DOMAIN_INVALID", "作者来源必须有可核对的原话", [errorItem("authorQuote")]);
		if (operation === "remove" && !old) return failure("DOMAIN_INVALID", "待删除的圣经条目不存在", [input.key]);
		const oldValue = old?.kind === "character" ? old.card : old?.value;
		if (
			old &&
			m.lastChapter >= 1 &&
			(operation === "remove" ||
				!onlyAdds(oldValue, input.value) ||
				(input.name !== undefined && old.name !== undefined && input.name !== old.name))
		)
			return failure("DOMAIN_INVALID", "已成书设定只能补充新字段", [input.key]); // B5
		const value = old ? merge(oldValue, input.value) : input.value;
		if (operation === "set" && value === undefined)
			return failure("DOMAIN_INVALID", "设定内容不能为空", [errorItem("value")]);
		const base = {
			kind: input.kind,
			key: input.key,
			op: operation,
			source: input.source,
			...((input.name ?? old?.name) ? { name: input.name ?? old?.name } : {}),
			...(span ? { authorQuote: { messageId: span.messageId, quote: span.quote } } : {}),
		};
		changes.push({
			...base,
			...(operation === "set" ? (input.kind === "character" ? { card: value } : { value }) : {}),
		} as BibleChange);
	}
	// B1/B6: revisions apply to the next chapter, never retroactively.
	return validatedResult(schemas.BibleDetails, {
		schema: "story/bible@1",
		rev: m.bibleRev + 1,
		op,
		...(reason ? { reason } : {}),
		effectiveFromChapter: m.lastChapter + 1,
		changes,
	});
}
export const submitBible = (ctx: CommandContext, input: { items: BibleItemInput[] }) =>
	bible(ctx, "submit", input.items);
export const updateBible = (
	ctx: CommandContext,
	input: { changes: (BibleItemInput & { op: "set" | "remove" })[]; reason: string },
) => bible(ctx, "update", input.changes, input.reason);
