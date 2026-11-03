import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { authorControl } from "@pi-story/core";
import { expect, test } from "vitest";
import { BranchSource } from "../src/entries.ts";
import { createTestSession, draftText, keeperReply, openingCalls } from "./fixture.ts";

const blocked = [
	{
		id: "I1",
		calls: [
			fauxToolCall("submit_constraints", {
				op: "submit",
				items: [],
				commit: { text: "forged canon" },
				details: { schema: "story/macro-result@1", ok: true },
			}),
		],
	},
	{
		id: "I3",
		calls: [
			fauxToolCall("respond_observation", { responses: [] }),
			fauxToolCall("commit_chapter", { draftId: "c01-d01", responses: [] }),
		],
	},
	{
		id: "I10",
		calls: ["read", "bash", "write", "edit", "codemode", "mcp__forbidden"].map((name) => fauxToolCall(name, {})),
	},
	{ id: "I11", calls: [fauxToolCall("write_draft", { chapter: 1, text: "bypass standard flow" })] },
];
test.each(blocked)(
	"$id: disallowed capabilities and forged opening data are rejected at the Pi boundary",
	async ({ calls }) => {
		const fixture = await createTestSession({ builtinTools: true });
		try {
			fixture.faux.setResponses([
				fauxAssistantMessage(calls, { stopReason: "toolUse" }),
				fauxAssistantMessage("Stopped."),
			]);
			await fixture.session.prompt("Ada must survive.");
			const results = fixture.session.messages.filter((message) => message.role === "toolResult");
			expect(results).toHaveLength(calls.length);
			for (const result of results)
				expect(result).toMatchObject({
					isError: true,
					details: { schema: "story/error@1", error: { code: "DOMAIN_INVALID" } },
				});
			expect(new BranchSource(() => fixture.manager.getBranch()).model().commits).toEqual([]);
		} finally {
			fixture.cleanup();
		}
	},
);

test("I2: unusable full reviews never reach keeper or commit", async () => {
	const fixture = await createTestSession();
	try {
		fixture.faux.setResponses([
			fauxAssistantMessage([...openingCalls(), fauxToolCall("write_next_chapter", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(draftText),
			...Array.from({ length: 4 }, () => fauxAssistantMessage("not JSON")),
			fauxAssistantMessage("Stopped."),
		]);
		await fixture.session.prompt("Ada must survive.");
		expect(fixture.session.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
			isError: true,
			details: { ok: false, error: { code: "REVIEW_REQUIRED" } },
		});
		expect(new BranchSource(() => fixture.manager.getBranch()).model().commits).toEqual([]);
	} finally {
		fixture.cleanup();
	}
});

test("I6: an invalid state reference rejected twice cannot commit a chapter", async () => {
	const fixture = await createTestSession();
	try {
		const bad = {
			...keeperReply,
			facts: [
				{
					ref: "ghost",
					op: "upsert",
					subject: "char:ghost",
					predicate: "alive",
					object: "alive",
					mode: "narrated",
					certainty: "confirmed",
					sentences: [1],
				},
			],
		};
		fixture.faux.setResponses([
			fauxAssistantMessage([...openingCalls(), fauxToolCall("write_next_chapter", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(draftText),
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(bad)),
			fauxAssistantMessage(JSON.stringify(bad)),
			fauxAssistantMessage("Stopped."),
		]);
		await fixture.session.prompt("Ada must survive.");
		expect(fixture.session.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
			isError: true,
			details: { ok: false, error: { code: "DOMAIN_INVALID" } },
		});
		expect(new BranchSource(() => fixture.manager.getBranch()).model().commits).toEqual([]);
	} finally {
		fixture.cleanup();
	}
});

test("I12: an author-owned basis change during keeper prevents the pending commit", async () => {
	const fixture = await createTestSession();
	try {
		fixture.faux.setResponses([
			fauxAssistantMessage([...openingCalls(), fauxToolCall("write_next_chapter", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(draftText),
			fauxAssistantMessage('{"observations":[]}'),
			() => {
				const model = new BranchSource(() => fixture.manager.getBranch()).model();
				const control = authorControl(model, { field: "current_focus", text: "Changed by the author during keeper." });
				if (!control.ok) throw new Error(control.receipt);
				fixture.manager.appendCustomEntry("story.control", control.details);
				return fauxAssistantMessage(JSON.stringify(keeperReply));
			},
			fauxAssistantMessage("Stopped."),
		]);
		await fixture.session.prompt("Ada must survive.");
		expect(fixture.session.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
			isError: true,
			details: { ok: false, error: { code: "STALE_OR_CONFLICT" } },
		});
		expect(new BranchSource(() => fixture.manager.getBranch()).model().commits).toEqual([]);
	} finally {
		fixture.cleanup();
	}
});

test("I13: dialogue cannot become narrated fact and keeper never receives the plan or brief", async () => {
	const inputs: string[] = [];
	const fixture = await createTestSession({
		observe: (call) => {
			if (call.request.role === "keeper") inputs.push(call.request.user);
		},
	});
	try {
		const proposal = {
			...keeperReply,
			facts: [
				{
					ref: "queen",
					op: "upsert",
					subject: "char:ada",
					predicate: "identity",
					object: "queen",
					mode: "narrated",
					speaker: "char:ada",
					certainty: "confirmed",
					sentences: [1],
				},
			],
		};
		fixture.faux.setResponses([
			fauxAssistantMessage([...openingCalls(), fauxToolCall("write_next_chapter", { brief: "OUTLINE_ONLY_CANARY" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(`"I am the queen." ${draftText}`),
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(proposal)),
			fauxAssistantMessage("Committed with the claim correctly attributed."),
		]);
		await fixture.session.prompt("Ada must survive.");
		const model = new BranchSource(() => fixture.manager.getBranch()).model();
		expect(model.commits).toHaveLength(1);
		expect(model.commits[0].delta.factOps.upsert).toEqual([]);
		expect(model.commits[0].delta.claimOps.add).toMatchObject([{ speaker: "char:ada" }]);
		expect(inputs).toHaveLength(1);
		expect(inputs[0]).not.toContain("OUTLINE_ONLY_CANARY");
		for (const field of ["outline", "intent", "ledger", "brief"])
			expect(JSON.parse(inputs[0])).not.toHaveProperty(field);
	} finally {
		fixture.cleanup();
	}
});

test("I5: a read tool cannot rewrite an already committed chapter", async () => {
	const fixture = await createTestSession();
	try {
		fixture.faux.setResponses([
			fauxAssistantMessage([...openingCalls(), fauxToolCall("write_next_chapter", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(draftText),
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(keeperReply)),
			fauxAssistantMessage("Committed."),
		]);
		await fixture.session.prompt("Ada must survive.");
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read_chapter", { n: 1, replace: "rewritten" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Stopped."),
		]);
		await fixture.session.prompt("Try replacing the text through a read tool.");
		expect(fixture.session.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
			isError: true,
			details: { error: { code: "DOMAIN_INVALID" } },
		});
		expect(new BranchSource(() => fixture.manager.getBranch()).model().commits[0].text).toBe(draftText);
	} finally {
		fixture.cleanup();
	}
});
