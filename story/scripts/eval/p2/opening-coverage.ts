import type { StoryModel } from "@pi-story/core";
import { sentences } from "../../../packages/core/src/shared/text.ts";

export function openingCoverage(model: StoryModel, prompt: string) {
	const author = model.authorMessages.find((message) => message.text === prompt);
	if (!author) return { status: "author_message_not_found", uncoveredSentences: null };
	const spans = model.ledger.flatMap((item) => item.sourceSpans.filter((span) => span.messageId === author.entryId));
	// Compare actual quote text rather than normalized/raw offset coordinate systems.
	const uncoveredSentences = sentences(prompt, 1, "s2").filter(
		(sentence) => !spans.some((span) => sentence.text.includes(span.quote) || span.quote.includes(sentence.text)),
	);
	return {
		status: "observed_not_semantic_recall",
		sentenceRule: "s2",
		authorMessageId: author.entryId,
		totalSentences: sentences(prompt, 1, "s2").length,
		uncoveredSentences,
	};
}
