import type { ImageContent, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import type { StoryRuntime } from "./session.ts";

interface PendingInput {
	text: string;
	images?: ImageContent[];
	forwarding: boolean;
	accepted: boolean;
}

// Retain ownership until Pi emits the native user message, not merely until its
// void sendUserMessage API returns. This also keeps undelivered images on abort.
export class ChapterFollowUps {
	private readonly pending: PendingInput[] = [];
	get hasPending(): boolean {
		return this.pending.length > 0;
	}
	acceptDelivery(event: InputEvent): boolean {
		if (event.source !== "extension" || event.streamingBehavior !== "steer") return false;
		const next = this.pending.find((input) => input.forwarding && !input.accepted);
		if (!next || next.text !== event.text || JSON.stringify(next.images ?? []) !== JSON.stringify(event.images ?? []))
			return false;
		next.accepted = true;
		return true;
	}
	add(event: InputEvent): void {
		this.pending.push({ text: event.text, images: structuredClone(event.images), forwarding: false, accepted: false });
	}
	acknowledge(message: UserMessage): void {
		const content =
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		const text = content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const images = content.filter((part) => part.type === "image");
		const next = this.pending[0];
		if (next?.accepted && next.text === text && JSON.stringify(next.images ?? []) === JSON.stringify(images))
			this.pending.shift();
	}
	flush(pi: ExtensionAPI, ctx: ExtensionContext): void {
		if (ctx.signal?.aborted) return;
		for (const input of this.pending) {
			if (input.forwarding) continue;
			input.forwarding = true;
			pi.sendUserMessage([{ type: "text", text: input.text }, ...(input.images ?? [])], { deliverAs: "steer" });
		}
	}
	returnToAuthor(pi: ExtensionAPI, ctx: ExtensionContext): void {
		if (!this.hasPending) return;
		const text = this.pending.map((input) => input.text).join("\n\n");
		if (ctx.hasUI) ctx.ui.setEditorText([ctx.ui.getEditorText(), text].filter(Boolean).join("\n\n"));
		pi.sendMessage(
			{
				customType: "story.pending-author-input",
				content: [
					{ type: "text", text: "以下下一章意见尚未送达，已交还作者：" },
					...this.pending.flatMap((input) => [{ type: "text" as const, text: input.text }, ...(input.images ?? [])]),
				],
				details: {
					schema: "story/pending-author-input@1",
					messages: this.pending.map(({ text, images }) => ({ text, images })),
				},
				display: true,
			},
			{ triggerTurn: false },
		);
		this.pending.length = 0;
	}
}

export function registerAuthorInput(pi: ExtensionAPI, runtime: StoryRuntime): void {
	pi.on("input", (event, ctx) => {
		const state = runtime.get(ctx);
		if (state.followUps.acceptDelivery(event)) return { action: "continue" };
		if (!ctx.isIdle() && event.streamingBehavior === "followUp") {
			state.followUps.add(event);
			return { action: "handled" };
		}
		if (state.gate.writing && event.streamingBehavior === "steer") state.gate.sequence++;
		return { action: "continue" };
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "user") runtime.get(ctx).followUps.acknowledge(event.message);
	});
	pi.on("tool_execution_start", (event, ctx) => {
		if (event.toolName === "write_next_chapter") runtime.get(ctx).gate.writing = true;
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName !== "write_next_chapter") return;
		const state = runtime.get(ctx);
		state.gate.writing = false;
		if (state.stopReason !== "budget_exhausted" && state.stopReason !== "provider_error")
			state.followUps.flush(pi, ctx);
	});
	pi.on("agent_settled", (_event, ctx) => runtime.get(ctx).followUps.returnToAuthor(pi, ctx));
}
