import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { RunControl } from "../../../scripts/eval/p2/run-control.ts";
import { loadScenarios } from "../../../scripts/eval/p3/datasets.ts";
import { prepareScenario, ReplyQueue, seedUsageSnapshot } from "../../../scripts/eval/p3/prepare.ts";
import { createMeasuredSession } from "../../../scripts/eval/p3/session.ts";

const datasets = path.resolve(import.meta.dirname, "../../../testing/datasets");
const scenarios = [
	...loadScenarios(path.join(datasets, "DS11-showrunner-scenarios/v2"), "dev"),
	...loadScenarios(path.join(datasets, "DS14-author-control-e2e/v1"), "dev"),
];
test("acceptance loader refuses before opening an index without a V4 product freeze", () => {
	expect(() => loadScenarios("does-not-exist", "acceptance")).toThrow("V4 product freeze required");
});
test.each(scenarios)(
	"$id preparation replays exact prose through the pinned SDK and actual Story tools, with no paid model",
	async (scenario) => {
		const work = process.env.PI_STORY_WORK_DIR;
		if (!work) throw new Error("Project workspace required");
		mkdirSync(path.join(work, "temp"), { recursive: true });
		const root = mkdtempSync(path.join(work, "temp/p3-prepare-"));
		const queue = new ReplyQueue();
		const f = await createMeasuredSession({
			work: path.join(root, "work"),
			archive: path.join(root, "archive"),
			suiteId: "P3-UNIT",
			runId: scenario.id,
			caseId: scenario.id,
			ledger: new UsageLedger(path.join(root, "fees.jsonl"), path.join(root, "reserves.jsonl")),
			control: new RunControl(),
			runLimitUsd: 2,
			main: "faux",
			internals: "faux",
			maxShowrunnerRequests: 30,
			reply: (context) => queue.next(context),
		});
		const fetchBefore = globalThis.fetch;
		globalThis.fetch = async () => {
			throw new Error("Preparation must never use HTTP");
		};
		try {
			await f.session.bindExtensions({
				mode: "print",
				onError: () => {
					throw new Error("Extension error");
				},
			});
			await prepareScenario(f, scenario, queue);
			if (scenario.execution.usageSnapshot) {
				await seedUsageSnapshot(f, scenario.execution.usageSnapshot);
				const context = JSON.stringify(f.manager.buildSessionContext().messages);
				expect(context).toContain("knownUsd");
				expect(context).toContain("unknownReservationsUsd");
				expect(context).toContain("0.031");
				expect(context).toContain("0.007");
				expect(f.story.current()?.services.guard.summary().estimatedCostUsd).toBeCloseTo(0.038);
			}
			const model = f.story.current()?.source.model();
			const expectedTexts = scenario.setup.flatMap((step) => (step.step === "commitChapters" ? step.texts : []));
			expect(model?.commits.map((commit) => commit.text)).toEqual(expectedTexts);
			if (scenario.category.startsWith("L")) expect(model?.failures[(model.lastChapter ?? 0) + 1]).toBe(2);
			expect(f.finish().fee.requests).toBe(0);
		} finally {
			globalThis.fetch = fetchBefore;
			f.dispose();
		}
	},
	30_000,
);
