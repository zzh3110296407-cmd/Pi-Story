import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { authorControl, submitConstraints } from "../src/control/index.ts";
import { editorInput, patchInput, writerInput } from "../src/flow/inputs.ts";
import { type BranchEntry, type FoldCache, foldBranch } from "../src/fold/index.ts";
import { createDraft } from "../src/production/index.ts";
import { readStory } from "../src/projections/index.ts";
import { context } from "./context.ts";
import { author, tool } from "./fixtures.ts";
import { record } from "./support/datasets.ts";

async function initialLedger(summary = "主角不能死亡。") {
	const entries: BranchEntry[] = [author("prompt", "主角不能死亡。")];
	const initial = await submitConstraints(context(entries), {
		op: "submit",
		items: [{ kind: "story", text: summary, quotes: ["主角不能死亡。"] }],
	});
	if (!initial.ok) throw new Error(initial.receipt);
	entries.push(tool("initial-ledger", "submit_constraints", initial.details));
	return entries;
}

function roleLedgers(entries: BranchEntry[]): unknown[] {
	const ctx = context(entries);
	const draft = createDraft(ctx, { chapter: 1, text: "门开了。" });
	if (!draft.ok) throw new Error(draft.receipt);
	return [
		writerInput(ctx.model),
		editorInput(ctx.model, draft.details, "full"),
		patchInput(ctx.model, draft.details, []),
	].map((input) => (input as { ledger: unknown[] }).ledger);
}

test("C2 initial model summaries cannot override complete author context", async () => {
	const entries = await initialLedger("主角必须死亡。");
	for (const ledger of roleLedgers(entries))
		expect(ledger).toEqual([
			{
				id: "L-1",
				kind: "story",
				text: "主角必须死亡。",
				authorQuotes: [{ messageId: "prompt", quote: "主角不能死亡。" }],
				authority: { kind: "author_quotes", establishes: "source_only" },
			},
		]);
});

test("C2 C3 author ledger replacement supersedes old quotations in fold and every role input", async () => {
	const entries = await initialLedger();
	const original = JSON.stringify(entries);
	const before = foldBranch(entries);
	const edit = authorControl(before, {
		field: "ledger_edit",
		ledgerPatch: [{ id: "L-1", op: "set", text: "主角必须死亡。" }],
	});
	if (!edit.ok) throw new Error(edit.receipt);
	const changed: BranchEntry[] = [
		...entries,
		{ kind: "custom", entryId: "author-edit", customType: "story.control", data: edit.details },
	];
	const model = foldBranch(changed);
	expect(model.ledger[0]).toEqual({
		id: "L-1",
		kind: "story",
		text: "主角必须死亡。",
		sourceSpans: [],
		authorEditEntryId: "author-edit",
	});
	expect(model.controlRev).toBe(before.controlRev + 1);
	for (const ledger of roleLedgers(changed))
		expect(ledger).toEqual([
			{
				id: "L-1",
				kind: "story",
				text: "主角必须死亡。",
				authorQuotes: [],
				authority: { kind: "author_command", entryId: "author-edit" },
			},
		]);
	expect(readStory(model, { section: "control" }).details?.data).toMatchObject({
		ledger: [{ sourceSpans: [], authorEditEntryId: "author-edit" }],
	});
	expect(JSON.stringify(entries)).toBe(original);
	expect(before.ledger[0].sourceSpans[0].quote).toBe("主角不能死亡。");
	const cache: FoldCache = {};
	foldBranch(entries, cache);
	expect(foldBranch(changed, cache)).toEqual(model);
	expect(foldBranch(entries, cache)).toEqual(before);
	const snapshot = () => [foldBranch(changed), roleLedgers(changed)];
	const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const hash1 = hash(snapshot()),
		hash2 = hash(snapshot());
	record("determinism", { id: "ledger-authority", hash1, hash2 });
	expect(hash1).toBe(hash2);
});

test("C2 C3 direct author additions, repeated replacements and removal retain the latest authority", async () => {
	const entries = await initialLedger();
	for (const [entryId, ledgerPatch] of [
		["add", [{ op: "set" as const, kind: "ambiguity" as const, text: "作者直接新增。" }]],
		["edit-1", [{ id: "L-1", op: "set" as const, text: "主角必须死亡。" }]],
		["edit-2", [{ id: "L-1", op: "set" as const, text: "主角最终幸存。" }]],
	] as const) {
		const command = authorControl(foldBranch(entries), { field: "ledger_edit", ledgerPatch: [...ledgerPatch] });
		if (!command.ok) throw new Error(command.receipt);
		entries.push({ kind: "custom", entryId, customType: "story.control", data: command.details });
	}
	const model = foldBranch(entries);
	expect(model.ledger[0]).toMatchObject({ text: "主角最终幸存。", sourceSpans: [], authorEditEntryId: "edit-2" });
	expect(model.ledger[1]).toMatchObject({ id: "L-2", kind: "ambiguity", sourceSpans: [], authorEditEntryId: "add" });
	const removed = authorControl(model, { field: "ledger_edit", ledgerPatch: [{ id: "L-1", op: "remove" }] });
	if (!removed.ok) throw new Error(removed.receipt);
	const after = [
		...entries,
		{ kind: "custom" as const, entryId: "remove", customType: "story.control", data: removed.details },
	];
	for (const ledger of roleLedgers(after))
		expect(ledger).toEqual([
			{
				id: "L-2",
				kind: "ambiguity",
				text: "作者直接新增。",
				authorQuotes: [],
				authority: { kind: "author_command", entryId: "add" },
			},
		]);
});
