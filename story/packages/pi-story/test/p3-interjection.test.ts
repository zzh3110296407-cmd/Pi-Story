import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { BranchSource } from "../src/entries.ts";
import { createTestSession, draftText, keeperReply } from "./fixture.ts";
import { p3Opening } from "./p3-fixture.ts";

test.each(["steer", "followUp"] as const)(
	"P3 %s during keeper uses the real input event and commit gate",
	async (behavior) => {
		const f = await createTestSession();
		try {
			f.faux.setResponses([
				fauxAssistantMessage([...p3Opening(), fauxToolCall("write_next_chapter", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage(draftText),
				fauxAssistantMessage('{"observations":[]}'),
				async () => {
					await f.session.prompt("Ada must investigate the red boat next.", { streamingBehavior: behavior });
					return fauxAssistantMessage(JSON.stringify(keeperReply));
				},
				fauxAssistantMessage("New requirement received."),
				fauxAssistantMessage("Done."),
			]);
			await f.session.prompt("Ada must survive.");
			const macro = f.session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "write_next_chapter",
			);
			const model = new BranchSource(() => f.manager.getBranch()).model();
			if (behavior === "steer") {
				expect(macro).toMatchObject({
					isError: true,
					details: { error: { code: "INTERJECTED" }, interjectionSeq: { atStart: 0, atCommit: 1 } },
				});
				expect(model.commits).toHaveLength(0);
			} else {
				expect(macro).toMatchObject({
					isError: false,
					details: { ok: true, interjectionSeq: { atStart: 0, atCommit: 0 } },
				});
				expect(model.commits).toHaveLength(1);
			}
			expect(f.errors).toEqual([]);
		} finally {
			f.cleanup();
		}
	},
);
