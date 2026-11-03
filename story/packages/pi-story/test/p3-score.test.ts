import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { scoreEvidenceV3 } from "../../../scripts/eval/p2/score-v3.ts";
import { selectBookPrompts } from "../../../scripts/eval/p3/main.ts";
import { scoreBooks } from "../../../scripts/eval/p3/score.ts";
import { commitRecord } from "../../core/test/fixtures.ts";
import { createTestSession, draftText, keeperReply, openingCalls } from "./fixture.ts";

test("P3 selects two short development books by frozen rank and preserves all five formal books", () => {
	const prompts = [1, 2, 3, 4, 5].map((id) => ({ id, language: "en", task_type: "original", prompt: `Story ${id}` }));
	expect(selectBookPrompts(prompts, [3, 1, 2], true).map((prompt) => prompt.id)).toEqual([3, 1]);
	expect(selectBookPrompts(prompts, [5, 2, 3, 1, 4], false).map((prompt) => prompt.id)).toEqual([5, 2, 3, 1, 4]);
	expect(() => selectBookPrompts(prompts, [3, 1, 1], true)).toThrow();
});

function book() {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "A short story.", timestamp: 0 });
	manager.appendCustomEntry("story.goal", { schema: "story/goal@1", targetChapter: 3 });
	for (const chapter of [0, 1, 2, 3]) {
		const call = fauxToolCall("write_next_chapter", {});
		manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
		manager.appendMessage({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: "result" }],
			isError: chapter === 0,
			timestamp: 0,
			details: {
				schema: "story/macro-result@1",
				ok: chapter !== 0,
				revision: true,
				interjectionSeq: { atStart: 0 },
				steps: [],
				calls: [],
				...(chapter === 0
					? { error: { code: "PARSE_FAILURE", message: "No draft" } }
					: { commit: commitRecord(chapter) }),
			},
		});
	}
	return {
		runId: "fixture-book",
		entries: manager.getBranch(),
		target: 3,
		lastChapter: 3,
		askedAuthor: false,
		completed: true,
		stopMessages: [],
		extraAuthorPrompts: 0,
	};
}
test("P3 scores actual per-chapter attempts, never promotes a small successful sample to acceptance", () => {
	const result = scoreBooks([book()]);
	expect(result.metrics.find((m) => m.id === "S03")).toMatchObject({
		n: 3,
		first: { correct: 2, value: 2 / 3 },
		withinTwo: { correct: 3, value: 1 },
		passed: false,
		minimum: 40,
	});
	expect(result.metrics.find((m) => m.id === "T08")).toMatchObject({ n: 3, value: 1, passed: false, minimum: 20 });
	expect(result.metrics.find((m) => m.id === "S01")).toMatchObject({ n: 1, value: 1, passed: false, minimum: 5 });
	expect(result.pendingManual).toContain("T04-task-relevance");
});
test("P3 rejects duplicate book IDs and includes abandoned attempted chapters in S03", () => {
	const sample = book();
	expect(() => scoreBooks([sample, sample])).toThrow(/duplicate/iu);
	const abandoned = { ...sample, entries: sample.entries.slice(0, 4), lastChapter: 0, completed: false };
	const score = scoreBooks([abandoned]);
	expect(score.metrics.find((m) => m.id === "S03")).toMatchObject({
		n: 1,
		first: { correct: 0 },
		withinTwo: { correct: 0 },
	});
});

test("an unopened book remains an S01 failure without inventing a chapter target or attempted chapters", () => {
	const sample = book();
	const result = scoreBooks([{ ...sample, target: null, entries: sample.entries.slice(0, 1) }]);
	expect(result.metrics.find((metric) => metric.id === "S01")).toMatchObject({ n: 1, correct: 0, value: 0 });
	expect(result.metrics.find((metric) => metric.id === "S03")).toMatchObject({ n: 0 });
	expect(result.rows[0]).toMatchObject({ completed: false, target: null, unattemptedChapters: null });
});

test("a valid macro whose keeper fails domain validation is not an inevitably invalid showrunner call", async () => {
	const f = await createTestSession();
	try {
		f.faux.setResponses([
			fauxAssistantMessage(openingCalls(), { stopReason: "toolUse" }),
			fauxAssistantMessage("Opened."),
		]);
		await f.session.prompt("Ada must survive.");
		await f.session.prompt("/goal off");
		const invalid = { ...keeperReply, summary: { ...keeperReply.summary, characters: ["char:unknown"] } };
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write_next_chapter", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(draftText),
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(invalid)),
			fauxAssistantMessage(JSON.stringify(invalid)),
			fauxAssistantMessage("The keeper could not settle the chapter."),
		]);
		await f.session.prompt("Write the next chapter.");
		const macro = f.session.messages.findLast((message) => message.role === "toolResult");
		expect(macro).toMatchObject({ details: { error: { code: "DOMAIN_INVALID" }, intent: { chapter: 1 } } });
		const scored = scoreBooks([
			{ runId: "keeper-domain", entries: f.manager.getBranch(), target: 1, askedAuthor: false, extraAuthorPrompts: 0 },
		]);
		expect(scored.rows[0].toolCalls.find((call) => call.tool === "write_next_chapter")?.invalid).toBe(false);
	} finally {
		f.cleanup();
	}
});

test("T08 uses actual dispatch counts including native retries; T04 permits a new chapter with the same macro arguments", () => {
	const sample = book();
	const score = scoreBooks([
		{
			...sample,
			requestCounts: [
				{ chapter: 1, requests: 15 },
				{ chapter: 2, requests: 1 },
				{ chapter: 3, requests: 1 },
			],
		},
	]);
	const t08 = score.metrics.find((metric) => metric.id === "T08");
	expect(t08).toMatchObject({ value: 2 / 3, n: 3 });
	expect(score.rows[0].toolCalls.every((call) => !call.invalid && !call.repeated)).toBe(true);
	expect(score.rows[0].recoveries).toHaveLength(1);
	expect(() => scoreBooks([{ ...sample, requestCounts: [] }])).toThrow("Missing actual main request count");
});

test("T04 counts the union of program violations and independently judged irrelevance once", () => {
	const sample = book();
	const before = scoreBooks([sample]);
	const calls = before.rows[0].toolCalls;
	const judgments = calls.map((call) => ({
		runId: sample.runId,
		metric: "T04",
		component: "relevance",
		sampleId: call.id,
		pass: false,
		status: "author_approved" as const,
	}));
	const after = scoreBooks([sample], judgments).metrics.find((metric) => metric.id === "T04");
	expect(after).toMatchObject({ n: 4, invalid: 4, judged: 4, value: 1, passed: null });
	expect(() => scoreBooks([sample], [...judgments, judgments[0]])).toThrow("Duplicate task relevance judgment");
});

test("29's received-output denominator is opt-in and retains unknown attempts for accounting", () => {
	const records = [
		{ type: "meta", suiteId: "P2-CHAP", runId: "local", expectedCaseIds: ["local"] },
		{ type: "request", caseId: "local", role: "writer", model: "faux/script", contextWindow: 1_000_000 },
		...[fauxAssistantMessage("", { stopReason: "error" }), fauxAssistantMessage("A boat reached the pier.")].map(
			(response, i) => ({
				type: "role_call",
				caseId: "local",
				toolCallId: `draft-${i}`,
				request: {
					role: "writer",
					model: "faux/script",
					system: "Write",
					user: '{"task":"draft"}',
					output: { kind: "text" },
				},
				response,
				inputSources: [],
			}),
		),
	];
	const old = scoreEvidenceV3(records, []);
	const current = scoreEvidenceV3(records, [], false, { receivedOutputsOnly: true });
	expect(old.metrics.find((metric) => metric.id === "W01")).toMatchObject({ n: 2 });
	expect(current.metrics.find((metric) => metric.id === "W01")).toMatchObject({ n: 1 });
	expect(current.metrics.find((metric) => metric.id === "H12")).toEqual(
		old.metrics.find((metric) => metric.id === "H12"),
	);
});

test("P3 opening regression uses the ten-prompt minimum in 16 while preserving P2's frozen default", () => {
	const ids = Array.from({ length: 12 }, (_, i) => String(i));
	const records = [
		{ type: "meta", suiteId: "P2-OPEN", runId: "local", expectedCaseIds: ids },
		...ids.map((caseId) => ({
			type: "opening_result",
			caseId,
			model: { controlRev: 1, bibleRev: 1, outlineRev: 1 },
			attempts: { submit_constraints: 1, submit_bible: 1, submit_outline: 1 },
		})),
	];
	expect(scoreEvidenceV3(records, []).metrics.find((metric) => metric.id === "T05")).toMatchObject({
		n: 12,
		minimum: 24,
		passed: null,
	});
	expect(
		scoreEvidenceV3(records, [], false, { openingMinimum: 10 }).metrics.find((metric) => metric.id === "T05"),
	).toMatchObject({ n: 12, minimum: 10, passed: true });
});
