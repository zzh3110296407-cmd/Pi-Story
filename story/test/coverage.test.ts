import { expect, test } from "vitest";
import { record } from "../packages/core/test/support/datasets.ts";
import { generateCoverage } from "../scripts/eval/coverage.mjs";

test("H01 required rules have test references or written phase exemptions", () => {
	const coverage = generateCoverage(undefined, "");
	record("coverage", coverage);
	expect(coverage.missing).toEqual([]);
});
