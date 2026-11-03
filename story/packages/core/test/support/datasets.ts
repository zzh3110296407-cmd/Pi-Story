import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type DatasetManifest, verifyDataset } from "../../../../scripts/eval/datasets.mjs";
import { inside, testingPaths } from "../../../../scripts/eval/paths.mjs";

export const testRoot = testingPaths().testRoot;
export function loadDataset<T>(
	directory: string,
	file: string,
	version = "v1",
): { data: T; manifest: DatasetManifest } {
	const { folder, manifest } = verifyDataset(testRoot, directory, version);
	if (!manifest.files.some((item) => item.path === file))
		throw new Error(`Unregistered dataset file: ${directory}/${file}`);
	return { data: JSON.parse(readFileSync(path.join(folder, file), "utf8")) as T, manifest };
}
export function record(kind: string, data: unknown): void {
	const folder = process.env.PI_STORY_RUN_DIR;
	if (!folder) return;
	const resolved = path.resolve(folder);
	if (!inside(testingPaths().runsRoot, resolved)) throw new Error("Run output must stay under the runs root");
	mkdirSync(path.join(resolved, "raw"), { recursive: true });
	appendFileSync(path.join(resolved, "raw/observations.jsonl"), `${JSON.stringify({ kind, data })}\n`);
}
