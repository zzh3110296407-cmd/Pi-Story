import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { RpcCommand, RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";

type Frame = Record<string, unknown>;
type DialogAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };
interface Options {
	cli: string;
	cwd: string;
	args?: string[];
	env?: NodeJS.ProcessEnv;
	onEvent?: (frame: Frame) => void;
	onWire?: (direction: "in" | "out", frame: Frame) => void;
	dialog?: (request: RpcExtensionUIRequest) => Promise<DialogAnswer>;
	commandTimeoutMs?: number;
	settleTimeoutMs?: number;
}
const object = (value: unknown): value is Frame => value !== null && typeof value === "object" && !Array.isArray(value);

// Pi's exported client has no extension_ui_response sender. Keep that missing
// protocol capability in the measurement layer; do not patch the pinned Pi.
export class P3RpcClient {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly options: Options;
	private sequence = 0;
	private fatal?: Error;
	private readonly listeners = new Set<(frame: Frame) => void>();
	private readonly pending = new Map<
		string,
		{ resolve: (frame: Frame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();
	private readonly settles = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
	constructor(options: Options) {
		this.options = options;
		this.child = spawn(process.execPath, [options.cli, "--mode", "rpc", ...(options.args ?? [])], {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
		lines.on("line", (line) => {
			try {
				const frame: unknown = JSON.parse(line);
				if (!object(frame) || typeof frame.type !== "string") throw new Error("Malformed RPC frame");
				options.onWire?.("out", frame);
				if (frame.type === "response" && typeof frame.id === "string") {
					const pending = this.pending.get(frame.id);
					if (!pending) throw new Error("Unmatched RPC response");
					this.pending.delete(frame.id);
					clearTimeout(pending.timer);
					if (frame.success !== true) pending.reject(new Error("RPC command was refused"));
					else pending.resolve(frame);
					return;
				}
				if (frame.type === "agent_settled") for (const waiter of [...this.settles]) waiter.resolve();
				options.onEvent?.(frame);
				for (const listener of [...this.listeners]) listener(frame);
				if (
					frame.type === "extension_ui_request" &&
					["select", "confirm", "input", "editor"].includes(String(frame.method))
				) {
					if (
						typeof frame.id !== "string" ||
						typeof frame.title !== "string" ||
						(frame.method === "select" &&
							(!Array.isArray(frame.options) || !frame.options.every((item) => typeof item === "string")))
					)
						throw new Error("Malformed RPC dialog");
					const answer = options.dialog
						? options.dialog(frame as RpcExtensionUIRequest)
						: Promise.resolve<DialogAnswer>({ cancelled: true });
					void answer
						.then((value) => this.write({ type: "extension_ui_response", id: frame.id, ...value }))
						.catch(() => this.fail(new Error("RPC dialog forwarding failed")));
				}
			} catch {
				this.fail(new Error("RPC output or evidence recording failed"));
			}
		});
		// Drain stderr without echoing untrusted provider diagnostics or credentials.
		this.child.stderr.resume();
		this.child.on("error", () => this.fail(new Error("RPC child could not start")));
		this.child.stdin.on("error", () => this.fail(new Error("RPC input closed")));
		this.child.on("close", () => {
			lines.close();
			this.fail(new Error("RPC child exited"));
		});
	}
	private write(frame: Frame): void {
		if (this.fatal) throw this.fatal;
		this.options.onWire?.("in", frame);
		this.child.stdin.write(`${JSON.stringify(frame)}\n`);
	}
	onEvent(listener: (frame: Frame) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	get processId(): number | undefined {
		return this.child.pid;
	}
	private fail(error: Error): void {
		if (this.fatal) return;
		this.fatal = error;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		for (const waiter of [...this.settles]) waiter.reject(error);
		this.child.kill();
	}
	request(command: RpcCommand): Promise<Frame> {
		if (this.fatal) return Promise.reject(this.fatal);
		const id = `p3-${++this.sequence}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => this.fail(new Error("RPC command timed out")),
				this.options.commandTimeoutMs ?? 180_000,
			);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.write({ ...command, id });
			} catch {
				this.fail(new Error("RPC command or evidence recording failed"));
			}
		});
	}
	async promptAndWait(message: string, streamingBehavior?: "steer" | "followUp"): Promise<{ disposition: string }> {
		let waiter: { resolve: () => void; reject: (error: Error) => void } | undefined;
		const settled = new Promise<void>((resolve, reject) => {
			waiter = { resolve, reject };
			this.settles.add(waiter);
		});
		void settled.catch(() => {});
		const timer = setTimeout(
			() => this.fail(new Error("RPC run did not settle")),
			this.options.settleTimeoutMs ?? 45 * 60_000,
		);
		try {
			const response = await this.request({
				type: "prompt",
				message,
				...(streamingBehavior ? { streamingBehavior } : {}),
			});
			const disposition = object(response.data) ? response.data.disposition : undefined;
			if (!["handled", "started", "queued"].includes(String(disposition)))
				throw new Error("Missing RPC prompt disposition");
			if (disposition !== "handled") await settled;
			return { disposition: String(disposition) };
		} finally {
			clearTimeout(timer);
			if (waiter) this.settles.delete(waiter);
		}
	}
	async close(): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		const closed = new Promise<void>((resolve) => this.child.once("close", () => resolve()));
		this.fail(new Error("RPC client closed"));
		await closed;
	}
}
