import { mkdtempSync } from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { foldBranch, type ModelRequest } from "@pi-story/core";
import { expect, test } from "vitest";
import { readEvidence } from "../../../scripts/eval/p2/artifacts.ts";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { RunControl } from "../../../scripts/eval/p2/run-control.ts";
import { scenarioChecks } from "../../../scripts/eval/p3/checks.ts";
import { nativeEntries } from "../../../scripts/eval/p3/metrics.ts";
import { runScenario } from "../../../scripts/eval/p3/scenario.ts";
import { loadV5Scenarios } from "../../../scripts/eval/p3r2/datasets.ts";
import { translateBranch } from "../src/entries.ts";

const scenarios = loadV5Scenarios(
	path.resolve(import.meta.dirname, "../../../testing/datasets/DS14-author-control-e2e/v2"),
	"dev",
);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";

test.each(["E05", "E11"])(
	"V5 %s checks the first writer boundary and rejects an apparently successful later trace",
	async (category) => {
		const scenario = structuredClone(scenarios.find((scenario) => scenario.category === category));
		const work = process.env.PI_STORY_WORK_DIR;
		if (!scenario || !work) throw new Error("Development scenario and workspace required");
		scenario.mode = "faux";
		scenario.execution.internalRoles = "faux";
		const root = mkdtempSync(path.join(work, "temp/p3r2-author-boundary-"));
		const archive = path.join(root, "archive");
		let requests = 0;
		const result = await runScenario(scenario, {
			stage: "P3R2",
			writerLengthFactor: 0.9,
			work: path.join(root, "work"),
			archive,
			suiteId: "P3R2-UNIT",
			runId: category,
			caseId: scenario.id,
			ledger: new UsageLedger(path.join(root, "fees.jsonl"), path.join(root, "reserves.jsonl")),
			control: new RunControl(),
			runLimitUsd: 1,
			fauxShowrunnerReply: (context) => {
				const step = ++requests;
				if (category === "E11" && step === 2)
					return fauxAssistantMessage(
						fauxToolCall("ask_author", { question: "Which delivery identity should I use in the next chapter?" }),
						{ stopReason: "toolUse" },
					);
				if (step === 1 || step === (category === "E11" ? 3 : 2)) {
					const user = context.messages.findLast((message) => message.role === "user");
					const text =
						typeof user?.content === "string"
							? user.content
							: (user?.content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("\n") ?? "");
					return fauxAssistantMessage(fauxToolCall("write_next_chapter", { brief: step === 1 ? "" : text }), {
						stopReason: "toolUse",
					});
				}
				return fauxAssistantMessage("The target is complete.");
			},
		});
		expect(result.status).toBe("measured");
		expect(result.errors).toEqual([]);
		const programCount = 6;
		expect(result.programChecks.slice(0, programCount).map((check) => check.status)).toEqual(
			Array.from({ length: programCount }, () => "passed"),
		);
		const observed = readEvidence(archive, true);
		expect(
			observed.filter((row) => row.driverPhase === "measurement").every((row) => typeof row.observedAt === "number"),
		).toBe(true);
		const prepared = observed.find((row) => row.type === "prepared")?.entries;
		if (!Array.isArray(prepared) || typeof result.firstMeasuredIndex !== "number")
			throw new Error("Prepared native evidence missing");
		const entries = nativeEntries(archive);
		const facts = {
			before: foldBranch(translateBranch(prepared as SessionEntry[])),
			after: foldBranch(translateBranch(entries)),
			entries,
			firstMeasuredIndex: result.firstMeasuredIndex,
			actions: result.actions,
			observed,
			stopReason: result.stopReason,
			injected: result.injected,
		};
		const corrupted = structuredClone(observed);
		if (category === "E05") {
			const native = corrupted.findIndex(
				(row) =>
					row.type === "session_event" &&
					row.driverPhase === "measurement" &&
					object(row.event) &&
					row.event.type === "message_end" &&
					object(row.event.message) &&
					row.event.message.role === "user" &&
					JSON.stringify(row.event.message).includes(scenario.trigger.text),
			);
			expect(native).toBeGreaterThanOrEqual(0);
			const [message] = corrupted.splice(native, 1);
			corrupted.push(message);
		} else {
			const writerIndex = corrupted.findIndex(
				(row) =>
					row.type === "role_checkpoint" &&
					row.driverPhase === "measurement" &&
					row.phase === "started" &&
					object(row.request) &&
					row.request.role === "writer" &&
					JSON.parse(String(row.request.user)).chapter === 3 &&
					JSON.parse(String(row.request.user)).task === "draft",
			);
			expect(writerIndex).toBeGreaterThanOrEqual(0);
			const [first] = corrupted.splice(writerIndex, 1);
			const later = structuredClone(first);
			const input = JSON.parse((first.request as ModelRequest).user) as Record<string, unknown>;
			input.brief = "";
			if (object(input.intent)) input.intent.brief = "";
			(first.request as ModelRequest).user = JSON.stringify(input);
			const answer = corrupted.findIndex((row) => row.type === "dialog_response" && row.driverPhase === "measurement");
			corrupted.splice(answer, 0, first);
			corrupted.push(later);
		}
		expect(scenarioChecks(scenario, { ...facts, observed: corrupted }, "p3-29@1")[3].status).toBe("passed");
		const visibilityCheck = category === "E05" ? 3 : 5;
		expect(scenarioChecks(scenario, { ...facts, observed: corrupted }, "p3r2-32@1")[visibilityCheck].status).toBe(
			"failed",
		);
		expect(result.archive.fee.requests).toBe(0);
	},
);
