import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { priorBatches } from "../../../scripts/eval/p3r2/main.ts";
import { assertProductMatches } from "../../../scripts/eval/p3r2/provenance.ts";

test("V5 rejects changed product/rules/configuration fingerprints while accepting unchanged source", () => {
	expect(() => assertProductMatches({ sha256: "frozen" }, { sha256: "changed" })).toThrow("V5 product source");
	expect(() => assertProductMatches({ sha256: "frozen" }, { sha256: "frozen" })).not.toThrow();
});

test("fixed measurement counts distinguish development, acceptance and the two preregistered repetitions", () => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("Project workspace required");
	const root = mkdtempSync(path.join(work, "temp/p3r2-run-selection-"));
	for (const [name, phase, repetition] of [
		["dev", "development", 1],
		["r1", "acceptance", 1],
		["r2", "acceptance", 2],
	] as const) {
		const folder = path.join(root, "P3R2-SCEN", name);
		mkdirSync(folder, { recursive: true });
		writeFileSync(path.join(folder, "manifest.json"), JSON.stringify({ phase, repetition }));
	}
	expect(priorBatches("SCEN", "development", 1, root)).toEqual([path.join(root, "P3R2-SCEN/dev")]);
	expect(priorBatches("SCEN", "acceptance", 2, root)).toEqual([path.join(root, "P3R2-SCEN/r2")]);
	expect(priorBatches("E2E", "development", 1, root)).toEqual([]);
});
