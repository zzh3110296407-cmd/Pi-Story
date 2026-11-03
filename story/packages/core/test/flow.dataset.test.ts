import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { type BranchEntry, foldBranch } from "../src/fold/index.ts";
import * as api from "../src/index.ts";
import type { ModelPort, ModelRequest } from "../src/ports/index.ts";
import { context } from "./context.ts";
import { loadDataset, record } from "./support/datasets.ts";

interface Scenario {
	id: string;
	command: string;
	entries: BranchEntry[];
	input: unknown;
	script: (Awaited<ReturnType<ModelPort["call"]>> & {
		role: string;
		event?: { interjection?: number; append?: BranchEntry };
	})[];
	expected: {
		ok: boolean;
		code?: string;
		quality?: string;
		calls?: number;
		totalTokens?: number;
		committed?: boolean;
		roles?: string[];
		items?: string[];
		dispositions?: Record<string, string>;
	};
	localRevision?: boolean;
	budgetDenyAt?: number;
	batchCommitted?: boolean;
	batch?: { committed: boolean };
	perChapterCalls?: number;
}
export const scenarios = loadDataset<Scenario[]>("DS04-eligibility-flow", "scenarios.json", "v2").data;
async function execute(s: Scenario) {
	const entries = structuredClone(s.entries);
	const ctx = context(entries);
	ctx.batch = structuredClone(s.batch ?? { committed: s.batchCommitted ?? false });
	ctx.settings.localRevision = s.localRevision ?? true;
	if (s.perChapterCalls !== undefined) {
		entries.push({
			kind: "custom",
			entryId: "test-policy",
			customType: "story.goal",
			data: { schema: "story/goal@1", budget: { perChapterCalls: s.perChapterCalls } },
		});
		ctx.model = foldBranch(entries);
	}
	let seq = 0,
		reservations = 0;
	const requests: ModelRequest[] = [];
	const unexpected: string[] = [];
	ctx.ports.interjections.seq = () => seq;
	ctx.ports.budget.reserve = () =>
		++reservations === s.budgetDenyAt
			? { ok: false, error: { code: "BUDGET_EXHAUSTED", message: "scripted budget denial" } }
			: { ok: true, reservationId: `r${reservations}`, costUsd: null };
	ctx.ports.models.call = async (req) => {
		const reply = s.script[requests.length];
		requests.push(req);
		if (!reply || reply.role !== req.role) {
			unexpected.push(`call ${requests.length}: expected ${reply?.role}, received ${req.role}`);
			throw new Error("Unexpected scripted call");
		}
		if (reply.event?.interjection !== undefined) seq = reply.event.interjection;
		if (reply.event?.append) entries.push(structuredClone(reply.event.append));
		return structuredClone(reply);
	};
	const p = s.input as Record<string, unknown>;
	const result =
		s.command === "eligibility"
			? api.checkCommitEligibility(ctx.model, String(p.draftId))
			: s.command === "macro"
				? await api.writeNextChapter(ctx, p)
				: s.command === "submitConstraints"
					? await api.submitConstraints(ctx, s.input as Parameters<typeof api.submitConstraints>[1])
					: s.command === "submitBible"
						? await api.submitBible(ctx, p as Parameters<typeof api.submitBible>[1])
						: s.command === "updateBible"
							? await api.updateBible(ctx, p as Parameters<typeof api.updateBible>[1])
							: s.command === "submitOutline"
								? await api.submitOutline(ctx, p as Parameters<typeof api.submitOutline>[1])
								: s.command === "patchOutline"
									? await api.patchOutline(ctx, p as Parameters<typeof api.patchOutline>[1])
									: s.command === "setChapterIntent"
										? await api.setChapterIntent(ctx, p as Parameters<typeof api.setChapterIntent>[1])
										: s.command === "writeDraft"
											? await api.writeDraft(ctx, p as Parameters<typeof api.writeDraft>[1])
											: s.command === "patchDraft"
												? await api.patchDraft(ctx, p as Parameters<typeof api.patchDraft>[1])
												: s.command === "checkDraft"
													? await api.checkDraft(ctx, p)
													: s.command === "reviewDraft"
														? await api.reviewDraft(ctx, p)
														: s.command === "respondObservations"
															? await api.respondObservations(ctx, p as Parameters<typeof api.respondObservations>[1])
															: s.command === "commit"
																? await api.commit(ctx, p as Parameters<typeof api.commit>[1])
																: (() => {
																		throw new Error(`Unregistered command: ${s.command}`);
																	})();
	return { result, requests, unexpected };
}
describe("E1-E7 W5 W6 A.3 A.6 A.8 BATCH frozen DS04 eligibility and macro", () => {
	for (const s of scenarios)
		test(s.id, async () => {
			const { result, requests, unexpected } = await execute(s);
			const expected = s.expected;
			const actual = JSON.parse(JSON.stringify(result)) as {
				ok: boolean;
				quality?: string;
				error?: { code: string; items?: string[] };
				usage?: { totalTokens: number };
				details?: {
					commit?: { quality: string };
					calls?: { role: string }[];
					responses?: { observationId: string; action: string }[];
				};
			};
			const quality = s.command === "eligibility" ? actual.quality : actual.details?.commit?.quality;
			const committed = !!actual.details?.commit;
			const dispositions = Object.fromEntries(
				(actual.details?.responses ?? []).map((r) => [r.observationId, r.action]),
			);
			const matched =
				unexpected.length === 0 &&
				actual.ok === expected.ok &&
				(!expected.code || actual.error?.code === expected.code) &&
				(!expected.quality || quality === expected.quality) &&
				(expected.calls === undefined || requests.length === expected.calls) &&
				(expected.totalTokens === undefined || (actual.usage?.totalTokens ?? 0) === expected.totalTokens) &&
				(expected.committed === undefined || committed === expected.committed) &&
				(!expected.roles || requests.map((r) => r.role).join() === expected.roles.join()) &&
				(!expected.items || expected.items.every((item) => actual.error?.items?.includes(item))) &&
				(!expected.dispositions ||
					Object.entries(expected.dispositions).every(([id, action]) => dispositions[id] === action)) &&
				(s.command !== "macro" ||
					(actual.details?.calls?.map((c) => c.role).join() ?? "") === requests.map((r) => r.role).join());
			record("flow", { id: s.id, matched, expected, actual, roles: requests.map((r) => r.role) });
			expect(unexpected).toEqual([]);
			expect(actual.ok, JSON.stringify(actual.error)).toBe(expected.ok);
			if (expected.code) expect(actual.error?.code).toBe(expected.code);
			if (expected.quality) expect(quality).toBe(expected.quality);
			if (expected.calls !== undefined) expect(requests).toHaveLength(expected.calls);
			if (expected.roles) expect(requests.map((r) => r.role)).toEqual(expected.roles);
			if (expected.totalTokens !== undefined) expect(actual.usage?.totalTokens ?? 0).toBe(expected.totalTokens);
			if (expected.committed !== undefined) expect(committed).toBe(expected.committed);
			if (expected.items) expect(actual.error?.items).toEqual(expect.arrayContaining(expected.items));
			if (expected.dispositions) expect(dispositions).toMatchObject(expected.dispositions);
			if (s.command === "macro")
				expect(actual.details?.calls?.map((c) => c.role) ?? []).toEqual(requests.map((r) => r.role));
			for (const req of requests.filter((r) => r.role === "keeper")) {
				const user = JSON.parse(req.user) as Record<string, unknown>;
				const input = (user.originalInput ?? user) as Record<string, unknown>;
				for (const forbidden of ["outline", "chapterIntent", "intent", "authorIntent", "ledger", "mustKeep", "beats"])
					expect(input).not.toHaveProperty(forbidden);
			}
			const twice = await execute(s);
			const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
			record("determinism", { id: s.id, hash1: hash(result), hash2: hash(twice.result) });
			expect(twice.result).toEqual(result);
		});
});
