import { mkdtempSync } from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { EvidenceArchive } from "../../../scripts/eval/p2/artifacts.ts";
import { createDriver } from "../../../scripts/eval/p2/driver.ts";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { draftText, keeperReply, openingCalls } from "./fixture.ts";

test.each([false, true])("opening goal stops before any chapter when outline repair=%s", async (repaired) => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("P2 workspace required");
	const root = mkdtempSync(path.join(work, "temp/p2r-opening-goal-"));
	const archive = new EvidenceArchive(path.join(root, "run"), path.join(root, "archive"), {
		suiteId: "P2-OPEN",
		runId: "goal",
		expectedCaseIds: ["one"],
		stage: "P2R",
	});
	const fees = new UsageLedger(path.join(root, "usage.jsonl"), path.join(root, "reservations.jsonl"));
	const faux = fauxProvider({ models: [{ id: "script", contextWindow: 1_000_000, maxTokens: 32768 }] });
	const calls = openingCalls();
	if (repaired)
		calls[2] = {
			...calls[2],
			arguments: {},
			argumentsError: `Unexpected non-whitespace character after JSON\n\nReceived arguments:\n${JSON.stringify(calls[2].arguments)}}`,
		};
	faux.setResponses([
		fauxAssistantMessage(calls, { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("write_next_chapter", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(draftText),
		fauxAssistantMessage('{"observations":[]}'),
		fauxAssistantMessage(JSON.stringify(keeperReply)),
		fauxAssistantMessage("Done."),
	]);
	const driver = await createDriver({
		work: path.join(root, "pi"),
		suiteId: "P2-OPEN",
		runId: "goal",
		caseId: "one",
		archive,
		ledger: fees,
		runLimitUsd: 1,
		phase: "faux",
		model: "faux/script",
		configureRuntime: (runtime) => runtime.registerNativeProvider(faux.provider),
	});
	try {
		await driver.session.prompt("Ada must survive.");
		expect(driver.state().source.model().outlineRev).toBe(1);
		expect(driver.state().source.model().commits).toHaveLength(0);
		expect(faux.state.callCount).toBe(1);
	} finally {
		driver.close();
	}
	archive.finish();
});
