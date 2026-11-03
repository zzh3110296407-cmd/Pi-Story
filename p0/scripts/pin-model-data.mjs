// Reproduce: node p0/scripts/pin-model-data.mjs, then prepare-runtime.mjs offline
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const source = "D:/AI/Multiple Agent For Stores/Pi/pi/packages/ai/src/providers/data";
const target = "D:/开源/test/pi-Story/p0/pi/packages/ai/src/providers/data";
const evidence = "D:/开源/test/pi-Story/p0/runs/S0";
mkdirSync(target, { recursive: true });
const hashes = [];
for (const name of readdirSync(source).filter((file) => file.endsWith(".json"))) {
	const bytes = readFileSync(join(source, name));
	const text = bytes.toString("utf8");
	if ((process.env.DEEPSEEK_API_KEY && text.includes(process.env.DEEPSEEK_API_KEY)) || /sk-[A-Za-z0-9_-]{20,}/.test(text)) {
		throw new Error("Secret detected: model catalog was not copied");
	}
	writeFileSync(join(target, name), bytes);
	hashes.push({ name, sha256: createHash("sha256").update(bytes).digest("hex") });
}
writeFileSync(join(evidence, "model-data-snapshot.json"), JSON.stringify({ source, target, copiedAt: new Date().toISOString(), hashes }, null, 2));
console.log(JSON.stringify({ source, target, files: hashes.length }));
