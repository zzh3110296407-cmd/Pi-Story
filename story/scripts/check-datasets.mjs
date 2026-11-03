import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { verifyDataset } from "./eval/datasets.mjs";
import { testingPaths } from "./eval/paths.mjs";

// Report paths and categories only: never echo a matching credential value.
const credentials =
	/(?:^|[\s"'{,])(?:authorization|proxy-authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|client[-_]?secret|secret[-_]?key|password)["']?\s*[:=]/imu;
const keyMaterial =
	/\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~+/-]{8,})|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u;

export function scanPublicContent(root) {
	let files = 0;
	const visit = (folder) => {
		for (const entry of readdirSync(folder, { withFileTypes: true })) {
			// The execution workspace holds dependencies and private sessions, not
			// public datasets or archived runs. P2-Z scans it separately.
			if (folder === root && ["private", "exec"].includes(entry.name)) continue;
			const target = path.join(folder, entry.name);
			const relative = path.relative(root, target);
			if (/^\.env(?:\.|$)/iu.test(entry.name)) throw new Error(`Forbidden environment file: ${relative}`);
			if (entry.isSymbolicLink()) throw new Error(`Public testing content cannot contain links: ${relative}`);
			if (entry.isDirectory()) visit(target);
			else {
				if (statSync(target).size > 10 * 1024 * 1024) throw new Error(`Testing file exceeds 10 MB: ${relative}`);
				const bytes = readFileSync(target);
				const text = (
					entry.name.endsWith(".gz") ? gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }) : bytes
				).toString("utf8");
				if (credentials.test(text)) throw new Error(`Forbidden authentication field: ${relative}`);
				if (keyMaterial.test(text)) throw new Error(`Forbidden key material: ${relative}`);
				files++;
			}
		}
	};
	visit(root);
	return files;
}

function checkCommittedVersions(root) {
	const repository = path.resolve(root, "../..");
	if (!existsSync(path.join(repository, ".git"))) return; // git archive exports have no Git metadata.
	const prefix = `${path.relative(repository, root).split(path.sep).join("/")}/datasets/`;
	const git = (...args) => {
		const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", windowsHide: true });
		if (result.status !== 0) throw new Error("Committed dataset evidence unavailable");
		return result.stdout.split("\0").filter(Boolean);
	};
	const versions = new Set(
		git("ls-tree", "-r", "--name-only", "-z", "HEAD", "--", prefix).map((file) =>
			file.slice(prefix.length).split("/").slice(0, 2).join("/"),
		),
	);
	const changed = [
		...git("diff", "--name-only", "-z", "--", prefix),
		...git("diff", "--cached", "--name-only", "-z", "--", prefix),
		...git("ls-files", "--others", "--exclude-standard", "-z", "--", prefix),
	];
	for (const file of changed) {
		if (versions.has(file.slice(prefix.length).split("/").slice(0, 2).join("/")))
			throw new Error(`Committed dataset version is immutable: ${file}`);
	}
}

export function inspectTesting(root = testingPaths().testRoot) {
	root = path.resolve(root);
	const datasets = path.join(root, "datasets");
	if (!existsSync(datasets)) throw new Error(`Missing datasets directory: ${datasets}`);
	let versions = 0;
	for (const dataset of readdirSync(datasets, { withFileTypes: true })) {
		if (!dataset.isDirectory()) throw new Error(`Unexpected dataset entry: ${dataset.name}`);
		for (const version of readdirSync(path.join(datasets, dataset.name), { withFileTypes: true })) {
			if (!version.isDirectory() || !/^v[1-9]\d*$/u.test(version.name))
				throw new Error(`Unexpected dataset version: ${dataset.name}/${version.name}`);
			verifyDataset(root, dataset.name, version.name);
			versions++;
		}
	}
	const files = scanPublicContent(root);
	checkCommittedVersions(root);
	return { versions, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		const result = inspectTesting(process.argv[2]);
		console.log(`Testing content verified: ${result.versions} dataset versions, ${result.files} public files.`);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
