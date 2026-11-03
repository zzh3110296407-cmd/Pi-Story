import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { assertFrozenTree } from "../scripts/check-upstream.mjs";

test("Pi boundary survives independent Git history and protects all four layers", async (t) => {
	const repo = path.resolve(import.meta.dirname, "../..");
	const root = path.join(repo, "story/testing/exec/upstream-guard");
	mkdirSync(root, { recursive: true });
	const fixture = mkdtempSync(path.join(root, "independent-"));
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "Guard fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.invalid",
		GIT_COMMITTER_NAME: "Guard fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.invalid",
	};
	const git = (args, input) => {
		const r = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
			cwd: fixture,
			env,
			input,
			encoding: "utf8",
			windowsHide: true,
		});
		assert.equal(r.status, 0, r.stderr);
		return r.stdout.trim();
	};
	git(["init", "--quiet"]);
	const baseline = [];
	for (const [file, text] of Object.entries({
		".gitattributes": "* text=auto eol=lf\n",
		".gitignore": "packages/*/dist/\n",
		"packages/ai/package.json": '{"name":"fixture"}\n',
		"tsconfig.json": "{}\n",
		"README.md": "upstream\n",
	})) {
		mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
		writeFileSync(path.join(fixture, file), text);
		baseline.push({ file, mode: "100644", oid: git(["hash-object", `--path=${file}`, "--stdin"], text) });
	}
	const folder = path.join(fixture, "story/scripts");
	mkdirSync(path.join(folder, "baselines"), { recursive: true });
	copyFileSync(path.join(repo, "story/scripts/check-upstream.mjs"), path.join(folder, "check-upstream.mjs"));
	copyFileSync(path.join(repo, "story/scripts/upstream-allowlist.json"), path.join(folder, "upstream-allowlist.json"));
	writeFileSync(
		path.join(folder, "baselines/pi.json"),
		JSON.stringify({
			schema: "story/git-tree-baseline@1",
			commit: "b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6",
			entries: baseline,
		}),
	);
	const paths = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
	git(["add", "--", ...paths]);
	const commit = () => {
		const tree = git(["write-tree"]);
		const oid = git(["commit-tree", tree], "fixture snapshot\n");
		writeFileSync(path.join(fixture, ".git/HEAD"), `${oid}\n`);
		return oid;
	};
	const initial = commit();
	const check = (code, layer, file = "packages/ai/package.json") => {
		const r = spawnSync(process.execPath, [path.join(folder, "check-upstream.mjs")], {
			cwd: fixture,
			encoding: "utf8",
			windowsHide: true,
		});
		assert.equal(r.status, code, `${r.stdout}\n${r.stderr}`);
		if (layer) assert(r.stderr.includes(`${layer}: ${file}`), r.stderr);
	};
	const protectedFile = path.join(fixture, "packages/ai/package.json");
	const original = readFileSync(protectedFile);
	const restore = () =>
		git(["restore", `--source=${initial}`, "--staged", "--worktree", "--", "packages/ai/package.json"]);
	t.diagnostic(fixture);
	await t.test("clean snapshot needs no Pi commit object", () => {
		assert.equal(
			spawnSync("git", ["cat-file", "-e", "b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6"], {
				cwd: fixture,
				windowsHide: true,
			}).status !== 0,
			true,
		);
		check(0);
	});
	await t.test("working-tree modification fails", () => {
		writeFileSync(protectedFile, "changed\n");
		try {
			check(1, "worktree");
		} finally {
			restore();
		}
	});
	await t.test("staged change hidden by restored worktree fails", () => {
		writeFileSync(protectedFile, "staged\n");
		git(["add", "--", "packages/ai/package.json"]);
		writeFileSync(protectedFile, original);
		try {
			check(1, "index");
		} finally {
			restore();
		}
	});
	await t.test("deletion fails", () => {
		unlinkSync(protectedFile);
		try {
			check(1, "worktree");
		} finally {
			restore();
		}
	});
	await t.test("untracked upstream source fails", () => {
		const extra = path.join(fixture, "packages/ai/new.ts");
		writeFileSync(extra, "export {};\n");
		try {
			check(1, "untracked", "packages/ai/new.ts");
		} finally {
			unlinkSync(extra);
		}
	});
	await t.test("project files and ignored builds remain allowed", () => {
		writeFileSync(path.join(fixture, "story/new.txt"), "owned\n");
		mkdirSync(path.join(fixture, "packages/ai/dist"), { recursive: true });
		writeFileSync(path.join(fixture, "packages/ai/dist/out.js"), "generated\n");
		check(0);
	});
	await t.test("protected root configuration fails", () => {
		const file = path.join(fixture, "tsconfig.json");
		writeFileSync(file, "changed\n");
		try {
			check(1, "worktree", "tsconfig.json");
		} finally {
			git(["restore", `--source=${initial}`, "--worktree", "--", "tsconfig.json"]);
		}
	});
	await t.test("project README can change", () => {
		writeFileSync(path.join(fixture, "README.md"), "Project README\n");
		try {
			check(0);
		} finally {
			git(["restore", `--source=${initial}`, "--worktree", "--", "README.md"]);
		}
	});
	await t.test("new root path outside allowlist fails", () => {
		const file = path.join(fixture, "unexpected.ts");
		writeFileSync(file, "export {};\n");
		try {
			check(1, "untracked", "unexpected.ts");
		} finally {
			unlinkSync(file);
		}
	});
	await t.test("committed change hidden by clean working bytes fails", () => {
		writeFileSync(protectedFile, "committed\n");
		git(["add", "--", "packages/ai/package.json"]);
		commit();
		writeFileSync(protectedFile, original);
		check(1, "HEAD");
		assert.equal(git(["for-each-ref", "refs/heads/"]), "");
	});
});

test("frozen dataset files survive history replacement but reject changed and extra committed files", () => {
	const repo = path.resolve(import.meta.dirname, "../..");
	const root = path.join(repo, "story/testing/exec/upstream-guard");
	mkdirSync(root, { recursive: true });
	const fixture = mkdtempSync(path.join(root, "data-"));
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "Data fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.invalid",
		GIT_COMMITTER_NAME: "Data fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.invalid",
	};
	const git = (args, input) => {
		const r = spawnSync("git", args, { cwd: fixture, env, input, encoding: "utf8", windowsHide: true });
		assert.equal(r.status, 0, r.stderr);
		return r.stdout.trim();
	};
	git(["init", "--quiet"]);
	const prefix = "story/testing/datasets/example/v1";
	const file = `${prefix}/input.json`;
	mkdirSync(path.join(fixture, prefix), { recursive: true });
	writeFileSync(path.join(fixture, file), "{}\n");
	git(["add", "--", file]);
	const save = () => {
		const oid = git(["commit-tree", git(["write-tree"])], "data snapshot\n");
		writeFileSync(path.join(fixture, ".git/HEAD"), `${oid}\n`);
	};
	save();
	const baseline = path.join(fixture, "frozen.json");
	writeFileSync(
		baseline,
		JSON.stringify({
			schema: "story/git-tree-baseline@1",
			commit: "b".repeat(40),
			prefixes: [prefix],
			entries: [{ file, mode: "100644", oid: git(["hash-object", file]) }],
		}),
	);
	assert.equal(assertFrozenTree(fixture, baseline), "b".repeat(40));
	writeFileSync(path.join(fixture, file), "changed\n");
	git(["add", "--", file]);
	save();
	assert.throws(() => assertFrozenTree(fixture, baseline), /differ/);
	writeFileSync(path.join(fixture, file), "{}\n");
	const extra = `${prefix}/extra.json`;
	writeFileSync(path.join(fixture, extra), "{}\n");
	git(["add", "--", file, extra]);
	save();
	assert.throws(() => assertFrozenTree(fixture, baseline), /differ/);
});
