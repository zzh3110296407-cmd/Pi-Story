import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { inspectTesting } from "../scripts/check-datasets.mjs";
import { sha256 } from "../scripts/eval/datasets.mjs";
import { hasSourceChanges, repository, testingPaths } from "../scripts/eval/paths.mjs";

const work = path.join(testingPaths().workDir, "dataset-guard");
mkdirSync(work, { recursive: true });
function fixture() {
	const root = mkdtempSync(path.join(work, "case-"));
	const version = path.join(root, "datasets/DS-test/v1");
	mkdirSync(version, { recursive: true });
	const data = path.join(version, "data.json");
	writeFileSync(data, "[]\n");
	writeFileSync(
		path.join(version, "manifest.json"),
		JSON.stringify({
			schema: "story/dataset-manifest@1",
			id: "DS-test",
			version: "v1",
			frozenAt: "2026-10-28",
			files: [{ path: "data.json", sha256: sha256(readFileSync(data)) }],
		}),
	);
	return { root, version, data };
}

test("testing paths default to this repository and allow independent overrides", () => {
	const defaults = testingPaths({});
	assert.equal(defaults.testRoot, path.join(repository, "story/testing"));
	assert.equal(defaults.runsRoot, path.join(defaults.testRoot, "runs"));
	assert.equal(defaults.workDir, path.join(repository, "story/testing/exec"));
	const override = testingPaths({
		PI_STORY_TEST_ROOT: work,
		PI_STORY_RUNS_DIR: path.join(work, "output"),
		PI_STORY_WORK_DIR: work,
	});
	assert.equal(override.runsRoot, path.join(work, "output"));
	assert.equal(override.workDir, work);
});

test("dataset guard accepts a complete manifest", () => {
	assert.equal(inspectTesting(fixture().root).versions, 1);
});
test("dataset guard rejects a one-byte change", () => {
	const { root, data } = fixture();
	writeFileSync(data, "{}\n");
	assert.throws(() => inspectTesting(root), /digest mismatch/u);
});
test("dataset guard rejects an unlisted file", () => {
	const { root, version } = fixture();
	writeFileSync(path.join(version, "extra.json"), "[]");
	assert.throws(() => inspectTesting(root), /Unregistered dataset file/u);
});
test("dataset guard rejects missing manifests and missing listed files", () => {
	const { root, version } = fixture();
	mkdirSync(path.join(version, "../v2"));
	assert.throws(() => inspectTesting(root), /ENOENT/u);
	const other = fixture();
	writeFileSync(
		path.join(other.version, "manifest.json"),
		JSON.stringify({
			schema: "story/dataset-manifest@1",
			version: "v1",
			frozenAt: "2026-10-28",
			files: [{ path: "missing.json", sha256: sha256("") }],
		}),
	);
	assert.throws(() => inspectTesting(other.root), /ENOENT/u);
});
for (const [name, file, content] of [
	["environment files", ".env.local", "fixture only"],
	["authentication fields", "request.json", JSON.stringify({ authorization: "fixture-only" })],
	["key material", "response.txt", `sk-${"x".repeat(24)}`],
	["compressed authentication fields", "raw.jsonl.gz", gzipSync(`${JSON.stringify({ api_key: "fixture-only" })}\n`)],
]) {
	test(`dataset guard rejects ${name}`, () => {
		const { root } = fixture();
		writeFileSync(path.join(root, file), content);
		assert.throws(() => inspectTesting(root), /Forbidden/u);
	});
}
test("dataset guard excludes private material", () => {
	const { root } = fixture();
	mkdirSync(path.join(root, "private"));
	writeFileSync(path.join(root, "private/.env"), "fixture-only");
	assert.equal(inspectTesting(root).versions, 1);
});

test("dataset guard excludes the execution workspace but still checks public directories named exec", () => {
	const { root } = fixture();
	mkdirSync(path.join(root, "exec"));
	writeFileSync(path.join(root, "exec/.env"), "fixture-only");
	assert.equal(inspectTesting(root).versions, 1);
	const nested = path.join(root, "runs/P2/exec");
	mkdirSync(nested, { recursive: true });
	writeFileSync(path.join(nested, ".env"), "fixture-only");
	assert.throws(() => inspectTesting(root), /Forbidden environment file/u);
});

test("Git ignores only run changes and rejects edits to committed dataset versions", () => {
	const root = path.join(mkdtempSync(path.join(work, "git-")), "fixture");
	const git = (...args) => {
		const result = spawnSync("git", args, { encoding: "utf8", windowsHide: true });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	git(
		"clone",
		"--shared",
		"--no-checkout",
		`--revision=${process.env.PI_STORY_ARCHIVE_COMMIT ?? "HEAD"}`,
		process.env.PI_STORY_GIT_SOURCE ?? repository,
		root,
	);
	git("-C", root, "sparse-checkout", "set", "story/testing/datasets");
	git("-C", root, "read-tree", "-mu", "HEAD");
	assert.equal(git("-C", root, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
	const testing = path.join(root, "story/testing");
	const runs = path.join(testing, "runs/P1/fixture");
	mkdirSync(runs, { recursive: true });
	writeFileSync(path.join(runs, "metrics.json"), "{}\n");
	assert.equal(hasSourceChanges(root), false);
	writeFileSync(path.join(root, "source-change.txt"), "fixture\n");
	assert.equal(hasSourceChanges(root), true);
	// Create a committed fixture on detached HEAD; never create a task branch.
	const version = path.join(testing, "datasets/DS-fixture/v1");
	mkdirSync(version, { recursive: true });
	writeFileSync(path.join(version, "data.json"), "[]\n");
	const manifest = {
		schema: "story/dataset-manifest@1",
		version: "v1",
		frozenAt: "2026-10-28",
		files: [{ path: "data.json", sha256: sha256("[]\n") }],
	};
	writeFileSync(path.join(version, "manifest.json"), JSON.stringify(manifest));
	git("-C", root, "add", "--", "story/testing/datasets/DS-fixture/v1");
	git("-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
	assert.ok(inspectTesting(testing).versions >= 1);
	writeFileSync(path.join(version, "data.json"), "{}\n");
	manifest.files[0].sha256 = sha256("{}\n");
	writeFileSync(path.join(version, "manifest.json"), JSON.stringify(manifest));
	assert.throws(() => inspectTesting(testing), /Committed dataset version is immutable/u);
});
