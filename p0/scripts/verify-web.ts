// Reproduce from project root: node p0/scripts/verify-web.ts all
// Modes: prepare (no install/build/browser), build, browser, all. Artifacts only under D:/开源/test/pi-Story/p0.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { checkSecret, PROJECT_ROOT, safeWrite, TEST_ROOT } from "../rpc/client.ts";

const DSH_ROOT = "D:/AI/DeepSeek Harness/deepseek-harness";
const DSH_COMMIT = "0a53fb55bea101816fa226bb964ae2bed71c343b";
const runtime = path.join(TEST_ROOT, "web-smoke");
const source = path.join(PROJECT_ROOT, "p0/web-smoke");
const mode = process.argv[2] ?? "all";
assert(["prepare", "build", "browser", "all"].includes(mode), "Unknown V25 mode");
const runDir = process.argv[3] ? path.resolve(process.argv[3]) : path.join(TEST_ROOT, "runs/V25", new Date().toISOString().replace(/[:.]/g, "-"));
assert(path.resolve(runDir).startsWith(`${path.resolve(TEST_ROOT)}${path.sep}`), "Evidence must stay in test root");
mkdirSync(runDir, { recursive: true });
mkdirSync(runtime, { recursive: true });
mkdirSync(path.join(TEST_ROOT, "temp"), { recursive: true });
const environment = {
	...process.env,
	TEMP: path.join(TEST_ROOT, "temp"), TMP: path.join(TEST_ROOT, "temp"), TMPDIR: path.join(TEST_ROOT, "temp"),
	NPM_CONFIG_CACHE: path.join(TEST_ROOT, "cache/npm"), PLAYWRIGHT_BROWSERS_PATH: path.join(TEST_ROOT, "browsers"),
	XDG_CACHE_HOME: path.join(TEST_ROOT, "cache"),
};

const chapter = `# 第一章 雾灯下的归人

暮色落下时，林予走到了旧码头。江面上的雾把船和岸分开，只有一盏灯还在仓库门口亮着。她已经离开这座小城七年，记忆里的石阶比眼前宽，风却和从前一样冷。

她从口袋里摸出一枚铜钥匙。钥匙齿间沾着细小的白盐，是母亲寄来的信里夹着的。信上只有一句话：回来时，别走有钟的那条街。

## 没有钟声的街道

林予沿着河堤绕路。河对岸的钟楼被灰布遮住，原本应该在六点响起的钟声没有传来。卖热粥的摊子还在，木牌上的字重新描过，摊主却换成了一个不认识的少年。

“找谁？”少年问。他把盛粥的勺子停在半空，目光落到她手里的钥匙上。

林予没有立刻回答。她先问起码头的灯，少年说那盏灯每天准时点亮，至于是谁点的，他从来没有见过。天色越暗，灯照出的那块空地反而越显得安静。

> “灯亮的时候，可以等；灯灭的时候，就不要回头。”

少年像背诵一句很旧的话，声音低了下去。林予想追问，河里忽然传来缆绳绷紧的声响。一艘没有鸣笛的小船从雾中靠岸，船头站着穿深蓝雨衣的老人。

## 门后的回信

老人没有叫她的名字，只指了指仓库。林予沿着灯光走过去，在门边看见一行刻得很浅的字。她俯身擦掉潮湿的灰，认出那是姐姐的笔迹：**别把等待当作失约**。

她把钥匙插进锁孔，却没有转动。七年前姐姐失踪的那个晚上，这把钥匙还挂在家中厨房的墙上。现在它为什么会和一封没有落款的信一起回来？

| 物件 | 林予已经确认的线索 |
| --- | --- |
| 铜钥匙 | 来自母亲寄出的信 |
| 仓库门 | 留着姐姐的字迹 |
| 雾灯 | 每日亮起，点灯者不明 |

她想起母亲教她记事的方法：先记住看见的，再写下猜测的。她在随身的小本子上划了两道线，把姐姐、钥匙和灯分别列下。纸页被风翻动，最后停在一张空白页上。

\`\`\`text
已见：门上有姐姐的字。
未知：是谁每天点亮雾灯。
\`\`\`

门从里面轻轻响了一下。林予退后半步，听见有人把一封信推过门缝。信封没有封口，里面是她七年前写给姐姐、却从未寄出的那一封。

她终于转动了钥匙。锁舌退开的声音很轻，仿佛有人在门后长长地松了一口气。灯光越过她的肩膀，照见地上一双摆得整齐的旧鞋。

原来，灯一直是给归人留的。
`;

function filesUnder(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(directory, entry.name);
		return entry.isDirectory() ? filesUnder(full) : [full];
	});
}

function copyText(from: string, to: string): void {
	const contents = readFileSync(from, "utf8");
	checkSecret(contents);
	mkdirSync(path.dirname(to), { recursive: true });
	copyFileSync(from, to);
}

function command(label: string, executable: string, args: string[], cwd: string): void {
	const startedAt = new Date().toISOString();
	const result = spawnSync(executable, args, { cwd, env: environment, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
	safeWrite(path.join(runDir, `${label}.log`), `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
	safeWrite(path.join(runDir, `${label}.json`), { executable, args, cwd, startedAt, endedAt: new Date().toISOString(), exitCode: result.status, error: result.error?.message });
	assert.equal(result.status, 0, `${label} failed; see ${path.join(runDir, `${label}.log`)}`);
}

function prepare(): void {
	const git = spawnSync("git", ["-C", DSH_ROOT, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
	assert.equal(git.status, 0, "Read DSH fixed revision");
	assert.equal(git.stdout.trim(), DSH_COMMIT, "DSH source revision matches plan");
	for (const file of ["package.json", "index.html", "main.tsx", "style.css", "vite.config.ts", "browser-check.mjs"]) {
		copyText(path.join(source, file), path.join(runtime, file));
	}
	safeWrite(path.join(runtime, "chapter.md"), chapter);
	const primitiveRoot = path.join(DSH_ROOT, "packages/client/ui-primitives");
	const selected = [...filesUnder(path.join(primitiveRoot, "src/markdown")), path.join(primitiveRoot, "src/clipboard.ts")];
	for (const file of selected) {
		const relative = path.relative(primitiveRoot, file);
		const contents = readFileSync(file, "utf8");
		assert(!/from\s+["']@deepseek-ai\//u.test(contents), `Unexpected DSH runtime import: ${relative}`);
		copyText(file, path.join(runtime, "vendor/ui-primitives", relative));
	}
	copyText(path.join(DSH_ROOT, "LICENSE"), path.join(runtime, "vendor/ui-primitives/LICENSE"));
	const metrics = ["ui-primitives", "ui-layout", "ui-sidebar", "ui-theme"].map((name) => {
		const folder = path.join(DSH_ROOT, "packages/client", name, "src");
		const allFiles = filesUnder(folder);
		const contents = allFiles.map((file) => readFileSync(file, "utf8"));
		const importLines = contents.flatMap((text) => text.split(/\r?\n/u).filter((line) => line.includes("@deepseek-ai/")));
		return { name, files: allFiles.length, lines: contents.reduce((sum, text) => sum + text.trimEnd().split(/\r?\n/u).length, 0), externalDshImportLines: importLines };
	});
	const inventory = {
		dshCommit: DSH_COMMIT, dshRoot: DSH_ROOT,
		selectedFiles: selected.map((file) => path.relative(primitiveRoot, file)),
		excluded: "Package manifest and standalone src/invariant.ts require Cordis; imported Markdown closure does not.",
		dependencyPins: JSON.parse(readFileSync(path.join(runtime, "package.json"), "utf8")),
		pinSource: "DSH pnpm-lock.yaml at fixed revision", metrics,
		migrationEstimate: {
			basis: "Static source estimate for one engineer familiar with React and Pi RPC; excludes full product UI.",
			layout: "1–2 days: retain columns.ts and CSS; replace slot/store/session props with local React state.",
			sidebar: "1–2 days: retain tree/grouping visuals; replace workspace/session APIs with story and branch projections.",
			theme: "0.5–1 day: retain token CSS and DOM-free theme runtime; replace Cordis/settings bootstrap.",
		},
	};
	safeWrite(path.join(runDir, "dependency-inventory.json"), inventory);
}

try {
	if (mode !== "browser") prepare();
	if (mode === "build" || mode === "all") {
		const npmCli = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
		assert(existsSync(npmCli), "Node installation includes npm CLI");
		command("install", process.execPath, [npmCli, "install", "--ignore-scripts", "--no-audit", "--no-fund"], runtime);
		command("build", process.execPath, [path.join(runtime, "node_modules/vite/bin/vite.js"), "build"], runtime);
	}
	if (mode === "browser" || mode === "all") {
		command("browser", process.execPath, [path.join(runtime, "browser-check.mjs"), runDir], runtime);
	}
	safeWrite(path.join(runDir, "result.json"), {
		verification: "V25", mode, status: mode === "all" ? "不成立·已用替代" : "未执行", runtime, runDir,
		componentStrategy: { original: "Entire ui-primitives package includes a Cordis peer and invariant companion", replacement: "Only the Markdown source closure and clipboard helper, with MIT license preserved", inventory: path.join(runDir, "dependency-inventory.json") },
		completed: mode === "prepare" ? ["source copy", "dependency inventory"] : mode === "build" ? ["source copy", "dependency install", "Vite build"] : mode === "browser" ? ["real browser DOM assertions"] : ["Vite build", "real browser DOM assertions"],
		visualReview: "Screenshot is saved; visual review is recorded separately.",
	});
	console.log(JSON.stringify({ verification: "V25", mode, runDir, runtime, ok: true }));
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	safeWrite(path.join(runDir, "result.json"), { verification: "V25", mode, status: "阻塞", runtime, runDir, error: message });
	console.error(message);
	process.exitCode = 1;
}
