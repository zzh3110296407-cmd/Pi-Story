import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { readEvidence, sha256 } from "../p2/artifacts.ts";

export const DEVELOPMENT_RUNS = [
	"P3/P3-BOOK/20261101T071920Z-78eff81-dev-r1",
	"P3/P3-BOOK/20261101T072049Z-4293091-dev-r1",
	"P2R3/P2-CHAP/20261031T143116Z-bba97a8-dev",
] as const;
export interface ReplayInput {
	id: string;
	source: string;
	caseId: string;
	sourceDigest: string;
	input: Record<string, unknown> & { targetWords: number };
	system: string;
	maxTokens: number;
	temperature?: number;
}
export function collectWriterInputs(runs: string): ReplayInput[] {
	const inputs = new Map<string, ReplayInput>();
	function visit(folder: string) {
		if (existsSync(path.join(folder, "raw/checksums.json"))) {
			for (const row of readEvidence(folder, true)) {
				const request = row.request as Record<string, unknown> | undefined;
				if (row.type !== "role_checkpoint" || row.phase !== "started" || request?.role !== "writer") continue;
				if (
					typeof request.user !== "string" ||
					typeof request.system !== "string" ||
					typeof request.maxTokens !== "number"
				)
					throw new Error("Invalid archived writer request");
				const input = JSON.parse(request.user) as ReplayInput["input"];
				if (input.task !== "draft") continue;
				if (!Number.isSafeInteger(input.targetWords) || input.targetWords < 1)
					throw new Error("Missing original outline target");
				const sourceDigest = sha256(JSON.stringify({ system: request.system, user: request.user }));
				if (inputs.has(sourceDigest)) continue;
				inputs.set(sourceDigest, {
					id: sourceDigest.slice(0, 16),
					source: path.relative(runs, folder).split(path.sep).join("/"),
					caseId: String(row.caseId),
					sourceDigest,
					input,
					system: request.system,
					maxTokens: request.maxTokens,
					...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
				});
			}
			return;
		}
		for (const entry of readdirSync(folder, { withFileTypes: true }))
			if (entry.isDirectory()) visit(path.join(folder, entry.name));
	}
	for (const run of DEVELOPMENT_RUNS) visit(path.join(runs, run));
	return [...inputs.values()].sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}
export function calibrateInput<T extends Record<string, unknown> & { targetWords: number }>(
	original: T,
	factor: 0.8 | 0.9,
) {
	const targetWords = Math.round(original.targetWords * factor);
	return {
		...structuredClone(original),
		targetWords,
		wordRange: { min: Math.round((targetWords * 85) / 100), max: Math.round((targetWords * 115) / 100) },
	};
}
export function lengthSummary(rows: { words: number; target: number; complete: boolean }[]) {
	return {
		n: rows.length,
		complete: rows.every((row) => row.complete),
		within: rows.filter((row) => row.complete && row.words >= row.target * 0.7 && row.words <= row.target * 1.3).length,
		short: rows.filter((row) => row.complete && row.words < row.target * 0.7).length,
	};
}
export function chooseFactor(
	a: ReturnType<typeof lengthSummary>,
	b: ReturnType<typeof lengthSummary>,
): 0.8 | 0.9 | null {
	if (a.n < 15 || b.n !== a.n || !a.complete || !b.complete) return null;
	const qualifies = (s: typeof a) => s.within / s.n >= 0.85 && s.short <= 1;
	return qualifies(b) ? 0.9 : qualifies(a) ? 0.8 : null;
}
