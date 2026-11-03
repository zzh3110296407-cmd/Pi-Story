import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { BranchSource } from "../src/entries.ts";
import { createTestSession, draftText, keeperReply, openingCalls } from "./fixture.ts";

test("P3 commands reject before the story prompt, then persist control and complete policy snapshots without model calls", async () => {
	const f = await createTestSession();
	try {
		const notices: string[] = [];
		await f.session.bindExtensions({
			uiContext: { ...f.session.extensionRunner.getUIContext(), notify: (message) => notices.push(message) },
		});
		const beforePrompt = f.manager.getBranch();
		for (const cmd of [
			"/intent No death",
			"/focus Harbor",
			"/ledger add story Keep Ada alive",
			"/goal 3",
			"/budget tokens=100000",
		])
			await f.session.prompt(cmd);
		expect(notices.filter((text) => text.includes("先发出故事提示"))).toHaveLength(5);
		expect(f.manager.getBranch()).toEqual(beforePrompt);
		f.faux.setResponses([fauxAssistantMessage("Ready.")]);
		await f.session.prompt("Ada must survive.");
		for (const cmd of [
			"/intent New intent",
			"/focus New focus",
			"/ledger add story Keep Ada alive",
			"/ledger set L-1 Ada may leave",
			"/ledger add given_fact Ada has a key",
			"/ledger remove L-1",
			"/goal 3",
			"/budget tokens=100000 usd=1.25 perChapterCalls=7",
			"/goal off",
		])
			await f.session.prompt(cmd);
		const model = new BranchSource(() => f.manager.getBranch()).model();
		expect(model.authorIntent).toBe("New intent");
		expect(model.currentFocus).toBe("New focus");
		expect(model.ledger).toMatchObject([{ id: "L-2", text: "Ada has a key", kind: "given_fact", sourceSpans: [] }]);
		expect(model.policy).toEqual({ budget: { tokens: 100000, costUsd: 1.25, perChapterCalls: 7 } });
		await f.session.prompt("/goal 4");
		await f.session.prompt("/budget off");
		expect(new BranchSource(() => f.manager.getBranch()).model().policy).toEqual({ targetChapter: 4 });
		expect(f.session.messages.filter((m) => m.role === "custom" && m.customType === "story.notice")).toHaveLength(11);
		expect(f.faux.state.callCount).toBe(1);
		expect(f.errors).toEqual([]);
	} finally {
		f.cleanup();
	}
});
test("P3 no-argument editors prefill current values; cancellation and invalid arguments write nothing", async () => {
	const f = await createTestSession();
	try {
		f.faux.setResponses([fauxAssistantMessage("Ready.")]);
		await f.session.prompt("Ada must survive.");
		await f.session.prompt("/intent Original");
		const seen: (string | undefined)[] = [];
		await f.session.bindExtensions({
			uiContext: {
				...f.session.extensionRunner.getUIContext(),
				editor: async (_title, prefill) => {
					seen.push(prefill);
					return undefined;
				},
			},
		});
		const count = f.manager.getBranch().length;
		for (const cmd of [
			"/intent",
			"/focus",
			"/ledger",
			"/goal",
			"/budget",
			"/goal -1",
			"/goal 1.5",
			"/budget tokens=-1",
			"/budget usd=NaN",
			"/budget perChapterCalls=0",
			"/budget usd=1 usd=2",
			"/ledger remove L-99",
			"/ledger add wrong text",
		])
			await f.session.prompt(cmd);
		expect(seen).toHaveLength(5);
		expect(seen[0]).toBe("Original");
		expect(f.manager.getBranch()).toHaveLength(count);
		expect(f.faux.state.callCount).toBe(1);
	} finally {
		f.cleanup();
	}
});

test("goal and budget commands reach the next model context without starting a model request", async () => {
	const f = await createTestSession();
	try {
		f.faux.setResponses([fauxAssistantMessage("Ready.")]);
		await f.session.prompt("Ada must survive.");
		const visible: string[] = [];
		f.faux.setResponses([
			async () => {
				const before = f.faux.state.callCount;
				await f.session.prompt("/goal 4");
				await f.session.prompt("/budget perChapterCalls=7");
				expect(f.faux.state.callCount).toBe(before);
				return fauxAssistantMessage(fauxToolCall("read_story", { section: "bible" }), { stopReason: "toolUse" });
			},
			(context) => {
				visible.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("Settings received.");
			},
			(context) => {
				visible.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("Budget received.");
			},
		]);
		await f.session.prompt("Confirm the current settings.");
		expect(visible[0]?.includes("写作目标：4")).toBe(true);
		expect(visible.at(-1)?.includes("预算：perChapterCalls=7")).toBe(true);
	} finally {
		f.cleanup();
	}
});
test("P3 author command executes during keeper, updates control immediately and prevents stale commit", async () => {
	const f = await createTestSession();
	try {
		f.faux.setResponses([
			fauxAssistantMessage([...openingCalls(), fauxToolCall("write_next_chapter", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(draftText),
			fauxAssistantMessage('{"observations":[]}'),
			async () => {
				await f.session.prompt("/intent Ada must leave the harbor");
				return fauxAssistantMessage(JSON.stringify(keeperReply));
			},
			fauxAssistantMessage("Stopped because the author changed intent."),
		]);
		await f.session.prompt("Ada must survive.");
		const model = new BranchSource(() => f.manager.getBranch()).model();
		expect(model.authorIntent).toBe("Ada must leave the harbor");
		expect(model.commits).toHaveLength(0);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({
			details: { error: { code: "STALE_OR_CONFLICT" } },
		});
		expect(f.errors).toEqual([]);
	} finally {
		f.cleanup();
	}
});
