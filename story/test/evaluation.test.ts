import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("evaluation tooling contracts", () => {
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
	const result = spawnSync(process.execPath, ["--test", "test/eval-tools.test.mjs"], {
		cwd: process.cwd(),
		env,
		encoding: "utf8",
		windowsHide: true,
	});
	expect(result.status, result.stdout + result.stderr).toBe(0);
});
