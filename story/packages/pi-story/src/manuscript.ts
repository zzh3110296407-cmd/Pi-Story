import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type StoryModel, toManuscript } from "@pi-story/core";

export async function writeManuscript(
	model: StoryModel,
	storiesDir: string,
	storyId: string,
	name?: string,
): Promise<string> {
	if (!/^[A-Za-z0-9_-]+$/u.test(storyId)) throw new Error("Invalid session story ID");
	const folder = path.join(storiesDir, "manuscripts");
	await mkdir(folder, { recursive: true });
	const target = path.join(folder, `${storyId}.md`);
	await writeFile(target, toManuscript(model, { name, includeDraft: false }), "utf8");
	return target;
}
