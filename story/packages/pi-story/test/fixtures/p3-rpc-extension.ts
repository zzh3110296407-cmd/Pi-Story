import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installStory } from "../../src/index.ts";
import { p3Chapter, p3Opening } from "../p3-fixture.ts";

export default function extension(pi: ExtensionAPI): void {
	const faux = fauxProvider({ models: [{ id: "script", contextWindow: 1_000_000, maxTokens: 32768 }] });
	faux.setResponses(
		process.env.PI_STORY_P3_RPC_BOOK === "1"
			? [
					fauxAssistantMessage([...p3Opening(), fauxToolCall("write_next_chapter", {})], { stopReason: "toolUse" }),
					...p3Chapter().slice(1),
					...p3Chapter(),
					...p3Chapter(),
				]
			: [
					fauxAssistantMessage(p3Opening(), { stopReason: "toolUse" }),
					fauxAssistantMessage("Book open."),
					...p3Chapter(),
					...p3Chapter(),
					...p3Chapter(),
					fauxAssistantMessage(
						fauxToolCall("ask_author", { question: "Harbor or mountains?", options: ["Harbor", "Mountains"] }),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("Author selected mountains."),
				],
	);
	pi.registerProvider(faux.provider);
	installStory(pi);
}
