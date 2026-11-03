import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { foldBranch, type IntentDetails, type OutlineDetails } from "@pi-story/core";
import { schemas, validate } from "../../../packages/core/src/schema/index.ts";
import { numberedLines } from "../../../packages/core/src/shared/text.ts";
import { translateBranch } from "../../../packages/pi-story/src/entries.ts";
import { sha256 } from "../p2/artifacts.ts";
import { wilson } from "../scorers/statistics.mjs";

interface Chapter {
	runId: string;
	sampleId: string;
	chapter: number;
	text: string;
	textSha256: string;
	outline: OutlineDetails["chapters"][number] | null;
	intent: IntentDetails | null;
	points: { id: string; text: string }[];
	ledger: ReturnType<typeof foldBranch>["ledger"];
}
interface LedgerPair {
	runId: string;
	sampleId: string;
	chapterSampleId: string;
	chapter: number;
	ledger: Chapter["ledger"][number];
}
export interface QualityJudgment {
	metric: string;
	component: string;
	runId: string;
	sampleId: string;
	pass: boolean | null;
	status: string;
	applicability?: string;
}
const rank = <T extends { runId: string; sampleId: string }>(rows: T[], seed: string) =>
	[...rows].sort((a, b) =>
		sha256(`${seed}:${a.runId}:${a.sampleId}`).localeCompare(sha256(`${seed}:${b.runId}:${b.sampleId}`)),
	);

export function qualitySample(books: { runId: string; entries: readonly SessionEntry[] }[]) {
	const chapters: Chapter[] = books.flatMap((book) =>
		book.entries.flatMap((entry, index) => {
			if (entry.type !== "message" || entry.message.role !== "toolResult") return [];
			const macro = validate(schemas.MacroDetails, entry.message.details);
			if (!macro.ok || !macro.value.ok || !macro.value.commit) return [];
			const commit = macro.value.commit;
			const before = foldBranch(translateBranch(book.entries.slice(0, index)));
			return [
				{
					runId: book.runId,
					sampleId: `${entry.id}:chapter`,
					chapter: commit.chapter,
					text: commit.text,
					textSha256: sha256(commit.text),
					outline: before.outline.find((chapter) => chapter.n === commit.chapter) ?? null,
					intent: macro.value.intent ?? null,
					points: outlinePoints(before.outline.find((chapter) => chapter.n === commit.chapter)),
					ledger: before.ledger,
				},
			];
		}),
	);
	if (new Set(chapters.map((row) => JSON.stringify([row.runId, row.sampleId]))).size !== chapters.length)
		throw new Error("Duplicate quality chapter");
	const ledgerPairs: LedgerPair[] = chapters.flatMap((chapter) =>
		chapter.ledger.map((ledger) => ({
			runId: chapter.runId,
			sampleId: `${chapter.sampleId}:ledger:${ledger.id}`,
			chapterSampleId: chapter.sampleId,
			chapter: chapter.chapter,
			ledger,
		})),
	);
	return {
		schema: "story/p3r2-quality-sample@1",
		seeds: { W03: "P3R2-W03", W04: "P3R2-W04" },
		chapters: chapters.map((chapter) => ({ ...chapter, lines: numberedLines(chapter.text) })),
		W03: {
			required: 60,
			rankedCandidates: rank(ledgerPairs, "P3R2-W03"),
			selection:
				"First 60 applicable pairs in fixed rank; applicability must be reviewed in rank order, independently of pass/fail.",
		},
		W04: {
			requiredChapters: 20,
			selected: rank(chapters, "P3R2-W04")
				.slice(0, 20)
				.map(({ runId, sampleId }) => ({ runId, sampleId })),
			selection:
				"Every nonempty outline purpose, turn and hookSeeds item in each selected chapter; intent is retained as context. Composite items pass only when all of their requirements are covered.",
		},
	};
}

function outlinePoints(outline: Chapter["outline"] | undefined) {
	return [
		...(outline?.purpose ? [{ id: "purpose", text: outline.purpose }] : []),
		...(outline?.turn ? [{ id: "turn", text: outline.turn }] : []),
		...(outline?.hookSeeds ?? []).map((text, index) => ({ id: `hookSeeds-${index}`, text })),
	];
}

export function scoreQuality(sample: ReturnType<typeof qualitySample>, judgments: QualityJudgment[]) {
	const approved = judgments.filter((row) => row.status === "author_approved");
	const key = (row: { runId: string; sampleId: string }) => JSON.stringify([row.runId, row.sampleId]);
	const ledger = new Map<string, QualityJudgment>();
	for (const row of approved.filter((row) => row.metric === "W03")) {
		if (ledger.has(key(row))) throw new Error("Duplicate W03 judgment");
		ledger.set(key(row), row);
	}
	const selected: QualityJudgment[] = [];
	let unreviewedBeforeSelection = 0;
	let notApplicable = 0;
	for (const pair of sample.W03.rankedCandidates) {
		if (selected.length === 60) break;
		const row = ledger.get(key(pair));
		if (!row) {
			unreviewedBeforeSelection++;
			continue;
		}
		if (row.applicability === "not_applicable") {
			notApplicable++;
			continue;
		}
		if (typeof row.pass !== "boolean") throw new Error("Applicable W03 judgment needs a boolean result");
		selected.push(row);
	}
	const successes = selected.filter((row) => row.pass).length;
	const points = sample.W04.selected.map((chapter) => {
		const expected = sample.chapters.find((candidate) => key(candidate) === key(chapter))?.points ?? [];
		const scores = expected.map((point) => {
			const rows = approved.filter(
				(row) =>
					row.metric === "W04" &&
					row.runId === chapter.runId &&
					row.sampleId === `${chapter.sampleId}:point:${point.id}`,
			);
			if (rows.length > 1) throw new Error("Duplicate W04 point judgment");
			return rows[0];
		});
		return {
			...chapter,
			expected,
			scores: scores.filter((row): row is QualityJudgment => Boolean(row)),
			missing: !expected.length || scores.some((row) => !row),
		};
	});
	const missingChapters = points.filter((chapter) => chapter.missing).length;
	const allPoints = points.flatMap((chapter) => chapter.scores);
	if (allPoints.some((row) => typeof row.pass !== "boolean"))
		throw new Error("W04 full point list cannot silently exclude points");
	const realized = allPoints.filter((row) => row.pass).length;
	return {
		scoringVersion: "p3r2-32@1",
		metrics: [
			{
				id: "W03",
				n: selected.length,
				successes,
				notApplicable,
				unreviewedBeforeSelection,
				minimum: 60,
				threshold: 0.9,
				value: selected.length === 60 && !unreviewedBeforeSelection ? successes / 60 : null,
				confidence95: selected.length === 60 && !unreviewedBeforeSelection ? wilson(successes, 60) : null,
				passed: selected.length === 60 && !unreviewedBeforeSelection ? successes / 60 >= 0.9 : null,
			},
			{
				id: "W04",
				n: points.length,
				points: allPoints.length,
				successes: realized,
				missingChapters,
				minimum: 20,
				threshold: 0.8,
				value: !missingChapters && allPoints.length ? realized / allPoints.length : null,
				confidence95: !missingChapters && allPoints.length ? wilson(realized, allPoints.length) : null,
				passed:
					points.length === 20 && !missingChapters && allPoints.length ? realized / allPoints.length >= 0.8 : null,
			},
		],
		W03: { selected },
		W04: { chapters: points },
	};
}
