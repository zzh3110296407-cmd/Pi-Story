import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { copyModelSnapshot, runtimeEnvironment, settingsTemplate } from "../scripts/prepare-p2.mjs";

const work = process.env.PI_STORY_WORK_DIR;
assert(work, "PI_STORY_WORK_DIR must point to the P2 execution workspace");
mkdirSync(path.join(work, "temp"), { recursive: true });

test("P2 template isolates stories and pins the four role configurations", () => {
	const settings = settingsTemplate(work);
	assert.equal(settings.schema, "story/global-settings@1");
	assert.equal(settings.localRevision, true);
	assert.equal(settings.storiesDir, path.join(work, "stories"));
	assert.deepEqual(Object.keys(settings.roles), ["writer", "editor", "keeper", "verifier"]);
	assert.deepEqual(
		Object.values(settings.roles).map((role) => role.temperature),
		[0.9, 0.2, 0, 0],
	);
	for (const role of Object.values(settings.roles)) {
		assert.equal(role.model, "deepseek/deepseek-flash");
		assert.equal(role.thinking, "low");
	}
	assert.equal(settings.roles.writer.maxTokens, 32768);
	assert.equal(settings.roles.editor.maxTokens, 32768);
	assert.equal(settings.roles.keeper.maxTokens, 32768);
});

test("build environment does not forward model credentials or the author's Pi directory", () => {
	const env = runtimeEnvironment(work, {
		PATH: "path",
		DEEPSEEK_API_KEY: "not-forwarded",
		PI_CODING_AGENT_DIR: "author",
	});
	assert.equal(env.DEEPSEEK_API_KEY, undefined);
	assert.equal(env.PI_CODING_AGENT_DIR, path.join(work, "build-agent"));
	assert.equal(env.NPM_CONFIG_CACHE, path.join(work, "npm-cache"));
});

test("model snapshot copies only manifest-verified bytes", () => {
	const root = mkdtempSync(path.join(work, "temp/snapshot-"));
	const source = path.join(root, "source");
	const target = path.join(root, "target");
	mkdirSync(source);
	const bytes = Buffer.from('{"models":[]}\n');
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	writeFileSync(path.join(source, "deepseek.json"), bytes);
	writeFileSync(
		path.join(source, ".manifest.json"),
		JSON.stringify({ schemaVersion: 6, files: { "deepseek.json": sha256 } }),
	);
	const snapshot = copyModelSnapshot(source, target);
	assert.equal(snapshot.files["deepseek.json"], sha256);
	assert.deepEqual(readFileSync(path.join(target, "deepseek.json")), bytes);
	writeFileSync(path.join(source, "deepseek.json"), "changed");
	assert.throws(() => copyModelSnapshot(source, path.join(root, "invalid")), /snapshot hash mismatch/u);
	assert.equal(existsSync(path.join(root, "invalid")), false);
});
