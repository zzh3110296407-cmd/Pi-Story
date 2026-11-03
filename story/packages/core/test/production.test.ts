import { expect, test } from "vitest";
import { createDraft, createReview, patchDraft } from "../src/production/index.ts";
import { context } from "./context.ts";
import { tool } from "./fixtures.ts";

test("W1 W2 W3 A.9 immutable patches require one exact match; rewriting starts a new lineage", async () => {
	const first = createDraft(context(), { chapter: 1, text: "甲乙甲。" });
	if (!first.ok) throw new Error("fixture");
	const entries = [tool("d1", "write_draft", first.details)];
	const ctx = context(entries);
	expect(
		(
			await patchDraft(ctx, {
				draftId: first.details.draftId,
				patches: [{ find: "甲", replace: "丙" }],
				reason: "修订",
			})
		).ok,
	).toBe(false);
	expect(
		(
			await patchDraft(ctx, {
				draftId: first.details.draftId,
				patches: [{ find: "无", replace: "丙" }],
				reason: "修订",
			})
		).ok,
	).toBe(false);
	const patched = await patchDraft(ctx, {
		draftId: first.details.draftId,
		patches: [{ find: "乙", replace: "丙" }],
		reason: "修订",
	});
	expect(patched.details).toMatchObject({
		text: "甲丙甲。",
		parentDraftId: "c01-d01",
		draftId: "c01-d02",
		basis: first.details.basis,
	});
	expect(first.details.text).toBe("甲乙甲。");
	expect(createDraft(ctx, { chapter: 1, text: "重写。" }).ok).toBe(false);
	const rewritten = createDraft(ctx, { chapter: 1, text: "重写。", reason: "重新起草" });
	expect(rewritten.details).not.toHaveProperty("parentDraftId");
	expect(createDraft(ctx, { chapter: 2, text: "越章。" }).ok).toBe(false);
});
test("W5 objective evidence and recheck conclusions are mandatory and bounded", () => {
	const draft = createDraft(context(), { chapter: 1, text: "一行。\n二行。" });
	if (!draft.ok) throw new Error("fixture");
	const ctx = context([tool("d", "write_draft", draft.details)]);
	const observation = {
		category: "连贯",
		objective: true,
		severity: "major",
		scope: "local",
		impact: "矛盾",
		lines: [],
	};
	expect(createReview(ctx, { scope: "full", output: { observations: [observation] } }).ok).toBe(false);
	expect(createReview(ctx, { scope: "full", output: { observations: [{ ...observation, lines: [3] }] } }).ok).toBe(
		false,
	);
	expect(createReview(ctx, { scope: "full", output: { observations: [{ ...observation, lines: [1] }] } }).ok).toBe(
		true,
	);
	const scope = { spans: [{ startLine: 1, endLine: 1 }], forObservations: ["c01-r01-o01"] };
	expect(createReview(ctx, { scope, output: { observations: [] } }).ok).toBe(false);
	expect(
		createReview(ctx, {
			scope,
			output: { observations: [], rechecks: [{ observationId: "c01-r01-o01", resolved: true }] },
		}).ok,
	).toBe(true);
});
