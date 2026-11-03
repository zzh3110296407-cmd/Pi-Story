import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { readBaseline } from "../../check-upstream.mjs";

const material =
	/\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~+/-]{8,})|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/gu;
const textFile = /\.(?:[cm]?js|tsx?|jsonl?|md|txt|log|ya?ml|toml|ini|sh|ps1|css|html|svg|pem|key|lock|npmrc|gz)$/iu;
const baseline = "b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6";
const pi = readBaseline(new URL("../../baselines/pi.json", import.meta.url));
if (pi.commit !== baseline) throw new Error("Pi secret fixture baseline differs");
const sourceBlobs = new Map(pi.entries.map((entry) => [entry.file, entry.oid]));
const publishedFixtures = JSON.parse(readFileSync(new URL("./public-secret-fixtures.json", import.meta.url), "utf8"));
if (publishedFixtures.schema !== "story/public-secret-fixtures@1" || publishedFixtures.upstreamLockCommit !== baseline)
	throw new Error("Public dependency fixture proof does not match the pinned upstream lock");

// Scan bytes without exposing matched values. Environment files are reported by
// path only; compressed model evidence is decoded before applying the patterns.
export function scanSecrets(scopes, _repository) {
	const hits = [],
		syntheticFixtures = [],
		environmentFiles = [],
		skippedLinks = [];
	const visited = new Set();
	let files = 0,
		bytes = 0;
	function publicFixture(file, text, value) {
		if (!value.startsWith("Bearer ") || !/^Bearer [a-z]+(?:[-_][a-z]+)*$/u.test(value)) return false;
		const normalized = file.replaceAll("\\", "/");
		const index = normalized.lastIndexOf("/packages/");
		if (index < 0) return false;
		const relative = normalized.slice(index + 1);
		if (!/^packages\/(?:ai|coding-agent|evals|mcp)\/(?:test\/|evals\/acme-server\.ts$)/u.test(relative)) return false;
		const bytes = Buffer.from(text.replace(/\r\n?/gu, "\n"));
		const oid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
		return sourceBlobs.get(relative) === oid;
	}
	function visit(file) {
		const name = path.basename(file);
		if (/^\.env(?:\.|$)/iu.test(name) || /\.env$/iu.test(name)) {
			environmentFiles.push({ path: file, read: false, knownSynthetic: /[\\/]dataset-guard[\\/]/u.test(file) });
			return;
		}
		if (!textFile.test(name) && !name.startsWith(".")) return;
		let data = readFileSync(file);
		if (name.endsWith(".gz")) data = gunzipSync(data);
		else if (data.subarray(0, 8192).includes(0)) return;
		const text = data.toString("utf8");
		const normalized = file.replaceAll("\\", "/");
		const published = publishedFixtures.files.find(
			(proof) =>
				normalized.endsWith(`/node_modules/${proof.package}/${proof.relative}`) &&
				proof.sha256 === createHash("sha256").update(data).digest("hex"),
		);
		files++;
		bytes += data.length;
		for (const match of text.matchAll(material)) {
			const row = {
				path: file,
				line: text.slice(0, match.index).split("\n").length,
				category: match[0].startsWith("Bearer") ? "bearer" : match[0].startsWith("-----") ? "private_key" : "key_like",
				candidateDigest: createHash("sha256").update(match[0]).digest("hex"),
			};
			if (published?.candidateDigests.includes(row.candidateDigest))
				syntheticFixtures.push({
					...row,
					reason: `${published.reason}; entire file equals the integrity-verified pinned package archive`,
				});
			else if (publicFixture(file, text, match[0]))
				syntheticFixtures.push({
					...row,
					reason: "word-only public fixture; entire source file equals the pinned Pi baseline",
				});
			else if (/^sk-x{24}$/u.test(match[0]) && /[\\/]dataset-guard[\\/]/u.test(file))
				syntheticFixtures.push({ ...row, reason: "exact deterministic dataset-guard negative fixture" });
			else hits.push(row);
		}
	}
	function walk(folder) {
		const canonical = path.resolve(folder).toLowerCase();
		if (visited.has(canonical)) return;
		visited.add(canonical);
		for (const entry of readdirSync(folder, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const file = path.join(folder, entry.name);
			if (entry.isSymbolicLink()) skippedLinks.push(file);
			else if (entry.isDirectory()) walk(file);
			else if (entry.isFile()) visit(file);
		}
	}
	for (const scope of scopes) walk(path.resolve(scope));
	return {
		schema: "story/secret-scan@2",
		scopes: scopes.map((scope) => path.resolve(scope)),
		method:
			"repository/workspace text including decompressed gzip; environment files and .git internals are not read; binary files and links are not followed",
		files,
		bytes,
		hits,
		syntheticFixtures,
		environmentFiles,
		skippedLinks,
		passed: hits.length === 0 && environmentFiles.every((file) => file.knownSynthetic),
	};
}
