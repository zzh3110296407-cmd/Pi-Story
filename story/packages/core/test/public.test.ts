import { expect, test } from "vitest";
import { foldBranch } from "../src/fold/index.ts";
import * as api from "../src/index.ts";
import { toExport } from "../src/projections/index.ts";
import { tool } from "./fixtures.ts";

test("IF-6 exposes only the P1 runtime contract", () => {
	expect(Object.keys(api).sort()).toEqual(
		[
			"BudgetGuard",
			"authorControl",
			"authorGoal",
			"checkCommitEligibility",
			"checkDraft",
			"commit",
			"foldBranch",
			"patchDraft",
			"patchOutline",
			"readStory",
			"respondObservations",
			"reviewDraft",
			"setChapterIntent",
			"submitBible",
			"submitConstraints",
			"submitOutline",
			"toBranchList",
			"toExport",
			"toManuscript",
			"toStoryView",
			"updateBible",
			"writeDraft",
			"writeNextChapter",
		].sort(),
	);
});
test("export omits authentication and system prompt fields from nested Bible values", () => {
	const model = foldBranch([
		tool("bible", "submit_bible", {
			schema: "story/bible@1",
			rev: 1,
			op: "submit",
			effectiveFromChapter: 1,
			changes: [
				{
					kind: "character",
					key: "char:a",
					op: "set",
					source: "model",
					value: {
						description: "保留资料",
						apiKey: "fixture-value",
						nested: { systemPrompt: "fixture-private-prompt", color: "蓝" },
					},
				},
			],
		}),
	]);
	const text = toExport(model, "json")
		.map((f) => f.content)
		.join("\n");
	expect(text).toContain("保留资料");
	expect(text).toContain("蓝");
	expect(text).not.toContain("fixture-value");
	expect(text).not.toContain("fixture-private-prompt");
});
