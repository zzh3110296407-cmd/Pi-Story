import { Check } from "typebox/value";
import { expect, test } from "vitest";
import { validateDelta } from "../../core/src/canon/delta.ts";
import { createDraft } from "../../core/src/production/index.ts";
import { parseWriter, patchSchema, schemas, validate } from "../../core/src/schema/index.ts";
import { context } from "../../core/test/context.ts";
import { commitRecord, delta, tool } from "../../core/test/fixtures.ts";
import { FileRules } from "../src/ports.ts";
import { createTestSession } from "./fixture.ts";

test("role rule examples satisfy the production output validators", () => {
	const rules = new FileRules();
	const validators = { Patches: patchSchema, ReviewOutput: schemas.ReviewOutput, DeltaProposal: schemas.DeltaProposal };
	for (const name of ["writer", "review-matrix", "state-projection"]) {
		const text = rules.get(name);
		expect(text).toMatch(/^---\nname: [a-z-]+\ndescription: .+\n---/u);
		expect(text).toContain("JSON");
		const examples = [...text.matchAll(/```json (Patches|ReviewOutput|DeltaProposal)\n([\s\S]*?)\n```/gu)];
		expect(examples.length).toBeGreaterThan(0);
		for (const example of examples)
			expect(Check(validators[example[1] as keyof typeof validators], JSON.parse(example[2]))).toBe(true);
		if (name === "writer") {
			const body = /```text DraftOutput\n([\s\S]*?)\n```/u.exec(text)?.[1];
			expect(body).toBeDefined();
			expect(parseWriter(body ?? "").ok).toBe(true);
		}
	}
});

test("showrunner examples pass the actual registered tool parameter schemas", async () => {
	const fixture = await createTestSession();
	try {
		const text = new FileRules().get("showrunner");
		const examples = [...text.matchAll(/```json (submit_constraints|submit_bible|submit_outline)\n([\s\S]*?)\n```/gu)];
		expect(examples).toHaveLength(3);
		for (const example of examples) {
			const schema = fixture.session.agent.state.tools.find((tool) => tool.name === example[1])?.parameters;
			expect(schema).toBeDefined();
			if (schema) expect(Check(schema, JSON.parse(example[2]))).toBe(true);
		}
	} finally {
		fixture.cleanup();
	}
});

test("the keeper example uses a supported cognition target rather than a bare character key", () => {
	const examples = [
		...new FileRules().get("state-projection").matchAll(/```json DeltaProposal\n([\s\S]*?)\n```/gu),
	].map((match) => {
		const checked = validate(schemas.DeltaProposal, JSON.parse(match[1]));
		if (!checked.ok) throw new Error("Invalid keeper example");
		return checked.value;
	});
	const proposal = examples.find((example) => example.cognitions.length > 0);
	expect(proposal).toBeDefined();
	if (!proposal) throw new Error("Missing cognition example");
	const ctx = context([
		tool("bible", "submit_bible", {
			schema: "story/bible@1",
			rev: 1,
			op: "submit",
			effectiveFromChapter: 1,
			changes: [
				{ kind: "character", key: "char:ada", op: "set", source: "model", card: { identity: "Ada" } },
				{ kind: "place", key: "place:harbor", op: "set", source: "model", value: { description: "The harbor" } },
			],
		}),
	]);
	const draft = createDraft(ctx, { chapter: 1, text: "Ada tested the harbor gate and found it locked." });
	if (!draft.ok) throw new Error(draft.receipt);
	expect(validateDelta(ctx.model, draft.details, proposal).ok).toBe(true);
	const invalid = structuredClone(proposal);
	invalid.cognitions[0].about = "char:ada";
	expect(validateDelta(ctx.model, draft.details, invalid)).toMatchObject({
		ok: false,
		error: { code: "DOMAIN_INVALID", items: ["cognitions[0].about"] },
	});
});

test("the keeper fact-transition example expires the prior chapter and uses location for a place", () => {
	const examples = [...new FileRules().get("state-projection").matchAll(/```json DeltaProposal\n([\s\S]*?)\n```/gu)]
		.map((match) => validate(schemas.DeltaProposal, JSON.parse(match[1])))
		.filter((result) => result.ok)
		.map((result) => result.value);
	const proposal = examples.find((example) => example.facts.some((fact) => fact.op === "expire"));
	expect(proposal, "Missing a complete fact-transition example").toBeDefined();
	if (!proposal) throw new Error("Missing fact-transition example");
	const prior = delta(1);
	prior.factOps.upsert.push({
		id: "F-1",
		subject: "item:compass",
		predicate: "holder",
		object: "char:ada",
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
				{ kind: "place", key: "place:harbor", op: "set", source: "model", value: { description: "The harbor" } },
			],
		}),
		tool("chapter-one", "commit_chapter", {
			schema: "story/commit-result@1",
			ok: true,
			commit: commitRecord(1, prior),
			calls: [],
		}),
	]);
	const draft = createDraft(ctx, { chapter: 2, text: "Ada left the compass on a table in the harbor." });
	if (!draft.ok) throw new Error(draft.receipt);
	expect(validateDelta(ctx.model, draft.details, proposal).ok).toBe(true);
	const sameChapter = structuredClone(proposal);
	sameChapter.facts[0].validUntil = 2;
	expect(validateDelta(ctx.model, draft.details, sameChapter)).toMatchObject({
		ok: false,
		error: { code: "DOMAIN_INVALID", items: ["facts[0]"] },
	});
	const placeHolder = structuredClone(proposal);
	placeHolder.facts[1].predicate = "holder";
	expect(validateDelta(ctx.model, draft.details, placeHolder)).toMatchObject({
		ok: false,
		error: { code: "DOMAIN_INVALID", items: ["facts[1]"] },
	});
});

test("the four published hook lifecycle examples pass the real domain validator", () => {
	const examples = [...new FileRules().get("state-projection").matchAll(/```json DeltaProposal\n([\s\S]*?)\n```/gu)]
		.map((match) => validate(schemas.DeltaProposal, JSON.parse(match[1])))
		.flatMap((result) => (result.ok && result.value.hooks.length ? [result.value] : []));
	expect(examples.map((proposal) => proposal.hooks[0].op)).toEqual(["upsert", "advance", "mention", "resolve"]);
	const texts = [
		"Ada found a humming envelope with no sender's name on the doorstep.",
		"Inside the envelope, Ada found a return address at the ferry office.",
		"Ada noticed the same envelope, still sealed on the table.",
		"The envelope's sender was the ferryman; Ada finally learned the truth from his signed dispatch register.",
	];
	for (const [i, proposal] of examples.entries()) {
		const prior = delta(1);
		prior.hookOps.upsert.push({
			id: "H-1",
			type: "mystery",
			status: "open",
			startChapter: 1,
			lastAdvancedChapter: 1,
			expectedPayoff: "Who sent the humming envelope?",
			dependsOn: [],
		});
		const entries = [
			tool("bible", "submit_bible", {
				schema: "story/bible@1",
				rev: 1,
				op: "submit",
				effectiveFromChapter: 1,
				changes: [{ kind: "character", key: "char:ada", op: "set", source: "model", card: { identity: "Ada" } }],
			}),
		];
		if (i > 0)
			entries.push(
				tool("chapter-one", "commit_chapter", {
					schema: "story/commit-result@1",
					ok: true,
					commit: commitRecord(1, prior),
					calls: [],
				}),
			);
		const ctx = context(entries);
		const draft = createDraft(ctx, { chapter: i === 0 ? 1 : 2, text: texts[i] });
		if (!draft.ok) throw new Error(draft.receipt);
		expect(validateDelta(ctx.model, draft.details, proposal).ok).toBe(true);
	}
});
