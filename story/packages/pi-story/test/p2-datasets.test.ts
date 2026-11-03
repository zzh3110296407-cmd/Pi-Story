import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { sha256 } from "../../../scripts/eval/p2/artifacts.ts";
import { splitDataset } from "../../../scripts/eval/p2/datasets.ts";

test("development loader never opens acceptance and rejects acceptance outside E13", () => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("P2 workspace required");
	const root = mkdtempSync(path.join(work, "temp/split-"));
	const folder = path.join(root, "datasets/DS08-fixture/v1");
	mkdirSync(path.join(folder, "dev"), { recursive: true });
	const bytes = JSON.stringify({ id: 1, language: "en", task_type: "test", prompt: "Development text" });
	writeFileSync(path.join(folder, "dev/one.json"), bytes);
	writeFileSync(
		path.join(folder, "manifest.json"),
		JSON.stringify({
			schema: "story/dataset-manifest@1",
			id: "DS08",
			version: "v1",
			frozenAt: "2026-10-29",
			annotationStatus: "author_approved",
			files: [
				{ path: "dev/one.json", split: "development", sha256: sha256(bytes) },
				// Deliberately absent: a development loader that opens it would fail.
				{ path: "acceptance/secret.json", split: "acceptance", sha256: "unread" },
			],
		}),
	);
	const dataset = splitDataset(root, "DS08-fixture", "v1", "development", "E12");
	expect(dataset.json("dev/one.json")).toMatchObject({ prompt: "Development text" });
	expect(() => dataset.json("acceptance/secret.json")).toThrow(/split/u);
	expect(() => splitDataset(root, "DS08-fixture", "v1", "acceptance", "E12")).toThrow(/E13/u);
	writeFileSync(path.join(folder, "dev/one.json"), "changed");
	expect(() => dataset.json("dev/one.json")).toThrow(/digest/u);
});
