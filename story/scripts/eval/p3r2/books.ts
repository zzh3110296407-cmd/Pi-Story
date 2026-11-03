import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openingPrompts, splitDataset } from "../p2/datasets.ts";
import type { UsageLedger } from "../p2/ledger.ts";
import { RunControl } from "../p2/run-control.ts";
import { balance, caseWorkspace } from "../p3/main.ts";
import { BOOK_LIMITS, bookBudgetPreflight, nextBook, PRIMARY_BOOKS, RESERVE_BOOKS } from "./book-policy.ts";
import { readBookInterruption, superviseBookCase } from "./book-process.ts";
import { assertDeterministicGates } from "./freeze.ts";
import { isoId, priorBatches, stageLedger } from "./main.ts";
import { assertNoRpcBootstrap, readPausedMacro } from "./pause.ts";
import { assertProductMatches, executionSource, paths, productSnapshot, stageRoot, writeRecord } from "./provenance.ts";

export function bookAllowance(ledger: UsageLedger, runIds: string[], current: string) {
	const priorUsd = runIds.filter((id) => id !== current).reduce((sum, id) => sum + ledger.snapshot(id).totalUsd, 0);
	const currentUsd = ledger.snapshot(current).totalUsd;
	const runLimitUsd = BOOK_LIMITS.perBookUsd - priorUsd;
	return { priorUsd, currentUsd, runLimitUsd, remainingUsd: runLimitUsd - currentUsd };
}
export function plannedTarget(rows: Record<string, unknown>[]): number | null {
	const plan = rows.find((row) => row.type === "outline_plan");
	if (!plan) return null;
	if (!Number.isSafeInteger(plan.target) || Number(plan.target) < 1 || Number(plan.target) > 10)
		throw new Error("Invalid recorded outline plan");
	return Number(plan.target);
}
function lifecycle(folder: string): Record<string, unknown>[] {
	const file = path.join(folder, "case-lifecycle.jsonl");
	return existsSync(file)
		? readFileSync(file, "utf8")
				.split(/\r?\n/u)
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
}
interface Outcome {
	id: number;
	target: number | null;
	classification: string;
	qualityIncluded: boolean;
	missing: boolean;
	attempts: { runId: string; folder: string; archive: string; classification: string; qualityIncluded: boolean }[];
}
export async function runBooks(development: boolean, resume?: string, resumePausedId?: number, retryBootstrap = false) {
	if (retryBootstrap && resumePausedId === undefined) throw new Error("Bootstrap retry needs the explicit paused case");
	if (
		resumePausedId !== undefined &&
		(development || !resume || !new Set<number>([...PRIMARY_BOOKS, ...RESERVE_BOOKS]).has(resumePausedId))
	)
		throw new Error("Paused continuation requires the existing formal BOOK batch");
	const provenance = executionSource(!development);
	if (!development) assertDeterministicGates(provenance.freeze?.commit ?? "");
	const phase = development ? "development" : "acceptance";
	const prior = priorBatches("BOOK", phase, 1);
	if (resume ? !prior.includes(path.resolve(resume)) : prior.length > 0)
		throw new Error("Fixed BOOK run already exists; continue it without repeating completed books");
	const data = splitDataset(
		paths.testRoot,
		"DS08-opening-prompts",
		development ? "v1" : "v2",
		development ? "development" : "acceptance",
		development ? "E12" : "E13",
	);
	const prompts = openingPrompts(data, false);
	const ids = development ? [Number(data.chapterSubset()[0])] : [...PRIMARY_BOOKS, ...RESERVE_BOOKS];
	if (development && ids[0] !== 1489)
		throw new Error("Development book differs from the preregistered first train prompt");
	if (ids.some((id) => !prompts.some((prompt) => Number(prompt.id) === id)))
		throw new Error("Frozen BOOK prompt missing");
	const runId = resume
		? path.basename(resume)
		: `${isoId()}-${provenance.source.commit.slice(0, 7)}-${development ? "dev" : "acceptance"}-r1`;
	const folder = resume ? path.resolve(resume) : path.join(stageRoot, "P3R2-BOOK", runId);
	mkdirSync(folder, { recursive: true });
	if (resume) {
		const registered = JSON.parse(readFileSync(path.join(folder, "manifest.json"), "utf8"));
		assertProductMatches(registered.provenance.product, provenance.product);
		if (registered.dataset.manifestDigest !== data.manifestDigest) throw new Error("Continuation dataset differs");
		if (existsSync(path.join(folder, "summary.json")))
			return JSON.parse(readFileSync(path.join(folder, "summary.json"), "utf8"));
	} else
		writeRecord(path.join(folder, "manifest.json"), {
			schema: "story/p3r2-run@1",
			suiteId: "P3R2-BOOK",
			runId,
			phase,
			repetition: 1,
			scoringVersion: "p3r2-32@1",
			provenance,
			dataset: { id: "DS08", version: development ? "v1" : "v2", manifestDigest: data.manifestDigest },
			primary: development ? ids : PRIMARY_BOOKS,
			reserves: development ? [] : RESERVE_BOOKS,
			limits: BOOK_LIMITS,
			developmentExactGoal: development ? 4 : null,
		});
	const ledger = stageLedger();
	const control = new RunControl();
	const plans: { id: number; target: number | null }[] = [];
	const outcomes: Outcome[] = [];
	let stopped: string | null = null;
	for (const id of ids) {
		if (!development && nextBook(plans).id !== id) {
			if (nextBook(plans).capacityUnknown) stopped = "outline_capacity_unknown";
			break;
		}
		control.assertActive();
		assertProductMatches(provenance.product, productSnapshot());
		const outcomeFile = path.join(folder, `${id}-outcome.json`);
		if (existsSync(outcomeFile)) {
			const outcome = JSON.parse(readFileSync(outcomeFile, "utf8")) as Outcome;
			outcomes.push(outcome);
			if (development && outcome.target === null) {
				stopped = "outline_capacity_unknown";
				break;
			}
			plans.push({ id, target: outcome.target });
			continue;
		}
		// Before all outlines exist, use ten chapters per unopened primary book
		// (and the remaining capacity floor), rather than inventing smaller plans.
		const remaining = development
			? 4
			: Math.max(
					(PRIMARY_BOOKS.length - plans.length) * 10,
					plans.some((plan) => plan.target === null)
						? 0
						: BOOK_LIMITS.capacity - plans.reduce((sum, plan) => sum + (plan.target ?? 0), 0),
					1,
				);
		const preflight = bookBudgetPreflight(ledger.snapshot().totalUsd, remaining);
		writeRecord(path.join(folder, `${id}-preflight-${isoId()}.json`), {
			...preflight,
			conservativeUnopenedOutlineEstimate: true,
		});
		if (!preflight.allowed) {
			stopped = "budget_preflight_requires_author";
			break;
		}
		const attempts: Outcome["attempts"] = [];
		let target: number | null = null;
		let classification = "unmeasured";
		let qualityIncluded = true;
		for (let restart = 0; restart <= 1; restart++) {
			const caseId = `${id}${restart ? "-restart-1" : ""}`;
			const caseRunId = `${runId}-${caseId}`;
			const caseFolder = path.join(folder, caseId);
			const archive = path.join(caseFolder, "book");
			let executionFolder = caseFolder;
			const firstContinuationFile = path.join(folder, `${id}-continuation.json`);
			const retryContinuationFile = path.join(folder, `${id}-continuation-bootstrap-retry.json`);
			let continuationFile = existsSync(retryContinuationFile) ? retryContinuationFile : firstContinuationFile;
			let paused: ReturnType<typeof readPausedMacro> | undefined;
			if (
				restart === 0 &&
				retryBootstrap &&
				resumePausedId === id &&
				existsSync(firstContinuationFile) &&
				!existsSync(retryContinuationFile)
			) {
				const first = JSON.parse(readFileSync(firstContinuationFile, "utf8"));
				assertNoRpcBootstrap(first.executionFolder);
				if (JSON.stringify(first.feeBefore) !== JSON.stringify(ledger.snapshot(caseRunId)))
					throw new Error("Paused BOOK fees changed after bootstrap");
				paused = readPausedMacro(first.proofFile, archive);
				executionFolder = path.join(caseFolder, `resume-${isoId()}`);
				continuationFile = retryContinuationFile;
			} else if (restart === 0 && existsSync(continuationFile)) {
				executionFolder = JSON.parse(readFileSync(continuationFile, "utf8")).executionFolder;
			} else if (restart === 0 && resumePausedId === id) {
				const prior = readBookInterruption(caseFolder, 0);
				if (!prior.facts.cancelled || prior.facts.parentAlive !== false || prior.facts.rpcAlive !== false)
					throw new Error("Paused process ownership is unresolved");
				paused = readPausedMacro(path.join(caseFolder, "pause-recovery-proof.json"), archive);
				if (paused.proof.runId !== caseRunId) throw new Error("Paused BOOK run identity differs");
				executionFolder = path.join(caseFolder, `resume-${isoId()}`);
			}
			const runIds = [...attempts.map((attempt) => attempt.runId), caseRunId];
			const allowance = bookAllowance(ledger, runIds, caseRunId);
			if (!existsSync(caseFolder) || paused) {
				if (allowance.remainingUsd <= 0) {
					stopped = "per_book_allowance_exhausted";
					break;
				}
				writeRecord(path.join(folder, `${caseId}-balance-${isoId()}.json`), await balance(control));
				if (paused)
					writeRecord(continuationFile, {
						schema: "story/p3r2-book-continuation@1",
						executionFolder,
						originalFolder: caseFolder,
						runId: caseRunId,
						proofFile: path.join(caseFolder, "pause-recovery-proof.json"),
						feeBefore: ledger.snapshot(caseRunId),
						completedOutputsReused: paused.completed.length,
						newBookOrGoal: false,
					});
				await superviseBookCase({
					schema: "story/p3r2-book-case@1",
					folder: executionFolder,
					prompt: prompts.find((prompt) => Number(prompt.id) === id)?.prompt ?? "",
					maximumTarget: development ? 4 : 10,
					...(development ? { exactTarget: 4 } : {}),
					settleTimeoutMs: 120 * 60_000,
					...(paused ? { resumeTarget: paused.proof.target } : {}),
					worker: {
						schema: "story/p3-rpc-worker@2",
						work: caseWorkspace(caseRunId, caseId),
						archive,
						runId: caseRunId,
						caseId,
						main: "real",
						writerLengthFactor: provenance.product.configuration.writerLengthFactor,
						runLimitUsd: allowance.runLimitUsd,
						ledgerFile: ledger.ledgerFile,
						reservationsFile: ledger.reservationsFile,
						...(paused ? { pauseProofFile: path.join(caseFolder, "pause-recovery-proof.json") } : {}),
					},
				});
			}
			const decision = readBookInterruption(executionFolder, restart);
			classification = decision.classification;
			qualityIncluded = decision.qualityIncluded;
			target = plannedTarget(lifecycle(executionFolder));
			attempts.push({ runId: caseRunId, folder: executionFolder, archive, classification, qualityIncluded });
			const exitFile = path.join(executionFolder, "case-exit.json");
			if (existsSync(exitFile)) {
				const exit = JSON.parse(readFileSync(exitFile, "utf8"));
				if (exit.fatal?.httpStatus) control.reject(exit.fatal.httpStatus);
			}
			const liveEvidence = path.join(caseWorkspace(caseRunId, caseId), "evidence.jsonl");
			if (existsSync(liveEvidence)) {
				for (const line of readFileSync(liveEvidence, "utf8").split(/\r?\n/u).filter(Boolean)) {
					const row = JSON.parse(line);
					if (row.type === "fatal_provider_error") control.reject(Number(row.httpStatus));
				}
			}
			control.assertActive();
			if (classification === "running" || classification === "insufficient_process_evidence")
				throw new Error("Book evidence is incomplete; no further paid dispatch until its process state is resolved");
			if (!decision.restart) break;
			writeRecord(path.join(folder, `${id}-external-restart-${isoId()}.json`), {
				...decision,
				originalFees: ledger.snapshot(caseRunId),
				allowance,
			});
		}
		const outcome: Outcome = {
			id,
			target,
			classification,
			qualityIncluded,
			missing: classification === "external_interruption" || attempts.length === 0,
			attempts,
		};
		writeRecord(outcomeFile, outcome);
		outcomes.push(outcome);
		console.log(JSON.stringify({ id, target, classification, fee: ledger.snapshot() }));
		assertProductMatches(provenance.product, productSnapshot());
		if (stopped || (development && target === null)) {
			stopped ??= "outline_capacity_unknown";
			break;
		}
		plans.push({ id, target });
	}
	const summary = {
		schema: "story/p3r2-book-batch@1",
		scoringVersion: "p3r2-32@1",
		runId,
		phase,
		outcomes,
		plans,
		plannedChapters: plans.every((plan) => plan.target !== null)
			? plans.reduce((sum, plan) => sum + (plan.target ?? 0), 0)
			: null,
		capacity: development ? null : nextBook(plans),
		stopped,
		fee: ledger.snapshot(),
	};
	writeRecord(path.join(folder, "summary.json"), summary);
	console.log(JSON.stringify({ folder, stopped, plannedChapters: summary.plannedChapters, fee: summary.fee }));
	return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	const resume = args.includes("--continue") ? args[args.indexOf("--continue") + 1] : undefined;
	const pausedId = args.includes("--resume-paused") ? Number(args[args.indexOf("--resume-paused") + 1]) : undefined;
	await runBooks(args.includes("--dev"), resume, pausedId, args.includes("--retry-resume-bootstrap"));
}
