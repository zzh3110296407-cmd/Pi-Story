import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test, vi } from "vitest";
import { EvidenceArchive, readEvidence, sha256 } from "../../../scripts/eval/p2/artifacts.ts";
import { runBooks } from "../../../scripts/eval/p3r2/books.ts";
import { assertBookBatchOpen, readBookClosure, sealInterruptedEvidence } from "../../../scripts/eval/p3r2/closure.ts";
import { completeAuthorizedBook } from "../../../scripts/eval/p3r2/complete-book.ts";

function temporary() {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("Project workspace required");
	mkdirSync(path.join(work, "temp"), { recursive: true });
	return mkdtempSync(path.join(work, "temp/p3r2-author-closure-"));
}

test("author closure blocks both normal BOOK and earlier authorized completion before any network", async () => {
	const folder = temporary();
	expect(readBookClosure(folder)).toBeUndefined();
	const closure = {
		schema: "story/p3r2-book-author-closure@1",
		authorApproved: true,
		stopFurtherBookDispatch: true,
		authorStatement: "1578和1769不跑了，有三本书就够了",
		completedBookIds: [837, 527, 42],
		stoppedBookIds: [1587, 1769],
		outcomes: [837, 527, 1587, 42, 1769].map((id) => ({
			id,
			target: 8,
			classification: "closed",
			qualityIncluded: true,
			missing: false,
			attempts: [{ runId: `old-${id}`, archive: folder, qualityIncluded: true }],
		})),
	};
	writeFileSync(path.join(folder, "book-closure.json"), JSON.stringify(closure));
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No HTTP allowed"));
	try {
		expect(() => assertBookBatchOpen(folder)).toThrow("closed by author");
		await expect(runBooks(false, folder)).rejects.toThrow("closed by author");
		await expect(completeAuthorizedBook(folder, 1587)).rejects.toThrow("closed by author");
		expect(fetch).not.toHaveBeenCalled();
		writeFileSync(path.join(folder, "book-closure.json"), JSON.stringify({ ...closure, authorApproved: false }));
		expect(() => readBookClosure(folder)).toThrow("Invalid author BOOK closure");
	} finally {
		fetch.mockRestore();
	}
});

test("offline sealing retains original journal and native bytes, classifies an unfinished checkpoint, and creates no result", () => {
	const root = temporary();
	const source = new EvidenceArchive(path.join(root, "source"), path.join(root, "work"), {
		suiteId: "P3R2-BOOK",
		runId: "old",
		expectedCaseIds: ["1587"],
		stage: "P3R2",
	});
	source.emit({
		type: "role_checkpoint",
		phase: "started",
		caseId: "1587",
		toolCallId: "pending",
		reservationId: "reserved",
		request: { role: "writer", user: "Saved input" },
		driverPhase: "measurement",
	});
	const sessionFile = path.join(root, "native.jsonl");
	const native = Buffer.from('{"type":"session","id":"original"}\n');
	writeFileSync(sessionFile, native);
	const before = readFileSync(source.workFile);
	const destination = path.join(root, "sealed");
	const saved = sealInterruptedEvidence({
		originalArchive: source.folder,
		evidenceFile: source.workFile,
		sessionFile,
		destination,
		reason: "measurement_timeout",
		interruptedAt: "2026-11-02T12:17:14.000Z",
	});
	expect(saved.pendingReservations).toEqual(["reserved"]);
	expect(readFileSync(source.workFile)).toEqual(before);
	expect(readFileSync(sessionFile)).toEqual(native);
	expect(existsSync(path.join(source.folder, "raw/checksums.json"))).toBe(false);
	expect(gunzipSync(readFileSync(path.join(destination, "raw/session.jsonl.gz")))).toEqual(native);
	const records = readEvidence(destination, true);
	expect(records.filter((row) => row.type === "role_checkpoint").map((row) => row.phase)).toEqual([
		"started",
		"interrupted",
	]);
	expect(records.at(-1)).toMatchObject({
		phase: "interrupted",
		classification: "interrupted",
		accounting: "reserved",
		offlineDerived: true,
	});
	expect(records.some((row) => row.type === "tool_result" || row.type === "chapter_result")).toBe(false);
	expect(existsSync(path.join(destination, "result.json"))).toBe(false);
	expect(saved.sourceEvidenceSha256).toBe(sha256(before));
	expect(() =>
		sealInterruptedEvidence({
			originalArchive: source.folder,
			evidenceFile: source.workFile,
			sessionFile,
			destination,
			reason: "measurement_timeout",
			interruptedAt: "2026-11-02T12:17:14.000Z",
		}),
	).toThrow("exists");
});
