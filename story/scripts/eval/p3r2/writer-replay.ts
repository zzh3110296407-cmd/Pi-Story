import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseWriter } from "../../../packages/core/src/schema/index.ts";
import { wordCount } from "../../../packages/core/src/shared/text.ts";
import { FileRules, PiModelPort } from "../../../packages/pi-story/src/ports.ts";
import { settingsTemplate } from "../../prepare-p2.mjs";
import { EvidenceArchive, publicEvidence, sha256 } from "../p2/artifacts.ts";
import { UsageLedger } from "../p2/ledger.ts";
import { instrumentRuntime } from "../p2/metering.ts";
import { RunControl } from "../p2/run-control.ts";
import { balance } from "../p3/main.ts";
import { inside, sourceEvidence, testingPaths } from "../paths.mjs";
import { type ReplayOutcome, readReplayContinuation } from "./replay-continuation.ts";
import { calibrateInput, chooseFactor, collectWriterInputs, DEVELOPMENT_RUNS, lengthSummary } from "./writer-length.ts";

const repository = path.resolve(import.meta.dirname, "../../../..");
const write = (file: string, value: unknown) => {
	const text = `${JSON.stringify(value, null, 2)}\n`;
	publicEvidence(text);
	writeFileSync(file, text, { flag: "wx" });
};

export async function replayWriterLengths(previous?: string) {
	const source = sourceEvidence(repository);
	if (source.dirty) throw new Error("Commit the replay code before making paid requests");
	const { runsRoot, workDir } = testingPaths();
	const inputs = collectWriterInputs(runsRoot);
	if (inputs.length < 15) throw new Error("S3 requires at least 15 independent development inputs");
	const runId = `${new Date()
		.toISOString()
		.replace(/[-:]/gu, "")
		.replace(/\.\d{3}/u, "")}-${source.commit.slice(0, 7)}-dev-a`;
	const root = path.join(runsRoot, "P3R2");
	const lengthRoot = path.join(root, "P3R2-LENGTH");
	if (previous && !inside(lengthRoot, path.resolve(previous)))
		throw new Error("Continuation must use a retained P3R2 length archive");
	if (!previous && existsSync(lengthRoot) && readdirSync(lengthRoot).length)
		throw new Error("S3 already has a run; continue its unperformed requests rather than repeating it");
	const system = new FileRules().get("writer");
	const continuation = previous ? readReplayContinuation(path.resolve(previous), inputs, sha256(system)) : undefined;
	const folder = path.join(root, "P3R2-LENGTH", runId);
	const work = path.join(workDir, "p3r2", runId);
	const ledger = new UsageLedger(path.join(root, "usage-ledger.jsonl"), path.join(root, "reservation-ledger.jsonl"), {
		stopUsd: 6.5,
		maximumUsd: 7.5,
	});
	const control = new RunControl();
	// Balance is checked before any generation reservation or request.
	const funds = await balance(control);
	const archive = new EvidenceArchive(folder, work, {
		suiteId: "P3R2-LENGTH",
		runId,
		expectedCaseIds: inputs.map((input) => input.id),
		stage: "P3R2",
		source,
		developmentOnly: true,
	});
	write(path.join(folder, "balance.json"), funds);
	if (continuation) write(path.join(folder, "continuation.json"), continuation);
	const settings = settingsTemplate(work);
	write(path.join(folder, "manifest.json"), {
		schema: "story/p3r2-writer-replay@1",
		runId,
		source,
		allowedSources: DEVELOPMENT_RUNS,
		factors: [0.8, 0.9],
		writerRuleSha256: sha256(system),
		settings: settings.roles.writer,
		inputs: inputs.map(({ input, system: _system, ...row }) => ({
			...row,
			targetWords: input.targetWords,
			inputSha256: sha256(JSON.stringify(input)),
		})),
	});
	const agent = path.join(work, "agent");
	mkdirSync(agent, { recursive: true });
	const runtime = await ModelRuntime.create({
		authPath: path.join(agent, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const restore = instrumentRuntime(runtime, {
		ledger,
		suiteId: "P3R2-LENGTH",
		runId,
		runLimitUsd: 6.5,
		control,
		haltOnNonFatalHttp: false,
		emit: (row) => archive.emit(row),
	});
	const port = new PiModelPort(new ModelRegistry(runtime), { localRevision: true, roles: settings.roles });
	const outcomes: ReplayOutcome[] = [...(continuation?.outcomes ?? [])];
	let failed = false;
	try {
		for (const factor of [0.8, 0.9] as const) {
			for (const input of inputs) {
				if (outcomes.some((row) => row.id === input.id && row.factor === factor)) continue;
				control.assertActive();
				const request = {
					role: "writer" as const,
					model: settings.roles.writer.model,
					system,
					user: JSON.stringify(calibrateInput(input.input, factor)),
					maxTokens: settings.roles.writer.maxTokens,
					temperature: settings.roles.writer.temperature,
					output: { kind: "text" as const },
					signal: AbortSignal.timeout(120_000),
				};
				archive.emit({
					type: "replay_started",
					caseId: input.id,
					source: input.source,
					sourceDigest: input.sourceDigest,
					factor,
					originalTarget: input.input.targetWords,
					request,
				});
				const response = await port.call(request);
				const parsed = parseWriter(response.text);
				const row = {
					id: input.id,
					factor,
					target: input.input.targetWords,
					words: parsed.ok ? wordCount(parsed.text).value : 0,
					complete: parsed.ok && response.stopReason === "stop" && !response.rejection,
					stopReason: response.stopReason,
				};
				outcomes.push(row);
				archive.emit({ type: "replay_completed", ...row, response });
				console.log(
					JSON.stringify({
						runId,
						completed: outcomes.length,
						expected: inputs.length * 2,
						factor,
						id: input.id,
						words: row.words,
						target: row.target,
						fee: ledger.snapshot(runId),
					}),
				);
			}
		}
	} catch (cause) {
		failed = true;
		let diagnostic = cause instanceof Error ? cause.message : "Unclassified replay failure";
		try {
			publicEvidence(diagnostic);
		} catch {
			diagnostic = "Sensitive failure diagnostic omitted";
		}
		archive.emit({
			type: "replay_interrupted",
			diagnostic,
			fatal: control.fatal ?? null,
		});
	} finally {
		restore();
	}
	const a = lengthSummary(outcomes.filter((row) => row.factor === 0.8));
	const b = lengthSummary(outcomes.filter((row) => row.factor === 0.9));
	const complete = !failed && a.n === inputs.length && b.n === inputs.length && a.complete && b.complete;
	const selected = complete ? chooseFactor(a, b) : null;
	const result = {
		schema: "story/p3r2-writer-replay-result@1",
		runId,
		complete,
		a,
		b,
		selectedFactor: selected,
		next: !complete ? "measurement_incomplete" : selected === null ? "validate_B" : "freeze_A",
		outcomes,
		fee: ledger.snapshot(runId),
		stageFee: ledger.snapshot(),
		continuedFrom: previous ?? null,
	};
	archive.emit({ type: "replay_result", result });
	archive.finish();
	write(path.join(folder, "result.json"), result);
	console.log(JSON.stringify({ folder, ...result }));
	return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	replayWriterLengths(process.argv[2] === "--continue" ? process.argv[3] : undefined)
		.then((result) => {
			if (!result.complete) process.exitCode = 1;
		})
		.catch(() => {
			console.error("P3R2 replay could not start or finalize; no automatic retry. Inspect retained evidence.");
			process.exitCode = 1;
		});
}
