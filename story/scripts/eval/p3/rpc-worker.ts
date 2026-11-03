import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { runRpcMode } from "@earendil-works/pi-coding-agent";
import { writeNextChapter } from "../../../packages/core/src/flow/next.ts";
import { UsageLedger } from "../p2/ledger.ts";
import { RunControl } from "../p2/run-control.ts";
import { readPausedMacro, replayPausedCalls } from "../p3r2/pause.ts";
import { createMeasuredSession, type MeasuredSession } from "./session.ts";

export interface WorkerConfig {
	schema: "story/p3-rpc-worker@1" | "story/p3-rpc-worker@2";
	writerLengthFactor?: 0.8 | 0.9;
	runLimitUsd?: number;
	work: string;
	archive: string;
	runId: string;
	caseId: string;
	ledgerFile: string;
	reservationsFile: string;
	main: "real" | "faux";
	// Local-only constructor regression. Paid runs cannot provide fixture replies.
	localReplies?: AssistantMessage[];
	pauseProofFile?: string;
}
async function main() {
	const file = process.env.PI_STORY_P3_WORKER_CONFIG;
	if (!file) throw new Error("P3 worker configuration required");
	const config = JSON.parse(readFileSync(file, "utf8")) as WorkerConfig;
	if (
		!["story/p3-rpc-worker@1", "story/p3-rpc-worker@2"].includes(config.schema) ||
		!["real", "faux"].includes(config.main) ||
		(config.main === "real" && config.localReplies)
	)
		throw new Error("Invalid P3 worker configuration");
	const v5 = config.schema === "story/p3-rpc-worker@2";
	if (
		v5 &&
		(![0.8, 0.9].includes(config.writerLengthFactor ?? 0) ||
			!Number.isFinite(config.runLimitUsd) ||
			(config.runLimitUsd ?? 0) <= 0 ||
			(config.runLimitUsd ?? 0) > 2)
	)
		throw new Error("V5 worker requires an explicit calibration and remaining per-book allowance");
	let f: MeasuredSession | undefined;
	const control = new RunControl();
	const replies = [...(config.localReplies ?? [])];
	if (config.pauseProofFile && !v5) throw new Error("Only V5 BOOK may resume a paused measurement");
	const paused = config.pauseProofFile ? readPausedMacro(config.pauseProofFile, config.archive) : undefined;
	f = await createMeasuredSession({
		...(v5 ? { stage: "P3R2", writerLengthFactor: config.writerLengthFactor } : {}),
		work: config.work,
		archive: config.archive,
		suiteId: v5 ? "P3R2-BOOK" : "P3-BOOK",
		runId: config.runId,
		caseId: config.caseId,
		ledger: new UsageLedger(
			config.ledgerFile,
			config.reservationsFile,
			v5 ? { stopUsd: 6.5, maximumUsd: 7.5 } : { stopUsd: 12, maximumUsd: 15 },
		),
		control,
		runLimitUsd: v5 ? (config.runLimitUsd ?? 2) : 2,
		main: config.main,
		internals: config.main,
		maxShowrunnerRequests: 200,
		preparation: false,
		...(paused ? { resume: paused.proof } : {}),
		reply: () => {
			const reply = replies.shift();
			if (!reply) throw new Error("Unexpected local worker request");
			return reply;
		},
		extension: (pi, story) => {
			if (paused)
				pi.registerCommand("__p3_resume_paused", {
					description: "Continue the original interrupted native tool call",
					handler: async (_text, ctx) => {
						if (!f) throw new Error("P3 worker not initialized");
						const state = story.get(ctx);
						if (state.source.model().policy.targetChapter !== paused.proof.target)
							throw new Error("Saved goal differs");
						if (
							paused.proof.completedBefore !== undefined &&
							state.source.model().lastChapter !== paused.proof.completedBefore
						)
							throw new Error("Previously committed chapter count changed");
						const controller = new AbortController();
						const replay = replayPausedCalls(
							state.services.ports,
							paused,
							controller,
							(index, recoveredReservationId) =>
								f?.emit({
									type: "role_output_reused",
									toolCallId: paused.proof.pendingToolCallId,
									role: paused.completed[index].request.role,
									originalReservationId: paused.settled[index].id,
									recoveredReservationId,
								}),
						);
						state.gate.writing = true;
						try {
							const result = await story.write(
								"write_next_chapter",
								paused.proof.pendingToolCallId,
								ctx,
								controller.signal,
								(command) => writeNextChapter(command, paused.args),
							);
							replay.assertReplayed();
							f.appendRecoveredResult({
								role: "toolResult",
								toolCallId: paused.proof.pendingToolCallId,
								toolName: "write_next_chapter",
								...result,
								timestamp: Date.now(),
							});
						} finally {
							replay.restore();
							state.gate.writing = false;
						}
						await f.session.agent.continue();
					},
				});
			pi.registerCommand("__p3_finish", {
				description: "Finalize measurement evidence",
				handler: async () => {
					if (!f) throw new Error("P3 worker not initialized");
					writeFileSync(
						path.join(config.archive, "finalization.json"),
						`${JSON.stringify({ ...f.finish(), fatal: control.fatal ?? null }, null, 2)}\n`,
						{
							flag: "wx",
						},
					);
				},
			});
		},
	});
	await runRpcMode(f.host);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
