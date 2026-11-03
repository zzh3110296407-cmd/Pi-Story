import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { readJudgments } from "../../../scripts/eval/p2/rescore.ts";
import { deterministicEnvironment } from "../../../scripts/eval/p3/program.ts";

test("deterministic child processes cannot inherit real provider credentials or change the parent's environment", () => {
	const source = {
		PATH: "fixture-path",
		DEEPSEEK_API_KEY: "synthetic-credential",
		ACCESS_TOKEN: "synthetic-token",
		PI_STORY_WORK_DIR: "previous",
	};
	const child = deterministicEnvironment(source, "D:/project/testing/exec");
	expect(child.DEEPSEEK_API_KEY).toBeUndefined();
	expect(child.ACCESS_TOKEN).toBeUndefined();
	expect(child.PATH).toBe(source.PATH);
	expect(child.PI_STORY_WORK_DIR).toBe("D:/project/testing/exec");
	expect(source.DEEPSEEK_API_KEY).toBe("synthetic-credential");
	expect(source.PI_STORY_WORK_DIR).toBe("previous");
});

test("P3 judgment loading retains coverage files, validates booleans and requires actual approval evidence", () => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("Project workspace required");
	const root = mkdtempSync(path.join(work, "temp/p3-judgments-"));
	mkdirSync(path.join(root, "judgments"));
	const file = path.join(root, "judgments/T06-coverage.json");
	const row = {
		runId: "p3-only",
		metric: "T06",
		component: "recall",
		sampleId: "gold-1",
		pass: true,
		status: "author_approved",
	};
	const document = {
		schema: "story/p2-judgments@2",
		approval: { evidence: "author-confirmation-record" },
		scores: [row],
	};
	writeFileSync(file, JSON.stringify(document));
	expect(readJudgments(root)).toEqual([]);
	expect(readJudgments(root, "P3")).toEqual([row]);
	writeFileSync(file, JSON.stringify({ ...document, scores: [{ ...row, pass: "false" }] }));
	expect(() => readJudgments(root, "P3")).toThrow("Invalid P2 judgment row");
	writeFileSync(file, JSON.stringify({ ...document, approval: undefined }));
	expect(() => readJudgments(root, "P3")).toThrow("Author judgment has no approval evidence");
});
