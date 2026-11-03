import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { foldBranch } from "../../../packages/core/src/fold/index.ts";
import { translateBranch } from "../../../packages/pi-story/src/entries.ts";
import { publicEvidence } from "../p2/artifacts.ts";
import { driveBook } from "../p3/book.ts";
import { P3RpcClient } from "../p3/rpc.ts";
import type { WorkerConfig } from "../p3/rpc-worker.ts";

export interface BookCaseConfig {
	schema: "story/p3r2-book-case@1";
	folder: string;
	worker: WorkerConfig;
	prompt: string;
	maximumTarget: number;
	exactTarget?: number;
	settleTimeoutMs?: number;
	resumeTarget?: number;
}
export async function runBookCase(config: BookCaseConfig) {
	if (config.schema !== "story/p3r2-book-case@1" || config.worker.schema !== "story/p3-rpc-worker@2")
		throw new Error("V5 book configuration required");
	if (
		config.resumeTarget !== undefined &&
		(!config.worker.pauseProofFile ||
			!Number.isSafeInteger(config.resumeTarget) ||
			config.resumeTarget < 1 ||
			config.resumeTarget > 10)
	)
		throw new Error("Paused BOOK needs its proved saved goal");
	mkdirSync(config.folder, { recursive: true });
	mkdirSync(config.worker.work, { recursive: true });
	const record = (row: Record<string, unknown>) => {
		const text = JSON.stringify({ time: new Date().toISOString(), parentPid: process.pid, ...row });
		publicEvidence(text);
		appendFileSync(path.join(config.folder, "case-lifecycle.jsonl"), `${text}\n`);
	};
	record({ type: "case_started", supervisorPid: process.ppid });
	const workerFile = config.resumeTarget
		? path.join(config.folder, "worker-resumed.json")
		: path.join(config.worker.work, "worker.json");
	const workerText = JSON.stringify(config.worker);
	publicEvidence(workerText);
	writeFileSync(workerFile, workerText, { flag: "wx" });
	let resumedAskedAuthor = false;
	let resumeCommandError: string | undefined;
	const client = new P3RpcClient({
		cli: path.resolve(import.meta.dirname, "../p3/rpc-worker.ts"),
		cwd: config.worker.work,
		env: { ...process.env, PI_STORY_P3_WORKER_CONFIG: workerFile },
		...(config.resumeTarget ? { commandTimeoutMs: config.settleTimeoutMs ?? 120 * 60_000 } : {}),
		settleTimeoutMs: config.settleTimeoutMs ?? 45 * 60_000,
		onWire: (direction, frame) => {
			if (
				direction === "out" &&
				frame.type === "extension_error" &&
				frame.extensionPath === "command:__p3_resume_paused"
			)
				resumeCommandError = String(frame.error);
			if (
				direction === "out" &&
				frame.type === "extension_ui_request" &&
				["select", "confirm", "input", "editor"].includes(String(frame.method))
			)
				resumedAskedAuthor = true;
			const text = JSON.stringify({ direction, frame });
			publicEvidence(text);
			appendFileSync(path.join(config.worker.work, "rpc.jsonl"), `${text}\n`);
		},
	});
	record({ type: "rpc_started", rpcPid: client.processId });
	record({ type: "heartbeat", rpcPid: client.processId });
	let cancelled = false;
	const cancel = async (message: unknown) => {
		if (!message || typeof message !== "object" || !("type" in message) || message.type !== "cancel") return;
		cancelled = true;
		record({ type: "author_cancel_requested", rpcPid: client.processId });
		try {
			await client.request({ type: "abort" });
		} catch {
			record({ type: "cancel_delivery_failed", diagnostic: "RPC abort was unavailable; closing the owned RPC child" });
			await client.close();
		}
	};
	process.on("message", cancel);
	process.send?.({ type: "rpc_started", rpcPid: client.processId });
	const heartbeat = setInterval(() => record({ type: "heartbeat", rpcPid: client.processId }), 30_000);
	heartbeat.unref();
	let exit: { status: string; productError: boolean; timedOut: boolean; cancelled: boolean; [key: string]: unknown } = {
		status: "failed",
		productError: true,
		timedOut: false,
		cancelled: false,
	};
	try {
		await client.request({ type: "get_state" });
		if (cancelled) throw new Error("Author cancelled before book generation");
		const book = config.resumeTarget
			? await (async () => {
					record({ type: "outline_plan", target: config.resumeTarget, source: "saved_author_goal" });
					await client.promptAndWait("/__p3_resume_paused");
					if (resumeCommandError) throw new Error(resumeCommandError);
					const response = await client.request({ type: "get_entries" });
					const data = response.data as { entries?: SessionEntry[] } | undefined;
					if (!data?.entries) throw new Error("Resumed native session missing");
					const model = foldBranch(translateBranch(data.entries));
					if (model.policy.targetChapter !== config.resumeTarget) throw new Error("Resumed BOOK goal changed");
					return {
						entries: data.entries,
						target: config.resumeTarget,
						lastChapter: model.lastChapter,
						askedAuthor: resumedAskedAuthor,
						completed: model.lastChapter === config.resumeTarget && !resumedAskedAuthor,
						stopMessages: data.entries.flatMap((entry) =>
							entry.type === "custom_message" && entry.customType === "story.stop" ? [entry.content] : [],
						),
						extraAuthorPrompts: 0,
					};
				})()
			: await driveBook(
					client,
					config.prompt,
					() => {},
					config.maximumTarget,
					config.exactTarget,
					(target) => record({ type: "outline_plan", target }),
				);
		await client.promptAndWait("/__p3_finish");
		const finalized = JSON.parse(readFileSync(path.join(config.worker.archive, "finalization.json"), "utf8")) as {
			fee: unknown;
			fatal?: { httpStatus: number };
		};
		const { entries: _entries, ...result } = book;
		const text = `${JSON.stringify({ ...result, runId: config.worker.runId, caseId: config.worker.caseId, scoringVersion: "p3r2-32@1", fees: finalized.fee, fatal: finalized.fatal ?? null }, null, 2)}\n`;
		publicEvidence(text);
		writeFileSync(path.join(config.worker.archive, "result.json"), text, { flag: "wx" });
		exit = {
			status: cancelled ? "cancelled" : "completed",
			productError: false,
			timedOut: false,
			cancelled,
			target: book.target,
			lastChapter: book.lastChapter,
			bookCompleted: book.completed,
			fatal: finalized.fatal ?? null,
		};
	} catch (cause) {
		let diagnostic = cause instanceof Error ? cause.message : "Unknown book execution failure";
		try {
			publicEvidence(diagnostic);
		} catch {
			diagnostic = "Sensitive diagnostic omitted";
		}
		exit = {
			status: cancelled ? "cancelled" : "failed",
			productError: !cancelled,
			timedOut: /timed out|did not settle/iu.test(diagnostic),
			cancelled,
			diagnostic,
		};
		// Finalization is a local command, never a replacement model request.
		// Keep a failed book failed while preserving its native evidence if RPC
		// remains available; a dead process is handled by the supervisor policy.
		if (!existsSync(path.join(config.worker.archive, "finalization.json"))) {
			try {
				await client.promptAndWait("/__p3_finish");
				record({ type: "failed_book_evidence_finalized" });
			} catch {
				record({ type: "failed_book_finalization_unavailable", evidenceRetainedIn: config.worker.work });
			}
		}
	} finally {
		clearInterval(heartbeat);
		process.removeListener("message", cancel);
		await client.close();
		writeFileSync(
			path.join(config.folder, "case-exit.json"),
			`${JSON.stringify({ ...exit, parentPid: process.pid, rpcPid: client.processId, time: new Date().toISOString() }, null, 2)}\n`,
			{ flag: "wx" },
		);
	}
	return exit;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const file = process.argv[2];
	if (!file) throw new Error("Book case configuration required");
	const exit = await runBookCase(JSON.parse(readFileSync(file, "utf8")) as BookCaseConfig);
	if (exit.status !== "completed") process.exitCode = 1;
	if (process.connected) process.disconnect?.();
}
