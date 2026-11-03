import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { foldBranch } from "@pi-story/core";
import { expect, test } from "vitest";
import { BranchSource } from "../src/entries.ts";
import { createTestSession, openingCalls } from "./fixture.ts";

test("flat opening arguments preserve character detail and every chapter point in core", async () => {
	const fixture = await createTestSession();
	try {
		fixture.faux.setResponses([
			fauxAssistantMessage(
				[
					openingCalls()[0],
					fauxToolCall("submit_bible", {
						items: [
							{
								kind: "character",
								key: "char:ada",
								name: "Ada",
								source: "model",
								description: "A courier seeking the harbor",
								invariants: ["Keeps her promise"],
							},
						],
					}),
					fauxToolCall("submit_outline", {
						viewpoint: "third person",
						tone: "tense",
						chapters: [
							{
								n: 1,
								title: "The gate",
								targetWords: 100,
								points: ["Approach the gate", "Find the seal", "Stop before opening it"],
							},
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Opened."),
		]);
		await fixture.session.prompt("Ada must survive.");
		const model = new BranchSource(() => fixture.manager.getBranch()).model();
		expect(model.bible["char:ada"].card).toMatchObject({
			identity: "A courier seeking the harbor",
			invariants: ["Keeps her promise"],
		});
		expect(model.outline[0]).toMatchObject({
			purpose: "Approach the gate",
			turn: "Find the seal; Stop before opening it",
		});
		expect(model.narration).toMatchObject({ viewpoint: "third person", tone: "tense" });
	} finally {
		fixture.cleanup();
	}
});

test("faux showrunner opens a book in one sequential tool batch using real core commands", async () => {
	const fixture = await createTestSession();
	try {
		fixture.faux.setResponses([
			fauxAssistantMessage(openingCalls(), { stopReason: "toolUse" }),
			fauxAssistantMessage("Book opened."),
		]);
		await fixture.session.prompt("Ada must survive.");
		const results = fixture.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(3);
		expect(results.every((message) => message.role === "toolResult" && !message.isError)).toBe(true);
		const source = new BranchSource(() => fixture.manager.getBranch());
		expect(source.model()).toEqual(foldBranch(source.branch()));
		expect(source.model()).toMatchObject({
			controlRev: 1,
			bibleRev: 1,
			outlineRev: 1,
			lastChapter: 0,
			ledger: [{ id: "L-1", text: "Keep Ada alive." }],
		});
		expect(fixture.errors).toEqual([]);
	} finally {
		fixture.cleanup();
	}
});

test("unmatched author quotes return a field path and never establish a ledger", async () => {
	const fixture = await createTestSession();
	try {
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("submit_constraints", {
					op: "submit",
					items: [{ kind: "story", text: "Invented", quotes: ["Never supplied"] }],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Stopped."),
		]);
		await fixture.session.prompt("Ada must survive.");
		expect(fixture.session.messages.find((message) => message.role === "toolResult")).toMatchObject({
			isError: true,
			details: { schema: "story/error@1", error: { code: "DOMAIN_INVALID", items: ["items[0].quotes[0]"] } },
		});
		expect(new BranchSource(() => fixture.manager.getBranch()).model().ledger).toEqual([]);
	} finally {
		fixture.cleanup();
	}
});

test("bible and outline domain errors identify their input fields", async () => {
	const fixture = await createTestSession();
	try {
		fixture.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("submit_bible", {
						items: [{ kind: "character", key: "place:ada", name: "Ada", source: "model", description: "Ada" }],
					}),
					fauxToolCall("submit_bible", {
						items: [
							{
								kind: "character",
								key: "char:ada",
								name: "Ada",
								source: "user",
								authorQuote: "Invented quote",
								description: "Ada",
							},
						],
					}),
					fauxToolCall("submit_outline", {
						viewpoint: "third",
						tone: "calm",
						chapters: [{ n: 2, title: "Gap", targetWords: 100, points: ["Move", "Stop"] }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Stopped."),
		]);
		await fixture.session.prompt("Ada must survive.");
		const results = fixture.session.messages.filter((message) => message.role === "toolResult");
		for (const [index, field] of ["items[0].key", "items[0].authorQuote", "chapters[0].n"].entries())
			expect(results[index]).toMatchObject({
				isError: true,
				details: { error: { code: "DOMAIN_INVALID", items: [field] } },
			});
	} finally {
		fixture.cleanup();
	}
});
