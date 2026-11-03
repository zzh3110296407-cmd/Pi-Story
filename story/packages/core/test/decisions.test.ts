import { expect, test } from "vitest";
import { validateDelta } from "../src/canon/delta.ts";
import { editorInput, writerInput } from "../src/flow/inputs.ts";
import { type BranchEntry, foldBranch, stateAt } from "../src/fold/index.ts";
import { patchOutline } from "../src/plan/index.ts";
import { createDraft, patchDraft } from "../src/production/index.ts";
import { schemas, validate } from "../src/schema/index.ts";
import { locateQuote, sentences } from "../src/shared/text.ts";
import { BudgetGuard } from "../src/usage/index.ts";
import { context } from "./context.ts";
import { author, commitRecord, delta, tool } from "./fixtures.ts";
import { loadDataset } from "./support/datasets.ts";

const fixture = loadDataset<{ entries: BranchEntry[] }>("DS03-state-deltas", "context.json", "v2").data;
const proposal = (facts: unknown[]) => ({
	facts,
	claims: [],
	cognitions: [],
	relations: [],
	hooks: [],
	summary: { title: "回忆", characters: [], events: [], mood: "平静" },
	issues: [],
});

test("O1 O2 DD05 deleting a middle unwritten chapter requires an atomic renumber and preserves canon", async () => {
	const entries = [
		author(),
		tool("outline", "submit_outline", {
			schema: "story/outline@1",
			rev: 1,
			op: "submit",
			chapters: [
				{ n: 1, title: "已提交" },
				{ n: 2, title: "删除" },
				{ n: 3, title: "后移" },
			],
		}),
		tool("canon", "commit_chapter", { schema: "story/commit-result@1", ok: true, commit: commitRecord(), calls: [] }),
	];
	const ctx = context(entries);
	expect((await patchOutline(ctx, { chapters: [{ n: 2, remove: true }], reason: "删除" })).ok).toBe(false);
	const result = await patchOutline(ctx, {
		chapters: [
			{ n: 2, title: "后移" },
			{ n: 3, remove: true },
		],
		reason: "删除并重排",
	});
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	const after = foldBranch([...entries, tool("patch", "patch_outline", result.details)]);
	expect(after.outline).toEqual([
		{ n: 1, title: "已提交" },
		{ n: 2, title: "后移" },
	]);
	expect(after.commits).toEqual(ctx.model.commits);
});

for (const [body, expected] of [
	["At 8:47 p.m. last night, she left. Next.", ["At 8:47 p.m. last night, she left.", "Next."]],
	["At 8 p.m. She left.", ["At 8 p.m.", "She left."]],
	["> migr. to GOLDWARD cluster — do not decom. ask R.M.", ["> migr. to GOLDWARD cluster — do not decom. ask R.M."]],
	["*Please.* She waited.", ["*Please.*", "She waited."]],
	["**Stop!** Then wait.", ["**Stop!**", "Then wait."]],
	["*3. Escalate before you touch anything.* Next.", ["*3. Escalate before you touch anything.*", "Next."]],
	["> 3. Escalate now. Next.", ["> 3. Escalate now.", "Next."]],
] as const) {
	test(`A.1 s2 editorial boundary: ${body}`, () => {
		const parts = sentences(body, 1, "s2");
		expect(parts.map((part) => part.text)).toEqual(expected);
		for (const part of parts) expect(body.slice(part.start, part.end)).toBe(part.text);
	});
}

test("A.1 s1 remains stable; new drafts use s2 and patches preserve the parent rule", async () => {
	const text = "*Please.* She waited.";
	expect(sentences(text, 1, "s1").map((part) => part.text)).toEqual([text]);
	const ctx = context([author()]);
	const draft = createDraft(ctx, { chapter: 1, text });
	if (!draft.ok) throw new Error("draft");
	expect(draft.details.sentenceRule).toBe("s2");
	const old = { ...draft.details, sentenceRule: "s1" as const };
	ctx.model.drafts.push(old);
	const patched = await patchDraft(ctx, {
		draftId: old.draftId,
		patches: [{ find: "waited", replace: "left" }],
		reason: "修订",
	});
	expect(patched.ok && patched.details.sentenceRule).toBe("s1");
	expect(validate(schemas.DraftDetails, old).ok).toBe(true);
});

test("C2 typographic equivalence treats fullwidth ASCII consistently without broad NFKC folding", () => {
	const messages = [{ entryId: "u", text: "不要使用ＡＩ旁白！第①条。" }];
	expect(locateQuote(messages, "不要使用AI旁白!")?.messageId).toBe("u");
	expect(locateQuote(messages, "第1条")).toBeNull();
	expect(locateQuote([{ entryId: "u", text: "AI" }], "АI")).toBeNull();
});

test("C2 role inputs preserve complete source context for conditions and forbidden examples", () => {
	const source = "如果下雨，林遥必须留在屋内。请把‘主角必须死亡’作为反例，不要照做。";
	const ctx = context([author("u", source)]);
	ctx.model.ledger.push({
		id: "L-1",
		kind: "story",
		text: "林遥必须留在屋内",
		sourceSpans: [{ messageId: "u", quote: "林遥必须留在屋内", start: 5, end: 13 }],
	});
	const draft = createDraft(ctx, { chapter: 1, text: "雨停了。" });
	if (!draft.ok) throw new Error("draft");
	for (const input of [writerInput(ctx.model), editorInput(ctx.model, draft.details, "full")]) {
		expect(input).toMatchObject({
			authorSources: [{ messageId: "u", sourceText: source }],
			ledger: [
				{
					authorQuotes: [{ messageId: "u", quote: "林遥必须留在屋内" }],
					authority: { kind: "author_quotes", establishes: "source_only" },
				},
			],
		});
	}
});

test("C2 repeated references include each complete author message only once", () => {
	const source = "如果下雨，林遥必须留在屋内；如果放晴，可以出门。";
	const ctx = context([author("u", source)]);
	for (const id of ["L-1", "L-2"])
		ctx.model.ledger.push({
			id,
			kind: "story",
			text: "整理",
			sourceSpans: [{ messageId: "u", quote: "林遥必须留在屋内", start: 5, end: 13 }],
		});
	expect(writerInput(ctx.model)).toMatchObject({ authorSources: [{ messageId: "u", sourceText: source }] });
	expect(JSON.stringify(writerInput(ctx.model)).split(source).length - 1).toBe(1);
});

for (const speaker of ["char:shopkeeper", "unknown", undefined]) {
	test(`D3 explicit speaker survives downgrade: ${speaker ?? "omitted"}`, () => {
		const ctx = context(fixture.entries);
		const draft = createDraft(ctx, { chapter: 2, text: "“店主已经死了。”" });
		if (!draft.ok) throw new Error("draft");
		const result = validateDelta(
			ctx.model,
			draft.details,
			proposal([
				{
					ref: "f",
					op: "upsert",
					subject: "char:shopkeeper",
					predicate: "alive",
					object: "dead",
					certainty: "confirmed",
					sentences: [1],
					...(speaker ? { speaker } : {}),
				},
			]),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.details.delta.factOps.upsert).toEqual([]);
			expect(result.details.delta.claimOps.add[0].speaker).toBe(speaker ?? "unknown");
		}
	});
}

test("D3 downgrade rejects an unknown character speaker instead of persisting it", () => {
	const ctx = context(fixture.entries);
	const draft = createDraft(ctx, { chapter: 2, text: "“店主已经死了。”" });
	if (!draft.ok) throw new Error("draft");
	const result = validateDelta(
		ctx.model,
		draft.details,
		proposal([
			{
				ref: "f",
				op: "upsert",
				subject: "char:shopkeeper",
				predicate: "alive",
				object: "dead",
				certainty: "confirmed",
				speaker: "char:missing",
				sentences: [1],
			},
		]),
	);
	expect(result).toMatchObject({ ok: false, error: { code: "DOMAIN_INVALID", items: ["facts[0].speaker"] } });
});

function historicalContext() {
	const first = delta(1),
		third = delta(3);
	first.factOps.upsert.push({
		id: "F-1",
		subject: "char:shopkeeper",
		predicate: "identity",
		object: "书商",
		validFrom: 0,
		validUntil: 1,
		mode: "narrated",
		status: "confirmed",
		visibility: "public",
		evidence: ["c01.s0001"],
		sourceChapter: 1,
	});
	third.factOps.upsert.push({
		...first.factOps.upsert[0],
		id: "F-2",
		object: "医生",
		validFrom: 3,
		validUntil: null,
		evidence: ["c03.s0001"],
		sourceChapter: 3,
	});
	return context([
		author(),
		...fixture.entries.filter((entry) => entry.kind === "toolResult" && entry.toolName === "submit_bible"),
		...[commitRecord(1, first), commitRecord(2), commitRecord(3, third)].map((commit, i) =>
			tool(`prior-${i}`, "commit_chapter", { schema: "story/commit-result@1", ok: true, commit, calls: [] }),
		),
	]);
}

test("D4 explicit historical start fills a real gap without expanding it to chapter zero", () => {
	const ctx = historicalContext();
	const draft = createDraft(ctx, { chapter: 4, text: "店主想起第二章时自己曾是一名画家。" });
	if (!draft.ok) throw new Error("draft");
	const result = validateDelta(
		ctx.model,
		draft.details,
		proposal([
			{
				ref: "f",
				op: "upsert",
				subject: "char:shopkeeper",
				predicate: "identity",
				object: "画家",
				mode: "recalled_past",
				validFrom: 2,
				validUntil: 2,
				certainty: "confirmed",
				sentences: [1],
			},
		]),
	);
	expect(result.ok).toBe(true);
	if (result.ok) expect(result.details.delta.factOps.upsert[0]).toMatchObject({ validFrom: 2, validUntil: 2 });
});

test("D4 unknown start is null and remains valid after persistence without retroactive knowledge", () => {
	const ctx = historicalContext();
	const draft = createDraft(ctx, { chapter: 4, text: "店主回忆自己的父亲早已去世。" });
	if (!draft.ok) throw new Error("draft");
	const result = validateDelta(
		ctx.model,
		draft.details,
		proposal([
			{
				ref: "f",
				op: "upsert",
				subject: "char:shopkeeper",
				predicate: "family_history",
				object: "父亲早已去世",
				mode: "recalled_past",
				certainty: "confirmed",
				sentences: [1],
			},
		]),
	);
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.details.delta.factOps.upsert[0].validFrom).toBeNull();
	const commit = {
		...commitRecord(4, result.details.delta),
		text: draft.details.text,
		sentenceRule: draft.details.sentenceRule,
	};
	expect(validate(schemas.CommitRecord, commit).ok).toBe(true);
	ctx.model.commits.push(commit);
	ctx.model.lastChapter = 4;
	expect(stateAt(ctx.model).facts.find((fact) => fact.predicate === "family_history")?.validFrom).toBeNull();
	expect(stateAt(ctx.model, 3).facts.some((fact) => fact.predicate === "family_history")).toBe(false);
});

test("D4 unknown historical start requests an explicit bound when an old interval may overlap", () => {
	const ctx = historicalContext();
	const draft = createDraft(ctx, { chapter: 4, text: "店主回忆过去曾是一名画家。" });
	if (!draft.ok) throw new Error("draft");
	const result = validateDelta(
		ctx.model,
		draft.details,
		proposal([
			{
				ref: "f",
				op: "upsert",
				subject: "char:shopkeeper",
				predicate: "identity",
				object: "画家",
				mode: "recalled_past",
				validUntil: 2,
				certainty: "confirmed",
				sentences: [1],
			},
		]),
	);
	expect(result).toMatchObject({ ok: false, error: { code: "DOMAIN_INVALID", items: ["facts[0].validFrom"] } });
});

for (const phase of ["active", "settled"] as const) {
	test(`U2 enabling a money limit detects unknown ${phase} reservations`, () => {
		let limited = false;
		const guard = new BudgetGuard(() => ({ calls: [], interruptions: [], budget: limited ? { costUsd: 10 } : {} }), {
			price: (model) => (model === "unknown" ? null : { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }),
		});
		const reservation = guard.reserve({ role: "writer", model: "unknown", inputTokensEstimate: 2, maxOutputTokens: 3 });
		if (!reservation.ok) throw new Error("reservation");
		if (phase === "settled")
			guard.settle(reservation.reservationId, {
				role: "writer",
				model: "unknown",
				reservedInputTokens: 2,
				reservedOutputTokens: 3,
				reservedCostUsd: null,
				usage: null,
				status: "missing",
			});
		limited = true;
		expect(guard.reserve({ role: "editor", model: "known", inputTokensEstimate: 1, maxOutputTokens: 1 })).toMatchObject(
			{ ok: false, error: { code: "BUDGET_EXHAUSTED" } },
		);
	});
}

for (const [mode, validFrom, validUntil] of [
	["recalled_past", 4, 4],
	["recalled_past", 3, 2],
	["narrated", 2, 4],
] as const) {
	test(`D4 D5 rejects invalid explicit interval ${mode}/${validFrom}/${validUntil}`, () => {
		const ctx = historicalContext();
		const draft = createDraft(ctx, { chapter: 4, text: "店主想起过去。" });
		if (!draft.ok) throw new Error("draft");
		expect(
			validateDelta(
				ctx.model,
				draft.details,
				proposal([
					{
						ref: "f",
						op: "upsert",
						subject: "char:shopkeeper",
						predicate: "memory",
						object: "过去",
						mode,
						validFrom,
						validUntil,
						certainty: "confirmed",
						sentences: [1],
					},
				]),
			),
		).toMatchObject({ ok: false, error: { code: "DOMAIN_INVALID" } });
	});
}

test("U2 monetary limits fail closed for unknown prices; token-only limits remain usable", () => {
	const request = { role: "writer", model: "unknown", inputTokensEstimate: 2, maxOutputTokens: 3 };
	const price = { price: () => null };
	const money = new BudgetGuard(() => ({ calls: [], interruptions: [], budget: { costUsd: 10 } }), price);
	expect(money.reserve(request)).toMatchObject({ ok: false, error: { code: "BUDGET_EXHAUSTED" } });
	expect(money.inFlight().tokens).toBe(0);
	const tokens = new BudgetGuard(() => ({ calls: [], interruptions: [], budget: { tokens: 5 } }), price);
	expect(tokens.reserve(request)).toMatchObject({ ok: true, costUsd: null });
	expect(tokens.reserve(request).ok).toBe(false);
});

test("U2 unknown historical interruption cost blocks a known-price call under a money limit", () => {
	const guard = new BudgetGuard(
		() => ({
			calls: [],
			interruptions: [
				{
					schema: "story/interrupted@1",
					toolCallId: "i",
					toolName: "write_next_chapter",
					reservedTokens: 10,
					note: "possible_duplicate",
				},
			],
			budget: { costUsd: 10 },
		}),
		{ price: () => ({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }) },
	);
	expect(guard.reserve({ role: "writer", model: "known", inputTokensEstimate: 2, maxOutputTokens: 3 })).toMatchObject({
		ok: false,
		error: { code: "BUDGET_EXHAUSTED" },
	});
});
