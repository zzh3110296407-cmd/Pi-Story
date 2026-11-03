import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { type BranchEntry, type FoldCache, foldBranch, stateAt } from "../src/fold/index.ts";
import { createDraft } from "../src/production/index.ts";
import { readStory, toBranchList, toExport, toManuscript, toStoryView } from "../src/projections/index.ts";
import { digest } from "../src/shared/text.ts";
import { context } from "./context.ts";
import { commitRecord, delta, tool } from "./fixtures.ts";
import { loadDataset, record } from "./support/datasets.ts";

const fixture = loadDataset<{ entries: BranchEntry[] }>("DS03-state-deltas", "context.json", "v2").data;
test("C4 A.9 historical state, provisional separation, persisted anchors and export snapshots", () => {
	const model = foldBranch(fixture.entries);
	const ctx = context(fixture.entries),
		drafted = createDraft(ctx, { chapter: 2, text: "尚未提交的秘密草稿。" });
	if (!drafted.ok) throw new Error("fixture");
	const workspace = foldBranch([...fixture.entries, tool("draft-only", "write_draft", drafted.details)]);
	expect(toManuscript(workspace)).toContain("未提交");
	for (const format of ["md", "txt", "json"] as const) {
		const files = toExport(workspace, format, { name: "测试故事" });
		expect(files.map((f) => f.content).join()).not.toContain("尚未提交的秘密草稿");
		const manifest = JSON.parse(files.find((f) => f.name === "manifest.json")?.content ?? "{}");
		for (const file of files.filter((f) => f.name !== "manifest.json"))
			expect(manifest.files).toContainEqual({ name: file.name, digest: digest(file.content) });
	}
	const current = readStory(model, { kind: "state" });
	expect(current.ok).toBe(true);
	expect(current.details?.data).toMatchObject({
		asOfChapter: 1,
		未确认: expect.arrayContaining([expect.objectContaining({ id: "F-3" }), expect.objectContaining({ id: "K-1" })]),
	});
	expect(readStory(model, { kind: "state", asOfChapter: 0 }).details?.data).toMatchObject({ facts: [] });
	expect(readStory(model, { kind: "state", asOfChapter: 2 }).ok).toBe(false);
	expect(readStory(model, { kind: "character", key: "char:lin_yao", asOfChapter: 1 }).ok).toBe(true);
	expect(readStory(model, { kind: "character", key: "char:missing" }).ok).toBe(false);
	expect(readStory(model, { kind: "chapter", n: 1, numbering: "sentences" }).details?.text).toContain("c01.s0001");
	expect(readStory(model, { kind: "chapter", n: 2 }).ok).toBe(false);
	for (const section of ["control", "bible", "plan", "observations", "decisions", "hooks"] as const)
		expect(readStory(model, { section }).ok).toBe(true);
	const view = toStoryView(model, undefined, { persisted: new Set([model.commitEntries[1]]) });
	expect(view.chapters[0]).toMatchObject({ n: 1, anchorEntryId: model.commitEntries[1], persisted: true });
	expect(JSON.stringify(view)).not.toContain(model.commits[0].text);
	expect(toStoryView(model).chapters[0].persisted).toBe(false);
	const tree = [
		{ entryId: "root", parentId: null },
		{ entryId: "left", parentId: "root", current: true },
		{ entryId: "right", parentId: "root" },
	];
	expect(toBranchList(tree, () => model)).toEqual([
		{ leafId: "left", current: true, lastChapter: 1, forkedBeforeChapter: 2, updatedAt: "" },
		{ leafId: "right", current: false, lastChapter: 1, forkedBeforeChapter: 2, updatedAt: "" },
	]);
	const snapshot = () => [
		foldBranch(fixture.entries),
		toStoryView(model),
		toManuscript(workspace),
		toExport(workspace, "json"),
		toBranchList(tree, () => model),
		readStory(model, { kind: "state" }),
	];
	const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const a = hash(snapshot()),
		b = hash(snapshot());
	record("determinism", { id: "projection-snapshots", hash1: a, hash2: b });
	expect(a).toBe(b);
});
test("H03 H14 fixed-seed 50 chapter full/incremental fold retains 40 states per chapter", () => {
	let seed = 20261028;
	const next = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed;
	};
	const entries: BranchEntry[] = [];
	for (let chapter = 1; chapter <= 50; chapter++) {
		const changes = delta(chapter),
			commit = commitRecord(chapter, changes);
		commit.text = "旅人沿着河岸走向远方看见灯火照亮夜色。".repeat(150).slice(0, 3000);
		commit.draftDigest = digest(commit.text);
		for (let j = 0; j < 40; j++)
			changes.factOps.upsert.push({
				id: `F-${(chapter - 1) * 40 + j + 1}`,
				subject: `item:seed_${next()}`,
				predicate: "color",
				object: "蓝",
				validFrom: chapter,
				validUntil: null,
				mode: "narrated",
				status: "confirmed",
				visibility: "public",
				evidence: [`c${String(chapter).padStart(2, "0")}.s0001`],
				sourceChapter: chapter,
			});
		entries.push(
			tool(`commit-${chapter}`, "commit_chapter", { schema: "story/commit-result@1", ok: true, commit, calls: [] }),
		);
	}
	const fullMs: number[] = [],
		incrementalMs: number[] = [];
	for (let i = 0; i < 5; i++) {
		let start = performance.now();
		const full = foldBranch(entries);
		fullMs.push(performance.now() - start);
		expect(full.lastChapter).toBe(50);
		expect(stateAt(full).facts).toHaveLength(2000);
		const cache: FoldCache = {};
		foldBranch(entries.slice(0, -1), cache);
		start = performance.now();
		const incremental = foldBranch(entries, cache);
		incrementalMs.push(performance.now() - start);
		expect(incremental).toEqual(full);
	}
	const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
	const a = hash(foldBranch(entries)),
		b = hash(foldBranch(entries));
	record("determinism", { id: "50-chapter-fold", hash1: a, hash2: b });
	expect(a).toBe(b);
	record("performance", {
		seed: 20261028,
		chapters: 50,
		charsPerChapter: 3000,
		statesPerChapter: 40,
		fullMs,
		incrementalMs,
	});
	expect([...fullMs].sort((a, b) => a - b)[2]).toBeLessThanOrEqual(1000);
});
