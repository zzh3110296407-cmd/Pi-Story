import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimateInputTokens } from "../../core/src/usage/index.ts";
import { storyProgress } from "./context.ts";
import type { SessionState, StoryRuntime } from "./session.ts";

function recordBudgetStop(pi: ExtensionAPI, state: SessionState, ctx: ExtensionContext): void {
	if (state.reportedStop === "budget_exhausted") return;
	state.reportedStop = "budget_exhausted";
	const progress: { lastChapter: number; targetChapter: number | null } = JSON.parse(storyProgress(state));
	pi.sendMessage(
		{
			customType: "story.stop",
			content: `写作已停止：budget_exhausted；已提交${progress.lastChapter}章，目标${progress.targetChapter ?? "关闭"}。`,
			details: { reason: "budget_exhausted", progress },
			display: true,
		},
		{ triggerTurn: false },
	);
	ctx.ui.setStatus("story", `预算耗尽；已提交${progress.lastChapter}章`);
}

export function registerBudget(pi: ExtensionAPI, runtime: StoryRuntime): void {
	pi.on("before_provider_request", (event, ctx) => {
		const state = runtime.get(ctx);
		state.services.sync();
		if (!ctx.model || state.stopReason === "provider_error" || state.stopReason === "budget_exhausted") {
			if (state.stopReason === "budget_exhausted") recordBudgetStop(pi, state, ctx);
			ctx.abort();
			return;
		}
		try {
			const payload =
				event.payload !== null && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
			const output = payload.max_tokens ?? payload.max_completion_tokens ?? ctx.model.maxTokens;
			if (typeof output !== "number" || !Number.isSafeInteger(output) || output < 1)
				throw new Error("Invalid output ceiling");
			const reserved = state.services.providerBudget.start(
				`${ctx.model.provider}/${ctx.model.id}`,
				estimateInputTokens(JSON.stringify(event.payload)),
				output,
			);
			if (!reserved.ok) {
				state.stopReason = "budget_exhausted";
				recordBudgetStop(pi, state, ctx);
				ctx.ui.notify(`${reserved.error.code}：${reserved.error.message}`, "warning");
				ctx.abort();
			}
		} catch {
			state.stopReason = "error";
			ctx.ui.notify("主笔预算检查失败，已在派发前停止。", "error");
			ctx.abort();
		}
	});
	pi.on("provider_stream_event", (event, ctx) => {
		const model = ctx.modelRegistry.find(event.provider, event.model);
		if (model) runtime.get(ctx).services.providerBudget.stream(event.data, model);
	});
	pi.on("after_provider_response", (event, ctx) => {
		if ([401, 402, 403].includes(event.status)) {
			runtime.get(ctx).stopReason = "provider_error";
			ctx.ui.notify(`HTTP ${event.status}：提供方拒绝，整次运行已停止。`, "error");
			ctx.abort();
		}
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") runtime.get(ctx).services.providerBudget.finish(event.message);
	});
	pi.on("session_before_compact", (event, ctx) => {
		const state = runtime.get(ctx);
		state.services.sync();
		if (!ctx.model) {
			state.stopReason = "error";
			return { cancel: true };
		}
		const prepared = event.preparation;
		const output =
			Math.min(Math.floor(0.8 * prepared.settings.reserveTokens), ctx.model.maxTokens) +
			(prepared.isSplitTurn ? Math.min(Math.floor(0.5 * prepared.settings.reserveTokens), ctx.model.maxTokens) : 0);
		const checked = state.services.guard.check({
			role: "compaction",
			model: `${ctx.model.provider}/${ctx.model.id}`,
			inputTokensEstimate: estimateInputTokens(
				JSON.stringify({
					messages: prepared.messagesToSummarize,
					prefix: prepared.turnPrefixMessages,
					previousSummary: prepared.previousSummary,
					instructions: event.customInstructions,
				}),
			),
			maxOutputTokens: output,
		});
		if (!checked.ok) {
			state.stopReason = "budget_exhausted";
			ctx.ui.notify("压缩前预算不足，自动写作已暂停。", "warning");
			return { cancel: true };
		}
		try {
			state.services.providerBudget.beginCompaction(ctx.modelRegistry, ctx.model.provider, (reason) => {
				state.stopReason = reason;
				ctx.abort();
			});
		} catch {
			state.stopReason = "error";
			ctx.ui.notify("压缩预算接线失败，已取消压缩。", "error");
			return { cancel: true };
		}
	});
	pi.on("session_compact", (event, ctx) =>
		runtime.get(ctx).services.providerBudget.endCompaction(event.compactionEntry.usage),
	);
	pi.on("session_compact_failed", (_event, ctx) => runtime.get(ctx).services.providerBudget.endCompaction());
}
