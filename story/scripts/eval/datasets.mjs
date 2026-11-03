import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { inside } from "./paths.mjs";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export function verifyDataset(root, directory, version = "v1") {
	const folder = path.resolve(root, "datasets", directory, version);
	if (!inside(path.resolve(root, "datasets"), folder)) throw new Error("Unsafe dataset directory");
	const bytes = readFileSync(path.join(folder, "manifest.json"));
	const manifest = JSON.parse(bytes);
	if (
		manifest.schema !== "story/dataset-manifest@1" ||
		manifest.version !== version ||
		!manifest.frozenAt ||
		!manifest.files?.length
	)
		throw new Error(`Dataset is not frozen: ${directory}/${version}`);
	const registered = new Set(["manifest.json"]);
	for (const file of manifest.files) {
		const target = path.resolve(folder, file.path);
		if (!inside(folder, target) || /^\.env(?:\.|$)/iu.test(path.basename(target)))
			throw new Error(`Unsafe dataset path: ${file.path}`);
		const relative = path.relative(folder, target).split(path.sep).join("/");
		if (registered.has(relative)) throw new Error(`Duplicate dataset file: ${file.path}`);
		registered.add(relative);
		if (sha256(readFileSync(target)) !== file.sha256)
			throw new Error(`Dataset digest mismatch: ${directory}/${version}/${file.path}`);
	}
	const visit = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const target = path.join(current, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Unsafe dataset link: ${entry.name}`);
			if (entry.isDirectory()) visit(target);
			else if (!registered.has(path.relative(folder, target).split(path.sep).join("/")))
				throw new Error(`Unregistered dataset file: ${target}`);
		}
	};
	visit(folder);
	return { folder, manifest, manifestDigest: sha256(bytes) };
}
