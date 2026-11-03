import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { StoryRuntime } from "./session.ts";

export function registerContinuation(pi: ExtensionAPI, runtime: StoryRuntime): void {
	pi.on("agent_before_settle", (event, ctx) => {
		const state = runtime.get(ctx);
		state.services.sync();
		if (
			state.followUps.hasPending &&
			!ctx.signal?.aborted &&
			event.outcome === "completed" &&
			state.stopReason !== "budget_exhausted" &&
			state.stopReason !== "provider_error"
		) {
			state.followUps.flush(pi, ctx);
			return { continue: true };
		}
		const model = state.source.model();
		const target = model.policy.targetChapter;
		const reason =
			state.stopReason === "budget_exhausted"
				? "budget_exhausted"
				: state.stopReason === "provider_error" || model.calls.some((call) => call.failure?.kind === "fatal")
					? "provider_error"
					: ctx.signal?.aborted || event.outcome === "aborted"
						? "cancelled"
						: state.waitingForAuthor
							? "ask_author"
							: target === undefined
								? "goal_off"
								: model.lastChapter >= target
									? "goal_reached"
									: (model.failures[model.lastChapter + 1] ?? 0) >= 2
										? "consecutive_failures"
										: event.outcome !== "completed" ||
												!model.outline.some((chapter) => chapter.n === model.lastChapter + 1)
											? "error"
											: undefined;
		state.stopReason = reason;
		if (reason) {
			if (
				(target !== undefined || state.waitingForAuthor || reason === "budget_exhausted") &&
				state.reportedStop !== reason
			) {
				state.reportedStop = reason;
				return {
					entries: [
						...event.entries,
						{
							type: "custom_message" as const,
							customType: "story.stop",
							content: `写作已停止：${reason}；已提交${model.lastChapter}章，目标${target ?? "关闭"}。`,
							display: true,
						},
					],
					continue: false,
				};
			}
			return;
		}
		if (ctx.hasPendingMessages() || event.context.pendingMessages.length) return;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: "story.continue",
					content: `继续写作：作者目标第${target}章，已提交${model.lastChapter}章；按最新意图与焦点写第${model.lastChapter + 1}章。每章完成后简短汇报。`,
					display: false,
				},
			],
			continue: true,
		};
	});
}
