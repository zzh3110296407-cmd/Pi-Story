import { expect, test } from "vitest";
import { settleCommit } from "../src/canon/commit.ts";
import { commit } from "../src/flow/commands.ts";
import { writeNextChapter } from "../src/flow/next.ts";
import { type BranchEntry, foldBranch } from "../src/fold/index.ts";
import type { ModelPort } from "../src/ports/index.ts";
import type { CallRecord, DeltaProposal } from "../src/schema/index.ts";
import { context } from "./context.ts";
import { tool } from "./fixtures.ts";
import { loadDataset, record } from "./support/datasets.ts";

interface Scenario {
	id: string;
	entries: BranchEntry[];
	input: { brief?: string };
	script: (Awaited<ReturnType<ModelPort["call"]>> & { role: string })[];
}
const scenarios = loadDataset<Scenario[]>("DS04-eligibility-flow", "scenarios.json", "v2").data;
const happy = scenarios.find((s) => s.id === "flow-happy");
const eligible = scenarios.find((s) => s.id === "eligible-clean");
if (!happy || !eligible) throw new Error("Required existing flow fixtures missing");
const proposal = happy.script.find((s) => s.role === "keeper")?.json as DeltaProposal;
if (!proposal) throw new Error("Required keeper proposal missing");

for (const [index, role] of ["writer", "editor", "keeper"].entries()) {
	test(`A.6 U4 cancellation after ${role} completes never commits and retains reported usage`, async () => {
		const entries = structuredClone(happy.entries),
			ctx = context(entries);
		const controller = new AbortController();
		ctx.signal = controller.signal;
		ctx.batch = { committed: false };
		const roles: string[] = [],
			settled: CallRecord[] = [];
		ctx.ports.budget.settle = (_id, call) => {
			settled.push(call);
		};
		ctx.ports.models.call = async (req) => {
			const reply = structuredClone(happy.script[roles.length]);
			roles.push(req.role);
			expect(req.role).toBe(reply.role);
			if (req.role === role) queueMicrotask(() => controller.abort());
			return reply;
		};
		const result = await writeNextChapter(ctx, happy.input);
		record("review-regression", { id: `abort-after-${role}`, ok: result.ok, result, settled });
		expect(controller.signal.aborted).toBe(true);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Cancelled macro returned a successful commit");
		expect(result.error.code).toBe("TRANSPORT_FAILURE");
		expect(result.details?.commit).toBeUndefined();
		expect(ctx.batch.committed).toBe(false);
		expect(roles).toEqual(["writer", "editor", "keeper"].slice(0, index + 1));
		expect(result.usage?.totalTokens).toBe(20 * (index + 1));
		expect(settled).toHaveLength(index + 1);
		expect(settled.every((call) => call.status === "reported" && call.usage?.totalTokens === 20)).toBe(true);
		const folded = foldBranch([...entries, tool("cancelled-result", "write_next_chapter", result.details, true)]);
		expect(folded.lastChapter).toBe(0);
		expect(folded.calls).toHaveLength(index + 1);
	});
}

for (const when of ["before_settlement", "during_final_branch_read"] as const) {
	test(`A.6 final commit gate rejects cancellation ${when} without marking the batch committed`, async () => {
		const entries = structuredClone(eligible.entries),
			ctx = context(entries);
		const controller = new AbortController();
		ctx.signal = controller.signal;
		ctx.batch = { committed: false };
		if (when === "before_settlement") controller.abort();
		else
			ctx.ports.entries.branch = () => {
				controller.abort();
				return entries;
			};
		const result = await settleCommit(ctx, { draftId: "c01-d01", proposal, startSeq: 0 });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Cancelled settlement returned a commit");
		expect(result.error.code).toBe("TRANSPORT_FAILURE");
		expect(result.details?.commit).toBeUndefined();
		expect(ctx.batch.committed).toBe(false);
	});
}

for (const cancel of [false, true]) {
	test(`A.6 standalone commit ${cancel ? "rejects completed-call cancellation" : "succeeds without cancellation"}`, async () => {
		const ctx = context(structuredClone(eligible.entries)),
			controller = new AbortController();
		ctx.signal = controller.signal;
		ctx.batch = { committed: false };
		ctx.ports.models.call = async (req) => {
			expect(req.role).toBe("keeper");
			if (cancel) queueMicrotask(() => controller.abort());
			return structuredClone(happy.script[2]);
		};
		const result = await commit(ctx, { draftId: "c01-d01" });
		expect(result.ok).toBe(!cancel);
		expect(!!result.details?.commit).toBe(!cancel);
		expect(ctx.batch.committed).toBe(!cancel);
		expect(result.usage?.totalTokens).toBe(20);
		expect(result.details?.calls).toHaveLength(1);
	});
}
