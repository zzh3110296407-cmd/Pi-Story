import { expect, test } from "vitest";
import { sentences } from "../src/shared/text.ts";
import { loadDataset, record } from "./support/datasets.ts";

interface Document {
	id: string;
	language: string;
	split: string;
	category: string;
	sentenceRule: string;
	text: string;
	gold: number[];
}
const { data } = loadDataset<Document[]>("DS01-sentences", "documents.json", "v3");
test("A.1 s2 frozen DS01 boundaries, separately measured by language and natural Chinese", () => {
	for (const language of ["zh", "en"]) {
		let tp = 0,
			fp = 0,
			fn = 0;
		for (const doc of data.filter((item) => item.language === language)) {
			const predicted = sentences(doc.text, 1, doc.sentenceRule).map((item) => item.end);
			record("segmentation", {
				id: doc.id,
				language: doc.language,
				category: doc.category,
				sentenceRule: doc.sentenceRule,
				split: doc.split,
				gold: doc.gold,
				predicted,
			});
			const gold = new Set(doc.gold),
				actual = new Set(predicted);
			if (doc.split === "acceptance") {
				tp += [...actual].filter((n) => gold.has(n)).length;
				fp += [...actual].filter((n) => !gold.has(n)).length;
				fn += [...gold].filter((n) => !actual.has(n)).length;
			}
			if (predicted.some((n) => !gold.has(n)) || doc.gold.some((n) => !actual.has(n)))
				record("segmentation-observation", {
					id: doc.id,
					language,
					split: doc.split,
					category: doc.category,
					gold: doc.gold,
					predicted,
				});
		}
		expect(tp + fn, language).toBeGreaterThanOrEqual(300);
		expect((2 * tp) / (2 * tp + fp + fn), language).toBeGreaterThanOrEqual(0.98);
	}
	let tp = 0,
		fp = 0,
		fn = 0;
	for (const doc of data.filter(
		(item) => item.language === "zh" && item.split === "acceptance" && item.category === "natural_prose",
	)) {
		const gold = new Set(doc.gold),
			predicted = new Set(sentences(doc.text, 1, doc.sentenceRule).map((item) => item.end));
		tp += [...predicted].filter((n) => gold.has(n)).length;
		fp += [...predicted].filter((n) => !gold.has(n)).length;
		fn += [...gold].filter((n) => !predicted.has(n)).length;
	}
	expect(tp + fn, "natural Chinese acceptance").toBeGreaterThanOrEqual(300);
	expect((2 * tp) / (2 * tp + fp + fn), "natural Chinese acceptance").toBeGreaterThanOrEqual(0.98);
});
