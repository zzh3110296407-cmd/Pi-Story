/** Reproduce after explicit release: P0_REAL_APPROVED=V19 node --import <resolver> p0/scripts/verify-v19-length.ts <formal-V19-directory>. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type TSchema } from "typebox";
import { Value } from "typebox/value";
import { PaidProbe, createRuntime, itemCosts } from "../model/paid.ts";
import { asArray, asRecord, type JsonRecord, safeWrite, TEST_ROOT } from "../rpc/client.ts";

const source = path.resolve(process.argv[2] ?? "");
assert(source.startsWith(path.resolve(TEST_ROOT) + path.sep), "Source evidence must remain under the D-drive P0 test root");
assert.equal(process.env.P0_REAL_APPROVED, "V19", "Primary agent must release this V19 diagnostic");
const observations = asArray(JSON.parse(readFileSync(path.join(source, "observations.json"), "utf8"))).map(asRecord);
const lengthCase = observations.find((row) => row.method === "json-mode" && row.stopReason === "length");
const objectCase = observations.find((row) => {
	if (row.method !== "json-mode" || row.stopReason === "length" || row.usable) return false;
	const parsed = row.adapterOutput && typeof row.adapterOutput === "object" ? asRecord(row.adapterOutput) : {};
	return Array.isArray(parsed.facts) && parsed.facts.some((fact) => fact && typeof fact === "object" && !Object.hasOwn(fact, "object"));
});
assert(lengthCase && objectCase, "Need one original length failure and one nonlength missing-object failure");
const directory = path.join(TEST_ROOT, "runs/V19", `${new Date().toISOString().replace(/[:.]/gu, "-")}-length-check`);
mkdirSync(directory, { recursive: true });
process.env.PI_CODING_AGENT_DIR = path.join(TEST_ROOT, "agent-home");
process.env.TMP = process.env.TEMP = process.env.TMPDIR = path.join(TEST_ROOT, "tmp");
const runtime = await createRuntime();
const paid = new PaidProbe("V19", directory, runtime);
const results: JsonRecord[] = [];
for (const original of [lengthCase, objectCase]) {
	const request = asRecord(JSON.parse(readFileSync(path.join(source, `${String(original.callId)}-request.json`), "utf8")));
	const messages = asArray(request.messages).map(asRecord);
	const systemPrompt = String(messages.find((message) => message.role === "system")?.content);
	const prompt = String(messages.find((message) => message.role === "user")?.content);
	const schema = JSON.parse(prompt.split("JSON schema:\n")[1].split("\nNumbered chapter")[0]) as TSchema;
	const response = await paid.call(paid.model(), { systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { maxTokens: 8192, reasoning: "low", samplingParams: { response_format: { type: "json_object" } } });
	const call = paid.calls.at(-1)!;
	const actualRequest = asRecord(JSON.parse(readFileSync(path.join(directory, `${String(call.callId)}-request.json`), "utf8")));
	const beforeWithoutLimit = { ...request };
	const afterWithoutLimit = { ...actualRequest };
	delete beforeWithoutLimit.max_tokens;
	delete afterWithoutLimit.max_tokens;
	assert.deepEqual(afterWithoutLimit, beforeWithoutLimit, "Only max_tokens may change in this diagnostic");
	const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
	let parsed: unknown;
	let parseError: string | null = null;
	try { parsed = JSON.parse(text); } catch (error) { parseError = error instanceof Error ? error.message : String(error); }
	const schemaErrors = parsed === undefined ? [] : [...Value.Errors(schema, parsed)].map((error) => ({ instancePath: error.instancePath, message: error.message, params: error.params }));
	results.push({ originalCallId: original.callId, originalStopReason: original.stopReason, originalUsable: original.usable, callId: call.callId, changedOnly: "max_tokens:2048->8192", stopReason: response.stopReason, parseable: parsed !== undefined, schemaCorrect: parsed !== undefined && Value.Check(schema, parsed), schemaErrors, parseError });
}
const result = { status: "成立", scope: "Two single-run output-budget diagnostics only; does not replace or rerate the formal V19 group", source, samples: 2, runsPerSample: 1, results, calls: paid.calls, cost: itemCosts("V19") };
safeWrite(path.join(directory, "result.json"), result);
console.log(JSON.stringify({ status: result.status, result: path.join(directory, "result.json"), results }));
