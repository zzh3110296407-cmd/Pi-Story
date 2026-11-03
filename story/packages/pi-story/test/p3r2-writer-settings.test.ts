import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { loadSettings } from "../src/ports.ts";
import { createTestSession, draftText, keeperReply } from "./fixture.ts";
import { p3Opening } from "./p3-fixture.ts";

test("S3 global setting reaches the real SDK writer without changing the committed outline", async () => {
	const writers: unknown[] = [];
	const f = await createTestSession({
		writerLengthFactor: 0.9,
		observe: ({ request }) => {
			if (request.role === "writer") writers.push(JSON.parse(request.user));
		},
	});
	try {
		f.faux.setResponses([
			fauxAssistantMessage([...p3Opening(1), fauxToolCall("write_next_chapter", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(draftText),
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(keeperReply)),
			fauxAssistantMessage("Committed."),
		]);
		await f.session.prompt("Ada must survive.");
		expect(writers).toMatchObject([{ targetWords: 90, wordRange: { min: 77, max: 104 } }]);
		expect(f.story?.current()?.source.model().outline[0].targetWords).toBe(100);
		expect(f.story?.current()?.source.model().commits).toHaveLength(1);
		expect(f.errors).toEqual([]);
	} finally {
		f.cleanup();
	}
});

test("S3 omitted settings preserve the original target; unvalidated factors cannot enter the runtime", async () => {
	const f = await createTestSession();
	try {
		expect(loadSettings(f.agentDir).effective.writerLengthFactor).toBeUndefined();
		const file = path.join(f.agentDir, "story-forge.json");
		const original = JSON.parse(readFileSync(file, "utf8"));
		for (const factor of [0, -1, 1.5, null, "0.9"]) {
			writeFileSync(file, JSON.stringify({ ...original, writerLengthFactor: factor }));
			expect(() => loadSettings(f.agentDir)).toThrow("Invalid Story global settings");
		}
	} finally {
		f.cleanup();
	}
});
