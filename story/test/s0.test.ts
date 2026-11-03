import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { record } from "../packages/core/test/support/datasets.ts";

for (const file of ["test/check-upstream.test.mjs", "test/check-deps.test.mjs", "test/check-datasets.test.mjs"]) {
	test(`S0 H13: ${file} rejects boundary violations`, () => {
		const env: Record<string, string> = {};
		for (const name of [
			"PATH",
			"SystemRoot",
			"ComSpec",
			"TEMP",
			"TMP",
			"TMPDIR",
			"NPM_CONFIG_CACHE",
			"NODE_COMPILE_CACHE",
			"PI_STORY_WORK_DIR",
			"PI_STORY_ARCHIVE_COMMIT",
			"PI_STORY_GIT_SOURCE",
		])
			if (process.env[name] !== undefined) env[name] = process.env[name];
		const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file], {
			cwd: process.cwd(),
			env,
			encoding: "utf8",
			windowsHide: true,
		});
		const lines = result.stdout.split("\n");
		const negative = lines.filter((line) => /^\s*(?:ok|not ok) \d+ - /u.test(line) && /reject|fails/u.test(line));
		const passed = negative.filter((line) => /^\s*ok /u.test(line)).length;
		record("boundaries", {
			file,
			negative: negative.length,
			passed,
			skipped: /# (?:SKIP|TODO)/u.test(result.stdout),
			exitCode: result.status,
			output: result.stdout,
		});
		expect(negative.length).toBeGreaterThan(0);
		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(passed).toBe(negative.length);
	}, 30000);
}
