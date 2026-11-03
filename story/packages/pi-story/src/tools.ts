import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { submitBible, submitConstraints, submitOutline, writeNextChapter } from "@pi-story/core";
import { Type } from "typebox";
import type { StoryRuntime } from "./session.ts";

const text = Type.String({ minLength: 1 });
const strings = Type.Array(text);
const source = {
	key: Type.String({
		maxLength: 120,
		pattern: "^(?:(?:char|place|rule|line|fw):[a-z0-9_]+|rel:[a-z0-9_]+->[a-z0-9_]+)$",
		description:
			"按kind使用char:ada、place:harbor、rule:survival、line:escape、fw:voice；关系必须为rel:ada->bo，不能用单个关系名。slug只含小写字母、数字、下划线，不用连字符。每批key唯一。",
	}),
	name: Type.String({ minLength: 1, maxLength: 80 }),
	source: Type.Union([Type.Literal("user"), Type.Literal("model")]),
	authorQuote: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 8192,
			description: "source=user时必须逐字复制当前分支作者消息中的连续原话，保留标点；不得转述或改写。",
		}),
	),
};
export const bibleItem = Type.Object(
	{
		...source,
		kind: Type.Union([
			Type.Literal("character"),
			Type.Literal("place"),
			Type.Literal("rule"),
			Type.Literal("conflictLine"),
			Type.Literal("frameworkChoice"),
			Type.Literal("relationBaseline"),
		]),
		description: Type.String({
			minLength: 1,
			maxLength: 800,
			description: "用简短自然语言保留必要设定，不嵌套value对象。整条含AI扩写时source=model。",
		}),
		invariants: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 240 }))),
	},
	{
		additionalProperties: false,
	},
);
export function registerOpeningTools(pi: ExtensionAPI, runtime: StoryRuntime): void {
	pi.registerTool({
		name: "submit_constraints",
		label: "提交台账",
		description:
			"开书第一步。逐项提交作者要求及至少一段逐字原话；原话必须出现在当前分支的作者消息中。仅提交初始台账，不能追加或改写。错误时修正所列字段再试。",
		promptSnippet: "开书提交附作者原话的台账。",
		executionMode: "sequential",
		parameters: Type.Object(
			{
				op: Type.Literal("submit"),
				items: Type.Array(
					Type.Object(
						{
							kind: Type.Union([
								Type.Literal("global"),
								Type.Literal("story"),
								Type.Literal("given_fact"),
								Type.Literal("continuation_start"),
								Type.Literal("ambiguity"),
							]),
							text,
							quotes: Type.Array(text, { minItems: 1 }),
						},
						{ additionalProperties: false },
					),
				),
			},
			{ additionalProperties: false },
		),
		execute: (id, params, signal, _onUpdate, ctx) =>
			runtime.write("submit_constraints", id, ctx, signal, async (commandCtx) => {
				const result = await submitConstraints(commandCtx, params);
				return result.ok ? { ...result, receipt: `台账已记录${result.details.items.length}条，请建立圣经。` } : result;
			}),
	});
	pi.registerTool({
		name: "submit_bible",
		label: "建立圣经",
		description:
			"开书第二步。每项用扁平description（最多800字符）；所有kind均可另附invariants短字符串数组，保留不变事实或限制，不传value对象。只有整条内容全部出自作者才标source=user并附逐字原话，含AI扩写则标model。一次提交全部设定，成功后继续submit_outline。kind/key对应character/char、place/place、rule/rule、conflictLine/line、frameworkChoice/fw，关系用rel:a->b。",
		promptSnippet: "开书建立带来源的故事圣经。",
		executionMode: "sequential",
		parameters: Type.Object({ items: Type.Array(bibleItem) }, { additionalProperties: false }),
		execute: (id, params, signal, _onUpdate, ctx) =>
			runtime.write("submit_bible", id, ctx, signal, async (commandCtx) => {
				const result = await submitBible(commandCtx, {
					items: params.items.map(({ description, invariants, ...item }) => ({
						...item,
						value: {
							...(item.kind === "character"
								? { identity: description }
								: item.kind === "relationBaseline"
									? { stance: description }
									: { description }),
							...(invariants ? { invariants } : {}),
						},
					})),
				});
				return result.ok
					? {
							...result,
							receipt: `圣经已建立，共${result.details.changes.length}项。初始设定提交已完成；下一步调用submit_outline。`,
						}
					: commandCtx.model.bibleRev && result.error.code === "DOMAIN_INVALID"
						? {
								...result,
								error: {
									...result.error,
									message: "初始圣经已建立，不能重复提交",
									hint: '本阶段不能追加或重交初始圣经；先调用read_story(section:"bible")确认已有设定，再继续submit_outline或写下一章',
								},
							}
						: result;
			}),
	});
	pi.registerTool({
		name: "submit_outline",
		label: "提交大纲",
		description:
			"开书第三步。根字段viewpoint、tone、可选format、chapters；不嵌套narration。每章给n、title、targetWords、points短字符串数组（2至5条，每条最多320字符）：第一条推进目标，后续为变化与明确停点。连续章号从1开始。完整JSON只闭合一次根对象。",
		promptSnippet: "开书提交含每章目标和停点的大纲。",
		executionMode: "sequential",
		parameters: Type.Object(
			{
				viewpoint: Type.String({ minLength: 1, maxLength: 240 }),
				tone: Type.String({ minLength: 1, maxLength: 240 }),
				format: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
				chapters: Type.Array(
					Type.Object(
						{
							n: Type.Integer({ minimum: 1 }),
							title: Type.String({ minLength: 1, maxLength: 100 }),
							targetWords: Type.Integer({ minimum: 1 }),
							points: Type.Array(Type.String({ minLength: 1, maxLength: 320 }), { minItems: 2, maxItems: 5 }),
							hookSeeds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 240 }))),
						},
						{ additionalProperties: false },
					),
					{ minItems: 1 },
				),
			},
			{ additionalProperties: false },
		),
		execute: (id, params, signal, _onUpdate, ctx) =>
			runtime.write("submit_outline", id, ctx, signal, async (commandCtx) => {
				const result = await submitOutline(commandCtx, {
					narration: {
						viewpoint: params.viewpoint,
						tone: params.tone,
						...(params.format ? { format: params.format } : {}),
					},
					chapters: params.chapters.map(({ points, ...chapter }) => ({
						...chapter,
						purpose: points[0],
						turn: points.slice(1).join("; "),
					})),
				});
				return result.ok
					? { ...result, receipt: `大纲已提交，共${result.details.chapters.length}章，可以调用write_next_chapter。` }
					: result;
			}),
	});
}

export function registerReadTools(pi: ExtensionAPI, runtime: StoryRuntime): void {
	pi.registerTool({
		name: "read_story",
		label: "读取故事资料",
		description:
			"读取control、bible、plan、observations、decisions或hooks。不会改写资料或正史。计划和未确认条目不等于已发生事实。",
		promptSnippet: "读取台账、圣经、计划、观察、决策或伏笔。",
		annotations: { readOnlyHint: true },
		parameters: Type.Object(
			{
				section: Type.Union([
					Type.Literal("control"),
					Type.Literal("bible"),
					Type.Literal("plan"),
					Type.Literal("observations"),
					Type.Literal("decisions"),
					Type.Literal("hooks"),
				]),
				chapter: Type.Optional(Type.Integer({ minimum: 1 })),
				keys: Type.Optional(strings),
			},
			{ additionalProperties: false },
		),
		execute: async (_id, params, _signal, _onUpdate, ctx) => runtime.read("read_story", ctx, params),
	});
	pi.registerTool({
		name: "read_chapter",
		label: "读取已提交章节",
		description: "按章号读取当前分支已提交正文，默认带行号，可选句号。不能读取其他分支或修改正文。",
		promptSnippet: "读取已提交正文与行号或句号。",
		annotations: { readOnlyHint: true },
		parameters: Type.Object(
			{
				n: Type.Integer({ minimum: 1 }),
				numbering: Type.Optional(Type.Union([Type.Literal("lines"), Type.Literal("sentences")])),
			},
			{ additionalProperties: false },
		),
		execute: async (_id, params, _signal, _onUpdate, ctx) =>
			runtime.read("read_chapter", ctx, { kind: "chapter", ...params }),
	});
	pi.registerTool({
		name: "read_state",
		label: "读取故事状态",
		description:
			"读取某章结束时的状态，默认最后提交章。未确认条目单列；filter可按主体、类型过滤。读取不生成或确认事实。",
		promptSnippet: "读取指定章的已确认与未确认状态。",
		annotations: { readOnlyHint: true },
		parameters: Type.Object(
			{
				asOfChapter: Type.Optional(Type.Integer({ minimum: 0 })),
				filter: Type.Optional(
					Type.Object(
						{
							subjects: Type.Optional(strings),
							kinds: Type.Optional(
								Type.Array(
									Type.Union([
										Type.Literal("fact"),
										Type.Literal("claim"),
										Type.Literal("cognition"),
										Type.Literal("relation"),
										Type.Literal("hook"),
									]),
								),
							),
							includeProvisional: Type.Optional(Type.Boolean()),
						},
						{ additionalProperties: false },
					),
				),
			},
			{ additionalProperties: false },
		),
		execute: async (_id, params, _signal, _onUpdate, ctx) =>
			runtime.read("read_state", ctx, { kind: "state", ...params }),
	});
	pi.registerTool({
		name: "get_character",
		label: "读取人物",
		description: "以char:键读取人物卡片及相关事实、认知和关系；可回看指定章，未确认条目单列。",
		promptSnippet: "读取人物卡片和相关状态。",
		annotations: { readOnlyHint: true },
		parameters: Type.Object(
			{ key: text, asOfChapter: Type.Optional(Type.Integer({ minimum: 0 })) },
			{ additionalProperties: false },
		),
		execute: async (_id, params, _signal, _onUpdate, ctx) =>
			runtime.read("get_character", ctx, { kind: "character", ...params }),
	});
}

export function registerMacroTool(pi: ExtensionAPI, runtime: StoryRuntime): void {
	pi.registerTool({
		name: "write_next_chapter",
		label: "写作并提交下一章",
		description:
			"标准单章流程：写手起草、程序检查、编辑审稿、符合条件的局部修订与复查、记录员结算后提交。章号固定为下一章。需要已提交大纲；一条回复至多提交一章。草稿预览不是正史；以最终ok/commit为准。",
		promptSnippet: "运行完整流程写作并提交下一章。",
		executionMode: "sequential",
		parameters: Type.Object({ brief: Type.Optional(Type.String()) }, { additionalProperties: false }),
		execute: async (id, params, signal, onUpdate, ctx) => {
			const state = runtime.get(ctx);
			if (state.followUps.hasPending && !signal?.aborted) {
				state.followUps.flush(pi, ctx);
				return {
					content: [
						{ type: "text" as const, text: "作者有新的下一章意见；本次未开始写作。先阅读原生作者消息，再决定下一步。" },
					],
					details: { schema: "story/host-deferred@1", code: "AUTHOR_MESSAGE_PENDING" },
				};
			}
			return runtime.write(
				"write_next_chapter",
				id,
				ctx,
				signal,
				(commandCtx) => writeNextChapter(commandCtx, params),
				(step, draftPreview) => {
					onUpdate?.({
						content: [{ type: "text", text: `创作流程：${step}…` }],
						details: { schema: "story/progress@1", step, ...(draftPreview ? { draftPreview } : {}) },
					});
				},
			);
		},
	});
}
