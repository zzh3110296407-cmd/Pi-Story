// Reproduce from the repository root: npm run check:upstream
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const UPSTREAM_BASELINE = "b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6";
export function readBaseline(file) {
	const baseline = JSON.parse(readFileSync(file, "utf8"));
	if (
		baseline.schema !== "story/git-tree-baseline@1" ||
		!/^[a-f0-9]{40}$/u.test(baseline.commit) ||
		!Array.isArray(baseline.entries) ||
		baseline.entries.length === 0
	)
		throw new Error("Invalid source baseline");
	const seen = new Set();
	for (const entry of baseline.entries) {
		if (
			typeof entry.file !== "string" ||
			entry.file.startsWith("/") ||
			entry.file.includes("\\") ||
			entry.file.split("/").some((part) => !part || part === "." || part === "..") ||
			!/^(100644|100755|120000)$/u.test(entry.mode) ||
			!/^[a-f0-9]{40}$/u.test(entry.oid) ||
			seen.has(entry.file)
		)
			throw new Error("Invalid source baseline entry");
		seen.add(entry.file);
	}
	return baseline;
}
function git(repositoryRoot, args) {
	const result = spawnSync(
		"git",
		["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", repositoryRoot, ...args],
		{ encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Git ${args[0]} failed: ${result.stderr.trim()}`);
	return result.stdout;
}
export function gitTree(repositoryRoot, revision, prefixes = []) {
	return git(repositoryRoot, ["ls-tree", "-rz", revision, "--", ...prefixes])
		.split("\0")
		.filter(Boolean)
		.map((row) => {
			const tab = row.indexOf("\t");
			const [mode, type, oid] = row.slice(0, tab).split(" ");
			if (type !== "blob") throw new Error("Source tree contains a non-file entry");
			return { file: row.slice(tab + 1), mode, oid };
		});
}
export function assertFrozenTree(repositoryRoot, baselineFile, revision = "HEAD") {
	const baseline = readBaseline(baselineFile);
	if (
		!Array.isArray(baseline.prefixes) ||
		baseline.prefixes.some((prefix) => typeof prefix !== "string" || !prefix.startsWith("story/testing/datasets/"))
	)
		throw new Error("Frozen dataset prefixes missing");
	const actual = gitTree(repositoryRoot, revision, baseline.prefixes);
	const expected = new Map(baseline.entries.map((entry) => [entry.file, `${entry.mode}:${entry.oid}`]));
	if (
		actual.length !== expected.size ||
		actual.some((entry) => expected.get(entry.file) !== `${entry.mode}:${entry.oid}`)
	)
		throw new Error("Frozen datasets differ from their delivery snapshot");
	return baseline.commit;
}
export function inspectUpstream(repositoryRoot) {
	if (git(repositoryRoot, ["rev-parse", "--show-prefix"]).trim())
		throw new Error("Upstream check must target the repository root");
	const baseline = readBaseline(path.join(import.meta.dirname, "baselines/pi.json"));
	if (baseline.commit !== UPSTREAM_BASELINE) throw new Error("Unexpected Pi source baseline");
	const policy = JSON.parse(readFileSync(path.join(import.meta.dirname, "upstream-allowlist.json"), "utf8"));
	for (const name of ["modifiedBaseline", "newPaths"]) {
		if (
			!Array.isArray(policy[name]) ||
			policy[name].some((rule) => typeof rule.path !== "string" || !rule.reason?.trim())
		)
			throw new Error(`Invalid upstream policy ${name}`);
	}
	const expected = new Map(baseline.entries.map((entry) => [entry.file, entry]));
	const forbidden = (file) => {
		if (file.startsWith("packages/")) return true;
		const rules = expected.has(file) ? policy.modifiedBaseline : policy.newPaths;
		return !rules.some((rule) =>
			rule.path.endsWith("/*") ? file.startsWith(rule.path.slice(0, -1)) : file === rule.path,
		);
	};
	const same = (before, after) => before?.oid === after?.oid && before?.mode === after?.mode;
	const head = new Map(gitTree(repositoryRoot, "HEAD").map((entry) => [entry.file, entry]));
	const index = new Map(
		git(repositoryRoot, ["ls-files", "--stage", "-z"])
			.split("\0")
			.filter(Boolean)
			.map((row) => {
				const tab = row.indexOf("\t");
				const [mode, oid, stage] = row.slice(0, tab).split(" ");
				if (stage !== "0") throw new Error("Resolve index conflicts before checking the Pi boundary");
				const file = row.slice(tab + 1);
				return [file, { file, mode, oid }];
			}),
	);
	const violations = [];
	for (const [layer, entries] of [
		["HEAD", head],
		["index", index],
	]) {
		const files = [...new Set([...expected.keys(), ...entries.keys()])].filter(
			(file) => forbidden(file) && !same(expected.get(file), entries.get(file)),
		);
		if (files.length) violations.push({ layer, files });
	}
	// Inspect index mismatches as well as Git's changed working paths: a restored
	// working file must not hide an independently staged modification.
	const candidates = new Set(
		git(repositoryRoot, ["diff-files", "--name-only", "-z", "--"]).split("\0").filter(Boolean),
	);
	for (const file of new Set([...expected.keys(), ...index.keys()]))
		if (!same(expected.get(file), index.get(file))) candidates.add(file);
	const files = [];
	for (const file of candidates) {
		if (!forbidden(file)) continue;
		if (!existsSync(path.join(repositoryRoot, file))) {
			if (expected.has(file)) files.push(file);
			continue;
		}
		const oid = git(repositoryRoot, ["hash-object", `--path=${file}`, "--", file]).trim();
		if (oid !== expected.get(file)?.oid) files.push(file);
	}
	if (files.length) violations.push({ layer: "worktree", files });
	const untracked = git(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
		.split("\0")
		.filter(Boolean)
		.filter(forbidden);
	if (untracked.length) violations.push({ layer: "untracked", files: untracked });
	return { baseline: baseline.commit, violations };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const result = inspectUpstream(path.resolve(import.meta.dirname, "../.."));
		if (result.violations.length) {
			console.error(`Protected Pi source differs from ${result.baseline}:`);
			for (const { layer, files } of result.violations) for (const file of files) console.error(`  ${layer}: ${file}`);
			process.exitCode = 1;
		} else console.log(`Pi source boundary matches ${result.baseline} (history-free manifest; packages immutable).`);
	} catch (error) {
		console.error(`Cannot verify Pi packages/: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
