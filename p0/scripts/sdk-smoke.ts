// Reproduce with PROBE_RUN_DIR and PROBE_SCRIPT set: node p0/scripts/sdk-smoke.ts
import assert from "node:assert/strict";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { asRecord, PROJECT_ROOT, safeWrite, TEST_ROOT } from "../rpc/client.ts";

const directory = process.env.PROBE_RUN_DIR;
assert(directory, "PROBE_RUN_DIR required");
const agentDir = path.join(TEST_ROOT, "agent-home");
const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "sdk-auth.json"), modelsPath: path.join(agentDir, "sdk-models.json") });
const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const resources = new DefaultResourceLoader({ cwd: directory, agentDir, settingsManager: settings,
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	additionalExtensionPaths: [path.join(PROJECT_ROOT, "p0/ext/probe")],
});
await resources.reload();
const manager = SessionManager.create(directory, path.join(directory, "sessions"));
const { session } = await createAgentSession({ cwd: directory, agentDir, resourceLoader: resources, modelRuntime: runtime,
	settingsManager: settings, sessionManager: manager, noTools: "builtin", thinkingLevel: "off" });
try {
	await session.bindExtensions({ mode: "print", onError: (event) => { throw new Error(event.error); } });
	const model = runtime.getModel("probe-faux", "script");
	assert(model, "Probe model registered by SDK extension");
	await session.setModel(model);
	await session.prompt("Ask author in SDK without UI");
	const result = session.messages.findLast((message) => message.role === "toolResult" && message.toolName === "probe_ask");
	assert(result && result.role === "toolResult");
	const details = asRecord(result.details);
	assert.equal(details.hasUI, false);
	assert(String(details.answer).includes("作者不在场"));
	safeWrite(path.join(directory, "sdk-result.json"), { status: "成立", details, sessionFile: manager.getSessionFile() });
	console.log(JSON.stringify({ status: "成立", sessionFile: manager.getSessionFile(), unavailableAuthor: true }));
} finally { session.dispose(); }
