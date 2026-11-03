import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { patchOutline, updateBible } from "@pi-story/core";
import { Type } from "typebox";
import { schemas } from "../../core/src/schema/index.ts";
import type { StoryRuntime } from "./session.ts";
import { bibleItem } from "./tools.ts";

const text = Type.String({ minLength: 1, pattern: "\\S" });
export function registerPlanningTools(pi: ExtensionAPI, runtime: StoryRuntime): void {
	const commonChange = {
		key: bibleItem.properties.key,
		name: Type.Optional(bibleItem.properties.name),
		source: bibleItem.properties.source,
		authorQuote: bibleItem.properties.authorQuote,
		op: Type.Union([Type.Literal("set"), Type.Literal("remove")]),
	};
	const otherKinds = ["place", "rule", "conflictLine", "frameworkChoice", "relationBaseline"] as const;
	pi.registerTool({
		name: "update_bible",
		label: "补充未来设定",
		description:
			"仅向后补充圣经，必须带reason；从下一章生效。changes使用value对象（人物卡片如voice、limits，其他种类为属性对象），不是开书的description字段。已写章后只能添加新字段或新键，不能改写已有值或删除已用条目；作者来源须有逐字authorQuote。",
		promptSnippet: "带理由补充未来设定，不改已写内容。",
		executionMode: "sequential",
		parameters: Type.Object(
			{
				changes: Type.Array(
					Type.Union([
						Type.Object(
							{
								...commonChange,
								kind: Type.Literal("character"),
								value: schemas.BibleDetails.properties.changes.items.properties.card,
							},
							{ additionalProperties: false },
						),
						Type.Object(
							{
								...commonChange,
								kind: Type.Union(otherKinds.map((kind) => Type.Literal(kind))),
								value: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
							},
							{ additionalProperties: false },
						),
					]),
					{ minItems: 1 },
				),
				reason: text,
			},
			{ additionalProperties: false },
		),
		execute: (id, params, signal, _onUpdate, ctx) =>
			runtime.write("update_bible", id, ctx, signal, (command) => updateBible(command, params)),
	});
	pi.registerTool({
		name: "patch_outline",
		label: "修改未写大纲",
		description:
			"只能修改未提交章节，必须带reason。使用chapters数组的purpose/turn字段（不是开书points）；可带完整narration。删除中间章时同批重排后续未写章，章号仍从1连续。已写章节需分支，当前阶段不能重写。",
		promptSnippet: "带理由修改未写章的大纲。",
		executionMode: "sequential",
		parameters: Type.Object(
			{
				narration: Type.Optional(
					Type.Object({ viewpoint: text, tone: text, format: Type.Optional(text) }, { additionalProperties: false }),
				),
				chapters: Type.Array(
					Type.Object(
						{
							n: Type.Integer({ minimum: 1 }),
							title: Type.Optional(text),
							targetWords: Type.Optional(Type.Integer({ minimum: 1 })),
							purpose: Type.Optional(text),
							turn: Type.Optional(text),
							hookSeeds: Type.Optional(Type.Array(text)),
							remove: Type.Optional(Type.Literal(true)),
						},
						{ additionalProperties: false },
					),
					{ minItems: 1 },
				),
				reason: text,
			},
			{ additionalProperties: false },
		),
		execute: (id, params, signal, _onUpdate, ctx) =>
			runtime.write("patch_outline", id, ctx, signal, (command) => patchOutline(command, params)),
	});
	pi.registerTool({
		name: "ask_author",
		label: "询问作者",
		description:
			"仅在两种以上合理理解会影响结果时询问作者。有options时选择框，否则输入框。作者不在场或取消回答时暂停自动继续；回答写入作者会话。",
		promptSnippet: "必要歧义时询问作者，未回答则暂停。",
		executionMode: "sequential",
		parameters: Type.Object(
			{ question: text, options: Type.Optional(Type.Array(text, { minItems: 1 })) },
			{ additionalProperties: false },
		),
		execute: async (_id, params, signal, _onUpdate, ctx) => {
			const state = runtime.get(ctx);
			state.waitingForAuthor = true;
			state.stopReason = "ask_author";
			const received =
				!ctx.hasUI || signal?.aborted
					? undefined
					: params.options
						? await ctx.ui.select(params.question, params.options, { signal })
						: await ctx.ui.input(params.question, undefined, { signal });
			const answer = signal?.aborted ? undefined : received;
			const status = answer === undefined ? (ctx.hasUI ? "unanswered" : "absent") : "answered";
			if (answer !== undefined && !signal?.aborted) {
				state.waitingForAuthor = false;
				state.stopReason = undefined;
				pi.sendUserMessage(answer, { deliverAs: "steer" });
			}
			return {
				content: [
					{
						type: "text",
						text:
							answer !== undefined
								? `作者回答：${answer}`
								: ctx.hasUI
									? "作者未回答，自动继续已暂停，请向作者说明问题。"
									: "作者不在场，自动继续已暂停，请向作者说明问题。",
					},
				],
				details: { schema: "story/read@1", data: { question: params.question, status, answer: answer ?? null } },
			};
		},
	});
}
