import type { TSchema } from "typebox";
import { foldBranch, type StoryModel } from "../fold/index.ts";
import type { CommandContext, ModelRequest, Role } from "../ports/index.ts";
import { type CallRecord, schemas, type Usage, validate } from "../schema/index.ts";
import { type CommandResult, failure, success } from "../shared/result.ts";
import { estimateInputTokens } from "../usage/index.ts";
import { roleInputSources } from "./inputs.ts";

type ModelReply = Awaited<ReturnType<CommandContext["ports"]["models"]["call"]>>;

async function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	await new Promise<void>((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
}
export class CallSession {
	readonly calls: CallRecord[] = [];
	#ctx: CommandContext;
	#fatal = false;
	constructor(ctx: CommandContext) {
		this.#ctx = ctx;
	}
	async call(
		role: Role,
		system: string,
		user: string,
		output: ModelRequest["output"],
		sourceModel?: StoryModel,
	): Promise<CommandResult<ModelReply>> {
		if (this.#fatal)
			return failure("TRANSPORT_FAILURE", "提供方拒绝，整次运行已停止", [role], "请检查授权或余额后重新运行");
		const before = this.calls.length;
		const first = await this.#attempt(role, system, user, output, sourceModel);
		const record = this.calls.at(-1);
		if (first.ok || this.calls.length === before || record?.failure?.kind !== "transport" || this.#ctx.signal?.aborted)
			return first;
		await waitForRetry(
			record.failure.httpStatus === 429 ? Math.min(record.failure.retryAfterMs ?? 2_000, 10_000) : 2_000,
			this.#ctx.signal,
		);
		return this.#attempt(role, system, user, output, sourceModel, record.id);
	}
	async #attempt(
		role: Role,
		system: string,
		user: string,
		output: ModelRequest["output"],
		sourceModel?: StoryModel,
		retryOf?: string,
	): Promise<CommandResult<ModelReply>> {
		const ctx = this.#ctx;
		if (ctx.signal?.aborted) return failure("TRANSPORT_FAILURE", "内部角色调用已停止");
		const policy = foldBranch(ctx.ports.entries.branch()).policy;
		if (policy.budget?.perChapterCalls !== undefined && this.calls.length >= policy.budget.perChapterCalls)
			return failure("BUDGET_EXHAUSTED", "本次标准流程已达到调用次数上限"); // A.5
		const settings = ctx.settings.roles[role];
		const maxTokens = settings.maxTokens ?? 8192;
		if (!settings.model.trim() || !Number.isSafeInteger(maxTokens) || maxTokens <= 0)
			return failure("DOMAIN_INVALID", "角色模型或输出上限配置无效", [role]);
		const inputTokensEstimate = estimateInputTokens(
			`${system}\n${user}${output.kind === "json" ? JSON.stringify(output.schema) : ""}`,
		);
		const reservation = ctx.ports.budget.reserve({
			role,
			model: settings.model,
			inputTokensEstimate,
			maxOutputTokens: maxTokens,
		});
		if (!reservation.ok)
			return {
				ok: false,
				error: reservation.error,
				receipt: `${reservation.error.code}：${reservation.error.message}`,
			};
		const request: ModelRequest = {
			role,
			model: settings.model,
			system,
			user,
			maxTokens,
			...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
			output,
			inputSources: roleInputSources(sourceModel ?? foldBranch(ctx.ports.entries.branch()), system, user),
			...(ctx.signal ? { signal: ctx.signal } : {}),
		};
		ctx.ports.callJournal?.started(reservation.reservationId, request, reservation.costUsd);
		let reply: ModelReply;
		try {
			reply = await ctx.ports.models.call(request);
		} catch (error) {
			let usage: Usage | null = null;
			const classified = validate(
				schemas.ModelFailure,
				error !== null && typeof error === "object" && "failure" in error ? error.failure : undefined,
			);
			if (error !== null && typeof error === "object" && "usage" in error) {
				const checked = validate(schemas.Usage, error.usage);
				if (checked.ok) usage = checked.value;
			}
			const record: CallRecord = {
				id: reservation.reservationId,
				...(retryOf ? { retryOf } : {}),
				...(classified.ok ? { failure: classified.value } : {}),
				role,
				model: settings.model,
				reservedInputTokens: inputTokensEstimate,
				reservedOutputTokens: maxTokens,
				reservedCostUsd: reservation.costUsd,
				usage,
				inputSources: request.inputSources,
				status: "failed",
				stopReason: "transport_failure",
			};
			this.calls.push(record);
			ctx.ports.budget.settle(reservation.reservationId, record);
			ctx.ports.callJournal?.completed(reservation.reservationId, record);
			if (classified.ok && classified.value.kind === "fatal") this.#fatal = true;
			return failure("TRANSPORT_FAILURE", "内部角色调用失败", [role]);
		}
		const checked = reply.usage === null ? null : validate(schemas.Usage, reply.usage);
		const usage = checked?.ok ? checked.value : null;
		const invalid = (reply.usage !== null && !checked?.ok) || typeof reply.text !== "string";
		const rejected =
			reply.stopReason === "rejected" &&
			reply.rejection !== undefined &&
			reply.rejection.httpStatus >= 400 &&
			reply.rejection.httpStatus < 500 &&
			reply.text === "" &&
			usage?.totalTokens === 0 &&
			usage.cost.total === 0;
		const failed =
			invalid || rejected || reply.failure !== undefined || ["error", "aborted", "rejected"].includes(reply.stopReason);
		const record: CallRecord = {
			id: reservation.reservationId,
			...(retryOf ? { retryOf } : {}),
			...(reply.failure ? { failure: reply.failure } : {}),
			role,
			model: settings.model,
			reservedInputTokens: inputTokensEstimate,
			reservedOutputTokens: maxTokens,
			reservedCostUsd: reservation.costUsd,
			usage,
			inputSources: request.inputSources,
			status: rejected ? "rejected" : failed ? "failed" : usage === null ? "missing" : "reported",
			...(rejected ? { rejection: reply.rejection } : {}),
			stopReason: invalid ? "invalid_model_response" : reply.stopReason,
			...(Number.isFinite(reply.durationMs) && reply.durationMs >= 0 ? { durationMs: reply.durationMs } : {}),
		};
		this.calls.push(record);
		ctx.ports.budget.settle(reservation.reservationId, record);
		ctx.ports.callJournal?.completed(reservation.reservationId, record);
		if (reply.failure?.kind === "fatal") this.#fatal = true;
		// Completion and cancellation are separate: account the finished call, but
		// do not let a provider that completed normally resume a cancelled workflow.
		if (ctx.signal?.aborted) return failure("TRANSPORT_FAILURE", "内部角色调用已停止", [role]);
		return failed ? failure("TRANSPORT_FAILURE", "内部调用未完成或返回结构无效", [role]) : success({ ...reply, usage });
	}
	async json<D>(
		role: Role,
		system: string,
		input: unknown,
		schema: TSchema,
		parse: (value: unknown) => CommandResult<D>,
		sourceModel?: StoryModel,
	): Promise<CommandResult<D>> {
		let user = JSON.stringify(input);
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await this.call(role, system, user, { kind: "json", schema }, sourceModel);
			if (!result.ok) return { ok: false, error: result.error, receipt: result.receipt };
			let value: unknown;
			try {
				value = result.details.json !== undefined ? result.details.json : JSON.parse(result.details.text);
			} catch {
				value = undefined;
			}
			const parsed = value === undefined ? failure<D>("PARSE_FAILURE", "角色输出不是有效JSON", ["$"]) : parse(value);
			if (parsed.ok || parsed.error.code !== "PARSE_FAILURE" || attempt === 1) return parsed;
			// One repair call, with a separate reservation. The validator never edits model fields.
			user = JSON.stringify({
				originalInput: input,
				invalidOutput: result.details.text,
				formatErrors: parsed.error.items ?? [parsed.error.message],
			});
		}
		throw new Error("JSON repair loop exhausted unexpectedly");
	}
}
