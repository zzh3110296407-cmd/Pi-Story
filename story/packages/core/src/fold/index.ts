import type { Static, TSchema } from "typebox";
import {
	type BibleChange,
	type BibleDetails,
	type CallRecord,
	type CheckDetails,
	type Claim,
	type Cognition,
	type CommitRecord,
	type ConstraintsDetails,
	type DraftDetails,
	type Fact,
	type GoalEntry,
	type Hook,
	type IntentDetails,
	type InterruptedEntry,
	type Observation,
	type OutlineDetails,
	type Relation,
	type ResponseDetails,
	type ReviewDetails,
	type StateDelta,
	schemas,
	validate,
} from "../schema/index.ts";

export type BranchEntry =
	| { kind: "toolResult"; entryId: string; toolName: string; isError: boolean; details: unknown }
	| { kind: "custom"; entryId: string; customType: string; data: unknown }
	| { kind: "authorMessage"; entryId: string; text: string };
export interface BibleItem extends BibleChange {
	effectiveFromChapter: number;
}
export interface StoryState {
	asOfChapter: number;
	facts: Fact[];
	claims: Claim[];
	cognitions: Cognition[];
	relations: Relation[];
	hooks: Hook[];
}
export interface StoryModel {
	leafEntryId: string | null;
	canonHead: string | null;
	stateRev: number;
	lastChapter: number;
	controlRev: number;
	authorIntent: string;
	currentFocus: string;
	ledger: (ConstraintsDetails["items"][number] & { authorEditEntryId?: string })[];
	ledgerSequence: number;
	policy: Omit<GoalEntry, "schema">;
	bibleRev: number;
	bible: Record<string, BibleItem>;
	bibleHistory: BibleDetails[];
	bibleRefs: string[];
	outlineRev: number;
	outline: OutlineDetails["chapters"];
	narration?: OutlineDetails["narration"];
	intents: Record<number, IntentDetails>;
	drafts: DraftDetails[];
	checks: CheckDetails[];
	reviews: ReviewDetails[];
	responses: ResponseDetails[];
	sequences: Record<string, number>;
	commits: CommitRecord[];
	commitEntries: Record<number, string>;
	observationHistory: { entryId: string; chapter: number; observations: Observation[]; responses: ResponseDetails[] }[];
	calls: CallRecord[];
	interruptions: InterruptedEntry[];
	failures: Record<number, number>;
	authorMessages: { entryId: string; text: string }[];
	events: { entryId: string; type: string; summary: string; reason?: string; failed?: boolean }[];
}
export interface FoldCache {
	ids?: string[];
	fingerprints?: string[];
	snapshots?: StoryModel[];
}

export function emptyModel(): StoryModel {
	return {
		leafEntryId: null,
		canonHead: null,
		stateRev: 0,
		lastChapter: 0,
		controlRev: 0,
		authorIntent: "",
		currentFocus: "",
		ledger: [],
		ledgerSequence: 0,
		policy: {},
		bibleRev: 0,
		bible: {},
		bibleHistory: [],
		bibleRefs: [],
		outlineRev: 0,
		outline: [],
		intents: {},
		drafts: [],
		checks: [],
		reviews: [],
		responses: [],
		sequences: {},
		commits: [],
		commitEntries: {},
		observationHistory: [],
		calls: [],
		interruptions: [],
		failures: {},
		authorMessages: [],
		events: [],
	};
}

function applyCommit(m: StoryModel, commit: CommitRecord, entryId: string) {
	// I1/I5: the command owns validation; folding never rejects a saved commit for a later basis change.
	m.commits.push(commit);
	m.commitEntries[commit.chapter] = entryId;
	m.canonHead = entryId;
	m.lastChapter = commit.chapter;
	m.drafts = [];
	m.checks = [];
	m.reviews = [];
	m.responses = [];
	m.failures[commit.chapter] = 0;
	const references = new Set(m.bibleRefs);
	const scan = (value: unknown) => {
		if (typeof value === "string" && value in m.bible) references.add(value);
		else if (Array.isArray(value)) value.forEach(scan);
		else if (value !== null && typeof value === "object") Object.values(value).forEach(scan);
	};
	scan(commit.delta);
	m.bibleRefs = [...references].sort();
}

function rememberSequences(m: StoryModel, value: unknown): void {
	if (value === null || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	for (const field of ["draftId", "checkId", "reviewId"]) {
		const id = record[field];
		const match = typeof id === "string" ? /^(c[0-9]+-[dpr])([0-9]+)$/u.exec(id) : null;
		if (match) m.sequences[match[1]] = Math.max(m.sequences[match[1]] ?? 0, Number(match[2]));
	}
	for (const field of ["drafts", "checks", "reviews"])
		if (Array.isArray(record[field])) for (const nested of record[field]) rememberSequences(m, nested);
}

function rememberObservations(m: StoryModel, value: unknown, entryId: string): void {
	const data = value as Record<string, unknown>;
	const groups = [
		...(Array.isArray(data.checks) ? data.checks : []),
		...(Array.isArray(data.reviews) ? data.reviews : []),
	] as (CheckDetails | ReviewDetails)[];
	const observations = [
		...(Array.isArray(data.observations) ? (data.observations as Observation[]) : []),
		...groups.flatMap((group) => group.observations),
	];
	const responses =
		data.schema === "story/response@1"
			? [data as unknown as ResponseDetails]
			: Array.isArray(data.responses)
				? (data.responses as ResponseDetails[])
				: [];
	const chapter = Number(
		(typeof data.draftId === "string"
			? data.draftId
			: (observations[0]?.id ?? responses[0]?.observationId ?? "")
		).match(/^c([0-9]+)/u)?.[1],
	);
	if (chapter && (observations.length || responses.length))
		m.observationHistory.push({ entryId, chapter, observations, responses });
}

function toolReducer<T extends TSchema>(
	schema: T,
	tools: string[],
	apply: (m: StoryModel, value: Static<T>, entryId: string) => void,
) {
	return (m: StoryModel, entry: Extract<BranchEntry, { kind: "toolResult" }>): boolean => {
		if (!tools.includes(entry.toolName)) return false;
		const checked = validate(schema, entry.details);
		if (!checked.ok) return false;
		const value = structuredClone(checked.value);
		rememberSequences(m, value);
		rememberObservations(m, value, entry.entryId);
		const failed = entry.isError || ("ok" in value && value.ok === false);
		if ("calls" in value && Array.isArray(value.calls)) m.calls.push(...(value.calls as CallRecord[]));
		const reason = "reason" in value && typeof value.reason === "string" ? value.reason : undefined;
		m.events.push({ entryId: entry.entryId, type: String(value.schema), summary: entry.toolName, reason, failed });
		if (!failed) apply(m, value, entry.entryId);
		else if (entry.toolName === "write_next_chapter") {
			const error = "error" in value ? (value as { error?: { code: string; message: string } }).error : undefined;
			// A3: budget, goal and this stopping rule do not increment the failure streak.
			if (
				error &&
				!["GOAL_REACHED", "BUDGET_EXHAUSTED"].includes(error.code) &&
				error.message !== "同一章连续两次未能提交，请先问作者"
			)
				m.failures[m.lastChapter + 1] = (m.failures[m.lastChapter + 1] ?? 0) + 1;
		}
		return true;
	};
}

const reducers = [
	toolReducer(
		schemas.ErrorDetails,
		[
			"submit_constraints",
			"submit_bible",
			"update_bible",
			"submit_outline",
			"patch_outline",
			"set_chapter_intent",
			"write_draft",
			"patch_draft",
			"check_draft",
			"review_draft",
			"respond_observation",
			"read_story",
			"read_chapter",
			"read_state",
			"get_character",
			"ask_author",
		],
		() => {},
	),
	toolReducer(schemas.ConstraintsDetails, ["submit_constraints"], (m, value) => {
		m.ledger = value.op === "submit" ? value.items : [...m.ledger, ...value.items];
		m.controlRev = value.rev;
		m.ledgerSequence = Math.max(m.ledgerSequence, ...value.items.map((item) => Number(item.id.slice(2))));
	}),
	toolReducer(schemas.BibleDetails, ["submit_bible", "update_bible"], (m, value) => {
		if (value.op === "submit") m.bible = {};
		for (const change of value.changes) {
			if (change.op === "remove") delete m.bible[change.key];
			else m.bible[change.key] = { ...change, effectiveFromChapter: value.effectiveFromChapter };
		}
		m.bibleHistory.push(value);
		m.bibleRev = value.rev;
	}),
	toolReducer(schemas.OutlineDetails, ["submit_outline", "patch_outline"], (m, value) => {
		if (value.op === "submit") m.outline = [];
		for (const change of value.chapters) {
			const index = m.outline.findIndex((item) => item.n === change.n);
			if (change.remove) m.outline = m.outline.filter((item) => item.n !== change.n);
			else if (index >= 0) m.outline[index] = { ...m.outline[index], ...change };
			else m.outline.push(change);
		}
		m.outline.sort((a, b) => a.n - b.n);
		if (value.narration) m.narration = value.narration;
		m.outlineRev = value.rev;
	}),
	toolReducer(schemas.IntentDetails, ["set_chapter_intent"], (m, value) => {
		m.intents[value.chapter] = value;
	}),
	toolReducer(schemas.DraftDetails, ["write_draft", "patch_draft"], (m, value) => {
		m.drafts.push(value);
	}),
	toolReducer(schemas.CheckDetails, ["check_draft"], (m, value) => {
		m.checks.push(value);
	}),
	toolReducer(schemas.ReviewDetails, ["review_draft"], (m, value) => {
		m.reviews.push(value);
	}),
	toolReducer(schemas.ResponseDetails, ["respond_observation"], (m, value) => {
		m.responses.push(value);
	}),
	toolReducer(schemas.CommitDetails, ["commit_chapter"], (m, value, entryId) => {
		if (value.commit) applyCommit(m, value.commit, entryId);
	}),
	toolReducer(schemas.MacroDetails, ["write_next_chapter"], (m, value, entryId) => {
		// v1.0 macro internals are audit data, never a reusable workspace.
		if (value.intent) m.intents[value.intent.chapter] = value.intent;
		if (value.commit) applyCommit(m, value.commit, entryId);
	}),
];

function custom(m: StoryModel, entry: Extract<BranchEntry, { kind: "custom" }>) {
	if (entry.customType === "story.control") {
		const result = validate(schemas.ControlEntry, entry.data);
		if (!result.ok) return;
		const data = result.value;
		if (data.field === "author_intent") m.authorIntent = data.text ?? "";
		if (data.field === "current_focus") m.currentFocus = data.text ?? "";
		if (data.field === "ledger_edit")
			for (const patch of data.ledgerPatch ?? []) {
				const index = m.ledger.findIndex((item) => item.id === patch.id);
				if (patch.op === "remove") m.ledger = m.ledger.filter((item) => item.id !== patch.id);
				else if (index >= 0 && patch.text !== undefined)
					// The latest author command replaces both the explanation and its authority.
					// Original message quotes remain in the historical constraints entry only.
					m.ledger[index] = {
						...m.ledger[index],
						text: patch.text,
						kind: patch.kind ?? m.ledger[index].kind,
						sourceSpans: [],
						authorEditEntryId: entry.entryId,
					};
				else if (patch.text !== undefined)
					m.ledger.push({
						id: patch.id,
						kind: patch.kind ?? "story",
						text: patch.text,
						sourceSpans: [],
						authorEditEntryId: entry.entryId,
					});
				m.ledgerSequence = Math.max(m.ledgerSequence, Number(patch.id.slice(2)));
			}
		m.controlRev = data.rev;
		m.events.push({
			entryId: entry.entryId,
			type: "story.control",
			summary: data.text ?? JSON.stringify(data.ledgerPatch),
		});
	} else if (entry.customType === "story.goal") {
		const result = validate(schemas.GoalEntry, entry.data);
		if (!result.ok) return;
		const { schema: _schema, ...data } = result.value;
		m.policy = data;
		m.events.push({ entryId: entry.entryId, type: "story.goal", summary: JSON.stringify(data) });
	} else if (entry.customType === "story.interrupted") {
		const result = validate(schemas.InterruptedEntry, entry.data);
		if (result.ok && !m.interruptions.some((item) => item.toolCallId === result.value.toolCallId))
			m.interruptions.push(structuredClone(result.value));
	}
	// story.settings is a v1.1 type only.
}

export function foldBranch(entries: readonly BranchEntry[], cache?: FoldCache): StoryModel {
	const fingerprints = entries.map((entry) => JSON.stringify(entry));
	let common = 0;
	while (
		common < entries.length &&
		cache?.ids?.[common] === entries[common].entryId &&
		cache.fingerprints?.[common] === fingerprints[common]
	)
		common++;
	const m = common && cache?.snapshots?.[common - 1] ? structuredClone(cache.snapshots[common - 1]) : emptyModel();
	if (!cache?.snapshots?.[common - 1]) common = 0;
	const snapshots = cache?.snapshots?.slice(0, common) ?? [];
	for (let i = common; i < entries.length; i++) {
		const entry = entries[i];
		m.leafEntryId = entry.entryId;
		if (entry.kind === "authorMessage") {
			m.authorMessages.push({ entryId: entry.entryId, text: entry.text });
			m.failures[m.lastChapter + 1] = 0;
		} else if (entry.kind === "custom") custom(m, entry);
		else for (const reduce of reducers) if (reduce(m, entry)) break;
		if (cache) snapshots.push(structuredClone(m));
	}
	if (cache) {
		cache.ids = entries.map((entry) => entry.entryId);
		cache.fingerprints = fingerprints;
		cache.snapshots = snapshots;
	}
	return m;
}

// A fresh replay supplies historical confirmation/relation/hook state as well as fact validity.
export function stateAt(m: StoryModel, asOfChapter = m.lastChapter): StoryState {
	const state: StoryState = { asOfChapter, facts: [], claims: [], cognitions: [], relations: [], hooks: [] };
	for (const record of m.bibleHistory)
		if (record.effectiveFromChapter <= asOfChapter)
			for (const change of record.changes) {
				if (change.kind !== "relationBaseline") continue;
				const value = change.value;
				if (change.op === "remove") {
					state.relations = state.relations.filter((item) => item.key !== change.key);
					continue;
				}
				if (value && typeof value === "object" && "stance" in value && typeof value.stance === "string") {
					const [from, to] = change.key.slice(4).split("->");
					state.relations = state.relations.filter((item) => item.key !== change.key);
					state.relations.push({
						key: change.key,
						from: `char:${from}`,
						to: `char:${to}`,
						stance: value.stance,
						sinceChapter: record.effectiveFromChapter,
						evidence: [],
						status: "confirmed",
					});
				}
			}
	for (const commit of m.commits) if (commit.chapter <= asOfChapter) applyDelta(state, structuredClone(commit.delta));
	state.facts = state.facts.filter(
		(item) =>
			(item.validFrom === null || item.validFrom <= asOfChapter) &&
			(item.validUntil === null || item.validUntil >= asOfChapter),
	);
	state.claims = state.claims.filter((item) => item.chapter <= asOfChapter);
	state.cognitions = state.cognitions.filter(
		(item) => item.acquiredChapter <= asOfChapter && item.supersededBy === null,
	);
	return state;
}

function applyDelta(state: StoryState, delta: StateDelta) {
	for (const item of delta.factOps.upsert) {
		state.facts = state.facts.filter((old) => old.id !== item.id);
		state.facts.push(item);
	}
	for (const op of delta.factOps.expire) {
		const item = state.facts.find((item) => item.id === op.id);
		if (item) item.validUntil = op.validUntil;
	}
	for (const op of delta.factOps.confirm) {
		const item = state.facts.find((item) => item.id === op.id);
		if (item) {
			item.status = "confirmed";
			delete item.uncertainReason;
			item.evidence.push(...op.evidence);
		}
	}
	state.claims.push(...delta.claimOps.add);
	state.cognitions.push(...delta.cognitionOps.add);
	for (const op of delta.cognitionOps.supersede) {
		const item = state.cognitions.find((item) => item.id === op.id);
		if (item) item.supersededBy = op.by;
	}
	for (const op of delta.cognitionOps.confirm) {
		const item = state.cognitions.find((item) => item.id === op.id);
		if (item) {
			item.status = "confirmed";
			delete item.uncertainReason;
			item.evidence.push(...op.evidence);
		}
	}
	for (const item of delta.relationOps.upsert) {
		state.relations = state.relations.filter((old) => old.key !== item.key);
		state.relations.push(item);
	}
	for (const op of delta.relationOps.confirm) {
		const item = state.relations.find((item) => item.key === op.key);
		if (item) {
			item.status = "confirmed";
			delete item.uncertainReason;
			item.evidence.push(...op.evidence);
		}
	}
	for (const item of delta.hookOps.upsert) {
		state.hooks = state.hooks.filter((old) => old.id !== item.id);
		state.hooks.push(item);
	}
	for (const op of delta.hookOps.advance) {
		const item = state.hooks.find((item) => item.id === op.id);
		if (item) {
			item.status = "progressing";
			item.lastAdvancedChapter = delta.chapter;
		}
	}
	for (const op of delta.hookOps.resolve) {
		const item = state.hooks.find((item) => item.id === op.id);
		if (item) item.status = "resolved";
	}
	for (const op of delta.hookOps.defer) {
		const item = state.hooks.find((item) => item.id === op.id);
		if (item) item.status = "deferred";
	}
	for (const op of delta.hookOps.supersede) {
		const item = state.hooks.find((item) => item.id === op.id);
		if (item) item.status = "superseded";
	}
	// D8: mentions are audit only; they never alter hook status or advancement.
}
