import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { scoreEvidenceV2 } from "../../../scripts/eval/p2/score-v2.ts";
import { BranchSource } from "../src/entries.ts";
import { createTestSession, draftText, keeperReply, openingCalls } from "./fixture.ts";

const malformed = (name: string, args: Record<string, unknown>, extra = "}") => ({
	...fauxToolCall(name, {}),
	argumentsError: `Unexpected non-whitespace character after JSON\n\nReceived arguments:\n${JSON.stringify(args)}${extra}`,
});

test.each(["submit_bible", "submit_outline"])(
	"one extra closing brace is repaired visibly through the real SDK: %s",
	async (name) => {
		const fixture = await createTestSession();
		try {
			const calls = openingCalls(),
				original = calls[name === "submit_bible" ? 1 : 2];
			fixture.faux.setResponses([
				fauxAssistantMessage(
					[...calls.slice(0, name === "submit_bible" ? 1 : 2), malformed(name, original.arguments)],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Done."),
			]);
			await fixture.session.prompt("Ada must survive.");
			const result = fixture.session.messages.findLast(
				(message) => message.role === "toolResult" && message.toolName === name,
			);
			if (result?.role !== "toolResult") throw new Error("Missing tool result");
			expect(result).toMatchObject({
				isError: false,
				details: {
					argumentsRepair: {
						strategy: "remove_one_trailing_brace",
						originalArguments: `${JSON.stringify(original.arguments)}}`,
					},
				},
			});
			expect(JSON.stringify(result?.content)).toContain("语法修复");
			const model = new BranchSource(() => fixture.manager.getBranch()).model();
			expect(name === "submit_bible" ? model.bibleRev : model.outlineRev).toBe(1);
			expect(fixture.errors).toEqual([]);
			const results = fixture.session.messages.filter((message) => message.role === "toolResult");
			const scored = scoreEvidenceV2(
				[
					{ type: "meta", suiteId: "P2-OPEN", runId: "repair", expectedCaseIds: ["one"], stage: "P2R" },
					...results.map((message) => ({ type: "tool_result", caseId: "one", message })),
				],
				[],
			);
			expect(scored.metrics.find((metric) => metric.id === "T01")).toMatchObject({
				n: results.length,
				successes: results.length - 1,
				afterRepairUsability: { successes: results.length },
				failureCategories: { json_syntax_repaired: 1 },
			});
		} finally {
			fixture.cleanup();
		}
	},
);

test.each(["two_braces", "schema_invalid"])(
	"repair does not broaden malformed JSON or the published schema: %s",
	async (reason) => {
		const fixture = await createTestSession();
		try {
			const args = reason === "schema_invalid" ? { unknown: "must not execute" } : openingCalls()[1].arguments;
			fixture.faux.setResponses([
				fauxAssistantMessage(malformed("submit_bible", args, reason === "two_braces" ? "}}" : "}"), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Stopped."),
			]);
			await fixture.session.prompt("Ada must survive.");
			expect(fixture.session.messages.find((message) => message.role === "toolResult")).toMatchObject({
				isError: true,
				details: { error: { code: "DOMAIN_INVALID" } },
			});
			expect(new BranchSource(() => fixture.manager.getBranch()).model().bibleRev).toBe(0);
		} finally {
			fixture.cleanup();
		}
	},
);

test("a syntax repair still obeys the commit batch guard", async () => {
	const fixture = await createTestSession();
	try {
		const calls = openingCalls();
		fixture.faux.setResponses([
			fauxAssistantMessage(
				[...calls, fauxToolCall("write_next_chapter", {}), malformed("submit_bible", calls[1].arguments)],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(draftText),
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(keeperReply)),
			fauxAssistantMessage("Done."),
		]);
		await fixture.session.prompt("Ada must survive.");
		expect(fixture.session.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
			isError: true,
			details: { argumentsRepair: expect.any(Object), error: { code: "STALE_OR_CONFLICT" } },
		});
		expect(new BranchSource(() => fixture.manager.getBranch()).model().commits).toHaveLength(1);
	} finally {
		fixture.cleanup();
	}
});
