import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { BranchSource } from "../src/entries.ts";
import type { CallObservation } from "../src/ports.ts";
import { createTestSession, draftText, keeperReply as keeper, openingCalls } from "./fixture.ts";

test("standard tool runs real core through Pi role calls and persists exactly one committed chapter", async () => {
	const observed: CallObservation[] = [];
	const fixture = await createTestSession({
		observe: (call) => {
			observed.push(call);
		},
	});
	try {
		const updates: unknown[] = [];
		fixture.session.subscribe((event) => {
			if (event.type === "tool_execution_update") updates.push(event.partialResult);
		});
		fixture.faux.setResponses([
			fauxAssistantMessage(
				[
					...openingCalls(),
					fauxToolCall("write_next_chapter", {}),
					fauxToolCall("submit_bible", { items: [] }),
					fauxToolCall("write_next_chapter", {}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				`${draftText}\n<<<写手说明>>>\nAda survives. The scene reaches the gate. The knock is the stopping point.`,
			),
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(keeper)),
			fauxAssistantMessage("Chapter one is committed. Ending this round."),
		]);
		await fixture.session.prompt("Ada must survive.");
		const results = fixture.session.messages.filter((message) => message.role === "toolResult");
		expect(results[3]).toMatchObject({
			isError: false,
			details: { schema: "story/macro-result@1", ok: true, commit: { chapter: 1, text: draftText } },
		});
		for (const result of results.slice(4))
			expect(result).toMatchObject({ isError: true, details: { error: { code: "STALE_OR_CONFLICT" } } });
		const source = new BranchSource(() => fixture.manager.getBranch());
		expect(source.model().commits).toHaveLength(1);
		expect(source.model().calls.map((call) => call.role)).toEqual(["writer", "editor", "keeper"]);
		expect(source.model().calls.reduce((sum, call) => sum + (call.usage?.totalTokens ?? 0), 0)).toBe(
			results[3]?.usage?.totalTokens,
		);
		expect(JSON.stringify(updates)).toContain(draftText);
		expect(fixture.faux.state.callCount).toBe(5);
		expect(fixture.errors).toEqual([]);
		expect(JSON.parse(observed[0].request.user)).toMatchObject({ targetWords: 100 });
		const keeperInput = JSON.parse(observed[2].request.user);
		for (const field of ["outline", "intent", "ledger", "brief", "authorIntent", "currentFocus"])
			expect(keeperInput).not.toHaveProperty(field);
		for (const call of observed) {
			expect(call.toolCallId).toBeDefined();
			expect(call.inputSources.length).toBeGreaterThan(0);
		}
		const manuscript = path.join(fixture.root, "stories/manuscripts", `${fixture.manager.getSessionId()}.md`);
		expect(readFileSync(manuscript, "utf8")).toContain(draftText);
	} finally {
		fixture.cleanup();
	}
});

test("manuscript write failure leaves the committed chapter intact in the session", async () => {
	const fixture = await createTestSession();
	try {
		writeFileSync(path.join(fixture.root, "stories"), "This file deliberately prevents directory creation.");
		fixture.faux.setResponses([
			fauxAssistantMessage([...openingCalls(), fauxToolCall("write_next_chapter", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(`${draftText}\n<<<写手说明>>>\nAda survives. The gate is reached. Stop at the knock.`),
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(keeper)),
			fauxAssistantMessage("Committed."),
		]);
		await fixture.session.prompt("Ada must survive.");
		expect(new BranchSource(() => fixture.manager.getBranch()).model().commits).toHaveLength(1);
		expect(fixture.errors).toEqual([]);
	} finally {
		fixture.cleanup();
	}
});
