import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyDataset } from "./datasets.mjs";
import { sourceEvidence, testingPaths } from "./paths.mjs";
import { compareSuiteMetrics, scoreSuite } from "./scorers/suites.mjs";

const repository = path.resolve(import.meta.dirname, "../../..");
const story = path.join(repository, "story");
const catalog = JSON.parse(readFileSync(new URL("suites.json", import.meta.url), "utf8"));
const results = "D:/AI/Story Dome/新版综合方案/测试结果/P1";
const { testRoot, runsRoot, workDir } = testingPaths();
const environment = () => {
	const env = {};
	for (const name of [
		"PATH",
		"SystemRoot",
		"ComSpec",
		"USERPROFILE",
		"HOMEDRIVE",
		"HOMEPATH",
		"APPDATA",
		"LOCALAPPDATA",
		"PI_STORY_ARCHIVE_COMMIT",
		"PI_STORY_GIT_SOURCE",
	])
		if (process.env[name] !== undefined) env[name] = process.env[name];
	for (const folder of ["temp", "npm-cache", "node-compile-cache", "empty-env"])
		mkdirSync(path.join(workDir, folder), { recursive: true });
	return Object.assign(env, {
		TEMP: path.join(workDir, "temp"),
		TMP: path.join(workDir, "temp"),
		TMPDIR: path.join(workDir, "temp"),
		NPM_CONFIG_CACHE: path.join(workDir, "npm-cache"),
		NODE_COMPILE_CACHE: path.join(workDir, "node-compile-cache"),
		PI_STORY_TEST_ROOT: testRoot,
		PI_STORY_RUNS_DIR: runsRoot,
		PI_STORY_WORK_DIR: workDir,
	});
};
const isoId = () =>
	new Date()
		.toISOString()
		.replace(/[-:]/gu, "")
		.replace(/\.\d{3}Z$/u, "Z");

function writeSummary(suite, manifest, metrics) {
	const folder = path.join(results, "套件结果");
	mkdirSync(folder, { recursive: true });
	const target = path.join(folder, suite === "P1-S0" ? "P1-S0-仓库准备.md" : `${suite}.md`);
	const previous = existsSync(target) ? readFileSync(target, "utf8") : "";
	const history = previous.includes("<!-- history -->")
		? previous.split("<!-- history -->")[1].trim()
		: "| 运行ID | 提交 | 结果 |\n|---|---|---|";
	const passed =
		metrics.metrics.every((item) => item.passed !== false && item.classificationGatePassed !== false) &&
		manifest.exitCode === 0;
	const rows = metrics.metrics
		.map(
			(item) =>
				`| ${item.id} | ${item.n} | ${JSON.stringify(item.value)} | ${JSON.stringify(item.confidence95)} | ${JSON.stringify(item.threshold)} | ${item.type} | ${item.passed === null ? "观察" : item.passed ? "数值达标" : "未达标"} |`,
		)
		.join("\n");
	writeFileSync(
		target,
		`# ${suite} 套件结果\n\n日期：${manifest.date}；执行者：Codex。提交：${manifest.repositoryCommit}；工作树：${manifest.dirty ? "有未提交修改（过程记录，不作验收证据）" : "干净"}。\n\n运行ID：${manifest.runId}；记录：${manifest.outputDirectory}。测试集：${manifest.datasets.map((item) => `${item.id}/${item.version}`).join("、") || "仓库测试代码"}。\n\n| ID | n | 数值 | 95%区间 | 阈值 | 类型 | 结果 |\n|---|---|---|---|---|---|---|\n${rows}\n\n自动测试：${manifest.exitCode === 0 ? "通过" : "失败"}。人工严格结果：尚待作者核对，AI标注不等同人工金标。无真实模型请求。\n\n缺陷与下一轮：${passed ? "本次程序测量无失败；保留人工复核状态。" : "详见该运行logs与raw记录；先定位失败，不降低阈值或删除用例。"}\n\n## 历次运行\n\n<!-- history -->\n${history}\n| ${manifest.runId} | ${manifest.repositoryCommit.slice(0, 7)} | ${passed ? "程序通过" : "未达标"}${manifest.dirty ? "，dirty" : ""} |\n`,
	);
}

export function runSuite(suite, options = {}) {
	const spec = catalog[suite];
	if (!spec) throw new Error(`Unknown P1 suite: ${suite}`);
	const { commit, dirty, archive } = sourceEvidence(repository);
	const runId = `${isoId()}-${commit.slice(0, 7)}${dirty ? "-dirty" : ""}`;
	const folder = options.reproduceRoot
		? path.join(options.reproduceRoot, suite)
		: archive
			? path.join(runsRoot, suite, runId)
			: path.join(runsRoot, "P1", suite, runId);
	if (existsSync(folder)) throw new Error(`Run already exists; records are immutable: ${folder}`);
	for (const child of options.createJudgments === false ? ["raw", "logs"] : ["raw", "judgments", "logs"])
		mkdirSync(path.join(folder, child), { recursive: true });
	const manifest = {
		schema: "story/run-manifest@1",
		runId,
		suiteId: suite,
		stage: "P1",
		date: new Date().toISOString(),
		executor: "Codex",
		repositoryCommit: commit,
		piCommit: "b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6",
		dirty,
		sourceKind: archive ? "git_archive" : "git_checkout",
		datasets: [],
		ruleTextDigests: [],
		promptDigests: [],
		models: [],
		modelCatalog: [],
		modelRequests: 0,
		nodeVersion: process.version,
		repetitions: 1,
		costs: { knownUsd: 0, unknownCalls: 0, reservedUsd: 0 },
		command: [process.execPath, "node_modules/vitest/vitest.mjs", "run", ...spec.files, "--reporter=json"],
		outputDirectory: folder,
		exitCode: null,
		status: "running",
	};
	let metrics;
	try {
		manifest.datasets = spec.datasets.map((item) => {
			const checked = verifyDataset(testRoot, item.directory, item.version);
			return {
				id: checked.manifest.id,
				directory: item.directory,
				version: item.version,
				manifestDigest: checked.manifestDigest,
			};
		});
		const env = environment();
		env.PI_STORY_RUN_DIR = folder;
		const args = [
			path.join(story, "node_modules/vitest/vitest.mjs"),
			"run",
			...spec.files,
			"--reporter=json",
			`--outputFile=${path.join(folder, "raw/vitest.json")}`,
		];
		const run = spawnSync(process.execPath, args, {
			cwd: story,
			env,
			encoding: "utf8",
			windowsHide: true,
			maxBuffer: 32 * 1024 * 1024,
		});
		manifest.exitCode = run.status;
		writeFileSync(path.join(folder, "logs/stdout.log"), run.stdout ?? "");
		writeFileSync(path.join(folder, "logs/stderr.log"), run.stderr ?? String(run.error ?? ""));
		const report = JSON.parse(readFileSync(path.join(folder, "raw/vitest.json"), "utf8"));
		const observationFile = path.join(folder, "raw/observations.jsonl");
		const observations = existsSync(observationFile)
			? readFileSync(observationFile, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];
		metrics = { schema: "story/metrics@1", suiteId: suite, metrics: scoreSuite(suite, report, observations) };
		if (!metrics.metrics.length) throw new Error("Scorer returned no measurements");
		manifest.status =
			run.status === 0 &&
			metrics.metrics.every((item) => item.passed !== false && item.classificationGatePassed !== false)
				? "passed"
				: "failed";
	} catch (error) {
		manifest.status = "failed";
		manifest.exitCode ??= 1;
		writeFileSync(path.join(folder, "logs/failure.log"), String(error));
		metrics = {
			schema: "story/metrics@1",
			suiteId: suite,
			metrics: spec.metrics.map((id) => ({
				id,
				n: 0,
				value: null,
				confidence95: null,
				threshold: "not_measured",
				type: "gate",
				passed: false,
				judgment: "program",
				records: ["logs/failure.log"],
			})),
		};
	}
	writeFileSync(path.join(folder, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
	writeFileSync(path.join(folder, "run-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	if (!options.reproduceRoot && !archive) writeSummary(suite, manifest, metrics);
	console.log(`${suite}: ${manifest.status}; ${folder}`);
	return { passed: manifest.status === "passed", manifest, metrics };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const selection = process.argv[2];
	if (selection?.startsWith("P2-") || ["--rescore", "--aggregate", "--fees", "--all-real"].includes(selection)) {
		const program = ["P2-REG", "P2-UNIT", "P2-GUARD", "P2-FOLD"].includes(selection) ? "p2/program.mjs" : "p2/main.ts";
		const run = spawnSync(process.execPath, [path.join(import.meta.dirname, program), ...process.argv.slice(2)], {
			cwd: story,
			env: process.env,
			stdio: "inherit",
			windowsHide: true,
		});
		process.exitCode = run.status ?? 1;
	} else if (selection === "--compare") {
		const reference = JSON.parse(readFileSync(process.argv[3], "utf8"));
		const rerun = JSON.parse(readFileSync(process.argv[4], "utf8"));
		const result = compareSuiteMetrics(reference, rerun);
		console.log(JSON.stringify(result, null, 2));
		if (!result.equal) process.exitCode = 1;
	} else {
		const suites = selection === "--all" ? Object.keys(catalog) : [selection];
		const results = suites.map((suite) => runSuite(suite));
		if (results.some((result) => !result.passed)) process.exitCode = 1;
	}
}
