import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { EvidenceArchive, readEvidence } from "../../../scripts/eval/p2/artifacts.ts";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { scoreProgram } from "../../../scripts/eval/p2/program-score.ts";
import { allRealScores } from "../../../scripts/eval/p2/rescore.ts";
import { scoreEvidence } from "../../../scripts/eval/p2/score.ts";
import { scanSecrets } from "../../../scripts/eval/p2/secrets.mjs";

test("P2 secret scanning inspects compressed evidence, redacts values and never reads an environment file", () => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("P2 workspace required");
	mkdirSync(path.join(work, "temp"), { recursive: true });
	const root = mkdtempSync(path.join(work, "temp/secret-scan-"));
	const token = `sk-${"x".repeat(24)}`;
	const zipped = path.join(root, "evidence.jsonl.gz");
	const environment = path.join(root, ".env");
	try {
		writeFileSync(zipped, gzipSync(JSON.stringify({ sample: token })));
		writeFileSync(environment, token);
		const result = scanSecrets([root, root], process.cwd());
		expect(result).toMatchObject({
			files: 1,
			passed: false,
			hits: [{ path: zipped, category: "key_like" }],
			environmentFiles: [{ path: environment, read: false, knownSynthetic: false }],
		});
		expect(JSON.stringify(result)).not.toContain(token);
	} finally {
		unlinkSync(zipped);
		unlinkSync(environment);
	}
});

test("offline closeout cannot pass an empty or differing rescore, a secret hit or an excessive fee", () => {
	const score = (suiteId: string, payload: unknown) => scoreProgram({ suiteId, runId: "faux", payload }).metrics[0];
	expect(score("P2-RESCORE", []).passed).toBe(false);
	expect(
		score("P2-RESCORE", [
			{ folder: "one", equal: true },
			{ folder: "two", equal: false },
		]),
	).toMatchObject({ value: 0.5, passed: false });
	expect(score("P2-RESCORE", [{ folder: "one", equal: true }]).passed).toBe(true);
	const scan = { files: 1, hits: [], passed: true };
	const fees = { totalUsd: 2, knownUsd: 1, reservedUsd: 1, unknownCalls: 1 };
	expect(score("P2-Z", { scan, fees }).passed).toBe(true);
	expect(score("P2-Z", { scan: { ...scan, hits: [{}], passed: false }, fees }).passed).toBe(false);
	expect(score("P2-Z", { scan, fees: { ...fees, totalUsd: 25.01 } }).passed).toBe(false);
});

test("secret scanning accepts a legal compressed archive even when its repeated context expands beyond 64 MiB", () => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("P2 workspace required");
	const root = mkdtempSync(path.join(work, "temp/secret-scan-large-"));
	const file = path.join(root, "evidence.jsonl.gz");
	const token = `sk-${"x".repeat(24)}`;
	try {
		const compressed = gzipSync(`${" ".repeat(65 * 1024 * 1024)}${JSON.stringify({ sample: token })}`);
		expect(compressed.length).toBeLessThan(10 * 1024 * 1024);
		writeFileSync(file, compressed);
		expect(scanSecrets([root], process.cwd())).toMatchObject({ files: 1, passed: false, hits: [{ path: file }] });
	} finally {
		unlinkSync(file);
	}
});

test("all-real scoring exposes diagnostic hard metrics instead of silently filtering them out", () => {
	const result = scoreEvidence([{ type: "meta", suiteId: "P2-PROBE", runId: "faux", expectedCaseIds: [] }], [], true);
	expect(result.metrics.find((metric) => metric.id === "H12")).toBeDefined();
});

test("a reserved internal call without a persisted observation cannot disappear from all-real gates", () => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("P2 workspace required");
	const root = mkdtempSync(path.join(work, "temp/all-real-"));
	const fees = new UsageLedger(path.join(root, "usage-ledger.jsonl"), path.join(root, "request-reservations.jsonl"));
	fees.reserve({
		runId: "faux",
		suiteId: "P2-PROBE",
		role: "editor",
		model: "faux",
		reservedCostUsd: 0.1,
		reservedInputTokens: 10,
		reservedOutputTokens: 10,
		runLimitUsd: 1,
	});
	expect(() => allRealScores(root)).toThrow(/no archived raw evidence/u);
	const archive = new EvidenceArchive(path.join(root, "P2-PROBE/faux"), path.join(root, "work"), {
		suiteId: "P2-PROBE",
		runId: "faux",
		expectedCaseIds: [],
	});
	archive.finish();
	const result = allRealScores(root);
	expect(result.runs).toMatchObject([{ internalRequests: 1, missingObservations: 1 }]);
	expect(result.metrics.find((metric) => metric.id === "H12")).toMatchObject({ n: 1, value: 0, passed: false });
	expect(result.metrics.find((metric) => metric.id === "C04")).toMatchObject({ n: 1, value: 0, passed: false });
	expect(result.metrics.find((metric) => metric.id === "H09")).toMatchObject({ unknownCalls: 1, passed: null });
});

test("offline evidence reading accepts an archive within the compressed limits when expanded context is large", () => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("P2 workspace required");
	const root = mkdtempSync(path.join(work, "temp/large-archive-"));
	const folder = path.join(root, "run");
	const archive = new EvidenceArchive(folder, path.join(root, "work"), {
		suiteId: "P2-OPEN",
		runId: "faux",
		expectedCaseIds: [],
	});
	try {
		archive.emit({ type: "repeated_context", text: " ".repeat(65 * 1024 * 1024) });
		archive.finish();
		const records = readEvidence(folder);
		expect(records).toHaveLength(2);
		expect(records[1].text).toHaveLength(65 * 1024 * 1024);
	} finally {
		for (const file of [
			archive.workFile,
			path.join(folder, "raw/evidence.jsonl.gz"),
			path.join(folder, "raw/checksums.json"),
		])
			if (existsSync(file)) unlinkSync(file);
	}
});

test("a published dependency example is excluded only while the complete file matches the verified package", () => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("P2 workspace required");
	const relative = "node_modules/@anthropic-ai/sdk/lib/helper-client.d.ts";
	const original = readFileSync(path.join(work, "pi", relative));
	const root = mkdtempSync(path.join(work, "temp/dependency-secret-fixture-"));
	const file = path.join(root, relative);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, original);
	try {
		expect(scanSecrets([root], process.cwd())).toMatchObject({
			passed: true,
			hits: [],
			syntheticFixtures: [{ path: file }],
		});
		writeFileSync(file, `${original.toString("utf8")}\n${`sk-${"x".repeat(24)}`}\n`);
		const changed = scanSecrets([root], process.cwd());
		expect(changed.passed).toBe(false);
		expect(changed.hits.some((hit) => hit.category === "key_like")).toBe(true);
		expect(changed.syntheticFixtures).toEqual([]);
	} finally {
		writeFileSync(file, original);
	}
});

test("a public Pi fixture uses its complete frozen blob without requiring the old commit object", () => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("Project workspace required");
	const relative = "packages/ai/test/anthropic-auth-token.test.ts";
	const original = readFileSync(path.resolve(import.meta.dirname, "../../../..", relative));
	const root = mkdtempSync(path.join(work, "temp/pi-secret-fixture-"));
	const file = path.join(root, relative);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, original);
	try {
		expect(scanSecrets([root], root)).toMatchObject({ passed: true, hits: [] });
		writeFileSync(file, `${original.toString("utf8")}\nchanged\n`);
		expect(scanSecrets([root], root)).toMatchObject({ passed: false });
	} finally {
		writeFileSync(file, original);
	}
	expect(scanSecrets([root], root)).toMatchObject({ passed: true, hits: [] });
});
