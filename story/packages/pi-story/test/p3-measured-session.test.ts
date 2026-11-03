import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { readEvidence } from "../../../scripts/eval/p2/artifacts.ts";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { RunControl } from "../../../scripts/eval/p2/run-control.ts";
import { createMeasuredSession } from "../../../scripts/eval/p3/session.ts";
import { p3Opening } from "./p3-fixture.ts";

test("P3 preparation uses actual tools with faux-only calls and archives the native session without paid fees", async () => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("Project workspace required");
	mkdirSync(path.join(work, "temp"), { recursive: true });
	const root = mkdtempSync(path.join(work, "temp/p3-session-"));
	const responses = [
		fauxAssistantMessage(p3Opening(), { stopReason: "toolUse" }),
		fauxAssistantMessage("Ready."),
		fauxAssistantMessage("Measured response."),
	];
	const f = await createMeasuredSession({
		work: path.join(root, "work"),
		archive: path.join(root, "archive"),
		suiteId: "P3-SCEN",
		runId: "offline",
		caseId: "local",
		ledger: new UsageLedger(path.join(root, "fees.jsonl"), path.join(root, "reserves.jsonl")),
		control: new RunControl(),
		runLimitUsd: 2,
		main: "faux",
		internals: "faux",
		maxShowrunnerRequests: 4,
		reply: () => {
			const response = responses.shift();
			if (!response) throw new Error("Unexpected request");
			return response;
		},
	});
	const fetchBefore = globalThis.fetch;
	let dispatched = 0;
	globalThis.fetch = async () => {
		dispatched++;
		throw new Error("Offline test must not dispatch");
	};
	try {
		await f.session.bindExtensions({
			mode: "print",
			onError: () => {
				throw new Error("Extension error");
			},
		});
		await f.session.prompt("Ada must survive.");
		expect(f.story.current()?.source.model().outline).toHaveLength(3);
		await f.measure();
		await f.session.prompt("Report readiness.");
		const final = f.finish();
		expect(final.fee).toMatchObject({ requests: 0, totalUsd: 0 });
		expect(final.measuredMainRequests).toBe(1);
		expect(dispatched).toBe(0);
		const records = readEvidence(path.join(root, "archive"));
		expect(records.filter((row) => row.type === "model_call" && row.driverPhase === "preparation")).toHaveLength(2);
		expect(records.filter((row) => row.type === "model_call").every((row) => row.paid === false)).toBe(true);
	} finally {
		globalThis.fetch = fetchBefore;
		f.dispose();
	}
});
