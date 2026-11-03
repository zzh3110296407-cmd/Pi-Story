import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { EvidenceArchive, readEvidence, sha256 } from "../../../scripts/eval/p2/artifacts.ts";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { RunControl } from "../../../scripts/eval/p2/run-control.ts";
import { deterministicEnvironment } from "../../../scripts/eval/p3/program.ts";
import { createMeasuredSession } from "../../../scripts/eval/p3/session.ts";
import { superviseBookCase } from "../../../scripts/eval/p3r2/book-process.ts";
import { readPausedMacro } from "../../../scripts/eval/p3r2/pause.ts";
import { p3Chapter, p3Opening } from "./p3-fixture.ts";

function temporary() {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("Project execution workspace required");
	mkdirSync(path.join(work, "temp"), { recursive: true });
	return mkdtempSync(path.join(work, "temp/p3r2-pause-"));
}

test("unfinished evidence resumes by digest and keeps its original bytes; finalized evidence is immutable", () => {
	const root = temporary();
	const meta = { suiteId: "P3R2-BOOK", runId: "paused", expectedCaseIds: ["one"], stage: "P3R2" };
	const original = new EvidenceArchive(path.join(root, "archive"), path.join(root, "work"), meta);
	original.emit({ type: "saved_output", text: "Previously paid output." });
	const before = readFileSync(original.workFile);
	expect(
		() => new EvidenceArchive(original.folder, path.dirname(original.workFile), meta, { evidenceSha256: "wrong" }),
	).toThrow("digest");
	const resumed = new EvidenceArchive(original.folder, path.dirname(original.workFile), meta, {
		evidenceSha256: sha256(before),
	});
	resumed.emit({ type: "next_output", text: "Continuation." });
	expect(readFileSync(original.workFile).subarray(0, before.length)).toEqual(before);
	resumed.finish();
	expect(readEvidence(original.folder).filter((row) => row.type === "saved_output")).toHaveLength(1);
	expect(
		() =>
			new EvidenceArchive(original.folder, path.dirname(original.workFile), meta, {
				evidenceSha256: sha256(readFileSync(original.workFile)),
			}),
	).toThrow("Finalized");
});

async function savedPausedFixture(chapters = 1) {
	const root = temporary();
	const work = path.join(root, "work");
	const archive = path.join(root, "original/book");
	const ledgerFile = path.join(root, "fees.jsonl");
	const reservationsFile = path.join(root, "reserves.jsonl");
	const replies = [
		fauxAssistantMessage(p3Opening(chapters), { stopReason: "toolUse" }),
		fauxAssistantMessage("Opened."),
		...Array.from({ length: chapters }, () => p3Chapter()).flat(),
	];
	const f = await createMeasuredSession({
		stage: "P3R2",
		writerLengthFactor: 0.9,
		work,
		archive,
		suiteId: "P3R2-BOOK",
		runId: "faux-paused-book",
		caseId: "one",
		ledger: new UsageLedger(ledgerFile, reservationsFile, { stopUsd: 6.5, maximumUsd: 7.5 }),
		control: new RunControl(),
		runLimitUsd: 2,
		main: "faux",
		internals: "faux",
		maxShowrunnerRequests: 200,
		preparation: false,
		reply: () => {
			const reply = replies.shift();
			if (!reply) throw new Error("Unexpected fixture model request");
			return reply;
		},
	});
	try {
		await f.session.bindExtensions({});
		await f.session.prompt("Ada must survive.");
		await f.session.prompt(`/goal ${chapters}`);
		await f.session.prompt("Write toward the saved goal.");
	} finally {
		f.dispose();
	}
	const sessionFile = f.manager.getSessionFile();
	if (!sessionFile) throw new Error("Native fixture session missing");
	const native = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
	const pendingIndex = native.findLastIndex((line) => {
		const entry = JSON.parse(line);
		return (
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part: { type: string; name?: string }) => part.type === "toolCall" && part.name === "write_next_chapter",
			)
		);
	});
	if (pendingIndex < 0) throw new Error("Fixture macro missing");
	const callId = JSON.parse(native[pendingIndex]).message.content.find(
		(part: { type: string }) => part.type === "toolCall",
	).id;
	writeFileSync(sessionFile, `${native.slice(0, pendingIndex + 1).join("\n")}\n`);
	const rows = readFileSync(path.join(work, "evidence.jsonl"), "utf8").trimEnd().split("\n");
	const pausedIndex = rows.findIndex((line) => {
		const row = JSON.parse(line);
		if (row.type !== "role_checkpoint" || row.phase !== "started" || row.toolCallId !== callId) return false;
		const full = JSON.parse(gunzipSync(readFileSync(path.join(archive, "raw", row.rawFile))).toString("utf8"));
		return full.request.role === "keeper";
	});
	if (pausedIndex < 0) throw new Error("Fixture keeper boundary missing");
	writeFileSync(path.join(work, "evidence.jsonl"), `${rows.slice(0, pausedIndex + 1).join("\n")}\n`);
	const proofFile = path.join(root, "pause-proof.json");
	writeFileSync(
		proofFile,
		JSON.stringify({
			schema: "story/p3r2-paused-book@1",
			sessionFile,
			sessionSha256: sha256(readFileSync(sessionFile)),
			evidenceFile: path.join(work, "evidence.jsonl"),
			evidenceSha256: sha256(readFileSync(path.join(work, "evidence.jsonl"))),
			pendingToolCallId: callId,
			target: chapters,
			completedBefore: chapters - 1,
			runId: "faux-paused-book",
		}),
	);
	return { root, work, archive, sessionFile, proofFile, callId, ledgerFile, reservationsFile };
}

test.each([1, 2])(
	"paused BOOK completes its original native macro at chapter %i, preserving prior chapters and reusing outputs once",
	async (chapters) => {
		const f = await savedPausedFixture(chapters);
		const ledger = new UsageLedger(f.ledgerFile, f.reservationsFile, { stopUsd: 6.5, maximumUsd: 7.5 });
		ledger.reserve({
			suiteId: "P3R2-BOOK",
			runId: "faux-paused-book",
			role: "keeper",
			model: "deepseek/deepseek-flash",
			reservedCostUsd: 0.01,
			reservedInputTokens: 10,
			reservedOutputTokens: 10,
			runLimitUsd: 2,
		});
		const pendingFees = ledger.snapshot();
		const priorSession = readFileSync(f.sessionFile);
		const oldWorkerFile = path.join(f.work, "worker.json");
		const oldWorkerBytes = JSON.stringify({
			schema: "story/p3-rpc-worker@2",
			runId: "faux-paused-book",
			original: true,
		});
		writeFileSync(oldWorkerFile, oldWorkerBytes);
		const saved = readPausedMacro(f.proofFile, f.archive);
		expect(saved.completed.map((call) => call.request.role)).toEqual(["writer", "editor"]);
		const outcome = await superviseBookCase(
			{
				schema: "story/p3r2-book-case@1",
				folder: path.join(f.root, "resumed"),
				prompt: "This must never become another author prompt.",
				maximumTarget: chapters,
				resumeTarget: chapters,
				settleTimeoutMs: 20_000,
				worker: {
					schema: "story/p3-rpc-worker@2",
					work: f.work,
					archive: f.archive,
					runId: "faux-paused-book",
					caseId: "one",
					main: "faux",
					writerLengthFactor: 0.9,
					runLimitUsd: 2,
					ledgerFile: f.ledgerFile,
					reservationsFile: f.reservationsFile,
					pauseProofFile: f.proofFile,
					localReplies: p3Chapter().slice(3),
				},
			},
			{ env: deterministicEnvironment(process.env, process.env.PI_STORY_WORK_DIR ?? f.work) },
		);
		expect(outcome.caseExit).toMatchObject({
			status: "completed",
			target: chapters,
			lastChapter: chapters,
			bookCompleted: true,
			cancelled: false,
		});
		expect(readFileSync(f.sessionFile).subarray(0, priorSession.length)).toEqual(priorSession);
		expect(readFileSync(oldWorkerFile, "utf8")).toBe(oldWorkerBytes);
		const records = readEvidence(f.archive, true);
		expect(records.filter((row) => row.type === "role_output_reused")).toHaveLength(2);
		for (const role of ["writer", "editor", "keeper"])
			expect(
				records.filter(
					(row) =>
						row.type === "role_call" &&
						row.request &&
						typeof row.request === "object" &&
						"role" in row.request &&
						row.request.role === role,
				),
			).toHaveLength(chapters);
		const entries = SessionManager.open(f.sessionFile).getBranch();
		expect(
			entries.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === f.callId,
			),
		).toHaveLength(1);
		expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(2);
		expect(records.filter((row) => row.type === "chapter_result")).toHaveLength(chapters);
		expect(ledger.snapshot()).toEqual(pendingFees);
		expect(JSON.parse(readFileSync(path.join(f.archive, "finalization.json"), "utf8")).fee).toMatchObject({
			reservedUsd: 0.01,
			unknownCalls: 1,
		});
		expect(() => readPausedMacro(f.proofFile, f.archive)).toThrow();
	},
	60_000,
);

test("changed paused bytes are rejected before a resumed worker can issue any model request", async () => {
	const f = await savedPausedFixture();
	writeFileSync(f.sessionFile, `${readFileSync(f.sessionFile, "utf8")}\n`);
	expect(() => readPausedMacro(f.proofFile, f.archive)).toThrow("differ");
}, 60_000);

test("an uninitialized faux measurement cannot fall through to a real role provider", async () => {
	const root = temporary();
	const replies = [
		fauxAssistantMessage([...p3Opening(1), fauxToolCall("write_next_chapter", {})], { stopReason: "toolUse" }),
	];
	const f = await createMeasuredSession({
		stage: "P3R2",
		writerLengthFactor: 0.9,
		work: path.join(root, "work"),
		archive: path.join(root, "archive"),
		suiteId: "P3R2-BOOK",
		runId: "unbound-faux",
		caseId: "one",
		ledger: new UsageLedger(path.join(root, "fees.jsonl"), path.join(root, "reserves.jsonl")),
		control: new RunControl(),
		runLimitUsd: 2,
		main: "faux",
		internals: "faux",
		maxShowrunnerRequests: 5,
		preparation: false,
		reply: () => {
			const reply = replies.shift();
			if (!reply) throw new Error("No further fixture response");
			return reply;
		},
	});
	f.runtime.registerProvider("deepseek", { apiKey: "fixture-local", baseUrl: "https://no-network.test" });
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		throw new Error("Real network forbidden");
	});
	try {
		// Deliberately omit bindExtensions: this is the original setup defect.
		await f.session.prompt("Ada must survive.");
		expect(fetch).not.toHaveBeenCalled();
		expect(
			f.manager
				.getBranch()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolName === "write_next_chapter" &&
						entry.message.isError,
				),
		).toBe(true);
	} finally {
		f.dispose();
		fetch.mockRestore();
	}
}, 30_000);
