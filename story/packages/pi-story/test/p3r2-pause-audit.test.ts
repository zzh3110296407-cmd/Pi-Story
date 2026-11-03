import { BudgetGuard } from "@pi-story/core";
import { expect, test } from "vitest";
import type { EvidenceRecord } from "../../../scripts/eval/p2/metering.ts";
import { scoreEvidenceV3 } from "../../../scripts/eval/p2/score-v3.ts";
import { CallSession } from "../../core/src/flow/calls.ts";
import { sumUsage } from "../../core/src/usage/index.ts";
import { context } from "../../core/test/context.ts";

async function recoveredEvidence() {
	const records: EvidenceRecord[] = [
		{ type: "meta", suiteId: "P2-CHAP", runId: "recovery-audit", expectedCaseIds: ["one"], stage: "P3R2" },
	];
	const ctx = context();
	ctx.ports.budget = new BudgetGuard(() => ({ calls: [], interruptions: [] }), ctx.ports.prices);
	let physical = 0;
	ctx.ports.callJournal = {
		started: (reservationId, request, reservedCostUsd) =>
			records.push({
				type: "role_checkpoint",
				phase: "started",
				caseId: "one",
				toolCallId: "macro",
				reservationId,
				request,
				reservedCostUsd,
			}),
		completed: (reservationId, record) =>
			records.push({
				type: "role_checkpoint",
				phase: "completed",
				caseId: "one",
				toolCallId: "macro",
				reservationId,
				record,
			}),
	};
	ctx.ports.models.call = async (request) => {
		const requestId = `physical-${++physical}`;
		records.push(
			{
				type: "request",
				caseId: "one",
				requestId,
				role: request.role,
				model: request.model,
				inputDigest: request.inputSources?.inputDigest,
				contextWindow: 1_000_000,
			},
			{ type: "dispatch", caseId: "one", requestId },
		);
		records.push({ type: "response", caseId: "one", requestId, classification: "reported", networkAttempts: 1 });
		return {
			text: "An intact boat.",
			usage: {
				input: 1,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 4,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			durationMs: 1,
		};
	};
	const calls = new CallSession(ctx);
	for (const role of ["writer", "editor", "keeper", "keeper"] as const)
		await calls.call(role, "Write", '{"task":"draft"}', { kind: "text" });
	const pendingId = calls.calls[2].id;
	const kept = records.filter(
		(row) =>
			!(row.type === "role_checkpoint" && row.phase === "completed" && row.reservationId === pendingId) &&
			!(row.type === "response" && row.requestId === "physical-3"),
	);
	const start = records.find(
		(row) => row.type === "role_checkpoint" && row.phase === "started" && row.reservationId === pendingId,
	);
	if (!start) throw new Error("Missing original pending checkpoint");
	kept.push(
		{ type: "measurement_resumed" },
		{ ...start, phase: "interrupted", classification: "interrupted", reason: "author_pause", accounting: "reserved" },
	);
	for (let i = 0; i < 2; i++)
		kept.push({
			type: "role_output_reused",
			caseId: "one",
			toolCallId: "macro",
			originalReservationId: calls.calls[i].id,
			recoveredReservationId: `recovered-${i}`,
		});
	const native = [
		{ ...structuredClone(calls.calls[0]), id: "recovered-0" },
		{ ...structuredClone(calls.calls[1]), id: "recovered-1" },
		structuredClone(calls.calls[3]),
	];
	kept.push({
		type: "tool_result",
		caseId: "one",
		message: {
			role: "toolResult",
			toolName: "write_next_chapter",
			toolCallId: "macro",
			isError: false,
			details: { schema: "story/macro-result@1", calls: native },
			usage: sumUsage(native),
		},
	});
	return kept;
}

test("resumed journal identities audit once while the cancelled physical request retains unknown usage", async () => {
	const records = await recoveredEvidence();
	const result = scoreEvidenceV3(records, [], true);
	expect(result.metrics.find((metric) => metric.id === "H12")).toMatchObject({
		n: 4,
		successes: 4,
		usageAggregateMismatches: 0,
		passed: true,
	});
	expect(result.metrics.find((metric) => metric.id === "C04")).toMatchObject({ n: 3, successes: 3, passed: true });
	expect(result.metrics.find((metric) => metric.id === "H09")).toMatchObject({
		unknownCalls: 1,
		unclassified: 0,
		passed: true,
	});
	const absent = records.filter((row) => row.type !== "role_output_reused");
	expect(scoreEvidenceV3(absent, [], true).metrics.find((metric) => metric.id === "C04")?.passed).toBe(false);
});

test("recovery aliases cannot hide changed usage, sources or duplicated identity", async () => {
	const records = await recoveredEvidence();
	const changed = structuredClone(records);
	const native = changed.find((row) => row.type === "tool_result")?.message as {
		details: { calls: { usage: { cost: { total: number } } }[] };
	};
	native.details.calls[0].usage.cost.total = 1;
	expect(scoreEvidenceV3(changed, [], true).metrics.find((metric) => metric.id === "H12")?.passed).toBe(false);
	const badSource = structuredClone(records);
	const sourceMessage = badSource.find((row) => row.type === "tool_result")?.message as {
		details: { calls: { inputSources: { inputDigest: string } }[] };
	};
	sourceMessage.details.calls[0].inputSources.inputDigest = "0".repeat(64);
	expect(scoreEvidenceV3(badSource, [], true).metrics.find((metric) => metric.id === "C04")?.passed).toBe(false);
	const link = records.find((row) => row.type === "role_output_reused");
	if (!link) throw new Error("Recovery link missing");
	expect(() => scoreEvidenceV3([...records, link], [], true)).toThrow("duplicated");
});
