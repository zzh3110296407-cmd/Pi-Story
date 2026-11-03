import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { readEvidence } from "../../../scripts/eval/p2/artifacts.ts";
import { deterministicEnvironment } from "../../../scripts/eval/p3/program.ts";
import type { BookCaseConfig } from "../../../scripts/eval/p3r2/book-case.ts";
import { readBookInterruption, superviseBookCase } from "../../../scripts/eval/p3r2/book-process.ts";
import { p3Chapter, p3Opening } from "./p3-fixture.ts";

function fixture(): BookCaseConfig {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("Project workspace required");
	const root = mkdtempSync(path.join(work, "temp/p3r2-book-process-"));
	return {
		schema: "story/p3r2-book-case@1",
		folder: path.join(root, "run"),
		prompt: "Ada must survive.",
		maximumTarget: 1,
		exactTarget: 1,
		settleTimeoutMs: 30_000,
		worker: {
			schema: "story/p3-rpc-worker@2",
			work: path.join(root, "work"),
			archive: path.join(root, "run/book"),
			runId: "faux-v5-book",
			caseId: "one",
			main: "faux",
			writerLengthFactor: 0.9,
			runLimitUsd: 2,
			ledgerFile: path.join(root, "fees.jsonl"),
			reservationsFile: path.join(root, "reserves.jsonl"),
			localReplies: [
				fauxAssistantMessage([...p3Opening(1), fauxToolCall("write_next_chapter", {})], { stopReason: "toolUse" }),
				...p3Chapter().slice(1),
			],
		},
	};
}

test("V5 BOOK runs in its own case and RPC processes and durably records successful exit and zero synthetic fees", async () => {
	const config = fixture();
	const result = await superviseBookCase(config, {
		env: deterministicEnvironment(process.env, process.env.PI_STORY_WORK_DIR ?? config.worker.work),
	});
	expect(result.code).toBe(0);
	expect(result.caseExit).toMatchObject({
		status: "completed",
		target: 1,
		lastChapter: 1,
		bookCompleted: true,
		cancelled: false,
	});
	const start = JSON.parse(readFileSync(path.join(config.folder, "supervisor-start.json"), "utf8"));
	expect(start.parentPid).not.toBe(process.pid);
	const exit = JSON.parse(readFileSync(path.join(config.folder, "case-exit.json"), "utf8"));
	expect(exit.rpcPid).not.toBe(start.parentPid);
	expect(() => process.kill(exit.rpcPid, 0)).toThrow();
	expect(existsSync(path.join(config.folder, "process-exit.json"))).toBe(true);
	expect(readFileSync(path.join(config.folder, "case-lifecycle.jsonl"), "utf8")).toContain('"type":"rpc_started"');
	expect(readFileSync(path.join(config.folder, "case-lifecycle.jsonl"), "utf8")).toContain('"type":"heartbeat"');
	expect(readBookInterruption(config.folder, 0)).toMatchObject({ classification: "completed", restart: false });
	expect(readEvidence(config.worker.archive).find((row) => row.type === "meta")).toMatchObject({
		stage: "P3R2",
		suiteId: "P3R2-BOOK",
	});
	expect(JSON.parse(readFileSync(path.join(config.worker.archive, "finalization.json"), "utf8")).fee.requests).toBe(0);
}, 60_000);

test("V5 author cancellation is recorded before RPC abort and cannot be mistaken for external interruption", async () => {
	const config = fixture();
	const abort = new AbortController();
	const result = await superviseBookCase(config, {
		env: deterministicEnvironment(process.env, process.env.PI_STORY_WORK_DIR ?? config.worker.work),
		signal: abort.signal,
		onRpcStarted: () => abort.abort(),
	});
	expect(result.caseExit).toMatchObject({ status: "cancelled", cancelled: true, productError: false });
	expect(existsSync(path.join(config.folder, "cancel-requested.json"))).toBe(true);
	expect(readFileSync(path.join(config.folder, "case-lifecycle.jsonl"), "utf8")).toContain(
		'"type":"author_cancel_requested"',
	);
	expect(readBookInterruption(config.folder, 0)).toMatchObject({ classification: "product_failure", restart: false });
}, 60_000);

test("V5 external interruption is proven from the two owned processes, and only the first interruption permits a restart", async () => {
	const config = fixture();
	const result = await superviseBookCase(config, {
		env: deterministicEnvironment(process.env, process.env.PI_STORY_WORK_DIR ?? config.worker.work),
		onRpcStarted: (rpcPid, parentPid) => {
			if (!parentPid || parentPid === process.pid || rpcPid === process.pid)
				throw new Error("Owned isolated process IDs required");
			process.kill(parentPid);
			try {
				process.kill(rpcPid);
			} catch (cause) {
				if (!cause || typeof cause !== "object" || !("code" in cause) || cause.code !== "ESRCH") throw cause;
			}
		},
	});
	expect(result.caseExit).toBeNull();
	expect(readBookInterruption(config.folder, 0)).toMatchObject({
		classification: "external_interruption",
		restart: true,
		qualityIncluded: false,
	});
	expect(readBookInterruption(config.folder, 1)).toMatchObject({
		classification: "external_interruption",
		restart: false,
		repeatedInterruptionIsMissing: true,
	});
}, 60_000);
