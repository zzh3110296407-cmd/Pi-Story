import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { EvidenceArchive, readEvidence } from "../../../scripts/eval/p2/artifacts.ts";
import { createDriver } from "../../../scripts/eval/p2/driver.ts";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { executionObservations } from "../../../scripts/eval/p2/observations.ts";
import { runEditTask, runKeeperTask } from "../../../scripts/eval/p2/roles.ts";
import { type HumanScore, scoreEvidence } from "../../../scripts/eval/p2/score.ts";
import { createDraft } from "../../core/src/production/index.ts";
import { context } from "../../core/test/context.ts";
import { draftText, keeperReply, openingCalls } from "./fixture.ts";

async function roleFixture(suiteId: "P2-KEEP" | "P2-EDIT") {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("P2 workspace required");
	mkdirSync(path.join(work, "temp"), { recursive: true });
	const root = mkdtempSync(path.join(work, "temp/role-driver-"));
	const archive = new EvidenceArchive(path.join(root, "run"), path.join(root, "archive"), {
		suiteId,
		runId: "faux-role",
		expectedCaseIds: ["one"],
	});
	const ledger = new UsageLedger(path.join(root, "usage.jsonl"), path.join(root, "reservations.jsonl"));
	const faux = fauxProvider({ models: [{ id: "script", contextWindow: 1_000_000, maxTokens: 32768 }] });
	const driver = await createDriver({
		work: path.join(root, "pi"),
		suiteId,
		runId: "faux-role",
		caseId: "one",
		archive,
		ledger,
		runLimitUsd: 1,
		phase: "faux",
		model: "faux/script",
		configureRuntime: (runtime) => runtime.registerNativeProvider(faux.provider),
	});
	faux.setResponses([fauxAssistantMessage(openingCalls(), { stopReason: "toolUse" }), fauxAssistantMessage("Opened.")]);
	await driver.session.prompt("Ada must survive.");
	return { driver, archive, faux, root };
}

test("keeper measurement records shared validation outputs without creating product canon", async () => {
	const fixture = await roleFixture("P2-KEEP");
	try {
		fixture.faux.setResponses([fauxAssistantMessage(JSON.stringify(keeperReply))]);
		const result = await runKeeperTask(fixture.driver, fixture.archive, {
			id: "one",
			chapter: 1,
			text: draftText,
			entries: fixture.driver.state().source.branch(),
		});
		expect(result.ok).toBe(true);
		expect(fixture.driver.state().source.model().commits).toEqual([]);
	} finally {
		fixture.driver.close();
	}
	fixture.archive.finish();
	const score = scoreEvidence(readEvidence(path.join(fixture.root, "run")), []);
	expect(readEvidence(path.join(fixture.root, "run")).filter((row) => row.type === "role_checkpoint")).toMatchObject([
		{ caseId: "one", toolCallId: "direct", phase: "started", reservationId: "reservation-1" },
		{ caseId: "one", toolCallId: "direct", phase: "completed", reservationId: "reservation-1" },
	]);
	expect(score.metrics.find((item) => item.id === "H12")).toMatchObject({ n: 1, value: 1 });
	expect(score.metrics.find((item) => item.id === "K02")).toMatchObject({ value: { first: 1, final: 1 } });
});

test("measurement cancellation also stops a role called outside the SDK main turn", async () => {
	const fixture = await roleFixture("P2-KEEP");
	try {
		fixture.faux.setResponses([
			() => {
				fixture.driver.cancel();
				return fauxAssistantMessage(JSON.stringify(keeperReply));
			},
		]);
		const result = await runKeeperTask(fixture.driver, fixture.archive, {
			id: "one",
			chapter: 1,
			text: draftText,
			entries: fixture.driver.state().source.branch(),
		});
		expect(result).toMatchObject({ ok: false, error: { code: "TRANSPORT_FAILURE" } });
		expect(fixture.faux.state.callCount).toBe(3);
	} finally {
		fixture.driver.close();
	}
});

test("editor measurement uses review patch program recheck and editor recheck without a keeper", async () => {
	const fixture = await roleFixture("P2-EDIT");
	try {
		const entries = fixture.driver.state().source.branch();
		const draft = createDraft(context(entries), { chapter: 1, text: draftText });
		if (!draft.ok) throw new Error(draft.receipt);
		entries.push({
			kind: "toolResult",
			entryId: "evaluation-draft",
			toolName: "write_draft",
			isError: false,
			details: draft.details,
		});
		fixture.faux.setResponses([
			fauxAssistantMessage(
				JSON.stringify({
					observations: [
						{
							category: "factual_details",
							severity: "major",
							objective: true,
							lines: [1],
							scope: "local",
							impact: "Use the intended approach to the harbor.",
						},
					],
				}),
			),
			fauxAssistantMessage(JSON.stringify([{ find: "Ada reached the harbor", replace: "Ada approached the harbor" }])),
			fauxAssistantMessage(
				JSON.stringify({ observations: [], rechecks: [{ observationId: "c01-r01-o01", resolved: true }] }),
			),
		]);
		const result = await runEditTask(fixture.driver, fixture.archive, { id: "one", chapter: 1, entries });
		expect(result.patchApplied).toBe(true);
		expect(result.calls.map((call) => call.role)).toEqual(["editor", "writer", "editor"]);
		expect(fixture.driver.state().source.model().commits).toEqual([]);
	} finally {
		fixture.driver.close();
	}
	fixture.archive.finish();
	const score = scoreEvidence(readEvidence(path.join(fixture.root, "run")), []);
	expect(score.metrics.find((item) => item.id === "H12")).toMatchObject({ n: 3, value: 1 });
	expect(score.metrics.find((item) => item.id === "W05")).toMatchObject({ n: 1, value: 1 });
	expect(executionObservations(readEvidence(path.join(fixture.root, "run"))).patchEffects[0]).toMatchObject({
		resolved: 1,
		newlyReportedObjective: 0,
		programProxyNet: 1,
		actualNet: null,
		status: "pending_human",
	});
	const records = readEvidence(path.join(fixture.root, "run"));
	expect(records.filter((row) => row.type === "role_checkpoint")).toHaveLength(6);
	const automatic = score.observations.execution;
	if (!automatic) throw new Error("Missing role execution observations");
	const reviewId = automatic.patchEffects[0].reviewId;
	const human: HumanScore[] = [
		{ metric: "P2-O6", component: "fixed", sampleId: `one:${reviewId}:original`, pass: true },
		{ metric: "P2-O6", component: "introduced", sampleId: `one:${reviewId}:none`, pass: false },
		{ metric: "P2-O7", component: "relevant", sampleId: "one:writer:L-1", pass: true },
		{ metric: "P2-O7", component: "relevant", sampleId: "one:writer:L-2", pass: false },
	].map((row) => ({ ...row, runId: "faux-role", status: "author_approved" }));
	const humanExecution = (rows: HumanScore[]) => {
		const result = scoreEvidence(records, rows).observations.execution;
		if (!result) throw new Error("Missing judged execution observations");
		return result;
	};
	const judged = humanExecution(human);
	expect(judged.patchEffects[0]).toMatchObject({ actualNet: 1, status: "author_measured" });
	expect(judged.relatedItemPrecision).toMatchObject({ n: 2, value: 0.5, status: "author_measured" });
	const preliminary = humanExecution(human.map((row) => ({ ...row, status: "ai_preliminary" })));
	expect(preliminary.patchEffects[0].actualNet).toBeNull();
	expect(preliminary.relatedItemPrecision.value).toBeNull();
	const partial = humanExecution(human.filter((row) => row.component !== "introduced"));
	expect(partial.patchEffects[0].actualNet).toBeNull();
});
