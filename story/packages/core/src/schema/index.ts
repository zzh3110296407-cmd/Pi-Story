/** biome-ignore-all lint/suspicious/noThenProperty: JSON Schema uses a non-callable then keyword for conditional validation. */
import { type Static, type TLiteral, type TProperties, type TSchema, Type } from "typebox";
import { Check, Errors } from "typebox/value";

const text = Type.String({ minLength: 1, pattern: "\\S" });
const strings = Type.Array(text);
const n = Type.Integer({ minimum: 0 });
const chapter = Type.Integer({ minimum: 1 });
const num = Type.Number({ minimum: 0 });
const literal = <const V extends string[]>(...values: V) =>
	Type.Union<{ [K in keyof V]: TLiteral<V[K]> }>(
		values.map((value) => Type.Literal(value)) as [...{ [K in keyof V]: TLiteral<V[K]> }],
	);
const obj = <P extends TProperties>(properties: P, options: Record<string, unknown> = {}) =>
	Type.Object(properties, { additionalProperties: false, ...options });
const optional = Type.Optional;
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const id = (prefix: string) => Type.String({ pattern: `^${prefix}-[1-9][0-9]*$` });
const sentenceRefs = Type.Array(Type.String({ pattern: "^c0*[1-9][0-9]*\\.s0*[1-9][0-9]*$" }), { minItems: 1 });
const evidenceNumbers = Type.Array(chapter, { minItems: 1 });
const digest = Type.String({ pattern: "^[0-9a-f]{16}$" });
const draftId = Type.String({ pattern: "^c0*[1-9][0-9]*-d0*[1-9][0-9]*$" });
const observationId = Type.String({ pattern: "^c0*[1-9][0-9]*-[pr]0*[1-9][0-9]*-o0*[1-9][0-9]*$" });
const mode = literal("narrated", "recalled_past");
const status = literal("confirmed", "provisional");
const role = literal("writer", "editor", "keeper", "verifier");
const severity = literal("blocking", "major", "minor");
const scope = literal("local", "structural", "unknown");
const action = literal("fixed", "refuted", "accepted_risk", "declined");
const cognitionKind = literal("knows", "believes", "suspects", "misbelieves");
const via = literal("witnessed", "told", "inferred", "read");
const visibility = literal("public", "restricted");
const object = Type.Union([text, obj({ value: Type.Number(), unit: text })]);
const relationKey = Type.String({ pattern: "^rel:[a-z0-9_]+->[a-z0-9_]+$" });
const conditional = (field: string, value: string, required: string[]) => ({
	if: { required: [field], properties: { [field]: { const: value } } },
	then: { required },
});
const provisional = { allOf: [conditional("status", "provisional", ["uncertainReason"])] };
const certainty = { certainty: optional(literal("confirmed", "uncertain")), uncertainReason: optional(text) };
const certaintyRules = (op: string) => ({
	allOf: [conditional("op", op, ["certainty"]), conditional("certainty", "uncertain", ["uncertainReason"])],
});

const Basis = obj({
	canonHead: nullable(text),
	controlRev: n,
	bibleRev: n,
	intentRev: n,
	stateRev: n,
	draftDigest: optional(digest),
});
const DomainError = obj({
	code: literal(
		"TRANSPORT_FAILURE",
		"PARSE_FAILURE",
		"SEMANTIC_GAP",
		"DOMAIN_INVALID",
		"STALE_OR_CONFLICT",
		"LITERARY_INVALID",
		"REVIEW_REQUIRED",
		"OBSERVATION_UNRESOLVED",
		"STATE_UNSUPPORTED",
		"BUDGET_EXHAUSTED",
		"NOT_IDLE",
		"INTERJECTED",
		"GOAL_REACHED",
	),
	message: text,
	items: optional(strings),
	hint: optional(text),
});
const Usage = obj({
	input: num,
	output: num,
	cacheRead: num,
	cacheWrite: num,
	cacheWrite1h: optional(num),
	reasoning: optional(num),
	totalTokens: num,
	cost: obj({ input: num, output: num, cacheRead: num, cacheWrite: num, total: num }),
});
const ModelFailure = obj({
	kind: literal("transport", "rejected", "fatal", "aborted"),
	httpStatus: optional(Type.Integer({ minimum: 400, maximum: 599 })),
	retryAfterMs: optional(num),
});
const CallRecord = obj({
	id: optional(text),
	retryOf: optional(text),
	failure: optional(ModelFailure),
	role,
	model: text,
	reservedInputTokens: n,
	reservedOutputTokens: n,
	reservedCostUsd: nullable(num),
	usage: nullable(Usage),
	status: literal("reported", "missing", "failed", "rejected"),
	// Optional only for decoding immutable pre-P2R history. New calls always supply it.
	inputSources: optional(
		obj({
			inputDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
			entries: Type.Array(obj({ type: text, entryId: text })),
		}),
	),
	rejection: optional(obj({ httpStatus: Type.Integer({ minimum: 400, maximum: 499 }) })),
	stopReason: optional(Type.String()),
	durationMs: optional(num),
});
const calls = Type.Array(CallRecord);
const AuthorQuote = obj({ messageId: text, quote: text });
const SourceSpan = obj({ messageId: text, quote: text, start: n, end: n });
const CharacterCard = obj({
	identity: optional(text),
	socialPosition: optional(text),
	drive: optional(text),
	psychology: optional(text),
	abilities: optional(text),
	limits: optional(text),
	voice: optional(text),
	embodiment: optional(text),
	secrets: optional(strings),
	arc: optional(text),
	invariants: optional(strings),
});
const BibleChange = obj(
	{
		kind: literal("rule", "place", "conflictLine", "frameworkChoice", "relationBaseline", "character"),
		key: text,
		op: literal("set", "remove"),
		value: optional(Type.Unknown()),
		card: optional(CharacterCard),
		source: literal("user", "model"),
		authorQuote: optional(AuthorQuote),
		name: optional(text),
	},
	{ allOf: [conditional("source", "user", ["authorQuote"])] },
);
const OutlineChapter = obj({
	n: chapter,
	title: optional(text),
	targetWords: optional(chapter),
	purpose: optional(text),
	turn: optional(text),
	hookSeeds: optional(strings),
	remove: optional(Type.Literal(true)),
});
const Narration = obj({ viewpoint: text, tone: text, format: optional(text) });
const Fact = obj(
	{
		id: id("F"),
		subject: text,
		predicate: text,
		object,
		validFrom: nullable(n),
		validUntil: nullable(n),
		mode,
		status,
		uncertainReason: optional(text),
		visibility,
		evidence: sentenceRefs,
		sourceChapter: chapter,
	},
	provisional,
);
const Claim = obj({ id: id("S"), speaker: text, content: text, chapter, evidence: sentenceRefs });
const Cognition = obj(
	{
		id: id("K"),
		characterId: text,
		kind: cognitionKind,
		content: text,
		about: nullable(text),
		acquiredChapter: n,
		via,
		evidence: sentenceRefs,
		status,
		uncertainReason: optional(text),
		supersededBy: nullable(text),
	},
	provisional,
);
const Relation = obj(
	{
		key: relationKey,
		from: text,
		to: text,
		stance: text,
		sinceChapter: n,
		evidence: Type.Array(Type.String({ pattern: "^c0*[1-9][0-9]*\\.s0*[1-9][0-9]*$" })),
		status,
		uncertainReason: optional(text),
	},
	provisional,
);
const Hook = obj({
	id: id("H"),
	type: text,
	status: literal("open", "progressing", "deferred", "resolved", "superseded"),
	startChapter: n,
	lastAdvancedChapter: n,
	expectedPayoff: optional(text),
	notes: optional(text),
	dependsOn: strings,
});
const ChapterSummary = obj({
	chapter,
	title: text,
	characters: strings,
	events: strings,
	stateChanges: strings,
	hookActivity: strings,
	mood: text,
});
const refEvidence = obj({ id: text, evidence: sentenceRefs });
const StateDelta = obj({
	chapter,
	basis: Basis,
	factOps: obj({
		upsert: Type.Array(Fact),
		expire: Type.Array(obj({ id: id("F"), validUntil: n, evidence: sentenceRefs })),
		confirm: Type.Array(refEvidence),
	}),
	claimOps: obj({ add: Type.Array(Claim) }),
	cognitionOps: obj({
		add: Type.Array(Cognition),
		supersede: Type.Array(obj({ id: id("K"), by: id("K") })),
		confirm: Type.Array(refEvidence),
	}),
	relationOps: obj({
		upsert: Type.Array(Relation),
		confirm: Type.Array(obj({ key: relationKey, evidence: sentenceRefs })),
	}),
	hookOps: obj({
		upsert: Type.Array(Hook),
		advance: Type.Array(refEvidence),
		mention: Type.Array(refEvidence),
		resolve: Type.Array(refEvidence),
		defer: Type.Array(refEvidence),
		supersede: Type.Array(obj({ id: id("H"), by: id("H"), evidence: sentenceRefs })),
	}),
	summary: ChapterSummary,
	issues: strings,
});
const ConstraintsDetails = obj({
	schema: Type.Literal("story/constraints@1"),
	rev: chapter,
	op: literal("submit", "append"),
	items: Type.Array(
		obj({
			id: id("L"),
			kind: literal("global", "story", "given_fact", "continuation_start", "ambiguity"),
			text,
			sourceSpans: Type.Array(SourceSpan, { minItems: 1 }),
		}),
	),
});
const BibleDetails = obj(
	{
		schema: Type.Literal("story/bible@1"),
		rev: chapter,
		op: literal("submit", "update"),
		reason: optional(text),
		effectiveFromChapter: chapter,
		changes: Type.Array(BibleChange),
	},
	{ allOf: [conditional("op", "update", ["reason"])] },
);
const OutlineDetails = obj(
	{
		schema: Type.Literal("story/outline@1"),
		rev: chapter,
		op: literal("submit", "patch"),
		reason: optional(text),
		narration: optional(Narration),
		chapters: Type.Array(OutlineChapter),
	},
	{ allOf: [conditional("op", "patch", ["reason"])] },
);
const IntentDetails = obj({
	schema: Type.Literal("story/intent@1"),
	chapter,
	rev: chapter,
	mustKeep: strings,
	mustAvoid: strings,
	beats: strings,
	hookOps: Type.Array(obj({ hookId: text, op: literal("advance", "resolve", "plant", "mention") })),
	cast: strings,
	brief: Type.String(),
});
const Patches = Type.Array(obj({ find: text, replace: Type.String() }), { minItems: 1 });
const DraftDetails = obj({
	schema: Type.Literal("story/draft@1"),
	draftId,
	chapter,
	parentDraftId: optional(draftId),
	author: literal("writer", "showrunner"),
	text,
	digest,
	sentenceRule: literal("s1", "s2"),
	patches: optional(Patches),
	reason: optional(text),
	basis: Basis,
	wordCount: obj({ unit: literal("en_words", "zh_chars"), value: n }),
	calls,
});
const Observation = obj({
	id: observationId,
	by: literal("editor", "check", "state_audit", "keeper"),
	category: text,
	severity,
	objective: Type.Boolean(),
	evidence: obj({ lines: Type.Array(chapter), stateRefs: optional(strings) }),
	impact: text,
	scope,
});
const CheckDetails = obj({
	schema: Type.Literal("story/check@1"),
	checkId: Type.String({ pattern: "^c0*[1-9][0-9]*-p0*[1-9][0-9]*$" }),
	draftId,
	draftDigest: digest,
	observations: Type.Array(Observation),
});
const Recheck = obj({ observationId, resolved: Type.Boolean(), note: optional(text) });
const ReviewDetails = obj({
	schema: Type.Literal("story/review@1"),
	reviewId: Type.String({ pattern: "^c0*[1-9][0-9]*-r0*[1-9][0-9]*$" }),
	draftId,
	draftDigest: digest,
	basis: Basis,
	scope: Type.Union([
		Type.Literal("full"),
		obj({
			spans: Type.Array(obj({ startLine: chapter, endLine: chapter })),
			forObservations: Type.Array(observationId),
		}),
	]),
	unavailable: optional(Type.Boolean()),
	observations: Type.Array(Observation),
	rechecks: optional(Type.Array(Recheck)),
	calls,
});
const ResponseDetails = obj({
	schema: Type.Literal("story/response@1"),
	observationId,
	action,
	reason: text,
	evidence: optional(obj({ lines: optional(Type.Array(chapter)), stateRefs: optional(strings) })),
	patchDraftId: optional(draftId),
	verifiedByReviewId: optional(text),
});
const CommitRecord = obj({
	schema: Type.Literal("story/commit@1"),
	chapter,
	draftId,
	draftDigest: digest,
	text,
	sentenceRule: literal("s1", "s2"),
	quality: literal("clean", "with_risk"),
	basis: Basis,
	delta: StateDelta,
	summary: ChapterSummary,
	responses: Type.Array(obj({ observationId, action: text })),
	// v1.1 type only; no verification command in P1.
	verification: optional(
		obj({
			checked: strings,
			removed: Type.Array(obj({ itemKey: text, reason: text })),
			downgraded: Type.Array(obj({ itemKey: text, from: text, to: text })),
			provisional: strings,
		}),
	),
});
const CommitDetails = obj(
	{
		schema: Type.Literal("story/commit-result@1"),
		ok: Type.Boolean(),
		error: optional(DomainError),
		commit: optional(CommitRecord),
		calls,
	},
	{ if: { properties: { ok: { const: true } } }, then: { required: ["commit"] }, else: { required: ["error"] } },
);
const MacroDetails = obj(
	{
		schema: Type.Literal("story/macro-result@1"),
		ok: Type.Boolean(),
		revision: Type.Boolean(),
		interjectionSeq: obj({ atStart: n, atCommit: optional(n) }),
		steps: Type.Array(
			obj({
				step: literal("intent", "draft", "check", "review", "patch", "recheck", "dispose", "commit"),
				ref: optional(text),
				ok: Type.Boolean(),
			}),
		),
		intent: optional(IntentDetails),
		drafts: optional(Type.Array(DraftDetails)),
		checks: optional(Type.Array(CheckDetails)),
		reviews: optional(Type.Array(ReviewDetails)),
		responses: optional(Type.Array(ResponseDetails)),
		commit: optional(CommitRecord),
		error: optional(DomainError),
		calls,
	},
	{ if: { properties: { ok: { const: true } } }, then: { required: ["commit"] }, else: { required: ["error"] } },
);
const ErrorDetails = obj({ schema: Type.Literal("story/error@1"), tool: text, error: DomainError });
const ProgressDetails = obj({ schema: Type.Literal("story/progress@1"), step: text });
const ControlEntry = obj({
	schema: Type.Literal("story/control@1"),
	field: literal("author_intent", "current_focus", "ledger_edit"),
	rev: chapter,
	text: optional(Type.String()),
	ledgerPatch: optional(
		Type.Array(
			obj({
				id: id("L"),
				op: literal("set", "remove"),
				text: optional(text),
				kind: optional(literal("global", "story", "given_fact", "continuation_start", "ambiguity")),
			}),
		),
	),
});
const GoalEntry = obj({
	schema: Type.Literal("story/goal@1"),
	targetChapter: optional(chapter),
	budget: optional(obj({ tokens: optional(num), costUsd: optional(num), perChapterCalls: optional(chapter) })),
});
const InterruptedEntry = obj({
	schema: Type.Literal("story/interrupted@1"),
	toolCallId: text,
	toolName: text,
	reservedTokens: n,
	reservedCostUsd: optional(nullable(num)),
	note: Type.Literal("possible_duplicate"),
});
// v1.1 type only. P1 uses settings passed by the adapter.
const StorySettingsEntry = obj({
	schema: Type.Literal("story/settings@1"),
	level: optional(literal("L0", "L1", "L2")),
	roles: optional(
		obj({
			writer: optional(obj({ model: text, thinking: optional(text), temperature: optional(Type.Number()) })),
			editor: optional(obj({ model: text, thinking: optional(text), temperature: optional(Type.Number()) })),
			keeper: optional(obj({ model: text, thinking: optional(text), temperature: optional(Type.Number()) })),
			verifier: optional(obj({ model: text, thinking: optional(text), temperature: optional(Type.Number()) })),
		}),
	),
});
const ReviewOutput = obj({
	observations: Type.Array(
		obj({
			category: text,
			severity,
			objective: Type.Boolean(),
			lines: Type.Array(chapter),
			stateRefs: optional(strings),
			impact: text,
			scope,
		}),
	),
	rechecks: optional(Type.Array(Recheck)),
});
const DeltaProposal = obj({
	facts: Type.Array(
		obj(
			{
				ref: text,
				op: literal("upsert", "expire", "confirm"),
				id: optional(text),
				subject: optional(text),
				predicate: optional(text),
				object: optional(object),
				change: optional(Type.Number()),
				mode: optional(mode),
				speaker: optional(text),
				validFrom: optional(nullable(n)),
				validUntil: optional(n),
				visibility: optional(visibility),
				...certainty,
				sentences: evidenceNumbers,
			},
			{
				allOf: [
					...certaintyRules("upsert").allOf,
					conditional("op", "upsert", ["subject", "predicate", "object"]),
					conditional("op", "expire", ["id", "validUntil"]),
					conditional("op", "confirm", ["id"]),
				],
			},
		),
	),
	claims: Type.Array(obj({ ref: text, speaker: text, content: text, sentences: evidenceNumbers })),
	cognitions: Type.Array(
		obj(
			{
				ref: text,
				op: literal("add", "supersede", "confirm"),
				id: optional(text),
				by: optional(text),
				characterId: text,
				kind: cognitionKind,
				content: text,
				about: optional(text),
				via,
				...certainty,
				sentences: evidenceNumbers,
			},
			{
				allOf: [
					...certaintyRules("add").allOf,
					conditional("op", "supersede", ["id", "by"]),
					conditional("op", "confirm", ["id"]),
				],
			},
		),
	),
	relations: Type.Array(
		obj(
			{
				ref: text,
				op: literal("upsert", "confirm"),
				key: relationKey,
				stance: optional(text),
				...certainty,
				sentences: evidenceNumbers,
			},
			{ allOf: [...certaintyRules("upsert").allOf, conditional("op", "upsert", ["stance"])] },
		),
	),
	hooks: Type.Array(
		obj(
			{
				ref: text,
				op: literal("upsert", "advance", "mention", "resolve", "defer", "supersede"),
				id: optional(text),
				by: optional(text),
				type: optional(text),
				expectedPayoff: optional(text),
				dependsOn: optional(strings),
				sentences: evidenceNumbers,
			},
			{ allOf: [conditional("op", "upsert", ["type"]), conditional("op", "supersede", ["id", "by"])] },
		),
	),
	summary: obj({ title: text, characters: strings, events: strings, mood: text }),
	issues: strings,
});

export { Patches as patchSchema };

export const schemas = {
	Basis,
	Usage,
	ModelFailure,
	CallRecord,
	Fact,
	Claim,
	Cognition,
	Relation,
	Hook,
	ChapterSummary,
	StateDelta,
	ConstraintsDetails,
	BibleDetails,
	OutlineDetails,
	IntentDetails,
	DraftDetails,
	Observation,
	CheckDetails,
	ReviewDetails,
	ResponseDetails,
	CommitRecord,
	CommitDetails,
	MacroDetails,
	ErrorDetails,
	ProgressDetails,
	ControlEntry,
	GoalEntry,
	InterruptedEntry,
	StorySettingsEntry,
	ReviewOutput,
	DeltaProposal,
};
export type Basis = Static<typeof Basis>;
export type Usage = Static<typeof Usage>;
export type ModelFailure = Static<typeof ModelFailure>;
export type CallRecord = Static<typeof CallRecord>;
export type Fact = Static<typeof Fact>;
export type Claim = Static<typeof Claim>;
export type Cognition = Static<typeof Cognition>;
export type Relation = Static<typeof Relation>;
export type Hook = Static<typeof Hook>;
export type ChapterSummary = Static<typeof ChapterSummary>;
export type StateDelta = Static<typeof StateDelta>;
export type ConstraintsDetails = Static<typeof ConstraintsDetails>;
export type BibleDetails = Static<typeof BibleDetails>;
export type BibleChange = Static<typeof BibleChange>;
export type OutlineDetails = Static<typeof OutlineDetails>;
export type IntentDetails = Static<typeof IntentDetails>;
export type DraftDetails = Static<typeof DraftDetails>;
export type Observation = Static<typeof Observation>;
export type CheckDetails = Static<typeof CheckDetails>;
export type ReviewDetails = Static<typeof ReviewDetails>;
export type ResponseDetails = Static<typeof ResponseDetails>;
export type CommitRecord = Static<typeof CommitRecord>;
export type CommitDetails = Static<typeof CommitDetails>;
export type MacroDetails = Static<typeof MacroDetails>;
export type ControlEntry = Static<typeof ControlEntry>;
export type GoalEntry = Static<typeof GoalEntry>;
export type InterruptedEntry = Static<typeof InterruptedEntry>;
export type StorySettingsEntry = Static<typeof StorySettingsEntry>;
export type ReviewOutput = Static<typeof ReviewOutput>;
export type DeltaProposal = Static<typeof DeltaProposal>;
export type Patch = Static<typeof Patches>[number];

export interface ValidationIssue {
	path: string;
	message: string;
}
interface SchemaNode {
	properties?: Record<string, SchemaNode>;
	items?: SchemaNode;
	allOf?: SchemaNode[];
	if?: SchemaNode;
	then?: SchemaNode;
	else?: SchemaNode;
	required?: string[];
}
// TypeBox localizes failed conditional schemas at the object. Add the missing-field
// paths from that same schema so JSON repair receives the actionable location.
function conditionalIssues(schema: SchemaNode, value: unknown, path: string): ValidationIssue[] {
	const result: ValidationIssue[] = [];
	if (value === null || typeof value !== "object") return result;
	const record = value as Record<string, unknown>;
	if (schema.if) {
		const branch = Check(schema.if as TSchema, value) ? schema.then : schema.else;
		for (const field of branch?.required ?? [])
			if (!(field in record)) result.push({ path: path ? `${path}.${field}` : field, message: "required" });
		if (branch) result.push(...conditionalIssues(branch, value, path));
	}
	for (const nested of schema.allOf ?? []) result.push(...conditionalIssues(nested, value, path));
	for (const [key, child] of Object.entries(schema.properties ?? {}))
		if (key in record) result.push(...conditionalIssues(child, record[key], path ? `${path}.${key}` : key));
	if (schema.items && Array.isArray(value))
		for (let i = 0; i < value.length; i++) result.push(...conditionalIssues(schema.items, value[i], `${path}[${i}]`));
	return result;
}
export function validate<T extends TSchema>(
	schema: T,
	value: unknown,
): { ok: true; value: Static<T> } | { ok: false; errors: ValidationIssue[] } {
	if (Check(schema, value)) return { ok: true, value };
	return {
		ok: false,
		errors: [
			...conditionalIssues(schema as SchemaNode, value, ""),
			...Errors(schema, value).flatMap((error) => {
				const base = error.instancePath
					.split("/")
					.slice(1)
					.map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"))
					.reduce(
						(result, part) => (/^\d+$/u.test(part) ? `${result}[${part}]` : result ? `${result}.${part}` : part),
						"",
					);
				return error.keyword === "required"
					? error.params.requiredProperties.map((field) => ({
							path: base ? `${base}.${field}` : field,
							message: "required",
						}))
					: [{ path: base || "$", message: error.message }];
			}),
		],
	};
}
export function parseWriter(
	raw: string,
): { ok: true; text: string; note: string } | { ok: false; errors: ValidationIssue[] } {
	const marker = "<<<写手说明>>>";
	const at = raw.indexOf(marker);
	const text = (at < 0 ? raw : raw.slice(0, at)).trim();
	return text
		? { ok: true, text, note: at < 0 ? "" : raw.slice(at + marker.length).trim() }
		: { ok: false, errors: [{ path: "text", message: "正文不能为空" }] };
}
export function parsePatches(raw: string) {
	try {
		return validate(Patches, JSON.parse(raw));
	} catch {
		return { ok: false as const, errors: [{ path: "$", message: "无效JSON" }] };
	}
}
