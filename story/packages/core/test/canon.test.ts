import { expect, test } from "vitest";
import { validateDelta } from "../src/canon/delta.ts";
import { type BranchEntry, stateAt } from "../src/fold/index.ts";
import { createDraft } from "../src/production/index.ts";
import type { DeltaProposal } from "../src/schema/index.ts";
import { context } from "./context.ts";
import { loadDataset } from "./support/datasets.ts";

const fixture = loadDataset<{ entries: BranchEntry[]; draft: { chapter: number; text: string } }>(
	"DS03-state-deltas",
	"context.json",
	"v2",
).data;
test("HOOK D8 all legal and illegal lifecycle transitions; mention preserves status", () => {
	const ctx = context(fixture.entries),
		draft = createDraft(ctx, fixture.draft);
	if (!draft.ok) throw new Error("fixture");
	for (const [id, status] of [
		["H-1", "open"],
		["H-2", "progressing"],
		["H-3", "deferred"],
		["H-4", "resolved"],
		["H-5", "superseded"],
	] as const) {
		for (const op of ["upsert", "advance", "mention", "resolve", "defer", "supersede"] as const) {
			const proposal: DeltaProposal = {
				facts: [],
				claims: [],
				cognitions: [],
				relations: [],
				hooks: [
					{
						ref: "h",
						op,
						id,
						type: "调查线",
						sentences: [21],
						...(op === "supersede" ? { by: id === "H-1" ? "H-2" : "H-1" } : {}),
					},
				],
				summary: { title: "章", characters: [], events: [], mood: "平静" },
				issues: [],
			};
			const allowed = !["resolved", "superseded"].includes(status) && !(status === "deferred" && op === "defer");
			const result = validateDelta(ctx.model, draft.details, proposal);
			expect(result.ok, `${status} -> ${op}: ${JSON.stringify(result.ok ? null : result.error)}`).toBe(allowed);
			if (op === "mention" && result.ok) {
				expect(result.details.delta.hookOps.upsert).toEqual([]);
				expect(result.details.delta.hookOps.mention[0].id).toBe(id);
			}
		}
	}
	expect(stateAt(ctx.model).hooks.find((h) => h.id === "H-1")?.status).toBe("open");
});
test("D6 decimal quantity arithmetic is exact and ID allocation is deterministic", () => {
	const ctx = context(fixture.entries),
		draft = createDraft(ctx, { chapter: 2, text: "林遥收到0.1枚银币。" });
	if (!draft.ok) throw new Error("fixture");
	const p: DeltaProposal = {
		facts: [
			{ ref: "expire", op: "expire", id: "F-2", validUntil: 1, sentences: [1] },
			{
				ref: "next",
				op: "upsert",
				subject: "char:lin_yao",
				predicate: "quantity:silver",
				object: { value: 10.1, unit: "枚" },
				change: 0.1,
				certainty: "confirmed",
				sentences: [1],
			},
		],
		claims: [],
		cognitions: [],
		relations: [],
		hooks: [],
		summary: { title: "章", characters: [], events: [], mood: "平静" },
		issues: [],
	};
	const result = validateDelta(ctx.model, draft.details, p);
	expect(result.ok).toBe(true);
	expect(validateDelta(ctx.model, draft.details, p)).toEqual(result);
	p.facts[1].change = 0.10001;
	expect(validateDelta(ctx.model, draft.details, p).ok).toBe(false);
});
