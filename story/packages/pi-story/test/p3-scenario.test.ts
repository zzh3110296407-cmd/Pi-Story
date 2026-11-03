import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { readEvidence } from "../../../scripts/eval/p2/artifacts.ts";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { RunControl } from "../../../scripts/eval/p2/run-control.ts";
import type { Scenario } from "../../../scripts/eval/p3/datasets.ts";
import { loadScenarios } from "../../../scripts/eval/p3/datasets.ts";
import { rescoreScenarioArchive } from "../../../scripts/eval/p3/metrics.ts";
import { emptyKeeper, prepareScenario, ReplyQueue } from "../../../scripts/eval/p3/prepare.ts";
import { bindScriptedDialog, runScenario, scenarioOutcome, scoreActions } from "../../../scripts/eval/p3/scenario.ts";
import { createMeasuredSession, requestRole } from "../../../scripts/eval/p3/session.ts";

const scenarios = loadScenarios(
	path.resolve(import.meta.dirname, "../../../testing/datasets/DS14-author-control-e2e/v1"),
	"dev",
);

test.each(["input", "select", "missing"])(
	"scripted %s reply follows the public RPC UI contract and exposes delivery failure",
	async (dialog) => {
		const base = structuredClone(scenarios.find((scenario) => scenario.category === "E10"));
		const text = scenarios.find((scenario) => scenario.category === "E15")?.execution.fauxProfile?.validRetryText;
		const work = process.env.PI_STORY_WORK_DIR;
		if (!base || !text || !work) throw new Error("Local fixtures and workspace required");
		for (const step of base.setup) if (step.step === "command" && step.text.startsWith("/goal")) step.text = "/goal 2";
		const root = mkdtempSync(path.join(work, "temp/p3-dialog-"));
		const queue = new ReplyQueue();
		const errors: string[] = [];
		const observed: Array<Record<string, unknown>> = [];
		const reply = "Use brighter daylight; keep the mood serious.";
		let mainReceivedAnswer = false;
		let asked = false;
		let f: Awaited<ReturnType<typeof createMeasuredSession>> | undefined;
		f = await createMeasuredSession({
			work: path.join(root, "work"),
			archive: path.join(root, "archive"),
			suiteId: "P3-UNIT",
			runId: `dialog-${dialog}`,
			caseId: `dialog-${dialog}`,
			main: "faux",
			internals: "faux",
			ledger: new UsageLedger(path.join(root, "fees.jsonl"), path.join(root, "reserves.jsonl")),
			control: new RunControl(),
			runLimitUsd: 1,
			maxShowrunnerRequests: 6,
			onEvidence: (row) => {
				observed.push(row);
				if (row.type === "scenario_driver_error") errors.push(String(row.diagnostic));
			},
			reply: (context) => {
				if (!f) throw new Error("Session not initialized");
				if (f.phase === "preparation") return queue.next(context);
				const role = requestRole(context);
				if (role === "writer") return fauxAssistantMessage(text);
				if (role === "editor") return fauxAssistantMessage('{"observations":[]}');
				if (role === "keeper") return emptyKeeper(context);
				if (!asked) {
					asked = true;
					return fauxAssistantMessage(
						fauxToolCall("ask_author", {
							question: "Does lighter refer to illumination or mood?",
							...(dialog === "select" ? { options: ["Illumination", "Mood"] } : {}),
						}),
						{ stopReason: "toolUse" },
					);
				}
				mainReceivedAnswer ||= context.messages.some(
					(message) =>
						(message.role === "user" || message.role === "toolResult") &&
						(typeof message.content === "string"
							? message.content
							: message.content
									.filter((block) => block.type === "text")
									.map((block) => block.text)
									.join("\n")
						).includes(reply),
				);
				return f.story.current()?.source.model().lastChapter === 1
					? fauxAssistantMessage(fauxToolCall("write_next_chapter", { brief: reply }), { stopReason: "toolUse" })
					: fauxAssistantMessage("The chapter is complete.");
			},
		});
		try {
			await f.session.bindExtensions({ mode: "print", onError: (event) => errors.push(event.error) });
			await prepareScenario(f, base, queue);
			const firstMeasuredIndex = f.manager.getBranch().length;
			await f.measure();
			await bindScriptedDialog(
				f,
				dialog === "missing" ? [] : [{ on: "ask_author", reply, delayUntilAssertion: "automatic_continuation_paused" }],
				(error) => errors.push(error),
			);
			await f.session.prompt("Make the next scene lighter; ask which meaning before writing.");
			const model = f.story.current()?.source.model();
			if (dialog === "missing") {
				expect(model?.authorMessages.some((message) => message.text === reply)).toBe(false);
				expect(model?.lastChapter).toBe(1);
				expect(observed.some((row) => row.type === "scenario_driver_error")).toBe(true);
				expect(scenarioOutcome("E11", [{ tool: "ask_author" }], errors, false).status).toBe("incomplete");
				// Reproduce the legacy summary bug over an actual failed SDK dialog:
				// replay must not trust its old measured label when the answer is absent.
				f.emit({
					type: "scenario_result",
					result: {
						actions: [{ tool: "ask_author" }],
						firstMeasuredIndex,
						injected: true,
						status: "measured",
						stopReason: f.story.current()?.stopReason,
					},
				});
				f.finish();
				expect(
					rescoreScenarioArchive(
						{
							...base,
							category: "E11",
							execution: {
								...base.execution,
								dialogResponses: [{ on: "ask_author", reply, delayUntilAssertion: "automatic_continuation_paused" }],
							},
						},
						path.join(root, "archive"),
					),
				).toMatchObject({ rawOutcomeRetained: "measured", measurementStatus: "incomplete" });
				return;
			}
			expect(model?.authorMessages.some((message) => message.text === reply)).toBe(true);
			expect(model?.lastChapter).toBe(2);
			expect(mainReceivedAnswer).toBe(true);
			expect(
				observed.find(
					(row) =>
						row.type === "role_checkpoint" &&
						row.driverPhase === "measurement" &&
						row.phase === "started" &&
						typeof row.request === "object" &&
						row.request !== null &&
						"role" in row.request &&
						row.request.role === "writer",
				),
			).toMatchObject({ request: { user: expect.stringContaining(reply) } });
			expect(observed.find((row) => row.type === "dialog_pause")).toMatchObject({
				waitingForAuthor: true,
				stopReason: "ask_author",
			});
			expect(observed.find((row) => row.type === "dialog_response")).toMatchObject({
				value: reply,
				channel: "rpc_value",
			});
			expect(observed.filter((row) => row.type === "scenario_driver_error")).toEqual([]);
			expect(errors).toEqual([]);
			f.finish();
		} finally {
			await f.session.abort();
			f.dispose();
		}
	},
	30_000,
);
test.each(["E10", "E15"])(
	"%s deterministic fault fixture runs real core guards, journals and transport retry without network",
	async (category) => {
		const scenario = scenarios.find((scenario) => scenario.category === category);
		if (!scenario) throw new Error("Development scenario missing");
		const work = process.env.PI_STORY_WORK_DIR;
		if (!work) throw new Error("Project workspace required");
		mkdirSync(path.join(work, "temp"), { recursive: true });
		const root = mkdtempSync(path.join(work, "temp/p3-scenario-"));
		const archive = path.join(root, "archive");
		const fetchBefore = globalThis.fetch;
		globalThis.fetch = async () => {
			throw new Error("Faux scenario must not use HTTP");
		};
		try {
			const result = await runScenario(scenario, {
				work: path.join(root, "work"),
				archive,
				suiteId: "P3-UNIT",
				runId: scenario.id,
				caseId: scenario.id,
				ledger: new UsageLedger(path.join(root, "fees.jsonl"), path.join(root, "reserves.jsonl")),
				control: new RunControl(),
				runLimitUsd: 2,
			});
			expect(result.errors).toEqual([]);
			expect(result.priorChaptersUnchanged).toBe(true);
			expect(result.programChecks.map((check) => ({ index: check.index, status: check.status }))).toEqual(
				scenario.expect.programChecks.map((_check, index) => ({ index, status: "passed" })),
			);
			expect(result.archive.fee.requests).toBe(0);
			expect(rescoreScenarioArchive(scenario, archive).programChecks).toEqual(result.programChecks);
			const rows = readEvidence(archive, true);
			const calls = rows.filter(
				(row) => row.type === "role_checkpoint" && row.driverPhase === "measurement" && row.phase === "completed",
			);
			if (category === "E10") {
				expect(result.afterLastChapter).toBe(1);
				expect(result.stopReason).toBe("budget_exhausted");
				expect(calls.map((row) => (row.record as { role: string }).role)).toEqual(["writer", "editor", "writer"]);
			} else {
				expect(result.afterLastChapter).toBe(2);
				expect(result.stopReason).toBe("goal_reached");
				const records = calls.map(
					(row) => row.record as { id: string; retryOf?: string; usage: unknown; reservedInputTokens: number },
				);
				expect(records).toHaveLength(4);
				expect(records[1].retryOf).toBe(records[0].id);
				expect(records[1].id).not.toBe(records[0].id);
				expect(records[0].usage).toBeNull();
				expect(records[0].reservedInputTokens).toBeGreaterThan(0);
			}
		} finally {
			globalThis.fetch = fetchBefore;
		}
	},
	30_000,
);

test("action scoring keeps the first emitted tool and applies independent forbidden checks", () => {
	const scenario = {
		...scenarios[0],
		expect: {
			acceptable: [{ tool: "patch_outline", argsMatch: { "chapters[0].n": 3 } }],
			forbidden: [{ tool: "write_next_chapter" }],
			programChecks: [],
			judgeChecks: [],
		},
	};
	expect(
		scoreActions(scenario, [
			{ tool: "write_next_chapter", args: {} },
			{ tool: "patch_outline", args: { chapters: [{ n: 3 }] } },
		]),
	).toMatchObject({ firstAcceptable: false, forbidden: [{ tool: "write_next_chapter" }] });
	expect(scoreActions(scenario, [{ tool: "patch_outline", args: { chapters: [{ n: 3 }] } }]).firstAcceptable).toBe(
		true,
	);
});

test("pre-dispatch fee denial and missing model output are incomplete, while E01 is an intentional command-only case", () => {
	expect(scenarioOutcome("A_change_unwritten_outline", [], [], false)).toMatchObject({
		status: "incomplete",
		errors: ["No measured action or final reply was received"],
	});
	expect(scenarioOutcome("H_budget_stop", [{ reply: "" }], [], false).status).toBe("incomplete");
	expect(scenarioOutcome("E01", [], [], false).status).toBe("measured");
});

test.each(["E03", "E04", "E05", "E06", "E07", "E08", "E09", "E14", "J"])(
	"%s scheduler and guards are exercised locally before any paid development",
	async (category) => {
		const base =
			category === "J"
				? loadScenarios(
						path.resolve(import.meta.dirname, "../../../testing/datasets/DS11-showrunner-scenarios/v1"),
						"dev",
					).find((scenario) => scenario.category.startsWith("J_"))
				: scenarios.find(
						(scenario) =>
							scenario.category ===
							(["E03", "E05", "E06", "E07"].includes(category)
								? "E04"
								: category === "E09" || category === "E14"
									? "E10"
									: category),
					);
		const retryText = scenarios.find((scenario) => scenario.category === "E15")?.execution.fauxProfile?.validRetryText;
		if (!base || !retryText) throw new Error("Development fixtures missing");
		const scenario: Scenario = structuredClone(base);
		scenario.id = category === "J" ? "ds11-j-synthetic" : `synthetic-${category}`;
		scenario.category = category === "J" ? base.category : category;
		scenario.mode = "faux";
		scenario.execution.internalRoles = "faux";
		scenario.execution.fauxProfile = { id: "valid_fixture", validRetryText: retryText };
		if (category === "J") scenario.execution.fauxProfile = { id: "valid_fixture" };
		if (["E03", "E05", "E06", "E07"].includes(category)) {
			scenario.trigger.type = category === "E05" ? "followUp" : "authorMessage";
			scenario.trigger.text =
				category === "E03"
					? "/goal off"
					: category === "E06"
						? "/intent Avoid accusation."
						: category === "E07"
							? "/focus Compare physical labels."
							: "In the following chapter, compare the new sealed envelope.";
			scenario.expect.programChecks = [
				"Prior chapters unchanged",
				"Preparation faux",
				"Control transition",
				"Next writer visibility or continuation behavior",
				...(category === "E05" ? [] : ["Final state or basis gate"]),
			];
		} else if (category === "E09") {
			scenario.trigger = { type: "authorMessage", text: "/budget usd=0.01" };
			scenario.execution.fauxProfile = { id: "priced_calls" };
			scenario.expect.programChecks = [
				"Prior chapters unchanged",
				"Preparation faux",
				"Only the declared deterministic local model is used",
				"One charged call precedes the next denied reservation",
				"Separate main guard probe denies before dispatch",
				"Budget stop is reported without a further request",
			];
		} else if (category === "E14") {
			scenario.trigger = { type: "continue", text: "Write the next chapter." };
			scenario.execution.afterTrigger = [];
			scenario.execution.fauxProfile = { id: "two_unusable_drafts" };
			scenario.expect.programChecks = [
				"Prior chapters unchanged",
				"Preparation faux",
				"Two actual parse failures",
				"Guard probe denies third attempt without a new author message",
				"Stop and report after consecutive failures",
			];
		}
		const work = process.env.PI_STORY_WORK_DIR;
		if (!work) throw new Error("Project workspace required");
		const root = mkdtempSync(path.join(work, "temp/p3-synthetic-"));
		const fetchBefore = globalThis.fetch;
		globalThis.fetch = async () => {
			throw new Error("Local checks must not dispatch HTTP");
		};
		try {
			const result = await runScenario(scenario, {
				work: path.join(root, "work"),
				archive: path.join(root, "archive"),
				suiteId: "P3-UNIT",
				runId: scenario.id,
				caseId: scenario.id,
				ledger: new UsageLedger(path.join(root, "fees.jsonl"), path.join(root, "reserves.jsonl")),
				control: new RunControl(),
				runLimitUsd: 2,
			});
			expect(result.errors).toEqual([]);
			expect(result.archive.fee.requests).toBe(0);
			expect(result.programChecks.map((check) => ({ index: check.index, status: check.status }))).toEqual(
				scenario.expect.programChecks.map((_check, index) => ({
					index,
					// E09 now has a persisted stop receipt; E05 prose effects still
					// require independent judgment rather than a driver assertion.
					status: category === "E05" && index === 3 ? "pending_judgment" : "passed",
				})),
			);
			if (category === "E09") {
				const archive = path.join(root, "archive");
				const event = readEvidence(archive, true).find(
					(row) => row.type === "driver_probe" && row.probe === "showrunner_predispatch",
				);
				const checksums = JSON.parse(readFileSync(path.join(archive, "raw/checksums.json"), "utf8"));
				const supplement = {
					schema: "story/p3-saved-showrunner-probe@1",
					caseId: scenario.id,
					sourceSessionSha256: "wrong-session",
					event,
				};
				const file = path.join(archive, "saved-showrunner-probe.json");
				writeFileSync(file, JSON.stringify(supplement));
				expect(() => rescoreScenarioArchive(scenario, archive)).toThrow("Invalid saved-session guard probe");
				supplement.sourceSessionSha256 = checksums.sessionSha256;
				writeFileSync(file, JSON.stringify(supplement));
				expect(rescoreScenarioArchive(scenario, archive).programChecks).toEqual(result.programChecks);
			}
		} finally {
			globalThis.fetch = fetchBefore;
		}
	},
	30_000,
);
