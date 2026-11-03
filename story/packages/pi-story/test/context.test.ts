import { readFileSync } from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { type ContextCase, contextInput, contextPredicates } from "../../../scripts/eval/p2/context.mjs";
import { FileRules, loadSettings, PiModelPort } from "../src/ports.ts";
import { createTestSession } from "./fixture.ts";

test("DS12 development examples use shared core construction and the extension's actual Pi model port", async () => {
	const fixture = await createTestSession();
	try {
		const root = path.resolve(import.meta.dirname, "../../../testing/datasets/DS12-context-cases/v2");
		const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8")) as {
			files: { path: string; split: string }[];
		};
		const examples = manifest.files.filter((file) => file.split === "development");
		expect(examples.length).toBeGreaterThan(0);
		for (const file of examples) {
			if (!file.path.startsWith("dev/")) throw new Error("Development-only read boundary");
			const scenario = JSON.parse(readFileSync(path.join(root, file.path), "utf8")) as ContextCase;
			const input = contextInput(scenario);
			const role =
				scenario.role === "patch"
					? "writer"
					: scenario.role === "keeper"
						? "keeper"
						: scenario.role === "writer"
							? "writer"
							: "editor";
			fixture.faux.setResponses([fauxAssistantMessage("{}")]);
			const port = new PiModelPort(
				new ModelRegistry(fixture.runtime),
				loadSettings(fixture.agentDir).effective,
				(call) => {
					const actual = JSON.parse(call.request.user);
					expect(
						contextPredicates(actual, [...scenario.must, ...scenario.forbidden]).every(
							(item: { passed: boolean }) => item.passed,
						),
						scenario.id,
					).toBe(true);
				},
			);
			await port.call({
				role,
				model: "faux/script",
				system: new FileRules().get(
					role === "writer" ? "writer" : role === "keeper" ? "state-projection" : "review-matrix",
				),
				user: JSON.stringify(input),
				maxTokens: 32,
				output: { kind: "text" },
			});
		}
		expect(fixture.faux.state.callCount).toBe(examples.length);
	} finally {
		fixture.cleanup();
	}
});

test("context predicates reject missing text and forbidden nested fields, preserving JSON escaping", () => {
	const input = { draft: { text: "Line one.\nLine two." }, nested: [{ ledger: "forbidden" }], present: false };
	expect(
		contextPredicates(input, [
			{ type: "text_contains", value: "Line one.\nLine two." },
			{ type: "text_contains", value: "not present" },
			{ type: "field_absent", value: "ledger" },
			{ type: "json_path_exists", value: "$.nested[0].ledger" },
			{ type: "json_path_exists", value: "$.present" },
		]).map((item: { passed: boolean }) => item.passed),
	).toEqual([true, false, false, true, true]);
});
