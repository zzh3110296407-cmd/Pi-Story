import { createHash } from "node:crypto";
import { type StoryModel, stateAt } from "../fold/index.ts";
import type { CallRecord, DraftDetails, Observation, ReviewDetails } from "../schema/index.ts";
import { numberedLines, sentences } from "../shared/text.ts";

// The trace records the replay dependencies of the supplied data families,
// including prior updates needed to derive their current state. No source text
// is copied into this metadata, and excluded input families have no references.
export function roleInputSources(m: StoryModel, system: string, user: string): NonNullable<CallRecord["inputSources"]> {
	let input: unknown;
	try {
		input = JSON.parse(user);
	} catch {
		input = {};
	}
	while (input !== null && typeof input === "object" && "originalInput" in input) input = input.originalInput;
	const data = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
	const types = new Set<string>();
	if ("bible" in data || "bibleKeys" in data || "state" in data) types.add("story/bible@1");
	if ("ledger" in data) types.add("story/constraints@1");
	if ("intent" in data || "narration" in data || "targetWords" in data) types.add("story/outline@1");
	if ("intent" in data) types.add("story/intent@1");
	if ("ledger" in data || "authorIntent" in data || "currentFocus" in data) types.add("story.control");
	if ("draft" in data) types.add("story/draft@1");
	if ("observations" in data) {
		types.add("story/check@1");
		types.add("story/review@1");
	}
	const commits = new Set("state" in data || "committed" in data ? Object.values(m.commitEntries) : []);
	const entries = m.events
		.filter((event) => !event.failed && (types.has(event.type) || commits.has(event.entryId)))
		.map(({ type, entryId }) => ({ type, entryId }));
	const messageIds = new Set<string>();
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) value.forEach(visit);
		else if (value !== null && typeof value === "object")
			for (const [key, child] of Object.entries(value)) {
				if (key === "messageId" && typeof child === "string") messageIds.add(child);
				else visit(child);
			}
	};
	visit(data.authorSources);
	visit(data.ledger);
	visit(data.bible);
	for (const message of m.authorMessages)
		if (messageIds.has(message.entryId)) entries.push({ type: "authorMessage", entryId: message.entryId });
	return { inputDigest: createHash("sha256").update(JSON.stringify({ system, user })).digest("hex"), entries };
}

function context(m: StoryModel, chapter: number) {
	return {
		chapter,
		targetWords: m.outline.find((entry) => entry.n === chapter)?.targetWords,
		intent: m.intents[chapter],
		bible: Object.values(m.bible).filter((item) => item.effectiveFromChapter <= chapter),
		state: stateAt(m),
		authorSources: [...new Set(m.ledger.flatMap((item) => item.sourceSpans.map((span) => span.messageId)))].map(
			(messageId) => ({
				messageId,
				sourceText: m.authorMessages.find((message) => message.entryId === messageId)?.text ?? null,
			}),
		),
		ledger: m.ledger.map((item) => ({
			id: item.id,
			kind: item.kind,
			text: item.text,
			authorQuotes: item.sourceSpans.map((span) => ({
				messageId: span.messageId,
				quote: span.quote,
			})),
			authority: item.authorEditEntryId
				? { kind: "author_command", entryId: item.authorEditEntryId }
				: { kind: "author_quotes", establishes: "source_only" },
		})),
		authorIntent: m.authorIntent,
		currentFocus: m.currentFocus,
	};
}
export function writerInput(m: StoryModel, brief?: string, factor: 0.8 | 0.9 | 1 = 1): unknown {
	const data = context(m, m.lastChapter + 1);
	const targetWords = data.targetWords === undefined ? undefined : Math.round(data.targetWords * factor);
	return {
		task: "draft",
		...data,
		...(targetWords === undefined
			? {}
			: {
					targetWords,
					wordRange: {
						min: Math.round((targetWords * 85) / 100),
						max: Math.round((targetWords * 115) / 100),
					},
				}),
		narration: m.narration,
		committed: m.commits.map((commit) => ({ chapter: commit.chapter, text: commit.text, summary: commit.summary })),
		brief: brief ?? "",
		format: { bodyThenSeparator: "<<<写手说明>>>", afterSeparator: "writer_note" },
	};
}
export function patchInput(m: StoryModel, draft: DraftDetails, observations: Observation[]): unknown {
	return {
		task: "patch",
		...context(m, draft.chapter),
		draft: { draftId: draft.draftId, text: draft.text, lines: numberedLines(draft.text) },
		observations,
		format: "find_replace_array",
	};
}
export function editorInput(
	m: StoryModel,
	draft: DraftDetails,
	scope: ReviewDetails["scope"],
	observations: Observation[] = [],
): unknown {
	return {
		task: scope === "full" ? "full_review" : "recheck",
		...context(m, draft.chapter),
		draft: { draftId: draft.draftId, digest: draft.digest, lines: numberedLines(draft.text) },
		scope,
		observations,
	};
}

export function keeperInput(m: StoryModel, draft: DraftDetails): unknown {
	const state = stateAt(m);
	const bibleKeys = new Map<string, { key: string; kind: string }>(
		Object.values(m.bible)
			.filter((item) => item.effectiveFromChapter <= draft.chapter)
			.map((item) => [item.key, { key: item.key, kind: item.kind }]),
	);
	const entityKinds: Record<string, string> = { char: "character", place: "place", item: "item", org: "organization" };
	const includeEntity = (key: unknown) => {
		if (typeof key !== "string") return;
		const match = /^(char|place|item|org):[a-z0-9_]+$/u.exec(key);
		if (match && !bibleKeys.has(key) && !(m.bible[key]?.effectiveFromChapter > draft.chapter))
			bibleKeys.set(key, { key, kind: entityKinds[match[1]] });
	};
	for (const fact of state.facts) {
		includeEntity(fact.subject);
		includeEntity(fact.object);
	}
	for (const claim of state.claims) includeEntity(claim.speaker);
	for (const cognition of state.cognitions) includeEntity(cognition.characterId);
	for (const relation of state.relations) {
		includeEntity(relation.from);
		includeEntity(relation.to);
	}
	const input = {
		task: "settle",
		chapter: draft.chapter,
		sentences: sentences(draft.text, draft.chapter, draft.sentenceRule).map((sentence, index) => ({
			n: index + 1,
			ref: sentence.id,
			text: sentence.text,
		})),
		state,
		openHooks: state.hooks
			.filter((hook) => !["resolved", "superseded"].includes(hook.status))
			.map((hook) => ({
				id: hook.id,
				type: hook.type,
				summary: hook.expectedPayoff ?? hook.notes ?? hook.type,
				startChapter: hook.startChapter,
				lastAdvancedChapter: hook.lastAdvancedChapter,
			})),
		bibleKeys: [...bibleKeys.values()],
		predicates: ["alive", "identity", "true_identity", "holder", "location", "quantity:<name>", "free_predicate"],
	};
	// D10: assert the structural boundary, without scanning story text for innocent words like "intent".
	const assert = (value: unknown): void => {
		if (Array.isArray(value)) value.forEach(assert);
		else if (value !== null && typeof value === "object")
			for (const [key, child] of Object.entries(value)) {
				if (["outline", "intent", "chapterIntent", "authorIntent", "currentFocus", "ledger", "brief"].includes(key))
					throw new Error(`Forbidden keeper input field: ${key}`);
				assert(child);
			}
	};
	assert(input);
	return input;
}
