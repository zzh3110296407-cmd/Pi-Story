// Reproduce: node p0/scripts/verify-bridge.ts V21 (then V23, V22, V28 in that order).
// V22 intentionally takes at least ten real minutes and prints a heartbeat every thirty seconds.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { createProbeBridge, type ProbeBridgeOptions } from "../bridge-smoke/server.ts";
import { asArray, asRecord, checkSecret, type JsonRecord, ProbeRpcClient, PROJECT_ROOT, safeWrite, TEST_ROOT } from "../rpc/client.ts";

type Bridge = Awaited<ReturnType<typeof createProbeBridge>>;
const bridgeRuntime = path.join(TEST_ROOT, "bridge-smoke");

function tool(name: string, args: JsonRecord, id: string): JsonRecord {
	return { type: "toolCall", id, name, arguments: args };
}

function safeEnvironment(): NodeJS.ProcessEnv {
	return { ...process.env, TEMP: path.join(TEST_ROOT, "temp"), TMP: path.join(TEST_ROOT, "temp"), TMPDIR: path.join(TEST_ROOT, "temp"), NPM_CONFIG_CACHE: path.join(TEST_ROOT, "cache/npm"), PLAYWRIGHT_BROWSERS_PATH: path.join(TEST_ROOT, "browsers"), XDG_CACHE_HOME: path.join(TEST_ROOT, "cache") };
}

function prepareBrowser(directory: string): void {
	mkdirSync(bridgeRuntime, { recursive: true });
	mkdirSync(path.join(TEST_ROOT, "temp"), { recursive: true });
	for (const file of ["package.json", "browser-check.mjs"]) safeWrite(path.join(bridgeRuntime, file), readFileSync(path.join(PROJECT_ROOT, "p0/bridge-smoke", file), "utf8"));
	const installedPackage = path.join(bridgeRuntime, "node_modules/playwright/package.json");
	if (existsSync(installedPackage) && asRecord(JSON.parse(readFileSync(installedPackage, "utf8"))).version === "1.61.1") return;
	const npmCli = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
	assert(existsSync(npmCli), "Node installation includes npm CLI");
	const result = spawnSync(process.execPath, [npmCli, "install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: bridgeRuntime, env: safeEnvironment(), windowsHide: true, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	safeWrite(path.join(directory, "browser-dependencies.log"), `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
	assert.equal(result.status, 0, "Install isolated Playwright dependency; see browser-dependencies.log");
}

async function runBrowser(bridge: Bridge, directory: string, item: string): Promise<JsonRecord> {
	mkdirSync(directory, { recursive: true });
	const child = spawn(process.execPath, [path.join(bridgeRuntime, "browser-check.mjs"), directory, item], { cwd: directory, env: { ...safeEnvironment(), P0_BRIDGE_ORIGIN: bridge.origin, P0_BRIDGE_COOKIE: bridge.cookie }, windowsHide: true });
	let output = "";
	child.stdout.on("data", (data: Buffer) => { const text = data.toString("utf8"); checkSecret(text); output += text; });
	child.stderr.on("data", (data: Buffer) => { const text = data.toString("utf8"); checkSecret(text); output += text; });
	const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
	safeWrite(path.join(directory, "browser.log"), output);
	assert.equal(exitCode, 0, `Browser verification failed: ${path.join(directory, "browser.log")}`);
	return asRecord(JSON.parse(readFileSync(path.join(directory, "bridge-browser-result.json"), "utf8")));
}

class EventClient {
	readonly records: JsonRecord[] = [];
	readonly socket: WebSocket;
	constructor(bridge: Bridge) {
		this.socket = new WebSocket(`${bridge.origin.replace("http:", "ws:")}/events`, { headers: { Cookie: bridge.cookie, Origin: bridge.origin } });
		this.socket.on("message", (data) => { const text = data.toString(); checkSecret(text); this.records.push(asRecord(JSON.parse(text))); });
	}
	async ready(): Promise<void> {
		if (this.socket.readyState === WebSocket.OPEN) return;
		assert(this.socket.readyState === WebSocket.CONNECTING, "WebSocket closed before ready");
		await new Promise<void>((resolve, reject) => { this.socket.once("open", resolve); this.socket.once("error", reject); });
	}
	async wait(predicate: (record: JsonRecord) => boolean, afterIndex = 0, timeoutMs = 30000): Promise<JsonRecord> {
		const started = performance.now();
		while (performance.now() - started < timeoutMs) {
			const result = this.records.slice(afterIndex).find(predicate);
			if (result) return result;
			await delay(20);
		}
		throw new Error("Timed out waiting for a real WebSocket event");
	}
	close(): void { this.socket.terminate(); }
}

async function login(bridge: Bridge): Promise<void> {
	const response = await fetch(bridge.authUrl, { redirect: "manual" });
	assert.equal(response.status, 303, "Startup token is exchanged for a cookie");
	assert(response.headers.get("set-cookie")?.startsWith(bridge.cookie));
	assert.equal((await fetch(bridge.authUrl, { redirect: "manual" })).status, 403, "Startup token is single use");
}

async function api(bridge: Bridge, pathname: string, data?: JsonRecord): Promise<JsonRecord> {
	const response = await fetch(`${bridge.origin}${pathname}`, { method: data ? "POST" : "GET", headers: { Cookie: bridge.cookie, Origin: bridge.origin, ...(data ? { "Content-Type": "application/json" } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
	const body = asRecord(await response.json());
	assert(response.ok, `Bridge ${pathname}: ${JSON.stringify(body)}`);
	return body;
}

async function createStory(bridge: Bridge, name: string): Promise<JsonRecord> {
	return api(bridge, "/api/stories", { name });
}

async function invalidHostStatus(bridge: Bridge): Promise<number | undefined> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(`${bridge.origin}/api/stories`, { headers: { Host: "evil.invalid", Cookie: bridge.cookie } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
		request.on("error", reject);
		request.end();
	});
}

async function invalidOriginSocketStatus(bridge: Bridge): Promise<number> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`${bridge.origin.replace("http:", "ws:")}/events`, { headers: { Cookie: bridge.cookie, Origin: "http://evil.invalid" } });
		socket.once("unexpected-response", (_request, response) => { response.resume(); response.once("end", () => { socket.terminate(); resolve(response.statusCode ?? 0); }); });
		socket.once("open", () => { socket.terminate(); reject(new Error("Untrusted Origin opened a WebSocket")); });
		socket.on("error", () => {});
	});
}

function rss(pid: number | undefined): number | null {
	if (!pid) return null;
	const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`], { windowsHide: true, encoding: "utf8", timeout: 10000 });
	return result.status === 0 && Number.isFinite(Number(result.stdout.trim())) ? Number(result.stdout.trim()) : null;
}

function isPi(record: JsonRecord, type: string, storyId?: string): boolean {
	return record.kind === "pi" && (!storyId || record.storyId === storyId) && asRecord(record.event).type === type;
}

async function withBridge<T>(directory: string, script: JsonRecord, use: (bridge: Bridge, events: EventClient) => Promise<T>, options: Pick<ProbeBridgeOptions, "promptTimeoutMs"> = {}): Promise<T> {
	const bridge = await createProbeBridge({ runDir: directory, script, ...options });
	const events = new EventClient(bridge);
	try {
		await login(bridge);
		await events.ready();
		return await use(bridge, events);
	} finally {
		events.close();
		await bridge.close();
	}
}

async function readonlyCommitCounterexample(directory: string): Promise<JsonRecord> {
	const script = { turns: [{ content: [tool("probe_write", { n: 28 }, "readonly-seed")] }, { text: "Seed saved" }, { content: [tool("probe_commit", { chapter: 1 }, "readonly-commit")] }, { text: "In-memory success is insufficient" }] };
	const bridge = await createProbeBridge({ runDir: directory, script, rpcEnv: { PROBE_COMMIT_DELAY_MS: "1500" }, commitConfirmTimeoutMs: 2000 });
	const events = new EventClient(bridge);
	let readonlyFile: string | undefined;
	try {
		await login(bridge);
		await events.ready();
		const story = await createStory(bridge, "V28 readonly counterexample");
		const id = String(story.id);
		await api(bridge, `/api/stories/${id}/prompt`, { message: "Persist seed first" });
		await events.wait((record) => isPi(record, "agent_settled", id));
		const state = await api(bridge, `/api/stories/${id}/state`);
		readonlyFile = path.resolve(String(state.sessionFile));
		assert(readonlyFile.startsWith(`${path.resolve(directory)}${path.sep}`), "Only mutate this counterexample's own session file");
		assert(existsSync(readonlyFile));
		const client = bridge.active.get(id)!.client;
		const index = events.records.length;
		await api(bridge, `/api/stories/${id}/prompt`, { message: "Commit into a read-only file" });
		await events.wait((record) => isPi(record, "tool_execution_start", id) && asRecord(record.event).toolCallId === "readonly-commit", index);
		const before = readFileSync(readonlyFile);
		const setReadonly = spawnSync("attrib", ["+R", readonlyFile], { windowsHide: true, encoding: "utf8" });
		assert.equal(setReadonly.status, 0, "Set only the owned session read-only");
		await events.wait((record) => isPi(record, "message_end", id) && asRecord(asRecord(record.event).message).toolCallId === "readonly-commit", index);
		const memory = await client.success({ type: "get_entries" });
		const memoryCommitCount = asArray(memory.entries).filter((entry) => { const value = asRecord(entry); return value.type === "message" && asRecord(value.message).role === "toolResult" && asRecord(value.message).toolCallId === "readonly-commit"; }).length;
		assert.equal(memoryCommitCount, 1, "Original Pi exposes the unwritten commit in memory");
		const error = await events.wait((record) => record.storyId === id && record.kind === "run.error", index);
		assert.equal(asRecord(error.event).code, "PERSISTENCE_NOT_CONFIRMED");
		assert(!events.records.some((record) => record.storyId === id && record.kind === "chapter.committed"), "Bridge never reports the unsaved chapter as committed");
		const exitedAt = performance.now();
		while (client.process.exitCode === null && client.process.signalCode === null && performance.now() - exitedAt < 3000) await delay(20);
		assert(client.process.exitCode !== null || client.process.signalCode !== null, "Bridge terminates its own failed Pi process");
		assert(!bridge.active.has(id));
		assert(bridge.failed.has(id));
		assert(readFileSync(readonlyFile).equals(before), "Read-only session file did not change");
		const clearReadonly = spawnSync("attrib", ["-R", readonlyFile], { windowsHide: true, encoding: "utf8" });
		assert.equal(clearReadonly.status, 0);
		await api(bridge, `/api/stories/${id}/open`, {});
		const reopened = await api(bridge, `/api/stories/${id}/entries`);
		const persistedCommitCount = asArray(reopened.entries).filter((entry) => { const value = asRecord(entry); return value.type === "message" && asRecord(value.message).role === "toolResult" && asRecord(value.message).toolCallId === "readonly-commit"; }).length;
		assert.equal(persistedCommitCount, 0, "Explicit reopen rebuilds from file without the unsaved commit");
		return { error, memoryCommitCount, persistedCommitCount, fileUnchanged: true, falseCommittedEvents: 0, failedPiTerminated: true, explicitFileReopen: true, file: readonlyFile, sourceCounterexample: "V07/2026-10-28T08-18-16-680Z" };
	} finally {
		let restoreStatus = 0;
		if (readonlyFile && existsSync(readonlyFile)) {
			const restored = spawnSync("attrib", ["-R", readonlyFile], { windowsHide: true, encoding: "utf8" });
			restoreStatus = restored.status ?? 1;
		}
		events.close();
		await bridge.close();
		assert.equal(restoreStatus, 0, "Restore owned file attributes during cleanup");
	}
}

const checks: Record<string, (directory: string) => Promise<JsonRecord>> = {
	async V21(directory) {
		prepareBrowser(directory);
		const script = { turns: [{ content: [tool("probe_write", { n: 21 }, "bridge-write")] }, { text: "Bridge write complete" }, { content: [tool("probe_slow", { ms: 10000, previewText: "V21 running" }, "bridge-slow")] }, { text: "Bridge stop complete" }] };
		return withBridge(directory, script, async (bridge, events) => {
			assert.equal((await fetch(`${bridge.origin}/api/stories`)).status, 403, "Cookie required");
			assert.equal(await invalidHostStatus(bridge), 403, "Host checked");
			assert.equal((await fetch(`${bridge.origin}/api/stories`, { headers: { Cookie: bridge.cookie, Origin: "http://evil.invalid" } })).status, 403, "HTTP Origin checked");
			assert.equal(await invalidOriginSocketStatus(bridge), 403, "WebSocket Origin checked");
			const first = await createStory(bridge, "Node story A");
			const second = await createStory(bridge, "Node story B");
			const firstId = String(first.id);
			const secondId = String(second.id);
			assert.equal(asArray((await api(bridge, "/api/stories")).stories).length, 2);
			for (const id of [firstId, secondId]) {
				const index = events.records.length;
				await api(bridge, `/api/stories/${id}/prompt`, { message: "Persist one probe value" });
				await events.wait((record) => isPi(record, "agent_settled", id), index);
				const view = await api(bridge, `/api/stories/${id}/entries`);
				assert(asArray(view.entries).some((entry) => { const item = asRecord(entry); return item.type === "message" && asRecord(item.message).toolName === "probe_write"; }));
			}
			const index = events.records.length;
			await api(bridge, `/api/stories/${firstId}/prompt`, { message: "Run a slow tool" });
			await events.wait((record) => isPi(record, "tool_execution_start", firstId) && asRecord(record.event).toolName === "probe_slow", index);
			await api(bridge, `/api/stories/${firstId}/prompt`, { message: "queued immediate author input", streamingBehavior: "steer" });
			await events.wait((record) => record.storyId === firstId && record.kind === "command.response" && asRecord(record.event).disposition === "queued", index);
			const stop = await api(bridge, `/api/stories/${firstId}/stop`, {});
			assert.equal(stop.stopped, true);
			assert(JSON.stringify(stop.clearedQueue).includes("queued immediate author input"), "Stop returns the queued author text before aborting");
			assert.equal((await api(bridge, `/api/stories/${firstId}/state`)).isStreaming, false);
			const perStory = [firstId, secondId].map((id) => ({ id, startupMs: bridge.active.get(id)?.startupMs, rssBytes: rss(bridge.active.get(id)?.client.process.pid) }));
			const firstFile = String((await api(bridge, `/api/stories/${firstId}/state`)).sessionFile);
			const secondFile = String((await api(bridge, `/api/stories/${secondId}/state`)).sessionFile);
			await bridge.closeStory(firstId);
			await api(bridge, `/api/stories/${firstId}/open`, {});
			assert(asArray((await api(bridge, `/api/stories/${firstId}/entries`)).entries).length > 0, "Existing story opens from persisted file");
			const browser = await runBrowser(bridge, path.join(directory, "browser"), "V21");
			for (const id of [...bridge.active.keys()]) await bridge.closeStory(id);
			const comparisonDir = path.join(directory, "switch-comparison");
			const comparisonScript = path.join(comparisonDir, "script.json");
			safeWrite(comparisonScript, { turns: [{ text: "Comparison reads only" }] });
			const started = performance.now();
			const client = new ProbeRpcClient({ runDir: comparisonDir, scriptFile: comparisonScript });
			let oneProcess: JsonRecord;
			try {
				await client.ready();
				const startupMs = performance.now() - started;
				const switches: JsonRecord[] = [];
				for (const [id, sessionPath] of [[firstId, firstFile], [secondId, secondFile]]) {
					const before = performance.now();
					const outcome = await client.success({ type: "switch_session", sessionPath });
					assert.equal(outcome.cancelled, false);
					assert.equal((await client.success({ type: "get_state" })).sessionId, id);
					switches.push({ storyId: id, switchMs: performance.now() - before, rssBytes: rss(client.process.pid) });
				}
				oneProcess = { startupMs, switches, rssBytes: rss(client.process.pid) };
			} finally { await client.close(); }
			return { status: "成立", httpAndWebSocket: true, newSessionIds: [firstId, secondId], cookieExchange: true, untrustedHostAndOriginRejected: true, steerAndClearQueueAbort: stop, browser, comparison: { perStory, oneProcess }, sampleCount: "two explicit story processes and two switch_session operations; not a performance distribution" };
		});
	},
	async V23(directory) {
		return withBridge(directory, { turns: [{ text: "V23 status test" }] }, async (bridge, events) => {
			const story = await createStory(bridge, "V23 status");
			await api(bridge, `/api/stories/${String(story.id)}/prompt`, { message: "Trigger status" });
			const event = await events.wait((record) => record.kind === "run.state" && asRecord(record.event).statusKey === "story");
			assert.equal(asRecord(event.event).method, "setStatus");
			assert.equal(asRecord(event.event).statusText, "working");
			return { status: "成立", rawStatusForwarded: event };
		});
	},
	async V22(directory) {
		const rpcPromptTimeoutMs = 15 * 60 * 1000;
		return withBridge(directory, { turns: [{ text: "V22 command test" }] }, async (bridge, events) => {
			const story = await createStory(bridge, "V22 ten minute dialog");
			const id = String(story.id);
			// Pi defers new-file creation until a normal user/assistant message exists.
			// An extension command handled before conversation does not satisfy that contract.
			const seedIndex = events.records.length;
			await api(bridge, `/api/stories/${id}/prompt`, { message: "Create a persisted conversation before the long author dialog" });
			await events.wait((record) => isPi(record, "agent_settled", id), seedIndex);
			await events.wait((record) => record.storyId === id && record.kind === "command.response", seedIndex);
			const seedState = await api(bridge, `/api/stories/${id}/state`);
			assert(existsSync(String(seedState.sessionFile)), "Seed conversation must exist on disk before starting the ten-minute wait");
			const index = events.records.length;
			const postStarted = performance.now();
			const acknowledgement = await api(bridge, `/api/stories/${id}/prompt`, { message: "/probe-intent" });
			assert.equal(acknowledgement.accepted, true, "HTTP already returned accepted before the long UI wait");
			const httpAcceptanceMs = performance.now() - postStarted;
			const request = asRecord((await events.wait((record) => record.storyId === id && record.kind === "ui.request" && asRecord(record.event).method === "editor")).event);
			const dialogOpenedAt = new Date().toISOString();
			const started = performance.now();
			while (performance.now() - started < 600000) {
				await delay(Math.min(30000, 600000 - (performance.now() - started)));
				const elapsedMs = performance.now() - started;
				assert(bridge.active.get(id)?.pendingDialogs.has(String(request.id)), "Dialog remains pending");
				assert(!events.records.slice(index).some((record) => record.storyId === id && ["command.response", "command.error"].includes(String(record.kind))), "Neither Pi nor the RPC client completed or timed out the editor before the author answered");
				const heartbeat = { verification: "V22", state: "waiting for real timeout check", elapsedMs, requiredMs: 600000 };
				safeWrite(path.join(directory, "progress.json"), heartbeat);
				console.log(JSON.stringify(heartbeat));
			}
			const elapsedMs = performance.now() - started;
			assert(elapsedMs >= 600000);
			const answeredAt = new Date().toISOString();
			await api(bridge, `/api/stories/${id}/dialog`, { requestId: String(request.id), value: "ten real minutes later" });
			await events.wait((record) => record.storyId === id && record.kind === "command.response" && asRecord(record.event).disposition === "handled", index);
			const entries = asArray((await api(bridge, `/api/stories/${id}/entries`)).entries);
			const authorControlEntry = entries.map(asRecord).find((value) => value.type === "custom" && value.customType === "probe.control" && asRecord(value.data).text === "ten real minutes later");
			assert(authorControlEntry, "Author control entry appears after the delayed answer");
			const state = await api(bridge, `/api/stories/${id}/state`);
			const sessionFile = String(state.sessionFile);
			assert(path.resolve(sessionFile).startsWith(`${path.resolve(directory)}${path.sep}`));
			const persistedEntry = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((line) => asRecord(JSON.parse(line))).find((entry) => entry.id === authorControlEntry.id);
			assert.deepEqual(persistedEntry, authorControlEntry, "Delayed control change is actually present in the session file");
			return {
				status: "成立", elapsedMs, requiredMs: 600000, dialogOpenedAt, answeredAt,
				seedConversationPersistedBeforeWait: true,
				requestId: request.id, answerPersisted: true, authorControlEntry: persistedEntry, sessionFile,
				transport: { rpcPromptTimeoutMs, httpAcceptanceMs, httpWaitsForDialog: false, responseDelivery: "WebSocket command.response after a separate HTTP dialog answer" },
				sampleCount: 1, clock: "real monotonic elapsed wait; no fake timer",
			};
		}, { promptTimeoutMs: rpcPromptTimeoutMs });
	},
	async V28(directory) {
		prepareBrowser(directory);
		const script = { turns: [{ content: [tool("probe_slow", { ms: 3000, previewText: "这是尚未提交的中文草稿预览。" }, "preview-slow")] }, { content: [tool("probe_commit", { chapter: 1 }, "file-confirmed-commit")] }, { text: "V28 committed" }] };
		const success = await withBridge(directory, script, async (bridge, events) => {
			const story = await createStory(bridge, "V28 commit");
			const id = String(story.id);
			await api(bridge, `/api/stories/${id}/prompt`, { message: "Preview then commit" });
			const preview = await events.wait((record) => record.storyId === id && record.kind === "draft.preview");
			assert.equal(asRecord(preview.event).state, "uncommitted");
			const committed = await events.wait((record) => record.storyId === id && record.kind === "chapter.committed");
			assert.equal(asRecord(committed.event).fileConfirmed, true);
			const state = await api(bridge, `/api/stories/${id}/state`);
			const lines = readFileSync(String(state.sessionFile), "utf8").split("\n").filter(Boolean).map((line) => asRecord(JSON.parse(line)));
			assert(lines.some((entry) => entry.id === asRecord(committed.event).entryId && asRecord(entry.message).toolCallId === asRecord(committed.event).toolCallId));
			const browserDir = path.join(directory, "browser");
			mkdirSync(browserDir, { recursive: true });
			const browser = await runBrowser(bridge, browserDir, "V28");
			const confirmations = bridge.envelopes.filter((record) => record.kind === "chapter.committed");
			return { status: "成立", preview, confirmedCommit: committed, confirmations: confirmations.map((record) => record.event), browser, confirmationMechanism: "Find matching toolCallId in the session file before chapter.committed, not get_entries memory" };
		});
		const readonlyFailure = await readonlyCommitCounterexample(path.join(directory, "readonly-counterexample"));
		return { ...success, readonlyFailure };
	},
};

for (const item of (process.argv[2] ?? "V21").split(",")) {
	const check = checks[item];
	assert(check, `Unsupported bridge verification ${item}`);
	const directory = path.join(TEST_ROOT, "runs", item, new Date().toISOString().replace(/[:.]/g, "-"));
	mkdirSync(directory, { recursive: true });
	const started = new Date().toISOString();
	try {
		const result = await check(directory);
		const summary = { verification: item, ...result, directory, started, finished: new Date().toISOString() };
		safeWrite(path.join(directory, "result.json"), summary);
		console.log(JSON.stringify(summary));
	} catch (error) {
		const summary = { verification: item, status: "阻塞", error: error instanceof Error ? error.message : String(error), directory, started, finished: new Date().toISOString() };
		safeWrite(path.join(directory, "result.json"), summary);
		console.log(JSON.stringify(summary));
		process.exitCode = 1;
		break;
	}
}
