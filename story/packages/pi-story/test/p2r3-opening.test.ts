import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { BranchSource } from "../src/entries.ts";
import { createTestSession } from "./fixture.ts";

interface Counterexample {
	kind: string;
	caseId: string;
	toolCallId: string;
	authorPrompt: string;
	parameters: JsonObject;
}
const { cases } = JSON.parse(
	readFileSync(new URL("./fixtures/p2r3-opening-failures.json", import.meta.url), "utf8"),
) as { cases: Counterexample[] };

for (const example of cases) {
	test(`25 S1 raw ${example.kind} ${example.caseId} ${example.toolCallId}`, async () => {
		const fixture = await createTestSession();
		try {
			fixture.faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall(example.kind === "bible_invariants" ? "submit_bible" : "submit_outline", example.parameters),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Stopped."),
			]);
			await fixture.session.prompt(example.authorPrompt);
			const result = fixture.session.messages.find((message) => message.role === "toolResult");
			if (example.kind === "bible_invariants") {
				const items = example.parameters.items as JsonObject[];
				if (items.some((item) => "source_note" in item)) {
					expect(result).toMatchObject({
						isError: true,
						details: { error: { items: expect.arrayContaining(["/items/9/source_note"]) } },
					});
					const corrected = {
						...example.parameters,
						items: items.map((item) => {
							const { source_note: _note, ...rest } = item;
							return rest;
						}),
					};
					fixture.faux.setResponses([
						fauxAssistantMessage(fauxToolCall("submit_bible", corrected), { stopReason: "toolUse" }),
						fauxAssistantMessage("Stopped."),
					]);
					await fixture.session.prompt("Correct the undeclared field and retry.");
					expect(fixture.session.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
						isError: false,
					});
				} else
					expect(result, JSON.stringify(result?.role === "toolResult" ? result.details : result)).toMatchObject({
						isError: false,
					});
				expect(new BranchSource(() => fixture.manager.getBranch()).model().bibleRev).toBe(1);
			} else {
				expect(result).toMatchObject({
					isError: true,
					details: { error: { code: "DOMAIN_INVALID", hint: expect.stringContaining("viewpoint、tone、chapters") } },
				});
				expect(new BranchSource(() => fixture.manager.getBranch()).model().outlineRev).toBe(0);
			}
		} finally {
			fixture.cleanup();
		}
	});
}

test("all six bible kinds retain invariants through the adapter and core", async () => {
	const fixture = await createTestSession();
	try {
		const items = [
			["character", "char:ada"],
			["place", "place:harbor"],
			["rule", "rule:tides"],
			["conflictLine", "line:search"],
			["frameworkChoice", "fw:voice"],
			["relationBaseline", "rel:ada->bo"],
		].map(([kind, key]) => ({
			kind,
			key,
			name: key,
			source: "model",
			description: "A stable detail",
			invariants: ["A stable restriction"],
		}));
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("submit_bible", { items }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Opened."),
		]);
		await fixture.session.prompt("Open a story.");
		expect(fixture.session.messages.find((message) => message.role === "toolResult")).toMatchObject({ isError: false });
		const model = new BranchSource(() => fixture.manager.getBranch()).model();
		for (const item of items) {
			const entry = model.bible[item.key];
			expect(entry?.kind === "character" ? entry.card : entry?.value).toMatchObject({ invariants: item.invariants });
		}
	} finally {
		fixture.cleanup();
	}
});
