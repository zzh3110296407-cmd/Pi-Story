// Reproduce via: node p0/scripts/verify-offline.ts V01
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

export type JsonRecord = Record<string, unknown>;
export const TEST_ROOT = "D:/开源/test/pi-Story/p0";
export const PI_ROOT = `${TEST_ROOT}/pi`;
export const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");

export function asRecord(value: unknown): JsonRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
	return value as JsonRecord;
}

export function asArray(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error("Expected an array");
	return value;
}

export function checkSecret(text: string): void {
	const key = process.env.DEEPSEEK_API_KEY;
	if ((key && text.includes(key)) || /\bsk-[A-Za-z0-9_-]{20,}/u.test(text)) {
		throw new Error("Secret detected: output was not saved");
	}
}

export function safeWrite(file: string, value: unknown): void {
	const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
	checkSecret(text);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
}

export function cliArgs(mode: "rpc" | "print" | "json", runDir: string, _scriptFile: string, extra: string[] = []): string[] {
	const builtCli = path.join(PI_ROOT, "packages/coding-agent/dist/cli.js");
	const useBuilt = process.env.P0_USE_BUILT_CLI === "1" && existsSync(builtCli);
	const entry = useBuilt
		? [builtCli]
		: ["--import", pathToFileURL(path.join(PI_ROOT, "packages/coding-agent/src/experimental/source-resolver.ts")).href,
			path.join(PI_ROOT, "packages/coding-agent/src/cli.ts")];
	return [...entry, "--session-dir", path.join(runDir, "sessions"), "--no-builtin-tools", "-ne", "-e",
		path.join(PROJECT_ROOT, "p0/ext/probe"), "-ns", "-np", "-nc", "--provider", "probe-faux", "--model", "script",
		...(mode === "print" ? ["-p"] : ["--mode", mode]), ...extra];
}

export function runEnvironment(runDir: string, scriptFile: string): NodeJS.ProcessEnv {
	return { ...process.env, PI_CODING_AGENT_DIR: path.join(TEST_ROOT, "agent-home"), PROBE_RUN_DIR: runDir,
		PROBE_SCRIPT: scriptFile, TMP: path.join(TEST_ROOT, "tmp"), TEMP: path.join(TEST_ROOT, "tmp"),
		npm_config_cache: path.join(TEST_ROOT, "npm-cache"), XDG_CACHE_HOME: path.join(TEST_ROOT, "cache") };
}

interface Waiter {
	predicate: (record: JsonRecord) => boolean;
	resolve: (record: JsonRecord) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface RpcOptions {
	runDir: string;
	scriptFile: string;
	extraArgs?: string[];
	env?: NodeJS.ProcessEnv;
}

export class ProbeRpcClient {
	readonly process: ChildProcessWithoutNullStreams;
	readonly records: JsonRecord[] = [];
	readonly receivedAt: number[] = [];
	readonly runDir: string;
	stderr = "";
	private counter = 0;
	private buffer = "";
	private decoder = new StringDecoder("utf8");
	private pending = new Map<string, { resolve: (record: JsonRecord) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private waiters = new Set<Waiter>();
	private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	private ended = false;

	constructor(options: RpcOptions) {
		this.runDir = options.runDir;
		mkdirSync(options.runDir, { recursive: true });
		mkdirSync(path.join(TEST_ROOT, "tmp"), { recursive: true });
		const args = cliArgs("rpc", options.runDir, options.scriptFile, options.extraArgs);
		this.process = spawn(process.execPath, args, { cwd: options.runDir, env: { ...runEnvironment(options.runDir, options.scriptFile), ...options.env }, windowsHide: true });
		this.process.stdin.on("error", (error) => this.fail(error));
		this.process.stdout.on("error", (error) => this.fail(error));
		this.process.stdout.on("data", (chunk: Buffer) => {
			try { this.consume(this.decoder.write(chunk)); } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); this.forceKill(); }
		});
		this.process.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			try { checkSecret(this.stderr + text); this.stderr += text; appendFileSync(path.join(options.runDir, "stderr.log"), text); }
			catch (error) {
				const logFile = path.join(options.runDir, "stderr.log");
				if (existsSync(logFile)) unlinkSync(logFile);
				this.fail(error instanceof Error ? error : new Error(String(error))); this.forceKill();
			}
		});
		this.process.on("error", (error) => this.fail(error));
		this.exitPromise = new Promise((resolve) => this.process.once("exit", (code, signal) => {
			this.ended = true;
			this.fail(new Error(`Pi exited (${code ?? signal}): ${this.stderr.slice(-2000)}`));
			resolve({ code, signal });
		}));
		safeWrite(path.join(options.runDir, "launch.json"), { executable: process.execPath, args, cwd: options.runDir, scriptFile: options.scriptFile });
	}

	private consume(text: string): void {
		this.buffer += text;
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
			this.buffer = this.buffer.slice(newline + 1);
			if (line) {
				checkSecret(line);
				const record = asRecord(JSON.parse(line));
				appendFileSync(path.join(this.runDir, "stdout.jsonl"), `${line}\n`);
				this.records.push(record);
				this.receivedAt.push(performance.now());
				if (record.type === "response" && typeof record.id === "string") {
					const request = this.pending.get(record.id);
					if (request) { clearTimeout(request.timer); this.pending.delete(record.id); request.resolve(record); }
				}
				for (const waiter of this.waiters) {
					if (waiter.predicate(record)) { clearTimeout(waiter.timer); this.waiters.delete(waiter); waiter.resolve(record); }
				}
			}
			newline = this.buffer.indexOf("\n");
		}
	}

	private fail(error: Error): void {
		for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
		this.pending.clear();
		for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
		this.waiters.clear();
	}

	async send(record: JsonRecord): Promise<void> {
		if (this.ended) throw new Error("Pi process has exited");
		const text = `${JSON.stringify(record)}\n`;
		checkSecret(text);
		appendFileSync(path.join(this.runDir, "stdin.jsonl"), text);
		await new Promise<void>((resolve, reject) => this.process.stdin.write(text, (error) => error ? reject(error) : resolve()));
	}

	async request(command: JsonRecord, timeoutMs = 30000): Promise<JsonRecord> {
		const id = `p0-${++this.counter}`;
		const response = new Promise<JsonRecord>((resolve, reject) => {
			const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC ${String(command.type)} timed out`)); }, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
		});
		try { await this.send({ ...command, id }); } catch (error) {
			const pending = this.pending.get(id); if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error instanceof Error ? error : new Error(String(error))); }
		}
		return response;
	}

	async success(command: JsonRecord, timeoutMs = 30000): Promise<JsonRecord> {
		const response = await this.request(command, timeoutMs);
		if (response.success !== true) throw new Error(`RPC ${String(command.type)} failed: ${String(response.error)}`);
		return response.data === undefined ? {} : asRecord(response.data);
	}

	waitFor(predicate: (record: JsonRecord) => boolean, afterIndex = this.records.length, timeoutMs = 30000): Promise<JsonRecord> {
		const existing = this.records.slice(afterIndex).find(predicate);
		if (existing) return Promise.resolve(existing);
		if (this.ended) return Promise.reject(new Error("Pi exited before event"));
		return new Promise<JsonRecord>((resolve, reject) => {
			const waiter: Waiter = { predicate, resolve, reject, timer: setTimeout(() => { this.waiters.delete(waiter); reject(new Error("Timed out waiting for RPC event")); }, timeoutMs) };
			this.waiters.add(waiter);
		});
	}

	async promptAndWait(message: string, timeoutMs = 30000): Promise<JsonRecord> {
		const index = this.records.length;
		const response = await this.success({ type: "prompt", message }, timeoutMs);
		if (response.disposition !== "handled") await this.waitFor((record) => record.type === "agent_settled", index, timeoutMs);
		return response;
	}

	async ready(): Promise<JsonRecord> { return this.success({ type: "get_state" }, 60000); }

	forceKill(): void {
		if (!this.ended && this.process.pid) {
			if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(this.process.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			else this.process.kill("SIGKILL");
		}
	}

	async close(): Promise<void> {
		if (this.ended) return;
		if (!this.process.stdin.destroyed) this.process.stdin.end();
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([this.exitPromise, new Promise<void>((resolve) => { timer = setTimeout(() => { this.forceKill(); resolve(); }, 8000); })]);
		if (timer) clearTimeout(timer);
	}
}
