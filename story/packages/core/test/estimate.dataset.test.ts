import { expect, test } from "vitest";
import { estimateInputTokens } from "../src/usage/index.ts";
import { loadDataset, record } from "./support/datasets.ts";

interface Case {
	id: string;
	text: string;
	actualInputTokens: number;
	reported: { input: number; cacheRead: number; cacheWrite: number };
}
const { data } = loadDataset<Case[]>("DS06-input-estimate", "cases.json", "v2");
test("U1 A.7 frozen DS06 billing input is never underestimated", () => {
	expect(data).toHaveLength(20);
	for (const item of data) {
		expect(item.actualInputTokens).toBe(item.reported.input + item.reported.cacheRead + item.reported.cacheWrite);
		const estimated = estimateInputTokens(item.text);
		record("estimate", { id: item.id, estimated, actual: item.actualInputTokens });
		expect(estimated, item.id).toBeGreaterThanOrEqual(item.actualInputTokens);
	}
});
