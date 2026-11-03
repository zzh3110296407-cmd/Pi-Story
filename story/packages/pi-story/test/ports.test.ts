import { writeFileSync } from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { BranchSource } from "../src/entries.ts";
import { loadSettings, PiModelPort, PiPrices, SessionPorts } from "../src/ports.ts";
import { createTestSession } from "./fixture.ts";

test("settings use only the selected global file and reject malformed budgets", async () => {
	const fixture = await createTestSession();
	try {
		const settings = loadSettings(fixture.agentDir);
		expect(settings.effective.localRevision).toBe(true);
		expect(settings.effective.roles.keeper.model).toBe("faux/script");
		writeFileSync(
			path.join(fixture.agentDir, "story-forge.json"),
			JSON.stringify({ ...settings.global, defaultBudget: { costUsd: -1 } }),
		);
		expect(() => loadSettings(fixture.agentDir)).toThrow(/settings/u);
		expect(() => loadSettings("")).toThrow(/PI_CODING_AGENT_DIR/u);
	} finally {
		fixture.cleanup();
	}
});

test("Pi model port makes exactly one JSON-mode request through the shared registry", async () => {
	const fixture = await createTestSession();
	try {
		let observed = 0;
		fixture.faux.setResponses([
			(context, options) => {
				expect(options?.reasoning).toBe("low");
				expect(options?.samplingParams).toEqual({ response_format: { type: "json_object" } });
				expect(options?.maxRetries).toBe(0);
				expect(JSON.stringify(context)).toContain("Only JSON");
				return fauxAssistantMessage('{"ok":true}');
			},
		]);
		const registry = new ModelRegistry(fixture.runtime);
		const port = new PiModelPort(registry, loadSettings(fixture.agentDir).effective, () => {
			observed++;
		});
		const reply = await port.call({
			role: "keeper",
			model: "faux/script",
			system: "Only JSON",
			user: "{}",
			maxTokens: 128,
			output: { kind: "json", schema: Type.Object({ ok: Type.Boolean() }) },
		});
		expect(reply.json).toEqual({ ok: true });
		expect(reply.usage).not.toBeNull();
		expect(fixture.faux.state.callCount).toBe(1);
		expect(observed).toBe(1);
		expect(new PiPrices(registry).price("faux/script")).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(new PiPrices(registry).price("absent/model")).toBeNull();
	} finally {
		fixture.cleanup();
	}
});

test("reservations are acknowledged only after their own tool result is persisted", async () => {
	const fixture = await createTestSession();
	try {
		const source = new BranchSource(() => fixture.manager.getBranch());
		const settings = loadSettings(fixture.agentDir);
		settings.global.defaultBudget.tokens = 20;
		const state = new SessionPorts(
			source,
			() => fixture.manager.getBranch(),
			new ModelRegistry(fixture.runtime),
			settings,
		);
		const ticket = state.begin();
		const reservation = state.guard.reserve({
			role: "keeper",
			model: "faux/script",
			inputTokensEstimate: 10,
			maxOutputTokens: 10,
		});
		if (!reservation.ok) throw new Error("Unexpected reserve failure");
		const call = {
			role: "keeper" as const,
			model: "faux/script",
			reservedInputTokens: 10,
			reservedOutputTokens: 10,
			reservedCostUsd: 0,
			usage: null,
			status: "missing" as const,
		};
		state.guard.settle(reservation.reservationId, call);
		state.complete("first", ticket);
		state.sync();
		expect(state.guard.settledReservations()).toEqual([reservation.reservationId]);
		fixture.manager.appendMessage(
			fauxAssistantMessage({ type: "toolCall", id: "first", name: "write_next_chapter", arguments: {} }),
		);
		fixture.manager.appendMessage({
			role: "toolResult",
			toolCallId: "first",
			toolName: "write_next_chapter",
			isError: true,
			content: [{ type: "text", text: "not a valid persisted macro" }],
			details: { schema: "story/macro-result@1" },
			timestamp: 0,
		});
		state.sync();
		expect(state.guard.settledReservations()).toEqual([reservation.reservationId]);
		fixture.manager.appendMessage({
			role: "toolResult",
			toolCallId: "first",
			toolName: "write_next_chapter",
			isError: true,
			content: [{ type: "text", text: "failed" }],
			details: {
				schema: "story/macro-result@1",
				ok: false,
				revision: true,
				interjectionSeq: { atStart: 0 },
				steps: [],
				calls: [call],
				error: { code: "TRANSPORT_FAILURE", message: "stopped" },
			},
			timestamp: 0,
		});
		state.sync();
		expect(source.model().calls).toEqual([call]);
		expect(state.guard.settledReservations()).toEqual([]);
		expect(
			state.guard.reserve({ role: "keeper", model: "faux/script", inputTokensEstimate: 1, maxOutputTokens: 1 }).ok,
		).toBe(false);
		expect(state.ports.interjections.seq()).toBe(0);
	} finally {
		fixture.cleanup();
	}
});

test("a role reservation larger than the model context is rejected before dispatch", async () => {
	const fixture = await createTestSession();
	try {
		const tiny = fauxProvider({ provider: "tiny-faux", models: [{ id: "tiny", contextWindow: 100, maxTokens: 8192 }] });
		fixture.runtime.registerNativeProvider(tiny.provider);
		const port = new PiModelPort(new ModelRegistry(fixture.runtime), loadSettings(fixture.agentDir).effective);
		await expect(
			port.call({
				role: "writer",
				model: "tiny-faux/tiny",
				system: "Write",
				user: "{}",
				maxTokens: 32,
				output: { kind: "text" },
			}),
		).rejects.toThrow(/context window/u);
		expect(tiny.state.callCount).toBe(0);
	} finally {
		fixture.cleanup();
	}
});

test("the pinned DeepSeek adapter sends low thinking and JSON mode on the actual HTTP body", async () => {
	const fixture = await createTestSession();
	const originalFetch = globalThis.fetch;
	try {
		fixture.runtime.registerProvider("deepseek", { apiKey: "fixture-local", baseUrl: "https://no-network.test" });
		const bodies: unknown[] = [];
		globalThis.fetch = async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			const chunks = [
				{
					id: "fixture",
					choices: [{ index: 0, delta: { role: "assistant", content: '{"ok":true}' }, finish_reason: null }],
				},
				{
					id: "fixture",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				},
			];
			return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		};
		const port = new PiModelPort(new ModelRegistry(fixture.runtime), loadSettings(fixture.agentDir).effective);
		const reply = await port.call({
			role: "keeper",
			model: "deepseek/deepseek-flash",
			system: "Return JSON only",
			user: "{}",
			maxTokens: 128,
			output: { kind: "json", schema: Type.Object({ ok: Type.Boolean() }) },
		});
		expect(reply.json).toEqual({ ok: true });
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toMatchObject({
			thinking: { type: "enabled" },
			reasoning_effort: "low",
			response_format: { type: "json_object" },
			max_tokens: 128,
		});
	} finally {
		globalThis.fetch = originalFetch;
		fixture.cleanup();
	}
});
