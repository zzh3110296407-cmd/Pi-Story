import { expect, test } from "vitest";
import { splitDataset } from "../../../scripts/eval/p2/datasets.ts";
import type { EvidenceRecord } from "../../../scripts/eval/p2/metering.ts";
import { scoreEvidenceV2 } from "../../../scripts/eval/p2/score-v2.ts";
import { CallSession } from "../../core/src/flow/calls.ts";
import { context } from "../../core/test/context.ts";

async function evidence() {
	const records: EvidenceRecord[] = [
		{ type: "meta", suiteId: "P2-CHAP", runId: "offline", expectedCaseIds: ["one"], stage: "P2R" },
	];
	const ctx = context();
	ctx.ports.callJournal = {
		started: (reservationId, request, reservedCostUsd) =>
			records.push({
				type: "role_checkpoint",
				phase: "started",
				caseId: "one",
				reservationId,
				request,
				reservedCostUsd,
			}),
		completed: (reservationId, record) =>
			records.push({ type: "role_checkpoint", phase: "completed", caseId: "one", reservationId, record }),
	};
	ctx.ports.models.call = async (request) => {
		records.push({
			type: "request",
			caseId: "one",
			requestId: "one",
			role: request.role,
			model: request.model,
			inputDigest: request.inputSources?.inputDigest,
			contextWindow: 1_000_000,
		});
		records.push({ type: "dispatch", caseId: "one", requestId: "one" });
		const usage = {
			input: 10,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 13,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		records.push({ type: "response", caseId: "one", requestId: "one", classification: "reported", networkAttempts: 1 });
		return { text: "A boat reached the pier.", usage, stopReason: "stop", durationMs: 1 };
	};
	await new CallSession(ctx).call("writer", "Write", '{"task":"draft"}', { kind: "text" });
	return records;
}
const metric = (records: EvidenceRecord[], id: string) => scoreEvidenceV2(records, []).metrics.find((x) => x.id === id);

test("former acceptance reuse cannot open v2 data during development", () => {
	expect(() => splitDataset("not-opened", "DS08-opening-prompts", "v2", "development", "E12", true)).toThrow(
		/only for v1 development/u,
	);
});

test("24 uses pre-dispatch inputs and actual product records without requiring a final macro", async () => {
	const records = await evidence();
	for (const id of ["H12", "C04"]) expect(metric(records, id)).toMatchObject({ n: 1, value: 1, passed: true });
	for (const id of ["C02", "H09", "C05"]) expect(metric(records, id)).toMatchObject({ n: 1, value: 0, passed: true });
	const missing = records.filter((row) => row.phase !== "started");
	expect(metric(missing, "H12")).toMatchObject({ passed: false });
	expect(metric(missing, "C02")).toMatchObject({ passed: false, missingInputs: 1 });
});

test("interrupted dispatch requires an explicit conservative record; it does not invent a CallRecord", async () => {
	const records = (await evidence()).filter((row) => row.phase !== "completed" && row.type !== "response");
	expect(metric(records, "H12")).toMatchObject({ n: 1, passed: false });
	const start = records.find((row) => row.phase === "started");
	if (!start) throw new Error("missing start");
	records.push({ ...start, phase: "interrupted", classification: "interrupted", accounting: "reserved" });
	expect(metric(records, "H12")).toMatchObject({ n: 1, passed: true });
	expect(metric(records, "H09")).toMatchObject({ n: 0, unknownCalls: 1, unclassified: 0, passed: true });
	expect(metric(records, "C04")).toMatchObject({ n: 0, passed: null });
});

test("a terminal CallRecord without product provenance cannot satisfy C04", async () => {
	const records = await evidence();
	const row = records.find((row) => row.phase === "completed");
	if (!row || !row.record || typeof row.record !== "object") throw new Error("missing record");
	row.record = { ...row.record, inputSources: undefined };
	expect(metric(records, "C04")).toMatchObject({ n: 1, value: 0, passed: false });
});

test("K08 requires twenty judged output operations as well as twenty gold operations", () => {
	const records: EvidenceRecord[] = [
		{ type: "meta", suiteId: "P2-KEEP", runId: "hooks", expectedCaseIds: [], stage: "P2R" },
	];
	const judgments = Array.from({ length: 20 }, (_, i) => ({
		metric: "K08",
		component: "recall",
		sampleId: `gold-${i}`,
		runId: "hooks",
		pass: true,
		status: "author_approved" as const,
	}));
	expect(scoreEvidenceV2(records, judgments).metrics.find((x) => x.id === "K08")).toMatchObject({ passed: null });
	const outputs = Array.from({ length: 20 }, (_, i) => ({
		metric: "K08",
		component: "precision",
		sampleId: `additional-valid-output-${i}`,
		runId: "hooks",
		pass: true,
		status: "author_approved" as const,
	}));
	expect(scoreEvidenceV2(records, [...judgments, ...outputs]).metrics.find((x) => x.id === "K08")).toMatchObject({
		passed: true,
		value: { precision: 1, recall: 1 },
	});
});

test("T01 failure count includes successful visible repairs", () => {
	const records: EvidenceRecord[] = [
		{ type: "meta", suiteId: "P2-OPEN", runId: "repair", expectedCaseIds: [], stage: "P2R" },
		{
			type: "tool_result",
			message: {
				toolName: "submit_bible",
				toolCallId: "repaired",
				isError: false,
				details: { argumentsRepair: { strategy: "remove_one_trailing_brace" } },
			},
		},
	];
	expect(metric(records, "T01")).toMatchObject({ n: 1, successes: 0, failures: 1, value: 0 });
});
