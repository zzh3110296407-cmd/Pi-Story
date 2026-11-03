import { readFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./artifacts.ts";

export type Split = "development" | "acceptance";
interface ManifestFile {
	path: string;
	split: string;
	sha256: string;
}
interface Manifest {
	schema: string;
	id: string;
	version: string;
	frozenAt: string;
	annotationStatus: string;
	files: ManifestFile[];
}
interface InputReference {
	dataset: string;
	version: string;
	path: string;
	sha256: string;
}
interface DevelopmentInputIndex {
	schema: string;
	sourceVersion: { directory: string; version: string; manifestSha256: string };
	actualRole: string;
	passed: boolean;
	items: {
		id: string;
		originalSplit: string;
		use: string;
		input: string;
		sourceInput: string;
		sourceInputSha256: string;
		prose: InputReference;
		gold: InputReference;
		nonHookDataUnchanged: boolean;
	}[];
}
interface FrozenDataset {
	folder: string;
	manifest: Manifest;
	files: ManifestFile[];
	manifestDigest: string;
	text(relative: string): string;
	json(relative: string): unknown;
	chapterSubset(): (string | number)[];
	inputOverride?: {
		version: string;
		manifestDigest: string;
		indexPath: string;
		indexDigest: string;
		sourceManifestDigest: string;
		cases: number;
	};
}
export function splitDataset(
	root: string,
	directory: string,
	version: string,
	split: Split,
	phase: "E12" | "E13",
	reuseV1Acceptance = false,
	inputPatchVersion?: string,
): FrozenDataset {
	if (
		inputPatchVersion &&
		(version !== "v1" ||
			split !== "development" ||
			phase !== "E12" ||
			!reuseV1Acceptance ||
			!["DS09-state-gold", "DS10-review-defects"].includes(directory))
	)
		throw new Error("A development input patch is only for the authorized complete v1 role development data");
	if (reuseV1Acceptance && (version !== "v1" || split !== "development" || phase !== "E12"))
		throw new Error("22 permits former acceptance reuse only for v1 development");
	if (split === "acceptance" && phase !== "E13")
		throw new Error("Acceptance may only be read by the E13 measurement script");
	const parent = path.resolve(root, "datasets");
	const folder = path.resolve(parent, directory, version);
	if (!folder.startsWith(`${parent}${path.sep}`)) throw new Error("Unsafe dataset directory");
	const bytes = readFileSync(path.join(folder, "manifest.json"));
	const manifest = JSON.parse(bytes.toString("utf8")) as Manifest;
	if (
		manifest.schema !== "story/dataset-manifest@1" ||
		manifest.version !== version ||
		!manifest.frozenAt ||
		!manifest.files?.length
	)
		throw new Error("Dataset must be frozen before use");
	const permitted = (value: string) => value === split || (reuseV1Acceptance && value === "acceptance");
	const files = manifest.files.filter((file) => permitted(file.split));
	const read = (relative: string, metadata = false): Buffer => {
		const file = manifest.files.find((file) => file.path === relative);
		if (!file || (metadata ? relative !== "chapter-subset.json" || file.split !== "metadata" : !permitted(file.split)))
			throw new Error("Dataset split boundary violation");
		if (
			(split === "development" && !reuseV1Acceptance && relative.startsWith("acceptance/")) ||
			(split === "acceptance" && relative.startsWith("dev/"))
		)
			throw new Error("Dataset split/path mismatch");
		const target = path.resolve(folder, relative);
		if (!target.startsWith(`${folder}${path.sep}`) || /^\.env(?:\.|$)/iu.test(path.basename(target)))
			throw new Error("Unsafe dataset resource path");
		const content = readFileSync(target);
		if (sha256(content) !== file.sha256) throw new Error(`Dataset digest mismatch: ${relative}`);
		return content;
	};
	const dataset: FrozenDataset = {
		folder,
		manifest,
		files,
		manifestDigest: sha256(bytes),
		text: (relative: string) => read(relative).toString("utf8"),
		json: (relative: string): unknown => JSON.parse(read(relative).toString("utf8")),
		chapterSubset(): (string | number)[] {
			const value = JSON.parse(read("chapter-subset.json", true).toString("utf8")) as {
				dev: (string | number)[];
				acceptance: (string | number)[];
			};
			return reuseV1Acceptance
				? [...value.dev, ...value.acceptance]
				: split === "development"
					? value.dev
					: value.acceptance;
		},
	};
	if (!inputPatchVersion) return dataset;
	// Read only the independently frozen development split of the supplied patch.
	// Prose/gold and case selection continue to come from the immutable v1 source.
	const patch = splitDataset(root, directory, inputPatchVersion, "development", "E12");
	const indexPath = "development-inputs/index.json";
	const indexText = patch.text(indexPath);
	const index = JSON.parse(indexText) as DevelopmentInputIndex;
	const role = directory === "DS09-state-gold" ? "keeper" : "editor";
	const entryFiles = files.filter((file) => /^(dev|acceptance)\/entries\/[^/]+\.json$/u.test(file.path));
	if (
		index.schema !== "story/development-input-patch@1" ||
		index.actualRole !== role ||
		index.passed !== true ||
		index.sourceVersion?.directory !== directory ||
		index.sourceVersion.version !== "v1" ||
		index.sourceVersion.manifestSha256 !== dataset.manifestDigest ||
		!Array.isArray(index.items) ||
		index.items.length !== entryFiles.length
	)
		throw new Error("Development input patch does not match its frozen v1 source");
	const overrides = new Map<string, string>();
	for (const item of index.items) {
		const original = entryFiles.find((file) => file.path === item.sourceInput);
		if (
			!original ||
			original.sha256 !== item.sourceInputSha256 ||
			item.use !== "R4_development_only" ||
			item.nonHookDataUnchanged !== true ||
			item.originalSplit !== original.path.split("/")[0] ||
			item.id !== path.posix.basename(original.path, ".json") ||
			typeof item.input !== "string" ||
			!item.input.startsWith("development-inputs/") ||
			!item.input.endsWith(`/${item.id}.json`) ||
			overrides.has(item.sourceInput)
		)
			throw new Error("Invalid or duplicate development input override");
		const prosePath = original.path
			.replace("/entries/", role === "keeper" ? "/chapters/" : "/variants/")
			.replace(/\.json$/u, ".md");
		const goldPath = original.path.replace("/entries/", role === "keeper" ? "/gold/" : "/defects/");
		if (item.prose?.path !== prosePath || item.gold?.path !== goldPath)
			throw new Error("Development input references a different case");
		for (const ref of [item.prose, item.gold])
			if (
				!ref ||
				ref.dataset !== directory ||
				ref.version !== "v1" ||
				!ref.path.startsWith(`${item.originalSplit}/`) ||
				!files.some((file) => file.path === ref.path && file.sha256 === ref.sha256)
			)
				throw new Error("Development prose/gold must reference the frozen v1 source");
		// Validate the replacement's frozen digest now, before creating a paid driver.
		patch.json(item.input);
		overrides.set(item.sourceInput, item.input);
	}
	return {
		...dataset,
		json: (relative) => {
			const replacement = overrides.get(relative);
			return replacement ? patch.json(replacement) : dataset.json(relative);
		},
		inputOverride: {
			version: inputPatchVersion,
			manifestDigest: patch.manifestDigest,
			indexPath,
			indexDigest: sha256(indexText),
			sourceManifestDigest: dataset.manifestDigest,
			cases: overrides.size,
		},
	};
}
export interface OpeningPrompt {
	id: string | number;
	language: string;
	task_type: string;
	prompt: string;
}
export function openingPrompts(dataset: ReturnType<typeof splitDataset>, chapters: boolean): OpeningPrompt[] {
	const subset = chapters ? new Set(dataset.chapterSubset().map(String)) : undefined;
	const result: OpeningPrompt[] = [];
	for (const file of dataset.files) {
		if (!file.path.endsWith(".json") || !/^(?:dev|acceptance)\/[^/]+\.json$/u.test(file.path)) continue;
		const value = dataset.json(file.path) as OpeningPrompt;
		if (
			(typeof value.id !== "string" && typeof value.id !== "number") ||
			value.language !== "en" ||
			typeof value.prompt !== "string" ||
			!value.prompt.trim()
		)
			throw new Error(`Invalid opening prompt: ${file.path}`);
		if (!subset || subset.has(String(value.id))) result.push(value);
	}
	if (subset && result.length !== subset.size) throw new Error("Frozen chapter subset is incomplete");
	if (!result.length) throw new Error("No prompts in the selected frozen split");
	return result;
}
