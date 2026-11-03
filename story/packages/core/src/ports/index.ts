import type { TSchema } from "typebox";
import type { BranchEntry, StoryModel } from "../fold/index.ts";
import type { CallRecord, ModelFailure, Usage } from "../schema/index.ts";
import type { DomainError } from "../shared/result.ts";

export type Role = "writer" | "editor" | "keeper" | "verifier";
export interface EntrySource {
	branch(): readonly BranchEntry[];
	authorMessage(entryId: string): string | null;
}
export interface RuleSource {
	get(name: string): string;
}
export interface ModelRequest {
	role: Role;
	model: string;
	system: string;
	user: string;
	maxTokens: number;
	temperature?: number;
	output: { kind: "text" } | { kind: "json"; schema: TSchema };
	signal?: AbortSignal;
	inputSources?: CallRecord["inputSources"];
}
export interface ModelPort {
	call(req: ModelRequest): Promise<{
		text: string;
		json?: unknown;
		usage: Usage | null;
		stopReason: string;
		durationMs: number;
		rejection?: { httpStatus: number };
		failure?: ModelFailure;
	}>;
}
export interface PriceTable {
	price(model: string): { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
}
export interface BudgetGuard {
	reserve(req: {
		role: string;
		model: string;
		inputTokensEstimate: number;
		maxOutputTokens: number;
	}): { ok: true; reservationId: string; costUsd: number | null } | { ok: false; error: DomainError };
	settle(reservationId: string, record: CallRecord): void;
}
export interface Ports {
	entries: EntrySource;
	models: ModelPort;
	prices: PriceTable;
	budget: BudgetGuard;
	rules: RuleSource;
	interjections: { seq(): number };
	// Synchronous audit sink, independent of the final macro result. A failed
	// start write must stop dispatch; a start is a reservation, not completed usage.
	callJournal?: {
		started(reservationId: string, request: ModelRequest, reservedCostUsd: number | null): void;
		completed(reservationId: string, record: CallRecord): void;
	};
}
export interface RoleSettings {
	model: string;
	maxTokens?: number;
	temperature?: number;
	thinking?: string;
}
export interface EffectiveSettings {
	localRevision: boolean;
	// Optional draft-only calibration. Omitted preserves the outline target.
	writerLengthFactor?: 0.8 | 0.9;
	roles: Record<Role, RoleSettings>;
	level?: "L0" | "L1" | "L2";
}
export interface CommandContext {
	model: StoryModel;
	ports: Ports;
	settings: EffectiveSettings;
	signal?: AbortSignal;
	progress?: (step: string, draftPreview?: { chapter: number; draftId: string; text: string }) => void;
	// 15 A.6: the adapter shares this marker for all writes in one batch.
	batch?: { committed: boolean };
}
