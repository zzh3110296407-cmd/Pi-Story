import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { RunControl } from "../../../scripts/eval/p2/run-control.ts";
import { caseAllowanceUsd, caseWorkspace } from "../../../scripts/eval/p3/main.ts";
import {
	measuredToolResults,
	scoreAllRealArchives,
	scoreBookArchives,
	scoreNativeInputs,
} from "../../../scripts/eval/p3/metrics.ts";
import { stopAfterOpening } from "../../../scripts/eval/p3/open.ts";
import { createMeasuredSession } from "../../../scripts/eval/p3/session.ts";
import { draftText, keeperReply } from "./fixture.ts";
import { p3Opening } from "./p3-fixture.ts";

test.each([false, true])(
	"P3 native HTTP archive and measured opening boundary (stop=%s)",
	async (openingOnly) => {
		const work = process.env.PI_STORY_WORK_DIR;
		if (!work) throw new Error("Project workspace required");
		mkdirSync(path.join(work, "temp"), { recursive: true });
		const root = mkdtempSync(path.join(work, "temp/p3-metrics-"));
		const archive = path.join(root, "archive");
		const runId = `private-run-dev-${path.basename(root)}`;
		const caseId = "ds11-private-case-label";
		let f: Awaited<ReturnType<typeof createMeasuredSession>>;
		f = await createMeasuredSession({
			work: caseWorkspace(runId, caseId),
			archive,
			suiteId: "P3-BOOK",
			runId,
			caseId,
			ledger: new UsageLedger(path.join(root, "fees.jsonl"), path.join(root, "reserves.jsonl")),
			control: new RunControl(),
			runLimitUsd: caseAllowanceUsd.SCEN,
			main: "real",
			internals: "real",
			preparation: false,
			maxShowrunnerRequests: 20,
			reply: () => {
				throw new Error("No faux call expected");
			},
			extension: openingOnly ? (pi) => stopAfterOpening(pi, (row) => f.emit(row)) : undefined,
		});
		const oldFetch = globalThis.fetch;
		let mainRequests = 0;
		let pathLabelLeaked = false;
		globalThis.fetch = async (url, init) => {
			if (!String(url).includes("no-network.test")) throw new Error("Offline regression cannot use network");
			const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
			pathLabelLeaked ||= JSON.stringify(body).includes(caseId) || JSON.stringify(body).includes(runId);
			const system = body.messages
				.filter((message) => message.role === "system")
				.map((message) => message.content)
				.join("\n");
			let delta: unknown;
			let finish = "stop";
			if (system.includes("name: story-long-writing\n")) delta = { content: draftText };
			else if (system.includes("name: story-review-matrix\n")) delta = { content: '{"observations":[]}' };
			else if (system.includes("name: story-state-projection\n")) delta = { content: JSON.stringify(keeperReply) };
			else {
				mainRequests++;
				const calls =
					mainRequests === 1
						? [...p3Opening(), fauxToolCall("write_next_chapter", {})]
						: mainRequests < 4
							? [fauxToolCall("write_next_chapter", {})]
							: [];
				delta = calls.length
					? {
							tool_calls: calls.map((call, index) => ({
								index,
								id: call.id,
								type: "function",
								function: { name: call.name, arguments: JSON.stringify(call.arguments) },
							})),
						}
					: { content: "Completed all three chapters." };
				if (calls.length) finish = "tool_calls";
			}
			return new Response(
				`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		};
		try {
			f.runtime.registerProvider("deepseek", { apiKey: "fixture-local", baseUrl: "https://no-network.test" });
			const model = f.runtime.getModel("deepseek", "deepseek-flash");
			if (!model) throw new Error("Frozen model unavailable");
			await f.session.setModel(model);
			await f.session.bindExtensions({
				mode: "print",
				onError: () => {
					throw new Error("Extension error");
				},
			});
			if (!openingOnly)
				f.session.subscribe(async (event) => {
					if (
						event.type === "message_end" &&
						event.message.role === "toolResult" &&
						event.message.toolName === "submit_outline"
					)
						await f.session.prompt("/goal 3");
				});
			await f.session.prompt("Ada must survive.");
			expect(pathLabelLeaked, "SDK payload must not expose scenario/run labels through cwd").toBe(false);
			if (openingOnly) {
				expect(f.story.current()?.source.model().lastChapter).toBe(0);
				expect(f.story.current()?.source.model().outline).toHaveLength(3);
				expect(mainRequests).toBe(1);
				f.finish();
				expect(measuredToolResults(archive).tools.map((message) => message.toolName)).toEqual([
					"submit_constraints",
					"submit_bible",
					"submit_outline",
				]);
				return;
			}
			expect(f.story.current()?.source.model().lastChapter).toBe(3);
			const final = f.finish();
			expect(final.fee.requests).toBe(13);
			writeFileSync(
				path.join(archive, "result.json"),
				JSON.stringify({
					runId,
					target: 3,
					askedAuthor: false,
					extraAuthorPrompts: 0,
					stopMessages: ["goal_reached"],
					fees: final.fee,
				}),
			);
			const score = scoreBookArchives([archive]);
			expect(score.rows[0].chapters.map((chapter) => chapter.requests)).toEqual([1, 1, 1]);
			for (const id of ["H12", "C04", "C02", "H09", "C05"])
				expect(
					score.regression.find((metric) => metric.id === id),
					id,
				).toMatchObject({ passed: true });
			expect(score.regression.find((metric) => metric.id === "W01")).toMatchObject({ n: 3 });
			const combined = scoreAllRealArchives([archive]);
			expect(combined.nativeInputAudit).toMatchObject({ dispatched: 4, under: 0, unclassified: 0 });
			expect(combined.metrics.every((metric) => metric.passed === true)).toBe(true);
		} finally {
			globalThis.fetch = oldFetch;
			f.dispose();
		}
	},
	30_000,
);

test("native input audit includes retries, retains unknown classification and rejects underestimated inputs", () => {
	const requests = ["first", "retry", "unknown"].map((requestId) => ({
		type: "request",
		requestId,
		role: "showrunner",
		inputTokensEstimate: 100,
		maxTokens: 100,
		contextWindow: 1000,
	}));
	const records = [
		...requests,
		...requests.map(({ requestId }) => ({ type: "dispatch", requestId })),
		{ type: "response", requestId: "first", usageKnown: false, classification: "interrupted" },
		{
			type: "response",
			requestId: "retry",
			usageKnown: true,
			response: { usage: { input: 30, cacheRead: 80, cacheWrite: 0 } },
		},
		{ type: "request", requestId: "not-dispatched", role: "showrunner" },
	];
	expect(scoreNativeInputs(records)).toMatchObject({ dispatched: 3, under: 1, unknown: 2, unclassified: 1 });
});
