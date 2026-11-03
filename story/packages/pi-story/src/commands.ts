import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { authorControl, authorGoal, type ControlChange, type GoalEntry, type StoryModel } from "@pi-story/core";
import { effectiveBudget } from "./ports.ts";
import type { StoryRuntime } from "./session.ts";

const kinds = ["global", "story", "given_fact", "continuation_start", "ambiguity"] as const;
type LedgerKind = (typeof kinds)[number];
const commandNames = ["intent", "focus", "ledger", "goal", "budget"] as const;
type Name = (typeof commandNames)[number];

function ledgerChange(text: string): ControlChange | undefined {
	const ledgerPatch: Extract<ControlChange, { field: "ledger_edit" }>["ledgerPatch"] = [];
	for (const line of text.split(/\r?\n/u).filter((line) => line.trim())) {
		const match = /^(add|set|remove)\s+(\S+)(?:\s+([\s\S]+))?$/u.exec(line.trim());
		if (!match) return;
		const [, op, key, value] = match;
		if (op === "add" && kinds.includes(key as LedgerKind) && value?.trim())
			ledgerPatch.push({ op: "set", kind: key as LedgerKind, text: value });
		else if (/^L-[1-9]\d*$/u.test(key) && op === "set" && value?.trim())
			ledgerPatch.push({ op: "set", id: key, text: value });
		else if (/^L-[1-9]\d*$/u.test(key) && op === "remove" && value === undefined)
			ledgerPatch.push({ op: "remove", id: key });
		else return;
	}
	return ledgerPatch.length ? { field: "ledger_edit", ledgerPatch } : undefined;
}
function budgetChange(text: string): GoalEntry["budget"] | undefined {
	const budget: NonNullable<GoalEntry["budget"]> = {};
	const seen = new Set<string>();
	for (const part of text.split(/\s+/u)) {
		const match = /^(tokens|usd|perChapterCalls)=(\d+(?:\.\d+)?)$/u.exec(part);
		if (!match || seen.has(match[1])) return;
		const [, key, raw] = match;
		seen.add(key);
		const value = Number(raw);
		if (
			!Number.isFinite(value) ||
			(key !== "usd" && !Number.isSafeInteger(value)) ||
			(key === "perChapterCalls" && value < 1)
		)
			return;
		if (key === "tokens") budget.tokens = value;
		else if (key === "usd") budget.costUsd = value;
		else budget.perChapterCalls = value;
	}
	return seen.size ? budget : undefined;
}
function prefill(name: Name, model: StoryModel, budget = model.policy.budget): string {
	if (name === "intent") return model.authorIntent;
	if (name === "focus") return model.currentFocus;
	if (name === "ledger") return model.ledger.map((item) => `set ${item.id} ${item.text}`).join("\n");
	if (name === "goal") return model.policy.targetChapter?.toString() ?? "off";
	return budget
		? Object.entries(budget)
				.map(([key, value]) => `${key === "costUsd" ? "usd" : key}=${value}`)
				.join(" ") || "off"
		: "off";
}
export function registerAuthorCommands(pi: ExtensionAPI, runtime: StoryRuntime): void {
	for (const name of commandNames)
		pi.registerCommand(name, {
			description: `作者控制：${name}（无参数打开当前内容）`,
			handler: async (args, ctx: ExtensionCommandContext) => {
				let model = runtime.get(ctx).source.model();
				if (!model.authorMessages.length) {
					ctx.ui.notify("DOMAIN_INVALID：先发出故事提示", "error");
					return;
				}
				let text = args.trim();
				if (!text) {
					if (!ctx.hasUI) {
						ctx.ui.notify("DOMAIN_INVALID：作者不在场，请在命令后提供参数", "error");
						return;
					}
					const edited = await ctx.ui.editor(
						`/${name}：编辑作者控制`,
						prefill(name, model, effectiveBudget(model, runtime.get(ctx).settings)),
					);
					if (edited === undefined) return;
					text = edited.trim();
				}
				// Another command can run while the editor is open. Read the authoritative
				// branch again so this command preserves its latest revision and policy.
				model = runtime.get(ctx).source.model();
				if (name === "intent" || name === "focus" || name === "ledger") {
					const change: ControlChange | undefined =
						name === "ledger"
							? ledgerChange(text)
							: { field: name === "intent" ? "author_intent" : "current_focus", text };
					if (!change) {
						ctx.ui.notify(
							"DOMAIN_INVALID：使用 add <kind> <文字>、set <L-n> <文字> 或 remove <L-n>，每行一条",
							"error",
						);
						return;
					}
					const result = authorControl(model, change);
					if (!result.ok) {
						ctx.ui.notify(result.receipt, "error");
						return;
					}
					pi.appendEntry("story.control", result.details);
					pi.sendMessage(
						{
							customType: "story.notice",
							content: `作者更新了${name === "intent" ? "作者意图" : name === "focus" ? "当前焦点" : "台账"}（rev ${result.details.rev}）。请读取最新控制层，按新要求继续并在提要中体现。`,
							display: false,
						},
						{ deliverAs: "steer" },
					);
					ctx.ui.notify(`/${name} 已更新（rev ${result.details.rev}）`, "info");
					return;
				}
				let change: Parameters<typeof authorGoal>[1];
				if (name === "goal") {
					if (text !== "off" && (!/^[1-9]\d*$/u.test(text) || !Number.isSafeInteger(Number(text)))) {
						ctx.ui.notify("DOMAIN_INVALID：目标为正整章数或 off", "error");
						return;
					}
					change = { targetChapter: text === "off" ? null : Number(text) };
				} else {
					const budget = text === "off" ? null : budgetChange(text);
					if (budget === undefined) {
						ctx.ui.notify("DOMAIN_INVALID：预算为 tokens=<整数> usd=<金额> perChapterCalls=<正整数> 或 off", "error");
						return;
					}
					change = { budget };
				}
				const state = runtime.get(ctx);
				const result = authorGoal(
					{ ...model, policy: { ...model.policy, budget: effectiveBudget(model, state.settings) } },
					change,
				);
				if (!result.ok) {
					ctx.ui.notify(result.receipt, "error");
					return;
				}
				pi.appendEntry("story.goal", result.details);
				if (name === "budget") state.stopReason = undefined;
				const current = runtime.get(ctx).source.model();
				const value = prefill(name, current);
				pi.sendMessage(
					{
						customType: "story.notice",
						content: `作者更新了${name === "goal" ? "写作目标" : "预算"}：${value}。当前已提交${current.lastChapter}章。以此最新设置为准，目标达成或预算耗尽后停止；off表示关闭该设置。`,
						display: false,
					},
					{ deliverAs: "steer" },
				);
				ctx.ui.notify(`/${name} 已更新：${value}`, "info");
			},
		});
}
