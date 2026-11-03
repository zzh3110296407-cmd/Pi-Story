import { expect, test } from "vitest";
import { locateQuote } from "../src/shared/text.ts";
import { loadDataset, record } from "./support/datasets.ts";

interface Case {
	id: string;
	messages: { kind: string; entryId: string; text: string }[];
	quote: string;
	isAuthorWords: boolean | "uncertain";
	matchesByRule: boolean;
	reason: string;
	instructionAuthority: { status: string; condition?: string; reason?: string };
}
const { data } = loadDataset<Case[]>("DS02-author-quotes", "cases.json", "v3");
test("C2 A.5 frozen DS02 quote contract and human-label measurement", () => {
	expect(data.length).toBeGreaterThanOrEqual(60);
	for (const item of data) {
		const result = locateQuote(
			item.messages.filter((m) => m.kind === "authorMessage"),
			item.quote,
		);
		record("quote", {
			id: item.id,
			expected: item.isAuthorWords,
			actual: result !== null,
			reason: item.reason,
			instructionAuthority: item.instructionAuthority,
			source: result,
		});
		expect(result !== null, item.id).toBe(item.matchesByRule);
	}
});
