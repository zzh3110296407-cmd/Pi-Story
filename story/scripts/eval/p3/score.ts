import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { foldBranch } from "@pi-story/core";
import { schemas, validate } from "../../../packages/core/src/schema/index.ts";
import { translateBranch } from "../../../packages/pi-story/src/entries.ts";
import type { HumanScore } from "../p2/score.ts";
import { wilson } from "../scorers/statistics.mjs";

interface BookSample {
	runId: string;
	entries: readonly SessionEntry[];
	target: number | null;
	askedAuthor: boolean;
	extraAuthorPrompts: number;
	requestCounts?: { chapter: number; requests: number }[];
}
const ratio = (correct: number, n: number) => ({
	correct,
	value: n ? correct / n : null,
	confidence95: wilson(correct, n),
});

export function scoreBooks(books: readonly BookSample[], judgments: HumanScore[] = []) {
	if (new Set(books.map((book) => book.runId)).size !== books.length) throw new Error("Duplicate book run IDs");
	const rows = books.map((book) => {
		if (book.target !== null && (!Number.isSafeInteger(book.target) || book.target < 1 || book.target > 10))
			throw new Error("Invalid book goal");
		const branch = translateBranch(book.entries);
		const model = foldBranch(branch);
		const chapters = new Map<number, { attempts: number; committedOn?: number; requests: number }>();
		const toolCalls: { id: string; tool: string; args: unknown; basis: string; invalid: boolean; repeated: boolean }[] =
			[];
		const recoveries: { toolCallId: string; error: unknown; next: unknown; status: "pending" }[] = [];
		let requests = 0;
		for (const [entryIndex, entry] of book.entries.entries()) {
			if (entry.type === "message" && entry.message.role === "assistant") requests++;
			if (entry.type === "message" && entry.message.role === "assistant") {
				const before = foldBranch(translateBranch(book.entries.slice(0, entryIndex)));
				const basis = JSON.stringify([
					before.canonHead,
					before.stateRev,
					before.controlRev,
					before.bibleRev,
					before.outlineRev,
					before.failures,
				]);
				for (const call of entry.message.content.filter((block) => block.type === "toolCall")) {
					const result = book.entries
						.slice(entryIndex + 1)
						.find(
							(candidate) =>
								candidate.type === "message" &&
								candidate.message.role === "toolResult" &&
								candidate.message.toolCallId === call.id,
						);
					const details =
						result?.type === "message" && result.message.role === "toolResult"
							? (result.message.details as { error?: { code?: string } } | undefined)
							: undefined;
					const macroStarted =
						result?.type === "message" &&
						result.message.role === "toolResult" &&
						validate(schemas.MacroDetails, result.message.details).ok &&
						Boolean((result.message.details as { intent?: unknown }).intent);
					const previous = toolCalls.at(-1);
					toolCalls.push({
						id: call.id,
						tool: call.name,
						args: call.arguments,
						basis,
						invalid:
							details?.error?.code === "GOAL_REACHED" || (details?.error?.code === "DOMAIN_INVALID" && !macroStarted),
						repeated: Boolean(
							previous &&
								previous.tool === call.name &&
								previous.basis === basis &&
								JSON.stringify(previous.args) === JSON.stringify(call.arguments),
						),
					});
				}
			}
			if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError) {
				const next = book.entries
					.slice(entryIndex + 1)
					.find((candidate) => candidate.type === "message" && candidate.message.role === "assistant");
				recoveries.push({
					toolCallId: entry.message.toolCallId,
					error: entry.message.details,
					next: next?.type === "message" ? next.message : null,
					status: "pending",
				});
			}
			const index = branch.findIndex((item) => item.entryId === entry.id);
			if (
				index < 0 ||
				entry.type !== "message" ||
				entry.message.role !== "toolResult" ||
				entry.message.toolName !== "write_next_chapter"
			)
				continue;
			const before = foldBranch(branch.slice(0, index));
			const chapter = before.lastChapter + 1;
			if (book.target === null || chapter > book.target) continue;
			const row = chapters.get(chapter) ?? { attempts: 0, requests: 0 };
			row.attempts++;
			const macro = validate(schemas.MacroDetails, entry.message.details);
			if (macro.ok && macro.value.ok && macro.value.commit?.chapter === chapter && !entry.message.isError) {
				row.committedOn = row.attempts;
				const actualRequests = book.requestCounts?.find((count) => count.chapter === chapter);
				if (book.requestCounts && !actualRequests)
					throw new Error("Missing actual main request count for a committed chapter");
				row.requests = actualRequests?.requests ?? requests;
				requests = 0;
			}
			chapters.set(chapter, row);
		}
		const firstGoal = branch.findIndex((entry) => entry.kind === "custom" && entry.customType === "story.goal");
		const interventions =
			firstGoal < 0
				? []
				: branch
						.slice(firstGoal + 1)
						.filter(
							(entry) =>
								entry.kind === "authorMessage" ||
								(entry.kind === "custom" && ["story.control", "story.goal"].includes(entry.customType)),
						);
		return {
			runId: book.runId,
			target: book.target,
			lastChapter: model.lastChapter,
			completed:
				book.target !== null &&
				model.lastChapter === book.target &&
				!book.askedAuthor &&
				book.extraAuthorPrompts === 0 &&
				interventions.length === 0,
			authorInterventions: interventions.length,
			chapters: [...chapters.entries()].map(([chapter, values]) => ({ chapter, ...values })),
			unattemptedChapters: book.target === null ? null : book.target - chapters.size,
			toolCalls,
			recoveries,
			riskChapters: model.commits.filter((commit) => commit.quality === "with_risk").length,
			committed: model.commits.length,
			writerInputs: model.calls
				.filter((call) => call.role === "writer")
				.map((call) => ({ id: call.id, inputTokensEstimate: call.reservedInputTokens })),
			transportFailures: model.calls.filter((call) => call.failure?.kind === "transport").length,
			recoveredTransport: model.calls.filter(
				(call) => call.retryOf && !call.failure && ["reported", "missing"].includes(call.status),
			).length,
		};
	});
	const attempts = rows.flatMap((row) => row.chapters);
	const committed = attempts.filter((chapter) => chapter.committedOn !== undefined);
	const first = ratio(attempts.filter((chapter) => chapter.committedOn === 1).length, attempts.length);
	const withinTwo = ratio(
		attempts.filter((chapter) => chapter.committedOn !== undefined && chapter.committedOn <= 2).length,
		attempts.length,
	);
	const requestLimit = ratio(committed.filter((chapter) => chapter.requests <= 14).length, committed.length);
	const completion = ratio(rows.filter((row) => row.completed).length, rows.length);
	const relevance = new Map<string, boolean>();
	for (const judgment of judgments.filter((row) => row.metric === "T04" && row.status === "author_approved")) {
		const key = JSON.stringify([judgment.runId, judgment.sampleId]);
		if (relevance.has(key)) throw new Error("Duplicate task relevance judgment");
		relevance.set(key, judgment.pass);
	}
	const allTools = rows.flatMap((row) =>
		row.toolCalls.map((call) => ({ ...call, relevant: relevance.get(JSON.stringify([row.runId, call.id])) })),
	);
	const programInvalid = allTools.filter((call) => call.invalid || call.repeated).length;
	const invalid = allTools.filter((call) => call.invalid || call.repeated || call.relevant === false).length;
	const judged = allTools.filter((call) => call.relevant !== undefined).length;
	return {
		scoringVersion: "p3-29@1",
		rows,
		metrics: [
			{
				id: "T04",
				n: allTools.length,
				programInvalid,
				programRate: allTools.length ? programInvalid / allTools.length : null,
				judged,
				invalid,
				value: judged === allTools.length && allTools.length ? invalid / allTools.length : null,
				confidence95: judged === allTools.length ? wilson(invalid, allTools.length) : null,
				minimum: 100,
				threshold: 0.1,
				passed:
					allTools.length >= 100 && (invalid / allTools.length > 0.1 || judged === allTools.length)
						? invalid / allTools.length <= 0.1
						: null,
				status: judged === allTools.length ? "measured" : "pending_task_relevance_judgments",
			},
			{
				id: "S01",
				n: rows.length,
				...completion,
				minimum: 5,
				threshold: 0.8,
				passed: rows.length >= 5 && completion.value !== null && completion.value >= 0.8,
			},
			{
				id: "S03",
				n: attempts.length,
				first,
				withinTwo,
				minimum: 40,
				thresholds: { first: 0.7, withinTwo: 0.9 },
				passed:
					attempts.length >= 40 &&
					first.value !== null &&
					first.value >= 0.7 &&
					withinTwo.value !== null &&
					withinTwo.value >= 0.9,
			},
			{
				id: "T08",
				n: committed.length,
				...requestLimit,
				minimum: 20,
				threshold: 0.95,
				passed: committed.length >= 20 && requestLimit.value !== null && requestLimit.value >= 0.95,
			},
		],
		observations: {
			S04: ratio(
				rows.reduce((sum, row) => sum + row.riskChapters, 0),
				rows.reduce((sum, row) => sum + row.committed, 0),
			),
		},
		pendingManual: ["T04-task-relevance"],
	};
}
