import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelFailure } from "@pi-story/core";

export interface HttpFailure {
	status: number;
	body: string;
	complete: boolean;
	retryAfter: string | null;
}
export function classifyModelFailure(
	response: AssistantMessage,
	http?: HttpFailure,
	aborted = false,
): ModelFailure | undefined {
	if (response.stopReason === "aborted" || (aborted && response.stopReason === "error")) return { kind: "aborted" };
	if (http && [401, 402, 403].includes(http.status)) return { kind: "fatal", httpStatus: http.status };
	if (http && (http.status === 429 || http.status >= 500)) {
		const seconds = http.retryAfter?.trim() ? Number(http.retryAfter) : Number.NaN;
		const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(http.retryAfter ?? "") - Date.now();
		return {
			kind: "transport",
			httpStatus: http.status,
			...(http.status === 429 && Number.isFinite(ms) && ms >= 0 ? { retryAfterMs: Math.min(ms, 10_000) } : {}),
		};
	}
	if (http && http.status >= 400 && http.status < 500) return { kind: "rejected", httpStatus: http.status };
	if (response.stopReason === "error") return { kind: "transport" };
	return undefined;
}

// An HTTP status alone (HTML gateways, truncated bodies, or partial generation)
// is insufficient evidence to turn an unknown fee into zero.
export function rejectedBeforeGeneration(
	status: number,
	body: string,
	complete: boolean,
	response: AssistantMessage,
): boolean {
	if (
		!complete ||
		status < 400 ||
		status >= 500 ||
		response.content.length ||
		response.usage.totalTokens !== 0 ||
		response.usage.cost.total !== 0
	)
		return false;
	try {
		const value: unknown = JSON.parse(body);
		if (value === null || typeof value !== "object" || !("error" in value) || "choices" in value || "output" in value)
			return false;
		return typeof value.error === "string"
			? value.error.trim().length > 0
			: value.error !== null &&
					typeof value.error === "object" &&
					"message" in value.error &&
					typeof value.error.message === "string" &&
					value.error.message.trim().length > 0;
	} catch {
		return false;
	}
}
