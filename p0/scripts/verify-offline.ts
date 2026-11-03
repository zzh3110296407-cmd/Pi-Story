// Reproduce: node p0/scripts/verify-offline.ts V01 (or a comma-separated list).
// All generated data stays under D:/开源/test/pi-Story/p0. No paid provider is used.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { asArray, asRecord, cliArgs, type JsonRecord, PI_ROOT, ProbeRpcClient, PROJECT_ROOT, runEnvironment, safeWrite, TEST_ROOT } from "../rpc/client.ts";

type Turn = { text?: string; content?: JsonRecord[]; delayMs?: number };
type Check = (directory: string) => Promise<JsonRecord>;

function tool(name: string, args: JsonRecord, id: string): JsonRecord {
	return { type: "toolCall", id, name, arguments: args };
}

function saveScript(directory: string, turns: Turn[], suffix = "script", extra: JsonRecord = {}): string {
	const file = path.join(directory, `${suffix}.json`);
	safeWrite(file, { turns, ...extra });
	return file;
}

function branch(entries: JsonRecord[], leafId: unknown): JsonRecord[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const result: JsonRecord[] = [];
	let cursor = leafId;
	const visited = new Set<unknown>();
	while (cursor) {
		assert(!visited.has(cursor), "parentId cycle");
		visited.add(cursor);
		const entry = byId.get(cursor);
		assert(entry, `Missing branch parent ${String(cursor)}`);
		result.push(entry);
		cursor = entry.parentId;
	}
	return result.reverse();
}

function results(entries: JsonRecord[], name?: string): JsonRecord[] {
	return entries.filter((entry) => {
		if (entry.type !== "message") return false;
		const message = asRecord(entry.message);
		return message.role === "toolResult" && (!name || message.toolName === name);
	});
}

async function entries(client: ProbeRpcClient): Promise<{ all: JsonRecord[]; current: JsonRecord[]; leafId: unknown }> {
	const response = await client.success({ type: "get_entries" });
	const all = asArray(response.entries).map(asRecord);
	return { all, current: branch(all, response.leafId), leafId: response.leafId };
}

function numbers(entries: JsonRecord[]): number[] {
	return results(entries, "probe_write").filter((entry) => asRecord(entry.message).isError !== true)
		.map((entry) => Number(asRecord(asRecord(entry.message).details).n));
}

async function withClient<T>(directory: string, scriptFile: string, fn: (client: ProbeRpcClient, state: JsonRecord) => Promise<T>, extraArgs: string[] = [], env: NodeJS.ProcessEnv = {}): Promise<T> {
	const client = new ProbeRpcClient({ runDir: directory, scriptFile, extraArgs, env });
	try { const state = await client.ready(); return await fn(client, state); }
	finally { await client.close(); }
}

async function readFolded(client: ProbeRpcClient): Promise<JsonRecord> {
	const index = client.records.length;
	await client.success({ type: "prompt", message: "/probe-state" });
	const notification = await client.waitFor((record) => record.type === "extension_ui_request" && record.method === "notify" && typeof record.message === "string" && record.message.startsWith("{"), index);
	return asRecord(JSON.parse(String(notification.message)));
}

function readSession(file: string): JsonRecord[] {
	return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => asRecord(JSON.parse(line)));
}

function eventLog(directory: string): JsonRecord[] {
	return readSession(path.join(directory, "events.jsonl"));
}

function messageResult(client: ProbeRpcClient, toolName: string): JsonRecord {
	const found = client.records.findLast((record) => record.type === "message_end" && asRecord(record.message).role === "toolResult" && asRecord(record.message).toolName === toolName);
	assert(found, `Missing ${toolName} message_end`);
	return asRecord(found.message);
}

function childMemory(pid: number | undefined): JsonRecord {
	assert(pid && Number.isInteger(pid));
	const command = `$p = Get-Process -Id ${pid}; @{workingSetBytes=$p.WorkingSet64;peakWorkingSetBytes=$p.PeakWorkingSet64;privateBytes=$p.PrivateMemorySize64} | ConvertTo-Json -Compress`;
	const response = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8", windowsHide: true, timeout: 10000 });
	assert.equal(response.status, 0, response.stderr);
	return asRecord(JSON.parse(response.stdout));
}

const checks: Record<string, Check> = {
	async V01(directory) {
		const printDir = path.join(directory, "print");
		mkdirSync(printDir, { recursive: true });
		const printScript = saveScript(printDir, [{ content: [tool("probe_write", { n: 101 }, "print-write")] }, { text: "print complete" }]);
		const args = cliArgs("print", printDir, printScript, ["验证打印模式"]);
		const print = spawnSync(process.execPath, args, { cwd: printDir, env: runEnvironment(printDir, printScript), windowsHide: true, encoding: "utf8", timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
		safeWrite(path.join(printDir, "stdout.log"), print.stdout ?? "");
		safeWrite(path.join(printDir, "stderr.log"), print.stderr ?? "");
		safeWrite(path.join(printDir, "launch.json"), { command: process.execPath, args, status: print.status, error: print.error?.message });
		assert.equal(print.status, 0, print.error?.message ?? `Print exited: ${String(print.stderr)}`);
		const printFiles = readdirSync(path.join(printDir, "sessions")).filter((file) => file.endsWith(".jsonl"));
		assert.equal(printFiles.length, 1, "Print mode persisted one session");
		assert.deepEqual(numbers(readSession(path.join(printDir, "sessions", printFiles[0]))), [101]);
		const rpcDir = path.join(directory, "rpc");
		const rpcScript = saveScript(rpcDir, [{ content: [tool("probe_write", { n: 102 }, "rpc-write")] }, { text: "rpc complete" }]);
		const rpc = await withClient(rpcDir, rpcScript, async (client, state) => {
			await client.promptAndWait("验证 RPC 模式");
			const view = await entries(client);
			assert.deepEqual(numbers(view.current), [102]);
			const finalState = await client.success({ type: "get_state" });
			assert.equal(typeof finalState.sessionFile, "string");
			assert(existsSync(String(finalState.sessionFile)), "RPC session exists on disk");
			assert.deepEqual(numbers(readSession(String(finalState.sessionFile))), [102]);
			return { sessionId: state.sessionId, sessionFile: finalState.sessionFile, events: client.records.length };
		});
		const manualDir = path.join(directory, "manual");
		const manualScript = saveScript(manualDir, [{ content: [tool("probe_write", { n: 103 }, "manual-write")] }, { text: "interactive complete" }]);
		const manualCommand = `$env:PROBE_RUN_DIR='${manualDir}'; $env:PROBE_SCRIPT='${manualScript}'; & '${path.join(PROJECT_ROOT, "p0/scripts/pi.ps1")}' --session-dir '${path.join(manualDir, "sessions")}' --no-builtin-tools -ne -e '${path.join(PROJECT_ROOT, "p0/ext/probe")}' -ns -np -nc --provider probe-faux --model script`;
		return { status: "成立", print: { sessionFile: path.join(printDir, "sessions", printFiles[0]) }, rpc,
			manual: { status: "未执行", command: manualCommand, observe: "输入任意一条消息；应出现 probe_write，/probe-state 应显示 n=103，随后正常退出" } };
	},

	async V02(directory) {
		const denied = ["read", "bash", "write", "edit", "codemode"];
		const script = saveScript(directory, [{ content: denied.map((name, index) => tool(name, {}, `denied-${index}`)) }, { text: "denial checks complete" }]);
		return withClient(directory, script, async (client) => {
			const commandData = await client.success({ type: "get_commands" });
			const commands = asArray(commandData.commands).map(asRecord);
			assert(commands.length >= 4, "Probe commands registered");
			assert(commands.every((command) => String(command.name).startsWith("probe-")), "Only probe commands loaded");
			await client.promptAndWait("尝试调用所有内置工具");
			const view = await entries(client);
			const attempts = results(view.current).map((entry) => asRecord(entry.message));
			for (const name of denied) assert(attempts.some((message) => message.toolName === name && message.isError === true), `${name} rejected`);
			const eventText = readFileSync(path.join(directory, "events.jsonl"), "utf8");
			const events = eventText.split("\n").filter(Boolean).map((line) => asRecord(JSON.parse(line)));
			const requests = events.filter((event) => event.type === "provider_request");
			assert(requests.length > 0, "Actual provider request captured");
			const toolNames = asArray(asRecord(asRecord(requests[0].data).payload).tools).map((value) => asRecord(value).name);
			assert(toolNames.includes("probe_write"));
			assert(toolNames.every((name) => String(name).startsWith("probe_")), "Actual provider payload exposes only probe tools");
			safeWrite(path.join(directory, "request-evidence.json"), requests);
			return { status: "成立", commandNames: commands.map((command) => command.name), denied: attempts.map((message) => ({ name: message.toolName, isError: message.isError })), evidence: "events.jsonl actual request tool list" };
		});
	},

	async V03(directory) {
		const initialDir = path.join(directory, "initial");
		const initialScript = saveScript(initialDir, [
			{ content: [tool("probe_write", { n: 1 }, "first-write")] }, { text: "first complete" },
			{ content: [tool("probe_write", { n: 2 }, "second-write")] }, { text: "second complete" },
		]);
		const saved = await withClient(initialDir, initialScript, async (client) => {
			await client.promptAndWait("写入第一个值");
			await client.success({ type: "prompt", message: "/probe-intent 保留作者控制" });
			await client.promptAndWait("写入第二个值");
			const view = await entries(client);
			assert.deepEqual(numbers(view.current), [1, 2]);
			assert(view.current.some((entry) => entry.type === "custom" && entry.customType === "probe.control"));
			const first = results(view.current, "probe_write")[0];
			const state = await client.success({ type: "get_state" });
			return { file: String(state.sessionFile), id: String(state.sessionId), firstId: String(first.id), before: view.current };
		});
		const reopenedDir = path.join(directory, "reopened");
		const reopenedScript = saveScript(reopenedDir, [{ content: [tool("probe_write", { n: 3 }, "branch-write")] }, { text: "new branch complete" }]);
		return withClient(reopenedDir, reopenedScript, async (client) => {
			const reopened = await entries(client);
			assert.deepEqual(numbers(reopened.current), [1, 2]);
			assert(reopened.current.some((entry) => entry.type === "custom" && entry.customType === "probe.control"));
			const reopenedFold = await readFolded(client);
			assert.deepEqual(asArray(reopenedFold.writes).map((item) => asRecord(item).n), [1, 2]);
			assert.equal(reopenedFold.control, "保留作者控制");
			await client.success({ type: "prompt", message: `/probe-branch ${saved.firstId}` });
			await client.promptAndWait("在新分支写入第三个值");
			const changed = await entries(client);
			assert.deepEqual(numbers(changed.current), [1, 3], "Current branch excludes abandoned write 2");
			assert(numbers(changed.all).includes(2), "Old branch is preserved in file");
			assert(!changed.current.some((entry) => entry.type === "branch_summary"), "No generated branch summary");
			const branchFold = await readFolded(client);
			assert.deepEqual(asArray(branchFold.writes).map((item) => asRecord(item).n), [1, 3]);
			return { status: "成立", sessionId: saved.id, sessionFile: saved.file, reopenedNumbers: numbers(reopened.current), branchNumbers: numbers(changed.current), allNumbers: numbers(changed.all), reopenedFold, branchFold };
		}, ["--session", saved.file]);
	},

	async V04(directory) {
		const script = saveScript(directory, [{ content: [tool("probe_write", { n: 1 }, "batch-1"), tool("probe_write", { n: 2 }, "batch-2"), tool("probe_read", {}, "batch-read")] }, { text: "batch complete" }]);
		return withClient(directory, script, async (client) => {
			await client.promptAndWait("同一批串行写读");
			const view = await entries(client);
			const writes = results(view.current, "probe_write").map((entry) => asRecord(asRecord(entry.message).details));
			assert.equal(writes.length, 2);
			safeWrite(path.join(directory, "writes-and-reads.json"), results(view.current));
			assert(asArray(writes[1].visible).map(asRecord).some((item) => item.n === 1), "Second write sees first tool result");
			const read = asRecord(asRecord(results(view.current, "probe_read")[0].message).details);
			assert.deepEqual(asArray(asRecord(read.state).writes).map((item) => asRecord(item).n), [1, 2]);
			return { status: "成立", writes, toolOrder: client.records.filter((record) => record.type === "tool_execution_start" || record.type === "tool_execution_end").map((record) => ({ type: record.type, id: record.toolCallId })) };
		});
	},

	async V05(directory) {
		const script = saveScript(directory, [{ content: [tool("probe_commit", { chapter: 1 }, "commit-1"), tool("probe_read", {}, "read-after-commit")] }, { text: "committed" }]);
		return withClient(directory, script, async (client) => {
			await client.promptAndWait("提交后给批次最后结果打标签");
			const view = await entries(client);
			const lastResult = results(view.current).at(-1);
			assert(lastResult);
			const labels = view.all.filter((entry) => entry.type === "label" && entry.label === "第 1 章");
			assert.equal(labels.length, 1);
			assert.equal(labels[0].targetId, lastResult.id);
			const tree = await client.success({ type: "get_tree" });
			assert(JSON.stringify(tree).includes("第 1 章"));
			return { status: "成立", label: labels[0], targetTool: asRecord(lastResult.message).toolName };
		});
	},

	async V24(directory) {
		const script = saveScript(directory, [{ content: [tool("probe_write", { n: 24 }, "entries-write")] }, { text: "entries done" }]);
		return withClient(directory, script, async (client) => {
			await client.promptAndWait("保存可读取的 details");
			await client.success({ type: "prompt", message: "/probe-intent V24自定义条目" });
			const view = await entries(client);
			assert(results(view.current, "probe_write").some((entry) => asRecord(asRecord(entry.message).details).n === 24));
			assert(view.current.some((entry) => entry.type === "custom" && entry.customType === "probe.control"));
			const cursor = String(view.all[0].id);
			const incremental = await client.success({ type: "get_entries", since: cursor });
			assert.equal(incremental.leafId, view.leafId);
			assert(asArray(incremental.entries).length < view.all.length);
			const invalid = await client.request({ type: "get_entries", since: "nonexistent-p0-cursor" });
			assert.equal(invalid.success, false);
			return { status: "成立", allCount: view.all.length, sinceCount: asArray(incremental.entries).length, leafId: view.leafId, invalidCursorResponse: invalid };
		});
	},

	async V06(directory) {
		const script = saveScript(directory, [
			{ content: [tool("probe_commit", { chapter: 1 }, "chapter-1")] }, { text: "chapter one done" },
			{ content: [tool("probe_commit", { chapter: 2 }, "chapter-2")] }, { text: "chapter two done" },
			{ content: [tool("probe_commit", { chapter: 3 }, "chapter-3")] }, { text: "chapter three done" },
			{ text: "continuing new branch" },
		]);
		return withClient(directory, script, async (client) => {
			for (let chapter = 1; chapter <= 3; chapter++) await client.promptAndWait(`write ${chapter}`);
			const before = await entries(client);
			const label = before.all.find((entry) => entry.type === "label" && entry.label === "第 1 章");
			assert(label);
			await client.success({ type: "prompt", message: `/probe-branch ${String(label.targetId)}` });
			await client.promptAndWait("Branch continuation with U+2028 separator: a\u2028b");
			const after = await entries(client);
			assert.equal(results(after.current, "probe_commit").length, 1);
			assert(!after.current.some((entry) => entry.type === "branch_summary"));
			const requests = eventLog(directory).filter((event) => event.type === "provider_request");
			const lastPayload = asRecord(asRecord(requests.at(-1)?.data).payload);
			const sentMessages = asArray(lastPayload.messages).map(asRecord);
			assert(!sentMessages.some((message) => JSON.stringify(message).includes('"chapter":2')));
			assert(!sentMessages.some((message) => JSON.stringify(message).includes('"chapter":3')));
			return { status: "未执行", offlineStatus: "成立", reason: "Real DeepSeek tool-result-to-user ordering check is separate and has not been executed here", branchCommitCount: 1, generatedBranchSummaries: 0, unicodeSeparatorPreserved: JSON.stringify(sentMessages).includes("a\u2028b") };
		});
	},

	async V08(directory) {
		const interruptedDir = path.join(directory, "interrupted");
		const script = saveScript(interruptedDir, [{ content: [tool("probe_slow", { ms: 30000 }, "unfinished-call")] }, { text: "must not finish before kill" }]);
		const client = new ProbeRpcClient({ runDir: interruptedDir, scriptFile: script });
		let sessionFile = "";
		try {
			const state = await client.ready();
			sessionFile = String(state.sessionFile);
			const startIndex = client.records.length;
			await client.success({ type: "prompt", message: "Start interruptible tool" });
			await client.waitFor((record) => record.type === "tool_execution_start" && record.toolCallId === "unfinished-call", startIndex);
			client.forceKill();
		} finally { await client.close(); }
		const before = readSession(sessionFile);
		assert(!results(before).some((entry) => asRecord(entry.message).toolCallId === "unfinished-call"));
		const reopenedDir = path.join(directory, "reopened");
		const reopenedScript = saveScript(reopenedDir, [{ text: "resumed after interruption" }]);
		return withClient(reopenedDir, reopenedScript, async (reopened) => {
			const initial = await entries(reopened);
			const audit = initial.current.find((entry) => entry.type === "custom" && entry.customType === "probe.interrupted");
			assert(audit && asRecord(audit.data).toolCallId === "unfinished-call");
			await reopened.promptAndWait("Continue after incomplete tool");
			const final = await entries(reopened);
			const syntheticResults = results(final.current).filter((entry) => asRecord(entry.message).toolCallId === "unfinished-call");
			return { status: "成立", sessionFile, interruptionAudit: audit, syntheticResultCount: syntheticResults.length, continuationCompleted: true };
		}, ["--session", sessionFile]);
	},

	async V09(directory) {
		const measurements: JsonRecord[] = [];
		for (const sizeKB of [100, 1024, 5120, 20480]) {
			const sizeDir = path.join(directory, String(sizeKB));
			const script = saveScript(sizeDir, [{ content: [tool("probe_commit", { chapter: 1, sizeKB }, `large-${sizeKB}`)] }, { text: "large result complete" }]);
			let file = "";
			const first = await withClient(sizeDir, script, async (client) => {
				const start = performance.now();
				await client.promptAndWait(`Commit ${sizeKB} KiB`, 120000);
				const commitMs = performance.now() - start;
				const readStart = performance.now();
				const view = await entries(client);
				const readMs = performance.now() - readStart;
				const commits = results(view.current, "probe_commit");
				assert.equal(String(asRecord(asRecord(commits[0].message).details).text).length, sizeKB * 1024);
				file = String((await client.success({ type: "get_state" })).sessionFile);
				return { commitMs, getEntriesMs: readMs, clientRssBytes: process.memoryUsage().rss, piMemory: childMemory(client.process.pid) };
			});
			const reopenedDir = path.join(sizeDir, "reopen");
			const reopenedScript = saveScript(reopenedDir, [{ text: "reopened" }]);
			const start = performance.now();
			const reopened = await withClient(reopenedDir, reopenedScript, async (client) => {
				const view = await entries(client);
				assert.equal(String(asRecord(asRecord(results(view.current, "probe_commit")[0].message).details).text).length, sizeKB * 1024);
				return { reopenAndReadMs: performance.now() - start };
			}, ["--session", file]);
			measurements.push({ sizeKB, ...first, ...reopened, sessionFile: file });
		}
		return { status: "成立", measurements, memoryScope: "Client RSS and Windows Pi process working set, peak working set and private bytes", observedMaximumBytes: 20480 * 1024, recommendation: "20 MiB passed as one details value; keep v1.0 chapter text in commit result, avoid additional duplicates when expansion requires it" };
	},

	async V10(directory) {
		const turns: Turn[] = [];
		for (let n = 1; n <= 3; n++) turns.push({ content: [tool("probe_write", { n }, `round-${n}`)] }, { text: `round ${n}` });
		const script = saveScript(directory, turns);
		// Pi normally retains 20,000 recent tokens. This short deterministic fixture
		// lowers only the test project's setting so manual compaction has a prefix to summarize.
		safeWrite(path.join(directory, ".pi/settings.json"), { compaction: { keepRecentTokens: 32 } });
		return withClient(directory, script, async (client) => {
			for (let round = 1; round <= 3; round++) await client.promptAndWait(`round ${round}`);
			const state = await client.success({ type: "get_state" });
			const persisted = readSession(String(state.sessionFile));
			const system = persisted.filter((entry) => entry.type === "message" && asRecord(entry.message).role === "system").map((entry) => asRecord(entry.message));
			safeWrite(path.join(directory, "system-entries.json"), system);
			assert(system.length >= 3);
			const sections = system.map((message) => asRecord(message.sections));
			assert(sections[0].probe_rules !== undefined);
			assert(sections.slice(1).some((section) => section.probe_progress !== undefined && section.probe_rules === undefined), "Unchanged rule section omitted from later persistence");
			await client.success({ type: "compact", customInstructions: "Give one short summary" }, 60000);
			assert.equal((await entries(client)).current.filter((entry) => entry.type === "compaction").length, 1, "Manual compaction actually persisted");
			await client.promptAndWait("Verify rules after compaction");
			const requests = eventLog(directory).filter((event) => event.type === "provider_request");
			const lastPayload = asRecord(asRecord(requests.at(-1)?.data).payload);
			assert(String(lastPayload.systemPrompt).includes("Scripted P0 probe rules"));
			assert(!String(lastPayload.systemPrompt).includes("<available_skills>"));
			return { status: "未执行", offlineStatus: "成立", reason: "DeepSeek cache-hit portion requires the approved real-model check", compactionFixture: { keepRecentTokens: 32, scope: "this test project only", processOnlyProjectApproval: true, compactionEntryPersisted: true }, systemEntryCount: system.length, changedSectionKeys: sections.map(Object.keys), rulesPresentAfterCompaction: true, skillDirectoryAbsent: true };
		}, ["-a"]);
	},

	async V11(directory) {
		const script = saveScript(directory, [{ content: [tool("probe_read", {}, "read-to-edit")] }, { text: "after read" }, { text: "later prompt" }]);
		return withClient(directory, script, async (client) => {
			await client.promptAndWait("Read current state");
			await client.promptAndWait("Observe edited context");
			const view = await entries(client);
			const edits = view.all.filter((entry) => entry.type === "context_edit");
			assert.equal(edits.length, 1);
			const requests = eventLog(directory).filter((event) => event.type === "provider_request");
			const lastPayload = asRecord(asRecord(requests.at(-1)?.data).payload);
			assert(JSON.stringify(lastPayload.messages).includes("P0 probe read result replaced by context edit"));
			return { status: "成立", edits, replacementObservedInNextRequest: true };
		}, [], { PROBE_CONTEXT_EDIT: "1" });
	},

	async V12(directory) {
		const goalDir = path.join(directory, "goal");
		const goalTurns: Turn[] = [];
		for (let chapter = 1; chapter <= 3; chapter++) goalTurns.push({ content: [tool("probe_commit", { chapter }, `goal-${chapter}`)] }, { text: `completed ${chapter}` });
		const goalScript = saveScript(goalDir, goalTurns);
		const goal = await withClient(goalDir, goalScript, async (client) => {
			await client.success({ type: "prompt", message: "/probe-goal 3" });
			await client.promptAndWait("Write to goal", 60000);
			const view = await entries(client);
			assert.equal(results(view.current, "probe_commit").length, 3);
			return { commits: 3, automaticContinueCount: eventLog(goalDir).filter((event) => event.type === "agent_before_settle" && asRecord(event.data).shouldContinue === true).length };
		});
		const askDir = path.join(directory, "ask");
		const askScript = saveScript(askDir, [{ content: [tool("probe_ask", { question: "Should I continue?" }, "ask-author")] }, { text: "waiting acknowledged" }]);
		const ask = await withClient(askDir, askScript, async (client) => {
			await client.success({ type: "prompt", message: "/probe-goal 3" });
			const index = client.records.length;
			await client.success({ type: "prompt", message: "Ask author before writing" });
			const dialog = await client.waitFor((record) => record.type === "extension_ui_request" && record.method === "input", index);
			assert.equal(results((await entries(client)).current, "probe_commit").length, 0);
			await client.send({ type: "extension_ui_response", id: dialog.id, value: "Wait" });
			await client.waitFor((record) => record.type === "agent_settled", index);
			assert.equal(results((await entries(client)).current, "probe_commit").length, 0);
			return { waitingDialog: true, autoContinued: eventLog(askDir).some((event) => event.type === "agent_before_settle" && asRecord(event.data).shouldContinue === true) };
		});
		assert.equal(ask.autoContinued, false);
		const budgetDir = path.join(directory, "budget");
		const budgetScript = saveScript(budgetDir, [{ text: "must be blocked" }]);
		const budget = await withClient(budgetDir, budgetScript, async (client) => {
			await client.success({ type: "prompt", message: "/probe-goal 3" });
			await client.promptAndWait("Budget is exhausted");
			assert.equal(results((await entries(client)).current, "probe_commit").length, 0);
			const observed = eventLog(budgetDir);
			const providerDispatches = observed.filter((event) => event.type === "provider_dispatch").length;
			assert.equal(providerDispatches, 0, "Budget exhaustion must abort before scripted provider dispatch");
			const assistantMessages = client.records.filter((record) => record.type === "message_end" && asRecord(record.message).role === "assistant").map((record) => asRecord(record.message));
			assert.equal(assistantMessages.at(-1)?.stopReason, "aborted");
			assert(!assistantMessages.some((message) => message.stopReason === "stop" || message.stopReason === "toolUse"), "No successful reply after budget cancellation");
			return { continued: observed.some((event) => event.type === "agent_before_settle" && asRecord(event.data).shouldContinue === true), preparedPayloads: observed.filter((event) => event.type === "provider_request").length, providerDispatches, finalStopReason: assistantMessages.at(-1)?.stopReason, successfulReplies: 0 };
		}, [], { PROBE_BUDGET_BLOCK: "1" });
		assert.equal(budget.continued, false);
		const abortDir = path.join(directory, "abort");
		const abortScript = saveScript(abortDir, [{ content: [tool("probe_slow", { ms: 10000 }, "abort-slow")] }, { content: [tool("probe_commit", { chapter: 1 }, "must-not-commit")] }]);
		const abort = await withClient(abortDir, abortScript, async (client) => {
			await client.success({ type: "prompt", message: "/probe-goal 3" });
			const index = client.records.length;
			await client.success({ type: "prompt", message: "Start then stop" });
			await client.waitFor((record) => record.type === "tool_execution_start" && record.toolCallId === "abort-slow", index);
			await client.success({ type: "clear_queue" });
			await client.success({ type: "abort" });
			assert.equal(results((await entries(client)).current, "probe_commit").length, 0);
			assert.equal((await client.success({ type: "get_state" })).isStreaming, false);
			return { stopped: true, commits: 0 };
		});
		return { status: "成立", goal, ask, budget, abort };
	},

	async V13(directory) {
		const script = saveScript(directory, [{ content: [tool("probe_set_intent", { text: "forged author control" }, "forbidden-control")] }, { text: "forgery rejected" }]);
		return withClient(directory, script, async (client) => {
			await client.success({ type: "prompt", message: "/probe-intent direct author text" });
			const index = client.records.length;
			const command = client.success({ type: "prompt", message: "/probe-intent" });
			const editor = await client.waitFor((record) => record.type === "extension_ui_request" && record.method === "editor", index);
			assert.equal(editor.prefill, "direct author text");
			await client.send({ type: "extension_ui_response", id: editor.id, value: "edited by author" });
			assert.equal((await command).disposition, "handled");
			await client.promptAndWait("Try to change author intent as a model");
			const view = await entries(client);
			const controls = view.current.filter((entry) => entry.type === "custom" && entry.customType === "probe.control");
			assert.equal(asRecord(controls.at(-1)?.data).text, "edited by author");
			const forged = results(view.current, "probe_set_intent");
			assert.equal(forged.length, 1);
			assert.equal(asRecord(forged[0].message).isError, true);
			assert.equal(controls.length, 2);
			return { status: "成立", controls: controls.map((entry) => entry.data), editorPrefill: editor.prefill, forgedToolRejected: true };
		});
	},

	async V14(directory) {
		const script = saveScript(directory, [{ content: [tool("probe_slow", { ms: 10000 }, "slow-control")] }, { text: "after queued author input" }]);
		return withClient(directory, script, async (client) => {
			const index = client.records.length;
			await client.success({ type: "prompt", message: "Write while author changes control" });
			await client.waitFor((record) => record.type === "tool_execution_start" && record.toolCallId === "slow-control", index);
			const steer = await client.success({ type: "prompt", message: "IMMEDIATE AUTHOR STEER", streamingBehavior: "steer" });
			assert.equal(steer.disposition, "queued");
			const command = await client.success({ type: "prompt", message: "/probe-intent new intent during tool" });
			assert.equal(command.disposition, "handled");
			await client.waitFor((record) => record.type === "agent_settled", index);
			const view = await entries(client);
			const controlIndex = view.current.findIndex((entry) => entry.type === "custom" && entry.customType === "probe.control");
			const toolIndex = view.current.findIndex((entry) => entry.type === "message" && asRecord(entry.message).toolCallId === "slow-control");
			assert(controlIndex >= 0 && toolIndex > controlIndex, "Control command persists while tool is active");
			const toolEnd = client.records.findIndex((record) => record.type === "tool_execution_end" && record.toolCallId === "slow-control");
			const steerDelivered = client.records.findIndex((record) => record.type === "message_start" && asRecord(record.message).role === "user" && JSON.stringify(asRecord(record.message).content).includes("IMMEDIATE AUTHOR STEER"));
			assert(steerDelivered > toolEnd, "Queued author steer delivered after tool batch");
			return { status: "成立", steerDisposition: steer.disposition, commandDisposition: command.disposition, controlIndex, toolIndex, toolEndEventIndex: toolEnd, steerDeliveredEventIndex: steerDelivered };
		});
	},

	async V26(directory) {
		const cases: JsonRecord[] = [];
		for (const behavior of ["steer", "followUp"] as const) {
			const caseDir = path.join(directory, behavior);
			const script = saveScript(caseDir, [{ content: [tool("probe_slow", { ms: 10000 }, `slow-${behavior}`)] }, { text: `after ${behavior}` }, { text: "follow up complete" }]);
			cases.push(await withClient(caseDir, script, async (client) => {
				const index = client.records.length;
				await client.success({ type: "prompt", message: `Start ${behavior} test` });
				await client.waitFor((record) => record.type === "tool_execution_start" && record.toolCallId === `slow-${behavior}`, index);
				await client.success({ type: "prompt", message: `Author ${behavior}`, streamingBehavior: behavior });
				await client.waitFor((record) => record.type === "agent_settled", index);
				const message = messageResult(client, "probe_slow");
				const input = eventLog(caseDir).find((event) => event.type === "input" && asRecord(event.data).streamingBehavior === behavior);
				assert(input);
				assert.equal(asRecord(input.data).source, "rpc");
				assert.equal(message.isError === true, behavior === "steer");
				if (behavior === "steer") assert.equal(asRecord(message.details).code, "INTERJECTED");
				return { behavior, input: input.data, resultIsError: message.isError === true, code: asRecord(message.details).code ?? null };
			}));
		}
		return { status: "成立", automaticCases: cases, manual: "Interactive terminal steer timing is unexecuted; run the documented command and type while probe_slow runs" };
	},

	async V15(directory) {
		const modes: JsonRecord[] = [];
		for (const mode of ["print", "json"] as const) {
			const modeDir = path.join(directory, mode);
			mkdirSync(modeDir, { recursive: true });
			const script = saveScript(modeDir, [{ content: [tool("probe_ask", { question: "Is author present?" }, `ask-${mode}`)] }, { text: "no UI fallback complete" }]);
			const args = cliArgs(mode, modeDir, script, ["Ask without interface"]);
			const run = spawnSync(process.execPath, args, { cwd: modeDir, env: runEnvironment(modeDir, script), encoding: "utf8", windowsHide: true, timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
			safeWrite(path.join(modeDir, "stdout.log"), run.stdout ?? "");
			safeWrite(path.join(modeDir, "stderr.log"), run.stderr ?? "");
			assert.equal(run.status, 0, run.error?.message ?? run.stderr);
			const sessionFiles = readdirSync(path.join(modeDir, "sessions")).filter((file) => file.endsWith(".jsonl"));
			assert.equal(sessionFiles.length, 1);
			const result = results(readSession(path.join(modeDir, "sessions", sessionFiles[0])), "probe_ask")[0];
			assert(result);
			const details = asRecord(asRecord(result.message).details);
			assert.equal(details.hasUI, false);
			assert(String(details.answer).includes("作者不在场"));
			modes.push({ mode, details });
		}
		const sdkDir = path.join(directory, "sdk");
		mkdirSync(sdkDir, { recursive: true });
		const sdkScript = saveScript(sdkDir, [{ content: [tool("probe_ask", { question: "Is author present in SDK?" }, "ask-sdk")] }, { text: "sdk complete" }]);
		const resolver = pathToFileURL(path.join(PI_ROOT, "packages/coding-agent/src/experimental/source-resolver.ts")).href;
		const sdkArgs = ["--import", resolver, path.join(PROJECT_ROOT, "p0/scripts/sdk-smoke.ts")];
		const sdk = spawnSync(process.execPath, sdkArgs, { cwd: sdkDir, env: runEnvironment(sdkDir, sdkScript), encoding: "utf8", windowsHide: true, timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
		safeWrite(path.join(sdkDir, "stdout.log"), sdk.stdout ?? "");
		safeWrite(path.join(sdkDir, "stderr.log"), sdk.stderr ?? "");
		assert.equal(sdk.status, 0, sdk.error?.message ?? sdk.stderr);
		modes.push({ mode: "SDK", ...asRecord(JSON.parse(readFileSync(path.join(sdkDir, "sdk-result.json"), "utf8"))) });
		return { status: "成立", modes };
	},

	async V07(directory) {
		const killed: JsonRecord[] = [];
		for (let repetition = 1; repetition <= 20; repetition++) {
			const caseDir = path.join(directory, "kill", String(repetition));
			const script = saveScript(caseDir, [{ content: [tool("probe_commit", { chapter: 1, sizeKB: 5120 }, `kill-commit-${repetition}`)] }, { text: "after commit" }]);
			const client = new ProbeRpcClient({ runDir: caseDir, scriptFile: script });
			let file = "";
			let eventReceived = false;
			try {
				file = String((await client.ready()).sessionFile);
				const index = client.records.length;
				await client.success({ type: "prompt", message: "Commit then immediately kill" });
				await client.waitFor((record) => record.type === "tool_execution_end" && record.toolCallId === `kill-commit-${repetition}`, index, 60000);
				eventReceived = true;
				client.forceKill();
			} finally { await client.close(); }
			const raw = readFileSync(file, "utf8");
			const lines = raw.split("\n").filter(Boolean);
			const valid: JsonRecord[] = [];
			let incompleteLastLine = false;
			for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
				try { valid.push(asRecord(JSON.parse(lines[lineIndex]))); }
				catch { assert.equal(lineIndex, lines.length - 1, "Only the final line may be incomplete"); incompleteLastLine = true; }
			}
			const commits = results(valid, "probe_commit");
			assert(commits.length === 0 || commits.length === 1);
			if (commits.length) assert.equal(String(asRecord(asRecord(commits[0].message).details).text).length, 5120 * 1024);
			killed.push({ repetition, eventReceived, completeCommitCount: commits.length, incompleteLastLine, file });
		}

		const readonlyDir = path.join(directory, "readonly");
		const readonlyScript = saveScript(readonlyDir, [{ content: [tool("probe_write", { n: 1 }, "readonly-seed")] }, { text: "seed saved" }, { content: [tool("probe_commit", { chapter: 1 }, "readonly-commit")] }, { text: "write attempt complete" }]);
		const readonlyObservation = await withClient(readonlyDir, readonlyScript, async (client) => {
			await client.promptAndWait("Flush seed conversation");
			const file = String((await client.success({ type: "get_state" })).sessionFile);
			assert(path.resolve(file).startsWith(path.resolve(TEST_ROOT) + path.sep));
			const index = client.records.length;
			const pendingPrompt = client.promptAndWait("Commit while readonly", 10000);
			void pendingPrompt.catch(() => {});
			await client.waitFor((record) => record.type === "tool_execution_start" && record.toolCallId === "readonly-commit", index);
			const attribute = spawnSync("attrib", ["+R", file], { windowsHide: true, encoding: "utf8" });
			assert.equal(attribute.status, 0, attribute.stderr);
			const beforeBytes = readFileSync(file).byteLength;
			let completionError: string | null = null;
			let memoryCount: number | null = null;
			try {
				try { await pendingPrompt; } catch (error) { completionError = error instanceof Error ? error.message : String(error); }
				try { memoryCount = results((await entries(client)).current, "probe_commit").length; } catch { /* A persistence error may terminate the RPC process. */ }
				const persisted = readSession(file);
				const toolEndObserved = client.records.slice(index).some((record) => record.type === "tool_execution_end" && record.toolCallId === "readonly-commit");
				assert(toolEndObserved, "Readonly failure is injected after tool start and the tool-end event is observed");
				return { file, readonlyAppliedAfterToolStart: true, completionError, toolEndObserved, messageEndObserved: client.records.slice(index).some((record) => record.type === "message_end" && asRecord(record.message).toolCallId === "readonly-commit"), memoryCommitCount: memoryCount, fileCommitCount: results(persisted, "probe_commit").length, beforeBytes, afterBytes: readFileSync(file).byteLength, eventsObserved: client.records.slice(index).map((record) => ({ type: record.type, toolCallId: record.toolCallId })) };
			} finally { spawnSync("attrib", ["-R", file], { windowsHide: true, stdio: "ignore" }); }
		}, [], { PROBE_COMMIT_DELAY_MS: "1500" });

		const seedDir = path.join(directory, "seed");
		const seedScript = saveScript(seedDir, [{ content: [tool("probe_commit", { chapter: 1 }, "seed-commit")] }, { text: "complete seed" }]);
		const seedFile = await withClient(seedDir, seedScript, async (client) => {
			await client.promptAndWait("Create persistent seed");
			return String((await client.success({ type: "get_state" })).sessionFile);
		});
		const seedEntries = readSession(seedFile);
		assert.equal(results(seedEntries, "probe_commit").length, 1, "Previously completed commit survives close");
		const seedLines = readFileSync(seedFile, "utf8").split("\n").filter(Boolean);
		const commitLineIndex = seedLines.findIndex((line) => line.includes('"toolCallId":"seed-commit"') && line.includes('"role":"toolResult"'));
		assert(commitLineIndex >= 0);
		const truncatedDir = path.join(directory, "truncated");
		mkdirSync(truncatedDir, { recursive: true });
		const truncatedFile = path.join(truncatedDir, "truncated-session.jsonl");
		const partialCommitLine = seedLines[commitLineIndex].slice(0, Math.floor(seedLines[commitLineIndex].length / 2));
		safeWrite(truncatedFile, `${seedLines.slice(0, commitLineIndex).join("\n")}\n${partialCommitLine}`);
		const truncatedScript = saveScript(truncatedDir, [{ content: [tool("probe_write", { n: 77 }, "after-truncation")] }, { text: "continued after truncated tail" }]);
		const truncated = await withClient(truncatedDir, truncatedScript, async (client) => {
			await client.promptAndWait("Continue after broken final line");
			const view = await entries(client);
			assert(numbers(view.current).includes(77));
			const diskRaw = readFileSync(truncatedFile, "utf8");
			const parsed: JsonRecord[] = [];
			let invalidLines = 0;
			for (const line of diskRaw.split("\n").filter(Boolean)) { try { parsed.push(asRecord(JSON.parse(line))); } catch { invalidLines++; } }
			const ids = new Set(parsed.map((entry) => entry.id));
			const orphanIds = parsed.filter((entry) => entry.type !== "session" && entry.parentId && !ids.has(entry.parentId)).map((entry) => entry.id);
			assert.equal(orphanIds.length, 0, "New parent links point to valid entries");
			return { file: truncatedFile, invalidLinesAfterContinue: invalidLines, continued: true, orphanIds, currentNumbers: numbers(view.current) };
		}, ["--session", truncatedFile]);

		const concurrentDir = path.join(directory, "concurrent");
		mkdirSync(concurrentDir, { recursive: true });
		const concurrentFile = path.join(concurrentDir, "shared-session.jsonl");
		copyFileSync(seedFile, concurrentFile);
		const scriptA = saveScript(path.join(concurrentDir, "a"), [{ content: [tool("probe_write", { n: 81 }, "writer-a")] }, { text: "a done" }]);
		const scriptB = saveScript(path.join(concurrentDir, "b"), [{ content: [tool("probe_write", { n: 82 }, "writer-b")] }, { text: "b done" }]);
		const a = new ProbeRpcClient({ runDir: path.join(concurrentDir, "a"), scriptFile: scriptA, extraArgs: ["--session", concurrentFile] });
		const b = new ProbeRpcClient({ runDir: path.join(concurrentDir, "b"), scriptFile: scriptB, extraArgs: ["--session", concurrentFile] });
		let concurrent: JsonRecord;
		try {
			await Promise.all([a.ready(), b.ready()]);
			const outcomes = await Promise.allSettled([a.promptAndWait("writer A"), b.promptAndWait("writer B")]);
			const persisted = readSession(concurrentFile);
			concurrent = { file: concurrentFile, bothProcessesOpened: true, outcomes: outcomes.map((outcome) => outcome.status), savedNumbers: numbers(persisted) };
		} finally { await Promise.allSettled([a.close(), b.close()]); }
		const lockFile = path.join(concurrentDir, "writer.lock");
		const openLocked = (runDir: string, scriptFile: string) => {
			const fd = openSync(lockFile, "wx");
			let ownedClient: ProbeRpcClient;
			try {
				ownedClient = new ProbeRpcClient({ runDir, scriptFile, extraArgs: ["--session", concurrentFile] });
				writeFileSync(fd, JSON.stringify({ pid: ownedClient.process.pid, session: concurrentFile }));
			} catch (error) { closeSync(fd); unlinkSync(lockFile); throw error; }
			return { client: ownedClient, close: async () => { try { await ownedClient.close(); } finally { closeSync(fd); unlinkSync(lockFile); } } };
		};
		const firstLocked = openLocked(path.join(concurrentDir, "locked-a"), scriptA);
		let secondWriterRejected = false;
		try {
			await firstLocked.client.ready();
			try { const secondLocked = openLocked(path.join(concurrentDir, "locked-b"), scriptB); await secondLocked.close(); }
			catch (error) { secondWriterRejected = error instanceof Error && "code" in error && error.code === "EEXIST"; }
			assert(secondWriterRejected, "Exclusive lock rejects a second writer before spawning Pi");
		} finally { await firstLocked.close(); }
		return { status: "成立", killRepetitions: killed, readonly: readonlyObservation, committedReopen: { survived: true, file: seedFile }, truncated, concurrent, adapterLock: { secondWriterRejected, primitive: "fs.openSync(lockFile, 'wx')" }, persistenceRecommendation: "Only show committed after reading complete toolCallId from the session file; enforce single-writer adapter lock; on write failure terminate and reopen from file. No power-loss durability claim." };
	},
};

for (const id of (process.argv[2] ?? "V01").split(",")) {
	const check = checks[id];
	if (!check) throw new Error(`Unsupported verification: ${id}`);
	const directory = path.join(TEST_ROOT, "runs", id, new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"));
	mkdirSync(directory, { recursive: true });
	const started = new Date().toISOString();
	try {
		const result = await check(directory);
		const summary = { verification: id, ...result, directory, started, finished: new Date().toISOString() };
		safeWrite(path.join(directory, "result.json"), summary);
		console.log(JSON.stringify(summary));
	} catch (error) {
		const summary = { verification: id, status: "阻塞", error: error instanceof Error ? error.message : String(error), directory, started, finished: new Date().toISOString() };
		safeWrite(path.join(directory, "result.json"), summary);
		console.log(JSON.stringify(summary));
		process.exitCode = 1;
		break;
	}
}
