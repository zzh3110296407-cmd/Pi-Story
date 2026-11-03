import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { EvidenceRecord } from "./metering.ts";

export const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export function publicEvidence(text: string): void {
	if (
		/\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~+/-]{8,})|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u.test(
			text,
		) ||
		/(?:^|[\s"'{,])(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|client[-_]?secret|secret[-_]?key)["']?\s*[:=]/imu.test(
			text,
		) ||
		// Authorization also occurs in ordinary administrative prose. Require
		// a field/line boundary, or an explicit HTTP authentication scheme inline.
		/(?:^|\r|\n|\\n|["'{,])\s*(?:authorization|proxy-authorization)["']?\s*[:=]/imu.test(text) ||
		/\b(?:proxy-)?authorization\s*:\s*(?:Basic|Bearer|Digest|Negotiate|AWS4-HMAC-SHA256)\s+\S+/iu.test(text) ||
		// Password fields/assignments start an object key, string or line. A
		// natural-language phrase such as "temporary password:" is not a field.
		/(?:^|\r|\n|\\n|["'{,])\s*password["']?\s*[:=]/imu.test(text)
	)
		throw new Error("Sensitive evidence rejected before writing; value omitted");
}
export class EvidenceArchive {
	readonly folder: string;
	readonly workFile: string;
	readonly meta: EvidenceRecord;
	private closed = false;
	private rawSize = 0;
	private readonly pendingCalls = new Map<string, EvidenceRecord>();
	constructor(
		folder: string,
		work: string,
		meta: { suiteId: string; runId: string; expectedCaseIds: string[]; [key: string]: unknown },
		resume?: { evidenceSha256: string; resumeReason?: "author_pause" | "measurement_timeout" },
	) {
		this.folder = folder;
		this.workFile = path.join(work, "evidence.jsonl");
		this.meta = { ...meta, type: "meta" };
		if (resume) {
			if (existsSync(path.join(folder, "raw/checksums.json"))) throw new Error("Finalized archive cannot resume");
			const bytes = readFileSync(this.workFile);
			if (sha256(bytes) !== resume.evidenceSha256) throw new Error("Paused evidence digest differs");
			const rows: EvidenceRecord[] = bytes
				.toString("utf8")
				.split(/\r?\n/u)
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			if (JSON.stringify(rows[0]) !== JSON.stringify(this.meta)) throw new Error("Paused measurement metadata differs");
			for (const row of rows) {
				if (typeof row.rawFile !== "string") continue;
				const raw = readFileSync(path.join(folder, "raw", row.rawFile));
				if (sha256(raw) !== row.sha256) throw new Error("Paused checkpoint digest differs");
				if (row.type !== "role_checkpoint") continue;
				const full = JSON.parse(gunzipSync(raw).toString("utf8")) as EvidenceRecord;
				const key = JSON.stringify([full.caseId, full.toolCallId ?? "direct", full.reservationId]);
				if (full.phase === "started") this.pendingCalls.set(key, full);
				else this.pendingCalls.delete(key);
			}
			for (const file of readdirSync(path.join(folder, "raw"), { recursive: true, withFileTypes: true }))
				if (file.isFile()) this.rawSize += readFileSync(path.join(file.parentPath, file.name)).length;
			this.emit({ type: "measurement_resumed", priorEvidenceSha256: resume.evidenceSha256 });
			for (const pending of [...this.pendingCalls.values()])
				this.emit({
					...pending,
					phase: "interrupted",
					classification: "interrupted",
					reason: resume.resumeReason ?? "author_pause",
					accounting: "reserved",
				});
			return;
		}
		if (existsSync(folder)) throw new Error("Run already exists; raw evidence is immutable");
		mkdirSync(path.join(folder, "raw"), { recursive: true });
		mkdirSync(work, { recursive: true });
		if (existsSync(this.workFile)) throw new Error("Evidence workspace already exists");
		this.emit(this.meta);
	}
	emit(record: EvidenceRecord): void {
		if (this.closed) throw new Error("Evidence archive is closed");
		const value = { ...record, runId: this.meta.runId };
		const text = JSON.stringify(value);
		publicEvidence(text);
		if (
			record.type === "role_checkpoint" ||
			((record.type === "http_response" || record.type === "request_body") && typeof record.requestId === "string")
		) {
			if (
				record.type !== "role_checkpoint" &&
				(typeof record.requestId !== "string" || !/^[a-f0-9-]{36}$/u.test(record.requestId))
			)
				throw new Error("Invalid request evidence ID");
			// Checkpoints must survive loss of the execution workspace, before finish().
			const id = record.type === "role_checkpoint" ? sha256(text) : record.requestId;
			const relative = `${record.type}/${id}.jsonl.gz`;
			const bytes = gzipSync(`${text}\n`);
			if (bytes.length > 10 * 1024 * 1024) throw new Error("Compressed request evidence exceeds 10 MB");
			mkdirSync(path.dirname(path.join(this.folder, "raw", relative)), { recursive: true });
			writeFileSync(path.join(this.folder, "raw", relative), bytes, { flag: "wx" });
			this.rawSize += bytes.length;
			appendFileSync(
				this.workFile,
				`${JSON.stringify({
					type: record.type,
					runId: this.meta.runId,
					requestId: record.requestId,
					...(record.type === "role_checkpoint"
						? {
								caseId: record.caseId,
								toolCallId: record.toolCallId,
								reservationId: record.reservationId,
								phase: record.phase,
							}
						: {}),
					rawFile: relative,
					sha256: sha256(bytes),
				})}\n`,
			);
		} else appendFileSync(this.workFile, `${text}\n`);
		if (record.type === "role_checkpoint") {
			const key = JSON.stringify([record.caseId, record.toolCallId ?? "direct", record.reservationId]);
			if (record.phase === "started") this.pendingCalls.set(key, record);
			else this.pendingCalls.delete(key);
		}
	}
	finish(sessionFile?: string): { evidenceSha256: string; sessionSha256?: string } {
		if (this.closed) throw new Error("Evidence archive already finalized");
		if (["P2R", "P2R3", "P3", "P3R2"].includes(String(this.meta.stage)))
			for (const pending of [...this.pendingCalls.values()])
				this.emit({ ...pending, phase: "interrupted", classification: "interrupted", accounting: "reserved" });
		const bytes = gzipSync(readFileSync(this.workFile));
		if (bytes.length > 10 * 1024 * 1024) throw new Error("Compressed evidence exceeds 10 MB");
		writeFileSync(path.join(this.folder, "raw/evidence.jsonl.gz"), bytes, { flag: "wx" });
		this.rawSize += bytes.length;
		const digests: { evidenceSha256: string; sessionSha256?: string } = { evidenceSha256: sha256(bytes) };
		if (sessionFile) {
			const session = readFileSync(sessionFile);
			publicEvidence(session.toString("utf8"));
			const compressed = gzipSync(session);
			if (compressed.length > 10 * 1024 * 1024) throw new Error("Compressed session exceeds 10 MB");
			writeFileSync(path.join(this.folder, "raw/session.jsonl.gz"), compressed, { flag: "wx" });
			this.rawSize += compressed.length;
			digests.sessionSha256 = sha256(compressed);
		}
		if (this.rawSize > 20 * 1024 * 1024) throw new Error("Compressed raw artifacts exceed the 20 MB run limit");
		writeFileSync(path.join(this.folder, "raw/checksums.json"), `${JSON.stringify(digests, null, 2)}\n`, {
			flag: "wx",
		});
		this.closed = true;
		return digests;
	}
	session(caseId: string, file: string): void {
		const bytes = readFileSync(file);
		publicEvidence(bytes.toString("utf8"));
		const compressed = gzipSync(bytes);
		if (compressed.length > 10 * 1024 * 1024) throw new Error("Compressed session exceeds 10 MB");
		const relative = `sessions/${sha256(caseId).slice(0, 16)}.jsonl.gz`;
		mkdirSync(path.join(this.folder, "raw/sessions"), { recursive: true });
		writeFileSync(path.join(this.folder, "raw", relative), compressed, { flag: "wx" });
		this.rawSize += compressed.length;
		this.emit({ type: "session_file", caseId, rawFile: relative, sha256: sha256(compressed) });
	}
}
export function readEvidence(folder: string, expandCheckpoints = false): EvidenceRecord[] {
	const bytes = readFileSync(path.join(folder, "raw/evidence.jsonl.gz"));
	const checksums = JSON.parse(readFileSync(path.join(folder, "raw/checksums.json"), "utf8")) as {
		evidenceSha256: string;
	};
	if (sha256(bytes) !== checksums.evidenceSha256) throw new Error("Raw evidence digest mismatch");
	const records = gunzipSync(bytes)
		.toString("utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as EvidenceRecord);
	for (const record of records) {
		if (typeof record.rawFile !== "string") continue;
		const root = path.resolve(folder, "raw");
		const file = path.resolve(root, record.rawFile);
		if (!file.startsWith(`${root}${path.sep}`) || sha256(readFileSync(file)) !== record.sha256)
			throw new Error("Referenced raw evidence digest mismatch");
		if (expandCheckpoints && record.type === "role_checkpoint") {
			const full = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as EvidenceRecord;
			Object.assign(record, full);
		}
	}
	return records;
}
