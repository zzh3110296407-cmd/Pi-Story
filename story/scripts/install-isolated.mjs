// Reproduce: node story/scripts/install-isolated.mjs (project dependencies, no root install).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

const source = path.resolve(import.meta.dirname, "..");
const root = path.resolve(process.env.PI_STORY_WORK_DIR ?? path.join(source, "testing/exec"));
const runtime = path.join(root, "runtime");
for (const folder of ["runtime", "temp", "npm-cache", "node-compile-cache", "empty-env", "logs"])
	mkdirSync(path.join(root, folder), { recursive: true });
copyFileSync(path.join(source, "package.json"), path.join(runtime, "package.json"));
if (existsSync(path.join(source, "package-lock.json")))
	copyFileSync(path.join(source, "package-lock.json"), path.join(runtime, "package-lock.json"));
for (const area of ["packages", "apps"]) {
	const folder = path.join(source, area);
	if (!existsSync(folder)) continue;
	for (const entry of readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
		const packageSource = path.join(folder, entry.name);
		const packageRuntime = path.join(runtime, area, entry.name);
		mkdirSync(packageRuntime, { recursive: true });
		copyFileSync(path.join(packageSource, "package.json"), path.join(packageRuntime, "package.json"));
		if (existsSync(path.join(packageSource, "src")) && !existsSync(path.join(packageRuntime, "src")))
			symlinkSync(path.join(packageSource, "src"), path.join(packageRuntime, "src"), "junction");
	}
}
const environment = {};
for (const name of [
	"PATH",
	"SystemRoot",
	"ComSpec",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"APPDATA",
	"LOCALAPPDATA",
]) {
	if (process.env[name] !== undefined) environment[name] = process.env[name];
}
Object.assign(environment, {
	TEMP: path.join(root, "temp"),
	TMP: path.join(root, "temp"),
	TMPDIR: path.join(root, "temp"),
	NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
	NODE_COMPILE_CACHE: path.join(root, "node-compile-cache"),
	NPM_CONFIG_USERCONFIG: path.join(root, "empty-npmrc"),
});
writeFileSync(environment.NPM_CONFIG_USERCONFIG, "");
const npmCli = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const result = spawnSync(process.execPath, [npmCli, "install", "--ignore-scripts", "--no-audit", "--no-fund"], {
	cwd: runtime,
	env: environment,
	encoding: "utf8",
	windowsHide: true,
	maxBuffer: 32 * 1024 * 1024,
});
const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
assert(!/sk-[A-Za-z0-9_-]{20,}/u.test(output), "Secret-like output discarded");
writeFileSync(path.join(root, "logs/install.log"), output);
assert.equal(result.status, 0, output);
copyFileSync(path.join(runtime, "package-lock.json"), path.join(source, "package-lock.json"));
const modules = path.join(source, "node_modules");
// Only replace the junction itself when changing the phase's dependency runtime.
// Never remove an installed directory or touch the previous runtime's contents.
if (existsSync(modules) && realpathSync(modules) !== realpathSync(path.join(runtime, "node_modules"))) {
	assert(lstatSync(modules).isSymbolicLink(), "Refusing to replace a physical node_modules directory");
	unlinkSync(modules);
}
if (!existsSync(modules)) symlinkSync(path.join(runtime, "node_modules"), modules, "junction");
assert.equal(realpathSync(modules), realpathSync(path.join(runtime, "node_modules")));
console.log(`Project dependencies installed under ${runtime}; story/node_modules is a junction.`);
