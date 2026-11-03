import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { foldBranch } from "../../../packages/core/src/fold/index.ts";
import { translateBranch } from "../../../packages/pi-story/src/entries.ts";
import { sha256 } from "../p2/artifacts.ts";
import { RunControl } from "../p2/run-control.ts";
import { balance } from "../p3/main.ts";
import type { BookCaseConfig } from "./book-case.ts";
import { bookBudgetPreflight } from "./book-policy.ts";
import { readBookInterruption, superviseBookCase } from "./book-process.ts";
import { assertBookBatchOpen } from "./closure.ts";
import { assertDeterministicGates } from "./freeze.ts";
import { isoId, stageLedger } from "./main.ts";
import { readPausedMacro } from "./pause.ts";
import { assertProductMatches, executionSource, stageRoot, writeRecord } from "./provenance.ts";

export async function completeAuthorizedBook(batch: string, id: number) {
	assertBookBatchOpen(path.resolve(batch));
	if (!Number.isSafeInteger(id) || id < 1 || path.dirname(path.resolve(batch)) !== path.join(stageRoot, "P3R2-BOOK"))
		throw new Error("Existing formal BOOK batch required");
	const provenance = executionSource(true);
	if (!provenance.freeze) throw new Error("V5 freeze required");
	assertDeterministicGates(provenance.freeze.commit);
	const manifest = JSON.parse(readFileSync(path.join(batch, "manifest.json"), "utf8"));
	if (manifest.phase !== "acceptance") throw new Error("Technical completion requires a formal batch");
	assertProductMatches(manifest.provenance.product, provenance.product);
	if (!existsSync(path.join(batch, "summary.json")))
		throw new Error("Original paid batch is still active; completion must be serial");
	const folder = path.join(batch, "technical-completion", String(id));
	const authorization = JSON.parse(readFileSync(path.join(folder, "authorization.json"), "utf8")) as {
		authorApproved: boolean;
		bookId: number;
		completedBefore: number;
		target: number;
		originalRunId: string;
		completedTextDigests: { chapter: number; sha256: string }[];
	};
	if (!authorization.authorApproved || authorization.bookId !== id)
		throw new Error("Author technical-completion approval required");
	if (existsSync(path.join(folder, "execution.json")))
		throw new Error("Authorized completion already launched; retain its result rather than repeat it");
	const original = JSON.parse(readFileSync(path.join(batch, String(id), "case-config.json"), "utf8")) as BookCaseConfig;
	if (original.worker.runId !== authorization.originalRunId || original.worker.main !== "real")
		throw new Error("Original real BOOK identity differs");
	const proofFile = path.join(folder, "pause-proof-v2.json");
	const paused = readPausedMacro(proofFile, original.worker.archive);
	const model = foldBranch(translateBranch(paused.entries));
	if (
		model.lastChapter !== authorization.completedBefore ||
		model.policy.targetChapter !== authorization.target ||
		paused.proof.runId !== original.worker.runId
	)
		throw new Error("Authorized native progress or goal changed");
	const verifyCompleted = () => {
		const current = foldBranch(translateBranch(SessionManager.open(paused.proof.sessionFile).getBranch()));
		for (const saved of authorization.completedTextDigests) {
			const commit = current.commits.find((row) => row.chapter === saved.chapter);
			if (!commit || sha256(commit.text) !== saved.sha256) throw new Error("Previously completed chapter changed");
		}
	};
	verifyCompleted();
	const ledger = stageLedger();
	const preflight = bookBudgetPreflight(ledger.snapshot().totalUsd, authorization.target - model.lastChapter);
	writeRecord(path.join(folder, `preflight-${isoId()}.json`), preflight);
	if (!preflight.allowed || ledger.snapshot(original.worker.runId).totalUsd >= 2)
		throw new Error("Existing budget prevents technical completion");
	const control = new RunControl();
	writeRecord(path.join(folder, `balance-${isoId()}.json`), await balance(control));
	const executionFolder = path.join(folder, `run-${isoId()}`);
	writeRecord(path.join(folder, "execution.json"), {
		schema: "story/p3r2-authorized-book-completion@1",
		provenance,
		executionFolder,
		originalOutcomeFile: path.join(batch, `${id}-outcome.json`),
		authorizationFile: path.join(folder, "authorization.json"),
		proofFile,
		runId: original.worker.runId,
		feeBefore: ledger.snapshot(original.worker.runId),
		completedOutputsReused: paused.completed.length,
		newBookOrGoal: false,
	});
	await superviseBookCase({
		...original,
		folder: executionFolder,
		resumeTarget: authorization.target,
		settleTimeoutMs: 120 * 60_000,
		worker: { ...original.worker, pauseProofFile: proofFile, runLimitUsd: 2 },
	});
	verifyCompleted();
	const decision = readBookInterruption(executionFolder, 0);
	const outcome = {
		id,
		target: authorization.target,
		classification: decision.classification,
		qualityIncluded: true,
		missing: !existsSync(path.join(original.worker.archive, "result.json")),
		attempts: [
			{
				runId: original.worker.runId,
				folder: executionFolder,
				archive: original.worker.archive,
				classification: decision.classification,
				qualityIncluded: true,
			},
		],
		technicalCompletion: true,
		originalMeasurementOutcomePreserved: path.join(batch, `${id}-outcome.json`),
	};
	mkdirSync(folder, { recursive: true });
	writeRecord(path.join(folder, "outcome.json"), outcome);
	console.log(
		JSON.stringify({ folder, outcome, fees: ledger.snapshot(), bookFees: ledger.snapshot(original.worker.runId) }),
	);
	return outcome;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
	await completeAuthorizedBook(path.resolve(process.argv[2] ?? ""), Number(process.argv[3]));
