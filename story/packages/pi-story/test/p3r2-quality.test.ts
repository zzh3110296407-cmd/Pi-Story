import { expect, test } from "vitest";
import { type QualityJudgment, type qualitySample, scoreQuality } from "../../../scripts/eval/p3r2/quality.ts";
import { numberedLines } from "../../core/src/shared/text.ts";

test("fixed W03 ranks cannot skip an unreviewed or failed pair, and W04 needs every point in all twenty chapters", () => {
	const sample: ReturnType<typeof qualitySample> = {
		schema: "story/p3r2-quality-sample@1",
		seeds: { W03: "P3R2-W03", W04: "P3R2-W04" },
		chapters: Array.from({ length: 20 }, (_, i) => ({
			runId: "book",
			sampleId: `chapter-${i}`,
			chapter: i + 1,
			text: "Prose",
			textSha256: "digest",
			outline: null,
			intent: null,
			ledger: [],
			lines: numberedLines("Prose"),
			points: [
				{ id: "purpose", text: "Find the letter" },
				{ id: "turn", text: "Learn who wrote it" },
			],
		})),
		W03: {
			required: 60,
			rankedCandidates: Array.from({ length: 61 }, (_, i) => ({
				runId: "book",
				sampleId: `pair-${i}`,
				chapterSampleId: "chapter-0",
				chapter: 1,
				ledger: { id: "L-1", kind: "global", text: "Ada must survive", sourceSpans: [] },
			})),
			selection: "fixed",
		},
		W04: {
			requiredChapters: 20,
			selected: Array.from({ length: 20 }, (_, i) => ({ runId: "book", sampleId: `chapter-${i}` })),
			selection: "all points",
		},
	};
	const judgments: QualityJudgment[] = [
		...sample.W03.rankedCandidates.map((row, i) => ({
			...row,
			metric: "W03",
			component: "compliance",
			pass: i !== 0,
			status: "author_approved",
		})),
		...sample.chapters.flatMap((chapter) =>
			chapter.points.map((point) => ({
				runId: chapter.runId,
				sampleId: `${chapter.sampleId}:point:${point.id}`,
				metric: "W04",
				component: "coverage",
				pass: true,
				status: "author_approved",
			})),
		),
	];
	expect(scoreQuality(sample, judgments).metrics[0]).toMatchObject({ n: 60, successes: 59, value: 59 / 60 });
	expect(scoreQuality(sample, judgments.slice(1)).metrics[0]).toMatchObject({
		unreviewedBeforeSelection: 1,
		value: null,
	});
	expect(scoreQuality(sample, judgments).metrics[1]).toMatchObject({ n: 20, points: 40, value: 1, passed: true });
	expect(scoreQuality(sample, judgments.slice(0, -1)).metrics[1]).toMatchObject({ missingChapters: 1, passed: null });
	judgments[0] = { ...judgments[0], applicability: "not_applicable", pass: null };
	expect(scoreQuality(sample, judgments).metrics[0]).toMatchObject({
		n: 60,
		notApplicable: 1,
		successes: 60,
		value: 1,
	});
});
