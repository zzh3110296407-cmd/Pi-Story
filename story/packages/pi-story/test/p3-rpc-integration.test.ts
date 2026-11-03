import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { foldBranch } from "@pi-story/core";
import { expect, test } from "vitest";
import { readEvidence } from "../../../scripts/eval/p2/artifacts.ts";
import { driveBook } from "../../../scripts/eval/p3/book.ts";
import { P3RpcClient } from "../../../scripts/eval/p3/rpc.ts";
import type { WorkerConfig } from "../../../scripts/eval/p3/rpc-worker.ts";
import { settingsTemplate } from "../../../scripts/prepare-p2.mjs";
import { translateBranch } from "../src/entries.ts";
import { p3Chapter, p3Opening } from "./p3-fixture.ts";

function createRpcFixture(book = false, wire: Record<string, unknown>[] = []) {
	const work = process.env.PI_STORY_WORK_DIR;
	if (!work) throw new Error("Project execution workspace required");
	mkdirSync(path.join(work, "temp"), { recursive: true });
	const root = mkdtempSync(path.join(work, "temp/p3-rpc-"));
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir);
	const settings = settingsTemplate(root);
	for (const role of Object.values(settings.roles)) role.model = "faux/script";
	writeFileSync(path.join(agentDir, "story-forge.json"), JSON.stringify(settings));
	return new P3RpcClient({
		cli: path.join(work, "pi/packages/coding-agent/dist/cli.js"),
		cwd: root,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			PI_STORY_P3_RPC_BOOK: book ? "1" : "0",
		},
		args: [
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-builtin-tools",
			"--no-mcp",
			"--extension",
			path.resolve(import.meta.dirname, "fixtures/p3-rpc-extension.ts"),
			"--model",
			"faux/script",
			"--thinking",
			"off",
			"--session-dir",
			path.join(root, "sessions"),
		],
		dialog: async () => ({ value: "Mountains" }),
		onWire: (direction, frame) => {
			if (direction === "in") wire.push(frame);
		},
		settleTimeoutMs: 20_000,
	});
}
test("P3 real pinned Pi RPC drives author commands, three automatic chapters and a forwarded dialog without a model API", async () => {
	const client = createRpcFixture();
	try {
		await client.request({ type: "get_state" });
		await client.promptAndWait("Ada must survive.");
		await client.promptAndWait("/intent Ada protects the harbor");
		await client.promptAndWait("/goal 3");
		await client.promptAndWait("Write toward the goal.");
		await client.promptAndWait("Clarify my next choice.");
		const result = await client.request({ type: "get_entries" });
		const data = result.data as { entries: SessionEntry[] };
		const model = foldBranch(translateBranch(data.entries));
		expect(model.lastChapter).toBe(3);
		expect(model.authorIntent).toBe("Ada protects the harbor");
		expect(model.authorMessages.some((m) => m.text === "Mountains")).toBe(true);
	} finally {
		await client.close();
	}
}, 60_000);

test("P3 book driver sets the outline goal once and sends no further author prompts", async () => {
	const wire: Record<string, unknown>[] = [];
	const client = createRpcFixture(true, wire);
	try {
		await client.request({ type: "get_state" });
		let preflight = 0;
		const book = await driveBook(client, "Ada must survive.", () => {
			preflight++;
		});
		expect(book).toMatchObject({ target: 3, lastChapter: 3, completed: true, askedAuthor: false });
		expect(preflight).toBe(1);
		expect(wire.filter((frame) => frame.type === "prompt").map((frame) => frame.message)).toEqual([
			"Ada must survive.",
			"/goal 3",
		]);
	} finally {
		await client.close();
	}
}, 60_000);

test.each([true, false])(
	"the measured RPC worker preserves complete and unopened book outcomes (complete=%s)",
	async (complete) => {
		const work = process.env.PI_STORY_WORK_DIR;
		if (!work) throw new Error("Project workspace required");
		const root = mkdtempSync(path.join(work, "temp/p3-worker-"));
		const config: WorkerConfig = {
			schema: "story/p3-rpc-worker@1",
			work: path.join(root, "work"),
			archive: path.join(root, "archive"),
			runId: "offline-worker",
			caseId: "local-book",
			main: "faux",
			ledgerFile: path.join(root, "fees.jsonl"),
			reservationsFile: path.join(root, "reserves.jsonl"),
			localReplies: complete
				? [
						fauxAssistantMessage([...p3Opening(), fauxToolCall("write_next_chapter", {})], { stopReason: "toolUse" }),
						...p3Chapter().slice(1),
						...p3Chapter(),
						...p3Chapter(),
					]
				: [fauxAssistantMessage("Opening not completed; no chapter was committed.")],
		};
		const configFile = path.join(root, "config.json");
		writeFileSync(configFile, JSON.stringify(config));
		const client = new P3RpcClient({
			cli: path.resolve(import.meta.dirname, "../../../scripts/eval/p3/rpc-worker.ts"),
			cwd: root,
			env: { ...process.env, PI_STORY_P3_WORKER_CONFIG: configFile },
			settleTimeoutMs: 30_000,
		});
		try {
			await client.request({ type: "get_state" });
			const book = await driveBook(client, "Ada must survive.", () => {});
			expect(book.completed).toBe(complete);
			expect(book.target).toBe(complete ? 3 : null);
			expect(book.lastChapter).toBe(complete ? 3 : 0);
			await client.promptAndWait("/__p3_finish");
			expect(readEvidence(config.archive).some((row) => row.type === "model_call")).toBe(true);
		} finally {
			await client.close();
		}
	},
	60_000,
);
