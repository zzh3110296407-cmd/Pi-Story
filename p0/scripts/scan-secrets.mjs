// Reproduce: node p0/scripts/scan-secrets.mjs. Never prints matched values.
import { createReadStream, existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const runtime = path.resolve("D:/开源/test/pi-Story/p0");
const roots = [project, runtime];
const base = "b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6";
const excludedNames = new Set([".git", "node_modules", "cache", "npm-cache", ".cache", "browser-profile", "python312-deps", "__pycache__"]);
const excluded = [];
const inheritedPatterns = [];
const findings = [];
const key = process.env.DEEPSEEK_API_KEY;
let files = 0;
let bytes = 0;

async function visit(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const filename = path.join(directory, entry.name);
		if (entry.isSymbolicLink() || (entry.isDirectory() && excludedNames.has(entry.name)) || /^\.env(?:\.|$)/u.test(entry.name)) { excluded.push(filename); continue; }
		if (entry.isDirectory()) { await visit(filename); continue; }
		if (!entry.isFile()) continue;
		let tail = Buffer.alloc(0);
		let actualKey = false;
		let longPattern = false;
		for await (const chunk of createReadStream(filename)) {
			bytes += chunk.length;
			const buffer = Buffer.concat([tail, chunk]);
			if (key && buffer.includes(Buffer.from(key))) actualKey = true;
			if (/sk-[A-Za-z0-9_-]{20,}/u.test(buffer.toString("utf8"))) longPattern = true;
			tail = buffer.subarray(Math.max(0, buffer.length - Math.max(256, key?.length ?? 0)));
		}
		files++;
		if (!actualKey && !longPattern) continue;
		const clone = path.join(runtime, "pi");
		const repository = filename.startsWith(`${project}${path.sep}`) ? project : filename.startsWith(`${clone}${path.sep}`) ? clone : undefined;
		let inherited = false;
		if (repository && !actualKey) {
			const relative = path.relative(repository, filename).replaceAll("\\", "/");
			const current = spawnSync("git", ["hash-object", "--", filename], { encoding: "utf8", windowsHide: true });
			const original = spawnSync("git", ["rev-parse", `${base}:${relative}`], { cwd: repository, encoding: "utf8", windowsHide: true });
			inherited = current.status === 0 && original.status === 0 && current.stdout.trim() === original.stdout.trim();
		}
		if (inherited) { inheritedPatterns.push({ file: filename, reason: "Unchanged fixed-base file; current environment key did not match. Pattern requires classification before closeout." }); continue; }
		const generatedLog = filename.startsWith(`${path.join(runtime, "runs")}${path.sep}`) && /\.(?:log|jsonl|json|txt)$/u.test(filename);
		if (generatedLog) unlinkSync(filename);
		findings.push({ file: filename, actualKey, longPattern, deletedGeneratedLog: generatedLog });
	}
}

for (const root of roots) if (existsSync(root)) await visit(root);
const report = { finished: new Date().toISOString(), roots, files, bytes, environmentKeyPresent: Boolean(key), findings, inheritedPatterns, excluded, scope: "All regular files including binary and generated dist; skips Git internals, dependency/cache/browser directories, symlinks, and .env files. No credential files were opened." };
const reportFile = path.join(runtime, "runs/S0/secret-scan.json");
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ reportFile, files, bytes, findings: findings.length, inheritedPatternFiles: inheritedPatterns.length, excluded: excluded.length }));
process.exitCode = findings.length ? 1 : 0;
