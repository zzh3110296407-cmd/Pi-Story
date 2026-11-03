import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const repository = path.resolve(import.meta.dirname, "../../..");
export function testingPaths(env = process.env) {
	const testRoot = path.resolve(env.PI_STORY_TEST_ROOT ?? path.join(repository, "story/testing"));
	return {
		testRoot,
		runsRoot: path.resolve(env.PI_STORY_RUNS_DIR ?? path.join(testRoot, "runs")),
		workDir: path.resolve(env.PI_STORY_WORK_DIR ?? path.join(repository, "story/testing/exec")),
	};
}

export function inside(folder, target) {
	const relative = path.relative(path.resolve(folder), path.resolve(target));
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function hasSourceChanges(root = repository) {
	const result = spawnSync(
		"git",
		["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", ":(exclude)story/testing/runs"],
		{ cwd: root, encoding: "utf8", windowsHide: true },
	);
	if (result.status !== 0) throw new Error("Git working-tree evidence unavailable");
	return result.stdout.length > 0;
}

export function sourceEvidence(root = repository, env = process.env) {
	const git = (cwd, ...args) => {
		const result = spawnSync("git", ["--no-optional-locks", "-C", cwd, ...args], {
			encoding: "utf8",
			windowsHide: true,
		});
		if (result.status !== 0) throw new Error("Git source evidence unavailable");
		return result.stdout.trim();
	};
	if (existsSync(path.join(root, ".git"))) {
		if (env.PI_STORY_ARCHIVE_COMMIT) throw new Error("Archive provenance cannot override a Git checkout");
		return { commit: git(root, "rev-parse", "HEAD"), dirty: hasSourceChanges(root), archive: false };
	}
	const commit = env.PI_STORY_ARCHIVE_COMMIT;
	const source = env.PI_STORY_GIT_SOURCE;
	if (!commit || !/^[a-f0-9]{40}$/u.test(commit) || !source || path.resolve(source) === path.resolve(root))
		throw new Error("Archive requires an explicit commit and read-only Git object source");
	if (git(source, "cat-file", "-t", commit) !== "commit") throw new Error("Archive commit object missing");
	return { commit, dirty: false, archive: true };
}
