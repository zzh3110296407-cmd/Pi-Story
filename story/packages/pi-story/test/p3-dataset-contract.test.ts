import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { EvidenceArchive, sha256 } from "../../../scripts/eval/p2/artifacts.ts";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { RunControl } from "../../../scripts/eval/p2/run-control.ts";
import { loadScenarios, type Scenario } from "../../../scripts/eval/p3/datasets.ts";
import { isMeasurementOnlyRevision } from "../../../scripts/eval/p3/main.ts";
import { runScenario } from "../../../scripts/eval/p3/scenario.ts";

function fixture(category = "E01", storyPrompt = "") {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("Project workspace required");
	const root = mkdtempSync(path.join(work, "temp/p3-empty-prompt-"));
	const version = path.join(root, "dataset");
	mkdirSync(path.join(version, "dev"), { recursive: true });
	const scenario: Scenario = {
		schema: "story/p3-scenario@1",
		id: "local-command-only",
		split: "dev",
		category,
		mode: "faux",
		storyPrompt,
		setup: [],
		trigger: { type: "authorMessage", text: "/goal 3" },
		expect: {
			acceptable: [],
			forbidden: [],
			programChecks: [
				"No author story prompt is created",
				"No goal is written before a story prompt",
				"No control entry, model request, or story mutation is produced",
			],
			judgeChecks: [],
		},
		execution: {
			internalRoles: "faux",
			maxShowrunnerRequests: 3,
			maxChapterAttempts: 1,
			stopAfterFirstAction: false,
			onBoundExceeded: "record_failure_and_stop",
		},
	};
	const bytes = JSON.stringify(scenario);
	writeFileSync(path.join(version, "dev/local.json"), bytes);
	writeFileSync(
		path.join(version, "dev/index.json"),
		JSON.stringify({
			schema: "story/p3-scenario-index@1",
			dataset: "local",
			split: "dev",
			cases: [{ id: scenario.id, path: "local.json", category, mode: "faux", sha256: sha256(bytes) }],
		}),
	);
	return { root, version };
}

test("command-only E01 loads with its deliberately empty story prompt and reaches the actual pre-prompt guard without model calls", async () => {
	const f = fixture();
	const [scenario] = loadScenarios(f.version, "dev");
	expect(scenario.storyPrompt).toBe("");
	const ledger = new UsageLedger(path.join(f.root, "fees.jsonl"), path.join(f.root, "reserves.jsonl"));
	const result = await runScenario(scenario, {
		work: path.join(f.root, "work"),
		archive: path.join(f.root, "archive"),
		suiteId: "local-contract",
		runId: "local-command-only",
		caseId: scenario.id,
		ledger,
		control: new RunControl(),
		runLimitUsd: 1,
	});
	expect(result.status).toBe("measured");
	expect(result.afterLastChapter).toBe(0);
	expect(result.archive.sessionSource).toBe("in_memory_snapshot");
	expect(result.actions).toEqual([]);
	expect(result.programChecks.every((check) => check.status === "passed")).toBe(true);
	expect(ledger.snapshot().requests).toBe(0);
});

test("a finalization error is propagated once without a second archive write masking its cause", async () => {
	const f = fixture();
	const [scenario] = loadScenarios(f.version, "dev");
	const finish = vi.spyOn(EvidenceArchive.prototype, "finish").mockImplementation(() => {
		throw new Error("original-finalization-failure");
	});
	try {
		await expect(
			runScenario(scenario, {
				work: path.join(f.root, "work"),
				archive: path.join(f.root, "archive"),
				suiteId: "local-contract",
				runId: "local-finalization",
				caseId: scenario.id,
				ledger: new UsageLedger(path.join(f.root, "fees.jsonl"), path.join(f.root, "reserves.jsonl")),
				control: new RunControl(),
				runLimitUsd: 1,
			}),
		).rejects.toThrow("original-finalization-failure");
		expect(finish).toHaveBeenCalledTimes(1);
	} finally {
		finish.mockRestore();
	}
});

test("an empty story prompt does not become valid for ordinary writing scenarios", () => {
	const f = fixture("E02");
	expect(() => loadScenarios(f.version, "dev")).toThrow("Invalid scenario contract");
});

test("E01 cannot smuggle a story prompt into the pre-prompt command scenario", () => {
	const f = fixture("E01", "Ada must survive.");
	expect(() => loadScenarios(f.version, "dev")).toThrow("Invalid scenario contract");
});

test("a misspelled scripted-answer field is rejected before a measured session starts", () => {
	const f = fixture();
	const file = path.join(f.version, "dev/local.json");
	const scenario = JSON.parse(readFileSync(file, "utf8"));
	scenario.execution.dialogResponses = [
		{ on: "ask_author", value: "Daylight", delayUntilAssertion: "automatic_continuation_paused" },
	];
	const bytes = JSON.stringify(scenario);
	writeFileSync(file, bytes);
	const indexFile = path.join(f.version, "dev/index.json");
	const index = JSON.parse(readFileSync(indexFile, "utf8"));
	index.cases[0].sha256 = sha256(bytes);
	writeFileSync(indexFile, JSON.stringify(index));
	expect(() => loadScenarios(f.version, "dev")).toThrow("Invalid scenario contract");
});

test("measurement correction stays restricted to loading, archival, frozen-condition checks and their regressions", () => {
	expect(
		isMeasurementOnlyRevision([
			"story/scripts/eval/p3/datasets.ts",
			"story/scripts/eval/p3/main.ts",
			"story/scripts/eval/p3/session.ts",
			"story/scripts/eval/p3/scenario.ts",
			"story/scripts/eval/p3/checks.ts",
			"story/scripts/eval/p3/metrics.ts",
			"story/scripts/eval/p3/scenario-score.ts",
			"story/packages/pi-story/test/p3-dataset-contract.test.ts",
		]),
	).toBe(true);
	for (const file of [
		"story/packages/core/src/flow/next.ts",
		"story/packages/pi-story/src/commands.ts",
		"story/packages/pi-story/rules/story-showrunner/SKILL.md",
		"story/scripts/eval/p3/score.ts",
		"story/testing/datasets/DS14-author-control-e2e/v1/acceptance/E01.json",
	])
		expect(isMeasurementOnlyRevision([file])).toBe(false);
	expect(isMeasurementOnlyRevision([])).toBe(false);
});
