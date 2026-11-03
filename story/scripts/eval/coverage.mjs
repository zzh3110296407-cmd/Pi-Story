import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repository } from "./paths.mjs";

const groups = { C: 5, R: 2, B: 6, O: 2, T: 3, W: 6, E: 7, D: 11, X: 4, U: 6 };
const exemptions = {
	C5: { reason: "作者修改后的插话通知由Pi适配层实现", phase: "P3" },
	R2: { reason: "模型/预算/档位的适配层生效时机", phase: "P3" },
	X1: { reason: "状态更正属于v1.1", phase: "P10" },
	X2: { reason: "状态更正属于v1.1", phase: "P10" },
	X3: { reason: "状态更正属于v1.1", phase: "P10" },
	X4: { reason: "状态更正属于v1.1", phase: "P10" },
	U5: { reason: "主笔请求预算由Pi适配层实现", phase: "P3" },
	U6: { reason: "自动压缩预算由Pi适配层实现", phase: "P3" },
};
const partial = {
	W2: "整章写作新谱系仍须测试；v1.2独立工具的重写理由到P11复核",
	E3: "P1覆盖标准流程；任意顺序的草稿/审稿组合到P11复核",
	E6: "P1覆盖标准流程和三类拒绝；任意顺序组合到P11复核",
	D5: "P1只测机械边界；记录员对计划/假设/梦境的语义识别到P2",
};
const rules = [
	...Object.entries(groups).flatMap(([prefix, count]) =>
		Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`),
	),
	"HOOK",
	"BATCH",
	...Array.from({ length: 9 }, (_, index) => `A.${index + 1}`),
];
function files(folder) {
	if (!existsSync(folder)) return [];
	return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? files(path.join(folder, entry.name))
			: /\.test\.(?:ts|mjs)$/u.test(entry.name)
				? [path.join(folder, entry.name)]
				: [],
	);
}
function identifiers(name) {
	const result = new Set();
	for (const match of name.matchAll(/\b([CBORTWEDXU])([0-9]+)\s*[-–—]\s*(?:\1)?([0-9]+)\b/gu))
		for (let index = Number(match[2]); index <= Number(match[3]); index++) result.add(`${match[1]}${index}`);
	for (const match of name.matchAll(/\b(?:[CBORTWEDXU][0-9]+|A\.?[1-9])\b/gu))
		result.add(match[0].startsWith("A") ? `A.${match[0].replace(/\D/gu, "")}` : match[0]);
	if (/HOOK|伏笔迁移/u.test(name)) result.add("HOOK");
	if (/BATCH|批内提交|A\.?6\b/u.test(name)) result.add("BATCH");
	return result;
}
export function generateCoverage(
	root = repository,
	output = "D:/AI/Story Dome/新版综合方案/测试结果/P1/规则覆盖表.md",
) {
	const references = new Map(rules.map((rule) => [rule, []]));
	for (const file of [...files(path.join(root, "story/packages/core/test")), ...files(path.join(root, "story/test"))]) {
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(/\b(?:test|it|describe)\s*\(\s*["'`]([^"'`\r\n]+)["'`]/gu)) {
			const line = source.slice(0, match.index).split("\n").length;
			for (const rule of identifiers(match[1]))
				references.get(rule)?.push({ file: path.relative(root, file).replaceAll(path.sep, "/"), line, name: match[1] });
		}
	}
	const entries = rules.map((rule) => ({
		rule,
		tests: references.get(rule),
		exemption: exemptions[rule] ?? null,
		note: partial[rule] ?? "",
		covered: references.get(rule).length > 0 || rule in exemptions,
	}));
	const result = {
		total: entries.length,
		covered: entries.filter((entry) => entry.covered).length,
		missing: entries.filter((entry) => !entry.covered).map((entry) => entry.rule),
		exemptions: entries.filter((entry) => entry.exemption).map((entry) => ({ rule: entry.rule, ...entry.exemption })),
		entries,
	};
	if (output) {
		mkdirSync(path.dirname(output), { recursive: true });
		const rows = entries.map(
			(entry) =>
				`| ${entry.rule} | ${entry.covered ? (entry.tests.length ? "有测试引用，运行状态另验" : "书面豁免") : "缺失，待补"} | ${entry.tests.map((item) => `${item.file}:${item.line} — ${item.name.replaceAll("|", "\\|")}`).join("<br>") || "—"} | ${entry.exemption ? `${entry.exemption.reason}（${entry.exemption.phase}）` : entry.note || "—"} |`,
		);
		writeFileSync(
			output,
			`# P1 规则覆盖表\n\n依据17 §2；仅静态提取测试/describe名称中的规则编号，不证明测试已运行或行为正确。动态生成的测试须在名称或describe中保留规则编号。\n\n覆盖引用及书面豁免：${result.covered}/${result.total}。缺口：${result.missing.join("、") || "无"}。正式数据集交付后的H02/H07等运行结果另行验收。\n\n| 规则 | 状态 | 测试引用 | 豁免或范围说明 |\n|---|---|---|---|\n${rows.join("\n")}\n`,
		);
	}
	return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const result = generateCoverage();
	console.log(`Rule references: ${result.covered}/${result.total}; missing: ${result.missing.join(", ") || "none"}`);
}
