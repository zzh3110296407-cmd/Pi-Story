import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { schemas, validate } from "../../../packages/core/src/schema/index.ts";
import { PI_COMMIT } from "../../prepare-p2.mjs";
import { publicEvidence, sha256 } from "../p2/artifacts.ts";
import { type OpeningPrompt, openingPrompts, splitDataset } from "../p2/datasets.ts";
import { UsageLedger } from "../p2/ledger.ts";
import { RunControl } from "../p2/run-control.ts";
import { driveBook } from "./book.ts";
import { loadScenarios } from "./datasets.ts";
import { scoreBookArchives, scoreOpeningArchives } from "./metrics.ts";
import { stopAfterOpening } from "./open.ts";
import { P3RpcClient } from "./rpc.ts";
import type { WorkerConfig } from "./rpc-worker.ts";
import { runScenario } from "./scenario.ts";
import { createMeasuredSession } from "./session.ts";

const repository = path.resolve(import.meta.dirname, "../../../..");
const testing = path.join(repository, "story/testing");
const root = path.join(testing, "runs/P3");
const workRoot = path.resolve(process.env.PI_STORY_WORK_DIR ?? path.join(testing, "exec"));
const freezeFile = path.join(root, "V4.json");
const dataFreeze = "c4fa1d5e0f409cb18e0cb6ac66836873c87d6069";
// This bounds a whole unattended book, not one request. Four development
// chapters took about 21 minutes; ten can exceed the RPC client's 45m default.
const bookSettleTimeoutMs = 120 * 60_000;
export const scenarioDatasets = {
	SCEN: { directory: "DS11-showrunner-scenarios", version: "v2", commit: "8a853518b76880de860118789a5a55838a237c46" },
	E2E: { directory: "DS14-author-control-e2e", version: "v1", commit: dataFreeze },
} as const;
// Pi's pinned Flash ceiling is 384000 output tokens ($0.4608 before input).
// Keep the native ceiling; this is a local allowance, under the stage ledger.
export const caseAllowanceUsd = { SCEN: 1, E2E: 1 } as const;
export function caseWorkspace(runId: string, caseId: string) {
	// Pi includes cwd in its model context. Keep evaluation labels in archive
	// metadata only; preserve stable resumable paths without exposing the labels.
	return path.join(workRoot, "model-work", sha256(runId).slice(0, 20), sha256(caseId).slice(0, 20));
}
export function selectBookPrompts(
	prompts: OpeningPrompt[],
	rankedIds: readonly (string | number)[],
	development: boolean,
) {
	if (rankedIds.length !== (development ? 3 : 5) || new Set(rankedIds.map(String)).size !== rankedIds.length)
		throw new Error("Frozen BOOK subset differs from plan 27/29");
	return rankedIds.slice(0, development ? 2 : 5).map((id) => {
		const prompt = prompts.find((candidate) => String(candidate.id) === String(id));
		if (!prompt) throw new Error("Frozen BOOK prompt missing");
		return prompt;
	});
}
function git(...args: string[]) {
	const result = spawnSync("git", ["--no-optional-locks", ...args], {
		cwd: repository,
		windowsHide: true,
		encoding: "utf8",
	});
	if (result.status !== 0) throw new Error("P3 Git provenance unavailable");
	return result.stdout.trim();
}
function write(file: string, value: unknown) {
	const text = `${JSON.stringify(value, null, 2)}\n`;
	publicEvidence(text);
	writeFileSync(file, text, { flag: "wx" });
}
function recordSelection(folder: string, value: unknown) {
	const file = path.join(folder, "selection.json");
	if (!existsSync(file)) write(file, value);
	else if (JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) !== JSON.stringify(value))
		throw new Error("Resume cannot change frozen sample selection");
}
export function isMeasurementOnlyRevision(files: readonly string[]) {
	const allowed = [
		"story/scripts/eval/p3/datasets.ts",
		"story/scripts/eval/p3/main.ts",
		"story/scripts/eval/p3/session.ts",
		"story/scripts/eval/p3/scenario.ts",
		"story/scripts/eval/p3/checks.ts",
		"story/scripts/eval/p3/metrics.ts",
		"story/scripts/eval/p3/scenario-score.ts",
		"story/packages/pi-story/test/p3-dataset-contract.test.ts",
		"story/packages/pi-story/test/p3-scenario.test.ts",
		"story/packages/pi-story/test/p3-scenario-score.test.ts",
	];
	return files.length > 0 && files.every((file) => allowed.includes(file));
}
interface Freeze {
	schema: "story/p3-v4@1";
	commit: string;
	dataFreeze: string;
	scenarioDatasets: typeof scenarioDatasets;
	frozenAt: string;
	measurementRevision?: { commit: string; evidence: string };
}
export function provenance(acceptance: boolean) {
	if (git("status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude)story/testing/runs"))
		throw new Error("Product source must be committed before measured development or acceptance");
	git("merge-base", "--is-ancestor", dataFreeze, "HEAD");
	for (const dataset of Object.values(scenarioDatasets)) {
		git("merge-base", "--is-ancestor", dataset.commit, "HEAD");
		if (
			git(
				"diff",
				"--name-only",
				dataset.commit,
				"HEAD",
				"--",
				`story/testing/datasets/${dataset.directory}/${dataset.version}`,
			)
		)
			throw new Error("Frozen scenario version differs from its delivery commit");
	}
	const build = JSON.parse(readFileSync(path.join(workRoot, "pi-build.json"), "utf8")) as {
		commit: string;
		built: boolean;
		modelSnapshot: unknown;
	};
	if (build.commit !== PI_COMMIT || !build.built) throw new Error("Pinned Pi build is not ready");
	const commit = git("rev-parse", "HEAD");
	const freeze = acceptance ? (JSON.parse(readFileSync(freezeFile, "utf8")) as Freeze) : undefined;
	const measurement = freeze?.measurementRevision;
	if (measurement) {
		if (!/^[a-f0-9]{40}$/u.test(measurement.commit) || !measurement.evidence)
			throw new Error("Invalid V4 measurement revision");
		git("merge-base", "--is-ancestor", freeze.commit, measurement.commit);
		const changes = git(
			"diff",
			"--name-only",
			freeze.commit,
			measurement.commit,
			"--",
			".",
			":(exclude)story/testing/runs",
		).split("\n");
		if (!isMeasurementOnlyRevision(changes))
			throw new Error("Measurement revision changes frozen product or protocol files");
	}
	if (
		freeze &&
		(freeze.schema !== "story/p3-v4@1" ||
			!/^[a-f0-9]{40}$/u.test(freeze.commit) ||
			git(
				"diff",
				"--name-only",
				measurement?.commit ?? freeze.commit,
				"HEAD",
				"--",
				".",
				":(exclude)story/testing/runs",
			))
	)
		throw new Error("Source differs from V4 product freeze");
	const rules = ["story-showrunner", "story-long-writing", "story-review-matrix", "story-state-projection"].map(
		(name) => {
			const file = `story/packages/pi-story/rules/${name}/SKILL.md`;
			return { file, sha256: sha256(readFileSync(path.join(repository, file))) };
		},
	);
	return {
		commit,
		freeze,
		dataFreeze,
		scenarioDatasets,
		rules,
		piCommit: build.commit,
		piBuild: build,
		node: process.version,
	};
}
function progress(caseId: string, message: unknown) {
	if (!message || typeof message !== "object" || !("details" in message)) return;
	const macro = validate(schemas.MacroDetails, message.details);
	if (macro.ok && macro.value.ok && macro.value.commit)
		console.log(`${caseId}: chapter ${macro.value.commit.chapter} committed (${macro.value.commit.quality})`);
}
export async function balance(control: RunControl) {
	const key = process.env.DEEPSEEK_API_KEY;
	if (!key) throw new Error("DEEPSEEK_API_KEY is absent; no paid request made");
	const reply = await fetch("https://api.deepseek.com/user/balance", {
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(30_000),
	});
	if (!reply.ok) {
		control.reject(reply.status);
		throw new Error(`Balance query refused (HTTP ${reply.status}); no paid request made`);
	}
	const value: unknown = await reply.json();
	if (
		!value ||
		typeof value !== "object" ||
		!("is_available" in value) ||
		value.is_available !== true ||
		!("balance_infos" in value) ||
		!Array.isArray(value.balance_infos)
	)
		throw new Error("Balance unavailable; no paid request made");
	return {
		checkedAt: new Date().toISOString(),
		available: true,
		balances: value.balance_infos.map((row: unknown) => {
			if (!row || typeof row !== "object" || !("currency" in row) || !("total_balance" in row))
				throw new Error("Invalid balance response");
			return { currency: String(row.currency), total: String(row.total_balance) };
		}),
	};
}
async function main(args: string[]) {
	const option = (name: string) => {
		const i = args.indexOf(name);
		return i < 0 ? undefined : args[i + 1];
	};
	const development = args.includes("--development");
	const suite = option("--suite");
	const selected = option("--cases")?.split(",");
	if (selected && (!development || suite !== "SCEN" || new Set(selected).size !== selected.length))
		throw new Error("Case selection is only for explicit targeted SCEN development checks");
	const prov = provenance(!development && !args.includes("--freeze"));
	mkdirSync(root, { recursive: true });
	if (args.includes("--freeze")) {
		write(freezeFile, {
			schema: "story/p3-v4@1",
			commit: prov.commit,
			dataFreeze,
			scenarioDatasets,
			frozenAt: new Date().toISOString(),
		});
		console.log(`V4 product frozen at ${prov.commit}`);
		return;
	}
	if (!["SCEN", "E2E", "BOOK", "OPEN"].includes(suite ?? "") || (development && suite === "OPEN"))
		throw new Error("Select SCEN|E2E|BOOK for development; OPEN is formal-only after V4, or use --freeze");
	const repetition = Number(option("--repetition") ?? "1");
	if (![1, 2].includes(repetition) || (repetition === 2 && (development || suite !== "SCEN")))
		throw new Error("Repetition differs from plan 29");
	const ledger = new UsageLedger(path.join(root, "usage-ledger.jsonl"), path.join(root, "request-reservations.jsonl"), {
		stopUsd: 12,
		maximumUsd: 15,
	});
	const control = new RunControl();
	const resumed = option("--resume");
	const runId =
		resumed ??
		`${new Date()
			.toISOString()
			.replace(/[-:]/gu, "")
			.replace(/\.\d{3}Z$/u, "Z")}-${prov.commit.slice(0, 7)}-${development ? "dev" : "acceptance"}-r${repetition}`;
	if (path.basename(runId) !== runId) throw new Error("Unsafe resumed run ID");
	const folder = path.join(root, `P3-${suite}`, runId);
	mkdirSync(folder, { recursive: true });
	if (resumed && existsSync(path.join(folder, "summary.json"))) {
		console.log(`Completed run retained: ${folder}`);
		return;
	}
	const results: unknown[] = [];
	const manifest = {
		schema: "story/p3-run@1",
		suite: `P3-${suite}`,
		runId,
		split: development ? "dev" : "acceptance",
		repetition,
		...prov,
		limits: { stopUsd: 12, maximumUsd: 15, bookUsd: 2, bookSettleTimeoutMs },
		initialFees: ledger.snapshot(),
		selectedCaseIds: selected ?? null,
	};
	if (resumed) {
		const old = JSON.parse(readFileSync(path.join(folder, "manifest.json"), "utf8")) as typeof manifest;
		if (
			old.split !== manifest.split ||
			old.suite !== manifest.suite ||
			old.repetition !== repetition ||
			(!development && old.freeze?.commit !== prov.freeze?.commit)
		)
			throw new Error("Resume cannot change the declared suite/split/repetition/freeze");
	} else write(path.join(folder, "manifest.json"), manifest);
	if (suite === "SCEN" || suite === "E2E") {
		const dataset = scenarioDatasets[suite];
		const version = path.join(testing, "datasets", dataset.directory, dataset.version);
		const all = loadScenarios(version, development ? "dev" : "acceptance", prov.freeze);
		if (selected?.some((id) => !all.some((scenario) => scenario.id === id)))
			throw new Error("Unknown selected development case");
		const scenarios = selected ? all.filter((scenario) => selected.includes(scenario.id)) : all;
		if (!development && scenarios.length !== (suite === "SCEN" ? 32 : 15))
			throw new Error("Formal scenario selection is incomplete");
		recordSelection(folder, {
			dataset,
			indexSha256: sha256(readFileSync(path.join(version, development ? "dev/index.json" : "acceptance/index.json"))),
			expected: scenarios.map(({ id, category, mode }) => ({ id, category, mode })),
		});
		for (const scenario of scenarios) {
			control.assertActive();
			const resultFile = path.join(folder, scenario.id, "result.json");
			if (resumed && existsSync(resultFile)) {
				results.push(JSON.parse(readFileSync(resultFile, "utf8")));
				console.log(`${scenario.id}: archived result retained`);
				continue;
			}
			if (resumed && existsSync(path.join(folder, scenario.id)))
				throw new Error(`${scenario.id} has partial evidence; finalize it before resuming`);
			if (scenario.mode === "real" || scenario.execution.internalRoles === "real")
				write(path.join(folder, `${scenario.id}-balance.json`), await balance(control));
			const result = await runScenario(scenario, {
				work: caseWorkspace(runId, scenario.id),
				archive: path.join(folder, scenario.id),
				suiteId: `P3-${suite}`,
				runId: `${runId}-${scenario.id}`,
				caseId: scenario.id,
				ledger,
				control,
				runLimitUsd: caseAllowanceUsd[suite],
				onEvidence: (row) => {
					if (row.type === "tool_result" && row.driverPhase === "measurement") progress(scenario.id, row.message);
				},
			});
			write(path.join(folder, scenario.id, "result.json"), result);
			results.push(result);
			console.log(
				`${scenario.id}: ${result.status}; first=${result.firstAction ? (result.firstAction.tool ?? "reply") : "none"}; checks=${result.programChecks.filter((check) => check.status === "passed").length}/${result.programChecks.length}`,
			);
			control.assertActive();
			if (result.status === "incomplete" && scenario.category !== "E01" && result.archive.measuredMainRequests === 0)
				throw new Error("Measurement did not start; remaining cases stopped without dispatch");
		}
	} else if (suite === "OPEN") {
		const dataset = splitDataset(testing, "DS08-opening-prompts", "v2", "acceptance", "E13");
		const prompts = openingPrompts(dataset, false);
		if (prompts.length !== 12) throw new Error("OPEN requires all twelve frozen prompts");
		recordSelection(folder, {
			dataset: "DS08",
			version: "v2",
			manifestDigest: dataset.manifestDigest,
			ids: prompts.map((prompt) => prompt.id),
		});
		for (const prompt of prompts) {
			control.assertActive();
			const caseId = String(prompt.id);
			const archive = path.join(folder, caseId);
			const resultFile = path.join(archive, "result.json");
			if (resumed && existsSync(resultFile)) {
				results.push(JSON.parse(readFileSync(resultFile, "utf8")));
				continue;
			}
			write(path.join(folder, `${caseId}-balance.json`), await balance(control));
			let driver: Awaited<ReturnType<typeof createMeasuredSession>> | undefined;
			driver = await createMeasuredSession({
				work: caseWorkspace(runId, caseId),
				archive,
				suiteId: "P3-OPEN",
				runId: `${runId}-${caseId}`,
				caseId,
				ledger,
				control,
				runLimitUsd: 1,
				main: "real",
				internals: "faux",
				preparation: false,
				maxShowrunnerRequests: 48,
				reply: () => {
					throw new Error("OPEN cannot call an internal role");
				},
				extension: (pi) =>
					stopAfterOpening(pi, (row) => {
						if (!driver) throw new Error("Opening driver missing");
						driver.emit(row);
					}),
			});
			try {
				const errors: string[] = [];
				let observedDecision = false;
				await driver.session.bindExtensions({
					mode: "print",
					onError: (event) => {
						errors.push(event.error);
					},
				});
				driver.session.subscribe((event) => {
					if (
						event.type === "message_end" &&
						event.message.role === "assistant" &&
						!["error", "aborted"].includes(event.message.stopReason) &&
						event.message.content.some(
							(block) => block.type === "toolCall" || (block.type === "text" && block.text.trim()),
						)
					)
						observedDecision = true;
				});
				driver.emit({
					type: "author_prompt",
					text: prompt.prompt,
					dataset: { version: "v2", manifestDigest: dataset.manifestDigest },
				});
				await driver.session.prompt(prompt.prompt);
				const model = driver.story.current()?.source.model();
				if (!model) throw new Error("Opening has no core state");
				const attempts: Record<string, number> = {};
				for (const entry of driver.manager.getBranch())
					if (entry.type === "message" && entry.message.role === "toolResult")
						attempts[entry.message.toolName] = (attempts[entry.message.toolName] ?? 0) + 1;
				driver.emit({
					type: "opening_result",
					measurementStatus: observedDecision ? "measured" : "incomplete",
					model: { controlRev: model.controlRev, bibleRev: model.bibleRev, outlineRev: model.outlineRev },
					attempts,
					entries: driver.story.current()?.source.branch(),
				});
				const result = {
					id: caseId,
					status: observedDecision ? "measured" : "incomplete",
					completed: Boolean(model.controlRev && model.bibleRev && model.outlineRev),
					errors,
					archive: driver.finish(),
				};
				write(resultFile, result);
				results.push(result);
				console.log(`${caseId}: opening complete=${result.completed}`);
				if (!observedDecision)
					throw new Error("Opening measurement did not receive a model decision; remaining prompts stopped");
			} finally {
				driver.dispose();
			}
			control.assertActive();
		}
		write(
			path.join(folder, "metrics.json"),
			scoreOpeningArchives(prompts.map((prompt) => path.join(folder, String(prompt.id)))),
		);
	} else {
		const dataset = splitDataset(
			testing,
			"DS08-opening-prompts",
			development ? "v1" : "v2",
			development ? "development" : "acceptance",
			development ? "E12" : "E13",
		);
		const prompts = selectBookPrompts(openingPrompts(dataset, true), dataset.chapterSubset(), development);
		if (prompts.length !== (development ? 2 : 5)) throw new Error("Frozen BOOK sample count differs from plan 27/29");
		recordSelection(folder, {
			dataset: "DS08",
			version: development ? "v1" : "v2",
			manifestDigest: dataset.manifestDigest,
			ids: prompts.map((prompt) => prompt.id),
			maximumTarget: development ? 4 : 10,
		});
		for (const prompt of prompts) {
			control.assertActive();
			const caseId = String(prompt.id);
			const resultFile = path.join(folder, caseId, "result.json");
			if (resumed && existsSync(resultFile)) {
				results.push(JSON.parse(readFileSync(resultFile, "utf8")));
				console.log(`${caseId}: archived result retained`);
				continue;
			}
			if (resumed && existsSync(path.join(folder, caseId)))
				throw new Error(`${caseId} has partial evidence; finalize it before resuming`);
			write(path.join(folder, `${caseId}-balance.json`), await balance(control));
			const work = caseWorkspace(runId, caseId);
			mkdirSync(work, { recursive: true });
			const archive = path.join(folder, caseId);
			const config: WorkerConfig = {
				schema: "story/p3-rpc-worker@1",
				work,
				archive,
				runId: `${runId}-${caseId}`,
				caseId,
				main: "real",
				ledgerFile: ledger.ledgerFile,
				reservationsFile: ledger.reservationsFile,
			};
			const configFile = path.join(work, "worker.json");
			write(configFile, config);
			const client = new P3RpcClient({
				cli: path.join(import.meta.dirname, "rpc-worker.ts"),
				settleTimeoutMs: bookSettleTimeoutMs,
				cwd: work,
				env: { ...process.env, PI_STORY_P3_WORKER_CONFIG: configFile },
				onWire: (direction, frame) => {
					const text = JSON.stringify({ direction, frame });
					publicEvidence(text);
					appendFileSync(path.join(work, "rpc.jsonl"), `${text}\n`);
				},
			});
			const stopProgress = client.onEvent((event) => {
				if (event.type === "message_end") progress(caseId, event.message);
			});
			try {
				await client.request({ type: "get_state" });
				const book = await driveBook(
					client,
					prompt.prompt,
					() => {
						control.assertActive();
					},
					development ? 4 : 10,
				);
				await client.promptAndWait("/__p3_finish");
				const finalized = JSON.parse(readFileSync(path.join(archive, "finalization.json"), "utf8")) as {
					fatal?: { httpStatus: number };
				};
				if (finalized.fatal) control.reject(finalized.fatal.httpStatus);
				const { entries: _entries, ...result } = book;
				write(path.join(archive, "result.json"), {
					...result,
					id: caseId,
					runId: config.runId,
					fees: ledger.snapshot(config.runId),
				});
				results.push(result);
				console.log(`${caseId}: ${book.lastChapter}/${book.target}; complete=${book.completed}`);
			} finally {
				stopProgress();
				await client.close();
			}
			control.assertActive();
		}
		write(
			path.join(folder, "metrics.json"),
			scoreBookArchives(prompts.map((prompt) => path.join(folder, String(prompt.id)))),
		);
	}
	write(path.join(folder, "summary.json"), {
		suite,
		runId,
		cases: results.length,
		results,
		fees: ledger.snapshot(),
		formalAcceptance: !development,
	});
	console.log(`Archived ${folder}`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
	await main(process.argv.slice(2));
