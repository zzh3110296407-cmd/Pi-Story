import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { instrumentRuntime } from "../../../scripts/eval/p2/metering.ts";
import { loadSettings, PiModelPort } from "../src/ports.ts";
import { createTestSession, draftText, keeperReply, openingCalls } from "./fixture.ts";

test("one metering boundary captures both SDK showrunner and internal role requests exactly once", async () => {
	const records: { type: string; [key: string]: unknown }[] = [];
	let ledger: UsageLedger | undefined;
	let restore: (() => void) | undefined;
	const fixture = await createTestSession({
		configureRuntime: (runtime, root) => {
			ledger = new UsageLedger(path.join(root, "usage.jsonl"), path.join(root, "reservations.jsonl"));
			restore = instrumentRuntime(runtime, {
				ledger,
				suiteId: "P2-CHAP",
				runId: "faux-metering",
				runLimitUsd: 1,
				allowFaux: true,
				emit: (record) => {
					records.push(record);
				},
			});
		},
	});
	try {
		fixture.faux.setResponses([
			fauxAssistantMessage([...openingCalls(), fauxToolCall("write_next_chapter", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(draftText),
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(keeperReply)),
			fauxAssistantMessage("Committed."),
		]);
		await fixture.session.prompt("Ada must survive.");
		expect(records.filter((record) => record.type === "request").map((record) => record.role)).toEqual([
			"showrunner",
			"writer",
			"editor",
			"keeper",
			"showrunner",
		]);
		expect(records.filter((record) => record.type === "response")).toHaveLength(5);
		expect(ledger?.snapshot()).toMatchObject({ requests: 5, totalUsd: 0, unknownCalls: 0 });
		expect(fixture.faux.state.callCount).toBe(5);
	} finally {
		restore?.();
		fixture.cleanup();
	}
});

test.each(["recording_failure", "request_limit"] as const)(
	"nonrecoverable measurement stop blocks later dispatch: %s",
	async (reason) => {
		let ledger: UsageLedger | undefined;
		let restore: (() => void) | undefined;
		const fixture = await createTestSession({
			configureRuntime: (runtime, root) => {
				ledger = new UsageLedger(path.join(root, "usage.jsonl"), path.join(root, "reservations.jsonl"));
				restore = instrumentRuntime(runtime, {
					ledger,
					suiteId: "P2-OPEN",
					runId: "faux-failure",
					runLimitUsd: 1,
					...(reason === "request_limit" ? { maxShowrunnerRequests: 1 } : {}),
					allowFaux: true,
					emit: (record) => {
						if (reason === "recording_failure" && record.type === "response")
							throw new Error("scripted recording IO failure");
					},
				});
			},
		});
		try {
			fixture.faux.setResponses([fauxAssistantMessage("unused"), fauxAssistantMessage("must not dispatch")]);
			await fixture.session.prompt("First attempt.");
			const before = fixture.faux.state.callCount;
			try {
				await fixture.session.prompt("Second attempt.");
			} catch {
				/* SDK may deliver the explicit error as an exception. */
			}
			expect(fixture.faux.state.callCount).toBe(before);
			expect(before).toBe(1);
			expect(ledger?.snapshot().requests).toBe(1);
		} finally {
			restore?.();
			fixture.cleanup();
		}
	},
);

test("a goal stop at the main request limit still records its zero-dispatch followup", async () => {
	let ledger: UsageLedger | undefined;
	let restore: (() => void) | undefined;
	const fixture = await createTestSession({
		configureRuntime: (runtime, root) => {
			ledger = new UsageLedger(path.join(root, "usage.jsonl"), path.join(root, "reservations.jsonl"));
			restore = instrumentRuntime(runtime, {
				ledger,
				suiteId: "P2-CHAP",
				runId: "goal-at-limit",
				runLimitUsd: 1,
				allowFaux: true,
				maxShowrunnerRequests: 1,
				emit: () => {},
			});
		},
	});
	try {
		fixture.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "toolResult" &&
				event.message.toolName === "write_next_chapter" &&
				!event.message.isError
			)
				void fixture.session.abort();
		});
		fixture.faux.setResponses([
			fauxAssistantMessage([...openingCalls(), fauxToolCall("write_next_chapter", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(draftText),
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(keeperReply)),
		]);
		await fixture.session.prompt("Ada must survive.");
		expect(ledger?.snapshot()).toMatchObject({ requests: 5, unknownCalls: 0 });
	} finally {
		restore?.();
		fixture.cleanup();
	}
});

test("an interrupted HTTP stream preserves received bytes and the original provider failure", async () => {
	const fixture = await createTestSession();
	const originalFetch = globalThis.fetch;
	const records: { type: string; [key: string]: unknown }[] = [];
	const ledger = new UsageLedger(path.join(fixture.root, "usage.jsonl"), path.join(fixture.root, "reservations.jsonl"));
	fixture.runtime.registerProvider("deepseek", { apiKey: "fixture-local", baseUrl: "https://no-network.test" });
	const restore = instrumentRuntime(fixture.runtime, {
		ledger,
		suiteId: "P2-CHAP",
		runId: "interrupted",
		runLimitUsd: 1,
		allowFaux: true,
		emit: (row) => {
			records.push(row);
		},
	});
	try {
		globalThis.fetch = async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "{" }, finish_reason: null }] })}\n\n`,
							),
						);
						setTimeout(() => controller.error(new Error("fixture connection ended")), 10);
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		const port = new PiModelPort(new ModelRegistry(fixture.runtime), loadSettings(fixture.agentDir).effective);
		const reply = await port.call({
			role: "editor",
			model: "deepseek/deepseek-flash",
			system: "JSON",
			user: "{}",
			maxTokens: 128,
			output: { kind: "json", schema: Type.Object({}) },
		});
		expect(reply.stopReason).toBe("error");
		expect(records.find((row) => row.type === "http_response")).toMatchObject({
			complete: false,
			body: expect.stringContaining('"id":"fixture"'),
		});
		expect(records.find((row) => row.type === "provider_response")).toMatchObject({
			response: { stopReason: "error", content: [{ type: "text", text: "{" }] },
		});
		expect(ledger.snapshot()).toMatchObject({ unknownCalls: 1 });
		globalThis.fetch = async () =>
			new Response(
				`data: ${JSON.stringify({ id: "fixture-next", choices: [{ index: 0, delta: { role: "assistant", content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		const continued = await port.call({
			role: "editor",
			model: "deepseek/deepseek-flash",
			system: "JSON",
			user: "{}",
			maxTokens: 128,
			output: { kind: "json", schema: Type.Object({}) },
		});
		expect(continued.json).toEqual({});
		expect(ledger.snapshot()).toMatchObject({ requests: 2, unknownCalls: 1 });
	} finally {
		restore();
		globalThis.fetch = originalFetch;
		fixture.cleanup();
	}
});
