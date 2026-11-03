import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CommandContext, type CommandResult, type ReadStoryQuery, readStory } from "@pi-story/core";
import { ChapterFollowUps } from "./author-input.ts";
import { BatchTracker, BranchSource, type ToolResult, toToolResult } from "./entries.ts";
import { loadSettings, type ObserveCall, type ObserveCheckpoint, SessionPorts, type Settings } from "./ports.ts";

export interface SessionState {
	id: string;
	settings: Settings;
	source: BranchSource;
	services: SessionPorts;
	batches: BatchTracker;
	stopReason?: string;
	waitingForAuthor: boolean;
	reportedStop?: string;
	gate: { sequence: number; writing: boolean };
	followUps: ChapterFollowUps;
}
export class StoryRuntime {
	private state?: SessionState;
	private readonly observe?: ObserveCall;
	private readonly checkpoint?: ObserveCheckpoint;
	private activeCallId?: string;
	constructor(observe?: ObserveCall, checkpoint?: ObserveCheckpoint) {
		this.observe = observe;
		this.checkpoint = checkpoint;
	}
	current(): SessionState | undefined {
		return this.state;
	}
	get(ctx: ExtensionContext): SessionState {
		const id = ctx.sessionManager.getSessionId();
		if (this.state?.id !== id) {
			const settings = loadSettings();
			const getEntries = () => ctx.sessionManager.getBranch();
			const source = new BranchSource(getEntries);
			const gate = { sequence: 0, writing: false };
			this.state = {
				id,
				settings,
				source,
				services: new SessionPorts(
					source,
					getEntries,
					ctx.modelRegistry,
					settings,
					(call) => this.observe?.({ ...call, toolCallId: this.activeCallId }),
					this.checkpoint ? (event) => this.checkpoint?.({ ...event, toolCallId: this.activeCallId }) : undefined,
					{ seq: () => gate.sequence },
				),
				batches: new BatchTracker(),
				waitingForAuthor: false,
				gate,
				followUps: new ChapterFollowUps(),
			};
		}
		return this.state;
	}
	async write(
		tool: string,
		callId: string,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		command: (ctx: CommandContext) => Promise<CommandResult<unknown>>,
		progress?: CommandContext["progress"],
	): Promise<ToolResult> {
		const state = this.get(ctx);
		const before = state.services.begin();
		this.activeCallId = callId;
		try {
			const commandCtx: CommandContext = {
				model: state.source.model(),
				ports: state.services.ports,
				settings: state.settings.effective,
				signal,
				progress,
				batch: state.batches.forCall(ctx.sessionManager.getBranch(), callId),
			};
			if (signal?.aborted)
				return toToolResult(tool, {
					ok: false,
					error: { code: "TRANSPORT_FAILURE", message: "作者已停止" },
					receipt: "作者已停止",
				});
			const result = await command(commandCtx);
			if (!result.ok && result.error.code === "BUDGET_EXHAUSTED") state.stopReason = "budget_exhausted";
			return toToolResult(tool, result, signal);
		} finally {
			state.services.complete(callId, before);
			this.activeCallId = undefined;
		}
	}
	read(tool: string, ctx: ExtensionContext, query: ReadStoryQuery): ToolResult {
		const result = readStory(this.get(ctx).source.model(), query);
		return toToolResult(
			tool,
			result.ok
				? { ...result, details: { schema: "story/read@1", data: result.details.data }, receipt: result.details.text }
				: result,
		);
	}
}
