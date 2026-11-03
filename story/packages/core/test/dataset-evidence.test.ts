import { expect, test } from "vitest";
import { validateDelta } from "../src/canon/delta.ts";
import type { BranchEntry } from "../src/fold/index.ts";
import { createDraft } from "../src/production/index.ts";
import type { DeltaProposal } from "../src/schema/index.ts";
import { context } from "./context.ts";
import { loadDataset } from "./support/datasets.ts";

const fixture = loadDataset<{ entries: BranchEntry[]; draft: { chapter: number; text: string } }>(
	"DS03-state-deltas",
	"context.json",
	"v2",
).data;
const cases = loadDataset<{ id: string; proposal?: DeltaProposal }[]>("DS03-state-deltas", "cases.json", "v2").data;

function settled(id: string) {
	const ctx = context(fixture.entries);
	const draft = createDraft(ctx, fixture.draft);
	const proposal = cases.find((item) => item.id === id)?.proposal;
	if (!draft.ok || !proposal) throw new Error("Missing positive fixture");
	const result = validateDelta(ctx.model, draft.details, proposal);
	if (!result.ok) throw new Error(result.receipt);
	return result.details;
}

test("D3 DS03 unattributed dialogue must retain an unknown speaker", () => {
	const result = settled("valid-claim");
	expect(result.delta.claimOps.add[0].speaker).toBe("unknown");
	expect(result.evidence["c02.s0008"]).toBe("“钥匙在河底。”");
});

test("D7 DS03 suspicion is inferred from contradictory statements rather than told", () => {
	const result = settled("valid-suspects");
	expect(result.delta.cognitionOps.add[0].via).toBe("inferred");
	expect(result.evidence["c02.s0013"]).toContain("前后矛盾");
});

test("D6 DS03 chapter net quantity includes both the receipt and the payment", () => {
	const result = settled("valid-quantity-change");
	expect(result.delta.factOps.upsert[0].object).toEqual({ value: 9, unit: "枚" });
	expect(result.evidence["c02.s0005"]).toBe("林遥收到两枚银币。");
	expect(result.evidence["c02.s0006"]).toBe("林遥付出三枚银币。");
	expect(result.evidence["c02.s0031"]).toBe("银币袋里现在有九枚银币。");
});
