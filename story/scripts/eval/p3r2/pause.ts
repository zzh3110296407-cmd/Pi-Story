import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { ToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ModelRequest, Ports } from "../../../packages/core/src/ports/index.ts";
import { schemas, validate } from "../../../packages/core/src/schema/index.ts";
import type { CallObservation } from "../../../packages/pi-story/src/ports.ts";
import { sha256 } from "../p2/artifacts.ts";
import type { EvidenceRecord } from "../p2/metering.ts";

export interface PauseProof {
	schema: "story/p3r2-paused-book@1";
	sessionFile: string;
	sessionSha256: string;
	evidenceFile: string;
	evidenceSha256: string;
	pendingToolCallId: string;
	target: number;
	runId: string;
	completedBefore?: number;
	resumeReason?: "author_pause" | "measurement_timeout";
}
export function assertNoRpcBootstrap(folder: string) {
	const exit = JSON.parse(readFileSync(path.join(folder, "process-exit.json"), "utf8")) as { code: number | null };
	const rows = readFileSync(path.join(folder, "case-lifecycle.jsonl"), "utf8")
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type: string });
	if (
		exit.code === null ||
		exit.code === 0 ||
		rows.some((row) => row.type === "rpc_started") ||
		existsSync(path.join(folder, "case-exit.json"))
	)
		throw new Error("Bootstrap has RPC/finished-case evidence; automatic relaunch forbidden");
}
export function readPausedMacro(proofFile: string, archive: string) {
	const proof = JSON.parse(readFileSync(proofFile, "utf8")) as PauseProof;
	if (
		proof.schema !== "story/p3r2-paused-book@1" ||
		!Number.isSafeInteger(proof.target) ||
		proof.target < 1 ||
		proof.target > 10
	)
		throw new Error("Invalid paused BOOK proof");
	if (existsSync(path.join(archive, "raw/checksums.json"))) throw new Error("Completed evidence cannot resume");
	if (
		sha256(readFileSync(proof.sessionFile)) !== proof.sessionSha256 ||
		sha256(readFileSync(proof.evidenceFile)) !== proof.evidenceSha256
	)
		throw new Error("Paused BOOK bytes differ from the saved proof");
	const rows = readFileSync(proof.evidenceFile, "utf8")
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as EvidenceRecord);
	const checkpoints = rows
		.filter((row) => row.type === "role_checkpoint")
		.map((row) => {
			if (typeof row.rawFile !== "string") throw new Error("Checkpoint reference missing");
			const bytes = readFileSync(path.join(archive, "raw", row.rawFile));
			if (sha256(bytes) !== row.sha256) throw new Error("Paused role checkpoint differs");
			return JSON.parse(gunzipSync(bytes).toString("utf8")) as EvidenceRecord;
		});
	const entries = SessionManager.open(proof.sessionFile).getBranch();
	const calls = entries.flatMap((entry) =>
		entry.type === "message" && entry.message.role === "assistant"
			? entry.message.content.filter(
					(part): part is ToolCall => part.type === "toolCall" && part.id === proof.pendingToolCallId,
				)
			: [],
	);
	if (
		calls.length !== 1 ||
		calls[0].name !== "write_next_chapter" ||
		entries.some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === proof.pendingToolCallId,
		)
	)
		throw new Error("Paused macro is absent, ambiguous or already completed");
	const completed = rows.filter(
		(row) => row.type === "role_call" && row.toolCallId === proof.pendingToolCallId,
	) as (EvidenceRecord & CallObservation)[];
	// Completion order is authoritative, including repeated roles after repair.
	const settled = checkpoints
		.filter((row) => row.phase === "completed" && row.toolCallId === proof.pendingToolCallId)
		.map((row) => {
			const checked = validate(schemas.CallRecord, row.record);
			if (!checked.ok) throw new Error("Paused call record is invalid");
			return checked.value;
		});
	if (
		completed.length !== settled.length ||
		completed.some((call, i) => call.request.role !== settled[i].role || settled[i].status !== "reported")
	)
		throw new Error("Paused outputs and completed journals disagree");
	const pending = checkpoints.filter(
		(row) =>
			row.phase === "started" &&
			row.toolCallId === proof.pendingToolCallId &&
			!settled.some((call) => call.id === row.reservationId),
	);
	if (pending.length !== 1 || !pending[0].request || !completed.length)
		throw new Error("Paused call boundary is not uniquely recoverable");
	return {
		proof,
		entries,
		args: calls[0].arguments as { brief?: string },
		completed,
		settled,
		pending: pending[0].request as ModelRequest,
	};
}
export function replayPausedCalls(
	ports: Ports,
	saved: Pick<ReturnType<typeof readPausedMacro>, "completed" | "settled" | "pending">,
	controller: AbortController,
	onReplay: (index: number, recoveredReservationId: string) => void = () => {},
) {
	const originalModels = ports.models;
	const originalBudget = ports.budget;
	const originalJournal = ports.callJournal;
	const replayIds = new Set<string>();
	const reservations: string[] = [];
	let replayed = 0;
	let live = 0;
	let mismatch: string | undefined;
	const canonical = (value: unknown) => JSON.stringify(value, (key, child) => (key === "signal" ? undefined : child));
	const reject = (message: string): never => {
		mismatch = message;
		controller.abort();
		throw new Error(message);
	};
	ports.budget = {
		reserve(request) {
			const result = originalBudget.reserve(request);
			if (!result.ok) return result;
			if (reservations.length < saved.completed.length) replayIds.add(result.reservationId);
			reservations.push(result.reservationId);
			return result;
		},
		settle(id, record) {
			originalBudget.settle(id, record);
		},
	};
	ports.callJournal = {
		started(id, request, cost) {
			if (!replayIds.has(id)) originalJournal?.started(id, request, cost);
		},
		completed(id, record) {
			if (!replayIds.has(id)) originalJournal?.completed(id, record);
		},
	};
	ports.models = {
		async call(request) {
			if (replayed < saved.completed.length) {
				const old = saved.completed[replayed];
				if (canonical(request) !== canonical(old.request)) {
					const fields = (
						["role", "model", "system", "user", "maxTokens", "temperature", "output", "inputSources"] as const
					).filter((key) => canonical(request[key]) !== canonical(old.request[key]));
					return reject(`Recovered completed request differs in ${fields.join(",")}; dispatch forbidden`);
				}
				const text = old.response.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				let json: unknown;
				if (request.output.kind === "json") {
					try {
						json = JSON.parse(text);
					} catch {
						/* Core preserves its original parse outcome. */
					}
				}
				onReplay(replayed, reservations[replayed]);
				replayed++;
				return {
					text,
					...(json !== undefined ? { json } : {}),
					usage: old.response.usage,
					stopReason: old.response.stopReason,
					durationMs: old.durationMs,
				};
			}
			if (live === 0 && canonical(request) !== canonical(saved.pending))
				return reject("Recovered pending request differs; dispatch forbidden");
			live++;
			return originalModels.call(request);
		},
	};
	return {
		assertReplayed() {
			if (replayed !== saved.completed.length)
				throw new Error(mismatch ?? "Completed paused outputs were not all reused");
		},
		restore() {
			ports.models = originalModels;
			ports.budget = originalBudget;
			ports.callJournal = originalJournal;
		},
	};
}
