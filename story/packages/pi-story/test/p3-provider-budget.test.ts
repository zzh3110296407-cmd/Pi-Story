import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { authorGoal } from "@pi-story/core";
import { expect, test } from "vitest";
import { storyProgress } from "../src/context.ts";
import { createTestSession } from "./fixture.ts";

async function useLocalDeepSeek(f: Awaited<ReturnType<typeof createTestSession>>) {
	f.runtime.registerProvider("deepseek", { apiKey: "fixture-local", baseUrl: "https://no-network.test" });
	const model = f.runtime.getModel("deepseek", "deepseek-flash");
	if (!model) throw new Error("Pinned model unavailable");
	await f.session.setModel(model);
}
test.each(["tokens=0", "tokens=1", "usd=0"])("U5 %s aborts the actual SDK request before fetch", async (budget) => {
	const f = await createTestSession({ observe: () => {} });
	const oldFetch = globalThis.fetch;
	try {
		f.faux.setResponses([fauxAssistantMessage("Ready.")]);
		await f.session.prompt("Ada must survive.");
		await f.session.prompt(`/budget ${budget}`);
		await useLocalDeepSeek(f);
		let dispatched = 0;
		globalThis.fetch = async () => {
			dispatched++;
			throw new Error("Must not dispatch");
		};
		await f.session.prompt("Continue writing.");
		expect(dispatched).toBe(0);
		expect(f.story?.current()?.stopReason).toBe("budget_exhausted");
		const stops = f.manager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "story.stop");
		expect(stops).toHaveLength(1);
		expect(stops[0]).toMatchObject({
			display: true,
			details: { reason: "budget_exhausted", progress: { stopReason: "budget_exhausted" } },
		});
		const state = f.story?.current();
		if (!state) throw new Error("Story runtime missing");
		expect(JSON.parse(storyProgress(state)).stopReason).toBe("budget_exhausted");
		expect(f.errors).toEqual([]);
	} finally {
		globalThis.fetch = oldFetch;
		f.cleanup();
	}
});
test("U5 successful main request releases its own reservation only after native persistence", async () => {
	const f = await createTestSession({ observe: () => {} });
	const oldFetch = globalThis.fetch;
	try {
		f.faux.setResponses([fauxAssistantMessage("Ready.")]);
		await f.session.prompt("Ada must survive.");
		await useLocalDeepSeek(f);
		let pendingBeforeAppend = 0;
		f.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant")
				pendingBeforeAppend = f.story?.current()?.services.guard.settledReservations().length ?? 0;
		});
		globalThis.fetch = async () =>
			new Response(
				`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Ready" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		await f.session.prompt("Report progress.");
		const services = f.story?.current()?.services;
		if (!services) throw new Error("Story runtime missing");
		services.sync();
		expect(services.guard.inFlight().tokens).toBe(0);
		expect(services.guard.settledReservations()).toEqual([]);
		expect(pendingBeforeAppend).toBe(1);
		expect(services.guard.summary().knownTokens).toBeGreaterThanOrEqual(15);
		expect(f.errors).toEqual([]);
	} finally {
		globalThis.fetch = oldFetch;
		f.cleanup();
	}
});

test("U5 a native transport error retains its unknown reservation instead of initialized zero usage", async () => {
	const f = await createTestSession({ observe: () => {} });
	const oldFetch = globalThis.fetch;
	try {
		f.faux.setResponses([fauxAssistantMessage("Ready.")]);
		await f.session.prompt("Ada must survive.");
		await useLocalDeepSeek(f);
		globalThis.fetch = async () => {
			throw new TypeError("synthetic connection failure");
		};
		await f.session.prompt("Report progress.");
		const guard = f.story?.current()?.services.guard;
		if (!guard) throw new Error("Story runtime missing");
		const usage = guard.summary();
		expect(usage.missingCalls).toBe(1);
		expect(usage.reservedTokens).toBeGreaterThan(0);
		expect(guard.inFlight().tokens).toBe(0);
		await f.session.prompt(`/budget tokens=${usage.knownTokens + usage.reservedTokens}`);
		expect(guard.check({ role: "writer", model: "faux/script", inputTokensEstimate: 1, maxOutputTokens: 0 }).ok).toBe(
			false,
		);
	} finally {
		globalThis.fetch = oldFetch;
		f.cleanup();
	}
});

test("U6 successful real SDK compaction reserves before each request and accounts its native aggregate once", async () => {
	const f = await createTestSession({
		observe: () => {},
		compactionSettings: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 },
	});
	const oldFetch = globalThis.fetch;
	try {
		f.faux.setResponses([
			fauxAssistantMessage("Ready to plan the mystery."),
			fauxAssistantMessage("The harbor is ready."),
		]);
		await f.session.prompt("Ada must survive.");
		await f.session.prompt("Plan a mystery in the harbor.");
		await useLocalDeepSeek(f);
		const guard = f.story?.current()?.services.guard;
		if (!guard) throw new Error("Story runtime missing");
		const before = guard.summary().knownTokens;
		const originalConfig = f.runtime.getRegisteredProviderConfig("deepseek");
		let calls = 0;
		const inFlight: number[] = [];
		globalThis.fetch = async () => {
			calls++;
			inFlight.push(guard.inFlight().tokens);
			return new Response(
				`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "The author requested a harbor mystery. Ada survives." }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		};
		await f.session.compact();
		expect(calls).toBeGreaterThan(0);
		expect(
			inFlight.every((tokens) => tokens > 0),
			JSON.stringify(inFlight),
		).toBe(true);
		expect(guard.summary().knownTokens).toBe(before + 15 * calls);
		expect(guard.inFlight().tokens).toBe(0);
		expect(guard.settledReservations()).toEqual([]);
		expect(f.runtime.getRegisteredNativeProvider("deepseek")).toBeUndefined();
		expect(f.runtime.getRegisteredProviderConfig("deepseek")).toEqual(originalConfig);
		expect(f.errors).toEqual([]);
	} finally {
		globalThis.fetch = oldFetch;
		f.cleanup();
	}
});

test("U6 a budget change between split summaries prevents the second request and restores the provider", async () => {
	const f = await createTestSession({
		observe: () => {},
		compactionSettings: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 },
	});
	const oldFetch = globalThis.fetch;
	try {
		f.faux.setResponses([
			fauxAssistantMessage("Ready to plan the mystery."),
			fauxAssistantMessage("The harbor is ready."),
		]);
		await f.session.prompt("Ada must survive.");
		await f.session.prompt("Plan a mystery in the harbor.");
		await useLocalDeepSeek(f);
		const state = f.story?.current();
		if (!state) throw new Error("Story runtime missing");
		let calls = 0;
		globalThis.fetch = async () => {
			calls++;
			const result = authorGoal(state.source.model(), { budget: { tokens: 1 } });
			if (!result.ok) throw new Error(result.receipt);
			f.manager.appendCustomEntry("story.goal", result.details);
			return new Response(
				`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "The author requested a harbor mystery." }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		};
		await expect(f.session.compact()).rejects.toThrow();
		expect(calls).toBe(1);
		expect(state.stopReason).toBe("budget_exhausted");
		expect(state.services.guard.inFlight().tokens).toBe(0);
		expect(state.services.guard.summary().knownTokens).toBeGreaterThanOrEqual(15);
		expect(f.runtime.getRegisteredNativeProvider("deepseek")).toBeUndefined();
	} finally {
		globalThis.fetch = oldFetch;
		f.cleanup();
	}
});
test("U6 insufficient budget cancels real compaction before any provider dispatch", async () => {
	const f = await createTestSession({
		observe: () => {},
		compactionSettings: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 },
	});
	const oldFetch = globalThis.fetch;
	try {
		f.faux.setResponses([
			fauxAssistantMessage("Ready to plan the mystery."),
			fauxAssistantMessage("The harbor is ready."),
		]);
		await f.session.prompt("Ada must survive.");
		await f.session.prompt("Plan a mystery in the harbor.");
		await f.session.prompt("/budget tokens=0");
		await useLocalDeepSeek(f);
		let dispatched = 0;
		globalThis.fetch = async () => {
			dispatched++;
			throw new Error("Must not dispatch");
		};
		await expect(f.session.compact()).rejects.toThrow(/cancel/iu);
		expect(dispatched).toBe(0);
		expect(f.story?.current()?.stopReason).toBe("budget_exhausted");
	} finally {
		globalThis.fetch = oldFetch;
		f.cleanup();
	}
});
