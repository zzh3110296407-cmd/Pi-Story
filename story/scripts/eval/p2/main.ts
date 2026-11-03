import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BranchEntry } from "@pi-story/core";
import { wordCount } from "../../../packages/core/src/shared/text.ts";
import { estimateInputTokens } from "../../../packages/core/src/usage/index.ts";
import { PI_COMMIT, piModelOverrides, settingsTemplate } from "../../prepare-p2.mjs";
import { EvidenceArchive, publicEvidence, readEvidence, sha256 } from "./artifacts.ts";
import { type ContextCase, contextInput, contextPredicates } from "./context.mjs";
import { openingPrompts, type Split, splitDataset } from "./datasets.ts";
import { createDriver } from "./driver.ts";
import { UsageLedger } from "./ledger.ts";
import { P2_LIMITS } from "./metering.ts";
import { evaluationSettings, MODEL_SETTINGS, type ModelSetting } from "./model-settings.ts";
import { openingCoverage } from "./opening-coverage.ts";
import { scoreProgram } from "./program-score.ts";
import { aggregateScores, allRealScores, readJudgments, rescoreRun } from "./rescore.ts";
import { runEditTask, runKeeperTask } from "./roles.ts";
import { evaluationRound } from "./round.ts";
import { RunControl } from "./run-control.ts";
import { scoreEvidence } from "./score.ts";
import { scoreEvidenceV2 } from "./score-v2.ts";
import { scoreEvidenceV3 } from "./score-v3.ts";
import { scanSecrets } from "./secrets.mjs";

const repository = path.resolve(import.meta.dirname, "../../../..");
const story = path.join(repository, "story");
const testRoot = path.join(story, "testing");
const round = evaluationRound(process.argv);
const stage = round.stage;
const round3Mode = stage === "P2R3";
const repairMode = stage !== "P2";
const runsRoot = path.join(testRoot, "runs", stage);
const workRoot = process.env.PI_STORY_WORK_DIR ?? path.join(repository, "story/testing/exec");
const resultsRoot = "D:/AI/Story Dome/新版综合方案/测试结果/P2/套件结果";
type PaidSuite = "P2-OPEN" | "P2-CHAP" | "P2-KEEP" | "P2-EDIT";
const paidSuites: readonly PaidSuite[] = round3Mode
	? ["P2-OPEN", "P2-CHAP", "P2-KEEP"]
	: ["P2-OPEN", "P2-CHAP", "P2-KEEP", "P2-EDIT"];
const json = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const write = (file: string, value: unknown) => {
	const text = `${JSON.stringify(value, null, 2)}\n`;
	publicEvidence(text);
	writeFileSync(file, text);
};
function git(...args: string[]) {
	const result = spawnSync("git", ["--no-optional-locks", ...args], {
		cwd: repository,
		windowsHide: true,
		encoding: "utf8",
	});
	if (result.status !== 0) throw new Error("Git evidence unavailable");
	return result.stdout.trim();
}
function provenance(freeze?: string) {
	const evidenceHead = git("rev-parse", "HEAD");
	if (
		freeze &&
		(!/^[a-f0-9]{40}$/u.test(freeze) ||
			git("diff", "--name-only", freeze, "HEAD", "--", ".", ":(exclude)story/testing/runs"))
	)
		throw new Error("Source differs from the frozen commit");
	const commit = freeze ?? evidenceHead;
	const dirty =
		git("status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude)story/testing/runs") !== "";
	const rules = ["story-long-writing", "story-review-matrix", "story-state-projection", "story-showrunner"].map(
		(name) => {
			const relative = `story/packages/pi-story/rules/${name}/SKILL.md`;
			const bytes = readFileSync(path.join(repository, relative));
			return {
				path: relative,
				sha256: sha256(bytes),
				characters: bytes.toString("utf8").length,
				estimatedTokens: estimateInputTokens(bytes.toString("utf8")),
			};
		},
	);
	const templates = [
		"story/packages/core/src/flow/inputs.ts",
		"story/packages/core/src/flow/calls.ts",
		"story/scripts/prepare-p2.mjs",
		"story/scripts/eval/p2/model-settings.ts",
	].map((relative) => ({ path: relative, sha256: sha256(readFileSync(path.join(repository, relative))) }));
	const build = json(path.join(workRoot, "pi-build.json")) as {
		commit: string;
		built: boolean;
		modelSnapshot: unknown;
	};
	if (build.commit !== PI_COMMIT || !build.built) throw new Error("Fixed Pi build is not ready");
	return {
		repositoryCommit: commit,
		evidenceHead,
		dirty,
		rules,
		templates,
		piBuild: build,
		settings: settingsTemplate(workRoot),
		modelOverrides: piModelOverrides(),
		nodeVersion: process.version,
	};
}
function ledger() {
	return new UsageLedger(
		path.join(runsRoot, "usage-ledger.jsonl"),
		path.join(runsRoot, "request-reservations.jsonl"),
		round.limits,
	);
}
function summary(suiteId: string, runId: string, manifest: unknown, metrics: unknown) {
	mkdirSync(resultsRoot, { recursive: true });
	writeFileSync(
		path.join(resultsRoot, `${repairMode ? `${stage}-` : ""}${suiteId}-${runId}.md`),
		`# ${suiteId}\n\n运行ID：${runId}。真实请求与费用以manifest/raw为准，开发运行不作为验收。缺失人工判定时保持待判定。\n\n记录：${path.join(runsRoot, suiteId, runId)}\n\n\`\`\`json\n${JSON.stringify({ manifest, metrics }, null, 2)}\n\`\`\`\n`,
	);
}
export async function runPaid(
	suiteId: PaidSuite,
	options: {
		split: Split;
		smoke: boolean;
		repetition: number;
		freeze?: string;
		caseId?: string;
		modelSetting?: ModelSetting;
	},
) {
	if (!repairMode) throw new Error("Historical P2 runs are read-only; use --repair for the authorized repair round");
	if (round3Mode && (suiteId === "P2-EDIT" || options.modelSetting))
		throw new Error("Round three freezes editor and all model settings; no EDIT or comparison run");
	if (options.modelSetting && options.split !== "development")
		throw new Error("Model comparisons are development only");
	const source = provenance(options.freeze);
	const configured = evaluationSettings(workRoot, suiteId, options.modelSetting);
	source.settings = configured.settings;
	const phase = options.split === "acceptance" ? "E13" : "E12";
	if (phase === "E13" && (source.dirty || source.repositoryCommit !== options.freeze))
		throw new Error("E13 requires the exact freeze commit and a clean source tree");
	if (options.smoke && phase !== "E12") throw new Error("Smoke is development only");
	if (options.caseId && phase !== "E12") throw new Error("Individual case selection is development only");
	if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is absent; no model request made");
	const fees = ledger();
	if (fees.snapshot().totalUsd >= fees.limits.stopUsd) throw new Error("Repair fee stop threshold reached");
	const directory =
		suiteId === "P2-KEEP" ? "DS09-state-gold" : suiteId === "P2-EDIT" ? "DS10-review-defects" : "DS08-opening-prompts";
	const data = splitDataset(
		testRoot,
		directory,
		options.split === "acceptance" ? (suiteId === "P2-KEEP" || suiteId === "P2-EDIT" ? "v3" : "v2") : "v1",
		options.split,
		phase,
		repairMode && options.split === "development" && !(round3Mode && suiteId === "P2-CHAP"),
		options.split === "development" && (suiteId === "P2-KEEP" || suiteId === "P2-EDIT") ? "v3" : undefined,
	);
	const prompts = suiteId === "P2-OPEN" || suiteId === "P2-CHAP" ? openingPrompts(data, suiteId === "P2-CHAP") : [];
	const entryFiles = data.files.filter((file) => /^(dev|acceptance)\/entries\/[^/]+\.json$/u.test(file.path));
	let cases = prompts.length
		? prompts.map((prompt) => ({
				id: String(prompt.id),
				prompt: prompt.prompt,
				entry: undefined as string | undefined,
			}))
		: entryFiles.map((file) => ({ id: path.basename(file.path, ".json"), prompt: "", entry: file.path }));
	if (options.caseId) cases = cases.filter((scenario) => scenario.id === options.caseId);
	if (options.smoke) cases = cases.slice(0, 1);
	if (!cases.length) throw new Error("Frozen split contains no executable cases");
	const stamp = new Date()
		.toISOString()
		.replace(/[-:]/gu, "")
		.replace(/\.\d{3}Z$/u, "Z");
	const runId = `${stamp}-${source.repositoryCommit.slice(0, 7)}-${options.smoke ? "smoke" : options.split === "development" ? "dev" : `r${options.repetition}`}${source.dirty ? "-dirty" : ""}`;
	const folder = path.join(runsRoot, suiteId, runId);
	const work = path.join(workRoot, "runs", suiteId, runId);
	const archive = new EvidenceArchive(folder, path.join(work, "archive"), {
		suiteId,
		runId,
		stage,
		expectedCaseIds: cases.map((item) => item.id),
		split: options.split,
		phase,
		repetition: options.repetition,
	});
	const started = Date.now();
	archive.emit({
		type: "configuration",
		...source,
		showrunner: configured.showrunner,
		comparisonSetting: options.modelSetting,
	});
	const runLimitUsd = options.smoke ? 1 : 3;
	const caseFailures: { caseId: string; code: string }[] = [];
	const control = new RunControl();
	const manifest = {
		schema: "story/run-manifest@2",
		suiteId,
		runId,
		stage,
		date: new Date().toISOString(),
		...source,
		showrunner: configured.showrunner,
		comparisonSetting: options.modelSetting,
		split: options.split,
		phase,
		smoke: options.smoke,
		selectedCaseId: options.caseId ?? null,
		repetition: options.repetition,
		datasets: [
			{
				id: data.manifest.id,
				version: data.manifest.version,
				manifestDigest: data.manifestDigest,
				annotationStatus: data.manifest.annotationStatus,
				...(data.inputOverride ? { inputOverride: data.inputOverride } : {}),
			},
		],
		driverLimits: { ...P2_LIMITS, runLimitUsd },
		status: "running",
		costs: fees.snapshot(runId),
		totalP2Costs: fees.snapshot(),
		elapsedMs: 0,
		rawChecksums: {},
		caseFailures,
		fatalProviderError: undefined as RunControl["fatal"],
	};
	write(path.join(folder, "run-manifest.json"), manifest);
	let failure: string | undefined;
	try {
		for (const scenario of cases) {
			control.assertActive();
			console.log(`${suiteId} ${runId}: ${scenario.id}`);
			const maxChapters = options.smoke ? 1 : options.split === "development" ? 3 : 4;
			const driver = await createDriver({
				work: path.join(work, sha256(scenario.id).slice(0, 16)),
				runId,
				suiteId,
				caseId: scenario.id,
				archive,
				ledger: fees,
				runLimitUsd,
				phase,
				maxChapters,
				control,
				modelSetting: options.modelSetting,
			});
			let cancelled = false;
			const stop = () => {
				if (cancelled) return;
				cancelled = true;
				archive.emit({ type: "measurement_stop", caseId: scenario.id, reason: "operator cancellation" });
				driver.cancel();
			};
			const stopFile = path.join(work, "STOP");
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
			watchFile(stopFile, { interval: 500, persistent: false }, () => {
				if (existsSync(stopFile)) stop();
			});
			try {
				if (scenario.entry) {
					const entries = data.json(scenario.entry) as BranchEntry[];
					if (!Array.isArray(entries)) throw new Error("Frozen entries must be an array");
					const chapterMatch = /-c(\d+)(?:-|$)/u.exec(scenario.id);
					if (!chapterMatch) throw new Error("Frozen case has no chapter number");
					const chapter = Number(chapterMatch[1]);
					if (suiteId === "P2-KEEP") {
						const result = await runKeeperTask(driver, archive, {
							id: scenario.id,
							chapter,
							entries,
							text: data.text(scenario.entry.replace("/entries/", "/chapters/").replace(/\.json$/u, ".md")),
						});
						if (!result.ok) caseFailures.push({ caseId: scenario.id, code: result.error.code });
					} else {
						const result = await runEditTask(driver, archive, { id: scenario.id, chapter, entries });
						if (!result.ok) caseFailures.push({ caseId: scenario.id, code: result.error?.code ?? "EDIT_UNAVAILABLE" });
					}
				} else {
					// The original DS08 author prompt is passed without additions.
					archive.emit({ type: "author_prompt", caseId: scenario.id, text: scenario.prompt });
					await driver.session.prompt(scenario.prompt);
					if (suiteId === "P2-CHAP")
						for (
							let round = 1;
							driver.state().source.model().lastChapter < maxChapters && round < P2_LIMITS.authorRounds;
							round++
						) {
							if (cancelled) break;
							archive.emit({ type: "author_prompt", caseId: scenario.id, text: "Write the next chapter." });
							await driver.session.prompt("Write the next chapter.");
						}
					const model = driver.state().source.model();
					if (repairMode && suiteId === "P2-OPEN")
						archive.emit({
							type: "ledger_quote_coverage",
							caseId: scenario.id,
							...openingCoverage(model, scenario.prompt),
						});
					if (!model.controlRev || !model.bibleRev || !model.outlineRev)
						caseFailures.push({ caseId: scenario.id, code: "OPENING_INCOMPLETE" });
					if (suiteId === "P2-CHAP" && model.lastChapter < maxChapters)
						caseFailures.push({ caseId: scenario.id, code: "CHAPTER_TARGET_NOT_REACHED" });
					const attempts: Record<string, number> = {};
					for (const entry of driver.manager.getBranch())
						if (entry.type === "message" && entry.message.role === "toolResult")
							attempts[entry.message.toolName] = (attempts[entry.message.toolName] ?? 0) + 1;
					archive.emit({
						type: "opening_result",
						caseId: scenario.id,
						model: { controlRev: model.controlRev, bibleRev: model.bibleRev, outlineRev: model.outlineRev },
						attempts,
						entries: driver.state().source.branch(),
					});
					for (const commit of model.commits)
						archive.emit({
							type: "chapter_result",
							caseId: scenario.id,
							chapter: commit.chapter,
							targetWords: model.outline.find((chapter) => chapter.n === commit.chapter)?.targetWords,
							wordCount: wordCount(commit.text).value,
							commit,
						});
					archive.emit({
						type: "story_result",
						caseId: scenario.id,
						requestedChapters: suiteId === "P2-CHAP" ? maxChapters : 0,
						committedChapters: model.lastChapter,
						risks: model.commits.map((commit) => commit.quality),
					});
				}
				if (driver.errors.length) throw new Error("Pi extension reported an execution error");
				control.assertActive();
				if (cancelled) throw new Error("Measurement cancelled; finished usage and unfinished reservations retained");
			} finally {
				process.off("SIGINT", stop);
				process.off("SIGTERM", stop);
				unwatchFile(stopFile);
				driver.close();
			}
		}
	} catch (cause) {
		failure = cause instanceof Error ? cause.message : String(cause);
		publicEvidence(failure);
		archive.emit({ type: "run_failure", diagnostic: failure });
	} finally {
		manifest.rawChecksums = archive.finish();
		manifest.fatalProviderError = control.fatal;
		manifest.costs = fees.snapshot(runId);
		manifest.totalP2Costs = fees.snapshot();
		manifest.elapsedMs = Date.now() - started;
		manifest.status = failure ? "failed" : caseFailures.length ? "measured_with_failures" : "measured_pending_gates";
		write(path.join(folder, "run-manifest.json"), manifest);
	}
	const metrics = round3Mode
		? scoreEvidenceV3(readEvidence(folder, true), readJudgments(folder))
		: repairMode
			? scoreEvidenceV2(readEvidence(folder, true), readJudgments(folder))
			: scoreEvidence(readEvidence(folder), readJudgments(folder));
	write(path.join(folder, "metrics.json"), metrics);
	const scan = scanSecrets([folder], repository);
	write(path.join(folder, "secret-scan.json"), scan);
	if (!scan.passed) {
		manifest.status = "failed";
		failure ??= "Run evidence failed secret scanning";
		write(path.join(folder, "run-manifest.json"), manifest);
	}
	summary(suiteId, runId, manifest, metrics);
	console.log(
		JSON.stringify({
			folder,
			status: manifest.status,
			costs: manifest.costs,
			totalP2Costs: manifest.totalP2Costs,
			failure,
		}),
	);
	return { folder, manifest, metrics };
}

export function runContext(split: Split, freeze?: string) {
	const source = provenance(freeze);
	if (split === "acceptance" && (source.dirty || source.repositoryCommit !== freeze))
		throw new Error("Context acceptance requires the clean freeze commit");
	const data = splitDataset(testRoot, "DS12-context-cases", "v2", split, split === "acceptance" ? "E13" : "E12");
	const files = data.files.filter((file) => file.path.endsWith(".json"));
	const stamp = new Date()
		.toISOString()
		.replace(/[-:]/gu, "")
		.replace(/\.\d{3}Z$/u, "Z");
	const runId = `${stamp}-${source.repositoryCommit.slice(0, 7)}-${split === "development" ? "dev" : "acceptance"}${source.dirty ? "-dirty" : ""}`;
	const folder = path.join(runsRoot, "P2-CTX", runId);
	const cases = files.map((file) => data.json(file.path) as ContextCase);
	const archive = new EvidenceArchive(folder, path.join(workRoot, "runs/P2-CTX", runId), {
		suiteId: "P2-CTX",
		stage,
		runId,
		expectedCaseIds: cases.map((scenario) => scenario.id),
		split,
	});
	archive.emit({
		type: "configuration",
		...source,
		dataset: { id: data.manifest.id, version: data.manifest.version, manifestDigest: data.manifestDigest },
	});
	for (const scenario of cases) {
		try {
			const input = contextInput(scenario);
			archive.emit({ type: "context_input", caseId: scenario.id, input });
			archive.emit({
				type: "context_result",
				caseId: scenario.id,
				must: contextPredicates(input, scenario.must),
				forbidden: contextPredicates(input, scenario.forbidden),
			});
		} catch (cause) {
			const error = cause instanceof Error ? cause.message : "Context construction failed";
			publicEvidence(error);
			archive.emit({ type: "context_result", caseId: scenario.id, must: [], forbidden: [], error });
		}
	}
	const rawChecksums = archive.finish();
	const metrics = round3Mode ? scoreEvidenceV3(readEvidence(folder), []) : scoreEvidence(readEvidence(folder), []);
	const passed = metrics.metrics.every((metric) => metric.passed === true);
	const manifest = {
		schema: "story/run-manifest@2",
		suiteId: "P2-CTX",
		runId,
		stage,
		...source,
		split,
		status: passed ? "passed" : "failed",
		modelRequests: 0,
		rawChecksums,
	};
	write(path.join(folder, "metrics.json"), metrics);
	write(path.join(folder, "run-manifest.json"), manifest);
	summary("P2-CTX", runId, manifest, metrics);
	return { folder, metrics, passed };
}

function runOffline(suiteId: "P2-Z" | "P2-RESCORE", folders: string[], freeze?: string) {
	const source = provenance(freeze);
	if (freeze && source.dirty) throw new Error("Offline acceptance requires clean frozen source");
	const runId = `${new Date()
		.toISOString()
		.replace(/[-:]/gu, "")
		.replace(/\.\d{3}Z$/u, "Z")}-${source.repositoryCommit.slice(0, 7)}${source.dirty ? "-dirty" : ""}`;
	const folder = path.join(runsRoot, suiteId, runId);
	// Collect before creating this run, so the scan never reads its own unfinished evidence.
	const payload =
		suiteId === "P2-Z"
			? { scan: scanSecrets([repository, path.dirname(workRoot)], repository), fees: ledger().snapshot() }
			: folders.map((selected) => {
					const target = path.resolve(selected);
					const manifest = json(path.join(target, "run-manifest.json")) as {
						repositoryCommit: string;
						dirty: boolean;
						suiteId: string;
						repetition?: number;
						split?: string;
					};
					if (freeze && (manifest.repositoryCommit !== freeze || manifest.dirty))
						throw new Error("Rescore target differs from the clean frozen source");
					return {
						folder: target,
						suiteId: manifest.suiteId,
						repetition: manifest.repetition,
						split: manifest.split,
						...rescoreRun(target),
					};
				});
	if (suiteId === "P2-RESCORE") {
		if (
			!folders.length ||
			new Set(folders.map((selected) => path.resolve(selected).toLowerCase())).size !== folders.length
		)
			throw new Error("Rescore requires distinct run directories");
		if (freeze && Array.isArray(payload)) {
			for (const suite of paidSuites)
				for (const repetition of [1, 2])
					if (
						payload.filter(
							(run) => run.suiteId === suite && run.repetition === repetition && run.split === "acceptance",
						).length !== 1
					)
						throw new Error("Rescore needs both acceptance repetitions of each model suite");
			for (const suite of ["P2-REG", "P2-UNIT", "P2-GUARD", "P2-FOLD", "P2-CTX"])
				if (payload.filter((run) => run.suiteId === suite).length !== 1)
					throw new Error("Rescore needs every deterministic acceptance suite");
		}
	}
	const raw = { suiteId, runId, payload, ...(round3Mode ? { stage } : {}) };
	const metrics = scoreProgram(raw);
	const passed = metrics.metrics.every((metric) => metric.passed === true);
	mkdirSync(path.join(folder, "raw"), { recursive: true });
	write(path.join(folder, "raw/program.json"), raw);
	write(path.join(folder, "metrics.json"), metrics);
	const manifest = {
		schema: "story/run-manifest@2",
		stage,
		suiteId,
		runId,
		...source,
		modelRequests: 0,
		status: passed ? "passed" : "failed",
		programSha256: sha256(readFileSync(path.join(folder, "raw/program.json"))),
	};
	write(path.join(folder, "run-manifest.json"), manifest);
	summary(suiteId, runId, manifest, metrics);
	console.log(JSON.stringify({ folder, passed, metrics }));
	if (!passed) process.exitCode = 1;
}

async function main(args: string[]) {
	const selected = args[0];
	if (!selected || selected === "--help") {
		console.log(
			"P2: P2-OPEN|P2-CHAP|P2-KEEP|P2-EDIT --dev [--smoke] [--compare flash-low|pro-low|flash-off]; acceptance: --acceptance --freeze <commit> --repeat 1|2; offline: --rescore <run> [--write], --aggregate <run...>, --fees, P2-CTX --dev",
		);
		return;
	}
	if (selected === "--fees") {
		console.log(JSON.stringify(ledger().snapshot(), null, 2));
		return;
	}
	if (selected === "--all-real") {
		const freeze = args.includes("--freeze") ? args[args.indexOf("--freeze") + 1] : undefined;
		if (repairMode && !freeze) throw new Error("Repair all-real scoring requires --freeze <commit>");
		console.log(
			JSON.stringify(allRealScores(runsRoot, repairMode ? freeze : undefined, round3Mode ? "P2R3" : "P2R"), null, 2),
		);
		return;
	}
	if (selected === "P2-Z" || selected === "P2-RESCORE") {
		const freeze = args.includes("--freeze") ? args[args.indexOf("--freeze") + 1] : undefined;
		const folders = args.includes("--runs") ? args.slice(args.indexOf("--runs") + 1) : [];
		runOffline(selected, folders, freeze);
		return;
	}
	if (selected === "--prepare-demo") {
		mkdirSync(workRoot, { recursive: true });
		const work = mkdtempSync(path.join(workRoot, "terminal-demo-"));
		const agentDir = path.join(work, "agent");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(path.join(work, "sessions"), { recursive: true });
		const settings = settingsTemplate(work);
		settings.defaultBudget.costUsd = 1;
		const file = path.join(agentDir, "story-forge.json");
		write(file, settings);
		write(path.join(agentDir, "models.json"), piModelOverrides());
		console.log(JSON.stringify({ work, agentDir, storiesDir: settings.storiesDir }));
		return;
	}
	if (selected === "--rescore") {
		const result = rescoreRun(path.resolve(args[1]), args.includes("--write"));
		console.log(JSON.stringify(result, null, 2));
		if (!result.equal && !args.includes("--write")) process.exitCode = 1;
		return;
	}
	if (selected === "--aggregate") {
		const selectedPairs = new Set<string>();
		const runs = args.slice(1).map((folder) => {
			const manifest = json(path.join(folder, "run-manifest.json")) as {
				runId: string;
				repetition: number;
				split: string;
				repositoryCommit: string;
				dirty: boolean;
				suiteId: string;
				status: string;
				caseFailures?: unknown[];
				stage?: string;
				phase?: string;
				smoke?: boolean;
				selectedCaseId?: string | null;
				datasets?: { version: string }[];
			};
			if (manifest.split !== "acceptance" || manifest.dirty)
				throw new Error("Only clean acceptance runs may enter aggregation");
			if (!paidSuites.includes(manifest.suiteId as PaidSuite)) throw new Error("Aggregate only model suites here");
			if (
				repairMode &&
				(manifest.stage !== stage ||
					manifest.phase !== "E13" ||
					manifest.smoke ||
					manifest.selectedCaseId ||
					manifest.datasets?.[0]?.version !== (["P2-KEEP", "P2-EDIT"].includes(manifest.suiteId) ? "v3" : "v2"))
			)
				throw new Error("Repair aggregation requires full E13 runs on the repaired acceptance versions");
			const pair = `${manifest.suiteId}:${manifest.repetition}`;
			if (selectedPairs.has(pair)) throw new Error("Duplicate suite repetition");
			selectedPairs.add(pair);
			return {
				...manifest,
				executionComplete: manifest.status === "measured_pending_gates" && !manifest.caseFailures?.length,
				metrics: rescoreRun(folder).metrics.metrics,
			};
		});
		if (new Set(runs.map((run) => run.repositoryCommit)).size !== 1)
			throw new Error("Acceptance runs must share a frozen commit");
		if (
			repairMode &&
			paidSuites.some((suite) => [1, 2].some((repetition) => !selectedPairs.has(`${suite}:${repetition}`)))
		)
			throw new Error("Repair aggregation needs both repetitions of every model suite");
		console.log(
			JSON.stringify(aggregateScores(runs, round3Mode ? "p2r3-26@1" : repairMode ? "p2r-24@1" : undefined), null, 2),
		);
		return;
	}
	const split = args.includes("--acceptance") ? "acceptance" : args.includes("--dev") ? "development" : undefined;
	if (!split) throw new Error("Select --dev or --acceptance explicitly");
	const freeze = args.includes("--freeze") ? args[args.indexOf("--freeze") + 1] : undefined;
	if (selected === "P2-CTX") {
		const result = runContext(split, freeze);
		console.log(JSON.stringify(result, null, 2));
		if (!result.passed) process.exitCode = 1;
		return;
	}
	if (!paidSuites.includes(selected as PaidSuite)) throw new Error("Unknown P2 suite");
	const repetition = args.includes("--repeat") ? Number(args[args.indexOf("--repeat") + 1]) : 1;
	if (split === "acceptance" && ![1, 2].includes(repetition)) throw new Error("Acceptance repetition must be 1 or 2");
	const caseId = args.includes("--case") ? args[args.indexOf("--case") + 1] : undefined;
	const comparison = args.includes("--compare") ? args[args.indexOf("--compare") + 1] : undefined;
	if (args.includes("--compare") && (!comparison || !Object.hasOwn(MODEL_SETTINGS, comparison)))
		throw new Error("--compare requires flash-low, pro-low or flash-off");
	if (args.includes("--case") && !caseId) throw new Error("--case requires a frozen development case ID");
	const result = await runPaid(selected as PaidSuite, {
		split,
		repetition,
		freeze,
		caseId,
		modelSetting: comparison as ModelSetting | undefined,
		smoke: args.includes("--smoke"),
	});
	if (["failed", "measured_with_failures"].includes(result.manifest.status)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
	await main(process.argv.slice(2).filter((arg) => !["--repair", "--round3"].includes(arg)));
