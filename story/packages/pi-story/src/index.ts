import type { ExtensionAPI, MessageEndEventResult } from "@earendil-works/pi-coding-agent";
import { Check, Errors } from "typebox/value";
import { type ArgumentsRepair, repairArguments, repairReceipt } from "./arguments-repair.ts";
import { registerAuthorInput } from "./author-input.ts";
import { registerBudget } from "./budget.ts";
import { registerAuthorCommands } from "./commands.ts";
import { storyProgress } from "./context.ts";
import { registerContinuation } from "./continuation.ts";
import { STORY_TOOLS, toToolResult } from "./entries.ts";
import { writeManuscript } from "./manuscript.ts";
import { registerPlanningTools } from "./planning-tools.ts";
import type { ObserveCall, ObserveCheckpoint } from "./ports.ts";
import { StoryRuntime } from "./session.ts";
import { registerMacroTool, registerOpeningTools, registerReadTools } from "./tools.ts";

export function installStory(
	pi: ExtensionAPI,
	options: { observe?: ObserveCall; checkpoint?: ObserveCheckpoint } = {},
): StoryRuntime {
	const runtime = new StoryRuntime(options.observe, options.checkpoint);
	const repairs = new Map<string, ArgumentsRepair>();
	registerAuthorCommands(pi, runtime);
	registerBudget(pi, runtime);
	registerOpeningTools(pi, runtime);
	registerReadTools(pi, runtime);
	registerMacroTool(pi, runtime);
	registerPlanningTools(pi, runtime);
	registerAuthorInput(pi, runtime);
	registerContinuation(pi, runtime);
	pi.on("session_start", (_event, ctx) => {
		repairs.clear();
		runtime.get(ctx);
		pi.setActiveTools([...STORY_TOOLS]);
		ctx.ui.setStatus("story", undefined);
	});
	pi.on("before_agent_start", (event, ctx) => {
		const state = runtime.get(ctx);
		if (event.messageType === "user") {
			state.waitingForAuthor = false;
			state.reportedStop = undefined;
			if (state.stopReason !== "budget_exhausted") state.stopReason = undefined;
		}
		const model = state.source.model();
		event.systemPromptOptions.customPrompt =
			"You are the showrunner of a fiction writing room. Use Story tools to plan and write fiction under the author's control.";
		event.systemPromptOptions.sections.story_rules = state.services.ports.rules.get("showrunner");
		event.systemPromptOptions.sections.author_intent =
			model.authorIntent || "作者尚未单独设置意图，以作者故事提示和台账为准。";
		event.systemPromptOptions.sections.current_focus = model.currentFocus || "未设置当前焦点。";
		event.systemPromptOptions.sections.story_progress = storyProgress(state);
	});
	pi.on("message_end", (event, ctx): MessageEndEventResult | undefined => {
		const message = event.message;
		if (message.role === "assistant" && message.stopReason === "toolUse") {
			let changed = false;
			const content = message.content.map((block) => {
				if (
					block.type !== "toolCall" ||
					!block.argumentsError ||
					!["submit_bible", "submit_outline"].includes(block.name)
				)
					return block;
				const tool = pi.getAllTools().find((tool) => tool.name === block.name);
				const repaired = tool ? repairArguments(block.argumentsError, tool.parameters) : undefined;
				if (!repaired) return block;
				repairs.set(block.id, repaired.repair);
				changed = true;
				const { argumentsError: _originalError, ...call } = block;
				return { ...call, arguments: repaired.arguments };
			});
			return changed ? { message: { ...message, content } } : undefined;
		}
		if (message.role === "toolResult") {
			const repair = repairs.get(message.toolCallId);
			if (repair && message.details !== null && typeof message.details === "object") {
				repairs.delete(message.toolCallId);
				return { message: repairReceipt(message, repair) };
			}
		}
		if (message.role !== "toolResult" || !message.isError) return;
		if (
			message.details !== null &&
			typeof message.details === "object" &&
			"schema" in message.details &&
			typeof message.details.schema === "string" &&
			message.details.schema.startsWith("story/")
		)
			return;
		const allowed = STORY_TOOLS.some((name) => name === message.toolName);
		const tool = pi.getAllTools().find((tool) => tool.name === message.toolName);
		const assistant = ctx.sessionManager
			.getBranch()
			.findLast(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.content.some((block) => block.type === "toolCall" && block.id === message.toolCallId),
			);
		const call =
			assistant?.type === "message" && assistant.message.role === "assistant"
				? assistant.message.content.find((block) => block.type === "toolCall" && block.id === message.toolCallId)
				: undefined;
		const argumentsError = call?.type === "toolCall" ? call.argumentsError : undefined;
		const invalid =
			allowed &&
			tool &&
			call?.type === "toolCall" &&
			(Boolean(argumentsError) || !Check(tool.parameters, call.arguments));
		const items = !allowed
			? ["toolName"]
			: argumentsError
				? ["$"]
				: invalid && tool && call?.type === "toolCall"
					? [...new Set([...Errors(tool.parameters, call.arguments)].map((issue) => issue.instancePath || "$"))]
					: undefined;
		const diagnostic =
			message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n") || "本机工具执行失败";
		const error = {
			code: !allowed || invalid ? ("DOMAIN_INVALID" as const) : ("TRANSPORT_FAILURE" as const),
			message: !allowed
				? "本阶段未启用该工具"
				: argumentsError
					? `工具参数不是有效JSON对象：${argumentsError.split("\n\nReceived arguments:")[0]}`
					: invalid
						? diagnostic.split("\n\nReceived arguments:")[0]
						: diagnostic,
			...(items ? { items } : {}),
			hint: !allowed
				? "只使用当前启用的Story工具"
				: argumentsError
					? "只提交一个完整JSON对象；修正括号或引号后重试，末尾不要多加右括号或说明文字"
					: invalid
						? message.toolName === "submit_outline"
							? "根层分别提交viewpoint、tone、chapters（可选format）；不要嵌套narration，也不要把tone或chapters编码进viewpoint字符串。修正列出的字段后重试"
							: "修正列出的参数字段后重试"
						: "检查全局设置与运行日志后重试",
		};
		const wrapped = toToolResult(message.toolName, { ok: false, error, receipt: error.message, usage: message.usage });
		const repair = repairs.get(message.toolCallId);
		if (repair) repairs.delete(message.toolCallId);
		const replacement = {
			...message,
			content: wrapped.content,
			isError: true,
			details: { schema: "story/error@1", tool: message.toolName, error },
		};
		return {
			message: repair ? repairReceipt(replacement, repair) : replacement,
		};
	});
	pi.on("turn_end", async (event, ctx) => {
		const state = runtime.get(ctx);
		state.services.sync();
		const model = state.source.model();
		if (!model.canonHead || !event.toolResultEntryIds.includes(model.canonHead)) return;
		const lastResult = event.toolResultEntryIds.at(-1);
		if (lastResult) pi.setLabel(lastResult, `第 ${model.lastChapter} 章`);
		try {
			await writeManuscript(model, state.settings.global.storiesDir, state.id, ctx.sessionManager.getSessionName());
		} catch {
			ctx.ui.notify("章节已保存在会话中，但书稿文件写入失败；请检查storiesDir与磁盘权限。", "error");
		}
	});
	return runtime;
}

export default function storyExtension(pi: ExtensionAPI): void {
	installStory(pi);
}
