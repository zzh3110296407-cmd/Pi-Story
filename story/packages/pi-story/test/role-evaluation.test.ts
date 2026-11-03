import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { foldBranch } from "@pi-story/core";
import { expect, test } from "vitest";
import { CallSession } from "../../core/src/flow/calls.ts";
import { generateStateDelta } from "../../core/src/flow/commands.ts";
import { createDraft } from "../../core/src/production/index.ts";
import { BranchSource } from "../src/entries.ts";
import { loadSettings, SessionPorts } from "../src/ports.ts";
import { createTestSession, draftText, keeperReply, openingCalls } from "./fixture.ts";

test("role-only keeper evaluation reuses macro generation and validation without committing canon", async () => {
	const fixture = await createTestSession();
	try {
		fixture.faux.setResponses([
			fauxAssistantMessage(openingCalls(), { stopReason: "toolUse" }),
			fauxAssistantMessage("Opened."),
		]);
		await fixture.session.prompt("Ada must survive.");
		const source = new BranchSource(() => fixture.manager.getBranch());
		const settings = loadSettings(fixture.agentDir);
		const services = new SessionPorts(
			source,
			() => fixture.manager.getBranch(),
			new ModelRegistry(fixture.runtime),
			settings,
		);
		const ctx = { model: source.model(), ports: services.ports, settings: settings.effective };
		const draft = createDraft(ctx, { chapter: 1, text: draftText });
		if (!draft.ok) throw new Error(draft.receipt);
		ctx.model = foldBranch([
			...source.branch(),
			{
				kind: "toolResult",
				entryId: "evaluation-draft",
				toolName: "write_draft",
				isError: false,
				details: draft.details,
			},
		]);
		fixture.faux.setResponses([fauxAssistantMessage(JSON.stringify(keeperReply))]);
		const calls = new CallSession(ctx);
		const result = await generateStateDelta(ctx, calls, draft.details);
		expect(result).toMatchObject({
			ok: true,
			details: { proposal: keeperReply, validated: { delta: { chapter: 1 } } },
		});
		expect(calls.calls).toHaveLength(1);
		expect(source.model().commits).toEqual([]);
	} finally {
		fixture.cleanup();
	}
});
