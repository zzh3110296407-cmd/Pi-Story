import { expect, test } from "vitest";
import { CallSession } from "../src/flow/calls.ts";
import { generateDraft } from "../src/flow/commands.ts";
import { editorInput, writerInput } from "../src/flow/inputs.ts";
import { submitOutline } from "../src/plan/index.ts";
import { context } from "./context.ts";
import { tool } from "./fixtures.ts";

test("S3 calibrates only the writer draft budget while outline and editor retain original T", async () => {
	const outline = await submitOutline(context(), {
		narration: { viewpoint: "third person", tone: "quiet" },
		chapters: [{ n: 1, title: "The gate", targetWords: 1351, purpose: "Open the gate", turn: "Find the letter" }],
	});
	if (!outline.ok) throw new Error(outline.receipt);
	const ctx = context([tool("outline", "submit_outline", outline.details)]);
	ctx.settings.writerLengthFactor = 0.9;
	let input: unknown;
	ctx.ports.models.call = async (request) => {
		input = JSON.parse(request.user);
		return { text: "The harbor gate opened. Ada found the letter.", usage: null, stopReason: "stop", durationMs: 0 };
	};
	const result = await generateDraft(ctx, new CallSession(ctx), { chapter: 1 });
	expect(result.ok).toBe(true);
	expect(input).toMatchObject({ targetWords: 1216, wordRange: { min: 1034, max: 1398 } });
	expect(ctx.model.outline[0].targetWords).toBe(1351);
	expect(writerInput(ctx.model)).toMatchObject({ targetWords: 1351 });
	if (!result.ok) throw new Error(result.receipt);
	expect(editorInput(ctx.model, result.details, "full")).toMatchObject({ targetWords: 1351 });
});
