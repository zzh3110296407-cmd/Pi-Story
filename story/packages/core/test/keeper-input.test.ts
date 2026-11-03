import { expect, test } from "vitest";
import { keeperInput } from "../src/flow/inputs.ts";
import { createDraft } from "../src/production/index.ts";
import { context } from "./context.ts";
import { commitRecord, delta, tool } from "./fixtures.ts";

test("keeper sees a fresh compact description of each unfinished hook without mutating canon", () => {
	const previous = delta(1);
	previous.hookOps.upsert = (["open", "progressing", "deferred", "resolved", "superseded"] as const).map(
		(status, i) => ({
			id: `H-${i + 1}`,
			type: "mystery",
			status,
			startChapter: 1,
			lastAdvancedChapter: 1,
			...(i === 0 ? { expectedPayoff: "Who sent the envelope?" } : {}),
			...(i === 1 ? { notes: "An unexplained mark on the seal." } : {}),
			dependsOn: [],
		}),
	);
	const ctx = context([
		tool("chapter-one", "commit_chapter", {
			schema: "story/commit-result@1",
			ok: true,
			commit: commitRecord(1, previous),
			calls: [],
		}),
	]);
	const drafted = createDraft(ctx, { chapter: 2, text: "The envelope was still on the table." });
	if (!drafted.ok) throw new Error(drafted.receipt);
	const before = structuredClone(ctx.model);
	const input = keeperInput(ctx.model, drafted.details) as { openHooks: { id: string; summary: string }[] };
	expect(input.openHooks).toEqual([
		{ id: "H-1", type: "mystery", summary: "Who sent the envelope?", startChapter: 1, lastAdvancedChapter: 1 },
		{
			id: "H-2",
			type: "mystery",
			summary: "An unexplained mark on the seal.",
			startChapter: 1,
			lastAdvancedChapter: 1,
		},
		{ id: "H-3", type: "mystery", summary: "mystery", startChapter: 1, lastAdvancedChapter: 1 },
	]);
	input.openHooks[0].summary = "Caller-local change";
	expect(ctx.model).toEqual(before);
});

test("an opening chapter has an explicit empty hook checklist", () => {
	const ctx = context();
	const drafted = createDraft(ctx, { chapter: 1, text: "The boat arrived." });
	if (!drafted.ok) throw new Error(drafted.receipt);
	expect(keeperInput(ctx.model, drafted.details)).toHaveProperty("openHooks", []);
});
