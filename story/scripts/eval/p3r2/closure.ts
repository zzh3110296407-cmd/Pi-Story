import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { publicEvidence, sha256 } from "../p2/artifacts.ts";
import type { EvidenceRecord } from "../p2/metering.ts";
import { PRIMARY_BOOKS } from "./book-policy.ts";

export interface ClosedBookOutcome {
	id: number;
	target: number;
	classification: string;
	qualityIncluded: boolean;
	missing: boolean;
	attempts: { archive: string; runId: string; qualityIncluded: boolean; [key: string]: unknown }[];
	[key: string]: unknown;
}
export interface BookClosure {
	schema: "story/p3r2-book-author-closure@1";
	authorApproved: true;
	stopFurtherBookDispatch: true;
	authorStatement: string;
	completedBookIds: number[];
	stoppedBookIds: number[];
	outcomes: ClosedBookOutcome[];
	[key: string]: unknown;
}
export function readBookClosure(folder: string): BookClosure | undefined {
	const file = path.join(folder, "book-closure.json");
	if (!existsSync(file)) return undefined;
	const closure = JSON.parse(readFileSync(file, "utf8")) as BookClosure;
	if (
		closure.schema !== "story/p3r2-book-author-closure@1" ||
		closure.authorApproved !== true ||
		closure.stopFurtherBookDispatch !== true ||
		!closure.authorStatement?.trim() ||
		!Array.isArray(closure.completedBookIds) ||
		!Array.isArray(closure.stoppedBookIds) ||
		JSON.stringify([...closure.completedBookIds, ...closure.stoppedBookIds].sort((a, b) => a - b)) !==
			JSON.stringify([...PRIMARY_BOOKS].sort((a, b) => a - b)) ||
		!Array.isArray(closure.outcomes) ||
		closure.outcomes.length !== PRIMARY_BOOKS.length ||
		closure.outcomes.some(
			(outcome, index) =>
				outcome.id !== PRIMARY_BOOKS[index] ||
				!Number.isSafeInteger(outcome.target) ||
				outcome.target < 1 ||
				!Array.isArray(outcome.attempts) ||
				!outcome.attempts.length,
		)
	)
		throw new Error("Invalid author BOOK closure; dispatch remains blocked");
	return closure;
}
export function assertBookBatchOpen(folder: string): void {
	if (readBookClosure(folder)) throw new Error("BOOK batch closed by author; no further model dispatch or completion");
}

// Seal a new, explicitly derived archive. Never append a native tool result,
// settle a reservation, edit the original journal or restart the SDK session.
export function sealInterruptedEvidence(options: {
	originalArchive: string;
	evidenceFile: string;
	sessionFile: string;
	destination: string;
	reason: "measurement_timeout";
	interruptedAt: string;
}) {
	if (existsSync(options.destination)) throw new Error("Sealed destination already exists");
	if (existsSync(path.join(options.originalArchive, "raw/checksums.json")))
		throw new Error("Original archive already finalized");
	const observedAt = Date.parse(options.interruptedAt);
	if (!Number.isFinite(observedAt)) throw new Error("Recorded interruption time required");
	const source = readFileSync(options.evidenceFile);
	const session = readFileSync(options.sessionFile);
	publicEvidence(session.toString("utf8"));
	const records = source
		.toString("utf8")
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as EvidenceRecord);
	if (records[0]?.type !== "meta") throw new Error("Original measurement metadata missing");
	const pending = new Map<string, EvidenceRecord>();
	for (const record of records) {
		if (typeof record.rawFile !== "string") continue;
		const root = path.resolve(options.originalArchive, "raw");
		const file = path.resolve(root, record.rawFile);
		if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Checkpoint escapes source archive");
		const bytes = readFileSync(file);
		if (sha256(bytes) !== record.sha256) throw new Error("Original checkpoint digest differs");
		if (record.type !== "role_checkpoint") continue;
		const full = JSON.parse(gunzipSync(bytes).toString("utf8")) as EvidenceRecord;
		const key = JSON.stringify([full.caseId, full.toolCallId ?? "direct", full.reservationId]);
		if (full.phase === "started") pending.set(key, full);
		else pending.delete(key);
	}
	mkdirSync(path.join(options.destination, "raw"), { recursive: true });
	cpSync(path.join(options.originalArchive, "raw"), path.join(options.destination, "raw"), {
		recursive: true,
		force: false,
		errorOnExist: true,
	});
	let appended = "";
	for (const previous of pending.values()) {
		const record: EvidenceRecord = {
			...previous,
			phase: "interrupted",
			classification: "interrupted",
			accounting: "reserved",
			reason: options.reason,
			observedAt,
			offlineDerived: true,
			sourceEvidenceSha256: sha256(source),
		};
		const text = JSON.stringify(record);
		publicEvidence(text);
		const relative = `role_checkpoint/${sha256(text)}.jsonl.gz`;
		const bytes = gzipSync(`${text}\n`);
		writeFileSync(path.join(options.destination, "raw", relative), bytes, { flag: "wx" });
		appended += `${JSON.stringify({ type: "role_checkpoint", runId: record.runId, caseId: record.caseId, toolCallId: record.toolCallId, reservationId: record.reservationId, phase: record.phase, rawFile: relative, sha256: sha256(bytes) })}\n`;
	}
	const evidence = gzipSync(
		Buffer.concat([source, source.at(-1) === 10 ? Buffer.alloc(0) : Buffer.from("\n"), Buffer.from(appended)]),
	);
	const native = gzipSync(session);
	writeFileSync(path.join(options.destination, "raw/evidence.jsonl.gz"), evidence, { flag: "wx" });
	writeFileSync(path.join(options.destination, "raw/session.jsonl.gz"), native, { flag: "wx" });
	const checksums = { evidenceSha256: sha256(evidence), sessionSha256: sha256(native) };
	writeFileSync(path.join(options.destination, "raw/checksums.json"), `${JSON.stringify(checksums, null, 2)}\n`, {
		flag: "wx",
	});
	return {
		...checksums,
		sourceEvidenceSha256: sha256(source),
		sourceNativeSha256: sha256(session),
		pendingReservations: [...pending.values()].map((row) => String(row.reservationId)),
		offlineDerived: true,
	};
}
