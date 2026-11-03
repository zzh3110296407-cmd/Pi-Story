import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	type BranchEntry,
	type CommandResult,
	type EntrySource,
	type FoldCache,
	foldBranch,
	type Usage,
} from "@pi-story/core";
import { validRepair } from "./arguments-repair.ts";

export const STORY_TOOLS = [
	"submit_constraints",
	"submit_bible",
	"submit_outline",
	"write_next_chapter",
	"read_story",
	"read_chapter",
	"read_state",
	"get_character",
	"ask_author",
	"update_bible",
	"patch_outline",
] as const;
export type StoryTool = (typeof STORY_TOOLS)[number];
const resultSchemas: Record<StoryTool, string> = {
	submit_constraints: "story/constraints@1",
	submit_bible: "story/bible@1",
	submit_outline: "story/outline@1",
	write_next_chapter: "story/macro-result@1",
	read_story: "story/read@1",
	read_chapter: "story/read@1",
	read_state: "story/read@1",
	get_character: "story/read@1",
	ask_author: "story/read@1",
	update_bible: "story/bible@1",
	patch_outline: "story/outline@1",
};
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

export function coreDetails(toolName: string, details: unknown): unknown {
	// The validated syntax receipt belongs to the Pi envelope, not the domain
	// result. Keep malformed receipts so strict domain validation still rejects them.
	if (
		["submit_bible", "submit_outline"].includes(toolName) &&
		record(details) &&
		validRepair(details.argumentsRepair)
	) {
		const { argumentsRepair: _repair, ...domain } = details;
		return domain;
	}
	return details;
}

export function translateBranch(entries: readonly SessionEntry[]): BranchEntry[] {
	const calls = new Map<string, string>();
	const result: BranchEntry[] = [];
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType.startsWith("story."))
			result.push({ kind: "custom", entryId: entry.id, customType: entry.customType, data: entry.data });
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") calls.set(block.id, block.name);
		} else if (message.role === "user") {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("\n");
			result.push({ kind: "authorMessage", entryId: entry.id, text });
		} else if (
			message.role === "toolResult" &&
			calls.get(message.toolCallId) === message.toolName &&
			Object.hasOwn(resultSchemas, message.toolName)
		) {
			const details = coreDetails(message.toolName, message.details);
			if (
				record(details) &&
				(details.schema === resultSchemas[message.toolName as StoryTool] || details.schema === "story/error@1")
			)
				result.push({
					kind: "toolResult",
					entryId: entry.id,
					toolName: message.toolName,
					isError: message.isError,
					details,
				});
		}
	}
	return result;
}

export class BranchSource implements EntrySource {
	private readonly getEntries: () => readonly SessionEntry[];
	private readonly cache: FoldCache = {};
	constructor(getEntries: () => readonly SessionEntry[]) {
		this.getEntries = getEntries;
	}
	branch(): BranchEntry[] {
		return translateBranch(this.getEntries());
	}
	model() {
		return foldBranch(this.branch(), this.cache);
	}
	authorMessage(entryId: string): string | null {
		const entry = this.branch().find((entry) => entry.entryId === entryId && entry.kind === "authorMessage");
		return entry?.kind === "authorMessage" ? entry.text : null;
	}
}

export class BatchTracker {
	private current?: { id: string; state: { committed: boolean } };
	forCall(entries: readonly SessionEntry[], callId: string): { committed: boolean } {
		const assistant = entries.findLast(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some((block) => block.type === "toolCall" && block.id === callId),
		);
		if (!assistant) throw new Error("Tool call is not in a persisted assistant message");
		if (this.current?.id !== assistant.id) this.current = { id: assistant.id, state: { committed: false } };
		return this.current.state;
	}
}

export interface ToolResult {
	content: { type: "text"; text: string }[];
	details: unknown;
	usage?: Usage;
	isError?: boolean;
}
export function toToolResult(tool: string, result: CommandResult<unknown>, signal?: AbortSignal): ToolResult {
	let details = result.details;
	let error = result.ok ? undefined : result.error;
	if (signal?.aborted && result.ok) {
		error = { code: "TRANSPORT_FAILURE", message: "作者已停止，本次结果未提交", hint: "需要时在下一轮重新发起" };
		if (record(details) && details.schema === "story/macro-result@1") {
			const { commit: _commit, ...uncommitted } = details;
			details = { ...uncommitted, ok: false, error };
		} else details = undefined;
	}
	return {
		content: [
			{
				type: "text",
				text: error
					? `错误 ${error.code}：${error.message}。${error.items?.length ? `相关字段：${error.items.join("、")}。` : ""}建议：${error.hint ?? "核对输入后重试"}`
					: result.receipt,
			},
		],
		details: details ?? { schema: "story/error@1", tool, error },
		...(error ? { isError: true } : {}),
		...(result.usage ? { usage: result.usage } : {}),
	};
}
