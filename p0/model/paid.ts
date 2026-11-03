/** Reproduce through verify-model.ts; every request is bounded and recorded before the next request. */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import {
	type Api, type AssistantMessage, type AssistantMessageEventStream, type Context,
	createAssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { asRecord, checkSecret, type JsonRecord, safeWrite, TEST_ROOT } from "../rpc/client.ts";

export const ITEM_LIMITS: Record<string, number> = { V06: 0.1, V10: 0.3, V16: 0.2, V17: 0.2, V18: 0.2, V27: 0.3, V19: 2, V20: 4.5 };
export const LEDGER = path.join(TEST_ROOT, "runs/usage-ledger.jsonl");

export function ledgerRows(): JsonRecord[] {
	return existsSync(LEDGER) ? readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((line) => asRecord(JSON.parse(line))) : [];
}

export function ledgerAmount(row: JsonRecord): number {
	const amount = row.estimatedCostUsd ?? row.reservedCostUsd;
	assert(typeof amount === "number" && Number.isFinite(amount) && amount >= 0, "Every ledger row must have a known or reserved amount");
	return amount;
}

export function itemCosts(item: string): { total: number; item: number } {
	const rows = ledgerRows();
	return {
		total: rows.reduce((sum, row) => sum + ledgerAmount(row), 0),
		item: rows.filter((row) => item === "V16" || item === "V17" ? row.item === "V16" || row.item === "V17" : row.item === item).reduce((sum, row) => sum + ledgerAmount(row), 0),
	};
}

export function appendLedger(row: JsonRecord): void {
	const line = JSON.stringify(row);
	try { checkSecret(line); } catch (error) { if (existsSync(LEDGER)) unlinkSync(LEDGER); throw error; }
	mkdirSync(path.dirname(LEDGER), { recursive: true });
	appendFileSync(LEDGER, `${line}\n`, "utf8");
}

export async function createRuntime(): Promise<ModelRuntime> {
	return ModelRuntime.create({ authPath: path.join(TEST_ROOT, "agent-home/model-auth.json"), modelsPath: null, allowModelNetwork: false });
}

export class PaidProbe {
	readonly calls: JsonRecord[] = [];
	private sequence = 0;
	private inFlightUsd = 0;
	readonly item: string;
	readonly directory: string;
	readonly runtime: ModelRuntime;
	constructor(item: string, directory: string, runtime: ModelRuntime) {
		this.item = item;
		this.directory = directory;
		this.runtime = runtime;
		assert(process.env.P0_REAL_APPROVED === item, `Set P0_REAL_APPROVED=${item} only after the primary agent releases this item`);
		assert(process.env.DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY is absent; no provider call made");
		assert(item in ITEM_LIMITS, "Real calls are not approved for this item");
	}

	model(id = "deepseek-flash"): Model<Api> {
		assert(id === "deepseek-flash" || (this.item === "V20" && id === "deepseek-v4-pro"), "Model is outside the approved item scope");
		const model = this.runtime.getModel("deepseek", id);
		assert(model, `Pinned model catalog does not contain deepseek/${id}`);
		assert(model.cost.input > 0 && model.cost.output > 0, "Unknown model prices cannot enforce an amount cap");
		return model;
	}

	stream(model: Model<Api>, context: Context | TranscriptContext, options: SimpleStreamOptions = {}): AssistantMessageEventStream {
		assert(!existsSync(path.join(TEST_ROOT, "runs", `${this.item}.stop`)), `${this.item} stopped by the primary agent before the next provider request`);
		assert(model.provider === "deepseek", "PaidProbe only dispatches the approved DeepSeek provider");
		this.model(model.id);
		const maxTokens = options.maxTokens ?? 512;
		const serialized = JSON.stringify(context);
		checkSecret(serialized);
		const estimatorFile = path.join(TEST_ROOT, "input-estimator.json");
		const estimator = existsSync(estimatorFile) ? asRecord(JSON.parse(readFileSync(estimatorFile, "utf8"))) : null;
		let reservedInputTokens = Math.ceil(serialized.length * 2) + 2048;
		if (estimator) {
			assert(typeof estimator.cjkCoefficient === "number" && typeof estimator.latinCoefficient === "number" && typeof estimator.fixedOverhead === "number", "Invalid calibrated estimator");
			const cjk = [...serialized].filter((character) => /[\u2e80-\u9fff\uf900-\ufaff]/u.test(character)).length;
			reservedInputTokens = Math.ceil(cjk * estimator.cjkCoefficient + (serialized.length - cjk) * estimator.latinCoefficient + estimator.fixedOverhead);
		}
		const reservedCostUsd = (reservedInputTokens * model.cost.input + maxTokens * model.cost.output) / 1000000;
		const costs = itemCosts(this.item);
		assert(costs.total < 8, "P0 real-model stop threshold reached ($8)");
		assert(costs.total + this.inFlightUsd + reservedCostUsd <= 10, "P0 $10 budget would be exceeded");
		assert(costs.item + this.inFlightUsd + reservedCostUsd <= ITEM_LIMITS[this.item], `${this.item} item budget would be exceeded`);
		this.inFlightUsd += reservedCostUsd;
		const id = `${this.item}-${path.basename(this.directory)}-${String(++this.sequence).padStart(3, "0")}`;
		const started = Date.now();
		const outer = createAssistantMessageEventStream();
		let usageReceived = false;
		let fetchInvocations = 0;
		let networkAttempts = 0;
		let httpStatus: number | null = null;
		const realFetch = globalThis.fetch;
		void (async () => {
			let response: AssistantMessage | undefined;
			try {
				const stream = this.runtime.streamSimple(model, context, {
					...options,
					maxTokens,
					maxRetries: 0,
					timeoutMs: 90000,
					onPayload: async (payload, actualModel) => {
						const replacement = await options.onPayload?.(payload, actualModel);
						safeWrite(path.join(this.directory, `${id}-request.json`), replacement ?? payload);
						return replacement;
					},
					fetch: async (input, init) => {
						fetchInvocations++;
						const aborted = init?.signal?.aborted ?? false;
						if (!aborted) networkAttempts++;
						const result = await realFetch(input, init);
						httpStatus = result.status;
						return result;
					},
					onResponse: async (result, actualModel) => { httpStatus = result.status; await options.onResponse?.(result, actualModel); },
					onProviderStreamEvent: async (data, actualModel) => {
						if (data && typeof data === "object") {
							const chunk = asRecord(data);
							if (chunk.usage && typeof chunk.usage === "object") usageReceived = true;
							if (Array.isArray(chunk.choices) && chunk.choices.some((choice) => asRecord(choice).usage)) usageReceived = true;
						}
						await options.onProviderStreamEvent?.(data, actualModel);
					},
				});
				for await (const event of stream) if (event.type !== "done" && event.type !== "error") outer.push(event);
				response = await stream.result();
			} catch (error) {
				response = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: options.signal?.aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : String(error), timestamp: started,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			} finally {
				this.inFlightUsd -= reservedCostUsd;
				if (response) {
					const usage = usageReceived ? response.usage : null;
					const row = { time: new Date().toISOString(), item: this.item, callId: id, model: `${model.provider}/${model.id}`, reservedInputTokens, reservedOutputTokens: maxTokens, reservedCostUsd, inputEstimator: estimator ? estimatorFile : "initial-2-per-character-plus-2048", usage,
						status: response.stopReason === "error" || response.stopReason === "aborted" ? "failed" : usage ? "reported" : "missing",
						estimatedCostUsd: usage?.cost.total ?? (networkAttempts > 0 ? reservedCostUsd : 0), inputTokens: usage?.input ?? null, outputTokens: usage?.output ?? null,
						cacheReadTokens: usage?.cacheRead ?? null, cacheWriteTokens: usage?.cacheWrite ?? null, totalInputTokens: usage ? usage.input + usage.cacheRead + usage.cacheWrite : null,
						stopReason: response.stopReason, fetchInvocations, networkAttempts, httpStatus, durationMs: Date.now() - started };
					appendLedger(row);
					this.calls.push(row);
					safeWrite(path.join(this.directory, `${id}-response.json`), { response, record: row });
					if (response.stopReason === "error" || response.stopReason === "aborted") outer.push({ type: "error", reason: response.stopReason, error: response });
					else outer.push({ type: "done", reason: response.stopReason === "toolUse" ? "toolUse" : response.stopReason === "length" ? "length" : "stop", message: response });
					outer.end(response);
				}
			}
		})();
		return outer;
	}

	async call(model: Model<Api>, context: Context, options: SimpleStreamOptions = {}): Promise<AssistantMessage> {
		const stream = this.stream(model, context, options);
		for await (const _event of stream) { /* Finish evidence bookkeeping before the next call. */ }
		return stream.result();
	}
}
