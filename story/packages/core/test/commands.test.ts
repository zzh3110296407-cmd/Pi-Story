import { expect, test } from "vitest";
import { authorControl, authorGoal, submitConstraints } from "../src/control/index.ts";
import { foldBranch } from "../src/fold/index.ts";
import { submitBible, updateBible } from "../src/foundation/index.ts";
import { assembleIntent, patchOutline, setChapterIntent, submitOutline } from "../src/plan/index.ts";
import { context } from "./context.ts";
import { author, commitRecord, tool } from "./fixtures.ts";

const prompt = author();
const bibleInput = {
	items: [
		{
			kind: "character" as const,
			key: "char:traveler",
			name: "旅人",
			source: "model" as const,
			value: { identity: "旅人" },
		},
	],
};
const opening = async () => {
	const ctx = context([prompt]);
	const result = await submitBible(ctx, bibleInput);
	if (!result.ok) throw new Error(result.receipt);
	return [prompt, tool("bible", "submit_bible", result.details)];
};
const outlineInput = {
	narration: { viewpoint: "第三人称", tone: "平静" },
	chapters: [
		{ n: 1, title: "启程", targetWords: 100, purpose: "开门", turn: "意外", hookSeeds: ["门后的声音"] },
		{ n: 2, title: "远行", targetWords: 100, purpose: "离开", turn: "遇阻" },
	],
};
const constraints = {
	op: "submit" as const,
	items: [
		{ kind: "story" as const, text: "主角不死", quotes: ["主角不能死亡"] },
		{ kind: "ambiguity" as const, text: "旅人性别未定", quotes: ["旅人"] },
	],
};
const failedItems = (result: { ok: boolean; error?: { code: string; items?: string[] } }, item?: string) => {
	expect(result.ok).toBe(false);
	expect(result.error?.code).toBe("DOMAIN_INVALID");
	if (item) expect(result.error?.items).toContain(item);
};

test("C2 C3 C4: initial quoted ledger, ambiguity, duplicates/append/false quote rejected", async () => {
	const result = await submitConstraints(context([prompt]), constraints);
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.details.rev).toBe(1);
	expect(result.details.items[0]?.sourceSpans[0]?.messageId).toBe("author");
	expect(result.details.items[1]?.kind).toBe("ambiguity");
	const ctx = context([prompt, tool("ledger", "submit_constraints", result.details)]);
	failedItems(await submitConstraints(ctx, constraints));
	failedItems(await submitConstraints(context([prompt]), { ...constraints, op: "append" }));
	failedItems(
		await submitConstraints(context([prompt]), {
			...constraints,
			items: [{ ...constraints.items[0], quotes: ["作者没说过"] }],
		}),
		"items[0].quotes[0]",
	);
});
test("C1 C3: author commands increment rev, preserve ownership and reject before prompt", () => {
	failedItems(authorControl(foldBranch([]), { field: "author_intent", text: "启程" }));
	const first = authorControl(foldBranch([prompt]), { field: "author_intent", text: "启程" });
	if (!first.ok) throw new Error(first.receipt);
	const m = foldBranch([
		prompt,
		{ kind: "custom", entryId: "control", customType: "story.control", data: first.details },
	]);
	expect(m.controlRev).toBe(1);
	const added = authorControl(m, {
		field: "ledger_edit",
		ledgerPatch: [{ op: "set", kind: "global", text: "忠于作者原话" }],
	});
	if (!added.ok) throw new Error(added.receipt);
	expect(added.details.ledgerPatch?.[0]).toMatchObject({ id: "L-1", kind: "global" });
	const edited = foldBranch([
		prompt,
		{ kind: "custom", entryId: "ledger", customType: "story.control", data: added.details },
	]);
	expect(edited.ledger[0]?.kind).toBe("global");
	failedItems(authorControl(edited, { field: "ledger_edit", ledgerPatch: [{ id: "L-99", op: "remove" }] }), "L-99");
});
test("R1 R2: author policy validation, immediate budget snapshot, off preserves other field", () => {
	failedItems(authorGoal(foldBranch([]), { targetChapter: 2 }));
	failedItems(authorGoal(foldBranch([prompt]), { targetChapter: 0 }));
	failedItems(authorGoal(foldBranch([prompt]), { budget: { tokens: -1 } }));
	const first = authorGoal(foldBranch([prompt]), { targetChapter: 2, budget: { tokens: 100, perChapterCalls: 3 } });
	if (!first.ok) throw new Error(first.receipt);
	const m = foldBranch([prompt, { kind: "custom", entryId: "goal", customType: "story.goal", data: first.details }]);
	const off = authorGoal(m, { targetChapter: null });
	if (!off.ok) throw new Error(off.receipt);
	const reset = foldBranch([
		prompt,
		{ kind: "custom", entryId: "goal", customType: "story.goal", data: first.details },
		{ kind: "custom", entryId: "off", customType: "story.goal", data: off.details },
	]);
	expect(reset.policy.targetChapter).toBeUndefined();
	expect(reset.policy.budget?.tokens).toBe(100);
	expect(authorGoal(reset, { budget: null })).toMatchObject({ ok: true, details: { schema: "story/goal@1" } });
});
test("B1 B2 B3 B6: source promotion with real quote, reject downgrade, false quote and wrong key", async () => {
	const entries = await opening();
	const ctx = context(entries);
	const change = {
		...bibleInput.items[0],
		op: "set" as const,
		source: "user" as const,
		authorQuote: "旅人",
		value: { drive: "远行" },
	};
	const result = await updateBible(ctx, { reason: "作者补充", changes: [change] });
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.details).toMatchObject({ rev: 2, effectiveFromChapter: 1 });
	expect(result.details.changes[0]?.card).toEqual({ identity: "旅人", drive: "远行" });
	const next = context([...entries, tool("bible2", "update_bible", result.details)]);
	failedItems(
		await updateBible(next, { reason: "降级", changes: [{ ...change, source: "model", authorQuote: undefined }] }),
		"char:traveler",
	);
	failedItems(
		await updateBible(ctx, { reason: "伪造", changes: [{ ...change, authorQuote: "我是外星人" }] }),
		"char:traveler",
	);
	failedItems(
		await submitBible(context([prompt]), { items: [{ ...bibleInput.items[0], key: "place:traveler" }] }),
		"items[0].key",
	);
});
test("B4 B5: after chapter one add fields only; reject rewrite, delete, missing reason", async () => {
	const entries = [
		...(await opening()),
		tool("commit", "commit_chapter", { schema: "story/commit-result@1", ok: true, calls: [], commit: commitRecord() }),
	];
	const ctx = context(entries);
	const change = { ...bibleInput.items[0], op: "set" as const, value: { drive: "远行" } };
	const result = await updateBible(ctx, { reason: "补充动机", changes: [change] });
	expect(result).toMatchObject({ ok: true, details: { effectiveFromChapter: 2, rev: 2 } });
	failedItems(
		await updateBible(ctx, { reason: "改身份", changes: [{ ...change, value: { identity: "王子" } }] }),
		"char:traveler",
	);
	failedItems(await updateBible(ctx, { reason: "删掉", changes: [{ ...change, op: "remove" }] }), "char:traveler");
	failedItems(await updateBible(ctx, { reason: " ", changes: [change] }));
});
test("O1 O2: submit and patch future chapters, append at end; reject committed edits and reasonless patch", async () => {
	const ctx = context([prompt]);
	const initial = await submitOutline(ctx, outlineInput);
	if (!initial.ok) throw new Error(initial.receipt);
	const next = context([
		prompt,
		tool("outline", "submit_outline", initial.details),
		tool("commit", "commit_chapter", { schema: "story/commit-result@1", ok: true, calls: [], commit: commitRecord() }),
	]);
	expect(
		await patchOutline(next, {
			reason: "展开",
			chapters: [
				{ n: 2, title: "远方" },
				{ n: 3, title: "归来", targetWords: 100 },
			],
		}),
	).toMatchObject({ ok: true, details: { rev: 2 } });
	failedItems(await patchOutline(next, { reason: "回改", chapters: [{ n: 1, title: "不应变" }] }), "1");
	failedItems(await patchOutline(next, { reason: "", chapters: [{ n: 2, title: "远方" }] }));
});
test("T1 T2 T3: deterministic intent from outline + ledger + brief; plant changes no canon", async () => {
	const ledger = await submitConstraints(context([prompt]), constraints);
	const outline = await submitOutline(context([prompt]), outlineInput);
	if (!ledger.ok || !outline.ok) throw new Error("opening");
	const ctx = context([
		prompt,
		tool("ledger", "submit_constraints", ledger.details),
		tool("outline", "submit_outline", outline.details),
	]);
	const intent = await assembleIntent(ctx, { brief: "主角推开门" });
	expect(intent).toMatchObject({
		ok: true,
		details: { chapter: 1, rev: 1, mustKeep: ["主角不死"], brief: "主角推开门" },
	});
	if (!intent.ok) return;
	expect(intent.details.hookOps[0]).toMatchObject({ op: "plant" });
	expect(ctx.model.commits).toEqual([]);
	expect(await assembleIntent(ctx, { brief: "主角推开门" })).toEqual(intent);
	const m = foldBranch([...ctx.ports.entries.branch(), tool("intent", "set_chapter_intent", intent.details)]);
	expect(await setChapterIntent({ ...ctx, model: m }, { ...intent.details, chapter: 1 })).toMatchObject({
		ok: true,
		details: { rev: 2 },
	});
	failedItems(await setChapterIntent(ctx, { ...intent.details, chapter: 3 }), "3");
});
test("A6: all opening/planning writes reject after batch commit", async () => {
	const ctx = { ...context([prompt]), batch: { committed: true } };
	for (const result of [
		await submitConstraints(ctx, constraints),
		await submitBible(ctx, bibleInput),
		await updateBible(ctx, { changes: [], reason: "测试" }),
		await submitOutline(ctx, outlineInput),
		await patchOutline(ctx, { reason: "测试", chapters: [] }),
		await assembleIntent(ctx, {}),
	])
		expect(result).toMatchObject({ ok: false, error: { code: "STALE_OR_CONFLICT" } });
});

test("C3 O1 T1: deletion preserves ledger sequence and only future plans may change", async () => {
	const initial = authorControl(foldBranch([prompt]), {
		field: "ledger_edit",
		ledgerPatch: [{ op: "set", text: "第一条" }],
	});
	if (!initial.ok) throw new Error(initial.receipt);
	const entries = [
		prompt,
		{ kind: "custom" as const, entryId: "add", customType: "story.control", data: initial.details },
	];
	const removed = authorControl(foldBranch(entries), {
		field: "ledger_edit",
		ledgerPatch: [{ op: "remove", id: "L-1" }],
	});
	if (!removed.ok) throw new Error(removed.receipt);
	const after = foldBranch([
		...entries,
		{ kind: "custom", entryId: "remove", customType: "story.control", data: removed.details },
	]);
	expect(authorControl(after, { field: "ledger_edit", ledgerPatch: [{ op: "set", text: "第二条" }] })).toMatchObject({
		ok: true,
		details: { rev: 3, ledgerPatch: [{ id: "L-2" }] },
	});
	failedItems(
		authorControl(after, { field: "ledger_edit", ledgerPatch: [{ op: "set", id: "L-99", text: "不存在" }] }),
		"L-99",
	);
	const outline = await submitOutline(context([prompt]), outlineInput);
	if (!outline.ok) throw new Error(outline.receipt);
	const ctx = context([
		prompt,
		tool("outline", "submit_outline", outline.details),
		tool("commit", "commit_chapter", { schema: "story/commit-result@1", ok: true, calls: [], commit: commitRecord() }),
	]);
	expect(await patchOutline(ctx, { reason: "结束于首章", chapters: [{ n: 2, remove: true }] })).toMatchObject({
		ok: true,
	});
	const input = { chapter: 1, mustKeep: [], mustAvoid: [], beats: [], hookOps: [], cast: [], brief: "不可回改" };
	failedItems(await setChapterIntent(ctx, input), "1");
	expect(await setChapterIntent(ctx, { ...input, chapter: 2 })).toMatchObject({ ok: true });
});
