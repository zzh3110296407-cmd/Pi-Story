import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readEvidence } from "../p2/artifacts.ts";
import { readJudgments } from "../p2/rescore.ts";
import type { HumanScore } from "../p2/score.ts";
import { nativeEntries, scoreAllRealArchives } from "../p3/metrics.ts";
import { isoId, priorBatches, stageLedger } from "./main.ts";
import {
	assertProductMatches,
	executionSource,
	productSnapshot,
	stageRoot,
	type V5Freeze,
	writeRecord,
} from "./provenance.ts";
import { type QualityJudgment, qualitySample, scoreQuality } from "./quality.ts";
import { scoreV5Books, scoreV5Scenarios, type V5ScenarioBatch } from "./score.ts";
import { decisiveRecoveries, measuredToolCalls, scoreToolCalls, type ToolCallSample } from "./tool-calls.ts";

const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
export function aggregateV5() {
	const measurementSource = executionSource(true).source;
	const freeze = json(path.join(stageRoot, "V5.json")) as V5Freeze;
	if (freeze.schema !== "story/p3-v5@1") throw new Error("V5 freeze required");
	assertProductMatches(freeze.product, productSnapshot());
	const roots: string[] = [];
	const completeArchives: string[] = [];
	const qualityArchives: string[] = [];
	const unavailableQualityBooks: string[] = [];
	const unavailableArchives: string[] = [];
	const calls: ToolCallSample[] = [];
	const scenarios = { SCEN: [] as V5ScenarioBatch[], E2E: [] as V5ScenarioBatch[] };
	for (const suite of ["SCEN", "E2E"] as const) {
		for (const repetition of suite === "SCEN" ? [1, 2] : [1]) {
			const batches = priorBatches(suite, "acceptance", repetition);
			if (batches.length > 1) throw new Error("Fixed acceptance batch repeated");
			for (const folder of batches) {
				roots.push(folder);
				const manifest = json(path.join(folder, "manifest.json"));
				assertProductMatches(freeze.product, manifest.provenance.product);
				const results: V5ScenarioBatch["results"] = [];
				for (const expected of manifest.expected as { id: string; mode: "real" | "faux" }[]) {
					const archive = path.join(folder, expected.id);
					if (!existsSync(path.join(archive, "result.json"))) {
						unavailableArchives.push(archive);
						continue;
					}
					const result = json(path.join(archive, "result.json"));
					results.push(result);
					completeArchives.push(archive);
					qualityArchives.push(archive);
					calls.push(
						...measuredToolCalls({
							runId: `${manifest.runId}-${expected.id}`,
							suite,
							mode: expected.mode,
							entries: nativeEntries(archive),
							firstMeasuredIndex: result.firstMeasuredIndex,
						}),
					);
				}
				scenarios[suite].push({ runId: manifest.runId, repetition, expected: manifest.expected, results });
			}
		}
	}
	const books: { runId: string; folder: string }[] = [];
	const bookOutcomes: Record<string, unknown>[] = [];
	const bookBatch = priorBatches("BOOK", "acceptance", 1);
	if (bookBatch.length > 1) throw new Error("Fixed BOOK acceptance batch repeated");
	let booksFinal = false;
	for (const folder of bookBatch) {
		roots.push(folder);
		const manifest = json(path.join(folder, "manifest.json"));
		assertProductMatches(freeze.product, manifest.provenance.product);
		booksFinal = existsSync(path.join(folder, "summary.json"));
		const completionRoot = path.join(folder, "technical-completion");
		if (existsSync(completionRoot))
			for (const item of readdirSync(completionRoot, { withFileTypes: true }).filter((item) => item.isDirectory())) {
				if (
					existsSync(path.join(completionRoot, item.name, "authorization.json")) &&
					!existsSync(path.join(completionRoot, item.name, "outcome.json"))
				)
					booksFinal = false;
			}
		for (const file of readdirSync(folder).filter((name) => name.endsWith("-outcome.json"))) {
			const originalOutcome = json(path.join(folder, file));
			const completionFile = path.join(completionRoot, String(originalOutcome.id), "outcome.json");
			const outcome = existsSync(completionFile) ? json(completionFile) : originalOutcome;
			bookOutcomes.push(outcome);
			for (const attempt of outcome.attempts as { archive: string; runId: string; qualityIncluded: boolean }[]) {
				if (existsSync(path.join(attempt.archive, "raw/checksums.json"))) completeArchives.push(attempt.archive);
				else unavailableArchives.push(attempt.archive);
				if (attempt.qualityIncluded && existsSync(path.join(attempt.archive, "result.json"))) {
					books.push({ runId: attempt.runId, folder: attempt.archive });
					qualityArchives.push(attempt.archive);
					calls.push(
						...measuredToolCalls({
							runId: attempt.runId,
							suite: "BOOK",
							mode: "real",
							entries: nativeEntries(attempt.archive),
							firstMeasuredIndex: 0,
						}),
					);
				} else if (attempt.qualityIncluded) unavailableQualityBooks.push(attempt.archive);
			}
		}
	}
	if (unavailableQualityBooks.length) booksFinal = false;
	const judgmentRoots = [...roots, ...books.map((book) => book.folder)];
	const judgments: HumanScore[] = judgmentRoots.flatMap((folder) => readJudgments(folder, "P3"));
	const allKeys = judgments.map((row) => JSON.stringify([row.runId, row.metric, row.component, row.sampleId]));
	if (new Set(allKeys).size !== allKeys.length) throw new Error("Judgment duplicated across archives");
	const bookRecoveries = books.flatMap((book) =>
		decisiveRecoveries(nativeEntries(book.folder), 0).map((row) => ({
			...row,
			runId: book.runId,
			hasNextDecision: Boolean(row.next),
		})),
	);
	const quality = qualitySample(books.map((book) => ({ runId: book.runId, entries: nativeEntries(book.folder) })));
	const qualityJudgments = judgmentRoots.flatMap((folder) => {
		const directory = path.join(folder, "judgments");
		return existsSync(directory)
			? readdirSync(directory)
					.filter((name) => name.endsWith(".json"))
					.flatMap((name) =>
						(json(path.join(directory, name)).scores as QualityJudgment[]).filter((row) =>
							["W03", "W04"].includes(row.metric),
						),
					)
			: [];
	});
	const real = qualityArchives.length ? scoreAllRealArchives([...new Set(qualityArchives)]) : null;
	const allRealHard = completeArchives.length ? scoreAllRealArchives([...new Set(completeArchives)]) : null;
	if (allRealHard && unavailableArchives.length) {
		for (const metric of allRealHard.metrics) {
			if (metric.passed !== false) metric.passed = null;
			metric.status = "unavailable_raw_evidence_retained";
		}
	}
	const bookScore = books.length ? scoreV5Books(books, judgments) : null;
	if (bookScore && unavailableQualityBooks.length) for (const metric of bookScore.metrics) metric.passed = null;
	const view = {
		schema: "story/p3r2-acceptance-view@1",
		scoringVersion: "p3r2-32@1",
		measurementSource,
		freezeCommit: freeze.commit,
		scenarios: {
			SCEN: scoreV5Scenarios("SCEN", scenarios.SCEN, judgments, bookRecoveries),
			E2E: scoreV5Scenarios("E2E", scenarios.E2E, judgments),
		},
		T04: scoreToolCalls(calls, judgments),
		books: bookScore,
		bookOutcomes,
		booksFinal,
		unavailableArchives,
		unavailableQualityBooks,
		qualityFinal: booksFinal,
		quality: scoreQuality(quality, qualityJudgments),
		real,
		allRealHard,
		opening: (freeze as V5Freeze & { opening?: unknown }).opening ?? null,
		fees: stageLedger().snapshot(),
		queueLatencies: qualityArchives.flatMap((folder) => {
			const records = readEvidence(folder, true);
			return records.flatMap((row, index) => {
				const input = row.type === "driver_input" ? (row.input as { type?: string; text?: string }) : undefined;
				if (input?.type !== "followUp") return [];
				const activation = records.slice(index + 1).find((candidate) => {
					const event =
						candidate.type === "session_event"
							? (candidate.event as {
									type?: string;
									message?: { role?: string; content?: string | { type: string; text?: string }[] };
								})
							: undefined;
					const content = event?.message?.content;
					return (
						event?.type === "message_end" &&
						event.message?.role === "user" &&
						(typeof content === "string"
							? content
							: content
									?.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("\n")) === input.text
					);
				});
				return [
					{
						folder,
						emittedAt: row.observedAt ?? null,
						activatedAt: activation?.observedAt ?? null,
						delayMs:
							typeof row.observedAt === "number" && typeof activation?.observedAt === "number"
								? activation.observedAt - row.observedAt
								: null,
					},
				];
			});
		}),
	};
	const folder = path.join(stageRoot, "P3R2-ACCEPTANCE", `${isoId()}-${freeze.commit.slice(0, 7)}`);
	mkdirSync(folder, { recursive: true });
	writeRecord(path.join(folder, "view.json"), view);
	writeRecord(path.join(folder, "T04-samples.json"), { samples: calls });
	writeRecord(path.join(folder, "BOOK-T03-samples.json"), { samples: bookRecoveries });
	if (booksFinal) writeRecord(path.join(folder, "quality-sample.json"), quality);
	const handoff = [
		"# P3R2 J3 独立判定交接",
		"",
		`V5产品提交：${freeze.commit}；评分p3r2-32@1。离线视图：${folder}。`,
		"",
		'仅判本轮正式验收，不改V4记录，不调用付费测量模型。初判ai_preliminary，作者整体认可后author_approved并附approval.evidence。沿用story/p2-judgments@1/@2和readJudgments(folder,"P3")；详细理由放judgments/support。',
		"",
		"- T02/decision：每个SCEN场景的决定性动作与全部禁止条件。sampleId=场景id，runId=整轮manifest.runId；读取超过3次或请求上限无决定必须失败，传输缺测保留。",
		"- T03/recovery：SCEN的G/H/I/J/L，sampleId=场景id、runId=整轮；BOOK见BOOK-T03-samples.json的runId/sampleId，取下一决定性动作，无后续决定保留缺测。",
		"- T04/relevance：T04-samples.json保留全部真实模式调用作分母；只判invalid=false、repeated=false、hostDeferred=false的项。使用逐项runId和sampleId（原生助手entryId:toolCallId）；程序无效/重复与无关取并集，不要求裁判重复确认已知无效。",
		"- S09/effect：E2E的场景id:check:零起始索引，runId=整轮；逐字不可证明的输入可见性用S09/program、场景id:program:索引。程序failed不能用认可覆盖；首次写手请求边界不因后续成功改变。",
		booksFinal
			? "- W03/compliance：quality-sample.json按P3R2-W03固定顺序核对适用性，取前60对适用项；不适用须@2保留null、理由，不能因失败换样。W04/coverage：P3R2-W04固定20章，sampleId=chapter sampleId:point:point.id；purpose、turn、hookSeeds所有非空项逐项判定，复合项所有要求实现才通过。正文行号和意图均保留。"
			: "- BOOK未全部归档，W03/W04正式抽样尚未冻结，不判临时样本。",
		"",
		"正式批次：",
		...roots.map((root) => `- ${root}`),
		"",
		"现有未判项和缺测均保持，不推定作者已认可运行结果。后续材料会更新同一交接文件，已认可样本不重复判定。",
		"",
	].join("\n");
	writeFileSync(path.join(stageRoot, "P3R2-J3-handoff.md"), handoff);
	console.log(JSON.stringify({ folder, fees: view.fees, bookCount: books.length, booksFinal }));
	return view;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) aggregateV5();
