import { fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { STORY_TOOLS } from "../src/entries.ts";
import { createTestSession } from "./fixture.ts";

test("the pinned Pi SDK loads the Story extension and completes a faux turn", async () => {
	const fixture = await createTestSession();
	try {
		expect(fixture.extensionsResult.errors).toEqual([]);
		expect(fixture.extensionsResult.extensions.some((extension) => extension.path.endsWith("index.ts"))).toBe(true);
		fixture.faux.setResponses([fauxAssistantMessage("Story extension loaded.")]);
		await fixture.session.prompt("Confirm the local extension is loaded.");
		expect(fixture.faux.state.callCount).toBe(1);
		expect(fixture.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Story extension loaded." }],
		});
		expect(fixture.errors).toEqual([]);
	} finally {
		fixture.cleanup();
	}
});

test("session assembly exposes exactly eleven Story tools and injects the fixed showrunner rules", async () => {
	const fixture = await createTestSession({ builtinTools: true });
	try {
		let declared: string[] = [];
		let system = "";
		fixture.faux.setResponses([
			(context) => {
				declared = getCurrentTools(context.messages)
					.map((tool) => tool.name)
					.sort();
				system = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage("Ready.");
			},
		]);
		await fixture.session.prompt("Open a story.");
		expect(declared).toEqual([...STORY_TOOLS].sort());
		expect(system).toContain("name: story-showrunner");
		expect(system).toContain("Continue toward the author's goal");
		expect(fixture.errors).toEqual([]);
	} finally {
		fixture.cleanup();
	}
});
