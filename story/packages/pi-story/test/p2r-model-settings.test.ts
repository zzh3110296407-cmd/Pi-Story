import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { EvidenceArchive } from "../../../scripts/eval/p2/artifacts.ts";
import { createDriver } from "../../../scripts/eval/p2/driver.ts";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { PiModelPort } from "../src/ports.ts";

for (const [choice, suite] of [
	["pro-low", "P2-OPEN"],
	["flash-off", "P2-OPEN"],
	["pro-low", "P2-EDIT"],
] as const) {
	test(`R5 ${suite} ${choice} reaches the actual HTTP body and preserves other roles`, async () => {
		const work = process.env.PI_STORY_WORK_DIR;
		if (!work) throw new Error("P2 workspace required");
		mkdirSync(path.join(work, "temp"), { recursive: true });
		const root = mkdtempSync(path.join(work, "temp/p2r-models-"));
		const archive = new EvidenceArchive(path.join(root, "run"), path.join(root, "archive"), {
			suiteId: "P2-OPEN",
			runId: "offline-models",
			expectedCaseIds: ["one"],
			stage: "P2R",
		});
		const fees = new UsageLedger(path.join(root, "usage.jsonl"), path.join(root, "reservations.jsonl"));
		const originalFetch = globalThis.fetch;
		const previousKey = process.env.DEEPSEEK_API_KEY;
		process.env.DEEPSEEK_API_KEY = "fixture-local";
		const bodies: Record<string, unknown>[] = [];
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
					usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
				},
			];
			return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		};
		let driver: Awaited<ReturnType<typeof createDriver>> | undefined;
		try {
			driver = await createDriver({
				work: path.join(root, "pi"),
				runId: "offline-models",
				caseId: "one",
				suiteId: suite,
				archive,
				ledger: fees,
				runLimitUsd: 3,
				phase: "E12",
				modelSetting: choice,
				configureRuntime: (runtime) =>
					runtime.registerProvider("deepseek", { apiKey: "fixture-local", baseUrl: "https://no-network.test" }),
			});
			await driver.session.prompt("Open a story.");
			expect(bodies).toHaveLength(1);
			expect(bodies[0]).toMatchObject(
				suite === "P2-EDIT"
					? { model: "deepseek-flash", thinking: { type: "enabled" }, reasoning_effort: "low" }
					: choice === "pro-low"
						? { model: "deepseek-v4-pro", thinking: { type: "enabled" }, reasoning_effort: "low" }
						: { model: "deepseek-flash", thinking: { type: "disabled" } },
			);
			const registry = new ModelRegistry(driver.runtime);
			const internal = new PiModelPort(registry, { localRevision: true, level: "L1", roles: driver.settings.roles });
			const role = suite === "P2-EDIT" ? "editor" : "keeper";
			await internal.call({
				role,
				model: driver.settings.roles[role].model,
				system: `name: ${role === "editor" ? "story-review-matrix" : "story-state-projection"}\nReturn JSON`,
				user: "{}",
				maxTokens: 32,
				output: { kind: "json", schema: Type.Object({ ok: Type.Boolean() }) },
			});
			expect(bodies[1]).toMatchObject({
				model: suite === "P2-EDIT" ? "deepseek-v4-pro" : "deepseek-flash",
				thinking: { type: "enabled" },
				reasoning_effort: "low",
			});
			expect(driver.settings.roles.keeper.thinking).toBe("low");
			expect(driver.settings.roles.writer.model).toBe("deepseek/deepseek-flash");
			await expect(
				internal.call({
					role: "keeper",
					model: "deepseek/deepseek-v4-pro",
					system: "name: story-state-projection\nReturn JSON",
					user: "{}",
					maxTokens: 32,
					output: { kind: "json", schema: Type.Object({ ok: Type.Boolean() }) },
				}),
			).rejects.toThrow(/declared role model setting/u);
			expect(bodies).toHaveLength(2);
		} finally {
			driver?.close();
			globalThis.fetch = originalFetch;
			if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
			else process.env.DEEPSEEK_API_KEY = previousKey;
		}
		archive.finish();
	});
}
