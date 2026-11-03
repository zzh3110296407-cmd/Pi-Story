import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { MacroDetails } from "@pi-story/core";
import type { Scenario, Setup } from "./datasets.ts";
import type { MeasuredSession } from "./session.ts";

const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
function jsonObject(value: unknown): ToolCall["arguments"] {
	const copy: unknown = JSON.parse(JSON.stringify(value));
	if (!object(copy)) throw new Error("Fixture arguments must be a JSON object");
	return copy as ToolCall["arguments"];
}

export class ReplyQueue {
	private readonly queue: Array<(context: TranscriptContext) => AssistantMessage> = [];
	push(...replies: Array<AssistantMessage | ((context: TranscriptContext) => AssistantMessage)>) {
		this.queue.push(...replies.map((reply) => (typeof reply === "function" ? reply : () => reply)));
	}
	next(context: TranscriptContext): AssistantMessage {
		const reply = this.queue.shift();
		if (!reply) throw new Error("Unexpected preparation request");
		return reply(context);
	}
	get pending() {
		return this.queue.length;
	}
}
export function emptyKeeper(
	context: TranscriptContext,
	hooks: Array<{ evidenceText: string; [key: string]: unknown }> = [],
): AssistantMessage {
	const content = context.messages.findLast((message) => message.role === "user")?.content;
	if (typeof content !== "string") throw new Error("Keeper fixture requires the actual input");
	const input = JSON.parse(content) as {
		chapter: number;
		sentences: Array<{ n: number; text: string }>;
		originalInput?: unknown;
	};
	if (!Array.isArray(input.sentences)) throw new Error("Unexpected keeper retry; fixture must be core-valid");
	return fauxAssistantMessage(
		JSON.stringify({
			facts: [],
			claims: [],
			cognitions: [],
			relations: [],
			issues: [],
			hooks: hooks.map(({ evidenceText, ...hook }) => {
				const matches = input.sentences.filter((sentence) => sentence.text === evidenceText);
				if (matches.length !== 1) throw new Error("Hook evidence must bind to one actual sentence");
				return { ...hook, sentences: [matches[0].n] };
			}),
			summary: {
				title: `Chapter ${input.chapter}`,
				characters: [],
				events: [input.sentences[0]?.text ?? "No event."],
				mood: "quiet",
			},
		}),
	);
}
function opening(step: Extract<Setup, { step: "open" }>) {
	return [
		fauxToolCall("submit_constraints", jsonObject(step.constraints)),
		fauxToolCall(
			"submit_bible",
			jsonObject({
				items: step.bible.items.map(({ value, ...item }) => {
					if (!object(value)) throw new Error("Bible fixture value must be an object");
					const valueText =
						item.kind === "character"
							? value.identity
							: item.kind === "relationBaseline"
								? value.stance
								: value.description;
					if (
						typeof valueText !== "string" ||
						Object.keys(value).some((key) => !["identity", "stance", "description", "invariants"].includes(key))
					)
						throw new Error("Preparation cannot flatten this bible value losslessly");
					return { ...item, description: valueText, ...(value.invariants ? { invariants: value.invariants } : {}) };
				}),
			}),
		),
		fauxToolCall(
			"submit_outline",
			jsonObject({
				...step.outline.narration,
				chapters: step.outline.chapters.map(({ purpose, turn, ...chapter }) => ({
					...chapter,
					points: [purpose, turn],
				})),
			}),
		),
	];
}
export async function continuation(f: MeasuredSession, text: string) {
	await f.session.sendCustomMessage(
		{ customType: "p3.continue", content: text, display: false },
		{ triggerTurn: true },
	);
}
export async function seedUsageSnapshot(
	f: MeasuredSession,
	usage: NonNullable<Scenario["execution"]["usageSnapshot"]>,
) {
	if (f.phase !== "preparation") throw new Error("Accounting fixture must precede measurement");
	const known = fauxAssistantMessage("Synthetic preparation accounting snapshot.");
	known.usage = {
		input: 1,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1,
		cost: { input: usage.knownUsd, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.knownUsd },
	};
	f.manager.appendMessage(known);
	f.manager.appendCustomEntry("story.interrupted", {
		schema: "story/interrupted@1",
		toolCallId: "synthetic-prior-interruption",
		toolName: "write_next_chapter",
		reservedTokens: 1,
		reservedCostUsd: usage.unknownReservationsUsd,
		note: "possible_duplicate",
	});
	// State-only native usage/journal entries do not expose the two monetary
	// components to the model. The contract explicitly supplies this visible data.
	await f.session.sendCustomMessage(
		{
			customType: "p3.accounting_snapshot",
			content: JSON.stringify({
				knownUsd: usage.knownUsd,
				unknownReservationsUsd: usage.unknownReservationsUsd,
				conservativeTotalUsd: usage.conservativeTotalUsd,
			}),
			display: false,
		},
		{ triggerTurn: false },
	);
}
export async function prepareScenario(f: MeasuredSession, scenario: Scenario, queue: ReplyQueue) {
	if (f.phase !== "preparation") throw new Error("Preparation after measurement is forbidden");
	let initial = true;
	for (const step of scenario.setup) {
		if (step.step === "open") {
			if (!initial || !scenario.storyPrompt) throw new Error("Opening needs the first real author prompt");
			queue.push(
				fauxAssistantMessage(opening(step), { stopReason: "toolUse" }),
				fauxAssistantMessage("The opening is prepared."),
			);
			await f.session.prompt(scenario.storyPrompt);
			initial = false;
		} else if (step.step === "commitChapters") {
			if (step.texts.length !== step.count || step.keeperHooks.length !== step.count)
				throw new Error("Preparation chapter count mismatch");
			for (let i = 0; i < step.count; i++) {
				const before = f.story.current()?.source.model().lastChapter ?? 0;
				queue.push(
					fauxAssistantMessage(fauxToolCall("write_next_chapter", {}), { stopReason: "toolUse" }),
					fauxAssistantMessage(step.texts[i]),
					fauxAssistantMessage('{"observations":[]}'),
					(context) => emptyKeeper(context, step.keeperHooks[i]),
					fauxAssistantMessage("Chapter prepared."),
				);
				await continuation(f, "Write the next planned chapter.");
				const model = f.story.current()?.source.model();
				if (model?.lastChapter !== before + 1 || model.commits.at(-1)?.text !== step.texts[i])
					throw new Error("Preparation did not commit the exact fixture chapter");
			}
		} else if (step.step === "command") {
			if (!step.text.startsWith("/")) throw new Error("Preparation command must use its real route");
			await f.session.prompt(step.text);
		} else if (step.step === "authorMessage") {
			f.manager.appendMessage({ role: "user", content: step.text, timestamp: Date.now() });
		} else if (step.step === "toolCall") {
			if (step.result.ok !== false) throw new Error("Preparation error fixtures cannot fake success");
			const call = fauxToolCall(step.tool, jsonObject(step.args));
			f.manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
			const details: MacroDetails | { schema: string; tool: string; error: typeof step.result.error } =
				step.tool === "write_next_chapter"
					? {
							schema: "story/macro-result@1",
							ok: false,
							revision: true,
							interjectionSeq: { atStart: 0 },
							steps: [],
							calls: [],
							error: step.result.error,
						}
					: { schema: "story/error@1", tool: step.tool, error: step.result.error };
			f.manager.appendMessage({
				role: "toolResult",
				toolCallId: call.id,
				toolName: step.tool,
				isError: true,
				content: [{ type: "text", text: JSON.stringify(step.result) }],
				details: jsonObject(details),
				timestamp: Date.now(),
			});
		} else throw new Error("Unknown preparation step");
	}
	if (queue.pending) throw new Error("Preparation did not consume its exact response sequence");
	if (initial && scenario.storyPrompt) {
		// Cases without an opening still require a genuine initial author message.
		f.manager.appendMessage({ role: "user", content: scenario.storyPrompt, timestamp: Date.now() });
	}
	f.session.agent.state.messages = f.manager.buildSessionContext().messages;
	f.emit({
		type: "prepared",
		entries: f.manager.getBranch(),
		modelLastChapter: f.story.current()?.source.model().lastChapter,
	});
}
