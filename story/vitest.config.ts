import { defineConfig } from "vitest/config";
import { testingPaths } from "./scripts/eval/paths.mjs";

const { workDir } = testingPaths();

export default defineConfig({
	cacheDir: `${workDir}/vite-cache`,
	envDir: `${workDir}/empty-env`,
	test: {
		include: ["packages/*/test/**/*.test.ts", "test/**/*.test.ts"],
		exclude: ["testing/**", "**/node_modules/**"],
		pool: "forks",
		maxWorkers: 1,
		testTimeout: 10000,
	},
});
