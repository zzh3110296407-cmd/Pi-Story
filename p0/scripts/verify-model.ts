/** Reproduce: set P0_REAL_APPROVED=V06; node --import <Pi source-resolver URL> p0/scripts/verify-model.ts V06. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Type, type AssistantMessage, type Context, type Tool } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { convertToLlm, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PaidProbe, createRuntime, itemCosts } from "../model/paid.ts";
import { asArray, asRecord, type JsonRecord, ProbeRpcClient, PROJECT_ROOT, safeWrite, TEST_ROOT } from "../rpc/client.ts";

type Check = (directory: string) => Promise<JsonRecord>;

function tool(name: string, args: JsonRecord, id: string): JsonRecord {
	return { type: "toolCall", id, name, arguments: args };
}

function saveScript(directory: string, turns: JsonRecord[]): string {
	const file = path.join(directory, "script.json");
	safeWrite(file, { turns });
	return file;
}

const deltaSchema = Type.Object({
	facts: Type.Array(Type.Object({
		ref: Type.String(), op: Type.Literal("upsert"), subject: Type.String(), predicate: Type.String(), object: Type.String(),
		mode: Type.Union([Type.Literal("narrated"), Type.Literal("recalled_past")]),
		certainty: Type.Union([Type.Literal("confirmed"), Type.Literal("uncertain")]),
		uncertainReason: Type.String(), sentences: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }),
	}, { additionalProperties: false }), { minItems: 1 }),
	claims: Type.Array(Type.Object({}, { additionalProperties: false }), { maxItems: 0 }),
	cognitions: Type.Array(Type.Object({}, { additionalProperties: false }), { maxItems: 0 }),
	relations: Type.Array(Type.Object({}, { additionalProperties: false }), { maxItems: 0 }),
	hooks: Type.Array(Type.Object({}, { additionalProperties: false }), { maxItems: 0 }),
	summary: Type.Object({ title: Type.String(), characters: Type.Array(Type.String()), events: Type.Array(Type.String()), mood: Type.String() }, { additionalProperties: false }),
	issues: Type.Array(Type.String()),
}, { additionalProperties: false });

function responseText(response: AssistantMessage): string {
	return response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function inspectDelta(value: unknown, allowedEvidence: Set<number>): JsonRecord {
	const record = value && typeof value === "object" && !Array.isArray(value) ? asRecord(value) : {};
	const facts = Array.isArray(record.facts) ? record.facts.map((fact) => fact && typeof fact === "object" && !Array.isArray(fact) ? asRecord(fact) : {}) : [];
	const certaintyMissing = facts.filter((fact) => fact.certainty !== "confirmed" && fact.certainty !== "uncertain").length;
	const evidence = facts.flatMap((fact) => Array.isArray(fact.sentences) ? fact.sentences : []);
	const evidenceOutOfRange = evidence.filter((ref) => typeof ref !== "number" || !Number.isInteger(ref) || !allowedEvidence.has(ref)).length;
	const provisionalReasonMissing = facts.filter((fact) => fact.certainty === "uncertain" && (typeof fact.uncertainReason !== "string" || !fact.uncertainReason.trim())).length;
	const schemaCorrect = Value.Check(deltaSchema, value);
	const validationErrors = [...Value.Errors(deltaSchema, value)].map((error) => ({ instancePath: error.instancePath, message: error.message, params: error.params }));
	for (const [index, fact] of facts.entries()) {
		if (fact.certainty === "uncertain" && (typeof fact.uncertainReason !== "string" || !fact.uncertainReason.trim())) validationErrors.push({ instancePath: `/facts/${index}/uncertainReason`, message: "uncertain facts require a nonempty uncertainReason", params: {} });
		if (Array.isArray(fact.sentences)) for (const [sentenceIndex, ref] of fact.sentences.entries()) if (typeof ref !== "number" || !Number.isInteger(ref) || !allowedEvidence.has(ref)) validationErrors.push({ instancePath: `/facts/${index}/sentences/${sentenceIndex}`, message: "sentence number must be present in this numbered chapter", params: {} });
	}
	return { schemaCorrect, factCount: facts.length, evidenceCount: evidence.length, certaintyMissing, evidenceOutOfRange, provisionalReasonMissing, validationErrors, usable: schemaCorrect && certaintyMissing === 0 && evidenceOutOfRange === 0 && provisionalReasonMissing === 0 };
}

const checks: Record<string, Check> = {
	async V06(directory) {
		const offlineDir = path.join(directory, "branch-setup");
		const turns: JsonRecord[] = [];
		for (let chapter = 1; chapter <= 3; chapter++) turns.push({ content: [tool("probe_commit", { chapter }, `chapter-${chapter}`)] }, { text: `chapter ${chapter} complete` });
		const client = new ProbeRpcClient({ runDir: offlineDir, scriptFile: saveScript(offlineDir, turns) });
		let sessionFile = "";
		let anchorId = "";
		try {
			await client.ready();
			for (let chapter = 1; chapter <= 3; chapter++) await client.promptAndWait(`Write chapter ${chapter}`);
			const data = await client.success({ type: "get_entries" });
			const entries = asArray(data.entries).map(asRecord);
			const anchor = entries.find((entry) => entry.type === "label" && entry.label === "第 1 章");
			assert(anchor);
			anchorId = String(anchor.targetId);
			await client.success({ type: "prompt", message: `/probe-branch ${anchorId}` });
			const state = await client.success({ type: "get_state" });
			sessionFile = String(state.sessionFile);
		} finally { await client.close(); }
		const manager = SessionManager.open(sessionFile);
		manager.branch(anchorId);
		assert(!manager.getBranch().some((entry) => entry.type === "branch_summary"));
		const user = { role: "user" as const, content: "Reply exactly OK. Do not use any tool. This is a branch continuation API ordering probe.", timestamp: Date.now() };
		manager.appendMessage(user);
		const messages = convertToLlm(manager.buildSessionContext().messages);
		assert.equal(messages.at(-2)?.role, "toolResult", "Branch anchor is immediately followed by a user message");
		assert.equal(messages.at(-1)?.role, "user");
		assert(!JSON.stringify(messages).includes('"chapter":2'));
		const runtime = await createRuntime();
		const paid = new PaidProbe("V06", directory, runtime);
		const response = await paid.call(paid.model(), { messages, tools: [{ name: "probe_commit", description: "Offline chapter probe; do not call", parameters: Type.Object({ chapter: Type.Number() }) }] }, { maxTokens: 512, reasoning: "low", toolChoice: "none" });
		assert.notEqual(response.stopReason, "error", response.errorMessage);
		assert.notEqual(response.stopReason, "aborted");
		assert.equal(paid.calls[0]?.httpStatus, 200);
		manager.appendMessage(response);
		safeWrite(path.join(directory, "branch-context.json"), messages);
		return { status: "成立", samples: 1, runs: 1, offlineChapters: 3, branchAnchor: anchorId, lastRoles: messages.slice(-2).map((message) => message.role), generatedBranchSummaries: 0, sessionFile, responseStopReason: response.stopReason, calls: paid.calls, cost: itemCosts("V06") };
	},

	async V10(directory) {
		const runtime = await createRuntime();
		const paid = new PaidProbe("V10", directory, runtime);
		const agentDir = path.join(TEST_ROOT, "agent-home");
		const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 8, reserveTokens: 1024 }, retry: { enabled: false } });
		const rulesFile = path.join(directory, "fixed-rules.txt");
		safeWrite(rulesFile, "P0 fixed prefix: author intent is author-owned; canonical state comes from committed evidence.\n".repeat(100));
		process.env.PROBE_RULES_TEXT_FILE = rulesFile;
		process.env.PROBE_RUN_DIR = directory;
		process.env.PROBE_SCRIPT = saveScript(directory, [{ text: "unused by real model" }]);
		const loader = new DefaultResourceLoader({ cwd: directory, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [path.join(PROJECT_ROOT, "p0/ext/probe")] });
		await loader.reload();
		const manager = SessionManager.create(directory, path.join(directory, "sessions"));
		const { session } = await createAgentSession({ cwd: directory, agentDir, resourceLoader: loader, modelRuntime: runtime, model: paid.model(), thinkingLevel: "low", noTools: "builtin", settingsManager: settings, sessionManager: manager });
		session.agent.streamFunction = (model, context, options) => paid.stream(model, context, { ...options, maxTokens: 512, toolChoice: "none" });
		try {
			await session.bindExtensions({ mode: "print", onError: (event) => { throw new Error(event.error); } });
			for (let round = 1; round <= 3; round++) await session.prompt(`Round ${round}. Reply exactly OK. Do not call a tool.`);
			const systemsBeforeCompact = manager.getBranch().flatMap((entry) => entry.type === "message" && entry.message.role === "system" ? [entry.message] : []);
			assert.equal(systemsBeforeCompact.length, 3);
			const sectionChanges = systemsBeforeCompact.map((message) => Object.keys(message.sections ?? {}));
			assert(sectionChanges[0].includes("probe_rules"));
			assert(sectionChanges.slice(1).every((keys) => keys.includes("probe_progress") && !keys.includes("probe_rules") && !keys.includes("probe_intent")), "Only the changing section is persisted after the first prompt");
			const compaction = await session.compact("Keep only the fact that these are P0 API probes and the author requested OK replies.");
			await session.prompt("After compaction, reply exactly OK. Do not call a tool.");
			const requestFiles = paid.calls.map((row) => path.join(directory, `${String(row.callId)}-request.json`));
			const requestTexts = requestFiles.map((file) => readFileSync(file, "utf8"));
			assert(requestTexts.at(-1)?.includes("P0 fixed prefix"), "Fixed rule text is still injected after compaction");
			assert(requestTexts.every((text) => !text.includes("<available_skills>")), "Disabled built-in read/bash does not create a Skill directory");
			const cacheRead = paid.calls.slice(0, 3).map((row) => Number(asRecord(row.usage ?? {}).cacheRead ?? 0));
			const cacheObserved = cacheRead.some((tokens) => tokens > 0);
			return { status: cacheObserved ? "成立" : "阻塞", samples: 1, preCompactionRounds: 3, postCompactionRounds: 1, cacheRead, cacheObserved, sectionChanges, compaction, rulesAfterCompact: true, skillDirectoryAbsent: true, sessionFile: manager.getSessionFile(), calls: paid.calls, reason: cacheObserved ? undefined : "No cache hit was observed in the prescribed three real-model rounds", cost: itemCosts("V10") };
		} finally { session.dispose(); delete process.env.PROBE_RULES_TEXT_FILE; }
	},

	async V16(directory) {
		const realDir = path.join(directory, "tool-real");
		const client = new ProbeRpcClient({ runDir: realDir,
			scriptFile: saveScript(realDir, [{ content: [tool("probe_llm", { prompt: "Reply with the word confirmed." }, "real-inner-call")] }, { text: "done" }]),
			env: { PROBE_ALLOW_REAL_MODEL: "1", PROBE_ITEM: "V16" } });
		let call: JsonRecord;
		let stats: JsonRecord;
		try {
			await client.ready();
			await client.promptAndWait("Execute one approved inner model call", 120000);
			const data = await client.success({ type: "get_entries" });
			const entry = asArray(data.entries).map(asRecord).findLast((entry) => entry.type === "message" && asRecord(entry.message).role === "toolResult" && asRecord(entry.message).toolName === "probe_llm");
			assert(entry);
			const message = asRecord(entry.message);
			assert.notEqual(message.isError, true, JSON.stringify(message.content));
			call = asRecord(asArray(asRecord(message.details).calls)[0]);
			assert.equal(call.status, "reported");
			assert(call.usage);
			stats = await client.success({ type: "get_session_stats" });
		} finally { await client.close(); }
		const missingDir = path.join(directory, "tool-missing");
		const faux = new ProbeRpcClient({ runDir: missingDir,
			scriptFile: saveScript(missingDir, [{ content: [tool("probe_llm", { prompt: "Return text without supplier usage", model: "probe-faux/script" }, "missing-inner-call")] }, { text: "Text without usage" }, { text: "done" }]), env: { PROBE_ALLOW_FAUX_LLM: "1" } });
		let missing: JsonRecord;
		try {
			await faux.ready();
			await faux.promptAndWait("Execute offline missing-usage boundary");
			const data = await faux.success({ type: "get_entries" });
			const entry = asArray(data.entries).map(asRecord).findLast((entry) => entry.type === "message" && asRecord(entry.message).role === "toolResult" && asRecord(entry.message).toolName === "probe_llm");
			assert(entry);
			missing = asRecord(asArray(asRecord(asRecord(entry.message).details).calls)[0]);
			assert.equal(missing.status, "missing");
			assert.equal(missing.usage, null);
		} finally { await faux.close(); }
		safeWrite(path.join(TEST_ROOT, "runs/v16-shared.json"), { call, stats, evidence: directory });
		return { status: "成立", realSamples: 1, realRuns: 1, missingUsageSamples: 1, missingUsageRuns: 1, call, missing, stats, cost: itemCosts("V16") };
	},

	async V17(directory) {
		const shared = asRecord(JSON.parse(readFileSync(path.join(TEST_ROOT, "runs/v16-shared.json"), "utf8")));
		const usage = asRecord(asRecord(shared.call).usage);
		const stats = asRecord(shared.stats);
		const tokens = asRecord(stats.tokens);
		for (const field of ["input", "output", "cacheRead", "cacheWrite"]) assert.equal(tokens[field], usage[field], `Tool ${field} included in Pi stats; outer scripted model uses zero`);
		assert.equal(stats.cost, asRecord(usage.cost).total);
		return { status: "成立", realCallsReusedFrom: "V16", additionalRealCalls: 0, evidence: shared.evidence, usage, stats };
	},

	async V18(directory) {
		const runtime = await createRuntime();
		const paid = new PaidProbe("V18", directory, runtime);
		const cases: JsonRecord[] = [];
		for (const action of ["throw", "abort"]) {
			const caseDir = path.join(directory, action);
			mkdirSync(caseDir, { recursive: true });
			const events: JsonRecord[] = [];
			const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
			const agentDir = path.join(TEST_ROOT, "agent-home");
			const loader = new DefaultResourceLoader({ cwd: caseDir, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [(pi) => {
					pi.on("before_provider_request", async (event, ctx) => {
						events.push({ type: "before_provider_request", action, payloadChars: JSON.stringify(event.payload).length });
						if (action === "abort") { ctx.abort(); return; }
						throw new Error("P0 V18 deliberate budget-hook rejection");
					});
					pi.on("turn_end", async (event) => { events.push({ type: "turn_end", usage: event.message.role === "assistant" ? event.message.usage : null }); });
				}] });
			await loader.reload();
			const { session } = await createAgentSession({ cwd: caseDir, agentDir, modelRuntime: runtime, model: paid.model(), thinkingLevel: "low", noTools: "all", resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.create(caseDir, path.join(caseDir, "sessions")) });
			session.agent.streamFunction = (model, context, options) => paid.stream(model, context, { ...options, maxTokens: 128, toolChoice: "none" });
			try {
				await session.bindExtensions({ mode: "print", onError: (event) => { events.push({ type: "extension_error", error: event.error }); } });
				const before = paid.calls.length;
				await session.prompt("Reply exactly OK. This is a bounded provider-hook cancellation probe.");
				const calls = paid.calls.slice(before);
				assert(events.some((event) => event.type === "before_provider_request"));
				cases.push({ action, calls, events, networkAttempts: calls.reduce((sum, row) => sum + Number(row.networkAttempts), 0), httpResponses: calls.filter((row) => row.httpStatus !== null).length });
			} finally { session.dispose(); }
			safeWrite(path.join(caseDir, "events.json"), events);
		}
		const abortCase = cases.find((item) => item.action === "abort");
		const blocked = abortCase?.networkAttempts === 0;
		return { status: blocked ? "成立" : "不成立·已用替代", samples: 1, hookModes: 2, cases, canAbortBeforeHttp: blocked, budgetPolicy: blocked ? "Use ctx.abort() in the request hook, then settle as aborted; throwing is not a rejection contract" : "Lead-writer requests use soft control and may exceed by one bounded request", maximumUninterceptedOutputTokens: blocked ? 0 : 128, calls: paid.calls, cost: itemCosts("V18") };
	},

	async V27(directory) {
		const runtime = await createRuntime();
		const paid = new PaidProbe("V27", directory, runtime);
		const lengths = [500, 1000, 2000, 5000, 20000];
		const patterns = [
			{ language: "latin", text: "A traveler observes a river, snow, stone, and a distant fire. " },
			{ language: "cjk", text: "旅人穿过雪原，看见河流与石桥。他记下沿途的风向，等待远处的灯火。" },
			{ language: "mixed", text: "The traveler 旅人 crosses 雪原 and records 河流与石桥. " },
			{ language: "mixed", text: "风吹过 stone bridge，river 向东流，traveler 继续走向灯火。" },
		];
		const samples: JsonRecord[] = [];
		for (const pattern of patterns) for (const length of lengths) {
			const text = pattern.text.repeat(Math.ceil(length / pattern.text.length)).slice(0, length);
			const response = await paid.call(paid.model(), { systemPrompt: "Return only OK. Do not analyze or repeat the supplied text.", messages: [{ role: "user", content: text, timestamp: Date.now() }] }, { maxTokens: 16, toolChoice: "none", samplingParams: { thinking: { type: "disabled" } } });
			assert.notEqual(response.stopReason, "error", response.errorMessage);
			const row = paid.calls.at(-1);
			assert(row?.usage, "Calibration requires actual supplier usage");
			const usage = asRecord(row.usage);
			const actualInput = Number(usage.input) + Number(usage.cacheRead) + Number(usage.cacheWrite);
			const cjkCharacters = [...text].filter((character) => /[\u2e80-\u9fff\uf900-\ufaff]/u.test(character)).length;
			samples.push({ language: pattern.language, characters: length, cjkCharacters, latinCharacters: length - cjkCharacters, actualInputTokens: actualInput, tokenPerCharacter: actualInput / length, callId: row.callId });
		}
		const maxLatinRatio = Math.max(...samples.filter((sample) => sample.language === "latin").map((sample) => Number(sample.tokenPerCharacter)));
		const maxCjkRatio = Math.max(...samples.filter((sample) => sample.language === "cjk").map((sample) => Number(sample.actualInputTokens) / Number(sample.cjkCharacters)));
		const latinCoefficient = Math.ceil(maxLatinRatio * 1.1 * 1000) / 1000;
		const cjkCoefficient = Math.ceil(maxCjkRatio * 1.1 * 1000) / 1000;
		const fixedOverhead = 2048;
		for (const sample of samples) {
			const estimate = Math.ceil(Number(sample.cjkCharacters) * cjkCoefficient + Number(sample.latinCharacters) * latinCoefficient + fixedOverhead);
			sample.estimatedInputTokens = estimate;
			assert(estimate >= Number(sample.actualInputTokens), "Calibrated estimate must dominate every observed sample");
		}
		const estimator = { schema: "probe/input-estimator@1", model: "deepseek/deepseek-flash", samples: samples.length, minCharacters: 500, maxCharacters: 20000, cjkCoefficient, latinCoefficient, fixedOverhead, maxLatinRatio, maxCjkRatio, safetyMultiplier: 1.1, evidence: directory, scope: "Empirical upper estimate on these 20 input samples; output and thinking are separately reserved; schema overhead receives a fixed margin" };
		safeWrite(path.join(TEST_ROOT, "input-estimator.json"), estimator);
		return { status: "成立", samples: samples.length, runsPerSample: 1, estimator, samplesDetail: samples, calls: paid.calls, cost: itemCosts("V27") };
	},

	async V19(directory) {
		const methods = process.argv.includes("--json-only") ? ["json-mode"] : ["typed-tool", "json-mode", "strict-tool"];
		const maxTokens = Number(process.argv.find((argument) => argument.startsWith("--max-tokens="))?.split("=")[1] ?? 2048);
		assert(maxTokens === 2048 || maxTokens === 8192, "Only the original or explicitly diagnosed output limit is supported");
		assert(readFileSync(path.join(TEST_ROOT, "input-estimator.json"), "utf8"), "V27 calibration must precede V19");
		const chapters = asArray(JSON.parse(readFileSync(path.join(TEST_ROOT, "fixtures/chapters.json"), "utf8"))).map(asRecord);
		assert.equal(chapters.length, 3, "Exactly three fixed v3 chapter fixtures");
		const runtime = await createRuntime();
		const paid = new PaidProbe("V19", directory, runtime);
		const model = paid.model();
		const strictModeDeclared = asRecord(model.compat ?? {}).supportsStrictMode;
		assert.equal(strictModeDeclared, true, "Pinned catalog declares strict tool-schema support");
		const observations: JsonRecord[] = [];
		const prompts = new Map<number, { prompt: string; evidence: Set<number> }>();
		for (const chapter of chapters) {
			const number = Number(chapter.chapterNo);
			const sentences = String(chapter.text).match(/[^.!?。！？]+[.!?。！？]*/gu)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
			assert(sentences.length > 0);
			const refs = sentences.map((_sentence, index) => index + 1);
			const prompt = `Extract a minimal DeltaProposal from this chapter only, following interface design 12 section 6. Do not add future plans or unstated facts. This P0 subset tests only 1 to 4 fact upserts: each has a temporary ref, op=upsert, subject, predicate, object(string), mode=narrated or recalled_past, certainty=confirmed or uncertain, uncertainReason(a nonempty string when uncertain; empty string when confirmed), and sentences(an array of integer sentence numbers from this chapter). Leave claims, cognitions, relations, and hooks as empty arrays. Summary must have title, characters, events, mood. Include issues.\nJSON schema:\n${JSON.stringify(deltaSchema)}\nNumbered chapter ${number}:\n${sentences.map((sentence, index) => `[${refs[index]}] ${sentence}`).join("\n")}`;
			prompts.set(number, { prompt, evidence: new Set(refs) });
		}
		for (const method of methods) for (const chapter of chapters) {
			const number = Number(chapter.chapterNo);
			const input = prompts.get(number)!;
			for (let repetition = 1; repetition <= 10; repetition++) {
				const toolSpec: Tool = { name: "record_delta", description: "Return the extracted state delta", parameters: deltaSchema, constrainedSampling: method === "strict-tool" ? { type: "json_schema", strict: "require" } : false };
				const context: Context = { systemPrompt: "You are the recorder. Extract only states stated in the numbered chapter. Use the requested JSON schema and cite exact sentence IDs.", messages: [{ role: "user", content: input.prompt, timestamp: Date.now() }], ...(method === "json-mode" ? {} : { tools: [toolSpec] }) };
				const response = await paid.call(model, context, { maxTokens, reasoning: "low", samplingParams: method === "json-mode" ? { response_format: { type: "json_object" } } : { tool_choice: { type: "function", function: { name: "record_delta" } } } });
				const toolCall = response.content.find((block) => block.type === "toolCall" && block.name === "record_delta");
				let parsed: unknown;
				let parseable = false;
				if (method !== "json-mode" && toolCall?.type === "toolCall") { parsed = toolCall.arguments; parseable = true; }
				if (method === "json-mode") { try { parsed = JSON.parse(responseText(response)); parseable = true; } catch { /* Initial parse failure is an observation. */ } }
				const carrierCorrect = method === "json-mode" ? toolCall === undefined && parseable : toolCall?.type === "toolCall";
				const responseSuccessful = response.stopReason !== "error" && response.stopReason !== "aborted";
				const inspected = inspectDelta(parsed, input.evidence);
				observations.push({ method, chapter: number, repetition, parseable, ...inspected, carrierCorrect, responseSuccessful, usable: inspected.usable === true && carrierCorrect && responseSuccessful, stopReason: response.stopReason, errorMessage: response.errorMessage, callId: paid.calls.at(-1)?.callId, adapterOutput: parsed ?? null, initialText: responseText(response) });
			}
			console.log(JSON.stringify({ item: "V19", completedMethod: method, chapter: number, completedCalls: observations.length }));
		}
		const summaries = methods.map((method) => {
			const rows = observations.filter((row) => row.method === method);
			const factCount = rows.reduce((sum, row) => sum + Number(row.factCount), 0);
			const evidenceCount = rows.reduce((sum, row) => sum + Number(row.evidenceCount), 0);
			const certaintyMissing = rows.reduce((sum, row) => sum + Number(row.certaintyMissing), 0);
			const evidenceOutOfRange = rows.reduce((sum, row) => sum + Number(row.evidenceOutOfRange), 0);
			const ids = new Set(rows.map((row) => row.callId));
			const calls = paid.calls.filter((call) => ids.has(call.callId));
			return { method, attempts: rows.length, parseable: rows.filter((row) => row.parseable).length, parseableRate: rows.filter((row) => row.parseable).length / rows.length, schemaCorrect: rows.filter((row) => row.schemaCorrect).length, schemaCorrectRate: rows.filter((row) => row.schemaCorrect).length / rows.length, usable: rows.filter((row) => row.usable).length, factCount, evidenceCount, certaintyMissing, certaintyMissingRate: factCount ? certaintyMissing / factCount : null, evidenceOutOfRange, evidenceOutOfRangeRate: evidenceCount ? evidenceOutOfRange / evidenceCount : null, usableRate: rows.filter((row) => row.usable).length / rows.length,
				durationMs: calls.reduce((sum, call) => sum + Number(call.durationMs), 0), inputTokens: calls.reduce((sum, call) => sum + Number(call.totalInputTokens ?? 0), 0), outputTokens: calls.reduce((sum, call) => sum + Number(call.outputTokens ?? 0), 0), estimatedCostUsd: calls.reduce((sum, call) => sum + Number(call.estimatedCostUsd), 0) };
		}).sort((left, right) => right.usableRate - left.usableRate);
		const chosen = summaries[0];
		const repairs: JsonRecord[] = [];
		if (chosen.usableRate < 0.95) for (const failed of observations.filter((row) => row.method === chosen.method && !row.usable)) {
			const input = prompts.get(Number(failed.chapter))!;
			const response = await paid.call(model, { systemPrompt: "Repair the prior state delta into the exact JSON schema. Return only JSON; do not invent evidence IDs.", messages: [{ role: "user", content: `${input.prompt}\nPrior output:\n${JSON.stringify(failed.adapterOutput ?? failed.initialText)}\nValidator errors to repair (do not ignore these paths):\n${JSON.stringify(failed.validationErrors ?? [])}`, timestamp: Date.now() }] }, { maxTokens, reasoning: "low", samplingParams: { response_format: { type: "json_object" } } });
			let parsed: unknown;
			try { parsed = JSON.parse(responseText(response).replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "")); } catch { /* One repair only; keep failure visible. */ }
			const responseSuccessful = response.stopReason !== "error" && response.stopReason !== "aborted";
			const inspected = inspectDelta(parsed, input.evidence);
			repairs.push({ originalCallId: failed.callId, callId: paid.calls.at(-1)?.callId, ...inspected, responseSuccessful, stopReason: response.stopReason, usable: inspected.usable === true && responseSuccessful });
		}
		const repairedRate = (chosen.usable + repairs.filter((row) => row.usable).length) / chosen.attempts;
		const status = chosen.usableRate >= 0.95 ? "成立" : repairedRate >= 0.95 ? "不成立·已用替代" : "阻塞";
		safeWrite(path.join(directory, "observations.json"), observations);
		safeWrite(path.join(TEST_ROOT, "runs/v19-shared.json"), { status, chosenMethod: chosen.method, initialUsableRate: chosen.usableRate, repairedRate, evidence: directory });
		return { status, formalGroup: true, experiment: methods.length === 1 ? "json-output-budget-followup" : "three-method-comparison", maxTokens, schemaBasis: "12 section 6 DeltaProposal: only fact upserts are populated; other event arrays are empty; confirmed/uncertain and integer sentences are preserved", chapterSamples: 3, methods: methods.length, initialRunsPerChapterPerMethod: 10, initialCalls: observations.length, strictModeDeclared, chosenMethod: chosen.method, summaries, repairs, repairedRate, repairPolicy: "At most one model repair for each failed initial sample; actual validator paths are provided, no host deletion or semantic filling", observationsFile: path.join(directory, "observations.json"), calls: paid.calls, scope: "Format and sentence-number-reference validity of Pi adapter outputs; no claim about semantic extraction accuracy or literary quality; prior experiment requests are excluded from this sample count and included in total item cost", cost: itemCosts("V19") };
	},

	async V20(directory) {
		assert(readFileSync(path.join(TEST_ROOT, "input-estimator.json"), "utf8"), "V27 calibration must precede V20");
		const structuralSelection = asRecord(JSON.parse(readFileSync(path.join(TEST_ROOT, "runs/v19-shared.json"), "utf8")));
		assert(structuralSelection.status !== "阻塞", "V19 must select a usable structured-output approach before V20");
		const strictTools = structuralSelection.chosenMethod === "strict-tool";
		const jsonFinal = structuralSelection.chosenMethod === "json-mode";
		const state = asRecord(JSON.parse(readFileSync(path.join(TEST_ROOT, "fixtures/story-state.json"), "utf8")));
		const prompts = asArray(JSON.parse(readFileSync(path.join(TEST_ROOT, "fixtures/prompts.json"), "utf8"))).map(asRecord);
		assert(prompts.length >= 1 && prompts.length <= 2, "Only one or two ConStory train prompts");
		const runtime = await createRuntime();
		const paid = new PaidProbe("V20", directory, runtime);
		const trials: JsonRecord[] = [];
		for (const modelId of ["deepseek-flash", "deepseek-v4-pro"]) for (let repetition = 1; repetition <= 5; repetition++) {
			const caseDir = path.join(directory, `${modelId}-${repetition}`);
			mkdirSync(caseDir, { recursive: true });
			const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
			const agentDir = path.join(TEST_ROOT, "agent-home");
			let readCount = 0;
			let commits = 0;
			let batchCommitted = false;
			let invalidCalls = 0;
			const invalidCallIds = new Set<string>();
			let afterCommitWrites = 0;
			let requestCount = 0;
			let goalSignalSent = false;
			const events: JsonRecord[] = [];
			const loader = new DefaultResourceLoader({ cwd: caseDir, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [(pi) => {
					pi.registerTool({ name: "read_story", label: "Read smoke story", description: "Read fixed story state and the three evidence-backed probe facts before answering the author questions", parameters: Type.Object({ section: Type.Optional(Type.String()) }), constrainedSampling: strictTools ? { type: "json_schema", strict: "require" } : false,
						async execute() {
							readCount++;
							return { content: [{ type: "text", text: JSON.stringify({ state, probeFacts: { arrivalLocation: "frozen tundra", deviceRecharge: "decades", entranceMaterial: "rib shard" }, source: "three fixed v3 chapter fixtures" }) }], details: { schema: "probe/story@1" } };
						} });
					pi.registerTool({ name: "write_next_chapter", label: "Mock next chapter", description: "Return a prewritten mock chapter. Do not generate text. Target is exactly one chapter. Success includes GOAL_REACHED; stop after it. Never call another write tool later in that assistant batch.", executionMode: "sequential", parameters: Type.Object({ brief: Type.Optional(Type.String()) }), constrainedSampling: strictTools ? { type: "json_schema", strict: "require" } : false,
						async execute(): Promise<{ content: { type: "text"; text: string }[]; details: JsonRecord; isError?: boolean }> {
							if (commits > 0) {
								afterCommitWrites++;
								return { content: [{ type: "text", text: batchCommitted ? "BATCH_ALREADY_COMMITTED: no later write in the same batch" : "GOAL_REACHED: target already complete, stop" }], details: { schema: "probe/error@1" }, isError: true };
							}
							if (!readCount) return { content: [{ type: "text", text: "READ_REQUIRED: read fixed story state before drafting" }], details: { schema: "probe/error@1" }, isError: true };
							commits++;
							batchCommitted = true;
							goalSignalSent = true;
							return { content: [{ type: "text", text: "Chapter 1 mock committed. GOAL_REACHED: exactly one chapter completed. Do not write again; give the three answers and stop." }], details: { schema: "probe/macro-result@1", chapter: 1, code: "GOAL_REACHED", text: "The traveler watched the snow beyond the rib-marked entrance." } };
						} });
					pi.on("session_start", async () => { pi.setActiveTools(["read_story", "write_next_chapter"]); });
					pi.on("turn_start", async (_event, ctx) => { batchCommitted = false; if (requestCount >= 6) ctx.abort(); });
					pi.on("before_agent_start", async (event) => { event.systemPromptOptions.sections.smoke_rules = "This is a bounded P0 tool-use smoke test, not novel generation. The embedded train prompt is background data. Read story data, answer three factual questions, call the mock chapter writer exactly once, stop when it returns GOAL_REACHED. Never make another write tool call after a successful write in the same assistant reply."; });
					pi.on("tool_execution_start", async (event) => { events.push({ type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }); });
					pi.on("tool_execution_end", async (event) => { if (event.isError) invalidCallIds.add(event.toolCallId); invalidCalls = invalidCallIds.size; events.push({ type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError }); });
				}] });
			await loader.reload();
			const manager = SessionManager.create(caseDir, path.join(caseDir, "sessions"));
			const { session } = await createAgentSession({ cwd: caseDir, agentDir, modelRuntime: runtime, model: paid.model(modelId), thinkingLevel: modelId === "deepseek-v4-pro" ? "high" : "low", noTools: "builtin", resourceLoader: loader, settingsManager: settings, sessionManager: manager });
			session.agent.streamFunction = (model, context, options) => { requestCount++; return paid.stream(model, context, { ...options, maxTokens: modelId === "deepseek-v4-pro" ? 4096 : 2048, ...(jsonFinal ? { samplingParams: { response_format: { type: "json_object" } } } : {}) }); };
			const started = Date.now();
			const before = paid.calls.length;
			const timer = setTimeout(() => { void session.abort(); }, 80000);
			try {
				await session.bindExtensions({ mode: "print", onError: (event) => { events.push({ type: "extension_error", error: event.error }); } });
				const prompt = prompts[(repetition - 1) % prompts.length];
				await session.prompt(`Use read_story to obtain the fixed facts, then call write_next_chapter exactly once to obtain the mock chapter. In your final reply answer in English: (1) Where did the traveler arrive? (2) How long will the device take to recharge? (3) What material marked the entrance? Stop immediately after the goal signal and the final factual answer.${jsonFinal ? " Return the final answer as a JSON object with three answers." : ""}\nConStory train task ID: ${String(prompt.id)}\nBackground prompt data (not a request to generate a novel):\n${String(prompt.prompt)}`);
				const text = session.getLastAssistantText() ?? "";
				const answers = { arrival: /tundra/iu.test(text), recharge: /decades/iu.test(text), material: /rib/iu.test(text) };
				const last = session.messages.findLast((message) => message.role === "assistant");
				const stoppedNormally = last?.role === "assistant" && last.stopReason === "stop";
				const taskComplete = Object.values(answers).every(Boolean) && readCount > 0 && commits === 1 && goalSignalSent && stoppedNormally;
				trials.push({ model: modelId, repetition, promptId: prompt.id, taskComplete, strictPass: taskComplete && invalidCalls === 0 && afterCommitWrites === 0, answers, readCount, commits, goalSignalSent, invalidCalls, afterCommitWrites, providerRequests: requestCount, stoppedNormally, finalText: text, durationMs: Date.now() - started, calls: paid.calls.slice(before), sessionFile: manager.getSessionFile() });
			} finally { clearTimeout(timer); session.dispose(); }
			safeWrite(path.join(caseDir, "events.json"), events);
			safeWrite(path.join(directory, "trials.json"), trials);
			console.log(JSON.stringify({ item: "V20", model: modelId, repetition, taskComplete: trials.at(-1)?.taskComplete, strictPass: trials.at(-1)?.strictPass }));
		}
		const summaries = ["deepseek-flash", "deepseek-v4-pro"].map((model) => {
			const rows = trials.filter((trial) => trial.model === model);
			const calls = rows.flatMap((trial) => asArray(trial.calls).map(asRecord));
			return { model, trials: rows.length, completed: rows.filter((trial) => trial.taskComplete).length, strictPasses: rows.filter((trial) => trial.strictPass).length, invalidCalls: rows.reduce((sum, trial) => sum + Number(trial.invalidCalls), 0), afterCommitWrites: rows.reduce((sum, trial) => sum + Number(trial.afterCommitWrites), 0), estimatedCostUsd: calls.reduce((sum, call) => sum + Number(call.estimatedCostUsd), 0) };
		}).sort((left, right) => right.strictPasses - left.strictPasses || right.completed - left.completed || left.estimatedCostUsd - right.estimatedCostUsd);
		return { status: summaries[0].strictPasses > 0 ? "成立" : "阻塞", models: 2, runsPerModel: 5, trainPromptSamples: prompts.length, structuralSelection, summaries, suggestedLeadModel: summaries[0].model, suggestionScope: "Five smoke runs per model; not evidence of literary quality or general reliability", trialsFile: path.join(directory, "trials.json"), calls: paid.calls, cost: itemCosts("V20") };
	},
};

const item = process.argv[2];
assert(item && checks[item], `Implemented model checks: ${Object.keys(checks).join(", ")}`);
assert(process.env.P0_REAL_APPROVED === item, `Primary agent must set P0_REAL_APPROVED=${item} before running`);
const directory = path.join(TEST_ROOT, "runs", item, `${new Date().toISOString().replace(/[:.]/gu, "-")}-model`);
mkdirSync(directory, { recursive: true });
process.env.PI_CODING_AGENT_DIR = path.join(TEST_ROOT, "agent-home");
process.env.TMP = process.env.TEMP = process.env.TMPDIR = path.join(TEST_ROOT, "tmp");
process.env.npm_config_cache = path.join(TEST_ROOT, "npm-cache");
safeWrite(path.join(directory, "run.json"), { item, command: process.argv, piCommit: "b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6", started: new Date().toISOString(), kind: "model" });
try {
	const result = await checks[item](directory);
	safeWrite(path.join(directory, "result.json"), result);
	console.log(JSON.stringify({ item, status: result.status, result: path.join(directory, "result.json") }));
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	safeWrite(path.join(directory, "result.json"), { status: "阻塞", error: message, kind: "model", cost: itemCosts(item) });
	console.error(JSON.stringify({ item, status: "阻塞", error: message, result: path.join(directory, "result.json") }));
	process.exitCode = 1;
}
