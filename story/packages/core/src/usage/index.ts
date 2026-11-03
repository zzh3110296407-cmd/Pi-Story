import type { BudgetGuard as BudgetGuardPort, PriceTable, Role } from "../ports/index.ts";
import type { CallRecord, GoalEntry, InterruptedEntry, Usage } from "../schema/index.ts";
import type { DomainError } from "../shared/result.ts";

export interface SessionUsage {
	tokens: number;
	costUsd: number;
}
// Budget bookkeeping also covers native Pi requests. Domain CallRecord keeps
// its internal-role schema; these records are not folded as story role calls.
export type BudgetCallRecord = Omit<CallRecord, "role"> & { role: string };
export interface BudgetSnapshot {
	calls: readonly BudgetCallRecord[];
	interruptions: readonly InterruptedEntry[];
	budget?: GoalEntry["budget"];
	knownUsage?: SessionUsage;
}
export interface UsageSummary {
	knownTokens: number;
	missingCalls: number;
	reservedTokens: number;
	possibleDuplicates: number;
	estimatedCostUsd: number | null;
	budget?: { tokens?: number; costUsd?: number; remainingTokens?: number };
}
interface Totals {
	knownTokens: number;
	knownCost: number;
	reservedTokens: number;
	reservedCost: number;
	unknownCost: boolean;
	missingCalls: number;
	possibleDuplicates: number;
}

// U1: count Unicode code points; supplementary Han characters must not be mistaken for Latin.
export function estimateInputTokens(text: string): number {
	let cjk = 0;
	let other = 0;
	for (const char of text)
		if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)) cjk++;
		else other++;
	return Math.ceil(cjk * 0.889 + other * 0.309 + 2048);
}
export function estimateCost(prices: PriceTable, model: string, input: number, output: number): number | null {
	const price = prices.price(model);
	if (!price) return null;
	// Prices are USD per million tokens. Without a cache prediction reserve the highest input rate.
	return (input * Math.max(price.input, price.cacheRead, price.cacheWrite) + output * price.output) / 1_000_000;
}
export function sumUsage(calls: readonly Pick<CallRecord, "usage">[]): Usage | undefined {
	const known = calls.flatMap((call) => (call.usage === null ? [] : [call.usage]));
	if (!known.length) return undefined;
	const result: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const usage of known) {
		for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
			result[field] += usage[field];
		for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
			result.cost[field] += usage.cost[field];
		if (usage.reasoning !== undefined) result.reasoning = (result.reasoning ?? 0) + usage.reasoning;
		if (usage.cacheWrite1h !== undefined) result.cacheWrite1h = (result.cacheWrite1h ?? 0) + usage.cacheWrite1h;
	}
	return result;
}
function totals(snapshot: BudgetSnapshot): Totals {
	const reported = sumUsage(snapshot.calls);
	const result: Totals = {
		knownTokens: snapshot.knownUsage?.tokens ?? reported?.totalTokens ?? 0,
		knownCost: snapshot.knownUsage?.costUsd ?? reported?.cost.total ?? 0,
		reservedTokens: 0,
		reservedCost: 0,
		unknownCost: false,
		missingCalls: 0,
		possibleDuplicates: snapshot.interruptions.length,
	};
	for (const call of snapshot.calls)
		if (call.usage === null) {
			result.missingCalls++;
			result.reservedTokens += call.reservedInputTokens + call.reservedOutputTokens;
			if (call.reservedCostUsd === null) result.unknownCost = true;
			else result.reservedCost += call.reservedCostUsd;
		}
	for (const call of snapshot.interruptions) {
		result.reservedTokens += call.reservedTokens;
		if (call.reservedCostUsd === null || call.reservedCostUsd === undefined) result.unknownCost = true;
		else result.reservedCost += call.reservedCostUsd;
	}
	return result;
}
export function usageSummary(snapshot: BudgetSnapshot): UsageSummary {
	const used = totals(snapshot);
	return {
		knownTokens: used.knownTokens,
		missingCalls: used.missingCalls,
		reservedTokens: used.reservedTokens,
		possibleDuplicates: used.possibleDuplicates,
		estimatedCostUsd: used.unknownCost ? null : used.knownCost + used.reservedCost,
		...(snapshot.budget
			? {
					budget: {
						...(snapshot.budget.tokens !== undefined
							? {
									tokens: snapshot.budget.tokens,
									remainingTokens: Math.max(0, snapshot.budget.tokens - used.knownTokens - used.reservedTokens),
								}
							: {}),
						...(snapshot.budget.costUsd !== undefined ? { costUsd: snapshot.budget.costUsd } : {}),
					},
				}
			: {}),
	};
}

interface Reservation {
	role: string;
	model: string;
	input: number;
	output: number;
	cost: number | null;
}
export class BudgetGuard implements BudgetGuardPort {
	#snapshot: () => BudgetSnapshot;
	#prices: PriceTable;
	#sequence = 0;
	#active = new Map<string, Reservation>();
	#settled = new Map<string, BudgetCallRecord>();
	constructor(snapshot: () => BudgetSnapshot, prices: PriceTable) {
		this.#snapshot = snapshot;
		this.#prices = prices;
	}
	check(request: { role: string; model: string; inputTokensEstimate: number; maxOutputTokens: number }) {
		if (
			![request.inputTokensEstimate, request.maxOutputTokens].every(
				(value) => Number.isSafeInteger(value) && value >= 0,
			)
		)
			throw new RangeError("Reservation token counts must be nonnegative integers");
		const snapshot = this.#snapshot();
		const used = totals(snapshot);
		const pending = totals({ calls: [...this.#settled.values()], interruptions: [] });
		let tokens = used.knownTokens + used.reservedTokens + pending.knownTokens + pending.reservedTokens;
		let cost = used.knownCost + used.reservedCost + pending.knownCost + pending.reservedCost;
		for (const reservation of this.#active.values()) {
			tokens += reservation.input + reservation.output;
			cost += reservation.cost ?? 0;
		}
		const reservedCost = estimateCost(
			this.#prices,
			request.model,
			request.inputTokensEstimate,
			request.maxOutputTokens,
		);
		if (
			snapshot.budget?.costUsd !== undefined &&
			(reservedCost === null ||
				used.unknownCost ||
				pending.unknownCost ||
				[...this.#active.values()].some((reservation) => reservation.cost === null))
		)
			return {
				ok: false as const,
				error: {
					code: "BUDGET_EXHAUSTED" as const,
					message: "金额预算无法核算：模型价格或既有预留费用未知",
					hint: "请补齐价格及费用记录，或由作者明确改用仅Token预算",
				},
			};
		const error: DomainError = {
			code: "BUDGET_EXHAUSTED",
			message: "剩余额度不足以预留下一次调用",
			hint: "请作者增加预算或停止写作",
		};
		if (
			(snapshot.budget?.tokens !== undefined &&
				tokens + request.inputTokensEstimate + request.maxOutputTokens > snapshot.budget.tokens) ||
			(snapshot.budget?.costUsd !== undefined && cost + (reservedCost ?? 0) > snapshot.budget.costUsd)
		)
			return { ok: false as const, error };
		return { ok: true as const, costUsd: reservedCost };
	}
	reserve(request: { role: string; model: string; inputTokensEstimate: number; maxOutputTokens: number }) {
		const checked = this.check(request);
		if (!checked.ok) return checked;
		const reservationId = `reservation-${++this.#sequence}`;
		this.#active.set(reservationId, {
			role: request.role,
			model: request.model,
			input: request.inputTokensEstimate,
			output: request.maxOutputTokens,
			cost: checked.costUsd,
		});
		return { ok: true as const, reservationId, costUsd: checked.costUsd };
	}
	settle(reservationId: string, record: BudgetCallRecord): void {
		const reservation = this.#active.get(reservationId);
		if (!reservation) throw new Error("Unknown or already settled reservation");
		if (
			reservation.role !== record.role ||
			reservation.model !== record.model ||
			reservation.input !== record.reservedInputTokens ||
			reservation.output !== record.reservedOutputTokens ||
			reservation.cost !== record.reservedCostUsd
		)
			throw new Error("Call record does not match its reservation");
		this.#active.delete(reservationId);
		this.#settled.set(reservationId, structuredClone(record));
	}
	// The adapter acknowledges only after these records appear in its authoritative snapshot.
	// Matching records by value would collapse legitimate identical calls and is deliberately avoided.
	acknowledge(reservationIds: readonly string[]): void {
		for (const id of reservationIds)
			if (!this.#settled.has(id)) throw new Error("Cannot acknowledge an unsettled reservation");
		for (const id of reservationIds) this.#settled.delete(id);
	}
	settledReservations(): string[] {
		return [...this.#settled.keys()];
	}
	summary(): UsageSummary {
		const snapshot = this.#snapshot();
		const known = sumUsage(snapshot.calls);
		const pending = totals({ calls: [...this.#settled.values()], interruptions: [] });
		const active = this.inFlight();
		const result = usageSummary({
			...snapshot,
			calls: [...snapshot.calls, ...this.#settled.values()],
			knownUsage: {
				tokens: (snapshot.knownUsage?.tokens ?? known?.totalTokens ?? 0) + pending.knownTokens,
				costUsd: (snapshot.knownUsage?.costUsd ?? known?.cost.total ?? 0) + pending.knownCost,
			},
		});
		result.reservedTokens += active.tokens;
		result.estimatedCostUsd =
			result.estimatedCostUsd === null || active.costUsd === null ? null : result.estimatedCostUsd + active.costUsd;
		if (result.budget?.tokens !== undefined)
			result.budget.remainingTokens = Math.max(0, result.budget.tokens - result.knownTokens - result.reservedTokens);
		return result;
	}
	inFlight(): { tokens: number; costUsd: number | null } {
		const values = [...this.#active.values()];
		return {
			tokens: values.reduce((total, reservation) => total + reservation.input + reservation.output, 0),
			costUsd: values.some((reservation) => reservation.cost === null)
				? null
				: values.reduce((total, reservation) => total + (reservation.cost ?? 0), 0),
		};
	}
}

export function interruptedMacro(input: {
	toolCallId: string;
	roleInputs: Record<Role, string>;
	roles: Record<Role, { model: string; maxTokens?: number }>;
	prices: PriceTable;
}): InterruptedEntry {
	// U7: 14 logical calls, each with at most one independently reserved transport retry.
	const upperCalls: Record<Role, number> = { writer: 8, editor: 12, keeper: 8, verifier: 0 };
	let reservedTokens = 0;
	let reservedCostUsd: number | null = 0;
	for (const role of ["writer", "editor", "keeper"] as const) {
		const estimate = estimateInputTokens(input.roleInputs[role]);
		const output = input.roles[role].maxTokens ?? 8192;
		reservedTokens += upperCalls[role] * (estimate + output);
		const cost = estimateCost(input.prices, input.roles[role].model, estimate, output);
		reservedCostUsd = reservedCostUsd === null || cost === null ? null : reservedCostUsd + upperCalls[role] * cost;
	}
	return {
		schema: "story/interrupted@1",
		toolCallId: input.toolCallId,
		toolName: "write_next_chapter",
		reservedTokens,
		reservedCostUsd,
		note: "possible_duplicate",
	};
}
