import { expect, test } from "vitest";
import { checkDraft, createDraft } from "../src/production/index.ts";
import { context } from "./context.ts";
import { tool } from "./fixtures.ts";
import { loadDataset, record } from "./support/datasets.ts";

interface Case {
	id: string;
	target: string;
	text: string;
	targetWords: number;
	expected: boolean;
}
const { data } = loadDataset<Case[]>("DS05-program-check", "cases.json", "v2");
async function check(text: string, targetWords: number) {
	const outline = tool("outline", "submit_outline", {
		schema: "story/outline@1",
		rev: 1,
		op: "submit",
		chapters: [{ n: 1, title: "章", purpose: "目的", turn: "变化", targetWords }],
	});
	const draft = createDraft(context([outline]), { chapter: 1, text });
	if (!draft.ok) throw new Error(JSON.stringify(draft.error));
	return checkDraft(context([outline, tool("draft", "write_draft", draft.details)]));
}
test("W4 A.2 frozen DS05 independent program-check targets", async () => {
	for (const item of data) {
		const result = await check(item.text, item.targetWords);
		expect(result.ok, item.id).toBe(true);
		const observations = result.details?.observations ?? [];
		const detected = observations.some(
			(o) =>
				({
					too_short: o.severity === "blocking" && o.scope === "structural",
					length: o.severity === "minor" && o.scope === "structural",
					marker: o.severity === "blocking" && o.scope === "local",
					duplicate: o.severity === "major" && o.scope === "local",
				})[item.target],
		);
		record("program-check", { id: item.id, target: item.target, expected: item.expected, detected, observations });
		expect(detected, item.id).toBe(item.expected);
	}
});
test("A.2 real v3 chapters are measured without invented semantic judgments", async () => {
	for (let chapter = 1; chapter <= 3; chapter++) {
		const { data } = loadDataset<{ text?: string; content?: string; chapterNo?: number }>(
			"DS05-program-check",
			`chapters/chapter-${chapter}.json`,
			"v2",
		);
		const text = data.text ?? data.content;
		if (!text) throw new Error("Real chapter body missing");
		const result = await check(text, 3000);
		record("real-check", {
			chapter,
			targetWords: 3000,
			scope: "P0 excerpt at an explicit synthetic length target; length flags are not semantic false positives",
			observations: result.details?.observations,
			judgment: "pending_author",
		});
		expect(result.ok).toBe(true);
	}
});
