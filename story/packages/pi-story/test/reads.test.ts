import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { BranchSource } from "../src/entries.ts";
import { createTestSession, openingCalls } from "./fixture.ts";

test("four read tools return projections and cannot change the book", async () => {
	const fixture = await createTestSession();
	try {
		fixture.faux.setResponses([
			fauxAssistantMessage(openingCalls(), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[
					fauxToolCall("read_story", { section: "control" }),
					fauxToolCall("read_chapter", { n: 1 }),
					fauxToolCall("read_state", { asOfChapter: 0 }),
					fauxToolCall("get_character", { key: "char:ada" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Read complete."),
		]);
		await fixture.session.prompt("Ada must survive.");
		const results = fixture.session.messages.filter((message) => message.role === "toolResult").slice(3);
		expect(results).toHaveLength(4);
		const byName = new Map(results.map((message) => [message.toolName, message]));
		expect(byName.get("read_story")).toMatchObject({ isError: false, details: { schema: "story/read@1" } });
		expect(JSON.stringify(byName.get("read_story")?.content)).toContain("Keep Ada alive.");
		expect(byName.get("read_chapter")).toMatchObject({ isError: true, details: { error: { code: "DOMAIN_INVALID" } } });
		expect(byName.get("read_state")).toMatchObject({ isError: false });
		expect(JSON.stringify(byName.get("get_character")?.content)).toContain("Ada");
		expect(new BranchSource(() => fixture.manager.getBranch()).model()).toMatchObject({
			lastChapter: 0,
			controlRev: 1,
			bibleRev: 1,
			outlineRev: 1,
			commits: [],
		});
		expect(fixture.errors).toEqual([]);
	} finally {
		fixture.cleanup();
	}
});
