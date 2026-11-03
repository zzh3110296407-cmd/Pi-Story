import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { installStory } from "../src/index.ts";
import type { ObserveCall } from "../src/ports.ts";
import type { StoryRuntime } from "../src/session.ts";

export const draftText =
	"Ada reached the harbor before dawn, carrying the brass key in her coat. Rain ran down the closed gate and pooled beneath her boots. She could still hear the last ferry moving through the dark water beyond the wall. Instead of calling after it, she bent to inspect the lock. Someone had recently scraped salt from its narrow mouth. Ada wiped the key on her sleeve and held it steady, listening. Two quiet knocks came from the other side. She stepped back from the gate, alive and alert, with the key still warm in her hand.";
export const keeperReply = {
	facts: [],
	claims: [],
	cognitions: [],
	relations: [],
	hooks: [],
	summary: {
		title: "The harbor",
		characters: ["char:ada"],
		events: ["Ada reaches the harbor and hears a knock."],
		mood: "tense",
	},
	issues: [],
};

export const openingCalls = () => [
	fauxToolCall("submit_constraints", {
		op: "submit",
		items: [{ kind: "story", text: "Keep Ada alive.", quotes: ["Ada must survive."] }],
	}),
	fauxToolCall("submit_bible", {
		items: [
			{
				kind: "character",
				key: "char:ada",
				name: "Ada",
				source: "user",
				authorQuote: "Ada must survive.",
				description: "Ada",
			},
		],
	}),
	fauxToolCall("submit_outline", {
		viewpoint: "third person",
		tone: "tense",
		chapters: [{ n: 1, title: "The harbor", targetWords: 100, points: ["Reach the harbor", "Ada finds a key"] }],
	}),
];

export async function createTestSession(
	options: {
		observe?: ObserveCall;
		builtinTools?: boolean;
		defaultBudget?: { tokens: number | null; costUsd: number | null };
		writerLengthFactor?: 0.8 | 0.9;
		compactionSettings?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
		configureRuntime?: (runtime: ModelRuntime, root: string) => void;
	} = {},
) {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("PI_STORY_WORK_DIR must select the P2 execution workspace");
	mkdirSync(path.join(work, "sessions"), { recursive: true });
	const root = mkdtempSync(path.join(work, "sessions/sdk-"));
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const faux = fauxProvider({ models: [{ id: "script", contextWindow: 1_000_000, maxTokens: 32768 }] });
	const runtime = await ModelRuntime.create({
		authPath: path.join(agentDir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerNativeProvider(faux.provider);
	options.configureRuntime?.(runtime, root);
	const roles = Object.fromEntries(
		["writer", "editor", "keeper", "verifier"].map((role) => [
			role,
			{
				model: "faux/script",
				thinking: "low",
				maxTokens: 8192,
				temperature: 0,
			},
		]),
	);
	writeFileSync(
		path.join(agentDir, "story-forge.json"),
		JSON.stringify({
			schema: "story/global-settings@1",
			storiesDir: path.join(root, "stories"),
			localRevision: true,
			defaultLevel: "L1",
			roles,
			defaultBudget: options.defaultBudget ?? { tokens: null, costUsd: null },
			...(options.writerLengthFactor !== undefined ? { writerLengthFactor: options.writerLengthFactor } : {}),
		}),
	);
	const settingsManager = SettingsManager.inMemory({
		compaction: options.compactionSettings ?? { enabled: false },
		retry: { enabled: false },
	});
	let story: StoryRuntime | undefined;
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		...(options.observe
			? {
					extensionFactories: [
						(pi) => {
							story = installStory(pi, options);
						},
					],
				}
			: { additionalExtensionPaths: [path.resolve(import.meta.dirname, "../src/index.ts")] }),
	});
	await loader.reload();
	const manager = SessionManager.create(root, path.join(root, "sessions"));
	const { session, extensionsResult } = await createAgentSession({
		cwd: root,
		agentDir,
		resourceLoader: loader,
		modelRuntime: runtime,
		settingsManager,
		sessionManager: manager,
		noTools: options.builtinTools ? undefined : "builtin",
		model: faux.getModel(),
		thinkingLevel: "off",
	});
	const errors: string[] = [];
	await session.bindExtensions({
		mode: "print",
		onError: (event) => {
			errors.push(event.error);
		},
	});
	return {
		root,
		agentDir,
		runtime,
		faux,
		session,
		manager,
		errors,
		extensionsResult,
		story,
		cleanup() {
			session.dispose();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		},
	};
}
