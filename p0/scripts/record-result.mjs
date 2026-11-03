// Reproduce: node p0/scripts/record-result.mjs V01 <result.json> [status] [note]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../../", import.meta.url));
const docs = resolve(project, "docs/p0");
mkdirSync(docs, { recursive: true });
const recordFile = resolve(docs, "results.json");
const records = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, "utf8")) : {};
const [id, evidence, status, note] = process.argv.slice(2);
if (id) {
	if (!/^V(?:0[1-9]|1[0-9]|2[0-8])$/.test(id)) throw new Error("Invalid verification ID");
	const result = JSON.parse(readFileSync(evidence, "utf8"));
	records[id] = { status: status ?? result.status, evidence: resolve(evidence), note: note ?? result.error ?? "详见原始结果与协议记录" };
}
const names = ["构建与启动", "工具隔离", "重开与分支折叠", "顺序写入可见性", "章节标签", "工具结果锚点续写", "持久化故障与单写者", "中断识别", "大条目", "提示分段与缓存", "上下文编辑", "自动继续与停止", "作者独占与编辑框", "运行中控制命令", "无界面模式", "内部模型用量", "工具用量统计", "主笔预算挂点", "结构化输出", "主笔模型", "桥接往返", "对话框长等待", "运行状态转发", "条目读取接口", "网页组件", "即时插话", "输入估算", "文件确认与草稿预览"];
const rows = names.map((name, index) => {
	const key = `V${String(index + 1).padStart(2, "0")}`;
	const value = records[key];
	return `| ${key} | ${name} | ${value?.status ?? "未执行"} | ${value ? value.note.replaceAll("|", "/").replaceAll("\n", " ") : "按执行顺序推进"} |`;
});
const methods = {
	V01: "固定克隆构建；打印和RPC各运行含probe_write的一轮，核对扩展加载与实际会话文件。",
	V02: "列举命令与请求工具清单，逐个请求内置read/bash/write/edit/codemode，确认均不执行。",
	V03: "写入探针及作者控制条目，退出重开并比较实际fold，再分支续写比较新旧父链。",
	V04: "同一批依次写1、写2、读取，比较每次开始时可见的条目和执行顺序。",
	V05: "提交后同批读取，turn_end打标签，再由get_tree核对标签目标。",
	V06: "写三章后回到第一章工具结果锚点，分别用替身和一次真实模型检查无摘要续写。",
	V07: "20次强杀、只读文件、事件与磁盘对比、截断尾行、双进程写入及wx锁反例。",
	V08: "慢工具执行中强杀，重开检查中断审计与后续上下文、再完成一轮。",
	V09: "依次保存100KiB、1/5/20MiB条目，实际重开和RPC读取并记录耗时与内存。",
	V10: "替身和真实模型各验证三轮提示分段，实际压缩后继续，核对缓存、规则与Skill目录。",
	V11: "turn_end写context_edit，直接检查下一轮实际请求中的替换内容。",
	V12: "目标三章自动继续，并分别触发等待作者、预算取消、abort；预算断言核对真实派发计数。",
	V13: "模型伪造修改工具被拒；作者带参及无参编辑框两种命令写入控制条目。",
	V14: "慢工具中分别发送普通steer与作者命令，对比处理响应、控制条目和结果落点。",
	V15: "同一探针在打印、JSON和真实SDK构造路径执行；检查无UI时ask的降级。",
	V16: "工具内真实调用一次，另在相同调用路径模拟缺失usage，比较原始usage与missing判定。",
	V17: "复用V16会话与调用证据，对比Pi会话统计和主笔、工具用量，没有新增付费请求。",
	V18: "对照请求钩子throw和ctx.abort，分别记录实际fetch、HTTP状态与停止原因。",
	V19: "三种输出方式各三章各十次，按schema与句号证据校验；保留先导、修复和上限对照全部数据。",
	V20: "两个模型各五次，固定状态及两条train提示，实测读取、三个事实答案、单次预制提交和停止。",
	V21: "真实HTTP/WS调用Pi并运行Edge网页；校验鉴权和来源，测两个独立进程与两次切换。",
	V22: "真实编辑框保留至少600000ms，期间检查未超时，回答后直接核对文件中的作者控制条目。",
	V23: "触发setStatus(story,working)，在RPC及WebSocket中核对原字段和值。",
	V24: "get_entries全量和since增量读取，比较details、自定义条目及leafId，检查非法游标。",
	V25: "固定参考提交复制Markdown源码闭包及MIT许可，在D盘独立安装构建、浏览器渲染并统计移植依赖。",
	V26: "慢工具中分别发送RPC steer与followUp，核对input来源、插话序号和INTERJECTED。",
	V27: "20段500至20000字符的英语、中文及混合输入逐次真实调用，比较估算和实际总输入Token。",
	V28: "正常提交由文件toolCallId确认后通知网页；再设只读重现内存假成功，验证报错、终止与文件重开。",
};
const details = Object.entries(records).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
	const commands = [];
	if (["V06", "V10", "V16", "V17", "V18", "V19", "V20", "V27"].includes(key)) commands.push(`$env:P0_REAL_APPROVED='${key}'; node p0/scripts/verify-model.ts ${key}`);
	if (["V21", "V22", "V23", "V28"].includes(key)) commands.push(`node p0/scripts/verify-bridge.ts ${key}`);
	else if (key === "V25") commands.push("node p0/scripts/verify-web.ts all");
	else if (!["V16", "V17", "V18", "V19", "V20", "V27"].includes(key)) commands.unshift(`node p0/scripts/verify-offline.ts ${key}`);
	const manual = ["V01", "V26"].includes(key) ? "自动部分完成；交互终端人工观察待作者执行。" : ["V21", "V25", "V28"].includes(key) ? "真实浏览器DOM断言与截图视觉检查分别记录于证据目录。" : "自动断言或真实API观测；未将人工观察计为通过。";
	return `## ${key}\n\n做法：${methods[key]}\n\n结论与数据摘要：${value.status}。${value.note}\n\n复现（项目根目录，先完成S0；付费项需要环境中的密钥与预算）：\n\n\`\`\`powershell\n${commands.join("\n")}\n\`\`\`\n\n证据：\`${value.evidence}\`。同目录保留启动参数、协议和原始输出；历史失败与重做未删除。\n\n检查方式：${manual}\n`;
}).join("\n");
const report = `# P0 底座验证报告\n\n日期：2026-10-28。状态：执行中；未完成项不计为通过。\n\n固定 Pi 提交：\`b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6\`。探针代码在当前仓库 \`p0\`；所有运行证据、fixtures、缓存和会话在 \`D:\\开源\\test\\pi-Story\\p0\`。没有修改 Pi 运行时源码。\n\n## 准备与检查\n\n- 现有仓库沿用 main，不重新初始化、不创建分支、不推送。每项完成后按计划本地提交。\n- 固定提交的 detached 克隆安装和构建成功。普通 build 刷新在线目录导致旧测试型号消失；复制参考仓库已水合模型目录后，离线构建与完整 npm run check 通过。模型目录43个JSON文件及SHA-256保存在 runs/S0/model-data-snapshot.json。\n- 构建、安装和完整检查日志在测试根 runs/S0；npm 11.6.1 对上游 min-release-age 配置有兼容性警告，未修改上游配置。P0 独立 TypeScript 检查使用 p0/tsconfig.json。\n- 原 Pi MIT 全文保留在 LICENSE.pi；根 LICENSE 与新增探针按计划采用 AGPL-3.0，第三方归属见 THIRD_PARTY_NOTICES。\n\n## 结论总表\n\n| 编号 | 验证项 | 结论 | 说明 |\n|---|---|---|---|\n${rows.join("\n")}\n\n${details}\n## 人工项与完成边界\n\n交互终端中的 V01、V26 按对应结果的完整命令由作者操作；打印、RPC、SDK 的自动结果不能替代终端人工观察。真实模型验证以样本数、原始用量及 usage-ledger.jsonl 为准。\n\n阶段完成后汇总 ADR-001 至 ADR-011、设计差异和花费。尚未有证据的部分仍为未执行。\n`;
const ledgerFile = "D:/开源/test/pi-Story/p0/runs/usage-ledger.jsonl";
const ledger = existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const costRows = [...new Set(ledger.map((row) => row.item))].sort().map((item) => {
	const calls = ledger.filter((row) => row.item === item);
	const cancelled = calls.filter((row) => row.networkAttempts === 0);
	const sent = calls.filter((row) => row.networkAttempts !== 0);
	const known = sent.filter((row) => row.usage !== null && row.usage !== undefined);
	const unknown = sent.filter((row) => row.usage === null || row.usage === undefined);
	const reported = known.reduce((sum, row) => sum + row.usage.cost.total, 0);
	const reserved = unknown.reduce((sum, row) => sum + (row.estimatedCostUsd ?? row.reservedCostUsd), 0);
	const input = known.reduce((sum, row) => sum + row.usage.input, 0);
	const output = known.reduce((sum, row) => sum + row.usage.output, 0);
	const cacheRead = known.reduce((sum, row) => sum + row.usage.cacheRead, 0);
	const cacheWrite = known.reduce((sum, row) => sum + row.usage.cacheWrite, 0);
	return { item, sent: sent.length, cancelled: cancelled.length, known: reported, unknown: unknown.length, reserved, total: reported + reserved, input, output, cacheRead, cacheWrite };
});
const fees = `## 花费口径\n\n以下按固定模型目录价格估算，金额包含未报告用量请求的保守预留，不是供应方账单。API400无用量也计预留；发出前已明确取消的请求单列。夹具重做、先导和修复均在总账内。\n\n| 项目 | 网络请求数 | 已知用量估算美元 | 未报告用量次数 | 保守预留美元 | 合计估算美元 |\n|---|---:|---:|---:|---:|---:|\n${costRows.map((row) => `| ${row.item} | ${row.sent} | ${row.known.toFixed(9)} | ${row.unknown} | ${row.reserved.toFixed(9)} | ${row.total.toFixed(9)} |`).join("\n")}\n\n总计估算：${costRows.reduce((sum, row) => sum + row.total, 0).toFixed(9)}美元。明确发出前取消：${costRows.reduce((sum, row) => sum + row.cancelled, 0)}次。原始台账：\`${ledgerFile}\`。\n\n`;
const tokens = `### 已报告的 Token\n\n下表只汇总供应方已报告的用量，input 不含另外列出的缓存读写；缺失用量请求没有补零，费用仍按上表预留。reasoning 已包含在供应方 output 中，不重复相加。\n\n| 项目 | 非缓存输入 | 输出 | 缓存读 | 缓存写 |\n|---|---:|---:|---:|---:|\n${costRows.map((row) => `| ${row.item} | ${row.input} | ${row.output} | ${row.cacheRead} | ${row.cacheWrite} |`).join("\n")}\n\n`;
const complete = names.every((_name, index) => ["成立", "不成立·已用替代"].includes(records[`V${String(index + 1).padStart(2, "0")}`]?.status));
let finalReport = report.replace("## 人工项与完成边界", `${fees}${tokens}## 人工项与完成边界`);
if (complete) {
	const alternatives = Object.values(records).filter((record) => record.status === "不成立·已用替代").length;
	finalReport = finalReport.replace("状态：执行中；未完成项不计为通过。", `状态：28项自动验证均有结论（${28 - alternatives}项成立、${alternatives}项采用已实测替代），无阻塞；V01/V26终端人工观察仍待作者完成。`);
	finalReport = finalReport.replace("阶段完成后汇总 ADR-001 至 ADR-011、设计差异和花费。尚未有证据的部分仍为未执行。", "ADR-001至ADR-011和design-deltas.md记录选择与限制。P0的自动验证退出条件已满足，终端人工项单独保留；未开始P1业务实现。\n\n```powershell\npwsh -File \"D:\\AI\\Story Dome\\pi-Story\\p0\\scripts\\manual-check.ps1\" -CheckId V01\npwsh -File \"D:\\AI\\Story Dome\\pi-Story\\p0\\scripts\\manual-check.ps1\" -CheckId V26\n```\n\nV01：输入一句话，观察probe_write成功及隔离目录中的会话文件。V26：启动probe_slow后再输入一句话，观察INTERJECTED；检查命令打印的证据目录events.jsonl中的input来源与streamingBehavior。两条命令使用替身模型，不产生模型费用。");
	const scanFile = "D:/开源/test/pi-Story/p0/runs/S0/secret-scan.json";
	const scan = existsSync(scanFile) ? JSON.parse(readFileSync(scanFile, "utf8")) : undefined;
	const scanSummary = scan ? `扫描时间${scan.finished}，检查${scan.files}个文件、${scan.bytes}字节；发现${scan.findings.length}项，固定基线模式匹配${scan.inheritedPatterns.length}项。环境密钥原文检测可用：${scan.environmentKeyPresent}。完整排除范围见原始报告；Git内部、依赖、缓存、浏览器资料、符号链接和.env文件未读取。后续新增探针日志与本报告仍经保存前密钥检查。` : "扫描报告缺失，密钥扫描收尾尚未完成。";
	finalReport += `\n## 收尾检查与作者审阅\n\n固定克隆完整npm run check与P0独立tsc通过，未修改Pi运行时源码。npm对上游min-release-age配置的兼容警告，以及V25的大chunk警告，均原样记录，没有改阈值掩盖。构建和浏览器实测只覆盖本报告列明的固定版本与样本。\n\n密钥扫描：${scanSummary} 原始报告：\`${scanFile}\`。\n\n需要作者审阅的后续设计取舍（本阶段未改原方案）：\n\n- 持久化承诺收窄为文件可读确认，保留单写者；不承诺任意强杀或掉电耐久。首次普通消息前的控制命令也须定义保存回执（ADR-002/010）。\n- 结构化输出采用JSON、8192输出上限及最多一次具体错误修复；三章样本上的30/30不代表语义质量保证（ADR-008）。\n- 主笔候选优先Flash；两个模型各五次工具编排通过，不作为文学质量比较（ADR-009）。\n- 网页只取Markdown闭包，其余布局、侧栏与主题按清单改接故事接口，并评估加载成本（ADR-011）。\n- P1/P4仍须实现正式业务校验、作者控制与提交的共同串行边界，以及宏中断计量；P0探针不能代替这些实现（ADR-006/007）。\n`;
}
for (const text of [JSON.stringify(records), finalReport]) {
	const secret = process.env.DEEPSEEK_API_KEY;
	if ((secret && text.includes(secret)) || /sk-[A-Za-z0-9_-]{20,}/.test(text)) throw new Error("Secret detected: report not saved");
}
writeFileSync(recordFile, `${JSON.stringify(records, null, 2)}\n`);
writeFileSync(resolve(docs, "verification-report.md"), finalReport);
console.log(JSON.stringify({ id, report: resolve(docs, "verification-report.md"), count: Object.keys(records).length }));
