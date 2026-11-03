import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { draftText, keeperReply, openingCalls } from "./fixture.ts";

export function p3Opening(chapters = 3) {
	return [
		...openingCalls().slice(0, 2),
		fauxToolCall("submit_outline", {
			viewpoint: "third person",
			tone: "tense",
			chapters: Array.from({ length: chapters }, (_, i) => ({
				n: i + 1,
				title: `Harbor ${i + 1}`,
				targetWords: 100,
				points: ["Ada explores the harbor", "Ada finds another clue"],
			})),
		}),
	];
}
export function p3Chapter() {
	return [
		fauxAssistantMessage(fauxToolCall("write_next_chapter", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(draftText),
		fauxAssistantMessage('{"observations":[]}'),
		fauxAssistantMessage(JSON.stringify(keeperReply)),
		fauxAssistantMessage("Chapter committed."),
	];
}
