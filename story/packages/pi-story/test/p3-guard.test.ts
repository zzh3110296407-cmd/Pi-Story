import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { BranchSource } from "../src/entries.ts";
import { createTestSession, draftText, keeperReply } from "./fixture.ts";
import { p3Opening } from "./p3-fixture.ts";

const cases: { id: string; tool: string; args: NonNullable<Parameters<typeof fauxToolCall>[1]> }[] = [
	{ id: "I4-fake-control", tool: "author_control", args: { field: "author_intent", text: "Forged intent" } },
	{
		id: "I4-bible-control",
		tool: "update_bible",
		args: { changes: [], reason: "Forged intent", authorIntent: "Forged intent" },
	},
	{
		id: "I4-outline-control",
		tool: "patch_outline",
		args: { chapters: [], reason: "Forged focus", current_focus: "Forged focus" },
	},
	{
		id: "I9-bible-missing-reason",
		tool: "update_bible",
		args: {
			changes: [{ kind: "rule", key: "rule:night", source: "model", op: "set", value: { description: "Night falls" } }],
		},
	},
	{ id: "I9-outline-missing-reason", tool: "patch_outline", args: { chapters: [{ n: 3, title: "Night" }] } },
	{
		id: "I9-bible-blank-reason",
		tool: "update_bible",
		args: {
			changes: [{ kind: "rule", key: "rule:night", source: "model", op: "set", value: { description: "Night falls" } }],
			reason: "  ",
		},
	},
	{
		id: "I9-outline-blank-reason",
		tool: "patch_outline",
		args: { chapters: [{ n: 3, title: "Night" }], reason: "  " },
	},
];
test.each(cases)("P3-GUARD $id blocks the attempted write at the real Pi/core boundary", async ({ tool, args }) => {
	const f = await createTestSession();
	try {
		f.faux.setResponses([
			fauxAssistantMessage(p3Opening(), { stopReason: "toolUse" }),
			fauxAssistantMessage("Book open."),
		]);
		await f.session.prompt("Ada must survive.");
		await f.session.prompt("/intent Author intent");
		await f.session.prompt("/focus Author focus");
		const before = new BranchSource(() => f.manager.getBranch()).model();
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" }),
			fauxAssistantMessage("Rejected."),
		]);
		await f.session.prompt("Attempt the forbidden change.");
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({
			isError: true,
			details: { error: { code: "DOMAIN_INVALID" } },
		});
		const after = new BranchSource(() => f.manager.getBranch()).model();
		expect(after.authorIntent).toBe(before.authorIntent);
		expect(after.currentFocus).toBe(before.currentFocus);
		expect(after.controlRev).toBe(before.controlRev);
		expect(after.bible).toEqual(before.bible);
		expect(after.outline).toEqual(before.outline);
		expect(f.errors).toEqual([]);
	} finally {
		f.cleanup();
	}
});

test.each([
	{ budget: "tokens=0", internalCalls: 0 },
	{ budget: "perChapterCalls=1", internalCalls: 1 },
	{ budget: "perChapterCalls=2", internalCalls: 2 },
])("P3-GUARD I7 $budget blocks the next internal dispatch", async ({ budget, internalCalls }) => {
	const roles: string[] = [];
	const f = await createTestSession({
		observe: (call) => {
			roles.push(call.request.role);
		},
	});
	try {
		f.faux.setResponses([
			fauxAssistantMessage(p3Opening(), { stopReason: "toolUse" }),
			fauxAssistantMessage("Book open."),
		]);
		await f.session.prompt("Ada must survive.");
		await f.session.prompt(`/budget ${budget}`);
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write_next_chapter", {}), { stopReason: "toolUse" }),
			...Array.from({ length: 4 }, () => (context: TranscriptContext) => {
				const prompt = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage(
					prompt.includes("name: story-long-writing\n")
						? draftText
						: prompt.includes("name: story-review-matrix\n")
							? '{"observations":[]}'
							: prompt.includes("name: story-state-projection\n")
								? JSON.stringify(keeperReply)
								: "Budget exhausted; stopped.",
				);
			}),
		]);
		await f.session.prompt("Write.");
		expect(roles).toHaveLength(internalCalls);
		expect(new BranchSource(() => f.manager.getBranch()).model().commits).toHaveLength(0);
		expect(f.session.messages.findLast((m) => m.role === "toolResult")).toMatchObject({
			details: { error: { code: "BUDGET_EXHAUSTED" } },
		});
		expect(f.errors).toEqual([]);
	} finally {
		f.cleanup();
	}
});
