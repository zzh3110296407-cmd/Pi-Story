import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { record } from "../packages/core/test/support/datasets.ts";
import { testingPaths } from "../scripts/eval/paths.mjs";

test("record writes only below the independently configured runs root", () => {
	const base = path.join(testingPaths().workDir, "record-guard");
	mkdirSync(base, { recursive: true });
	const workspace = mkdtempSync(path.join(base, "run-"));
	const previousRoot = process.env.PI_STORY_RUNS_DIR;
	const previousRun = process.env.PI_STORY_RUN_DIR;
	try {
		const runs = path.join(workspace, "runs");
		process.env.PI_STORY_RUNS_DIR = runs;
		process.env.PI_STORY_RUN_DIR = path.join(runs, "P1/case");
		record("fixture", { value: 1 });
		expect(JSON.parse(readFileSync(path.join(runs, "P1/case/raw/observations.jsonl"), "utf8")).kind).toBe("fixture");
		for (const invalid of [runs, `${runs}-sibling/case`, path.join(runs, "../escape")]) {
			process.env.PI_STORY_RUN_DIR = invalid;
			expect(() => record("fixture", {})).toThrow("runs root");
		}
	} finally {
		if (previousRoot === undefined) delete process.env.PI_STORY_RUNS_DIR;
		else process.env.PI_STORY_RUNS_DIR = previousRoot;
		if (previousRun === undefined) delete process.env.PI_STORY_RUN_DIR;
		else process.env.PI_STORY_RUN_DIR = previousRun;
	}
});
