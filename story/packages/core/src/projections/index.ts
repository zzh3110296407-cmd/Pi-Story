import type { BibleItem, StoryModel } from "../fold/index.ts";
import { stateAt } from "../fold/index.ts";
import { checkCommitEligibility, unresolvedObservations } from "../production/index.ts";
import { type CommandResult, failure, success } from "../shared/result.ts";
import { digest, numberedLines, sentences, wordCount } from "../shared/text.ts";
import { type SessionUsage, type UsageSummary, usageSummary } from "../usage/index.ts";

export type ReadStoryQuery =
	| {
			section: "control" | "bible" | "plan" | "observations" | "decisions" | "hooks";
			chapter?: number;
			keys?: string[];
	  }
	| { kind: "chapter"; n: number; numbering?: "lines" | "sentences" }
	| {
			kind: "state";
			asOfChapter?: number;
			filter?: {
				subjects?: string[];
				kinds?: ("fact" | "claim" | "cognition" | "relation" | "hook")[];
				includeProvisional?: boolean;
			};
	  }
	| { kind: "character"; key: string; asOfChapter?: number };
export type ReadResult = CommandResult<{ text: string; data: unknown }>;

function bibleAt(m: StoryModel, asOfChapter: number): Record<string, BibleItem> {
	const result: Record<string, BibleItem> = {};
	for (const record of m.bibleHistory)
		if (record.effectiveFromChapter <= asOfChapter)
			for (const change of record.changes) {
				if (change.op === "remove") delete result[change.key];
				else result[change.key] = { ...structuredClone(change), effectiveFromChapter: record.effectiveFromChapter };
			}
	return result;
}
function evidenceText(m: StoryModel, refs: string[]): { ref: string; text: string }[] {
	return refs.map((ref) => {
		const chapter = Number(/^c([0-9]+)\.s/u.exec(ref)?.[1]);
		const commit = m.commits.find((item) => item.chapter === chapter);
		return {
			ref,
			text: commit
				? (sentences(commit.text, chapter, commit.sentenceRule).find((item) => item.id === ref)?.text ?? "")
				: "",
		};
	});
}
function readable(data: unknown, label: string): ReadResult {
	return success({ text: `${label}\n${JSON.stringify(data, null, 2)}`, data: structuredClone(data) });
}

export function readStory(m: StoryModel, query: ReadStoryQuery): ReadResult {
	if ("kind" in query) {
		if (query.kind === "chapter") {
			const commit = m.commits.find((item) => item.chapter === query.n);
			if (!commit) return failure("DOMAIN_INVALID", "已提交章节不存在", [String(query.n)]);
			const entries =
				query.numbering === "sentences"
					? sentences(commit.text, commit.chapter, commit.sentenceRule).map((item) => ({
							ref: item.id,
							text: item.text,
						}))
					: numberedLines(commit.text).map((line) => ({ ref: `L${line.n}`, text: line.text }));
			return success({
				data: { n: commit.chapter, title: commit.summary.title, quality: commit.quality, entries },
				text: entries.map((line) => `${line.ref} ${line.text}`).join("\n"),
			});
		}
		const chapter = query.asOfChapter ?? m.lastChapter;
		if (!Number.isInteger(chapter) || chapter < 0 || chapter > m.lastChapter)
			return failure("DOMAIN_INVALID", "回看章号超出当前正史", [String(chapter)]);
		const state = stateAt(m, chapter);
		if (query.kind === "character") {
			const card = bibleAt(m, Math.max(1, chapter))[query.key];
			if (!card || card.kind !== "character") return failure("DOMAIN_INVALID", "人物在指定章节尚不存在", [query.key]);
			const facts = state.facts.filter((item) => item.subject === query.key || item.object === query.key);
			const cognitions = state.cognitions.filter((item) => item.characterId === query.key);
			const relations = state.relations.filter((item) => item.from === query.key || item.to === query.key);
			const provisional = [...facts, ...cognitions, ...relations].filter((item) => item.status === "provisional");
			return readable(
				{
					key: query.key,
					asOfChapter: chapter,
					card,
					facts: facts.filter((item) => item.status === "confirmed"),
					cognitions: cognitions.filter((item) => item.status === "confirmed"),
					relations: relations.filter((item) => item.status === "confirmed"),
					未确认: provisional,
				},
				"人物资料（未确认条目单独列出）",
			);
		}
		const filter = query.filter;
		const wanted = new Set(filter?.subjects ?? []);
		const include = (kind: "fact" | "claim" | "cognition" | "relation" | "hook", subjects: string[]) =>
			(!filter?.kinds || filter.kinds.includes(kind)) &&
			(!wanted.size || subjects.some((subject) => wanted.has(subject)));
		const facts = state.facts.filter((item) => include("fact", [item.subject]));
		const cognitions = state.cognitions.filter((item) => include("cognition", [item.characterId]));
		const relations = state.relations.filter((item) => include("relation", [item.from, item.to]));
		const withEvidence = <T extends { evidence: string[] }>(item: T) => ({
			...item,
			evidenceText: evidenceText(m, item.evidence),
		});
		const provisional =
			filter?.includeProvisional === false
				? []
				: [...facts, ...cognitions, ...relations].filter((item) => item.status === "provisional").map(withEvidence);
		return readable(
			{
				asOfChapter: chapter,
				facts: facts.filter((item) => item.status === "confirmed").map(withEvidence),
				claims: state.claims.filter((item) => include("claim", [item.speaker])).map(withEvidence),
				cognitions: cognitions.filter((item) => item.status === "confirmed").map(withEvidence),
				relations: relations.filter((item) => item.status === "confirmed").map(withEvidence),
				hooks: state.hooks.filter((item) => include("hook", [item.id])),
				未确认: provisional,
			},
			"故事状态（未确认条目单独列出）",
		);
	}
	switch (query.section) {
		case "control":
			return readable(
				{ authorIntent: m.authorIntent, currentFocus: m.currentFocus, ledger: m.ledger },
				"作者控制与原话台账",
			);
		case "bible":
			return readable(
				Object.values(m.bible).filter((item) => !query.keys || query.keys.includes(item.key)),
				"故事圣经",
			);
		case "plan":
			return readable(
				{
					narration: m.narration,
					chapters: m.outline.filter((item) => query.chapter === undefined || query.chapter === item.n),
					intents: Object.values(m.intents).filter(
						(item) => query.chapter === undefined || query.chapter === item.chapter,
					),
				},
				"计划（不等同已发生事实）",
			);
		case "observations":
			return readable(
				m.observationHistory.filter((item) => query.chapter === undefined || item.chapter === query.chapter),
				"观察与处置记录",
			);
		case "decisions":
			return readable(
				m.events.filter((item) => item.reason || ["story.control", "story.goal"].includes(item.type)),
				"决策记录",
			);
		case "hooks":
			return readable(stateAt(m).hooks, "伏笔状态");
	}
}

export interface StoryView {
	leafId: string;
	progress: { lastChapter: number; targetChapter?: number; plannedChapters: number; level: "L0" | "L1" | "L2" };
	chapters: {
		n: number;
		title: string;
		quality: "clean" | "with_risk";
		wordCount: number;
		anchorEntryId: string;
		provisional: number;
		persisted: boolean;
	}[];
	characters: { key: string; name: string; alive?: "alive" | "dead" | "unknown"; provisionalCount: number }[];
	draft?: {
		chapter: number;
		draftId: string;
		wordCount: number;
		eligibility: { ok: boolean; firstFailure?: string; openObservations: number };
	};
	control: {
		authorIntent: string;
		currentFocus: string;
		ledger: { id: string; kind: string; text: string; fromAuthor: boolean }[];
	};
	bible: {
		characters: { key: string; name: string; source: "user" | "model" }[];
		places: { key: string; name: string }[];
		rules: number;
		conflictLines: number;
	};
	state: {
		hooks: { id: string; type: string; status: string; lastAdvancedChapter: number }[];
		provisional: { itemKey: string; text: string; chapter: number }[];
		risks: { chapter: number; observationIds: string[] }[];
	};
	usage: UsageSummary;
}
export function toStoryView(
	m: StoryModel,
	sessionUsage?: SessionUsage,
	options: { level?: "L0" | "L1" | "L2"; persisted?: ReadonlySet<string> } = {},
): StoryView {
	const state = stateAt(m);
	const bible = Object.values(m.bible);
	const provisional = [
		...state.facts
			.filter((item) => item.status === "provisional")
			.map((item) => ({
				itemKey: item.id,
				text: `${item.subject} ${item.predicate} ${typeof item.object === "object" ? `${item.object.value}${item.object.unit}` : item.object}`,
				chapter: item.sourceChapter,
			})),
		...state.cognitions
			.filter((item) => item.status === "provisional")
			.map((item) => ({ itemKey: item.id, text: item.content, chapter: item.acquiredChapter })),
		...state.relations
			.filter((item) => item.status === "provisional")
			.map((item) => ({ itemKey: item.key, text: item.stance, chapter: item.sinceChapter })),
	];
	const characters = bible
		.filter((item) => item.kind === "character")
		.map((item) => ({ key: item.key, name: item.name ?? item.key, source: item.source }));
	const draft = m.drafts.at(-1);
	const eligibility = draft ? checkCommitEligibility(m, draft.draftId) : undefined;
	return {
		leafId: m.leafEntryId ?? "",
		progress: {
			lastChapter: m.lastChapter,
			...(m.policy.targetChapter !== undefined ? { targetChapter: m.policy.targetChapter } : {}),
			plannedChapters: m.outline.length,
			level: options.level ?? "L1",
		},
		chapters: m.commits.map((commit) => ({
			n: commit.chapter,
			title: commit.summary.title,
			quality: commit.quality,
			wordCount: wordCount(commit.text).value,
			anchorEntryId: m.commitEntries[commit.chapter],
			provisional: provisional.filter((item) => item.chapter === commit.chapter).length,
			persisted: options.persisted?.has(m.commitEntries[commit.chapter]) ?? false,
		})),
		characters: characters.map((character) => {
			const alive = state.facts.find(
				(fact) => fact.subject === character.key && fact.predicate === "alive" && fact.status === "confirmed",
			);
			return {
				key: character.key,
				name: character.name,
				...(alive && ["alive", "dead", "unknown"].includes(String(alive.object))
					? { alive: alive.object as "alive" | "dead" | "unknown" }
					: {}),
				provisionalCount: [
					...state.facts.filter((item) => item.subject === character.key),
					...state.cognitions.filter((item) => item.characterId === character.key),
					...state.relations.filter((item) => item.from === character.key || item.to === character.key),
				].filter((item) => item.status === "provisional").length,
			};
		}),
		...(draft && eligibility
			? {
					draft: {
						chapter: draft.chapter,
						draftId: draft.draftId,
						wordCount: draft.wordCount.value,
						eligibility: {
							ok: eligibility.ok,
							...(!eligibility.ok ? { firstFailure: eligibility.error.code } : {}),
							openObservations: unresolvedObservations(m, draft).length,
						},
					},
				}
			: {}),
		control: {
			authorIntent: m.authorIntent,
			currentFocus: m.currentFocus,
			ledger: m.ledger.map((item) => ({ id: item.id, kind: item.kind, text: item.text, fromAuthor: true })),
		},
		bible: {
			characters,
			places: bible
				.filter((item) => item.kind === "place")
				.map((item) => ({ key: item.key, name: item.name ?? item.key })),
			rules: bible.filter((item) => item.kind === "rule").length,
			conflictLines: bible.filter((item) => item.kind === "conflictLine").length,
		},
		state: {
			hooks: state.hooks.map(({ id, type, status, lastAdvancedChapter }) => ({
				id,
				type,
				status,
				lastAdvancedChapter,
			})),
			provisional,
			risks: m.commits
				.filter((commit) => commit.quality === "with_risk")
				.map((commit) => ({
					chapter: commit.chapter,
					observationIds: commit.responses
						.filter((item) => item.action === "accepted_risk")
						.map((item) => item.observationId),
				})),
		},
		usage: usageSummary({
			calls: m.calls,
			interruptions: m.interruptions,
			budget: m.policy.budget,
			knownUsage: sessionUsage,
		}),
	};
}

export function toManuscript(m: StoryModel, options: { name?: string; includeDraft?: boolean } = {}): string {
	const sections = [
		`# ${options.name ?? "未命名故事"}`,
		...m.commits.map((commit) => `## 第 ${commit.chapter} 章 ${commit.summary.title}\n\n${commit.text}`),
	];
	const draft = m.drafts.at(-1);
	if (draft && options.includeDraft !== false)
		sections.push(
			`## 第 ${draft.chapter} 章 ${m.outline.find((chapter) => chapter.n === draft.chapter)?.title ?? ""}（草稿 ${draft.draftId}，未提交）\n\n${draft.text}`,
		);
	return `${sections.join("\n\n")}\n`;
}

export type ExportFormat = "md" | "txt" | "json";
export interface ExportFile {
	name: string;
	content: string;
}
export interface ExportContext {
	storyId?: string;
	name?: string;
	exportedAt?: string;
	packageVersion?: string;
}
function exportSafe(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(exportSafe);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(
					([key]) =>
						!/^(?:api[_-]?key|authorization|credentials?|password|access[_-]?token|refresh[_-]?token|system[_-]?prompt|prompt[_-]?templates?)$/iu.test(
							key,
						),
				)
				.map(([key, value]) => [key, exportSafe(value)]),
		);
	return value;
}
export function toExport(m: StoryModel, format: ExportFormat, metadata: ExportContext = {}): ExportFile[] {
	const files: ExportFile[] = [];
	if (format === "txt")
		files.push({
			name: "novel.txt",
			content: `${m.commits.map((commit) => `第 ${commit.chapter} 章 ${commit.summary.title}\n\n${commit.text}`).join("\n\n")}\n`,
		});
	else files.push({ name: "novel.md", content: toManuscript(m, { name: metadata.name, includeDraft: false }) });
	const data = exportSafe({
		schema: "story/export-data@1",
		authorIntent: m.authorIntent,
		currentFocus: m.currentFocus,
		ledger: m.ledger,
		bible: m.bible,
		narration: m.narration,
		outline: m.outline,
		state: stateAt(m),
		summaries: m.commits.map((commit) => commit.summary),
	});
	const serialized = `${JSON.stringify(data, null, 2)}\n`;
	files.push(
		{ name: "story-data.json", content: serialized },
		{ name: "story-data.md", content: ["# 故事资料", "", "```json", serialized.trimEnd(), "```", ""].join("\n") },
	);
	const manifest = {
		schema: "story/export-manifest@1",
		storyId: metadata.storyId ?? null,
		leafId: m.leafEntryId,
		exportedAt: metadata.exportedAt ?? null,
		sentenceRule: [...new Set(m.commits.map((commit) => commit.sentenceRule))],
		packageVersion: metadata.packageVersion ?? "0.0.0",
		digestRule: "LF UTF-8 SHA-256 first 16 hex",
		files: files.map((file) => ({ name: file.name, digest: digest(file.content) })),
	};
	files.push({ name: "manifest.json", content: `${JSON.stringify(manifest, null, 2)}\n` });
	return files;
}

export interface TreeNode {
	entryId: string;
	parentId: string | null;
	updatedAt?: string;
	current?: boolean;
}
export interface BranchSummary {
	leafId: string;
	current: boolean;
	lastChapter: number;
	forkedBeforeChapter?: number;
	updatedAt: string;
}
export function toBranchList(tree: TreeNode[], folds: (leafId: string) => StoryModel): BranchSummary[] {
	const byId = new Map(tree.map((node) => [node.entryId, node]));
	const parents = new Map<string, number>();
	for (const node of tree) if (node.parentId) parents.set(node.parentId, (parents.get(node.parentId) ?? 0) + 1);
	return tree
		.filter((node) => !parents.has(node.entryId))
		.map((leaf) => {
			let parent = leaf.parentId;
			let forkedBeforeChapter: number | undefined;
			const seen = new Set<string>();
			while (parent && !seen.has(parent)) {
				seen.add(parent);
				if ((parents.get(parent) ?? 0) > 1) {
					forkedBeforeChapter = folds(parent).lastChapter + 1;
					break;
				}
				parent = byId.get(parent)?.parentId ?? null;
			}
			return {
				leafId: leaf.entryId,
				current: leaf.current ?? false,
				lastChapter: folds(leaf.entryId).lastChapter,
				...(forkedBeforeChapter !== undefined ? { forkedBeforeChapter } : {}),
				updatedAt: leaf.updatedAt ?? "",
			};
		});
}
