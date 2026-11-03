// Reproduce through node p0/scripts/verify-bridge.ts V21 or V28.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const runDir = path.resolve(process.argv[2] ?? "");
const item = process.argv[3];
assert(runDir.startsWith(`${path.resolve("D:/开源/test/pi-Story/p0")}${path.sep}`));
const origin = process.env.P0_BRIDGE_ORIGIN;
const cookie = process.env.P0_BRIDGE_COOKIE;
assert(origin && cookie);
const [cookieName, cookieValue] = cookie.split("=");
const candidates = [process.env.P0_BROWSER_EXECUTABLE, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"].filter((candidate) => candidate && existsSync(candidate));
mkdirSync(runDir, { recursive: true });
const context = await chromium.launchPersistentContext(path.join(runDir, "browser-profile"), { headless: true, ...(candidates[0] ? { executablePath: candidates[0] } : {}), viewport: { width: 1200, height: 900 } });
try {
	await context.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Strict" }]);
	const page = context.pages()[0] ?? await context.newPage();
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto(origin);
	await page.getByText("已连接", { exact: true }).waitFor();
	await page.getByRole("button", { name: "新建故事", exact: true }).click();
	await page.getByRole("button", { name: "打开 浏览器故事", exact: true }).waitFor();
	if (item === "V21") {
		await page.getByRole("textbox", { name: "消息", exact: true }).fill("/probe-intent");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await page.getByRole("dialog").waitFor();
		await page.getByRole("textbox", { name: "作者回复", exact: true }).fill("由网页作者填写的意图");
		await page.getByRole("button", { name: "保存回复", exact: true }).click();
		await page.getByText("Probe intent saved", { exact: true }).waitFor();
	} else {
		await page.getByRole("textbox", { name: "消息", exact: true }).fill("写一章并显示预览");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await page.getByText("这是尚未提交的中文草稿预览。", { exact: true }).waitFor();
		assert.equal(await page.locator("#draft-label").innerText(), "未提交");
		await page.locator('#commit-state[data-saved="true"]').waitFor();
		assert.equal(await page.locator("#commit-state").innerText(), "第 1 章已提交");
	}
	assert.equal(pageErrors.length, 0, `Browser errors: ${pageErrors.join("; ")}`);
	const screenshot = path.join(runDir, "bridge-browser.png");
	await page.screenshot({ path: screenshot, fullPage: true });
	const result = { ok: true, item, browser: context.browser()?.version(), pageErrors, screenshot, visualReview: "Pending separate screenshot inspection" };
	const serialized = JSON.stringify(result, null, 2);
	const key = process.env.DEEPSEEK_API_KEY;
	if ((key && serialized.includes(key)) || /\bsk-[A-Za-z0-9_-]{20,}/u.test(serialized)) throw new Error("Secret detected: browser result discarded");
	writeFileSync(path.join(runDir, "bridge-browser-result.json"), serialized);
	console.log(JSON.stringify(result));
} finally {
	await context.close();
}
