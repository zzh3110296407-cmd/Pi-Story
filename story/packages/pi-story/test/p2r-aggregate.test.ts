import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { EvidenceArchive } from "../../../scripts/eval/p2/artifacts.ts";
import { aggregateScores, allRealScores } from "../../../scripts/eval/p2/rescore.ts";
import { CallSession } from "../../core/src/flow/calls.ts";
import { context } from "../../core/test/context.ts";

const freeze = "a".repeat(40);
function workspace() {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("P2 workspace required");
	return mkdtempSync(path.join(work, "temp/p2r-aggregate-"));
}
async function archivedCall(
	root: string,
	runId: string,
	commit: string,
	cancelled = false,
	missingStart = false,
	stage: "P2R" | "P2R3" = "P2R",
) {
	const folder = path.join(root, "P2-KEEP", runId);
	const archive = new EvidenceArchive(folder, path.join(root, "work", runId), {
		suiteId: "P2-KEEP",
		runId,
		expectedCaseIds: ["one"],
		stage,
	});
	archive.emit({ type: "configuration", repositoryCommit: commit, dirty: false });
	const ctx = context();
	ctx.ports.callJournal = {
		started: (reservationId, request, reservedCostUsd) => {
			if (!missingStart)
				archive.emit({
					type: "role_checkpoint",
					phase: "started",
					caseId: "one",
					reservationId,
					request,
					reservedCostUsd,
				});
		},
		completed: (reservationId, record) =>
			archive.emit({ type: "role_checkpoint", phase: "completed", caseId: "one", reservationId, record }),
	};
	ctx.ports.models.call = async (request) => {
		archive.emit({
			type: "request",
			caseId: "one",
			requestId: runId,
			role: request.role,
			model: request.model,
			inputDigest: request.inputSources?.inputDigest,
			contextWindow: 1_000_000,
		});
		archive.emit({ type: "dispatch", requestId: runId, caseId: "one" });
		archive.emit({
			type: "response",
			requestId: runId,
			caseId: "one",
			classification: cancelled ? "cancelled" : "reported",
			networkAttempts: 1,
		});
		return {
			text: "{}",
			usage: cancelled
				? null
				: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
			stopReason: cancelled ? "aborted" : "stop",
			durationMs: 1,
		};
	};
	await new CallSession(ctx).call("keeper", "Extract", "{}", { kind: "text" });
	archive.finish();
	writeFileSync(
		path.join(folder, "run-manifest.json"),
		JSON.stringify({
			stage,
			suiteId: "P2-KEEP",
			runId,
			repositoryCommit: commit,
			dirty: false,
			status: cancelled ? "failed" : "measured_pending_gates",
		}),
	);
	const ledgerFile = path.join(root, "request-reservations.jsonl");
	const previous = existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8") : "";
	writeFileSync(ledgerFile, `${previous}${JSON.stringify({ requestId: runId, runId, role: "keeper" })}\n`);
	return folder;
}

test("24 all-real gates include a cancelled call at the freeze and exclude older development", async () => {
	const root = workspace();
	await archivedCall(root, "old-development", "b".repeat(40), false, true);
	await archivedCall(root, "frozen-success", freeze);
	await archivedCall(root, "frozen-cancelled", freeze, true);
	const result = allRealScores(root, freeze);
	expect(result.runs.map((run) => run.runId).sort()).toEqual(["frozen-cancelled", "frozen-success"]);
	for (const id of ["H12", "C04"])
		expect(result.metrics.find((m) => m.id === id)).toMatchObject({ n: 2, value: 1, passed: true });
	expect(result.metrics.find((m) => m.id === "H09")).toMatchObject({
		n: 1,
		unknownCalls: 1,
		unclassified: 0,
		passed: true,
	});
});

test("26 all-real accepts only the selected third-round stage and retains classified cancellation", async () => {
	const root = workspace();
	await archivedCall(root, "third-success", freeze, false, false, "P2R3");
	await archivedCall(root, "third-cancelled", freeze, true, false, "P2R3");
	const result = allRealScores(root, freeze, "P2R3");
	expect(result.metrics.find((metric) => metric.id === "H12")).toMatchObject({ n: 2, value: 1, passed: true });
	expect(result.metrics.find((metric) => metric.id === "H09")).toMatchObject({
		n: 1,
		unknownCalls: 1,
		unclassified: 0,
		passed: true,
	});
	expect(() => allRealScores(root, freeze)).toThrow(/stage/u);
});

test("24 all-real gates retain a failed dispatch missing its started input", async () => {
	const root = workspace();
	await archivedCall(root, "failed", freeze, true, true);
	const result = allRealScores(root, freeze);
	expect(result.metrics.find((m) => m.id === "H12")).toMatchObject({ n: 1, passed: false });
	expect(result.metrics.find((m) => m.id === "C02")).toMatchObject({ n: 1, passed: false });
});

test("24 all-real refuses a reservation whose run provenance is unavailable or dirty", async () => {
	const root = workspace();
	writeFileSync(
		path.join(root, "request-reservations.jsonl"),
		`${JSON.stringify({ runId: "lost", role: "keeper" })}\n`,
	);
	expect(() => allRealScores(root, freeze)).toThrow(/archived|provenance/u);
	const folder = await archivedCall(root, "lost", freeze);
	const file = path.join(folder, "run-manifest.json");
	const manifest = JSON.parse(readFileSync(file, "utf8"));
	writeFileSync(file, JSON.stringify({ ...manifest, dirty: true }));
	expect(() => allRealScores(root, freeze)).toThrow(/dirty|frozen/u);
});

test("24 repetition aggregation permits classified unknown usage and fails unclassified usage", () => {
	const metric = {
		id: "H09",
		n: 1,
		value: 0,
		threshold: 0,
		confidence95: null,
		passed: true,
		status: "measured",
		unknownCalls: 1,
		unclassified: 0,
	};
	const runs = [1, 2].map((repetition) => ({ runId: String(repetition), repetition, metrics: [metric] }));
	expect(aggregateScores(runs, "p2r-24@1").metrics[0]).toMatchObject({
		unknownCalls: 2,
		unclassified: 0,
		passed: true,
	});
	runs[0].metrics = [{ ...metric, unclassified: 1, passed: false }];
	expect(aggregateScores(runs, "p2r-24@1").metrics[0]).toMatchObject({ passed: false });
	expect(aggregateScores(runs).metrics[0]).toMatchObject({ passed: null });
});

test("24 all-real cannot hide an archived dispatch by omitting its fee reservation", async () => {
	const root = workspace();
	await archivedCall(root, "orphan", freeze);
	writeFileSync(path.join(root, "request-reservations.jsonl"), "");
	expect(() => allRealScores(root, freeze)).toThrow(/matching reservation/u);
});

test("24 all-classified cancellations need no fictitious billed H09 comparisons", () => {
	const metric = {
		id: "H09",
		n: 0,
		value: 0,
		threshold: 0,
		confidence95: null,
		passed: true,
		status: "no_billed_comparisons_all_classified",
		unknownCalls: 1,
		unclassified: 0,
	};
	const runs = [1, 2].map((repetition) => ({ runId: String(repetition), repetition, metrics: [metric] }));
	expect(aggregateScores(runs, "p2r-24@1").metrics[0]).toMatchObject({ n: 0, unknownCalls: 2, value: 0, passed: true });
});

test("24 K08 aggregation requires enough judged output operations independently of gold count", () => {
	const runs = [1, 2].map((repetition) => ({
		runId: String(repetition),
		repetition,
		metrics: [
			{
				id: "K08",
				n: 30,
				manual: true,
				value: { precision: 1, recall: 1 },
				threshold: { precision: 0.7, recall: 0.5 },
				minimum: 20,
				confidence95: null,
				passed: null,
				status: "insufficient_evidence",
				components: { precision: { n: 9, successes: 9 }, recall: { n: 30, successes: 30 } },
			},
		],
	}));
	expect(aggregateScores(runs, "p2r-24@1").metrics[0]).toMatchObject({ n: 60, passed: null });
	runs[0].metrics[0].components.precision = { n: 11, successes: 11 };
	expect(aggregateScores(runs, "p2r-24@1").metrics[0]).toMatchObject({ passed: true });
});
