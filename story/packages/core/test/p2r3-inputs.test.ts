import { expect, test } from "vitest";
import { keeperInput, writerInput } from "../src/flow/inputs.ts";
import { submitBible, updateBible } from "../src/foundation/index.ts";
import { createDraft } from "../src/production/index.ts";
import { context } from "./context.ts";
import { commitRecord, delta, tool } from "./fixtures.ts";

test("writer receives a rounded 85–115 percent interval only for a supplied target", () => {
	const ctx = context();
	ctx.model.outline = [{ n: 1, targetWords: 1299 }];
	expect(writerInput(ctx.model)).toMatchObject({ targetWords: 1299, wordRange: { min: 1104, max: 1494 } });
	ctx.model.outline = [];
	expect(writerInput(ctx.model)).not.toHaveProperty("wordRange");
});

test("writer rounds exact half-word boundaries without floating multiplier drift", () => {
	const ctx = context();
	ctx.model.outline = [{ n: 1, targetWords: 1350 }];
	expect(writerInput(ctx.model)).toMatchObject({ targetWords: 1350, wordRange: { min: 1148, max: 1553 } });
});

test("non-character invariants remain subject to unchanged B5 protection", async () => {
	const item = {
		kind: "rule" as const,
		key: "rule:wind",
		source: "model" as const,
		value: { description: "Wind changes", invariants: ["Never changes direction"] },
	};
	const initial = await submitBible(context(), { items: [item] });
	if (!initial.ok) throw Error(initial.receipt);
	const ctx = context([
		tool("bible", "submit_bible", initial.details),
		tool("commit", "commit_chapter", { schema: "story/commit-result@1", ok: true, commit: commitRecord(1), calls: [] }),
	]);
	expect(
		await updateBible(ctx, {
			changes: [{ ...item, op: "set", value: { invariants: ["Always changes direction"] } }],
			reason: "change",
		}),
	).toMatchObject({ ok: false, error: { code: "DOMAIN_INVALID" } });
	const result = await updateBible(ctx, {
		changes: [{ ...item, op: "set", value: { notes: "A new detail" } }],
		reason: "add",
	});
	expect(result.ok).toBe(true);
});

test("keeper keys include every effective bible kind and existing state entities, excluding future bible", async () => {
	const initial = await submitBible(context(), {
		items: [
			{ kind: "rule", key: "rule:tide", source: "model", value: { description: "Tide" } },
			{ kind: "character", key: "char:ada", source: "model", value: { identity: "Ada" } },
		],
	});
	if (!initial.ok) throw Error(initial.receipt);
	const previous = delta(1);
	previous.factOps.upsert.push({
		id: "F-1",
		subject: "item:key",
		predicate: "holder",
		object: "org:crew",
		validFrom: 1,
		validUntil: null,
		mode: "narrated",
		status: "confirmed",
		visibility: "public",
		evidence: ["c01.s0001"],
		sourceChapter: 1,
	});
	const ctx = context([
		tool("bible", "submit_bible", initial.details),
		tool("commit", "commit_chapter", {
			schema: "story/commit-result@1",
			ok: true,
			commit: commitRecord(1, previous),
			calls: [],
		}),
	]);
	ctx.model.bible["place:future"] = {
		kind: "place",
		key: "place:future",
		op: "set",
		source: "model",
		value: { description: "future" },
		effectiveFromChapter: 3,
	};
	const draft = createDraft(ctx, { chapter: 2, text: "Ada carried the key." });
	if (!draft.ok) throw Error(draft.receipt);
	const before = structuredClone(ctx.model);
	const input = keeperInput(ctx.model, draft.details) as { bibleKeys: { key: string; kind: string }[] };
	expect(input.bibleKeys).toEqual(
		expect.arrayContaining([
			{ key: "rule:tide", kind: "rule" },
			{ key: "char:ada", kind: "character" },
			{ key: "item:key", kind: "item" },
			{ key: "org:crew", kind: "organization" },
		]),
	);
	expect(input.bibleKeys.some((item) => item.key === "place:future")).toBe(false);
	expect(new Set(input.bibleKeys.map((item) => item.key)).size).toBe(input.bibleKeys.length);
	expect(ctx.model).toEqual(before);
});
