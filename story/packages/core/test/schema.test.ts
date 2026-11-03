import { expect, test } from "vitest";
import { parsePatches, parseWriter, schemas, validate } from "../src/schema/index.ts";

const basis = { canonHead: null, controlRev: 0, bibleRev: 1, intentRev: 1, stateRev: 0 };
const summary = {
	chapter: 1,
	title: "启程",
	characters: [],
	events: [],
	stateChanges: [],
	hookActivity: [],
	mood: "平静",
};
const fact = {
	id: "F-1",
	subject: "char:a",
	predicate: "alive",
	object: "alive",
	validFrom: 1,
	validUntil: null,
	mode: "narrated",
	status: "confirmed",
	visibility: "public",
	evidence: ["c01.s0001"],
	sourceChapter: 1,
};
const cognition = {
	id: "K-1",
	characterId: "char:a",
	kind: "knows",
	content: "门已开",
	about: null,
	acquiredChapter: 1,
	via: "witnessed",
	evidence: ["c01.s0001"],
	status: "confirmed",
	supersededBy: null,
};
const relation = {
	key: "rel:a->b",
	from: "char:a",
	to: "char:b",
	stance: "合作",
	sinceChapter: 1,
	evidence: ["c01.s0001"],
	status: "confirmed",
};
const hook = { id: "H-1", type: "悬念", status: "open", startChapter: 1, lastAdvancedChapter: 1, dependsOn: [] };
const delta = {
	chapter: 1,
	basis,
	factOps: { upsert: [], expire: [], confirm: [] },
	claimOps: { add: [] },
	cognitionOps: { add: [], supersede: [], confirm: [] },
	relationOps: { upsert: [], confirm: [] },
	hookOps: { upsert: [], advance: [], mention: [], resolve: [], defer: [], supersede: [] },
	summary,
	issues: [],
};
const commit = {
	schema: "story/commit@1",
	chapter: 1,
	draftId: "c01-d01",
	draftDigest: "0123456789abcdef",
	text: "门开了。",
	sentenceRule: "s1",
	quality: "clean",
	basis,
	delta,
	summary,
	responses: [],
};
const proposal = {
	facts: [],
	claims: [],
	cognitions: [],
	relations: [],
	hooks: [],
	summary: { title: "启程", characters: [], events: [], mood: "平静" },
	issues: [],
};
export const samples: Record<keyof typeof schemas, unknown> = {
	Basis: basis,
	ModelFailure: { kind: "transport", httpStatus: 429, retryAfterMs: 2000 },
	Usage: {
		input: 1,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 3,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	CallRecord: {
		role: "writer",
		model: "fake",
		reservedInputTokens: 2050,
		reservedOutputTokens: 8192,
		reservedCostUsd: null,
		usage: null,
		status: "missing",
	},
	Fact: fact,
	Claim: { id: "S-1", speaker: "char:a", content: "门开了", chapter: 1, evidence: ["c01.s0001"] },
	Cognition: cognition,
	Relation: relation,
	Hook: hook,
	ChapterSummary: summary,
	StateDelta: delta,
	ConstraintsDetails: {
		schema: "story/constraints@1",
		rev: 1,
		op: "submit",
		items: [
			{
				id: "L-1",
				kind: "story",
				text: "启程",
				sourceSpans: [{ messageId: "author", quote: "启程", start: 0, end: 2 }],
			},
		],
	},
	BibleDetails: {
		schema: "story/bible@1",
		rev: 1,
		op: "submit",
		effectiveFromChapter: 1,
		changes: [{ kind: "character", key: "char:a", op: "set", card: { identity: "旅人" }, source: "model" }],
	},
	OutlineDetails: {
		schema: "story/outline@1",
		rev: 1,
		op: "submit",
		narration: { viewpoint: "第三人称", tone: "冷静" },
		chapters: [{ n: 1, title: "启程", targetWords: 100 }],
	},
	IntentDetails: {
		schema: "story/intent@1",
		chapter: 1,
		rev: 1,
		mustKeep: [],
		mustAvoid: [],
		beats: [],
		hookOps: [],
		cast: [],
		brief: "启程",
	},
	DraftDetails: {
		schema: "story/draft@1",
		draftId: "c01-d01",
		chapter: 1,
		author: "writer",
		text: "门开了。",
		digest: "0123456789abcdef",
		sentenceRule: "s1",
		basis,
		wordCount: { unit: "zh_chars", value: 3 },
		calls: [],
	},
	Observation: {
		id: "c01-r01-o01",
		by: "editor",
		category: "连贯",
		severity: "major",
		objective: true,
		evidence: { lines: [1] },
		impact: "门的位置矛盾",
		scope: "local",
	},
	CheckDetails: {
		schema: "story/check@1",
		checkId: "c01-p01",
		draftId: "c01-d01",
		draftDigest: "0123456789abcdef",
		observations: [],
	},
	ReviewDetails: {
		schema: "story/review@1",
		reviewId: "c01-r01",
		draftId: "c01-d01",
		draftDigest: "0123456789abcdef",
		basis,
		scope: "full",
		observations: [],
		calls: [],
	},
	ResponseDetails: {
		schema: "story/response@1",
		observationId: "c01-r01-o01",
		action: "accepted_risk",
		reason: "保留处理",
	},
	CommitRecord: commit,
	CommitDetails: { schema: "story/commit-result@1", ok: true, commit, calls: [] },
	MacroDetails: {
		schema: "story/macro-result@1",
		ok: true,
		revision: true,
		interjectionSeq: { atStart: 0, atCommit: 0 },
		steps: [],
		commit,
		calls: [],
	},
	ErrorDetails: {
		schema: "story/error@1",
		tool: "submit_bible",
		error: { code: "DOMAIN_INVALID", message: "字段无效" },
	},
	ProgressDetails: { schema: "story/progress@1", step: "draft" },
	ControlEntry: { schema: "story/control@1", field: "author_intent", rev: 1, text: "启程" },
	GoalEntry: { schema: "story/goal@1", targetChapter: 3, budget: { tokens: 100000 } },
	InterruptedEntry: {
		schema: "story/interrupted@1",
		toolCallId: "t1",
		toolName: "write_next_chapter",
		reservedTokens: 140000,
		note: "possible_duplicate",
	},
	StorySettingsEntry: {
		schema: "story/settings@1",
		level: "L1",
		roles: { writer: { model: "fake", temperature: 0.9 } },
	},
	ReviewOutput: { observations: [] },
	DeltaProposal: proposal,
};

for (const name of Object.keys(samples) as (keyof typeof schemas)[]) {
	test(`schema ${name}: explicit valid sample and invalid required field/version`, () => {
		expect(validate(schemas[name], samples[name])).toEqual({ ok: true, value: samples[name] });
		const bad = { ...(samples[name] as object), schema: "story/wrong@99" };
		expect(validate(schemas[name], bad).ok).toBe(false);
	});
}
test("D11: certainty is mandatory per operation, uncertain needs reason, error paths identify item", () => {
	const invalid = {
		...proposal,
		facts: [{ ref: "f1", op: "upsert", subject: "char:a", predicate: "alive", object: "alive", sentences: [1] }],
	};
	const result = validate(schemas.DeltaProposal, invalid);
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.errors.some((error) => error.path === "facts[0].certainty")).toBe(true);
	expect(
		validate(schemas.DeltaProposal, { ...invalid, facts: [{ ...invalid.facts[0], certainty: "uncertain" }] }).ok,
	).toBe(false);
	expect(
		validate(schemas.DeltaProposal, {
			...invalid,
			facts: [{ ...invalid.facts[0], certainty: "uncertain", uncertainReason: "视线不清" }],
		}).ok,
	).toBe(true);
	expect(validate(schemas.Fact, { ...fact, status: "provisional" }).ok).toBe(false);
});
test("role parsing: integer evidence, writer delimiter, exact patch shape", () => {
	expect(
		validate(schemas.DeltaProposal, {
			...proposal,
			claims: [{ ref: "s", speaker: "char:a", content: "是", sentences: [1.5] }],
		}).ok,
	).toBe(false);
	expect(parseWriter("门开了。\n<<<写手说明>>>\n保持悬念")).toEqual({ ok: true, text: "门开了。", note: "保持悬念" });
	expect(parseWriter("<<<写手说明>>>\n没有正文").ok).toBe(false);
	expect(parsePatches('[{"find":"门","replace":"窗"}]').ok).toBe(true);
	expect(parsePatches('[{"replace":"窗"}]').ok).toBe(false);
});

test("D11: cognition/relation certainty and v1.1 supersession targets", () => {
	const cognitions = [
		{ ref: "k", op: "add", characterId: "char:a", kind: "knows", content: "门开了", via: "witnessed", sentences: [1] },
	];
	const relations = [{ ref: "r", op: "upsert", key: "rel:a->b", stance: "合作", sentences: [1] }];
	expect(validate(schemas.DeltaProposal, { ...proposal, cognitions }).ok).toBe(false);
	expect(validate(schemas.DeltaProposal, { ...proposal, relations }).ok).toBe(false);
	expect(
		validate(schemas.DeltaProposal, {
			...proposal,
			cognitions: [{ ...cognitions[0], certainty: "confirmed" }],
			relations: [{ ...relations[0], certainty: "confirmed" }],
		}).ok,
	).toBe(true);
	expect(
		validate(schemas.DeltaProposal, { ...proposal, hooks: [{ ref: "h", id: "H-1", op: "supersede", sentences: [1] }] })
			.ok,
	).toBe(false);
	expect(validate(schemas.Usage, { ...(samples.Usage as object), cacheWrite1h: 0, reasoning: 1 }).ok).toBe(true);
});
