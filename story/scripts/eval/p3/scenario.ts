import {
	type AssistantMessage,
	type Context,
	fauxAssistantMessage,
	fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { writeNextChapter } from "@pi-story/core";
import type { EvidenceRecord } from "../p2/metering.ts";
import { decisiveAction } from "../p3r2/decisions.ts";
import { scenarioChecks } from "./checks.ts";
import type { InputEvent, Scenario } from "./datasets.ts";
import type { LocalReply } from "./faux.ts";
import { continuation, emptyKeeper, prepareScenario, ReplyQueue, seedUsageSnapshot } from "./prepare.ts";
import { createMeasuredSession, type MeasuredSession, requestRole, type SessionOptions } from "./session.ts";

export interface CapturedAction {
	tool?: string;
	args?: Record<string, unknown>;
	reply?: string;
	id?: string;
}
export function scenarioOutcome(
	category: string,
	actions: CapturedAction[],
	errors: string[],
	boundExceeded: boolean,
	stopReason?: string,
) {
	const problems = [...errors];
	if (
		category !== "E01" &&
		!(category === "E09" && stopReason === "budget_exhausted") &&
		!actions.some((action) => action.tool || action.reply?.trim())
	)
		problems.push("No measured action or final reply was received");
	return { status: problems.length || boundExceeded ? "incomplete" : "measured", errors: problems };
}
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
function userInput(context: Context) {
	const text = context.messages.findLast((message) => message.role === "user")?.content;
	if (typeof text !== "string") throw new Error("Role input was not a text request");
	const parsed: unknown = JSON.parse(text);
	if (!object(parsed)) throw new Error("Role input was not an object");
	return parsed;
}

// This controller receives execution metadata, never expect/referenceAction.
// Real showrunner requests bypass it; preparation and deterministic fault cases
// use exactly the same SDK, domain guards, ports and journals as product calls.
function localController(scenario: Pick<Scenario, "execution">, getSession: () => MeasuredSession, queue: ReplyQueue) {
	let profileIndex = 0;
	let writerAttempt = 0;
	let mainAfterTool = false;
	return (context: TranscriptContext): AssistantMessage => {
		const f = getSession();
		if (f.phase === "preparation") return queue.next(context);
		const role = requestRole(context);
		const state = f.story.current();
		if (!state) throw new Error("Story state unavailable");
		const model = state.source.model();
		if (role === "showrunner") {
			if (mainAfterTool) {
				mainAfterTool = false;
				return fauxAssistantMessage(`Current result: ${state.stopReason ?? "chapter attempt complete"}.`);
			}
			mainAfterTool = true;
			return fauxAssistantMessage(fauxToolCall("write_next_chapter", {}), { stopReason: "toolUse" });
		}
		const profile = scenario.execution.fauxProfile;
		if (profile?.id === "local_revision") {
			const step = profile.script?.[profileIndex];
			const input = userInput(context);
			const task = input.task === "full_review" ? "review" : input.task === "local_patch" ? "patch" : input.task;
			if (!step || step.role !== role || step.task !== task)
				throw new Error("Local revision did not follow the declared real call path");
			profileIndex++;
			return fauxAssistantMessage(step.text ?? JSON.stringify(step.json));
		}
		if (role === "writer") {
			writerAttempt++;
			if (profile?.id === "two_unusable_drafts") return fauxAssistantMessage("");
			if (profile?.id === "one_transport_interruption" && writerAttempt === 1)
				return fauxAssistantMessage("An interrupted fragment", {
					stopReason: "error",
					errorMessage: "Synthetic stream interrupted after generation started",
				});
			if (profile?.validRetryText) return fauxAssistantMessage(profile.validRetryText);
			const chapter = model.outline.find((item) => item.n === model.lastChapter + 1);
			if (!chapter) throw new Error("No fixture outline for writer");
			return fauxAssistantMessage(
				`${chapter.purpose}\n\nThe work continued with care. They compared the available records and separated what they had observed from what remained unknown.\n\n${chapter.turn}`,
			);
		}
		if (role === "editor") return fauxAssistantMessage('{"observations":[]}');
		return emptyKeeper(context);
	};
}

export async function deliver(f: MeasuredSession, input: InputEvent) {
	f.emit({ type: "driver_input", input });
	if (input.type === "continue") await continuation(f, input.text);
	else
		await f.session.prompt(
			input.text,
			input.type === "steer" || input.type === "followUp" ? { streamingBehavior: input.type } : undefined,
		);
}

export async function bindScriptedDialog(
	f: MeasuredSession,
	script: NonNullable<Scenario["execution"]["dialogResponses"]>,
	onError: (message: string) => void,
) {
	const responses = [...script];
	const runner = f.session.extensionRunner;
	if (!runner) throw new Error("Dialog runner unavailable");
	const answer = async (title: string, choices?: string[]) => {
		const state = f.story.current();
		f.emit({
			type: "dialog_pause",
			title,
			choices,
			waitingForAuthor: state?.waitingForAuthor,
			stopReason: state?.stopReason,
		});
		const reply = responses.shift();
		if (
			!state?.waitingForAuthor ||
			state.stopReason !== "ask_author" ||
			!reply ||
			reply.on !== "ask_author" ||
			typeof reply.reply !== "string" ||
			!reply.reply.trim() ||
			reply.delayUntilAssertion !== "automatic_continuation_paused"
		) {
			f.emit({
				type: "scenario_driver_error",
				diagnostic: "Scripted author response could not be delivered after the pause assertion",
			});
			void f.session.abort().catch(() => onError("Dialog cancellation failed"));
			return undefined;
		}
		await Promise.resolve();
		// Pinned RPC select/input both resolve extension_ui_response.value as a
		// string. Do not require a scripted free-text answer to equal an option
		// label generated by the measured model; never choose a different answer.
		f.emit({ type: "dialog_response", value: reply.reply, channel: "rpc_value" });
		return reply.reply;
	};
	await f.session.bindExtensions({
		mode: "rpc",
		uiContext: { ...runner.getUIContext(), select: answer, input: (title) => answer(title) },
		onError: (event) => onError(event.error),
	});
}
function matches(action: CapturedAction, expected: Scenario["expect"]["acceptable"][number]) {
	if (expected.reply) return Boolean(action.reply?.trim());
	if (!expected.tool || action.tool !== expected.tool) return false;
	return Object.entries(expected.argsMatch ?? {}).every(([path, expectedValue]) => {
		const segments = path.replace(/\[(\d+)\]/gu, ".$1").split(".");
		let value: unknown = action.args;
		for (const segment of segments) {
			if (Array.isArray(value) && /^\d+$/u.test(segment)) value = value[Number(segment)];
			else if (object(value)) value = value[segment];
			else return false;
		}
		return value === expectedValue;
	});
}
export function scoreActions(scenario: Scenario, actions: CapturedAction[]) {
	const decision =
		scenario.schema === "story/p3-scenario@2"
			? decisiveAction(actions, scenario.execution.maxReadOnlyCalls ?? 3)
			: undefined;
	const first = decision ? decision.action : actions[0];
	return {
		firstAction: first ?? null,
		firstAcceptable: Boolean(
			first && !decision?.exceeded && scenario.expect.acceptable.some((acceptable) => matches(first, acceptable)),
		),
		...(decision ? { readOnlyCalls: decision.readOnlyCalls, readOnlyExceeded: decision.exceeded } : {}),
		forbidden: actions.filter((action) => scenario.expect.forbidden.some((forbidden) => matches(action, forbidden))),
		judgeChecks: scenario.expect.judgeChecks.map((check) => ({ check, status: "pending" as const })),
	};
}

export async function runScenario(
	scenario: Scenario,
	options: Omit<
		SessionOptions,
		"reply" | "main" | "internals" | "beforeRequest" | "extension" | "price" | "preparation" | "maxShowrunnerRequests"
	> & { fauxShowrunnerReply?: LocalReply },
) {
	if (options.fauxShowrunnerReply && scenario.mode !== "faux")
		throw new Error("A real measured showrunner cannot use a scripted reply");
	const queue = new ReplyQueue();
	let f: MeasuredSession | undefined;
	const actions: CapturedAction[] = [];
	let injected = false;
	let measuredAttempts = 0;
	let boundExceeded = false;
	let firstToolComplete = false;
	let finalizing = false;
	const decisiveMode = scenario.schema === "story/p3-scenario@2";
	let completedMainRequests = 0;
	let decisionLimitReached = false;
	let scheduledAttempts = 0;
	const errors: string[] = [];
	const observed: EvidenceRecord[] = [];
	const getSession = () => {
		if (!f) throw new Error("Scenario not initialized");
		return f;
	};
	const local = localController(scenario, getSession, queue);
	f = await createMeasuredSession({
		...options,
		main: scenario.mode,
		internals: scenario.execution.internalRoles,
		onEvidence: (record) => {
			if (record.type === "execution_bound") boundExceeded = true;
			if (record.type === "scenario_driver_error") errors.push(String(record.diagnostic));
			if (
				(record.type === "session_event" &&
					object(record.event) &&
					record.event.type === "message_end" &&
					object(record.event.message) &&
					record.event.message.role === "user") ||
				[
					"model_call",
					"role_call",
					"role_checkpoint",
					"dialog_pause",
					"dialog_response",
					"driver_probe",
					"ui_notice",
				].includes(record.type)
			)
				observed.push(record);
			options.onEvidence?.(record);
		},
		reply: (context, streamOptions) =>
			options.fauxShowrunnerReply && getSession().phase === "measurement" && requestRole(context) === "showrunner"
				? options.fauxShowrunnerReply(context, streamOptions)
				: local(context),
		maxShowrunnerRequests: scenario.execution.maxShowrunnerRequests,
		price: scenario.execution.fauxProfile?.id === "priced_calls",
		beforeRequest: async (role, context) => {
			if (role !== "writer" || !scenario.trigger.at || injected) return;
			const match = /^write_next_chapter:chapter=(\d+):draft_request:attempt=(\d+)$/u.exec(scenario.trigger.at);
			if (!match) throw new Error("Unrecognized injection event");
			const input = userInput(context);
			if (input.task !== "draft" || input.chapter !== Number(match[1])) return;
			scheduledAttempts++;
			if (scheduledAttempts !== Number(match[2])) return;
			const active = getSession();
			active.emit({ type: "injection_hold", at: scenario.trigger.at, chapter: input.chapter, input });
			injected = true;
			await deliver(active, scenario.trigger);
			active.emit({
				type: "injection_release",
				at: scenario.trigger.at,
				sequence: active.story.current()?.gate.sequence,
			});
		},
		extension: (pi, story) => {
			pi.on("agent_before_settle", (event, ctx) => {
				if (f?.phase === "preparation") return { entries: [], continue: false };
				if (decisiveMode) {
					if (decisionLimitReached || decisiveAction(actions, scenario.execution.maxReadOnlyCalls ?? 3).action)
						return { entries: event.entries, continue: false };
					if (
						ctx.signal?.aborted ||
						event.outcome !== "completed" ||
						["budget_exhausted", "provider_error"].includes(story.current()?.stopReason ?? "")
					)
						return { continue: false };
					return {
						entries: [
							...event.entries,
							{
								type: "custom_message",
								customType: "p3r2.await-decision",
								content: "Continue responding to the current author request.",
								display: false,
							},
						],
						continue: true,
					};
				}
				if (
					scenario.execution.stopAfterFirstAction ||
					(decisiveMode &&
						(decisionLimitReached || decisiveAction(actions, scenario.execution.maxReadOnlyCalls ?? 3).action))
				)
					return { entries: event.entries, continue: false };
			});
			pi.on("tool_execution_start", (event, ctx) => {
				if (
					f?.phase === "measurement" &&
					event.toolName === "write_next_chapter" &&
					!story.current()?.followUps.hasPending &&
					++measuredAttempts > scenario.execution.maxChapterAttempts
				) {
					boundExceeded = true;
					ctx.abort();
				}
			});
			pi.on("message_end", (event) => {
				if (f?.phase !== "measurement") return;
				if (event.message.role === "assistant") {
					if (!["error", "aborted"].includes(event.message.stopReason)) completedMainRequests++;
					const calls = event.message.content.filter((block) => block.type === "toolCall");
					if (calls.length)
						for (const call of calls) actions.push({ tool: call.name, args: call.arguments, id: call.id });
					else if (!["error", "aborted"].includes(event.message.stopReason)) {
						const reply = event.message.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("\n");
						if (!decisiveMode || reply.trim()) actions.push({ reply });
					}
				} else if (event.message.role === "toolResult") firstToolComplete = true;
			});
			pi.on("turn_end", (_event, ctx) => {
				if (f?.phase === "measurement" && scenario.execution.stopAfterFirstAction && firstToolComplete) ctx.abort();
				if (f?.phase !== "measurement" || !decisiveMode) return;
				const decision = decisiveAction(actions, scenario.execution.maxReadOnlyCalls ?? 3);
				decisionLimitReached =
					decision.exceeded || (!decision.action && completedMainRequests >= scenario.execution.maxShowrunnerRequests);
				if (decision.action || decisionLimitReached) ctx.abort();
			});
			pi.registerCommand("__p3_probe", {
				description: "Post-measurement domain guard probe",
				handler: async () => {
					if (f?.phase !== "driver_probe") throw new Error("Probe outside its separate phase");
					const state = story.current();
					if (!state) throw new Error("Probe story state unavailable");
					const result = await writeNextChapter({
						model: state.source.model(),
						ports: state.services.ports,
						settings: state.settings.effective,
					});
					f.emit({ type: "driver_probe", result });
					if (scenario.category === "E09") {
						const model = f.runtime.getModel("faux", "priced");
						if (!model) throw new Error("Priced probe model unavailable");
						const before = state.services.guard.summary();
						const result = state.services.providerBudget.start("faux/priced", 1, model.maxTokens);
						f.emit({
							type: "driver_probe",
							probe: "showrunner_predispatch",
							result,
							before,
							after: state.services.guard.summary(),
							modelRequests: 0,
						});
					}
				},
			});
		},
	});
	try {
		await f.session.bindExtensions({
			mode: "print",
			onError: (event) => {
				errors.push(event.error);
			},
		});
		const baseRunner = f.session.extensionRunner;
		if (!baseRunner) throw new Error("Scenario extension runner unavailable");
		await f.session.bindExtensions({
			mode: "print",
			uiContext: {
				...baseRunner.getUIContext(),
				notify: (message, severity) => getSession().emit({ type: "ui_notice", message, severity }),
			},
			onError: (event) => {
				errors.push(event.error);
			},
		});
		if (scenario.execution.dialogResponses?.length) {
			await bindScriptedDialog(f, scenario.execution.dialogResponses, (error) => errors.push(error));
		}
		await prepareScenario(f, scenario, queue);
		const usage = scenario.execution.usageSnapshot;
		if (usage) await seedUsageSnapshot(f, usage);
		const before = structuredClone(f.story.current()?.source.model());
		if (!before) throw new Error("Prepared story missing");
		const firstMeasuredIndex = f.manager.getBranch().length;
		await f.measure();
		if (scenario.trigger.at) {
			if (!scenario.execution.start) throw new Error("Scheduled injection has no start event");
			await deliver(f, scenario.execution.start);
			if (!injected) errors.push("Named writer injection event was never observed");
		} else {
			await deliver(f, scenario.trigger);
			injected = true;
		}
		for (const input of scenario.execution.afterTrigger ?? []) await deliver(f, input);
		const entries = f.manager.getBranch();
		const after = f.story.current()?.source.model();
		if (!after) throw new Error("Measured story missing");
		const unchanged = before.commits.every((commit, i) => JSON.stringify(commit) === JSON.stringify(after.commits[i]));
		const actionScore = scoreActions(scenario, actions);
		if (["E02", "E09", "E14"].includes(scenario.category)) {
			f.probe();
			await f.session.prompt("/__p3_probe");
		}
		const result = {
			id: scenario.id,
			...(decisiveMode && decisionLimitReached && errors.length === 0 && !boundExceeded
				? { status: "measured", errors: [], behaviorFailed: true }
				: scenarioOutcome(scenario.category, actions, errors, boundExceeded, f.story.current()?.stopReason)),
			...(decisiveMode ? { completedMainRequests, decisionLimitReached } : {}),
			boundExceeded,
			injected,
			measuredAttempts,
			firstMeasuredIndex,
			actions,
			...actionScore,
			priorChaptersUnchanged: unchanged,
			beforeLastChapter: before.lastChapter,
			afterLastChapter: after.lastChapter,
			stopReason: f.story.current()?.stopReason,
			programChecks: scenarioChecks(
				scenario,
				{
					before,
					after,
					entries,
					firstMeasuredIndex,
					actions,
					observed,
					stopReason: f.story.current()?.stopReason,
					injected,
				},
				options.stage === "P3R2" ? "p3r2-32@1" : "p3-29@1",
			),
		};
		f.emit({ type: "scenario_result", result });
		finalizing = true;
		const archive = f.finish();
		return { ...result, archive };
	} catch (cause) {
		if (finalizing) throw cause;
		await f.session.abort();
		f.emit({
			type: "scenario_interrupted",
			diagnostic: "Scenario execution failed; partial native and role evidence retained",
		});
		f.finish();
		throw cause;
	} finally {
		f.dispose();
	}
}
