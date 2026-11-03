import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { parseWriter } from "../../../packages/core/src/schema/index.ts";
import { wordCount } from "../../../packages/core/src/shared/text.ts";
import { readEvidence } from "../p2/artifacts.ts";
import type { ReplayInput } from "./writer-length.ts";

export interface ReplayOutcome {
	id: string;
	factor: 0.8 | 0.9;
	words: number;
	target: number;
	complete: boolean;
	stopReason?: string;
}

// Recover only the known recording failure after a completely received HTTP
// response. A transport interruption, truncated response or different output
// cannot be turned into a successful measurement by this reader.
export function readReplayContinuation(
	folder: string,
	inputs: ReplayInput[],
	writerRuleSha256: string,
	seen = new Set<string>(),
) {
	folder = path.resolve(folder);
	if (seen.has(folder)) throw new Error("Cyclic replay continuation");
	seen.add(folder);
	const manifest = JSON.parse(readFileSync(path.join(folder, "manifest.json"), "utf8")) as {
		schema: string;
		writerRuleSha256: string;
		inputs: { id: string; sourceDigest: string }[];
	};
	if (
		manifest.schema !== "story/p3r2-writer-replay@1" ||
		manifest.writerRuleSha256 !== writerRuleSha256 ||
		manifest.inputs.length !== inputs.length ||
		manifest.inputs.some((row, i) => row.id !== inputs[i].id || row.sourceDigest !== inputs[i].sourceDigest)
	)
		throw new Error("Continuation inputs or writer rule differ from the registered experiment");
	const records = readEvidence(folder);
	const outcomes: ReplayOutcome[] = [];
	const repairs: { id: string; factor: number; requestId: string; rawFile: string; sha256: unknown; reason: string }[] =
		[];
	const inheritedFile = path.join(folder, "continuation.json");
	if (existsSync(inheritedFile)) {
		const inherited = JSON.parse(readFileSync(inheritedFile, "utf8")) as { sourceFolder: string };
		const relative = path.relative(path.dirname(folder), path.resolve(inherited.sourceFolder));
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
			throw new Error("Continuation source must be a sibling length archive");
		const prior = readReplayContinuation(inherited.sourceFolder, inputs, writerRuleSha256, seen);
		outcomes.push(...prior.outcomes);
		repairs.push(...prior.repairs);
	}
	for (const [index, row] of records.entries()) {
		if (row.type !== "replay_completed") continue;
		const input = inputs.find((input) => input.id === row.id);
		if (
			!input ||
			![0.8, 0.9].includes(Number(row.factor)) ||
			outcomes.some((outcome) => outcome.id === row.id && outcome.factor === row.factor)
		)
			throw new Error("Invalid or duplicate replay outcome");
		const response = row.response as { text: string; stopReason: string; usage?: { totalTokens: number } };
		let recovered = false;
		if (!row.complete) {
			const start = records.findLastIndex(
				(candidate, i) =>
					i < index &&
					candidate.type === "replay_started" &&
					candidate.caseId === row.id &&
					candidate.factor === row.factor,
			);
			const segment = records.slice(start + 1, index);
			const request = segment.filter((candidate) => candidate.type === "request");
			const failure = segment.find(
				(candidate) => candidate.type === "recording_failure" && candidate.requestId === request[0]?.requestId,
			);
			const pointer = segment.find(
				(candidate) => candidate.type === "http_response" && candidate.requestId === request[0]?.requestId,
			);
			if (
				start < 0 ||
				request.length !== 1 ||
				failure?.diagnostic !== "Sensitive evidence rejected before writing; value omitted" ||
				failure.ledgerFailure !== false ||
				typeof pointer?.rawFile !== "string" ||
				typeof pointer.requestId !== "string"
			)
				throw new Error("Incomplete replay has no recoverable recording failure");
			const http = JSON.parse(gunzipSync(readFileSync(path.join(folder, "raw", pointer.rawFile))).toString("utf8")) as {
				complete: boolean;
				status: number;
				body: string;
			};
			let text = "";
			const finishes: string[] = [];
			let total: number | undefined;
			for (const line of http.body.split(/\r?\n/u)) {
				if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
				const frame = JSON.parse(line.slice(5)) as {
					choices?: { delta?: { content?: string }; finish_reason?: string }[];
					usage?: { total_tokens: number };
				};
				for (const choice of frame.choices ?? []) {
					text += choice.delta?.content ?? "";
					if (choice.finish_reason) finishes.push(choice.finish_reason);
				}
				if (frame.usage) total = frame.usage.total_tokens;
			}
			if (
				!http.complete ||
				http.status !== 200 ||
				!http.body.includes("data: [DONE]") ||
				finishes.length !== 1 ||
				finishes[0] !== "stop" ||
				text !== response.text ||
				!total ||
				total !== response.usage?.totalTokens
			)
				throw new Error("Original provider completion cannot be proven");
			recovered = true;
			repairs.push({
				id: input.id,
				factor: Number(row.factor),
				requestId: pointer.requestId,
				rawFile: pointer.rawFile,
				sha256: pointer.sha256,
				reason:
					"Complete HTTP 200/SSE stop/usage and exact prose verified; only recording failed. No model request repeated.",
			});
		}
		const parsed = parseWriter(response.text);
		if (
			!parsed.ok ||
			(!recovered && response.stopReason !== "stop") ||
			wordCount(parsed.text).value !== row.words ||
			row.target !== input.input.targetWords
		)
			throw new Error("Replay output or target does not match the retained observation");
		outcomes.push({
			id: input.id,
			factor: row.factor as 0.8 | 0.9,
			target: input.input.targetWords,
			words: row.words as number,
			complete: true,
			stopReason: "stop",
		});
	}
	for (const [index, row] of records.entries()) {
		if (
			row.type !== "replay_started" ||
			outcomes.some((outcome) => outcome.id === row.caseId && outcome.factor === row.factor)
		)
			continue;
		const end = records.findIndex((candidate, i) => i > index && candidate.type === "replay_started");
		if (records.slice(index + 1, end < 0 ? undefined : end).some((candidate) => candidate.type === "request"))
			throw new Error("Unresolved earlier request must not be dispatched twice");
	}
	return { sourceFolder: folder, outcomes, repairs };
}
