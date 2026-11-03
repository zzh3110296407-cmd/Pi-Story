import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { EvidenceArchive, sha256 } from "../../../scripts/eval/p2/artifacts.ts";
import { readReplayContinuation } from "../../../scripts/eval/p3r2/replay-continuation.ts";
import type { ReplayInput } from "../../../scripts/eval/p3r2/writer-length.ts";

function fixture(mode = "recoverable") {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("Project workspace required");
	const root = mkdtempSync(path.join(work, "temp/p3r2-replay-recovery-"));
	const folder = path.join(root, "archive");
	const inputs: ReplayInput[] = [
		{
			id: "one",
			source: "registered-dev",
			caseId: "book",
			sourceDigest: sha256("original"),
			input: { targetWords: 100 },
			system: "rules",
			maxTokens: 1000,
		},
	];
	const rules = sha256("rules");
	const archive = new EvidenceArchive(folder, path.join(root, "work"), {
		suiteId: "P3R2-UNIT",
		runId: "recovery",
		stage: "P3R2",
		expectedCaseIds: ["one"],
	});
	writeFileSync(
		path.join(folder, "manifest.json"),
		JSON.stringify({ schema: "story/p3r2-writer-replay@1", writerRuleSha256: rules, inputs }),
	);
	const requestId = "11111111-1111-4111-8111-111111111111";
	archive.emit({ type: "replay_started", caseId: "one", factor: 0.8 });
	archive.emit({ type: "request", requestId, role: "writer" });
	archive.emit({
		type: "http_response",
		requestId,
		status: 200,
		complete: mode !== "truncated",
		body: `data: ${JSON.stringify({ choices: [{ delta: { content: "Chapter complete." }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: mode === "length" ? "length" : "stop" }], usage: { total_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
	});
	archive.emit({
		type: "recording_failure",
		requestId,
		diagnostic:
			mode === "transport" ? "Connection interrupted" : "Sensitive evidence rejected before writing; value omitted",
		ledgerFailure: false,
	});
	archive.emit({
		type: "replay_completed",
		id: "one",
		factor: 0.8,
		target: 100,
		words: 2,
		complete: false,
		response: {
			text: mode === "mismatch" ? "Different words." : "Chapter complete.",
			stopReason: "error",
			usage: { totalTokens: 20 },
		},
	});
	if (mode === "unknown_dispatch") {
		archive.emit({ type: "replay_started", caseId: "one", factor: 0.9 });
		archive.emit({ type: "request", requestId: "22222222-2222-4222-8222-222222222222", role: "writer" });
	}
	archive.finish();
	return { folder, inputs, rules };
}

test("complete retained provider output can repair a recording-only failure without changing the original result", () => {
	const f = fixture();
	const result = readReplayContinuation(f.folder, f.inputs, f.rules);
	expect(result.outcomes).toEqual([
		{ id: "one", factor: 0.8, target: 100, words: 2, complete: true, stopReason: "stop" },
	]);
	expect(result.repairs).toHaveLength(1);
});

test.each(["truncated", "length", "transport", "mismatch", "unknown_dispatch"])(
	"recovery refuses %s evidence instead of rerunning a charged request",
	(mode) => {
		const f = fixture(mode);
		expect(() => readReplayContinuation(f.folder, f.inputs, f.rules)).toThrow();
	},
);

test("a continuation cannot substitute different inputs or writer rules", () => {
	const f = fixture();
	expect(() => readReplayContinuation(f.folder, f.inputs, sha256("different rules"))).toThrow("differ");
	expect(() =>
		readReplayContinuation(f.folder, [{ ...f.inputs[0], sourceDigest: sha256("different input") }], f.rules),
	).toThrow("differ");
});
