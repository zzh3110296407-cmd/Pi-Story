import type { BranchEntry } from "../src/fold/index.ts";
import type { Basis, CommitRecord, StateDelta } from "../src/schema/index.ts";
import { digest } from "../src/shared/text.ts";

export const basis = (change: Partial<Basis> = {}): Basis => ({
	canonHead: null,
	controlRev: 0,
	bibleRev: 0,
	intentRev: 0,
	stateRev: 0,
	...change,
});
export const delta = (chapter = 1): StateDelta => ({
	chapter,
	basis: basis(),
	factOps: { upsert: [], expire: [], confirm: [] },
	claimOps: { add: [] },
	cognitionOps: { add: [], supersede: [], confirm: [] },
	relationOps: { upsert: [], confirm: [] },
	hookOps: { upsert: [], advance: [], mention: [], resolve: [], defer: [], supersede: [] },
	summary: { chapter, title: "启程", characters: [], events: [], stateChanges: [], hookActivity: [], mood: "平静" },
	issues: [],
});
export const commitRecord = (chapter = 1, changes = delta(chapter)): CommitRecord => ({
	schema: "story/commit@1",
	chapter,
	draftId: `c${String(chapter).padStart(2, "0")}-d01`,
	draftDigest: digest("门开了。"),
	text: "门开了。",
	sentenceRule: "s1",
	quality: "clean",
	basis: basis(),
	delta: changes,
	summary: changes.summary,
	responses: [],
});
export const tool = (entryId: string, toolName: string, details: unknown, isError = false): BranchEntry => ({
	kind: "toolResult",
	entryId,
	toolName,
	details,
	isError,
});
export const author = (entryId = "author", text = "写一个旅人启程的故事，主角不能死亡。"): BranchEntry => ({
	kind: "authorMessage",
	entryId,
	text,
});
