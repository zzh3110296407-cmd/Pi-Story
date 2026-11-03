import { mkdtempSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { RunControl } from "../../../scripts/eval/p2/run-control.ts";
import { prepareScenario, ReplyQueue } from "../../../scripts/eval/p3/prepare.ts";
import { createMeasuredSession } from "../../../scripts/eval/p3/session.ts";
import { loadV5Scenarios } from "../../../scripts/eval/p3r2/datasets.ts";

const datasets = path.resolve(import.meta.dirname, "../../../testing/datasets");
const scenarios = [
	...loadV5Scenarios(path.join(datasets, "DS11-showrunner-scenarios/v3"), "dev"),
	...loadV5Scenarios(path.join(datasets, "DS14-author-control-e2e/v2"), "dev"),
];
test("J1 development selection contains the declared 18 scenarios and 7 E2E variants", () => {
	expect(scenarios.filter((scenario) => scenario.schema === "story/p3-scenario@2")).toHaveLength(18);
	expect(scenarios.filter((scenario) => scenario.id.startsWith("ds14-"))).toHaveLength(7);
});
test.each(scenarios)("$id preparation uses actual SDK/domain constructors with no paid requests", async (scenario) => {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("Project workspace required");
	const root = mkdtempSync(path.join(work, "temp/p3r2-prepare-"));
	const queue = new ReplyQueue();
	const errors: string[] = [];
	const f = await createMeasuredSession({
		stage: "P3R2",
		writerLengthFactor: 0.9,
		work: path.join(root, "work"),
		archive: path.join(root, "archive"),
		suiteId: "P3R2-UNIT",
		runId: scenario.id,
		caseId: scenario.id,
		main: "faux",
		internals: "faux",
		ledger: new UsageLedger(path.join(root, "fees.jsonl"), path.join(root, "reserves.jsonl")),
		control: new RunControl(),
		runLimitUsd: 1,
		maxShowrunnerRequests: 6,
		reply: (context) => queue.next(context),
		extension: (pi) => {
			pi.on("agent_before_settle", () => ({ entries: [], continue: false }));
		},
	});
	try {
		await f.session.bindExtensions({ mode: "print", onError: (event) => errors.push(event.error) });
		await prepareScenario(f, scenario, queue);
		const model = f.story.current()?.source.model();
		expect(model?.commits.map((commit) => commit.text)).toEqual(
			scenario.setup.flatMap((step) => (step.step === "commitChapters" ? step.texts : [])),
		);
		if (scenario.category.startsWith("L")) expect(model?.failures[(model.lastChapter ?? 0) + 1]).toBe(2);
		expect(errors).toEqual([]);
		expect(f.finish().fee.requests).toBe(0);
	} finally {
		await f.session.abort();
		f.dispose();
	}
});
