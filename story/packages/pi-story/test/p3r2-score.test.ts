import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import type { HumanScore } from "../../../scripts/eval/p2/score.ts";
import { scoreScenarioBatches } from "../../../scripts/eval/p3/scenario-score.ts";
import { scoreBooks } from "../../../scripts/eval/p3/score.ts";
import { scoreV5Scenarios, type V5ScenarioBatch } from "../../../scripts/eval/p3r2/score.ts";
import { commitRecord } from "../../core/test/fixtures.ts";

function fixture() {
	const batches: V5ScenarioBatch[] = [1, 2].map((repetition) => ({
		runId: `run-${repetition}`,
		repetition,
		expected: Array.from({ length: 32 }, (_, i) => ({
			id: `case-${i}`,
			category: i === 0 ? "G_fixable_error" : "F_story_question",
		})),
		results: Array.from({ length: 32 }, (_, i) => ({
			id: `case-${i}`,
			status: "measured",
			firstAcceptable: true,
			forbidden: [],
			programChecks: [],
			judgeChecks: [],
			readOnlyCalls: 1,
		})),
	}));
	const judgments: HumanScore[] = batches.flatMap((batch) => [
		...batch.expected.map((sample) => ({
			runId: batch.runId,
			sampleId: sample.id,
			metric: "T02",
			component: "decision",
			pass: true,
			status: "author_approved" as const,
		})),
		{
			runId: batch.runId,
			sampleId: "case-0",
			metric: "T03",
			component: "recovery",
			pass: true,
			status: "author_approved" as const,
		},
	]);
	return { batches, judgments };
}

test("V5 cannot turn a read/request-bound failure into success and retains all 64 samples", () => {
	const { batches, judgments } = fixture();
	batches[0].results[0].readOnlyExceeded = true;
	const score = scoreV5Scenarios("SCEN", batches, judgments);
	expect(score.metrics.find((metric) => metric.id === "T02")).toMatchObject({
		n: 64,
		judged: 64,
		successes: 63,
		value: 63 / 64,
	});
	expect(score.metrics.find((metric) => metric.id === "T03")).toMatchObject({
		n: 2,
		successes: 1,
		minimum: 20,
		passed: null,
	});
	expect(judgments[0].pass).toBe(true);
	expect(scoreScenarioBatches("SCEN", batches, judgments).scoringVersion).toBe("p3-29@1");
	expect(score.scoringVersion).toBe("p3r2-32@1");
});

test("a missing BOOK next decision remains missing even if an unsupported success judgment is supplied", () => {
	const { batches, judgments } = fixture();
	judgments.push({
		runId: "book",
		sampleId: "interrupted",
		metric: "T03",
		component: "recovery",
		pass: true,
		status: "author_approved",
	});
	const result = scoreV5Scenarios("SCEN", batches, judgments, [
		{ runId: "book", sampleId: "interrupted", hasNextDecision: false },
	]);
	expect(result.metrics.find((metric) => metric.id === "T03")).toMatchObject({ n: 3, judged: 2, value: null });
	expect(result.missingBookRecoveries).toHaveLength(1);
});

test("an approved semantic judgment cannot override a decisive action outside the frozen acceptable set", () => {
	const { batches, judgments } = fixture();
	batches[0].results[0].firstAcceptable = false;
	expect(scoreV5Scenarios("SCEN", batches, judgments).metrics.find((metric) => metric.id === "T02")).toMatchObject({
		n: 64,
		successes: 63,
		value: 63 / 64,
	});
});

test("S03 excludes host deferral before the first real chapter attempt", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "Write one chapter.", timestamp: 0 });
	manager.appendCustomEntry("story.goal", { schema: "story/goal@1", targetChapter: 1 });
	for (const deferred of [true, false]) {
		const call = fauxToolCall("write_next_chapter", {});
		manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
		manager.appendMessage({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			isError: false,
			timestamp: 0,
			content: [{ type: "text", text: "result" }],
			details: deferred
				? { schema: "story/host-deferred@1", code: "AUTHOR_MESSAGE_PENDING" }
				: {
						schema: "story/macro-result@1",
						ok: true,
						revision: true,
						interjectionSeq: { atStart: 0 },
						steps: [],
						calls: [],
						commit: commitRecord(1),
					},
		});
	}
	const sample = {
		runId: "host-defer",
		entries: manager.getBranch(),
		target: 1,
		askedAuthor: false,
		extraAuthorPrompts: 0,
	};
	expect(scoreBooks([sample]).rows[0].chapters[0]).toMatchObject({ attempts: 1, committedOn: 1 });
});
