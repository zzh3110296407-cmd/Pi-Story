import { Type } from "typebox";
import { afterEach, expect, test, vi } from "vitest";
import { CallSession } from "../src/flow/calls.ts";
import { writeNextChapter } from "../src/flow/next.ts";
import { foldBranch } from "../src/fold/index.ts";
import { BudgetGuard } from "../src/usage/index.ts";
import { context } from "./context.ts";
import { author, tool } from "./fixtures.ts";

afterEach(() => vi.useRealTimers());

function setup() {
	const ctx = context();
	ctx.ports.budget = new BudgetGuard(() => ({ calls: [], interruptions: [] }), { price: () => null });
	const journal: string[] = [];
	ctx.ports.callJournal = {
		started: (id) => journal.push(`start:${id}`),
		completed: (id) => journal.push(`end:${id}`),
	};
	return { ctx, journal, session: new CallSession(ctx) };
}
const success = { text: "A valid draft.", usage: null, stopReason: "stop", durationMs: 1 };

test.each(["stream", "connection", "timeout", "http500", "http503", "http429"])(
	"U7 retries %s exactly once, with separate reservation and linked records",
	async (kind) => {
		vi.useFakeTimers();
		const { ctx, session, journal } = setup();
		ctx.ports.models.call = vi
			.fn()
			.mockResolvedValueOnce({
				...success,
				text: "partial",
				stopReason: "error",
				failure: { kind: "transport", ...(kind === "http429" ? { httpStatus: 429, retryAfterMs: 30_000 } : {}) },
			})
			.mockResolvedValueOnce(success);
		const result = session.call("writer", "system", "input", { kind: "text" });
		await vi.advanceTimersByTimeAsync(kind === "http429" ? 9_999 : 1_999);
		expect(ctx.ports.models.call).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect((await result).ok).toBe(true);
		expect(ctx.ports.models.call).toHaveBeenCalledTimes(2);
		expect(session.calls).toHaveLength(2);
		expect(session.calls[0]).toMatchObject({ id: "reservation-1", status: "failed", usage: null });
		expect(session.calls[1]).toMatchObject({ id: "reservation-2", retryOf: "reservation-1" });
		expect(journal).toEqual(["start:reservation-1", "end:reservation-1", "start:reservation-2", "end:reservation-2"]);
	},
);
test.each(["rejected", "fatal", "aborted"])("U7 does not retry %s or dispatch a later fatal call", async (kind) => {
	const { ctx, session } = setup();
	ctx.ports.models.call = vi
		.fn()
		.mockResolvedValue({ ...success, stopReason: "error", failure: { kind, httpStatus: 402 } });
	expect((await session.call("writer", "", "", { kind: "text" })).ok).toBe(false);
	expect(ctx.ports.models.call).toHaveBeenCalledTimes(1);
	if (kind === "fatal") {
		expect((await session.call("editor", "", "", { kind: "text" })).ok).toBe(false);
		expect(ctx.ports.models.call).toHaveBeenCalledTimes(1);
	}
});
test("U7 transport exception retries once, a second failure stops with both fees reserved", async () => {
	vi.useFakeTimers();
	const { ctx, session } = setup();
	ctx.ports.models.call = vi
		.fn()
		.mockRejectedValue(Object.assign(new Error("private"), { failure: { kind: "transport" } }));
	const pending = session.call("keeper", "", "", { kind: "text" });
	await vi.runAllTimersAsync();
	const result = await pending;
	expect(result.ok).toBe(false);
	expect(JSON.stringify(result)).not.toContain("private");
	expect(session.calls).toHaveLength(2);
	expect(session.calls.every((call) => call.usage === null)).toBe(true);
});
test("U7 cancellation during backoff prevents a retry and keeps the failed attempt", async () => {
	vi.useFakeTimers();
	const { ctx, session } = setup();
	const controller = new AbortController();
	ctx.signal = controller.signal;
	ctx.ports.models.call = vi
		.fn()
		.mockResolvedValue({ ...success, stopReason: "error", failure: { kind: "transport" } });
	const pending = session.call("writer", "", "", { kind: "text" });
	await vi.advanceTimersByTimeAsync(1_000);
	controller.abort();
	expect((await pending).ok).toBe(false);
	expect(ctx.ports.models.call).toHaveBeenCalledTimes(1);
	expect(session.calls).toHaveLength(1);
});
test.each(["perChapterCalls", "budget"])("U7 checks %s again before retry", async (limit) => {
	vi.useFakeTimers();
	const { ctx, session } = setup();
	if (limit === "perChapterCalls") {
		const entries = [
			{
				kind: "custom" as const,
				entryId: "goal",
				customType: "story.goal",
				data: { schema: "story/goal@1", budget: { perChapterCalls: 1 } },
			},
		];
		ctx.ports.entries.branch = () => entries;
	} else {
		ctx.ports.budget = new BudgetGuard(() => ({ calls: [], interruptions: [], budget: { tokens: 10_241 } }), {
			price: () => null,
		});
	}
	ctx.ports.models.call = vi
		.fn()
		.mockResolvedValue({ ...success, stopReason: "error", failure: { kind: "transport" } });
	const pending = session.call("writer", "", "", { kind: "text" });
	await vi.runAllTimersAsync();
	expect(await pending).toMatchObject({ ok: false, error: { code: "BUDGET_EXHAUSTED" } });
	expect(ctx.ports.models.call).toHaveBeenCalledTimes(1);
});
test("U7 parse repair is independent and receives no transport retry link", async () => {
	const { ctx, session } = setup();
	ctx.ports.models.call = vi
		.fn()
		.mockResolvedValueOnce({ ...success, text: "{" })
		.mockResolvedValueOnce({ ...success, text: "{}" });
	const result = await session.json("keeper", "", {}, Type.Object({}), () => ({
		ok: true,
		details: {},
		receipt: "ok",
	}));
	expect(result.ok).toBe(true);
	expect(session.calls).toHaveLength(2);
	expect(session.calls[1]).not.toHaveProperty("retryOf");
});
test("U7 writer retry success completes a real core chapter, preserving both attempts", async () => {
	vi.useFakeTimers();
	const entries = [
		author(),
		tool("outline", "submit_outline", {
			schema: "story/outline@1",
			rev: 1,
			op: "submit",
			narration: { viewpoint: "third", tone: "quiet" },
			chapters: [{ n: 1, targetWords: 4, purpose: "Open the door" }],
		}),
	];
	const { ctx, session: _session } = setup();
	ctx.model = foldBranch(entries);
	ctx.ports.entries.branch = () => entries;
	ctx.ports.models.call = vi
		.fn()
		.mockResolvedValueOnce({ ...success, stopReason: "error", failure: { kind: "transport" } })
		.mockResolvedValueOnce({ ...success, text: "The door opened quietly." })
		.mockResolvedValueOnce({ ...success, text: '{"observations":[]}' })
		.mockResolvedValueOnce({
			...success,
			text: JSON.stringify({
				facts: [],
				claims: [],
				cognitions: [],
				relations: [],
				hooks: [],
				summary: { title: "Door", characters: [], events: ["The door opened."], mood: "quiet" },
				issues: [],
			}),
		});
	const pending = writeNextChapter(ctx);
	await vi.runAllTimersAsync();
	const result = await pending;
	expect(result.ok, result.receipt).toBe(true);
	expect(result.details?.calls).toHaveLength(4);
	expect(result.details?.commit?.chapter).toBe(1);
	expect(result.details?.calls[1]?.retryOf).toBe(result.details?.calls[0]?.id);
});
