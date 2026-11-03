import path from "node:path";
import { expect, test } from "vitest";
import { splitDataset } from "../../../scripts/eval/p2/datasets.ts";
import { editorInput, keeperInput } from "../../core/src/flow/inputs.ts";
import { type BranchEntry, foldBranch } from "../../core/src/fold/index.ts";
import { createDraft } from "../../core/src/production/index.ts";
import { context } from "../../core/test/context.ts";

const root = path.resolve(import.meta.dirname, "../../../testing");

test.each([
	["DS09-state-gold", "keeper", 15, 35],
	["DS10-review-defects", "editor", 45, 105],
] as const)(
	"%s uses the separate v1 development input patch through the actual role projection",
	(directory, role, n, hooks) => {
		const data = splitDataset(root, directory, "v1", "development", "E12", true, "v3");
		const files = data.files.filter((file) => /^(dev|acceptance)\/entries\/[^/]+\.json$/u.test(file.path));
		expect(files).toHaveLength(n);
		let references = 0;
		for (const file of files) {
			const entries = data.json(file.path) as BranchEntry[];
			const model = foldBranch(entries);
			const chapter = Number(/-c(\d+)/u.exec(file.path)?.[1]);
			let input: unknown;
			if (role === "keeper") {
				const drafted = createDraft(context(entries), {
					chapter,
					text: data.text(file.path.replace("/entries/", "/chapters/").replace(/\.json$/u, ".md")),
				});
				if (!drafted.ok) throw new Error(drafted.receipt);
				input = keeperInput(model, drafted.details);
			} else {
				const draft = model.drafts.at(-1);
				if (!draft) throw new Error("Missing frozen editor draft");
				input = editorInput(model, draft, "full");
			}
			const state = (input as { state: { hooks: { expectedPayoff?: string }[] } }).state;
			for (const hook of state.hooks) {
				references++;
				expect(hook.expectedPayoff?.trim(), file.path).toBeTruthy();
			}
		}
		expect(references).toBe(hooks);
	},
);

test("a development override cannot be used by an acceptance reader before any file access", () => {
	expect(() => splitDataset("must-not-open", "DS09-state-gold", "v1", "acceptance", "E13", false, "v3")).toThrow(
		/development input patch/u,
	);
});
