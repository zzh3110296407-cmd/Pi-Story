import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runSuite } from "../run-suite.mjs";
import { publicEvidence, sha256 } from "./artifacts.ts";
import { scoreProgram } from "./program-score.ts";
import { evaluationRound } from "./round.ts";

const repository = path.resolve(import.meta.dirname, "../../../..");
const story = path.join(repository, "story");
const work = process.env.PI_STORY_WORK_DIR ?? path.join(repository, "story/testing/exec");
const suiteId = process.argv[2];
const stage = evaluationRound(process.argv).stage;
const git = (args) => {
	const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", windowsHide: true });
	if (result.status !== 0) throw new Error("Git evidence unavailable");
	return result.stdout.trim();
};
const evidenceHead = git(["rev-parse", "HEAD"]);
const freezeIndex = process.argv.indexOf("--freeze");
const freeze = freezeIndex >= 0 ? process.argv[freezeIndex + 1] : undefined;
if (
	freezeIndex >= 0 &&
	(!/^[a-f0-9]{40}$/u.test(freeze ?? "") ||
		git(["diff", "--name-only", freeze, "HEAD", "--", ".", ":(exclude)story/testing/runs"]))
)
	throw new Error("Source differs from the frozen commit");
const commit = freeze ?? evidenceHead;
const dirty =
	git(["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude)story/testing/runs"]) !== "";
if (freeze && dirty) throw new Error("Deterministic acceptance requires clean frozen source");
const runId = `${new Date()
	.toISOString()
	.replace(/[-:]/gu, "")
	.replace(/\.\d{3}Z$/u, "Z")}-${commit.slice(0, 7)}${dirty ? "-dirty" : ""}`;
const folder = path.join(story, "testing/runs", stage, suiteId, runId);
const write = (file, value) => {
	const text = `${JSON.stringify(value, null, 2)}\n`;
	publicEvidence(text);
	writeFileSync(file, text);
};
const selected = {
	"P2-UNIT": ["packages/pi-story/test"],
	"P2-GUARD": ["packages/pi-story/test/guard.test.ts"],
	"P2-FOLD": ["packages/pi-story/test/entries.test.ts"],
}[suiteId];
if (!selected && suiteId !== "P2-REG") throw new Error("Unknown deterministic P2 suite");
mkdirSync(path.join(folder, "raw"), { recursive: true });
mkdirSync(path.join(folder, "logs"));
for (const name of ["temp", "node-compile-cache", "empty-env"]) mkdirSync(path.join(work, name), { recursive: true });
const env = {
	...process.env,
	PI_STORY_WORK_DIR: work,
	TEMP: path.join(work, "temp"),
	TMP: path.join(work, "temp"),
	TMPDIR: path.join(work, "temp"),
	NODE_COMPILE_CACHE: path.join(work, "node-compile-cache"),
};
// Deterministic suites must never inherit credentials for real providers.
for (const key of Object.keys(env)) if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/u.test(key)) delete env[key];
let passed, raw, metrics;
if (suiteId === "P2-REG") {
	const suites = JSON.parse(readFileSync(new URL("../suites.json", import.meta.url), "utf8"));
	const results = Object.keys(suites).map((suite) =>
		runSuite(suite, { reproduceRoot: path.join(folder, "raw/regression"), createJudgments: false }),
	);
	passed = results.every((result) => result.passed);
	raw = results.map(({ manifest, metrics }) => ({ manifest, metrics }));
	metrics = {
		schema: "story/metrics@2",
		suiteId,
		metrics: [
			{
				id: "H01-H08,H13",
				n: results.length,
				value: results.filter((result) => result.passed).length / results.length,
				threshold: 1,
				passed,
			},
		],
	};
} else {
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
		{ cwd: story, env, windowsHide: true, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	);
	publicEvidence(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
	writeFileSync(path.join(folder, "logs/stdout.log"), result.stdout ?? "");
	writeFileSync(path.join(folder, "logs/stderr.log"), result.stderr ?? String(result.error ?? ""));
	raw = JSON.parse(readFileSync(output, "utf8"));
	passed =
		result.status === 0 &&
		raw.numFailedTests === 0 &&
		raw.numPendingTests === 0 &&
		raw.numTodoTests === 0 &&
		raw.numPassedTests === raw.numTotalTests &&
		raw.numTotalTests > 0;
	metrics = {
		schema: "story/metrics@2",
		suiteId,
		metrics: [
			{
				id: suiteId === "P2-UNIT" ? "H02" : suiteId === "P2-GUARD" ? "H10" : "P2-F",
				n: raw.numTotalTests,
				value: raw.numPassedTests / raw.numTotalTests,
				skipped: raw.numPendingTests + raw.numTodoTests,
				threshold: 1,
				passed,
			},
		],
	};
}
raw = { suiteId, runId, payload: raw };
metrics = scoreProgram(raw);
passed = metrics.metrics.every((metric) => metric.passed === true);
write(path.join(folder, "raw/program.json"), raw);
write(path.join(folder, "metrics.json"), metrics);
write(path.join(folder, "run-manifest.json"), {
	schema: "story/run-manifest@2",
	stage,
	suiteId,
	runId,
	repositoryCommit: commit,
	evidenceHead,
	dirty,
	status: passed ? "passed" : "failed",
	modelRequests: 0,
	costs: { knownUsd: 0, reservedUsd: 0, unknownCalls: 0 },
	programSha256: sha256(readFileSync(path.join(folder, "raw/program.json"))),
});
console.log(JSON.stringify({ suiteId, folder, passed, metrics }));
if (!passed) process.exitCode = 1;
