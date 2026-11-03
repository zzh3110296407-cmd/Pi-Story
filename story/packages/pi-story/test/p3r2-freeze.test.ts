import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { assertDeterministicGates, openingComparison } from "../../../scripts/eval/p3r2/freeze.ts";

test("paid V5 acceptance requires all five passing deterministic suites from the frozen product commit", () => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("Project workspace required");
	const root = mkdtempSync(path.join(work, "temp/p3r2-freeze-gates-"));
	const commit = "a".repeat(40);
	expect(() => assertDeterministicGates(commit, root)).toThrow("P3R2-REG");
	for (const suite of ["REG", "UNIT", "GUARD", "FOLD", "CTX"]) {
		const folder = path.join(root, `P3R2-${suite}`, "one");
		mkdirSync(folder, { recursive: true });
		writeFileSync(
			path.join(folder, "run-manifest.json"),
			JSON.stringify({ repositoryCommit: commit, status: "passed" }),
		);
	}
	expect(() => assertDeterministicGates(commit, root)).not.toThrow();
	expect(() => assertDeterministicGates("b".repeat(40), root)).toThrow();
	writeFileSync(
		path.join(root, "P3R2-UNIT/one/run-manifest.json"),
		JSON.stringify({ repositoryCommit: commit, status: "failed" }),
	);
	expect(() => assertDeterministicGates(commit, root)).toThrow("P3R2-UNIT");
	const correction = path.join(root, "P3R2-UNIT/corrected");
	mkdirSync(correction);
	writeFileSync(
		path.join(correction, "run-manifest.json"),
		JSON.stringify({ repositoryCommit: commit, status: "passed", correctionOf: "missing" }),
	);
	expect(() => assertDeterministicGates(commit, root)).toThrow("P3R2-UNIT");
	writeFileSync(
		path.join(root, "P3R2-UNIT/one/run-manifest.json"),
		JSON.stringify({ repositoryCommit: commit, status: "failed", runId: "original" }),
	);
	writeFileSync(
		path.join(correction, "run-manifest.json"),
		JSON.stringify({ repositoryCommit: commit, status: "passed", correctionOf: "original" }),
	);
	expect(() => assertDeterministicGates(commit, root)).not.toThrow();
});

test("the V4 opening tool definitions and opening rule prefix remain byte-identical in V5", () => {
	const compared = openingComparison();
	expect(compared.inheritOpen).toBe(true);
	expect(compared.checks.every((row) => row.beforeDigest === row.afterDigest)).toBe(true);
});
