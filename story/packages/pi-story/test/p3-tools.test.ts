import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { expect, test } from "vitest";
import { BranchSource, STORY_TOOLS } from "../src/entries.ts";
import { createTestSession, draftText, keeperReply, openingCalls } from "./fixture.ts";

test("future character tool arguments publish the core card fields instead of accepting invented skills", async () => {
	const f = await createTestSession();
	try {
		const tool = f.session.agent.state.tools.find((tool) => tool.name === "update_bible");
		if (!tool) throw new Error("Future bible tool missing");
		const input = {
			reason: "Add an ability",
			changes: [
				{ kind: "character", key: "char:ada", op: "set", source: "model", value: { skills: "Read semaphore" } },
			],
		};
		expect(Check(tool.parameters, input)).toBe(false);
		expect(
			Check(tool.parameters, {
				...input,
				changes: [{ ...input.changes[0], value: { abilities: "Read semaphore in daylight" } }],
			}),
		).toBe(true);
	} finally {
		f.cleanup();
	}
});

test("P3 exposes eleven tools and changes only future bible/outline through real core", async () => {
	const f = await createTestSession();
	try {
		f.faux.setResponses([
			fauxAssistantMessage([...openingCalls(), fauxToolCall("write_next_chapter", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(draftText),
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(keeperReply)),
			fauxAssistantMessage("Committed."),
		]);
		await f.session.prompt("Ada must survive.");
		const before = new BranchSource(() => f.manager.getBranch()).model().commits[0];
		f.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("update_bible", {
						changes: [
							{
								kind: "place",
								key: "place:boathouse",
								name: "Boathouse",
								source: "model",
								op: "set",
								value: { description: "A future destination" },
							},
						],
						reason: "Add the next destination",
					}),
					fauxToolCall("patch_outline", {
						chapters: [{ n: 2, title: "Boathouse", targetWords: 100, purpose: "Enter the boathouse" }],
						reason: "Continue the investigation",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Updated future chapters."),
		]);
		await f.session.prompt("Add a future destination and chapter.");
		const model = new BranchSource(() => f.manager.getBranch()).model();
		expect(model.bible["place:boathouse"]).toMatchObject({ effectiveFromChapter: 2 });
		expect(model.outline.at(-1)).toMatchObject({ n: 2, title: "Boathouse" });
		expect(model.commits[0]).toEqual(before);
		expect(f.session.agent.state.tools.map((t) => t.name).sort()).toEqual([...STORY_TOOLS].sort());
		expect(STORY_TOOLS).toHaveLength(11);
		expect(f.errors).toEqual([]);
	} finally {
		f.cleanup();
	}
});
test("P3 asks through a dialog, records the author answer as author input and reports absence honestly", async () => {
	const f = await createTestSession();
	try {
		f.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("ask_author", { question: "Harbor or mountains?", options: ["Harbor", "Mountains"] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Waiting for author."),
		]);
		await f.session.prompt("Plan a story.");
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({
			details: { data: { status: "absent", answer: null } },
		});
		await f.session.bindExtensions({
			uiContext: { ...f.session.extensionRunner.getUIContext(), select: async () => "Mountains" },
		});
		f.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("ask_author", { question: "Harbor or mountains?", options: ["Harbor", "Mountains"] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Mountains selected."),
		]);
		await f.session.prompt("I am here now.");
		expect(
			new BranchSource(() => f.manager.getBranch()).model().authorMessages.some((m) => m.text === "Mountains"),
		).toBe(true);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({
			details: { data: { status: "answered", answer: "Mountains" } },
		});
		expect(f.errors).toEqual([]);
	} finally {
		f.cleanup();
	}
});
