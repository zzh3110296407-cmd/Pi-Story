import { fauxAssistantMessage, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { createTestSession } from "./fixture.ts";

test("P3 dynamic sections rebuild from author-owned state while fixed rules stay stable", async () => {
	const f = await createTestSession();
	try {
		const prompts: string[] = [];
		f.faux.setResponses(
			Array.from({ length: 2 }, () => (context) => {
				prompts.push(getCurrentSystemPrompt(context.messages));
				return fauxAssistantMessage("Ready.");
			}),
		);
		await f.session.prompt("Ada must survive.");
		await f.session.prompt("/intent Protect the harbor");
		await f.session.prompt("/focus Find the ferryman");
		await f.session.prompt("/goal 3");
		await f.session.prompt("/budget tokens=200000");
		await f.session.prompt("Report your current controls.");
		expect(prompts[1]).toContain("<author_intent>\nProtect the harbor");
		expect(prompts[1]).toContain("<current_focus>\nFind the ferryman");
		expect(prompts[1]).toContain('"lastChapter":0');
		expect(prompts[1]).toContain('"targetChapter":3');
		expect(prompts[1]).toContain('"tokens":200000');
		expect(prompts[1]).toContain('"stopReason"');
		const rules = (prompt: string) => /<story_rules>([\s\S]*?)<\/story_rules>/u.exec(prompt)?.[1];
		expect(rules(prompts[0])).toBeTruthy();
		expect(rules(prompts[1])).toBe(rules(prompts[0]));
		expect(prompts[1]).toContain("Continue toward the author's goal");
		expect(f.errors).toEqual([]);
	} finally {
		f.cleanup();
	}
});
