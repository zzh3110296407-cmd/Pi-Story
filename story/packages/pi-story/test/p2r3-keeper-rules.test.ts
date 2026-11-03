import { expect, test } from "vitest";
import { validateDelta } from "../../core/src/canon/delta.ts";
import { createDraft } from "../../core/src/production/index.ts";
import { context } from "../../core/test/context.ts";
import { commitRecord, delta, tool } from "../../core/test/fixtures.ts";
import { FileRules } from "../src/ports.ts";

test("25 S3 time and cognition positive/negative examples exercise unchanged core validators", () => {
	const section = new FileRules().get("state-projection").split("## Time and cognition boundary examples")[1] ?? "";
	const examples = [...section.matchAll(/```json DeltaProposal\n([\s\S]*?)\n```/gu)].map((match) =>
		JSON.parse(match[1]),
	);
	expect(examples).toHaveLength(4);
	const prior = delta(1);
	prior.factOps.upsert.push({
		id: "F-1",
		subject: "place:harbor",
		predicate: "free_predicate",
		object: "The gate is locked",
		validFrom: 1,
		validUntil: null,
		mode: "narrated",
		status: "confirmed",
		visibility: "public",
		evidence: ["c01.s0001"],
		sourceChapter: 1,
	});
	const ctx = context([
		tool("bible", "submit_bible", {
			schema: "story/bible@1",
			rev: 1,
			op: "submit",
			effectiveFromChapter: 1,
			changes: [
				{ kind: "character", key: "char:ada", op: "set", source: "model", card: { identity: "Ada" } },
				{ kind: "place", key: "place:harbor", op: "set", source: "model", value: { description: "Harbor" } },
			],
		}),
		tool("commit", "commit_chapter", {
			schema: "story/commit-result@1",
			ok: true,
			commit: commitRecord(1, prior),
			calls: [],
		}),
	]);
	const draft = createDraft(ctx, {
		chapter: 2,
		text: "Ada remembered that the medal had been damaged long before the story began. Ada tested the harbor gate and learned it was locked.",
	});
	if (!draft.ok) throw Error(draft.receipt);
	const results = examples.map((example) => validateDelta(ctx.model, draft.details, example));
	expect(results.map((result) => result.ok)).toEqual([true, false, true, false]);
	expect(results[1]).toMatchObject({ error: { code: "DOMAIN_INVALID", items: ["facts[0].validFrom"] } });
	expect(results[3]).toMatchObject({ error: { code: "DOMAIN_INVALID", items: ["cognitions[0].about"] } });
});
