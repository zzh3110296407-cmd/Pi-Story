import { readFileSync } from "node:fs";
import path from "node:path";
import type { BibleItemInput, ConstraintsInput, DomainError, submitOutline } from "@pi-story/core";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { sha256 } from "../p2/artifacts.ts";

export interface InputEvent {
	type: "authorMessage" | "steer" | "followUp" | "continue";
	text: string;
	at?: string;
}
interface Action {
	tool?: string;
	reply?: boolean;
	argsMatch?: Record<string, unknown>;
}
export type Setup =
	| {
			step: "open";
			constraints: ConstraintsInput;
			bible: { items: BibleItemInput[] };
			outline: Parameters<typeof submitOutline>[1];
	  }
	| {
			step: "commitChapters";
			count: number;
			texts: string[];
			keeperHooks: Array<Array<{ evidenceText: string; [key: string]: unknown }>>;
	  }
	| { step: "command" | "authorMessage"; text: string }
	| { step: "toolCall"; tool: string; args: Record<string, unknown>; result: { ok: false; error: DomainError } };
export interface Scenario {
	schema: "story/p3-scenario@1" | "story/p3-scenario@2";
	id: string;
	split: "dev" | "acceptance";
	category: string;
	mode: "real" | "faux";
	storyPrompt?: string;
	setup: Setup[];
	trigger: InputEvent;
	expect: { acceptable: Action[]; forbidden: Action[]; programChecks: string[]; judgeChecks: string[] };
	execution: {
		internalRoles: "real" | "faux";
		maxShowrunnerRequests: number;
		maxChapterAttempts: number;
		stopAfterFirstAction?: boolean;
		stopAt?: "decisive_action";
		maxReadOnlyCalls?: number;
		onBoundExceeded: "record_failure_and_stop";
		targetChapterMaximum?: number;
		start?: InputEvent;
		afterTrigger?: InputEvent[];
		dialogResponses?: Array<{
			on: "ask_author";
			reply: string;
			delayUntilAssertion: "automatic_continuation_paused";
		}>;
		fauxProfile?: {
			id: string;
			script?: Array<{ role: string; task: string; text?: string; json?: unknown }>;
			validRetryText?: string;
			[key: string]: unknown;
		};
		usageSnapshot?: { knownUsd: number; unknownReservationsUsd: number; conservativeTotalUsd: number; status: string };
	};
}
const text = Type.String({ minLength: 1 });
const event = Type.Object({
	type: Type.Union([
		Type.Literal("authorMessage"),
		Type.Literal("steer"),
		Type.Literal("followUp"),
		Type.Literal("continue"),
	]),
	text,
	at: Type.Optional(text),
});
const scenarioSchema = Type.Object({
	schema: Type.Union([Type.Literal("story/p3-scenario@1"), Type.Literal("story/p3-scenario@2")]),
	id: text,
	split: Type.Union([Type.Literal("dev"), Type.Literal("acceptance")]),
	category: text,
	mode: Type.Union([Type.Literal("real"), Type.Literal("faux")]),
	storyPrompt: Type.Optional(Type.String()),
	setup: Type.Array(Type.Object({ step: text })),
	trigger: event,
	expect: Type.Object({
		acceptable: Type.Array(Type.Object({})),
		forbidden: Type.Array(Type.Object({})),
		programChecks: Type.Array(text),
		judgeChecks: Type.Array(text),
	}),
	execution: Type.Object({
		internalRoles: Type.Union([Type.Literal("real"), Type.Literal("faux")]),
		maxShowrunnerRequests: Type.Integer({ minimum: 1 }),
		maxChapterAttempts: Type.Integer({ minimum: 1 }),
		stopAfterFirstAction: Type.Optional(Type.Boolean()),
		stopAt: Type.Optional(Type.Literal("decisive_action")),
		maxReadOnlyCalls: Type.Optional(Type.Literal(3)),
		onBoundExceeded: Type.Literal("record_failure_and_stop"),
		dialogResponses: Type.Optional(
			Type.Array(
				Type.Object({
					on: Type.Literal("ask_author"),
					reply: Type.String({ minLength: 1, pattern: "\\S" }),
					delayUntilAssertion: Type.Literal("automatic_continuation_paused"),
				}),
			),
		),
	}),
});
const indexSchema = Type.Object({
	schema: Type.Literal("story/p3-scenario-index@1"),
	dataset: text,
	split: text,
	cases: Type.Array(
		Type.Object({
			id: text,
			path: text,
			category: text,
			mode: text,
			sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		}),
	),
});

// Dev callers cannot even select acceptance without an independently recorded
// product freeze. Never import the dataset's generator: it contains gold cases.
export function loadScenarios(
	version: string,
	split: "dev" | "acceptance",
	freeze?: { schema: "story/p3-v4@1" | "story/p3-v5@1"; commit: string },
) {
	if (
		split === "acceptance" &&
		(!freeze || !["story/p3-v4@1", "story/p3-v5@1"].includes(freeze.schema) || !/^[a-f0-9]{40}$/u.test(freeze.commit))
	)
		throw new Error("V4 product freeze required before opening acceptance");
	const root = path.resolve(version, split);
	const index: unknown = JSON.parse(readFileSync(path.join(root, "index.json"), "utf8"));
	if (!Check(indexSchema, index) || index.split !== split) throw new Error("Invalid scenario index");
	const seen = new Set<string>();
	return index.cases.map((row) => {
		if (seen.has(row.id) || path.basename(row.path) !== row.path || !row.path.endsWith(".json"))
			throw new Error("Unsafe or duplicate scenario path");
		seen.add(row.id);
		const bytes = readFileSync(path.join(root, row.path));
		if (sha256(bytes) !== row.sha256) throw new Error("Frozen scenario hash mismatch");
		const scenario: unknown = JSON.parse(bytes.toString("utf8"));
		if (!Check(scenarioSchema, scenario) || scenario.id !== row.id || scenario.split !== split)
			throw new Error("Invalid scenario contract");
		if (scenario.schema === "story/p3-scenario@2") {
			if (
				scenario.execution.stopAt !== "decisive_action" ||
				scenario.execution.maxReadOnlyCalls !== 3 ||
				scenario.execution.stopAfterFirstAction !== undefined
			)
				throw new Error("Invalid @2 decisive-action contract");
			if (split === "acceptance" && freeze?.schema !== "story/p3-v5@1")
				throw new Error("V5 product freeze required for @2 acceptance");
		} else if (typeof scenario.execution.stopAfterFirstAction !== "boolean")
			throw new Error("Invalid @1 first-action contract");
		// E01 deliberately tests slash commands before a first story prompt.
		// Empty is meaningful there; keep ordinary writing prompts nonblank.
		if (
			(scenario.category === "E01" && ((scenario.storyPrompt ?? "") !== "" || scenario.setup.length !== 0)) ||
			(scenario.category !== "E01" && scenario.storyPrompt !== undefined && !scenario.storyPrompt.trim())
		)
			throw new Error("Invalid scenario contract");
		return scenario as Scenario;
	});
}
