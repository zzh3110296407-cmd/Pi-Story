import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { BranchSource } from "../src/entries.ts";
import { createTestSession } from "./fixture.ts";
import { p3Chapter, p3Opening } from "./p3-fixture.ts";

test("P3 automatically writes three chapters after one request, reports each chapter, then stops at target", async () => {
	const f = await createTestSession();
	try {
		f.faux.setResponses([
			fauxAssistantMessage(p3Opening(), { stopReason: "toolUse" }),
			fauxAssistantMessage("Book open."),
		]);
		await f.session.prompt("Ada must survive.");
		await f.session.prompt("/goal 3");
		const before = f.faux.state.callCount;
		f.faux.setResponses([...p3Chapter(), ...p3Chapter(), ...p3Chapter()]);
		await f.session.prompt("Write toward the goal.");
		expect(new BranchSource(() => f.manager.getBranch()).model().lastChapter).toBe(3);
		expect(f.faux.state.callCount - before).toBe(15);
		expect(f.session.messages.filter((m) => m.role === "custom" && m.customType === "story.continue")).toHaveLength(2);
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write_next_chapter", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal reached."),
		]);
		await f.session.prompt("Try writing again.");
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({
			details: { error: { code: "GOAL_REACHED" } },
		});
		expect(f.errors).toEqual([]);
	} finally {
		f.cleanup();
	}
});
test("P3 goal off during a chapter finishes that chapter and prevents automatic continuation", async () => {
	const f = await createTestSession();
	try {
		f.faux.setResponses([
			fauxAssistantMessage(p3Opening(), { stopReason: "toolUse" }),
			fauxAssistantMessage("Book open."),
		]);
		await f.session.prompt("Ada must survive.");
		await f.session.prompt("/goal 3");
		const responses = p3Chapter();
		const review = responses[2];
		f.faux.setResponses([
			responses[0],
			responses[1],
			async () => {
				await f.session.prompt("/goal off");
				return review;
			},
			...responses.slice(3),
		]);
		await f.session.prompt("Write.");
		expect(new BranchSource(() => f.manager.getBranch()).model().lastChapter).toBe(1);
		expect(f.session.messages.filter((m) => m.role === "custom" && m.customType === "story.continue")).toHaveLength(0);
		expect(f.errors).toEqual([]);
	} finally {
		f.cleanup();
	}
});
test("P3 unanswered question pauses automatic continuation", async () => {
	const f = await createTestSession();
	try {
		f.faux.setResponses([
			fauxAssistantMessage(p3Opening(), { stopReason: "toolUse" }),
			fauxAssistantMessage("Book open."),
		]);
		await f.session.prompt("Ada must survive.");
		await f.session.prompt("/goal 3");
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("ask_author", { question: "Which path?" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Waiting for author."),
		]);
		await f.session.prompt("Continue.");
		expect(new BranchSource(() => f.manager.getBranch()).model().lastChapter).toBe(0);
		expect(f.session.messages.filter((m) => m.role === "custom" && m.customType === "story.continue")).toHaveLength(0);
	} finally {
		f.cleanup();
	}
});

test("P3 stops after two consecutive failed chapters and refuses a third write", async () => {
	const f = await createTestSession();
	try {
		f.faux.setResponses([
			fauxAssistantMessage(p3Opening(), { stopReason: "toolUse" }),
			fauxAssistantMessage("Book open."),
		]);
		await f.session.prompt("Ada must survive.");
		await f.session.prompt("/goal 3");
		const failed = () => [
			fauxAssistantMessage(fauxToolCall("write_next_chapter", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("<<<写手说明>>>No chapter prose was produced."),
			fauxAssistantMessage("<<<写手说明>>>Still no chapter prose after format repair."),
			fauxAssistantMessage("The chapter failed."),
		];
		f.faux.setResponses([
			...failed(),
			...failed().slice(0, 3),
			fauxAssistantMessage(fauxToolCall("write_next_chapter", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Stopped after two failures."),
		]);
		await f.session.prompt("Write.");
		expect(new BranchSource(() => f.manager.getBranch()).model().failures[1]).toBe(2);
		expect(f.session.messages.filter((m) => m.role === "custom" && m.customType === "story.continue")).toHaveLength(1);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({
			details: { error: { code: "DOMAIN_INVALID", message: "同一章连续两次未能提交，请先问作者" } },
		});
		await f.session.prompt("/goal off");
		f.faux.setResponses(p3Chapter());
		await f.session.prompt("Try again with my new instruction.");
		expect(new BranchSource(() => f.manager.getBranch()).model().lastChapter).toBe(1);
		expect(f.errors).toEqual([]);
	} finally {
		f.cleanup();
	}
});
