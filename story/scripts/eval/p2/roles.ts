import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	type BranchEntry,
	BudgetGuard,
	type CommandContext,
	type DomainError,
	foldBranch,
	type ReviewDetails,
} from "@pi-story/core";
import { CallSession } from "../../../packages/core/src/flow/calls.ts";
import { generatePatch, generateReview, generateStateDelta } from "../../../packages/core/src/flow/commands.ts";
import {
	autoDispositions,
	checkDraft,
	createDraft,
	respondObservations,
	unavailableReview,
} from "../../../packages/core/src/production/index.ts";
import { changedLines } from "../../../packages/core/src/shared/text.ts";
import { sumUsage } from "../../../packages/core/src/usage/index.ts";
import { createCallJournal, FileRules, PiModelPort, PiPrices } from "../../../packages/pi-story/src/ports.ts";
import type { EvidenceArchive } from "./artifacts.ts";
import type { createDriver } from "./driver.ts";

type Driver = Awaited<ReturnType<typeof createDriver>>;
export interface KeeperCase {
	id: string;
	chapter: number;
	text: string;
	entries: BranchEntry[];
}
export interface EditCase {
	id: string;
	chapter: number;
	entries: BranchEntry[];
}
function evaluationContext(driver: Driver, archive: EvidenceArchive, scenario: EditCase) {
	archive.emit({ type: "evaluation_start", caseId: scenario.id, chapter: scenario.chapter });
	const entries = structuredClone(scenario.entries);
	const registry = new ModelRegistry(driver.runtime);
	const prices = new PiPrices(registry);
	const settings = {
		localRevision: driver.settings.localRevision ?? true,
		roles: driver.settings.roles,
		level: "L1" as const,
	};
	const budget = new BudgetGuard(() => {
		const model = foldBranch(entries);
		return {
			calls: model.calls,
			interruptions: model.interruptions,
			budget: {
				...(driver.settings.defaultBudget.tokens !== null ? { tokens: driver.settings.defaultBudget.tokens } : {}),
				...(driver.settings.defaultBudget.costUsd !== null ? { costUsd: driver.settings.defaultBudget.costUsd } : {}),
			},
		};
	}, prices);
	const ctx: CommandContext = {
		model: foldBranch(entries),
		signal: driver.signal,
		settings,
		ports: {
			entries: {
				branch: () => entries,
				authorMessage: (id) =>
					entries.find((entry) => entry.kind === "authorMessage" && entry.entryId === id)?.kind === "authorMessage"
						? (foldBranch(entries).authorMessages.find((entry) => entry.entryId === id)?.text ?? null)
						: null,
			},
			models: new PiModelPort(registry, settings, ({ payload: _payload, ...call }) =>
				archive.emit({ type: "role_call", caseId: scenario.id, ...call }),
			),
			prices,
			budget,
			rules: new FileRules(),
			interjections: { seq: () => 0 },
			callJournal: createCallJournal((event) =>
				archive.emit({ type: "role_checkpoint", caseId: scenario.id, toolCallId: "direct", ...event }),
			),
		},
	};
	const local: BranchEntry[] = [];
	const append = (toolName: string, details: unknown) => {
		local.push({
			kind: "toolResult",
			entryId: `@p2-eval:${scenario.id}:${local.length}`,
			toolName,
			isError: false,
			details,
		});
		ctx.model = foldBranch([...entries, ...local]);
	};
	return { ctx, append, entries: () => [...entries, ...local] };
}
export async function runKeeperTask(driver: Driver, archive: EvidenceArchive, scenario: KeeperCase) {
	const env = evaluationContext(driver, archive, scenario);
	const draft = createDraft(env.ctx, { chapter: scenario.chapter, text: scenario.text });
	if (!draft.ok) throw new Error(`Invalid frozen keeper input: ${draft.receipt}`);
	env.append("write_draft", draft.details);
	archive.emit({ type: "role_task", caseId: scenario.id, entries: env.entries(), draft: draft.details });
	const calls = new CallSession(env.ctx);
	const result = await generateStateDelta(env.ctx, calls, draft.details);
	archive.emit({
		type: "keeper_result",
		time: Date.now(),
		caseId: scenario.id,
		result,
		calls: calls.calls,
		usage: sumUsage(calls.calls),
	});
	return result;
}

export async function runEditTask(driver: Driver, archive: EvidenceArchive, scenario: EditCase) {
	const env = evaluationContext(driver, archive, scenario);
	const ctx = env.ctx;
	let draft = ctx.model.drafts.at(-1);
	if (!draft || draft.chapter !== scenario.chapter || draft.chapter !== ctx.model.lastChapter + 1)
		throw new Error("Invalid frozen editor draft");
	const calls = new CallSession(ctx);
	const checks = [],
		reviews: ReviewDetails[] = [];
	const initial = await checkDraft(ctx, { draftId: draft.draftId });
	if (!initial.ok) throw new Error(`Invalid frozen editor check input: ${initial.receipt}`);
	checks.push(initial.details);
	env.append("check_draft", initial.details);
	let fullReview: ReviewDetails | undefined;
	let error: DomainError | undefined;
	for (let round = 0; round < 2; round++) {
		const start = calls.calls.length;
		const reviewed = await generateReview(ctx, calls, draft, "full");
		if (reviewed.ok) {
			fullReview = reviewed.details;
			reviews.push(fullReview);
			env.append("review_draft", fullReview);
			break;
		}
		if (reviewed.error.code !== "PARSE_FAILURE") {
			error = reviewed.error;
			break;
		}
		const unavailable = unavailableReview(ctx.model, draft, calls.calls.slice(start), "full");
		reviews.push(unavailable);
		env.append("review_draft", unavailable);
		if (round === 1) error = { code: "REVIEW_REQUIRED", message: "全章审稿重试后仍不可用" };
	}
	let patchApplied = false;
	if (fullReview) {
		const issues = [...initial.details.observations, ...fullReview.observations].filter(
			(item) => item.objective && item.severity !== "minor" && item.scope === "local",
		);
		if (ctx.settings.localRevision && issues.length) {
			const original = draft;
			const patched = await generatePatch(ctx, calls, draft, issues);
			if (!patched.ok) error = patched.error;
			else {
				draft = patched.details;
				patchApplied = true;
				env.append("patch_draft", draft);
				const checked = await checkDraft(ctx, { draftId: draft.draftId });
				if (!checked.ok) throw new Error(checked.receipt);
				checks.push(checked.details);
				env.append("check_draft", checked.details);
				const scope = {
					spans: changedLines(original.text, draft.text).map((line) => ({ startLine: line, endLine: line })),
					forObservations: issues.map((item) => item.id),
				};
				const reviewed = await generateReview(ctx, calls, draft, scope, issues);
				if (!reviewed.ok) error = reviewed.error;
				else {
					reviews.push(reviewed.details);
					env.append("review_draft", reviewed.details);
				}
			}
		}
		if (!error) {
			const disposed = await respondObservations(ctx, { responses: autoDispositions(ctx.model) });
			if (!disposed.ok) error = disposed.error;
			else for (const response of disposed.details) env.append("respond_observation", response);
		}
	}
	const result = {
		ok: error === undefined && fullReview !== undefined,
		...(error ? { error } : {}),
		patchApplied,
		draft,
		checks,
		reviews,
		calls: calls.calls,
		usage: sumUsage(calls.calls),
		responses: ctx.model.responses,
	};
	archive.emit({ type: "edit_result", time: Date.now(), caseId: scenario.id, ...result });
	return result;
}
