import { describe, expect, test } from "vitest";
import { validateDelta } from "../src/canon/delta.ts";
import { keeperInput } from "../src/flow/inputs.ts";
import { type BranchEntry, stateAt } from "../src/fold/index.ts";
import { createDraft } from "../src/production/index.ts";
import { context } from "./context.ts";
import { loadDataset, record } from "./support/datasets.ts";

interface Fixture {
	entries: BranchEntry[];
	draft: { chapter: number; text: string };
	initialState: { facts: unknown[] };
}
interface Case {
	id: string;
	group: string;
	rule: string;
	layer: string;
	proposal?: unknown;
	expected: {
		ok: boolean;
		errorCode: string | null;
		items: string[];
		transform?: { factCount: number; claimCount: number; evidenceSentences: number[] };
	};
}
const fixture = loadDataset<Fixture>("DS03-state-deltas", "context.json", "v2").data;
const cases = loadDataset<Case[]>("DS03-state-deltas", "cases.json", "v2").data;
describe("D1-D11 A.4 frozen DS03 proposal validation and keeper boundary", () => {
	for (const item of cases)
		test(item.id, () => {
			const ctx = context(fixture.entries);
			expect(stateAt(ctx.model).facts.length).toBe(fixture.initialState.facts.length);
			const drafted = createDraft(ctx, fixture.draft);
			if (!drafted.ok) throw new Error(JSON.stringify(drafted.error));
			if (item.layer === "keeper_input") {
				const input = keeperInput(ctx.model, drafted.details) as Record<string, unknown>;
				const matched = item.expected.items.every((key) => !(key in input));
				record("delta", { id: item.id, group: item.group, rule: item.rule, layer: item.layer, matched, input });
				expect(matched).toBe(true);
				return;
			}
			const result = validateDelta(ctx.model, drafted.details, item.proposal);
			const paths = result.ok ? [] : (result.error.items ?? []).map((s) => s.split(": ")[0]);
			const transformed =
				!item.expected.transform ||
				(result.ok &&
					result.details.delta.factOps.upsert.length === item.expected.transform.factCount &&
					result.details.delta.claimOps.add.length === item.expected.transform.claimCount &&
					result.details.downgraded.length > 0 &&
					result.details.delta.claimOps.add[0].evidence.map((s) => Number(s.split(".s")[1])).join() ===
						item.expected.transform.evidenceSentences.join());
			const matched =
				result.ok === item.expected.ok &&
				(result.ok ||
					(result.error.code === item.expected.errorCode &&
						item.expected.items.every((path) => paths.includes(path)))) &&
				transformed;
			record("delta", { id: item.id, group: item.group, rule: item.rule, matched, result });
			expect(result.ok, JSON.stringify(result.ok ? null : result.error)).toBe(item.expected.ok);
			if (!result.ok) {
				expect(result.error.code).toBe(item.expected.errorCode);
				expect(paths).toEqual(expect.arrayContaining(item.expected.items));
			}
			expect(transformed).toBe(true);
		});
});
