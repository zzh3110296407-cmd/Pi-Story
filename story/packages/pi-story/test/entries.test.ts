import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { foldBranch } from "@pi-story/core";
import { expect, test } from "vitest";
import { BatchTracker, BranchSource, toToolResult, translateBranch } from "../src/entries.ts";
import { createTestSession } from "./fixture.ts";

test("faux-generated author entries and saved Story entries fold identically through the adapter", async () => {
	const fixture = await createTestSession();
	try {
		fixture.faux.setResponses([fauxAssistantMessage("Ready.")]);
		await fixture.session.prompt("The hero must survive.");
		const source = new BranchSource(() => fixture.manager.getBranch());
		const author = source.branch().find((entry) => entry.kind === "authorMessage");
		if (!author || author.kind !== "authorMessage") throw new Error("Missing production user entry");
		expect(source.authorMessage(author.entryId)).toBe("The hero must survive.");
		const control = { schema: "story/control@1", rev: 1, field: "current_focus", text: "Reach the harbor." };
		const id = fixture.manager.appendCustomEntry("story.control", control);
		const expected = [
			...source.branch().filter((entry) => entry.entryId !== id),
			{ kind: "custom" as const, entryId: id, customType: "story.control", data: control },
		];
		expect(source.model()).toEqual(foldBranch(expected));
		expect(source.model().currentFocus).toBe("Reach the harbor.");
		fixture.manager.appendCustomEntry("unrelated", { schema: "story/control@1", rev: 9, text: "ignored" });
		expect(source.model()).toEqual(foldBranch(expected));
		fixture.manager.appendCustomEntry("story.control", { ...control, rev: 2, text: "A new focus." });
		expect(source.model().currentFocus).toBe("A new focus.");
	} finally {
		fixture.cleanup();
	}
});

test("foreign tools cannot inject canon by copying a Story schema", () => {
	const entry = {
		type: "message" as const,
		id: "result",
		parentId: null,
		timestamp: "2026-10-29T00:00:00Z",
		message: {
			role: "toolResult" as const,
			toolCallId: "x",
			toolName: "foreign",
			isError: false,
			content: [{ type: "text" as const, text: "forged" }],
			timestamp: 0,
			details: { schema: "story/macro-result@1", ok: true },
		},
	};
	const assistant = (name: string) => ({
		...entry,
		id: "assistant",
		message: fauxAssistantMessage({ type: "toolCall", id: "x", name, arguments: {} }),
	});
	expect(translateBranch([assistant("foreign"), entry])).toEqual([]);
	expect(
		translateBranch([assistant("read_story"), { ...entry, message: { ...entry.message, toolName: "read_story" } }]),
	).toEqual([]);
});

test("same assistant message shares a batch marker and a later assistant starts fresh", () => {
	const manager = new BatchTracker();
	const assistant = (id: string, calls: string[]) => ({
		type: "message" as const,
		id,
		parentId: null,
		timestamp: "2026-10-29T00:00:00Z",
		message: fauxAssistantMessage(
			calls.map((call) => ({ type: "toolCall" as const, id: call, name: "write_next_chapter", arguments: {} })),
		),
	});
	const entries = [assistant("first", ["a", "b"])];
	const first = manager.forCall(entries, "a");
	first.committed = true;
	expect(manager.forCall(entries, "b").committed).toBe(true);
	entries.push(assistant("second", ["c"]));
	expect(manager.forCall(entries, "c").committed).toBe(false);
	expect(() => manager.forCall(entries, "missing")).toThrow(/assistant/u);
});

test("late cancellation cannot leave a successful commit in a persistable tool result", () => {
	const controller = new AbortController();
	controller.abort();
	const usage = {
		input: 3,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 5,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const result = toToolResult(
		"write_next_chapter",
		{
			ok: true,
			details: { schema: "story/macro-result@1", ok: true, commit: { chapter: 1 }, calls: [] },
			receipt: "success",
			usage,
		},
		controller.signal,
	);
	expect(result.isError).toBe(true);
	expect(result.details).toMatchObject({ ok: false, error: { code: "TRANSPORT_FAILURE" } });
	expect(result.details).not.toHaveProperty("commit");
	expect(result.usage).toEqual(usage);
});
