import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { publicEvidence } from "../p2/artifacts.ts";
import type { BookCaseConfig } from "./book-case.ts";
import { interruptionDecision } from "./book-policy.ts";

export async function superviseBookCase(
	config: BookCaseConfig,
	options: {
		env?: NodeJS.ProcessEnv;
		signal?: AbortSignal;
		onRpcStarted?: (pid: number, parentPid: number | undefined) => void;
	} = {},
) {
	mkdirSync(config.folder, { recursive: true });
	const file = path.join(config.folder, "case-config.json");
	const text = JSON.stringify(config);
	publicEvidence(text);
	writeFileSync(file, text, { flag: "wx" });
	if (options.signal?.aborted) {
		writeFileSync(
			path.join(config.folder, "cancel-requested.json"),
			JSON.stringify({ time: new Date().toISOString(), beforeLaunch: true }),
			{ flag: "wx" },
		);
		return {
			code: 1,
			signal: null,
			folder: config.folder,
			caseExit: { status: "cancelled", cancelled: true, productError: false, timedOut: false },
		};
	}
	const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "book-case.ts"), file], {
		env: options.env ?? process.env,
		cwd: config.folder,
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		windowsHide: true,
	});
	let cancellationSent = false;
	const cancel = () => {
		if (cancellationSent) return;
		cancellationSent = true;
		writeFileSync(
			path.join(config.folder, "cancel-requested.json"),
			JSON.stringify({ time: new Date().toISOString(), parentPid: child.pid }),
			{ flag: "wx" },
		);
		if (child.connected) child.send({ type: "cancel" });
	};
	options.signal?.addEventListener("abort", cancel, { once: true });
	child.on("message", (message) => {
		if (
			message &&
			typeof message === "object" &&
			"type" in message &&
			message.type === "rpc_started" &&
			"rpcPid" in message &&
			typeof message.rpcPid === "number"
		)
			options.onRpcStarted?.(message.rpcPid, child.pid);
	});
	writeFileSync(
		path.join(config.folder, "supervisor-start.json"),
		JSON.stringify({ supervisorPid: process.pid, parentPid: child.pid, time: new Date().toISOString() }),
		{ flag: "wx" },
	);
	// Evidence is written by the RPC worker and case process. Provider stderr is
	// drained without echoing credentials or treating logs as success signals.
	child.stdout?.resume();
	let stderrBytes = 0;
	child.stderr?.on("data", (chunk: Buffer) => {
		stderrBytes += chunk.length;
	});
	const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; launchError?: string }>(
		(resolve) => {
			child.once("error", () =>
				resolve({ code: null, signal: null, launchError: "Book case process could not start" }),
			);
			child.once("close", (code, signal) => resolve({ code, signal }));
		},
	);
	options.signal?.removeEventListener("abort", cancel);
	writeFileSync(
		path.join(config.folder, "process-exit.json"),
		`${JSON.stringify({ ...result, stderrBytes, supervisorPid: process.pid, parentPid: child.pid, time: new Date().toISOString() }, null, 2)}\n`,
		{ flag: "wx" },
	);
	const exitFile = path.join(config.folder, "case-exit.json");
	return {
		...result,
		folder: config.folder,
		caseExit: existsSync(exitFile) ? (JSON.parse(readFileSync(exitFile, "utf8")) as Record<string, unknown>) : null,
	};
}

export function readBookInterruption(folder: string, previousRestarts: number) {
	const json = (name: string): Record<string, unknown> | undefined => {
		const file = path.join(folder, name);
		return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : undefined;
	};
	const start = json("supervisor-start.json");
	const exit = json("case-exit.json");
	const processExit = json("process-exit.json");
	const log = path.join(folder, "case-lifecycle.jsonl");
	const lifecycle = existsSync(log)
		? readFileSync(log, "utf8")
				.split(/\r?\n/u)
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>)
		: [];
	const rpc = lifecycle.findLast((row) => row.type === "rpc_started");
	const parentPid = typeof start?.parentPid === "number" ? start.parentPid : undefined;
	const rpcPid = typeof rpc?.rpcPid === "number" ? rpc.rpcPid : undefined;
	const alive = (pid: number | undefined): boolean | null => {
		if (!pid || !Number.isSafeInteger(pid) || pid < 1) return null;
		try {
			process.kill(pid, 0);
			return true;
		} catch (cause) {
			if (cause && typeof cause === "object" && "code" in cause && cause.code === "ESRCH") return false;
			return null;
		}
	};
	const facts = {
		parentPid,
		rpcPid,
		parentAlive: alive(parentPid),
		rpcAlive: alive(rpcPid),
		previousRestarts,
		...(exit?.status === "completed"
			? { exit: "completed" as const }
			: exit?.status === "failed"
				? { exit: "failed" as const }
				: {}),
		productError: exit?.productError === true,
		timedOut: exit?.timedOut === true,
		cancelled: existsSync(path.join(folder, "cancel-requested.json")) || exit?.cancelled === true,
		unclassifiedDiagnostic: !exit && Number(processExit?.stderrBytes ?? 0) > 0,
	};
	return { facts, ...interruptionDecision(facts) };
}
