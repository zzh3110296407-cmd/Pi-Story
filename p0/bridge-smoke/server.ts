// Reproduce through node p0/scripts/verify-bridge.ts V21.
import assert from "node:assert/strict";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { asRecord, checkSecret, type JsonRecord, ProbeRpcClient, PROJECT_ROOT, safeWrite, TEST_ROOT } from "../rpc/client.ts";

export interface ProbeBridgeOptions {
	runDir: string;
	script: JsonRecord;
	rpcEnv?: NodeJS.ProcessEnv;
	commitConfirmTimeoutMs?: number;
	promptTimeoutMs?: number;
}

interface StoryProcess {
	id: string;
	name: string;
	directory: string;
	client: ProbeRpcClient;
	sessionFile?: string;
	startupMs: number;
	pump: ReturnType<typeof setInterval>;
	pendingDialogs: Map<string, JsonRecord>;
}

export interface BridgeEnvelope extends JsonRecord {
	kind: string;
	storyId: string;
	event: JsonRecord;
	observedAt: number;
}

function constantEqual(left: string, right: string): boolean {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

function toolMessage(record: JsonRecord): JsonRecord | undefined {
	if (record.type !== "message_end") return undefined;
	const message = asRecord(record.message);
	return message.role === "toolResult" ? message : undefined;
}

export async function createProbeBridge(options: ProbeBridgeOptions) {
	const runDir = path.resolve(options.runDir);
	assert(runDir.startsWith(`${path.resolve(TEST_ROOT)}${path.sep}`), "Bridge data must stay in test root");
	const storiesDir = path.join(runDir, "stories");
	mkdirSync(storiesDir, { recursive: true });
	const active = new Map<string, StoryProcess>();
	const failed = new Map<string, JsonRecord>();
	const sockets = new Set<WebSocket>();
	const envelopes: BridgeEnvelope[] = [];
	let startupToken: string | null = randomBytes(24).toString("hex");
	const sessionToken = randomBytes(24).toString("hex");
	const cookie = `p0_bridge=${sessionToken}`;
	let origin = "";
	let allowedHost = "";
	const pendingConfirmations = new Map<string, { story: StoryProcess; toolCallId: string; receivedAt: number; chapter: unknown }>();
	const background = new Set<Promise<unknown>>();
	let closed = false;
	const commitConfirmTimeoutMs = options.commitConfirmTimeoutMs ?? 2000;
	assert(commitConfirmTimeoutMs > 0, "Commit confirmation timeout must be positive");
	const promptTimeoutMs = options.promptTimeoutMs ?? 30000;
	assert(promptTimeoutMs > 0, "Prompt response timeout must be positive");

	function publish(storyId: string, kind: string, event: JsonRecord): void {
		const envelope = { kind, storyId, event, observedAt: performance.now() };
		const text = JSON.stringify(envelope);
		checkSecret(text);
		envelopes.push(envelope);
		for (const socket of sockets) if (socket.readyState === 1) socket.send(text);
		safeWrite(path.join(runDir, "bridge-events.json"), envelopes);
	}

	function failStory(story: StoryProcess, toolCallId: string, reason: string): void {
		const error = { code: "PERSISTENCE_NOT_CONFIRMED", toolCallId, reason, reopenRequired: true };
		failed.set(story.id, error);
		clearInterval(story.pump);
		for (const [key, pending] of pendingConfirmations) if (pending.story === story) pendingConfirmations.delete(key);
		publish(story.id, "run.error", error);
		story.client.forceKill();
		active.delete(story.id);
	}

	function flush(story: StoryProcess, index: number): number {
		while (index < story.client.records.length) {
			const record = story.client.records[index];
			const receivedAt = story.client.receivedAt[index++];
			publish(story.id, "pi", record);
			if (record.type === "extension_ui_request") {
				if (["editor", "input", "select", "confirm"].includes(String(record.method))) {
					story.pendingDialogs.set(String(record.id), record);
					publish(story.id, "ui.request", record);
				}
				if (record.method === "setStatus") publish(story.id, "run.state", record);
			}
			if (record.type === "tool_execution_update") {
				const result = asRecord(record.partialResult ?? record.result ?? {});
				const details = asRecord(result.details ?? {});
				if (typeof details.previewText === "string" && details.previewText) {
					publish(story.id, "draft.preview", { text: details.previewText, state: "uncommitted", toolCallId: record.toolCallId });
				}
			}
			const message = toolMessage(record);
			if (message?.toolName === "probe_commit" && message.isError !== true) {
				const details = asRecord(message.details);
				pendingConfirmations.set(`${story.id}:${String(message.toolCallId)}`, { story, toolCallId: String(message.toolCallId), receivedAt, chapter: details.chapter });
				publish(story.id, "chapter.pending", { toolCallId: message.toolCallId, chapter: details.chapter });
			}
		}
		for (const [key, pending] of pendingConfirmations) {
			if (pending.story !== story) continue;
			let match: JsonRecord | undefined;
			if (story.sessionFile && existsSync(story.sessionFile)) {
				let text: string;
				try { text = readFileSync(story.sessionFile, "utf8"); } catch (error) {
					failStory(story, pending.toolCallId, error instanceof Error ? error.message : String(error));
					break;
				}
				for (const line of text.split("\n").filter(Boolean)) {
					let entry: JsonRecord;
					try { entry = asRecord(JSON.parse(line)); } catch { continue; }
					if (entry.type !== "message") continue;
					const message = asRecord(entry.message);
					if (message.role === "toolResult" && message.toolCallId === pending.toolCallId) { match = entry; break; }
				}
			}
			if (!match) {
				if (performance.now() - pending.receivedAt >= commitConfirmTimeoutMs) {
					failStory(story, pending.toolCallId, `No complete tool result in session file within ${commitConfirmTimeoutMs} ms`);
					break;
				}
				continue;
			}
			pendingConfirmations.delete(key);
			publish(story.id, "chapter.committed", { chapter: pending.chapter, toolCallId: pending.toolCallId, entryId: match.id, fileConfirmed: true, confirmationLatencyMs: performance.now() - pending.receivedAt });
		}
		return index;
	}

	async function openStory(id: string, explicitReopen = false): Promise<StoryProcess> {
		if (active.has(id)) return active.get(id)!;
		assert(explicitReopen || !failed.has(id), "Story failed; explicitly reopen from its session file");
		assert(/^[a-f0-9-]{36}$/u.test(id), "Invalid story ID");
		const directory = path.join(storiesDir, id);
		assert(existsSync(path.join(directory, "story.json")), "Story does not exist");
		const metadata = asRecord(JSON.parse(readFileSync(path.join(directory, "story.json"), "utf8")));
		const startedAt = performance.now();
		const client = new ProbeRpcClient({ runDir: directory, scriptFile: path.join(directory, "script.json"), extraArgs: ["--session-id", id], env: options.rpcEnv });
		try {
			const state = await client.ready();
			let index = 0;
			const story: StoryProcess = {
				id, name: String(metadata.name), directory, client,
				sessionFile: typeof state.sessionFile === "string" ? state.sessionFile : undefined,
				startupMs: performance.now() - startedAt,
				pendingDialogs: new Map(), pump: setInterval(() => { index = flush(story, index); }, 20),
			};
			active.set(id, story);
			failed.delete(id);
			return story;
		} catch (error) {
			await client.close();
			throw error;
		}
	}

	function listStories(): JsonRecord[] {
		return readdirSync(storiesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
			const metadata = asRecord(JSON.parse(readFileSync(path.join(storiesDir, entry.name, "story.json"), "utf8")));
			return { ...metadata, active: active.has(entry.name), ...(failed.has(entry.name) ? { error: failed.get(entry.name) } : {}) };
		});
	}

	function sendJson(response: ServerResponse, code: number, body: unknown): void {
		const text = JSON.stringify(body);
		checkSecret(text);
		response.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
		response.end(text);
	}

	async function body(request: IncomingMessage): Promise<JsonRecord> {
		let value = "";
		for await (const chunk of request) {
			value += String(chunk);
			assert(Buffer.byteLength(value) < 65536, "Request too large");
		}
		return value ? asRecord(JSON.parse(value)) : {};
	}

	function trusted(request: IncomingMessage, requireCookie: boolean): boolean {
		if (request.headers.host !== allowedHost) return false;
		if (request.headers.origin !== undefined && request.headers.origin !== origin) return false;
		if (request.method !== "GET" && request.headers.origin !== origin) return false;
		if (requireCookie && !(request.headers.cookie ?? "").split(/;\s*/u).includes(cookie)) return false;
		return true;
	}

	const server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? "/", origin);
			if (!trusted(request, url.pathname !== "/auth")) { sendJson(response, 403, { error: "Forbidden" }); return; }
			if (url.pathname === "/auth") {
				if (!startupToken || !constantEqual(url.searchParams.get("token") ?? "", startupToken)) { sendJson(response, 403, { error: "Invalid startup token" }); return; }
				startupToken = null;
				response.writeHead(303, { Location: "/", "Set-Cookie": `${cookie}; HttpOnly; SameSite=Strict; Path=/`, "Cache-Control": "no-store" }).end();
				return;
			}
			if (url.pathname === "/" && request.method === "GET") {
				response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(readFileSync(path.join(PROJECT_ROOT, "p0/bridge-smoke/index.html")));
				return;
			}
			if (url.pathname === "/api/stories" && request.method === "GET") { sendJson(response, 200, { stories: listStories() }); return; }
			if (url.pathname === "/api/stories" && request.method === "POST") {
				const input = await body(request);
				const id = randomUUID();
				const directory = path.join(storiesDir, id);
				safeWrite(path.join(directory, "story.json"), { id, name: typeof input.name === "string" ? input.name : "P0 story" });
				safeWrite(path.join(directory, "script.json"), options.script);
				const story = await openStory(id);
				sendJson(response, 201, { id, startupMs: story.startupMs, sessionFile: story.sessionFile });
				return;
			}
			const match = /^\/api\/stories\/([a-f0-9-]{36})\/(open|prompt|stop|dialog|entries|state)$/u.exec(url.pathname);
			if (!match) { sendJson(response, 404, { error: "Not found" }); return; }
			const action = match[2];
			if (failed.has(match[1]) && action !== "open") { sendJson(response, 409, { error: "Story failed; explicitly reopen from its session file", details: failed.get(match[1]) }); return; }
			const story = await openStory(match[1], action === "open");
			if (action === "open" && request.method === "POST") { sendJson(response, 200, { id: story.id, startupMs: story.startupMs }); return; }
			if (action === "entries" && request.method === "GET") { sendJson(response, 200, await story.client.success({ type: "get_entries" })); return; }
			if (action === "state" && request.method === "GET") { sendJson(response, 200, await story.client.success({ type: "get_state" })); return; }
			if (action === "prompt" && request.method === "POST") {
				const input = await body(request);
				assert(typeof input.message === "string", "message is required");
				const command = story.client.success({ type: "prompt", message: input.message, ...(input.streamingBehavior ? { streamingBehavior: input.streamingBehavior } : {}) }, promptTimeoutMs)
					.then((data) => publish(story.id, "command.response", data))
					.catch((error: unknown) => publish(story.id, "command.error", { message: error instanceof Error ? error.message : String(error) }));
				background.add(command);
				void command.finally(() => background.delete(command));
				sendJson(response, 202, { accepted: true });
				return;
			}
			if (action === "stop" && request.method === "POST") {
				const queue = await story.client.success({ type: "clear_queue" });
				await story.client.success({ type: "abort" });
				sendJson(response, 200, { stopped: true, clearedQueue: queue });
				return;
			}
			if (action === "dialog" && request.method === "POST") {
				const input = await body(request);
				assert(typeof input.requestId === "string" && story.pendingDialogs.has(input.requestId), "Unknown dialog request");
				await story.client.send({ type: "extension_ui_response", id: input.requestId, value: input.value, ...(input.cancelled === true ? { cancelled: true } : {}) });
				story.pendingDialogs.delete(input.requestId);
				sendJson(response, 200, { answered: true });
				return;
			}
			sendJson(response, 405, { error: "Method not allowed" });
		})().catch((error: unknown) => {
			if (!response.headersSent) sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
			else response.end();
		});
	});
	const websocketServer = new WebSocketServer({ noServer: true });
	server.on("upgrade", (request, socket, head) => {
		if (request.url !== "/events" || !trusted(request, true) || request.headers.origin !== origin) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return; }
		websocketServer.handleUpgrade(request, socket, head, (websocket) => {
			sockets.add(websocket);
			websocket.on("close", () => sockets.delete(websocket));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	origin = `http://127.0.0.1:${address.port}`;
	allowedHost = `127.0.0.1:${address.port}`;

	async function closeStory(id: string): Promise<void> {
		const story = active.get(id);
		if (!story) return;
		clearInterval(story.pump);
		for (const [key, pending] of pendingConfirmations) if (pending.story === story) pendingConfirmations.delete(key);
		await story.client.close();
		active.delete(id);
	}

	return {
		origin, cookie, authUrl: `${origin}/auth?token=${startupToken}`, envelopes, active, failed, listStories,
		async closeStory(id: string) { await closeStory(id); },
		async close() {
			if (closed) return;
			closed = true;
			for (const socket of sockets) socket.terminate();
			for (const id of [...active.keys()]) await closeStory(id);
			await new Promise<void>((resolve, reject) => websocketServer.close((error) => error ? reject(error) : resolve()));
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		},
	};
}
