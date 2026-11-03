import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sha256 } from "../p2/artifacts.ts";
import { priorBatches } from "./main.ts";
import { executionSource, repository, stageRoot, writeRecord } from "./provenance.ts";
export function openingComparison() {
	const v4 = "a44db87ad272879275b0b2db30b8889ae8518893";
	const baseline = JSON.parse(
		readFileSync(path.resolve(import.meta.dirname, "../../baselines/v4-opening.json"), "utf8"),
	) as {
		schema: string;
		commit: string;
		checks: { file: string; boundary: string; beforeDigest: string }[];
	};
	if (baseline.schema !== "story/opening-baseline@1" || baseline.commit !== v4)
		throw new Error("Invalid V4 opening baseline");
	const definitions = [
		{
			file: "story/packages/pi-story/src/tools.ts",
			boundary: "export function registerReadTools(",
			scope: "submit_constraints / submit_bible / submit_outline 参数 schema、适配映射及相关辅助定义",
		},
		{
			file: "story/packages/pi-story/rules/story-showrunner/SKILL.md",
			boundary: "After opening succeeds",
			scope: "主笔开书规则",
		},
	];
	const checks = definitions.map(({ file, boundary, scope }) => {
		const after = readFileSync(path.join(repository, file), "utf8").replace(/\r\n/gu, "\n");
		const before = baseline.checks.find((row) => row.file === file && row.boundary === boundary);
		if (!before || !/^[a-f0-9]{64}$/u.test(before.beforeDigest) || !after.includes(boundary))
			throw new Error("Opening comparison boundary missing");
		const beforeDigest = before.beforeDigest;
		const afterDigest = sha256(after.slice(0, after.indexOf(boundary)));
		return { file, scope, beforeDigest, afterDigest, identical: beforeDigest === afterDigest };
	});
	return { v4, checks, inheritOpen: checks.every((check) => check.identical) };
}
export function freezeV5() {
	if (existsSync(path.join(stageRoot, "V5.json"))) throw new Error("V5 is already frozen");
	const provenance = executionSource();
	const development = ["SCEN", "E2E", "BOOK"].map((suite) => {
		const batches = priorBatches(suite, "development", 1);
		if (batches.length !== 1 || !existsSync(path.join(batches[0], "summary.json")))
			throw new Error("Complete the single registered development round before V5 freeze");
		const summary = JSON.parse(readFileSync(path.join(batches[0], "summary.json"), "utf8"));
		if (suite === "BOOK" ? summary.outcomes.length !== 1 : summary.results.length !== (suite === "SCEN" ? 18 : 7))
			throw new Error("Development samples are missing; failed results must remain visible");
		return { suite, folder: batches[0], summarySha256: sha256(readFileSync(path.join(batches[0], "summary.json"))) };
	});
	const opening = openingComparison();
	const docs = path.join(repository, "docs/p3r2");
	mkdirSync(docs, { recursive: true });
	const report = [
		"# V4 → V5 开书冻结检查",
		"",
		`V4：${opening.v4}。V5产品提交：${provenance.source.commit}。`,
		"",
		...opening.checks.map(
			(row) =>
				`- ${row.scope}：${row.identical ? "逐字一致" : "存在差异"}。文件：${row.file}；V4摘要${row.beforeDigest}；V5摘要${row.afterDigest}。`,
		),
		"",
		opening.inheritOpen
			? "OPEN沿用V4：T05=12/12；T06精确率113/126、召回率145/159；T07=50/50。不派发第二次开书测量。"
			: "存在开书差异，必须运行P3R2-OPEN一次并独立判定后才能采用。",
		"",
		"比较范围覆盖完整开书工具定义（含schema与映射）及主笔规则中After opening succeeds之前的全部文本。后续章节输入中的writerLengthFactor不改变大纲目标或开书映射。",
		"",
	].join("\n");
	writeFileSync(path.join(docs, "open-freeze-check.md"), report, { flag: "wx" });
	const dataFreezeCommit = JSON.parse(
		readFileSync(path.resolve(import.meta.dirname, "../../baselines/p3r2-data.json"), "utf8"),
	).commit;
	writeRecord(path.join(stageRoot, "V5.json"), {
		schema: "story/p3-v5@1",
		commit: provenance.source.commit,
		frozenAt: new Date().toISOString(),
		product: provenance.product,
		dataFreezeCommit,
		development,
		opening,
	});
	console.log(JSON.stringify({ commit: provenance.source.commit, inheritOpen: opening.inheritOpen }));
}

export function assertDeterministicGates(freezeCommit: string, root = stageRoot) {
	for (const suite of ["REG", "UNIT", "GUARD", "FOLD", "CTX"]) {
		const directory = path.join(root, `P3R2-${suite}`);
		const manifests = existsSync(directory)
			? readdirSync(directory).flatMap((name) => {
					const file = path.join(directory, name, "run-manifest.json");
					return existsSync(file) ? [JSON.parse(readFileSync(file, "utf8"))] : [];
				})
			: [];
		const original = manifests.find((row) => row.status === "failed");
		const corrected = manifests.find((row) => row.status === "passed" && row.correctionOf === original?.runId);
		const correctedPair =
			manifests.length === 2 &&
			original &&
			typeof original.runId === "string" &&
			original.runId.length > 0 &&
			corrected &&
			original.repositoryCommit === freezeCommit &&
			corrected.repositoryCommit === freezeCommit;
		if (
			!correctedPair &&
			(manifests.length !== 1 || manifests[0].repositoryCommit !== freezeCommit || manifests[0].status !== "passed")
		)
			throw new Error(`V5 deterministic gate P3R2-${suite} must pass once before paid acceptance`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) freezeV5();
