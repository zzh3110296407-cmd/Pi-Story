import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { foldBranch } from "@pi-story/core";
import { schemas, validate } from "../../../packages/core/src/schema/index.ts";
import { translateBranch } from "../../../packages/pi-story/src/entries.ts";
import type { P3RpcClient } from "./rpc.ts";

const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

// Called only after the runner's fee/provenance preflight. This function sends
// the initial prompt and exactly one /goal command; it never repairs a late or
// incomplete run by sending another author prompt.
export async function driveBook(
	client: P3RpcClient,
	storyPrompt: string,
	preflight: () => void,
	maximumTarget = 10,
	exactTarget?: number,
	onPlan?: (target: number) => void,
) {
	if (!Number.isSafeInteger(maximumTarget) || maximumTarget < 1 || maximumTarget > 10)
		throw new Error("Invalid book target ceiling");
	if (
		exactTarget !== undefined &&
		(!Number.isSafeInteger(exactTarget) || exactTarget < 1 || exactTarget > maximumTarget)
	)
		throw new Error("Invalid exact development goal");
	preflight();
	let target: number | undefined;
	let goal: Promise<Record<string, unknown>> | undefined;
	let goalError: unknown;
	let askedAuthor = false;
	const dispose = client.onEvent((event) => {
		if (
			event.type === "extension_ui_request" &&
			["select", "confirm", "input", "editor"].includes(String(event.method))
		)
			askedAuthor = true;
		if (event.type !== "message_end" || !object(event.message)) return;
		const message = event.message;
		if (message.role !== "toolResult" || message.toolName !== "submit_outline" || message.isError || goal) return;
		const outline = validate(schemas.OutlineDetails, message.details);
		if (!outline.ok || !outline.value.chapters.length) return;
		target = exactTarget ?? Math.min(maximumTarget, Math.max(...outline.value.chapters.map((chapter) => chapter.n)));
		onPlan?.(target);
		goal = client.request({ type: "prompt", message: `/goal ${target}` });
		void goal.catch((error: unknown) => {
			goalError = error;
		});
	});
	try {
		await client.promptAndWait(storyPrompt);
		if (goal) await goal;
		if (goalError) throw new Error("Book goal command failed");
		const response = await client.request({ type: "get_entries" });
		if (!object(response.data) || !Array.isArray(response.data.entries))
			throw new Error("Book session evidence missing");
		const entries = response.data.entries as SessionEntry[];
		const model = foldBranch(translateBranch(entries));
		if (target !== undefined && model.policy.targetChapter !== target)
			throw new Error("Book goal was not saved in authoritative session state");
		if (target === undefined && model.outline.length)
			throw new Error("Book outline exists but its goal event was not observed");
		const stops = entries.flatMap((entry) =>
			entry.type === "custom_message" && entry.customType === "story.stop" ? [entry.content] : [],
		);
		return {
			entries,
			target: target ?? null,
			lastChapter: model.lastChapter,
			askedAuthor,
			completed: target !== undefined && model.lastChapter === target && !askedAuthor,
			stopMessages: stops,
			extraAuthorPrompts: 0,
		};
	} finally {
		dispose();
	}
}
