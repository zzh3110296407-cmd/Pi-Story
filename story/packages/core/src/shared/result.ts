import type { Usage } from "../schema/index.ts";

export type ErrorCode =
	| "TRANSPORT_FAILURE"
	| "PARSE_FAILURE"
	| "SEMANTIC_GAP"
	| "DOMAIN_INVALID"
	| "STALE_OR_CONFLICT"
	| "LITERARY_INVALID"
	| "REVIEW_REQUIRED"
	| "OBSERVATION_UNRESOLVED"
	| "STATE_UNSUPPORTED"
	| "BUDGET_EXHAUSTED"
	| "NOT_IDLE"
	| "INTERJECTED"
	| "GOAL_REACHED";
export interface DomainError {
	code: ErrorCode;
	message: string;
	items?: string[];
	hint?: string;
}
export type CommandResult<D> =
	| { ok: true; details: D; receipt: string; usage?: Usage }
	| { ok: false; error: DomainError; details?: D; receipt: string; usage?: Usage };
export const failure = <D = never>(
	code: ErrorCode,
	message: string,
	items?: string[],
	hint = "请核对输入后重试",
): CommandResult<D> => ({ ok: false, error: { code, message, items, hint }, receipt: `${code}：${message}` });
export const success = <D>(details: D, receipt = "已完成"): CommandResult<D> => ({ ok: true, details, receipt });
