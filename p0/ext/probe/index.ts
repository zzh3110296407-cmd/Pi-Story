/** Reproduce: p0/scripts/pi.ps1 --provider probe-faux --model script -p "probe". */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerScriptProvider } from "./script-provider.ts";

type JsonObject = Record<string, unknown>;
interface FoldedState {
	writes: { entryId: string; n: number }[];
	commits: { entryId: string; chapter: number }[];
	control: string;
	goal: number | null;
	interrupted: string[];
}

function object(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function fold(ctx: ExtensionContext): FoldedState {
	const state: FoldedState = { writes: [], commits: [], control: "", goal: null, interrupted: [] };
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom") {
			const data = object(entry.data);
			if (entry.customType === "probe.control" && typeof data?.text === "string") state.control = data.text;
			if (entry.customType === "probe.goal" && typeof data?.n === "number") state.goal = data.n;
			if (entry.customType === "probe.interrupted" && typeof data?.toolCallId === "string") state.interrupted.push(data.toolCallId);
		}
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const message = entry.message;
		const details = object(message.details);
		if (message.isError || details?.ok === false || !message.toolName.startsWith("probe_")) continue;
		if (typeof details?.schema !== "string" || !details.schema.startsWith("probe/")) continue;
		if (details.schema === "probe/write@1" && typeof details.n === "number") state.writes.push({ entryId: entry.id, n: details.n });
		if (details.schema === "probe/commit@1" && typeof details.chapter === "number") state.commits.push({ entryId: entry.id, chapter: details.chapter });
	}
	return state;
}

export default function probe(pi: ExtensionAPI): void {
	const runRoot = process.env.PROBE_RUN_DIR;
	const allowedRoot = resolve("D:/开源/test");
	if (!runRoot || !resolve(runRoot).toLowerCase().startsWith(`${allowedRoot.toLowerCase()}${sep}`)) {
		throw new Error("PROBE_RUN_DIR must be a directory below D:/开源/test");
	}
	mkdirSync(runRoot, { recursive: true });
	const eventsFile = join(runRoot, "events.jsonl");
	const appendEvidence = (file: string, value: unknown): void => {
		const line = JSON.stringify(value);
		const key = process.env.DEEPSEEK_API_KEY;
		if ((key && line.includes(key)) || /sk-[A-Za-z0-9_-]{16,}/u.test(line)) {
			if (existsSync(file)) unlinkSync(file);
			throw new Error("Secret detected; probe evidence file removed");
		}
		appendFileSync(file, `${line}\n`, "utf8");
	};
	const log = (type: string, data: unknown): void => appendEvidence(eventsFile, { time: new Date().toISOString(), type, data });
	registerScriptProvider(pi, log);
	let interjectSequence = 0;
	let batchCommitted = false;
	let waitingForAuthor = false;
	let promptSequence = 0;
	const budgetBlocked = process.env.PROBE_BUDGET_BLOCK === "1";
	const toolNames = ["probe_write", "probe_read", "probe_commit", "probe_slow", "probe_llm", "probe_ask"];
	const errorResult = (code: string) => ({ content: [{ type: "text" as const, text: code }], details: { schema: "probe/error@1", ok: false, code }, isError: true });

	pi.registerTool({
		name: "probe_write", label: "Probe write", description: "Record one numbered probe value", executionMode: "sequential",
		parameters: Type.Object({ n: Type.Number() }),
		async execute(toolCallId, params, _signal, _update, ctx) {
			if (batchCommitted) return errorResult("BATCH_ALREADY_COMMITTED");
			const visible = fold(ctx).writes;
			const details = { schema: "probe/write@1", n: params.n, visible, observedAt: Date.now() };
			log("probe_write", { toolCallId, ...details });
			return { content: [{ type: "text", text: `wrote ${params.n}` }], details };
		},
	});
	pi.registerTool({
		name: "probe_read", label: "Probe read", description: "Read current branch probe state", parameters: Type.Object({}),
		async execute(toolCallId, _params, _signal, _update, ctx) {
			const state = fold(ctx);
			log("probe_read", { toolCallId, state });
			return { content: [{ type: "text", text: JSON.stringify(state) }], details: { schema: "probe/read@1", state } };
		},
	});
	pi.registerTool({
		name: "probe_commit", label: "Probe commit", description: "Commit a numbered probe chapter", executionMode: "sequential",
		parameters: Type.Object({ chapter: Type.Integer({ minimum: 1 }), sizeKB: Type.Optional(Type.Number({ minimum: 0, maximum: 20480 })) }),
		async execute(toolCallId, params, signal, _update, ctx) {
			if (batchCommitted) return errorResult("BATCH_ALREADY_COMMITTED");
			const state = fold(ctx);
			if (state.goal !== null && state.commits.length >= state.goal) return errorResult("GOAL_REACHED");
			const delayMs = Number(process.env.PROBE_COMMIT_DELAY_MS ?? 0);
			if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60000) return errorResult("INVALID_COMMIT_DELAY");
			if (delayMs) await setTimeout(delayMs, undefined, { signal });
			batchCommitted = true;
			const text = "x".repeat(Math.floor((params.sizeKB ?? 1) * 1024));
			log("probe_commit", { toolCallId, chapter: params.chapter, bytes: text.length });
			return { content: [{ type: "text", text: `committed ${params.chapter}` }], details: { schema: "probe/commit@1", chapter: params.chapter, text } };
		},
	});
	pi.registerTool({
		name: "probe_slow", label: "Probe slow", description: "Wait and reject if immediately interjected", executionMode: "sequential",
		parameters: Type.Object({ ms: Type.Number({ minimum: 0, maximum: 60000 }), previewText: Type.Optional(Type.String()) }),
		async execute(toolCallId, params, signal, onUpdate) {
			const startSequence = interjectSequence;
			log("probe_slow_start", { toolCallId, startSequence });
			onUpdate?.({ content: [{ type: "text", text: "waiting" }], details: { schema: "probe/progress@1", previewText: params.previewText ?? "", step: "waiting" } });
			await setTimeout(params.ms, undefined, { signal });
			if (startSequence !== interjectSequence) return errorResult("INTERJECTED");
			return { content: [{ type: "text", text: "wait complete" }], details: { schema: "probe/slow@1", toolCallId, startSequence, endSequence: interjectSequence } };
		},
	});
	pi.registerTool({
		name: "probe_ask", label: "Probe ask", description: "Ask author or report unavailable UI", executionMode: "sequential",
		parameters: Type.Object({ question: Type.String() }),
		async execute(_toolCallId, params, _signal, _update, ctx) {
			waitingForAuthor = true;
			const answer = ctx.hasUI ? await ctx.ui.input(params.question) : "作者不在场，请自行决定";
			log("probe_ask", { hasUI: ctx.hasUI, mode: ctx.mode, answer });
			return { content: [{ type: "text", text: answer ?? "cancelled" }], details: { schema: "probe/ask@1", answer: answer ?? null, hasUI: ctx.hasUI, mode: ctx.mode } };
		},
	});
	pi.registerTool({
		name: "probe_llm", label: "Probe llm", description: "One bounded model call for approved P0 real-model items", executionMode: "sequential",
		parameters: Type.Object({ prompt: Type.String(), model: Type.Optional(Type.String()) }),
		async execute(_toolCallId, params, signal, _update, ctx) {
			const faux = process.env.PROBE_ALLOW_FAUX_LLM === "1" && params.model === "probe-faux/script";
			if (!faux && process.env.PROBE_ALLOW_REAL_MODEL !== "1") return errorResult("REAL_MODEL_NOT_ENABLED");
			if (budgetBlocked) return errorResult("BUDGET_EXHAUSTED");
			const item = process.env.PROBE_ITEM ?? "";
			const itemLimits: Record<string, number> = { V06: 0.1, V10: 0.3, V16: 0.2, V17: 0.2, V18: 0.2, V19: 2, V20: 4.5, V27: 0.3 };
			if (!faux && !(item in itemLimits)) return errorResult("REAL_MODEL_ITEM_NOT_APPROVED");
			const modelName = params.model ?? "deepseek/deepseek-flash";
			if (!faux && modelName !== "deepseek/deepseek-flash" && !(item === "V20" && modelName === "deepseek/deepseek-v4-pro")) return errorResult("REAL_MODEL_NOT_APPROVED");
			const [provider, ...parts] = modelName.split("/");
			const model = ctx.modelRegistry.find(provider, parts.join("/"));
			if (!model) return errorResult("MODEL_NOT_FOUND");
			const ledgerFile = resolve("D:/开源/test/pi-Story/p0/runs/usage-ledger.jsonl");
			mkdirSync(resolve("D:/开源/test/pi-Story/p0/runs"), { recursive: true });
			const ledger = existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as JsonObject) : [];
			const itemGroup = item === "V17" ? "V16" : item;
			let totalCost = 0;
			let itemCost = 0;
			for (const row of ledger) {
				const amount = typeof row.estimatedCostUsd === "number" ? row.estimatedCostUsd : typeof row.reservedCostUsd === "number" ? row.reservedCostUsd : 0;
				totalCost += amount;
				if (row.item === itemGroup || (itemGroup === "V16" && row.item === "V17")) itemCost += amount;
			}
			const reservedInputTokens = Math.ceil(params.prompt.length * 2) + 8192;
			const reservedOutputTokens = 256;
			const reservedCostUsd = (reservedInputTokens * model.cost.input + reservedOutputTokens * model.cost.output) / 1000000;
			if (!faux && (!Number.isFinite(reservedCostUsd) || reservedCostUsd <= 0)) return errorResult("MODEL_PRICE_UNKNOWN");
			if (!faux && (totalCost >= 8 || totalCost + reservedCostUsd > 10 || itemCost + reservedCostUsd > itemLimits[item])) return errorResult("BUDGET_EXHAUSTED");
			const startedAt = Date.now();
			let usageReceived = false;
			const response = await ctx.modelRegistry.complete(model, { messages: [{ role: "user", content: params.prompt, timestamp: startedAt }] }, {
				maxTokens: reservedOutputTokens,
				signal,
				onProviderStreamEvent: (data) => {
					const chunk = object(data);
					if (object(chunk?.usage)) usageReceived = true;
					if (Array.isArray(chunk?.choices) && chunk.choices.some((choice) => object(object(choice)?.usage))) usageReceived = true;
				},
			});
			const usage = usageReceived ? response.usage : null;
			const status = response.stopReason === "error" || response.stopReason === "aborted" ? "failed" : usageReceived ? "reported" : "missing";
			const call = { role: "keeper", model: modelName, reservedInputTokens, reservedOutputTokens, reservedCostUsd, usage, status, stopReason: response.stopReason, durationMs: Date.now() - startedAt };
			if (!faux) appendEvidence(ledgerFile, { time: new Date().toISOString(), item, toolCallId: _toolCallId, ...call, estimatedCostUsd: usage?.cost.total ?? reservedCostUsd });
			log("probe_llm", call);
			return { content: [{ type: "text", text: response.content.filter((block) => block.type === "text").map((block) => block.text).join("") }], details: { schema: "probe/llm@1", calls: [call] }, ...(usage ? { usage } : {}), isError: status === "failed" };
		},
	});

	pi.registerCommand("probe-intent", {
		description: "View or update author-only intent",
		handler: async (args, ctx) => {
			const text = args.trim() || await ctx.ui.editor("Probe intent", fold(ctx).control);
			if (text === undefined) return;
			pi.appendEntry("probe.control", { schema: "probe/control@1", text });
			log("probe_intent", { text, leafId: ctx.sessionManager.getLeafId() });
			pi.sendMessage({ customType: "probe.notice", content: `Author intent changed: ${text}`, display: false }, { deliverAs: "steer" });
			ctx.ui.notify("Probe intent saved", "info");
		},
	});
	pi.registerCommand("probe-branch", {
		description: "Navigate to a branch entry without summary",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) { ctx.ui.notify("NOT_IDLE: 需要空闲", "error"); return; }
			await ctx.navigateTree(args.trim(), { summarize: false });
			log("probe_branch", { leafId: ctx.sessionManager.getLeafId(), state: fold(ctx) });
		},
	});
	pi.registerCommand("probe-goal", {
		description: "Set probe chapter goal",
		handler: async (args, ctx) => {
			const n = Number(args.trim());
			if (!Number.isInteger(n) || n < 0) { ctx.ui.notify("Goal must be a nonnegative integer", "error"); return; }
			pi.appendEntry("probe.goal", { n });
			log("probe_goal", { n });
		},
	});
	pi.registerCommand("probe-state", {
		description: "Report folded probe state",
		handler: async (_args, ctx) => { const state = fold(ctx); log("probe_state", state); ctx.ui.notify(JSON.stringify(state), "info"); },
	});
	pi.on("session_start", async (_event, ctx) => {
		pi.setActiveTools(toolNames);
		const state = fold(ctx);
		const completed = new Set<string>();
		const calls = new Set<string>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			if (entry.message.role === "toolResult") completed.add(entry.message.toolCallId);
			if (entry.message.role === "assistant") for (const block of entry.message.content) {
				if (block.type === "toolCall" && block.name.startsWith("probe_")) calls.add(block.id);
			}
		}
		for (const toolCallId of calls) {
			if (!completed.has(toolCallId) && !state.interrupted.includes(toolCallId)) pi.appendEntry("probe.interrupted", { schema: "probe/interrupted@1", toolCallId });
		}
		log("session_start", { state: fold(ctx), mode: ctx.mode, hasUI: ctx.hasUI });
	});
	pi.on("session_tree", async (_event, ctx) => { log("session_tree", { state: fold(ctx) }); });
	pi.on("before_agent_start", async (event, ctx) => {
		const state = fold(ctx);
		waitingForAuthor = false;
		event.systemPromptOptions.sections.probe_rules = "Use only probe tools. Author intent is author-owned. Scripted P0 probe rules." + (process.env.PROBE_RULES_TEXT_FILE ? `\n${readFileSync(process.env.PROBE_RULES_TEXT_FILE, "utf8")}` : "");
		event.systemPromptOptions.sections.probe_intent = state.control || "No author intent";
		event.systemPromptOptions.sections.probe_progress = `round=${++promptSequence};committed=${state.commits.length};writes=${state.writes.length};goal=${state.goal ?? "none"}`;
		ctx.ui.setStatus("story", "working");
		log("before_agent_start", { sections: event.systemPromptOptions.sections });
	});
	pi.on("turn_start", async (event) => { batchCommitted = false; log("turn_start", event); });
	pi.on("turn_end", async (event, ctx) => {
		const commit = event.toolResults.find((result) => result.toolName === "probe_commit" && !result.isError);
		const chapter = object(commit?.details)?.chapter;
		const lastEntry = event.toolResultEntryIds.at(-1);
		if (typeof chapter === "number" && lastEntry) pi.setLabel(lastEntry, `第 ${chapter} 章`);
		log("turn_end", { toolResultEntryIds: event.toolResultEntryIds, chapter, state: fold(ctx), usage: event.message.role === "assistant" ? event.message.usage : null });
		if (process.env.PROBE_CONTEXT_EDIT === "1") {
			const branch = ctx.sessionManager.getBranch();
			const edited = new Set(branch.filter((entry) => entry.type === "context_edit").map((entry) => entry.targetId));
			const target = branch.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "probe_read" && !edited.has(entry.id));
			if (target) return { entries: [{ type: "context_edit", targetId: target.id, replacement: { content: [{ type: "text", text: "P0 probe read result replaced by context edit" }] } }] };
		}
	});
	pi.on("agent_before_settle", async (event, ctx) => {
		const state = fold(ctx);
		const shouldContinue = state.goal !== null && state.commits.length < state.goal && !waitingForAuthor && !budgetBlocked && !ctx.signal?.aborted && event.outcome === "completed";
		log("agent_before_settle", { shouldContinue, waitingForAuthor, budgetBlocked, outcome: event.outcome });
		if (shouldContinue) return { entries: [...event.entries, { type: "custom_message", customType: "probe.continue", content: `Continue to goal ${state.goal}; next chapter ${state.commits.length + 1}`, display: false }], continue: true };
	});
	pi.on("input", async (event) => {
		if (event.streamingBehavior === "steer") interjectSequence++;
		log("input", { ...event, interjectSequence });
		return { action: "continue" };
	});
	pi.on("before_provider_request", async (event, ctx) => {
		log("before_provider_request", { payload: event.payload });
		if (budgetBlocked) {
			log("budget_request_aborted", { reason: "BUDGET_EXHAUSTED" });
			ctx.abort();
		}
	});
	pi.on("session_before_compact", async (event) => {
		log("session_before_compact", { reason: event.type, budgetBlocked });
		if (budgetBlocked || process.env.PROBE_CANCEL_COMPACT === "1") return { cancel: true };
	});
	pi.on("agent_settled", async (event) => { log("agent_settled", event); });
	pi.on("tool_execution_start", async (event) => { log("tool_execution_start", event); });
	pi.on("tool_execution_update", async (event) => { log("tool_execution_update", event); });
	pi.on("tool_execution_end", async (event) => {
		const details = object(object(event.result)?.details);
		log("tool_execution_end", { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, schema: details?.schema });
	});
}
