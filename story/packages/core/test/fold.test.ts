import { expect, test } from "vitest";
import { type BranchEntry, type FoldCache, foldBranch, stateAt } from "../src/fold/index.ts";
import { author, commitRecord, delta, tool } from "./fixtures.ts";

const failure = (entryId: string, code = "REVIEW_REQUIRED", message = "审稿不可用") =>
	tool(
		entryId,
		"write_next_chapter",
		{
			schema: "story/macro-result@1",
			ok: false,
			revision: true,
			interjectionSeq: { atStart: 0 },
			steps: [],
			calls: [],
			error: { code, message },
		},
		true,
	);
const bible = tool("bible", "submit_bible", {
	schema: "story/bible@1",
	rev: 1,
	op: "submit",
	effectiveFromChapter: 1,
	changes: [
		{
			kind: "relationBaseline",
			key: "rel:a->b",
			op: "set",
			source: "model",
			value: { from: "char:a", to: "char:b", stance: "陌生" },
		},
	],
});
const d1 = delta();
d1.factOps.upsert.push({
	id: "F-1",
	subject: "char:a",
	predicate: "location",
	object: "门外",
	validFrom: 1,
	validUntil: null,
	mode: "narrated",
	status: "confirmed",
	visibility: "public",
	evidence: ["c01.s0001"],
	sourceChapter: 1,
});
const d2 = delta(2);
d2.factOps.expire.push({ id: "F-1", validUntil: 1, evidence: ["c02.s0001"] });
d2.factOps.upsert.push({
	...d1.factOps.upsert[0],
	id: "F-2",
	object: "门内",
	validFrom: 2,
	sourceChapter: 2,
	evidence: ["c02.s0001"],
});
const entries: BranchEntry[] = [
	author(),
	bible,
	failure("failed"),
	tool("commit1", "write_next_chapter", {
		schema: "story/macro-result@1",
		ok: true,
		revision: true,
		interjectionSeq: { atStart: 0, atCommit: 0 },
		steps: [],
		calls: [],
		commit: commitRecord(1, d1),
	}),
	{
		kind: "custom",
		entryId: "intent",
		customType: "story.control",
		data: { schema: "story/control@1", field: "author_intent", rev: 1, text: "走进门内" },
	},
	tool("commit2", "commit_chapter", {
		schema: "story/commit-result@1",
		ok: true,
		commit: commitRecord(2, d2),
		calls: [],
	}),
];

test("I1 I5: deterministic fold from opening, failed chapter, two commits and author control", () => {
	const m = foldBranch(entries);
	expect({
		lastChapter: m.lastChapter,
		canonHead: m.canonHead,
		stateRev: m.stateRev,
		authorIntent: m.authorIntent,
		controlRev: m.controlRev,
		workspace: m.drafts,
		chapters: m.commits.map((c) => c.chapter),
	}).toEqual({
		lastChapter: 2,
		canonHead: "commit2",
		stateRev: 0,
		authorIntent: "走进门内",
		controlRev: 1,
		workspace: [],
		chapters: [1, 2],
	});
	expect(stateAt(m, 1).facts.map((f) => f.object)).toEqual(["门外"]);
	expect(stateAt(m, 2).facts.map((f) => f.object)).toEqual(["门内"]);
	expect(stateAt(m, 0).relations).toEqual([]);
	expect(stateAt(m, 1).relations[0]?.stance).toBe("陌生");
	expect(JSON.stringify(foldBranch(entries))).toBe(JSON.stringify(m));
});
test("fold cache: prefix + append, rollback, alternate branch and caller mutation isolation", () => {
	const cache: FoldCache = {};
	const first = foldBranch(entries.slice(0, 4), cache);
	expect(foldBranch(entries, cache)).toEqual(foldBranch(entries));
	expect(foldBranch(entries.slice(0, 3), cache).lastChapter).toBe(0);
	first.commits.length = 0;
	expect(foldBranch(entries.slice(0, 4), cache).lastChapter).toBe(1);
	const fork = [...entries.slice(0, 4), author("fork-author", "另一条路")];
	expect(foldBranch(fork, cache)).toEqual(foldBranch(fork));
});
test("I1: failed, foreign, bare commit and invalid schema never alter canon", () => {
	const commit = commitRecord();
	const m = foldBranch([
		tool("foreign", "bash", { schema: "story/commit-result@1", ok: true, commit, calls: [] }),
		tool("bare", "commit_chapter", commit),
		tool("failed", "commit_chapter", { schema: "story/commit-result@1", ok: true, commit, calls: [] }, true),
		tool("invalid", "commit_chapter", { schema: "story/commit-result@99", ok: true, commit, calls: [] }),
	]);
	expect(m.lastChapter).toBe(0);
	expect(m.commits).toEqual([]);
});
test("A3: failures count, budget/goal/self rejection excluded, new author resets", () => {
	const list = [
		failure("f1"),
		failure("budget", "BUDGET_EXHAUSTED"),
		failure("goal", "GOAL_REACHED"),
		failure("f2", "DOMAIN_INVALID"),
		failure("self", "DOMAIN_INVALID", "同一章连续两次未能提交，请先问作者"),
	];
	expect(foldBranch(list).failures[1]).toBe(2);
	expect(foldBranch([...list, author()]).failures[1]).toBe(0);
});
test("v1.0: successful macro's internal draft/review do not become a workspace", () => {
	const m = foldBranch(entries.slice(0, 4));
	expect(m.drafts).toEqual([]);
	expect(m.reviews).toEqual([]);
	expect(m.canonHead).toBe("commit1");
});

test("C1: control only comes from matching custom entry; failure usage remains audit data", () => {
	const control = { schema: "story/control@1", rev: 1, field: "author_intent", text: "外部不能改" };
	const failed = failure("missing-usage");
	if (failed.kind !== "toolResult") throw new Error("fixture");
	const details = failed.details as { calls: unknown[] };
	details.calls.push({
		role: "writer",
		model: "fake",
		reservedInputTokens: 2000,
		reservedOutputTokens: 8192,
		reservedCostUsd: null,
		usage: null,
		status: "missing",
	});
	const m = foldBranch([
		tool("fake-control", "submit_bible", control),
		{ kind: "custom", entryId: "wrong-custom", customType: "foreign.control", data: control },
		failed,
		tool(
			"error",
			"submit_bible",
			{ schema: "story/error@1", tool: "submit_bible", error: { code: "DOMAIN_INVALID", message: "无效设定" } },
			true,
		),
	]);
	expect(m.authorIntent).toBe("");
	expect(m.calls).toHaveLength(1);
	expect(m.events).toHaveLength(2);
	expect(m.events.every((event) => event.failed)).toBe(true);
});
