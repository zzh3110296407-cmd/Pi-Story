import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { EvidenceArchive, readEvidence } from "../../../scripts/eval/p2/artifacts.ts";
import { createDriver } from "../../../scripts/eval/p2/driver.ts";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { executionObservations } from "../../../scripts/eval/p2/observations.ts";
import { scoreEvidence } from "../../../scripts/eval/p2/score.ts";
import { draftText, keeperReply, openingCalls } from "./fixture.ts";

test("the complete offline driver archives a real SDK chapter and rescores actual outputs", async () => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("P2 workspace required");
	mkdirSync(path.join(work, "temp"), { recursive: true });
	const root = mkdtempSync(path.join(work, "temp/driver-"));
	const run = path.join(root, "run");
	const archive = new EvidenceArchive(run, path.join(root, "archive"), {
		suiteId: "P2-CHAP",
		runId: "faux-driver",
		expectedCaseIds: ["one"],
	});
	const ledger = new UsageLedger(path.join(root, "usage.jsonl"), path.join(root, "reservations.jsonl"));
	const faux = fauxProvider({ models: [{ id: "script", contextWindow: 1_000_000, maxTokens: 32768 }] });
	const driver = await createDriver({
		work: path.join(root, "pi"),
		suiteId: "P2-CHAP",
		runId: "faux-driver",
		caseId: "one",
		archive,
		ledger,
		runLimitUsd: 1,
		phase: "faux",
		model: "faux/script",
		maxChapters: 1,
		configureRuntime: (runtime) => runtime.registerNativeProvider(faux.provider),
	});
	try {
		faux.setResponses([
			fauxAssistantMessage([...openingCalls(), fauxToolCall("write_next_chapter", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(draftText),
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(keeperReply)),
		]);
		await driver.session.prompt("Ada must survive.");
		const model = driver.state().source.model();
		expect(model.commits).toHaveLength(1);
		archive.emit({
			type: "chapter_result",
			caseId: "one",
			targetWords: 100,
			wordCount: model.commits[0].text.split(/\s+/u).length,
		});
		expect(driver.errors).toEqual([]);
	} finally {
		driver.close();
	}
	archive.finish();
	const raw = readEvidence(run);
	const checkpoints = raw
		.filter((row) => row.type === "role_checkpoint")
		.map(
			(row) =>
				JSON.parse(gunzipSync(readFileSync(path.join(run, "raw", String(row.rawFile)))).toString("utf8")) as {
					phase: string;
					reservationId: string;
					toolCallId: string;
					record?: unknown;
					inputSources?: unknown[];
				},
		);
	expect(checkpoints).toHaveLength(6);
	expect(new Set(checkpoints.map((row) => row.toolCallId)).size).toBe(1);
	expect(new Set(checkpoints.map((row) => row.reservationId)).size).toBe(3);
	for (let i = 0; i < checkpoints.length; i += 2) {
		expect(checkpoints[i]).toMatchObject({ phase: "started", inputSources: expect.any(Array) });
		expect(checkpoints[i + 1]).toMatchObject({ phase: "completed", reservationId: checkpoints[i].reservationId });
	}
	const metrics = scoreEvidence(raw, []);
	const execution = executionObservations(raw);
	expect(execution.total).toMatchObject({
		logicalRequests: 5,
		knownUsd: ledger.snapshot().knownUsd,
		reservedUsd: 0,
		unknownCalls: 0,
	});
	expect(execution.chapters[0]).toMatchObject({
		chapter: 1,
		committed: true,
		internalCalls: 3,
		mainLogicalRequests: 1,
	});
	const priced = structuredClone(raw);
	const pricedResponse = priced.find((row) => row.type === "response" && row.role === "writer") as
		| { response: AssistantMessage }
		| undefined;
	if (!pricedResponse) throw new Error("Missing normalized writer response");
	pricedResponse.response.usage.cost.total = 1;
	expect(executionObservations(priced)).toMatchObject({
		total: { knownUsd: 1 },
		chapters: [{ knownUsd: 1 }],
		overhead: { knownUsd: 0 },
	});
	for (const id of ["H12", "C04"])
		expect(metrics.metrics.find((item) => item.id === id)).toMatchObject({ n: 3, value: 1, passed: true });
	expect(metrics.metrics.find((item) => item.id === "K02")).toMatchObject({ n: 1, value: { first: 1, final: 1 } });
	expect(scoreEvidence(raw, [])).toEqual(metrics);
	const missingUsage = structuredClone(raw);
	const missingCall = missingUsage.find((row) => row.type === "role_call") as
		| { response: AssistantMessage }
		| undefined;
	if (!missingCall) throw new Error("Missing observed role call");
	missingCall.response.stopReason = "error";
	missingCall.response.usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	expect(scoreEvidence(missingUsage, []).metrics.find((item) => item.id === "H09")).toMatchObject({
		unknownCalls: 1,
		passed: null,
		status: "unknown_usage",
	});
	const corrupted = structuredClone(raw);
	const tool = corrupted.find(
		(row) => row.type === "tool_result" && (row.message as ToolResultMessage).toolName === "write_next_chapter",
	);
	if (!tool) throw new Error("Missing real macro tool result");
	const message = tool.message as ToolResultMessage;
	if (!message.usage) throw new Error("Missing real aggregate usage");
	message.usage.cost.total += 1;
	expect(scoreEvidence(corrupted, []).metrics.find((item) => item.id === "H12")).toMatchObject({
		passed: false,
		usageAggregateMismatches: 1,
	});
	// Pi prepares one final showrunner request after the tool boundary; the
	// driver's abort prevents its provider dispatch and records a known zero fee.
	expect(ledger.snapshot()).toMatchObject({ requests: 5, totalUsd: 0, unknownCalls: 0 });
});
