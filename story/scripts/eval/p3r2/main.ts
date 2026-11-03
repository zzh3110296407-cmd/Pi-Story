import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sha256 } from "../p2/artifacts.ts";
import { UsageLedger } from "../p2/ledger.ts";
import { RunControl } from "../p2/run-control.ts";
import { balance, caseWorkspace } from "../p3/main.ts";
import { runScenario } from "../p3/scenario.ts";
import { loadV5Scenarios } from "./datasets.ts";
import { assertDeterministicGates } from "./freeze.ts";
import {
	assertProductMatches,
	DATA_FREEZE,
	executionSource,
	paths,
	productSnapshot,
	stageRoot,
	writeRecord,
} from "./provenance.ts";

export const isoId = () =>
	new Date()
		.toISOString()
		.replace(/[-:]/gu, "")
		.replace(/\.\d{3}/u, "");
export function stageLedger() {
	return new UsageLedger(path.join(stageRoot, "usage-ledger.jsonl"), path.join(stageRoot, "reservation-ledger.jsonl"), {
		stopUsd: 6.5,
		maximumUsd: 7.5,
	});
}
export function priorBatches(suite: string, phase: string, repetition: number, runs = stageRoot): string[] {
	const root = path.join(runs, `P3R2-${suite}`);
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.flatMap((entry) => {
			const folder = path.join(root, entry.name);
			const file = path.join(folder, "manifest.json");
			if (!existsSync(file)) return [];
			const row = JSON.parse(readFileSync(file, "utf8")) as { phase: string; repetition: number };
			return row.phase === phase && row.repetition === repetition ? [folder] : [];
		});
}

export async function runScenarios(suite: "SCEN" | "E2E", development: boolean, repetition: number, resume?: string) {
	if (((development || suite === "E2E") && repetition !== 1) || ![1, 2].includes(repetition))
		throw new Error("Repetition differs from plan 30/32");
	const provenance = executionSource(!development);
	if (!development) assertDeterministicGates(provenance.freeze?.commit ?? "");
	const writerLengthFactor = provenance.product.configuration.writerLengthFactor;
	const phase = development ? "development" : "acceptance";
	const prior = priorBatches(suite, phase, repetition);
	if (resume ? !prior.includes(path.resolve(resume)) : prior.length > 0)
		throw new Error("Fixed run already exists; continue it without repeating completed cases");
	const version = path.join(
		paths.testRoot,
		"datasets",
		suite === "SCEN" ? "DS11-showrunner-scenarios/v3" : "DS14-author-control-e2e/v2",
	);
	const scenarios = loadV5Scenarios(version, development ? "dev" : "acceptance", provenance.freeze);
	const indexDigest = sha256(
		readFileSync(path.join(version, development ? "dev/index.json" : "acceptance/index.json")),
	);
	if (scenarios.length !== (development ? (suite === "SCEN" ? 18 : 7) : suite === "SCEN" ? 32 : 15))
		throw new Error("Fixed scenario selection differs from the plan");
	if (scenarios.some((scenario) => !/^[a-z0-9_-]+$/u.test(scenario.id))) throw new Error("Unsafe scenario ID");
	const runId = resume
		? path.basename(resume)
		: `${isoId()}-${provenance.source.commit.slice(0, 7)}-${development ? "dev" : "acceptance"}-r${repetition}`;
	const folder = resume ? path.resolve(resume) : path.join(stageRoot, `P3R2-${suite}`, runId);
	mkdirSync(folder, { recursive: true });
	if (resume) {
		const registered = JSON.parse(readFileSync(path.join(folder, "manifest.json"), "utf8")) as {
			provenance: { product: { sha256: string } };
			dataset: { indexDigest: string };
		};
		assertProductMatches(registered.provenance.product, provenance.product);
		if (registered.dataset.indexDigest !== indexDigest)
			throw new Error("Continuation dataset differs from the registered run");
	}
	if (resume && existsSync(path.join(folder, "summary.json")))
		return JSON.parse(readFileSync(path.join(folder, "summary.json"), "utf8")) as { runId: string; complete: boolean };
	if (!resume)
		writeRecord(path.join(folder, "manifest.json"), {
			schema: "story/p3r2-run@1",
			suiteId: `P3R2-${suite}`,
			runId,
			phase,
			repetition,
			scoringVersion: "p3r2-32@1",
			provenance,
			dataset: { version, dataFreezeCommit: DATA_FREEZE, indexDigest },
			writerLengthFactor,
			expected: scenarios.map(({ id, category, mode }) => ({ id, category, mode })),
		});
	const ledger = stageLedger();
	const control = new RunControl();
	const results: Awaited<ReturnType<typeof runScenario>>[] = [];
	for (const scenario of scenarios) {
		control.assertActive();
		assertProductMatches(provenance.product, productSnapshot());
		const archive = path.join(folder, scenario.id);
		const file = path.join(archive, "result.json");
		if (resume && existsSync(file)) {
			results.push(JSON.parse(readFileSync(file, "utf8")));
			console.log(`${scenario.id}: retained existing result`);
			continue;
		}
		if (existsSync(archive)) throw new Error("Partial case evidence retained; do not repeat its paid request");
		if (scenario.mode === "real" || scenario.execution.internalRoles === "real")
			writeRecord(path.join(folder, `${scenario.id}-balance-${isoId()}.json`), await balance(control));
		const result = await runScenario(scenario, {
			stage: "P3R2",
			writerLengthFactor,
			work: caseWorkspace(runId, scenario.id),
			archive,
			suiteId: `P3R2-${suite}`,
			runId: `${runId}-${scenario.id}`,
			caseId: scenario.id,
			ledger,
			control,
			runLimitUsd: 1,
		});
		writeRecord(file, { ...result, scoringVersion: "p3r2-32@1" });
		results.push(result);
		assertProductMatches(provenance.product, productSnapshot());
		console.log(
			JSON.stringify({
				id: scenario.id,
				status: result.status,
				firstAcceptable: result.firstAcceptable,
				reads: result.readOnlyCalls ?? null,
				checks: result.programChecks.map((check) => check.status),
				fee: ledger.snapshot(),
			}),
		);
		control.assertActive();
		if (result.status === "incomplete" && scenario.category !== "E01" && result.archive.measuredMainRequests === 0)
			throw new Error("Measurement did not begin; remaining cases stopped without dispatch");
	}
	const summary = {
		schema: "story/p3r2-batch-result@1",
		scoringVersion: "p3r2-32@1",
		runId,
		phase,
		repetition,
		complete: results.length === scenarios.length && results.every((row) => row.status === "measured"),
		expected: scenarios.length,
		results,
		fee: ledger.snapshot(),
	};
	writeRecord(path.join(folder, "summary.json"), summary);
	console.log(JSON.stringify({ folder, complete: summary.complete, expected: summary.expected, fee: summary.fee }));
	return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	if (!["SCEN", "E2E"].includes(args[0] ?? "")) throw new Error("Select SCEN|E2E with --dev or a V5 freeze");
	const repetition = Number(args[args.indexOf("--repetition") + 1] ?? 1);
	const resume = args.includes("--continue") ? args[args.indexOf("--continue") + 1] : undefined;
	await runScenarios(
		args[0] as "SCEN" | "E2E",
		args.includes("--dev"),
		args.includes("--repetition") ? repetition : 1,
		resume,
	);
}
