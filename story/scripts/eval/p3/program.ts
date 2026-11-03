import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EvidenceArchive, publicEvidence, readEvidence, sha256 } from "../p2/artifacts.ts";
import { type ContextCase, contextInput, contextPredicates } from "../p2/context.mjs";
import { splitDataset } from "../p2/datasets.ts";
import { scoreProgram } from "../p2/program-score.ts";
import { scoreEvidenceV3 } from "../p2/score-v3.ts";
import { runSuite } from "../run-suite.mjs";
import { provenance } from "./main.ts";

const repository = path.resolve(import.meta.dirname, "../../../..");
const story = path.join(repository, "story");
const work = process.env.PI_STORY_WORK_DIR ?? path.join(story, "testing/exec");
export function deterministicEnvironment(source: NodeJS.ProcessEnv, directory: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of [
		"PATH",
		"SystemRoot",
		"ComSpec",
		"USERPROFILE",
		"HOMEDRIVE",
		"HOMEPATH",
		"APPDATA",
		"LOCALAPPDATA",
	])
		if (source[key] !== undefined) env[key] = source[key];
	return Object.assign(env, {
		PI_STORY_WORK_DIR: directory,
		TEMP: path.join(directory, "temp"),
		TMP: path.join(directory, "temp"),
		TMPDIR: path.join(directory, "temp"),
		NODE_COMPILE_CACHE: path.join(directory, "node-compile-cache"),
	});
}
const write = (file: string, value: unknown) => {
	const text = `${JSON.stringify(value, null, 2)}\n`;
	publicEvidence(text);
	writeFileSync(file, text, { flag: "wx" });
};

async function main(suite: string | undefined) {
	if (!suite || !["P3-REG", "P3-UNIT", "P3-GUARD", "P3-FOLD", "P3-CTX"].includes(suite))
		throw new Error("Select P3-REG|P3-UNIT|P3-GUARD|P3-FOLD|P3-CTX");
	const prov = provenance(true);
	if (!prov.freeze) throw new Error("V4 freeze missing");
	const runId = `${new Date()
		.toISOString()
		.replace(/[-:]/gu, "")
		.replace(/\.\d{3}Z$/u, "Z")}-${prov.freeze.commit.slice(0, 7)}-acceptance`;
	const folder = path.join(story, "testing/runs/P3", suite as string, runId);
	if (existsSync(folder)) throw new Error("Deterministic run already exists");
	mkdirSync(path.join(folder, "raw"), { recursive: true });
	mkdirSync(path.join(folder, "logs"));
	for (const name of ["temp", "node-compile-cache", "empty-env"]) mkdirSync(path.join(work, name), { recursive: true });
	let metrics: { metrics: { passed: boolean | null; [key: string]: unknown }[]; [key: string]: unknown };
	let program: unknown;
	if (suite === "P3-REG") {
		const catalog = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../suites.json"), "utf8")) as Record<
			string,
			unknown
		>;
		const results = Object.keys(catalog).map((suite) =>
			runSuite(suite, { reproduceRoot: path.join(folder, "raw/regression"), createJudgments: false }),
		);
		program = results.map(({ manifest, metrics }) => ({ manifest, metrics }));
		metrics = { ...scoreProgram({ suiteId: "P2-REG", runId, payload: program }), suiteId: suite };
	} else if (suite === "P3-CTX") {
		// Existing DS12 was already frozen for P2; only the actual core input
		// constructors are executed, never an external model or dataset generator.
		const data = splitDataset(path.join(story, "testing"), "DS12-context-cases", "v2", "acceptance", "E13");
		const cases = data.files
			.filter((file) => file.path.endsWith(".json"))
			.map((file) => data.json(file.path) as ContextCase);
		// EvidenceArchive requires a new folder; the deterministic shell above owns raw/logs.
		const archiveFolder = path.join(folder, "context");
		const archive = new EvidenceArchive(archiveFolder, path.join(work, "runs/P3", runId), {
			suiteId: "P3-CTX",
			stage: "P3",
			runId,
			expectedCaseIds: cases.map((scenario) => scenario.id),
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
			} catch {
				archive.emit({
					type: "context_result",
					caseId: scenario.id,
					must: [],
					forbidden: [],
					error: "Core input construction failed",
				});
			}
		}
		archive.finish();
		const records = readEvidence(archiveFolder);
		const scored = scoreEvidenceV3(
			records.map((row) => (row.type === "meta" ? { ...row, suiteId: "P2-CTX" } : row)),
			[],
		);
		metrics = { ...scored, suiteId: suite };
		program = { contextArchive: "context", metrics };
	} else {
		const selected =
			suite === "P3-UNIT"
				? ["packages/pi-story/test", "packages/core/test/transport-retry.test.ts"]
				: suite === "P3-GUARD"
					? [
							"packages/pi-story/test/guard.test.ts",
							"packages/pi-story/test/p3-guard.test.ts",
							"packages/pi-story/test/p3-provider-budget.test.ts",
							"packages/pi-story/test/p3-continuation.test.ts",
						]
					: ["packages/pi-story/test/entries.test.ts", "packages/core/test/fold.test.ts"];
		const output = path.join(folder, "raw/vitest.json");
		const result = spawnSync(
			process.execPath,
			[
				path.join(story, "node_modules/vitest/vitest.mjs"),
				"run",
				...selected,
				"--reporter=json",
				`--outputFile=${output}`,
			],
			{
				cwd: story,
				env: deterministicEnvironment(process.env, work),
				windowsHide: true,
				encoding: "utf8",
				maxBuffer: 32 * 1024 * 1024,
			},
		);
		publicEvidence(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
		writeFileSync(path.join(folder, "logs/stdout.log"), result.stdout ?? "");
		writeFileSync(path.join(folder, "logs/stderr.log"), result.stderr ?? String(result.error ?? ""));
		program = JSON.parse(readFileSync(output, "utf8"));
		const id = suite.replace("P3-", "P2-");
		metrics = { ...scoreProgram({ suiteId: id, runId, payload: program }), suiteId: suite };
		if (result.status !== 0) for (const metric of metrics.metrics) metric.passed = false;
	}
	write(path.join(folder, "raw/program.json"), { suiteId: suite, runId, payload: program });
	write(path.join(folder, "metrics.json"), metrics);
	const passed = metrics.metrics.length > 0 && metrics.metrics.every((metric) => metric.passed === true);
	write(path.join(folder, "run-manifest.json"), {
		schema: "story/run-manifest@2",
		stage: "P3",
		suiteId: suite,
		runId,
		...prov,
		repositoryCommit: prov.freeze.commit,
		status: passed ? "passed" : "failed",
		modelRequests: 0,
		costs: { knownUsd: 0, reservedUsd: 0, unknownCalls: 0 },
		programSha256: sha256(readFileSync(path.join(folder, "raw/program.json"))),
	});
	console.log(JSON.stringify({ suite, runId, folder, passed, metrics }));
	if (!passed) process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
	await main(process.argv[2]);
