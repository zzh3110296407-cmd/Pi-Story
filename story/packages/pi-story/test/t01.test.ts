import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { expect, test } from "vitest";
import { BranchSource } from "../src/entries.ts";
import { createTestSession, openingCalls } from "./fixture.ts";

test("the next showrunner request receives the rejected quote field and can correct it", async () => {
	const fixture = await createTestSession();
	let feedback = "";
	try {
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("submit_constraints", {
					op: "submit",
					items: [{ kind: "story", text: "Keep Ada alive.", quotes: ["Unprovided quote"] }],
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				feedback = JSON.stringify(result?.content);
				return feedback.includes("items[0].quotes[0]")
					? fauxAssistantMessage(openingCalls()[0], { stopReason: "toolUse" })
					: fauxAssistantMessage("Cannot identify the rejected quote.");
			},
			fauxAssistantMessage("Corrected."),
		]);
		await fixture.session.prompt("Ada must survive.");
		expect(feedback).toContain("DOMAIN_INVALID");
		expect(feedback).toContain("items[0].quotes[0]");
		expect(new BranchSource(() => fixture.manager.getBranch()).model().controlRev).toBe(1);
		expect(fixture.errors).toEqual([]);
	} finally {
		fixture.cleanup();
	}
});

test.each(["submit_outline", "write_next_chapter"])(
	"malformed JSON for %s stays rejected and returns concise input feedback",
	async (name) => {
		const fixture = await createTestSession();
		let feedback = "";
		try {
			fixture.faux.setResponses([
				fauxAssistantMessage(
					{
						...fauxToolCall(name, {}),
						argumentsError:
							'Unexpected non-whitespace character after JSON\n\nReceived arguments:\n{"brief":"ONLY_IN_REJECTED_PAYLOAD"}}',
					},
					{ stopReason: "toolUse" },
				),
				(context) => {
					feedback = JSON.stringify(context.messages.findLast((message) => message.role === "toolResult")?.content);
					return fauxAssistantMessage("Stopped.");
				},
			]);
			await fixture.session.prompt("Ada must survive.");
			const result = fixture.session.messages.find((message) => message.role === "toolResult");
			expect(result).toMatchObject({
				isError: true,
				details: { error: { code: "DOMAIN_INVALID", items: ["$"] } },
			});
			expect(feedback).toContain("JSON");
			expect(feedback).not.toContain("ONLY_IN_REJECTED_PAYLOAD");
			expect(feedback).not.toContain("Received arguments");
			expect(new BranchSource(() => fixture.manager.getBranch()).model()).toMatchObject({
				outlineRev: 0,
				lastChapter: 0,
				drafts: [],
			});
			expect(fixture.faux.state.callCount).toBe(2);
			expect(fixture.errors).toEqual([]);
		} finally {
			fixture.cleanup();
		}
	},
);

test("published bible key syntax rejects malformed keys and accepts all six core kinds", async () => {
	const fixture = await createTestSession();
	try {
		const schema = fixture.session.agent.state.tools.find((tool) => tool.name === "submit_bible")?.parameters;
		if (!schema) throw new Error("Missing bible tool");
		const pairs = [
			["character", "char:ada", "char:Ada"],
			["place", "place:harbor", "place:two words"],
			["rule", "rule:survival", "rule:must-survive"],
			["conflictLine", "line:escape", "conflictLine:escape"],
			["frameworkChoice", "fw:voice", "fw:"],
			["relationBaseline", "rel:ada->bo", "rel:ada_bo"],
		] as const;
		const items = pairs.map(([kind, key]) => {
			return { kind, key, name: "Example", source: "model", description: "Example" };
		});
		for (const [index, [, , malformed]] of pairs.entries()) {
			expect(Check(schema, { items: [items[index]] })).toBe(true);
			expect(Check(schema, { items: [{ ...items[index], key: malformed }] })).toBe(false);
		}
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("submit_bible", { items }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Established."),
		]);
		await fixture.session.prompt("Create a story.");
		const model = new BranchSource(() => fixture.manager.getBranch()).model();
		expect(model.bibleRev).toBe(1);
		expect(Object.keys(model.bible).sort()).toEqual(items.map((item) => item.key).sort());
		expect(fixture.errors).toEqual([]);
	} finally {
		fixture.cleanup();
	}
});

test("a repeated initial bible submission points to an enabled read tool and leaves the book intact", async () => {
	const fixture = await createTestSession();
	let feedback = "";
	try {
		fixture.faux.setResponses([
			fauxAssistantMessage(openingCalls(), { stopReason: "toolUse" }),
			fauxAssistantMessage(openingCalls()[1], { stopReason: "toolUse" }),
			(context) => {
				feedback = JSON.stringify(context.messages.findLast((message) => message.role === "toolResult")?.content);
				return fauxAssistantMessage("Use the existing book.");
			},
		]);
		await fixture.session.prompt("Ada must survive.");
		expect(feedback).toContain("read_story");
		expect(feedback).toContain("bible");
		expect(new BranchSource(() => fixture.manager.getBranch()).model()).toMatchObject({
			bibleRev: 1,
			outlineRev: 1,
			lastChapter: 0,
		});
		expect(fixture.errors).toEqual([]);
	} finally {
		fixture.cleanup();
	}
});
