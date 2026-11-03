import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertFrozenTree } from "../../check-upstream.mjs";
import { PI_COMMIT, settingsTemplate } from "../../prepare-p2.mjs";
import { publicEvidence, sha256 } from "../p2/artifacts.ts";
import { sourceEvidence, testingPaths } from "../paths.mjs";

export const repository = path.resolve(import.meta.dirname, "../../../..");
export const paths = testingPaths();
export const stageRoot = path.join(paths.runsRoot, "P3R2");
export const DATA_FREEZE = "bdea40bf3";
export function writeRecord(file: string, value: unknown): void {
	const text = `${JSON.stringify(value, null, 2)}\n`;
	publicEvidence(text);
	writeFileSync(file, text, { flag: "wx" });
}
export function selectedWriterFactor(): 0.8 | 0.9 {
	const value = JSON.parse(readFileSync(path.join(stageRoot, "writer-length-selection.json"), "utf8")) as {
		schema: string;
		selectedPlan: string;
		writerLengthFactor: number;
	};
	if (
		value.schema !== "story/p3r2-writer-length-selection@1" ||
		value.selectedPlan !== "A" ||
		![0.8, 0.9].includes(value.writerLengthFactor)
	)
		throw new Error("A completed S3 selection is required");
	return value.writerLengthFactor as 0.8 | 0.9;
}
export function productSnapshot() {
	const result = spawnSync(
		"git",
		[
			"ls-files",
			"-z",
			"--",
			"story/packages/core/src",
			"story/packages/core/package.json",
			"story/packages/pi-story/src",
			"story/packages/pi-story/rules",
			"story/packages/pi-story/package.json",
		],
		{ cwd: repository, encoding: "utf8", windowsHide: true },
	);
	if (result.status !== 0 || !result.stdout) throw new Error("Product source list unavailable");
	const files = result.stdout
		.split("\0")
		.filter(Boolean)
		.sort()
		.map((file) => ({ file, sha256: sha256(readFileSync(path.join(repository, file))) }));
	const configuration = { ...settingsTemplate("<execution-workspace>"), writerLengthFactor: selectedWriterFactor() };
	const snapshot = {
		piCommit: PI_COMMIT,
		files,
		configuration,
		showrunner: { model: "deepseek/deepseek-flash", thinking: "low" },
	};
	return { ...snapshot, sha256: sha256(JSON.stringify(snapshot)) };
}
export interface V5Freeze {
	schema: "story/p3-v5@1";
	commit: string;
	frozenAt: string;
	product: ReturnType<typeof productSnapshot>;
	dataFreezeCommit: string;
}
export function assertProductMatches(frozen: { sha256: string }, actual: { sha256: string }): void {
	if (frozen.sha256 !== actual.sha256) throw new Error("V5 product source, rules or configuration changed");
}
export function executionSource(formal = false) {
	const source = sourceEvidence(repository);
	if (source.dirty) throw new Error("Commit source changes before measured execution");
	const delivered = assertFrozenTree(repository, path.resolve(import.meta.dirname, "../../baselines/p3r2-data.json"));
	if (!delivered.startsWith(DATA_FREEZE)) throw new Error("Unexpected DS11 v3 / DS14 v2 delivery snapshot");
	if (!formal) return { source, product: productSnapshot() };
	const file = path.join(stageRoot, "V5.json");
	if (!existsSync(file)) throw new Error("V5 product freeze required before formal execution");
	const freeze = JSON.parse(readFileSync(file, "utf8")) as V5Freeze;
	if (freeze.schema !== "story/p3-v5@1" || !/^[a-f0-9]{40}$/u.test(freeze.commit))
		throw new Error("Invalid V5 product freeze");
	const product = productSnapshot();
	assertProductMatches(freeze.product, product);
	return { source, product, freeze };
}
