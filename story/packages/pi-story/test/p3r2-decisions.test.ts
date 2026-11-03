import { mkdtempSync } from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { EvidenceArchive, readEvidence } from "../../../scripts/eval/p2/artifacts.ts";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { RunControl } from "../../../scripts/eval/p2/run-control.ts";
import { loadScenarios, type Scenario } from "../../../scripts/eval/p3/datasets.ts";
import { runScenario, scoreActions } from "../../../scripts/eval/p3/scenario.ts";
import { loadV5Scenarios } from "../../../scripts/eval/p3r2/datasets.ts";
import { decisiveAction } from "../../../scripts/eval/p3r2/decisions.ts";

function scenarioFixture(): Scenario {
	const base = structuredClone(
		loadScenarios(
			path.resolve(import.meta.dirname, "../../../testing/datasets/DS11-showrunner-scenarios/v2"),
			"dev",
		)[0],
	);
	const { stopAfterFirstAction: _oldStop, ...execution } = base.execution;
	return {
		...base,
		schema: "story/p3-scenario@2",
		id: "local-v2-decision",
		mode: "faux",
		trigger: { type: "authorMessage", text: "Report the current state." },
		expect: { acceptable: [{ reply: true }], forbidden: [], programChecks: [], judgeChecks: [] },
		execution: {
			...execution,
			internalRoles: "faux",
			stopAt: "decisive_action",
			maxReadOnlyCalls: 3,
			maxShowrunnerRequests: 6,
		},
	};
}

test("@2 permits up to three preparatory reads and chooses the first native non-read-only call", () => {
	const actions = [
		{ tool: "read_story" },
		{ tool: "read_chapter" },
		{ tool: "get_character" },
		{ tool: "patch_outline", id: "patch" },
		{ tool: "write_next_chapter" },
	];
	expect(decisiveAction(actions, 3)).toMatchObject({ action: actions[3], readOnlyCalls: 3, exceeded: false });
	expect(decisiveAction([{ tool: "read_state" }, { reply: "The clue is under the gate." }], 3)).toMatchObject({
		action: { reply: "The clue is under the gate." },
		readOnlyCalls: 1,
	});
	expect(decisiveAction([{ tool: "new_unknown_tool" }], 3).action).toEqual({ tool: "new_unknown_tool" });
	expect(decisiveAction([...actions.slice(0, 3), { tool: "read_state" }, actions[3]], 3).exceeded).toBe(true);
	expect(decisiveAction([{ tool: "read_state" }], 3).action).toBeNull();
});

test("@1 first-action scoring remains unchanged while @2 scores the decisive action and all forbidden calls", () => {
	const fixture = scenarioFixture();
	const { stopAt: _stopAt, maxReadOnlyCalls: _maxReadOnlyCalls, ...execution } = fixture.execution;
	const base: Scenario = {
		...fixture,
		schema: "story/p3-scenario@1",
		execution: { ...execution, stopAfterFirstAction: true },
		expect: {
			acceptable: [{ tool: "patch_outline" }],
			forbidden: [{ tool: "write_next_chapter" }],
			programChecks: [],
			judgeChecks: [],
		},
	};
	const { stopAfterFirstAction: _stopAfterFirstAction, ...v2Execution } = base.execution;
	const v2: Scenario = {
		...base,
		schema: "story/p3-scenario@2",
		execution: { ...v2Execution, stopAt: "decisive_action", maxReadOnlyCalls: 3 },
	};
	const actions = [{ tool: "read_story" }, { tool: "patch_outline" }, { tool: "write_next_chapter" }];
	expect(scoreActions(base, actions)).toMatchObject({ firstAcceptable: false, firstAction: actions[0] });
	expect(scoreActions(v2, actions)).toMatchObject({
		firstAcceptable: true,
		firstAction: actions[1],
		readOnlyCalls: 1,
		forbidden: [actions[2]],
	});
	expect(
		scoreActions(v2, Array.from({ length: 4 }, () => ({ tool: "read_story" })).concat([{ tool: "patch_outline" }])),
	).toMatchObject({ firstAcceptable: false, readOnlyCalls: 4 });
});

test.each(["read_then_reply", "read_limit", "request_limit", "transport_failure"])(
	"@2 actual SDK measures %s without confusing behavior failure with missing output",
	async (mode) => {
		const work = process.env.PI_STORY_WORK_DIR;
		if (!work) throw new Error("Project workspace required");
		const root = mkdtempSync(path.join(work, "temp/p3r2-decision-"));
		const scenario = scenarioFixture();
		let requests = 0;
		const result = await runScenario(scenario, {
			stage: "P3R2",
			work: path.join(root, "work"),
			archive: path.join(root, "archive"),
			suiteId: "P3R2-UNIT",
			runId: mode,
			caseId: scenario.id,
			ledger: new UsageLedger(path.join(root, "fees.jsonl"), path.join(root, "reserves.jsonl")),
			control: new RunControl(),
			runLimitUsd: 1,
			fauxShowrunnerReply: () => {
				requests++;
				if (mode === "transport_failure")
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic transport interruption" });
				if (mode === "request_limit") return fauxAssistantMessage("");
				if (mode === "read_then_reply" && requests === 2)
					return fauxAssistantMessage("The current state is available.");
				return fauxAssistantMessage(fauxToolCall("read_state", {}), { stopReason: "toolUse" });
			},
		});
		if (mode === "transport_failure") {
			expect(result.status).toBe("incomplete");
		} else {
			expect(result.status).toBe("measured");
			expect(result.errors).toEqual([]);
			if (mode === "read_then_reply")
				expect(result).toMatchObject({ firstAcceptable: true, readOnlyCalls: 1, completedMainRequests: 2 });
			else expect(result).toMatchObject({ firstAcceptable: false, decisionLimitReached: true, behaviorFailed: true });
			if (mode === "read_limit") expect(requests).toBe(4);
			if (mode === "request_limit") expect(requests).toBe(6);
		}
		expect(result.archive.fee.requests).toBe(0);
	},
);

test("V5 acceptance requires a product freeze before any index read", () => {
	expect(() => loadV5Scenarios("nonexistent", "acceptance")).toThrow("V5 product freeze required");
});

test.each(["D", "H"])(
	"@2 historical program checks use the decisive %s action after permitted reads",
	async (category) => {
		const scenario = structuredClone(
			loadV5Scenarios(
				path.resolve(import.meta.dirname, "../../../testing/datasets/DS11-showrunner-scenarios/v3"),
				"dev",
			).find((scenario) => scenario.category.startsWith(`${category}_`)),
		);
		const work = process.env.PI_STORY_WORK_DIR;
		if (!scenario || !work) throw new Error("Development fixture and workspace required");
		scenario.mode = "faux";
		const root = mkdtempSync(path.join(work, "temp/p3r2-program-decision-"));
		let requests = 0;
		const result = await runScenario(scenario, {
			stage: "P3R2",
			work: path.join(root, "work"),
			archive: path.join(root, "archive"),
			suiteId: "P3R2-UNIT",
			runId: category,
			caseId: scenario.id,
			ledger: new UsageLedger(path.join(root, "fees.jsonl"), path.join(root, "reserves.jsonl")),
			control: new RunControl(),
			runLimitUsd: 1,
			fauxShowrunnerReply: () => {
				if (++requests === 1) return fauxAssistantMessage(fauxToolCall("read_state", {}), { stopReason: "toolUse" });
				return category === "D"
					? fauxAssistantMessage(
							fauxToolCall("ask_author", { question: "Which of the two alternatives should this chapter use?" }),
							{ stopReason: "toolUse" },
						)
					: fauxAssistantMessage("The chapter call quota is exhausted; no additional chapter has been committed.");
			},
		});
		expect(result.programChecks.map((check) => check.status)).toEqual(
			scenario.expect.programChecks.map(() => "passed"),
		);
		expect(result.firstAcceptable).toBe(true);
	},
);

test("P3R2 interrupted role checkpoints remain archived with their unknown reservations", () => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("Project workspace required");
	const root = mkdtempSync(path.join(work, "temp/p3r2-interrupted-"));
	const archive = new EvidenceArchive(path.join(root, "archive"), path.join(root, "work"), {
		suiteId: "P3R2-UNIT",
		stage: "P3R2",
		runId: "interrupted",
		expectedCaseIds: ["one"],
	});
	archive.emit({
		type: "role_checkpoint",
		phase: "started",
		caseId: "one",
		reservationId: "pending-1",
		request: { role: "writer" },
	});
	archive.finish();
	expect(
		readEvidence(path.join(root, "archive"), true)
			.filter((row) => row.type === "role_checkpoint")
			.map((row) => row.phase),
	).toEqual(["started", "interrupted"]);
});
