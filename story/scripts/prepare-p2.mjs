// node story/scripts/prepare-p2.mjs [prepare|install|build|all]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PI_COMMIT = "b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6";
// The pinned catalog predates Pro's low support. Use Pi's own configuration
// layer; leave the archived catalog, source, prices and authentication intact.
export function piModelOverrides() {
	return { providers: { deepseek: { modelOverrides: { "deepseek-v4-pro": { thinkingLevelMap: { low: "low" } } } } } };
}
// R5 selected Flash low for the main agent and editor; keeper and writer retain
// Flash low. This is the V2 default template (selection evidence: ADR-020).
export function settingsTemplate(workDir) {
	return {
		schema: "story/global-settings@1",
		storiesDir: path.join(workDir, "stories"),
		defaultLevel: "L1",
		localRevision: true,
		roles: Object.fromEntries(
			["writer", "editor", "keeper", "verifier"].map((role, index) => [
				role,
				{
					model: "deepseek/deepseek-flash",
					thinking: "low",
					maxTokens: role === "verifier" ? 8192 : 32768,
					temperature: [0.9, 0.2, 0, 0][index],
				},
			]),
		),
		defaultBudget: { tokens: null, costUsd: null },
		bridge: { port: 0 },
	};
}

export function runtimeEnvironment(workDir, source = process.env) {
	const env = {};
	for (const name of [
		"PATH",
		"SystemRoot",
		"ComSpec",
		"USERPROFILE",
		"HOMEDRIVE",
		"HOMEPATH",
		"APPDATA",
		"LOCALAPPDATA",
	])
		if (source[name] !== undefined) env[name] = source[name];
	return Object.assign(env, {
		TEMP: path.join(workDir, "temp"),
		TMP: path.join(workDir, "temp"),
		TMPDIR: path.join(workDir, "temp"),
		NPM_CONFIG_CACHE: path.join(workDir, "npm-cache"),
		NPM_CONFIG_USERCONFIG: path.join(workDir, "empty-npmrc"),
		NODE_COMPILE_CACHE: path.join(workDir, "node-compile-cache"),
		PI_CODING_AGENT_DIR: path.join(workDir, "build-agent"),
	});
}

export function copyModelSnapshot(source, target) {
	const manifestBytes = readFileSync(path.join(source, ".manifest.json"));
	const manifest = JSON.parse(manifestBytes);
	assert.equal(manifest.schemaVersion, 6, "Unsupported model snapshot version");
	const files = Object.entries(manifest.files).map(([name, hash]) => {
		assert(/^[a-z0-9-]+\.json$/u.test(name), "Invalid snapshot filename");
		const bytes = readFileSync(path.join(source, name));
		assert.equal(createHash("sha256").update(bytes).digest("hex"), hash, `Model snapshot hash mismatch: ${name}`);
		return { name, bytes };
	});
	mkdirSync(target, { recursive: true });
	for (const { name, bytes } of files) writeFileSync(path.join(target, name), bytes);
	copyFileSync(path.join(source, ".manifest.json"), path.join(target, ".manifest.json"));
	return { manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"), files: manifest.files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const mode = process.argv[2] ?? "all";
	assert(["prepare", "install", "build", "all"].includes(mode), "Expected prepare, install, build or all");
	const repo = path.resolve(import.meta.dirname, "../..");
	const workDir = path.resolve(process.env.PI_STORY_WORK_DIR ?? path.join(repo, "story/testing/exec"));
	const pi = path.join(workDir, "pi");
	for (const name of ["temp", "npm-cache", "node-compile-cache", "build-agent", "logs"])
		mkdirSync(path.join(workDir, name), { recursive: true });
	writeFileSync(path.join(workDir, "empty-npmrc"), "");
	const env = runtimeEnvironment(workDir);
	const command = (name, executable, args, cwd) => {
		const result = spawnSync(executable, args, {
			cwd,
			env,
			encoding: "utf8",
			windowsHide: true,
			maxBuffer: 32 * 1024 * 1024,
		});
		const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
		assert(!/sk-[A-Za-z0-9_-]{20,}/u.test(output), "Sensitive command output discarded");
		writeFileSync(path.join(workDir, "logs", `${name}.log`), output);
		assert.equal(result.status, 0, `${name} failed; inspect its workspace log`);
		console.log(`${name}: passed`);
	};
	if (mode === "prepare" || mode === "all") {
		assert(
			!existsSync(pi) || readdirSync(pi).length === 0,
			"P2 Pi source already exists; use install/build, do not overwrite it",
		);
		mkdirSync(pi, { recursive: true });
		const archive = path.join(workDir, "pi-source.tar");
		let archiveSource = repo;
		const local = spawnSync("git", ["cat-file", "-e", `${PI_COMMIT}^{commit}`], { cwd: repo, windowsHide: true });
		if (local.status !== 0) {
			// Keep upstream build objects in the execution workspace, never in the
			// independent Story repository. Fetch one pinned commit without parents.
			archiveSource = path.join(workDir, "pi-upstream.git");
			if (!existsSync(archiveSource)) command("source-init", "git", ["init", "--bare", archiveSource], workDir);
			const cached = spawnSync("git", ["cat-file", "-e", `${PI_COMMIT}^{commit}`], {
				cwd: archiveSource,
				windowsHide: true,
			});
			if (cached.status !== 0)
				command(
					"source-fetch",
					"git",
					["fetch", "--depth=1", "https://github.com/earendil-works/pi.git", PI_COMMIT],
					archiveSource,
				);
		}
		command("archive", "git", ["archive", "--format=tar", `--output=${archive}`, PI_COMMIT], archiveSource);
		// Windows bsdtar loses non-ASCII argv paths. Relative ASCII paths retain the Unicode cwd.
		command("extract", "tar", ["-xf", "pi-source.tar", "-C", "pi"], workDir);
		const source = process.env.PI_STORY_MODEL_SNAPSHOT ?? path.join(workDir, "model-snapshot");
		const snapshot = copyModelSnapshot(source, path.join(pi, "packages/ai/src/providers/data"));
		writeFileSync(
			path.join(workDir, "pi-build.json"),
			`${JSON.stringify(
				{
					schema: "story/pi-build@1",
					commit: PI_COMMIT,
					sourceKind: "git_archive",
					archiveSha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
					modelSnapshot: snapshot,
					node: process.version,
					install: "npm ci --ignore-scripts",
					build: "npm run build:offline",
				},
				null,
				2,
			)}\n`,
		);
		writeFileSync(
			path.join(workDir, "story-forge.template.json"),
			`${JSON.stringify(settingsTemplate(workDir), null, 2)}\n`,
		);
	}
	const provenance = JSON.parse(readFileSync(path.join(workDir, "pi-build.json"), "utf8"));
	assert.equal(provenance.commit, PI_COMMIT);
	const npm = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
	if (mode === "install" || mode === "all")
		command("pi-install", process.execPath, [npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], pi);
	if (mode === "build" || mode === "all") {
		command("pi-build-offline", process.execPath, [npm, "run", "build:offline"], pi);
		assert(existsSync(path.join(pi, "packages/coding-agent/dist/cli.js")), "Missing built Pi CLI");
		writeFileSync(path.join(workDir, "pi-build.json"), `${JSON.stringify({ ...provenance, built: true }, null, 2)}\n`);
	}
}
