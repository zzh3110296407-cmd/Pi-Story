import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { BudgetCallRecord, BudgetGuard, Usage } from "@pi-story/core";
import { estimateInputTokens, sumUsage } from "../../core/src/usage/index.ts";

const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export class ProviderBudget {
	private readonly guard: InstanceType<typeof BudgetGuard>;
	private active?: BudgetCallRecord;
	private readonly pending = new Map<string, AssistantMessage>();
	private compaction: BudgetCallRecord[] | undefined;
	private wireUsage = false;
	private restoreProvider?: () => void;
	constructor(guard: InstanceType<typeof BudgetGuard>) {
		this.guard = guard;
	}
	start(model: string, input: number, output: number) {
		// A following payload can also be a Pi retry or the second split summary.
		// Settle the preceding physical attempt before reserving another one.
		if (this.active) this.finish();
		const role = this.compaction ? "compaction" : "showrunner";
		const reserved = this.guard.reserve({ role, model, inputTokensEstimate: input, maxOutputTokens: output });
		if (!reserved.ok) return reserved;
		this.active = {
			id: reserved.reservationId,
			role,
			model,
			reservedInputTokens: input,
			reservedOutputTokens: output,
			reservedCostUsd: reserved.costUsd,
			usage: null,
			status: "missing",
		};
		this.wireUsage = false;
		return reserved;
	}
	stream(data: unknown, model: Model<Api>): void {
		if (!this.active || this.active.model !== `${model.provider}/${model.id}`) return;
		// This proves presence, not the value of usage. Pi's final reply remains
		// responsible for provider-specific cache mapping and price calculation.
		if (object(data) && object(data.usage) && finite(data.usage.prompt_tokens) && finite(data.usage.completion_tokens))
			this.wireUsage = true;
	}
	finish(message?: AssistantMessage): void {
		const record = this.active;
		if (!record?.id) return;
		if (message) {
			// A valid wire usage chunk can prove zero; initialized error zeros cannot.
			record.usage = this.wireUsage || message.usage.totalTokens > 0 ? message.usage : null;
			record.stopReason = message.stopReason;
		}
		record.status =
			message && ["error", "aborted"].includes(message.stopReason) ? "failed" : record.usage ? "reported" : "missing";
		this.guard.settle(record.id, record);
		if (this.compaction) this.compaction.push(record);
		else if (message && record.usage) this.pending.set(record.id, message);
		this.active = undefined;
	}
	beginCompaction(
		registry: ModelRegistry,
		providerId: string,
		blocked: (reason: "budget_exhausted" | "provider_error") => void,
	): void {
		if (this.compaction) throw new Error("Compaction already active");
		const original = registry.getProvider(providerId);
		if (!original) throw new Error("Compaction provider missing");
		const native = registry.getRegisteredNativeProvider(providerId);
		const config = registry.getRegisteredProviderConfig(providerId);
		this.compaction = [];
		this.restoreProvider = () => {
			if (native) registry.registerProvider(native);
			else if (config) registry.registerProvider(providerId, config);
			else registry.unregisterProvider(providerId);
		};
		// Fixed Pi does not forward its main-agent request hooks to summaries.
		// Keep Pi's summary algorithm, routing, auth and retry policy; intercept
		// only this provider's summary streams until the compact event finishes.
		try {
			registry.registerProvider({
				...original,
				streamSimple: (model, context, options) => {
					const reserved = this.start(
						`${model.provider}/${model.id}`,
						estimateInputTokens(JSON.stringify(context)),
						options?.maxTokens ?? model.maxTokens,
					);
					if (!reserved.ok) {
						blocked("budget_exhausted");
						throw new Error("BUDGET_EXHAUSTED: summary not dispatched");
					}
					const stream = original.streamSimple(model, context, {
						...options,
						onResponse: async (response, responseModel) => {
							if ([401, 402, 403].includes(response.status)) blocked("provider_error");
							await options?.onResponse?.(response, responseModel);
						},
						onProviderStreamEvent: async (data, responseModel) => {
							this.stream(data, responseModel);
							await options?.onProviderStreamEvent?.(data, responseModel);
						},
					});
					const result = stream.result.bind(stream);
					let settled = false;
					stream.result = async () => {
						try {
							const message = await result();
							if (!settled) {
								this.finish(message);
								settled = true;
							}
							return message;
						} catch (error) {
							if (!settled) {
								this.finish();
								settled = true;
							}
							throw error;
						}
					};
					return stream;
				},
			});
		} catch (error) {
			this.endCompaction();
			throw error;
		}
	}
	endCompaction(usage?: Usage): void {
		try {
			this.finish();
			const known = (this.compaction ?? []).filter((record) => record.usage !== null);
			const sum = sumUsage(known);
			if (usage && sum && usage.totalTokens === sum.totalTokens && Math.abs(usage.cost.total - sum.cost.total) < 1e-10)
				this.guard.acknowledge(known.flatMap((record) => (record.id ? [record.id] : [])));
		} finally {
			this.compaction = undefined;
			this.restoreProvider?.();
			this.restoreProvider = undefined;
		}
	}
	sync(entries: readonly SessionEntry[]): void {
		for (const [id, message] of this.pending) {
			// Pinned SessionManager.appendMessage stores this message object. Identity
			// binds the actual append; identical replies never collapse by value.
			if (!entries.some((entry) => entry.type === "message" && entry.message === message)) continue;
			this.guard.acknowledge([id]);
			this.pending.delete(id);
		}
	}
}
