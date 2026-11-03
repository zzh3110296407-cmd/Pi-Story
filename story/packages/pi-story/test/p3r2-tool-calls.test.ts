import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { scoreBooks } from "../../../scripts/eval/p3/score.ts";
import { decisiveRecoveries, measuredToolCalls, scoreToolCalls } from "../../../scripts/eval/p3r2/tool-calls.ts";

function addCall(
	manager: SessionManager,
	name: string,
	details: Extract<Parameters<SessionManager["appendMessage"]>[0], { role: "toolResult" }>["details"],
	isError = false,
) {
	const call = fauxToolCall(name, {});
	manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
	manager.appendMessage({
		role: "toolResult",
		toolCallId: call.id,
		toolName: name,
		content: [{ type: "text", text: "result" }],
		details,
		isError,
		timestamp: 0,
	});
}

test("T04 combines only real measurement calls, keeps host deferral separate and counts overlapping invalid reasons once", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "Prepare a story.", timestamp: 0 });
	addCall(manager, "read_story", { schema: "story/read@1", data: {} });
	const firstMeasuredIndex = manager.getBranch().length;
	addCall(manager, "read_state", { schema: "story/read@1", data: {} });
	addCall(manager, "read_state", { schema: "story/read@1", data: {} });
	addCall(manager, "write_next_chapter", { schema: "story/host-deferred@1", code: "AUTHOR_MESSAGE_PENDING" });
	addCall(
		manager,
		"write_next_chapter",
		{ schema: "story/error@1", error: { code: "INTERJECTED", message: "Interrupted by author" } },
		true,
	);
	addCall(
		manager,
		"disabled_tool",
		{ schema: "story/error@1", error: { code: "DOMAIN_INVALID", message: "Tool unavailable" } },
		true,
	);
	const sample = {
		runId: "scen",
		suite: "SCEN" as const,
		mode: "real" as const,
		entries: manager.getBranch(),
		firstMeasuredIndex,
	};
	const calls = measuredToolCalls(sample);
	expect(calls).toHaveLength(5);
	expect(calls.map((call) => call.repeated)).toEqual([false, true, false, false, false]);
	expect(calls[2]).toMatchObject({ hostDeferred: true, invalid: false });
	expect(calls[4].invalid).toBe(true);
	expect(measuredToolCalls({ ...sample, mode: "faux" })).toEqual([]);
	const books = measuredToolCalls({ ...sample, runId: "book", suite: "BOOK" });
	const all = [...calls, ...books];
	const judgments = all.map((call) => ({
		runId: call.runId,
		metric: "T04",
		component: "relevance",
		sampleId: call.sampleId,
		pass: !call.invalid,
		status: "author_approved" as const,
	}));
	const scored = scoreToolCalls(all, judgments);
	expect(scored.combined).toMatchObject({
		n: 10,
		invalid: 4,
		hostDeferred: 2,
		programInvalid: 4,
		pending: 0,
		value: 0.4,
		passed: null,
	});
	expect(scored.book).toMatchObject({ n: 5, invalid: 2, hostDeferred: 1 });
	expect(scoreToolCalls(all).combined.pending).toBe(4);
	const onlyUnclassified = judgments.filter((row) =>
		all.some(
			(call) =>
				call.runId === row.runId &&
				call.sampleId === row.sampleId &&
				!call.invalid &&
				!call.repeated &&
				!call.hostDeferred,
		),
	);
	expect(scoreToolCalls(all, onlyUnclassified).combined).toMatchObject({ invalid: 4, pending: 0, value: 0.4 });
});

test("a native author message changes the basis for otherwise identical calls", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "Read the state.", timestamp: 0 });
	addCall(manager, "read_state", { schema: "story/read@1", data: {} });
	manager.appendMessage({ role: "user", content: "Read it again for the current request.", timestamp: 1 });
	addCall(manager, "read_state", { schema: "story/read@1", data: {} });
	const calls = measuredToolCalls({
		runId: "one",
		suite: "E2E",
		mode: "real",
		entries: manager.getBranch(),
		firstMeasuredIndex: 0,
	});
	expect(calls[1].repeated).toBe(false);
});

test("host-deferred receipts never create S03 chapter attempts", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "Write a chapter after my next note.", timestamp: 0 });
	addCall(manager, "write_next_chapter", { schema: "story/host-deferred@1", code: "AUTHOR_MESSAGE_PENDING" });
	const result = scoreBooks([
		{ runId: "deferred", entries: manager.getBranch(), target: 1, askedAuthor: false, extraAuthorPrompts: 0 },
	]);
	expect(result.metrics.find((metric) => metric.id === "S03")).toMatchObject({ n: 0 });
});

test("T03 looks past preparatory reads and preserves a genuinely absent next decision", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "Resolve the failed action.", timestamp: 0 });
	addCall(
		manager,
		"disabled_tool",
		{ schema: "story/error@1", error: { code: "DOMAIN_INVALID", message: "Unavailable" } },
		true,
	);
	expect(decisiveRecoveries(manager.getBranch(), 0)[0]).toMatchObject({ next: null, status: "missing_next_decision" });
	addCall(manager, "read_state", { schema: "story/read@1", data: {} });
	manager.appendMessage(fauxAssistantMessage("I will stop and report the unavailable operation."));
	expect(decisiveRecoveries(manager.getBranch(), 0)[0]).toMatchObject({
		readOnlyCalls: 1,
		next: { reply: "I will stop and report the unavailable operation." },
		status: "pending_judgment",
	});
});
