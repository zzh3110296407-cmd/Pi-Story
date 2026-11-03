import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { BranchSource } from "../src/entries.ts";
import { loadSettings, SessionPorts } from "../src/ports.ts";
import { createTestSession } from "./fixture.ts";

test("P3 budget reads the newest goal snapshot, honors explicit off, and restores author changes immediately", async () => {
	const f = await createTestSession();
	try {
		f.faux.setResponses([fauxAssistantMessage("Ready.")]);
		await f.session.prompt("Ada must survive.");
		const source = new BranchSource(() => f.manager.getBranch());
		const settings = loadSettings(f.agentDir);
		settings.global.defaultBudget.tokens = 5;
		const ports = new SessionPorts(source, () => f.manager.getBranch(), new ModelRegistry(f.runtime), settings);
		const reserve = () =>
			ports.guard.reserve({ role: "writer", model: "faux/script", inputTokensEstimate: 6, maxOutputTokens: 0 });
		expect(reserve().ok).toBe(false);
		await f.session.prompt("/budget tokens=3");
		expect(reserve().ok).toBe(false);
		await f.session.prompt("/budget off");
		expect(reserve().ok).toBe(true);
		await f.session.prompt("/budget tokens=4");
		expect(reserve().ok).toBe(false);
	} finally {
		f.cleanup();
	}
});
test("P3 setting the first goal preserves the configured default budget in its full snapshot", async () => {
	const f = await createTestSession({ defaultBudget: { tokens: 99999, costUsd: null } });
	try {
		f.faux.setResponses([fauxAssistantMessage("Ready.")]);
		await f.session.prompt("Ada must survive.");
		await f.session.prompt("/goal 3");
		expect(new BranchSource(() => f.session.sessionManager.getBranch()).model().policy).toMatchObject({
			targetChapter: 3,
			budget: { tokens: 99999 },
		});
	} finally {
		f.cleanup();
	}
});
