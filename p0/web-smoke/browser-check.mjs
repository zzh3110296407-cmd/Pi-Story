// Reproduce after prepare/build: node <D-test-root>/web-smoke/browser-check.mjs <V25-run-dir>
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const workspace = path.dirname(fileURLToPath(import.meta.url));
const testRoot = path.resolve("D:/开源/test/pi-Story/p0");
const runDir = path.resolve(process.argv[2] ?? "");
assert(runDir.startsWith(`${testRoot}${path.sep}`), "Evidence must stay inside the D-drive test root");
mkdirSync(runDir, { recursive: true });

function safeSave(file, value) {
	const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
	const key = process.env.DEEPSEEK_API_KEY;
	if ((key && text.includes(key)) || /\bsk-[A-Za-z0-9_-]{20,}/u.test(text)) {
		throw new Error("Secret detected: evidence was not saved");
	}
	writeFileSync(file, text);
}

const dist = path.join(workspace, "dist");
const mimeTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf" };
const server = createServer((request, response) => {
	try {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const filename = path.resolve(dist, `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`);
		if (!filename.startsWith(`${dist}${path.sep}`) || !existsSync(filename) || !statSync(filename).isFile()) {
			response.writeHead(404).end("Not found");
			return;
		}
		response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filename)] ?? "application/octet-stream" });
		response.end(readFileSync(filename));
	} catch {
		response.writeHead(400).end("Bad request");
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}`;

const candidates = [
	process.env.P0_BROWSER_EXECUTABLE,
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
].filter((candidate) => candidate && existsSync(candidate));

let context;
try {
	context = await chromium.launchPersistentContext(path.join(runDir, "browser-profile"), {
		headless: true,
		...(candidates[0] ? { executablePath: candidates[0] } : {}),
		viewport: { width: 1280, height: 900 },
	});
	const page = context.pages()[0] ?? await context.newPage();
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
	await page.getByRole("heading", { name: "第一章 雾灯下的归人", exact: true }).waitFor();
	const article = page.getByRole("article", { name: "中文样例章节" });
	const text = await article.innerText();
	assert(text.includes("林予没有立刻回答"), "Chinese chapter body rendered");
	assert(text.includes("原来，灯一直是给归人留的"), "Final chapter paragraph rendered");
	assert.equal(await article.locator("table").count(), 1, "GFM table rendered");
	assert.equal(await article.locator("blockquote").count(), 1, "Chinese quotation rendered");
	assert.equal(await article.locator("pre").count(), 1, "Code fence rendered");
	assert.equal(await article.locator("strong").count(), 1, "CJK strong emphasis rendered");
	assert.equal(pageErrors.length, 0, `Browser errors: ${pageErrors.join("; ")}`);
	const screenshot = path.join(runDir, "chapter-render.png");
	await page.screenshot({ path: screenshot, fullPage: true });
	const result = {
		ok: true, url: baseUrl, title: await page.title(), heading: "第一章 雾灯下的归人",
		textCharacters: text.length, paragraphs: await article.locator("p").count(),
		browser: context.browser()?.version(), executable: candidates[0] ?? "Playwright managed Chromium",
		pageErrors, screenshot, checkType: "real Chromium DOM assertions; screenshot requires separate visual review",
	};
	safeSave(path.join(runDir, "browser-result.json"), result);
	safeSave(path.join(runDir, "rendered-text.txt"), text);
	console.log(JSON.stringify(result));
} finally {
	await context?.close();
	await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
