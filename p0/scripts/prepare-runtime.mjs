// Reproduce: node p0/scripts/prepare-runtime.mjs [install|build]
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = "D:/开源/test/pi-Story/p0";
const piRoot = join(root, "pi");
const mode = process.argv[2] ?? "install";
if (!["install", "build", "offline", "check"].includes(mode)) throw new Error("Expected install, build, offline or check");
for (const dir of ["temp", "cache", "agent-home", "runs/S0"]) mkdirSync(join(root, dir), { recursive: true });
const environment = {
	...process.env,
	TEMP: join(root, "temp"),
	TMP: join(root, "temp"),
	TMPDIR: join(root, "temp"),
	NPM_CONFIG_CACHE: join(root, "cache/npm"),
	PI_CODING_AGENT_DIR: join(root, "agent-home"),
};
const command = { install: "npm ci --ignore-scripts", build: "npm run build", offline: "npm run build:offline", check: "npm run check" }[mode];
const startedAt = new Date().toISOString();
const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
	cwd: piRoot,
	env: environment,
	encoding: "utf8",
	maxBuffer: 32 * 1024 * 1024,
	windowsHide: true,
});
const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const secret = process.env.DEEPSEEK_API_KEY;
if ((secret && output.includes(secret)) || /sk-[A-Za-z0-9_-]{20,}/.test(output)) {
	throw new Error("Secret detected: command output discarded without saving");
}
const logPath = join(root, "runs/S0", `${mode}.log`);
writeFileSync(logPath, output);
writeFileSync(join(root, "runs/S0", `${mode}.json`), JSON.stringify({
	command, cwd: piRoot, startedAt, endedAt: new Date().toISOString(),
	exitCode: result.status, error: result.error?.message, logPath,
}, null, 2));
console.log(JSON.stringify({ mode, exitCode: result.status, logPath, error: result.error?.message }));
console.log(mode === "check" ? output : output.split(/\r?\n/).slice(-24).join("\n"));
process.exitCode = result.status ?? 1;
