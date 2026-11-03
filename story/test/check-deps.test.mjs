import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { inspectDependencies } from "../scripts/check-deps.mjs";

const root = path.join(process.env.PI_STORY_WORK_DIR ?? "D:/开源/test/pi-Story/p1", "dependency-guard");
mkdirSync(root, { recursive: true });
const cases = [
	["core", "export type { TSchema } from 'typebox'; import type { Static } from 'typebox';", true],
	["core", "import './shared/safe.ts';", true],
	["core", "const x = import(name);", false],
	["core", "", false, { "@earendil-works/pi-ai": "1.2.0" }],
	["core", "", false, { fs: "1.0.0" }],
	["runner", "export * from '../../core/src/index.ts';", true],
	["web", "export * from '../../../packages/core/src/index.ts';", false],
	["core", "import { Type } from 'typebox'; import { createHash } from 'node:crypto';", true],
	["core", "// import x from 'node:fs'\nconst text = \"import x from 'node:fs'\";", true],
	["core", "import fs from 'node:fs';", false],
	["core", "import cp from 'child_process';", false],
	["core", "export * from '@earendil-works/pi-ai';", false],
	["core", "import x from '@pi-story/runner';", false],
	["core", "import x from 'zod';", false],
	["core", "const x = import('typebox');", false],
	["core", "type X = import('typebox').TSchema;", false],
	["core", "const x = require('node:fs');", false],
	["core", "import x from '../../../apps/web/src/index.ts';", false],
	["core", "import x from '../test/fixture.ts';", false],
	[
		"runner",
		"import x from '@pi-story/core'; import y from '@pi-story/pi-story'; import z from '@earendil-works/pi-ai';",
		true,
	],
	["runner", "import x from '@pi-story/evals';", false],
	["pi-story", "import x from '@pi-story/runner';", false],
	["bridge", "import x from '@pi-story/pi-story';", false],
	["bridge", "import x from '@pi-story/core'; import y from '@earendil-works/pi-coding-agent';", true],
	["evals", "import x from '@pi-story/runner';", true],
	["evals", "import x from '@earendil-works/pi-ai';", false],
	["web", "import x from 'react';", true],
	["web", "import x from '@pi-story/core';", false],
	["web", "import x from '@earendil-works/chord';", false],
	["web", "import x from 'node:crypto';", false],
	["web", "import x from 'pi-alias';", false, { "pi-alias": "npm:@earendil-works/pi-ai@1.2.0" }],
];

for (const [owner, content, allowed, dependencies = {}] of cases) {
	test(`${owner}: ${allowed ? "allow" : "reject"} ${content}`, () => {
		const fixture = mkdtempSync(path.join(root, "case-"));
		for (const name of ["core", "pi-story", "runner", "evals", "bridge", "web"]) {
			const folder = path.join(fixture, ["bridge", "web"].includes(name) ? "apps" : "packages", name);
			mkdirSync(path.join(folder, "src"), { recursive: true });
			writeFileSync(
				path.join(folder, "package.json"),
				JSON.stringify({ name: `@pi-story/${name}`, dependencies: name === owner ? dependencies : {} }),
			);
		}
		const area = ["bridge", "web"].includes(owner) ? "apps" : "packages";
		writeFileSync(path.join(fixture, area, owner, "src/index.ts"), content);
		const result = inspectDependencies(fixture);
		assert.equal(result.length === 0, allowed, JSON.stringify(result));
	});
}

test("template literals terminate, ignore literal text and inspect interpolation code", () => {
	const checker = pathToFileURL(path.resolve(import.meta.dirname, "../scripts/check-deps.mjs")).href;
	for (const [content, allowed] of [
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal source is the scanner's input.
		['const a = `# ${name ?? "未命名故事"}`; const b = `## 第 ${chapter} 章 ${title}\\n\\n${text}`;', true],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal source is the scanner's input.
		["const text = `${chapter} 章 import x from 'node:fs'`;", true],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal source is the scanner's input.
		["const text = `${({ value: `${chapter} 章` }).value} 正文`;", true],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal source is the scanner's input.
		["const text = `${import('node:fs')} 章`;", false],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal source is the scanner's input.
		["const text = `${chapter} 章`; import fs from 'node:fs';", false],
	]) {
		const fixture = mkdtempSync(path.join(root, "template-"));
		const source = path.join(fixture, "packages/core/src");
		mkdirSync(source, { recursive: true });
		writeFileSync(path.join(source, "../package.json"), JSON.stringify({ name: "@pi-story/core" }));
		writeFileSync(path.join(source, "index.ts"), content);
		const probe = path.join(fixture, "probe.mjs");
		writeFileSync(
			probe,
			`import { inspectDependencies } from ${JSON.stringify(checker)};\nconsole.log(JSON.stringify(inspectDependencies(process.argv[2])));\n`,
		);
		const result = spawnSync(process.execPath, [probe, fixture], {
			encoding: "utf8",
			windowsHide: true,
			timeout: 3000,
			maxBuffer: 1024 * 1024,
		});
		assert.equal(result.status, 0, `Scanner must terminate: ${content}; ${result.error?.code ?? result.stderr}`);
		assert.equal(JSON.parse(result.stdout).length === 0, allowed, result.stdout);
	}
});
