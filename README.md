# Pi Story

Pi Story 是面向长篇小说创作的 AI 辅助写作项目，基于 [Pi](https://github.com/earendil-works/pi) 的 Agent 运行时开发。它围绕作者的创作要求，组织故事设定、章节大纲、正文写作、审稿修订与状态记录，让连续创作有可追踪的依据，也让作者能够在过程中调整方向。

项目由本仓库独立开发和维护。故事业务代码位于 [`story/`](story/)，Pi 提供底层模型调用、工具执行与会话能力。

> 当前处于开发与验证阶段，已有故事领域核心和 Pi 扩展实现，主笔调度与连续创作流程仍在验证中。浏览器界面、本机桥接服务以及独立的成书与评测工作区属于后续规划。

## 创作流程

1. **提出故事要求**：作者给出题材、人物、世界观、创作限制或续写起点。
2. **建立故事资料**：整理带有作者原话依据的要求台账，建立人物与世界设定，并形成章节大纲。
3. **逐章创作**：由主笔调度，依次执行写手起草、程序检查、编辑审稿、符合条件的局部修订与复查，再由记录员整理状态变化。
4. **确认正文与状态**：完成流程的章节作为正式正文提交，并与故事状态一同保存到会话记录。
5. **继续与调整**：作者可以补充意见、调整未写章节的计划或设置写作目标；已提交章节会输出为 Markdown 书稿。

## 当前已实现的能力

以下为源码中已有的能力，完整效果与阶段验收结果见[开发进展](#开发进展)。

- **作者控制**：记录作者意图、当前创作焦点和要求台账，支持写作过程中补充意见。
- **故事资料管理**：保存人物、地点、世界规则、冲突线与章节计划，区分作者提供的设定和模型补充内容。
- **单章写作流程**：将起草、检查、审稿、局部修订和状态结算串成一次章节操作，区分草稿预览与正式正文。
- **连续性查询**：读取已写章节、人物卡片、事实、角色认知、人物关系与伏笔，并可回看指定章节的状态。
- **后续计划调整**：补充面向未来的设定、修改尚未写作的章节大纲；遇到需要作者决定的歧义时发起询问。
- **目标与预算控制**：设置目标章数、token 预算、费用预算和每章调用次数限制，并记录停止原因。
- **会话与书稿**：从当前会话分支重建故事状态，将已提交正文输出到配置的 `storiesDir/manuscripts/<storyId>.md`。

## 作者命令

加载 Pi Story 扩展并发送第一条故事提示后，可以使用以下命令。无参数时会在交互界面打开当前设置。

| 命令 | 用途 | 示例 |
| --- | --- | --- |
| `/intent` | 设置整体创作意图 | `/intent 写一部克制、重人物关系的悬疑小说` |
| `/focus` | 设置当前创作焦点 | `/focus 下一章重点表现两位主角之间的信任变化` |
| `/ledger` | 增加、修改或移除作者要求 | `/ledger add story 不使用超自然解释` |
| `/goal` | 设置目标章号，或关闭自动目标 | `/goal 5`、`/goal off` |
| `/budget` | 设置预算，或关闭当前预算设置 | `/budget tokens=100000 usd=2 perChapterCalls=10`、`/budget off` |

## 开发进展

当前实现集中在两个包：

- [`@pi-story/core`](story/packages/core/)：故事领域模型、状态重建、校验、章节流程和内容投影。
- [`@pi-story/pi-story`](story/packages/pi-story/)：Pi 扩展、故事工具、作者命令、角色调用、会话适配与书稿输出。

开发记录按阶段保留。P1 为领域核心，P2 为 Pi 扩展与角色流程，P3 为主笔调度、作者控制与连续创作。阶段报告同时记录通过项、失败项和待验证项：

- [P1 核心验证](docs/p1/report.md)
- [P2 扩展验证及修订](docs/p2r3/report.md)
- [P3 连续创作验证及当前修订](docs/p3r2/report.md)
- [测试数据与运行记录说明](story/testing/README.md)

浏览器端 `web`、本机桥接服务 `bridge`、无界面成书包 `runner` 和独立评测包 `evals` 尚未形成对应的业务包。现阶段的评测脚本位于 `story/scripts/eval/`。

## 代码结构

| 路径 | 内容 |
| --- | --- |
| [`story/packages/core/`](story/packages/core/) | 故事领域核心 |
| [`story/packages/pi-story/`](story/packages/pi-story/) | Pi Story 扩展与运行时适配 |
| [`story/scripts/`](story/scripts/) | 项目检查、环境准备和评测脚本 |
| [`story/testing/`](story/testing/) | 测试数据集与归档运行记录 |
| [`docs/`](docs/) | 架构决策、阶段报告与设计差异 |
| [`p0/`](p0/) | 早期可行性验证探针 |
| [`packages/`](packages/) | 固定版本的 Pi 上游源码 |

`story/` 是独立的 npm 工作区。根目录 `packages/` 保留固定版本的 Pi 源码，故事业务在 `story/` 中实现。目录划分与依赖边界见 [ADR-012](docs/adr/ADR-012-仓库结构与上游边界.md)。

## 开发与检查

需要 Git、Node.js 22.19 或更高版本，以及 npm。本仓库使用独立 Git 历史；上游边界按已冻结的文件清单校验，浅克隆即可运行，不需要 Pi 的提交历史。

在仓库根目录执行：

```bash
npm run check:upstream
```

开发运行环境集中在 `story/testing/exec/`，包括固定版本 Pi 构建、项目依赖、缓存和运行中会话。环境准备入口为 [prepare-p2.mjs](story/scripts/prepare-p2.mjs) 和 [install-isolated.mjs](story/scripts/install-isolated.mjs)：

- Pi 构建需要带有清单的模型目录快照；准备脚本会在 `story/testing/exec/pi-upstream.git` 按需获取固定 Pi 提交的浅快照，不向本项目 Git 历史导入上游提交。已有构建继续复用。
- Story 依赖当前通过 `file:` 路径引用该 Pi 构建；迁移到其他目录或机器时，需要核对 [扩展包清单](story/packages/pi-story/package.json) 中的本地路径。
- 运行扩展需要将 `PI_CODING_AGENT_DIR` 指向独立配置目录，并提供 `story-forge.json`、可用的模型配置和认证信息。`story-forge.json` 设置书稿目录、各角色模型和默认预算。

完成开发环境配置后，可在仓库根目录执行故事项目检查：

```bash
npm --prefix story run check
```

该命令检查上游边界、依赖方向、测试数据、代码格式与类型。模型调用和创作质量验证由阶段评测另行执行。开发约定见 [AGENTS.md](AGENTS.md)。

## 上游来源与许可证

Pi Story 基于 [earendil-works/pi](https://github.com/earendil-works/pi) 开发，当前固定上游提交为 [`b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6`](https://github.com/earendil-works/pi/commit/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6)。感谢 Pi 作者及贡献者提供底层运行时。

- **Pi Story 新增代码**采用 **AGPL-3.0**，完整条款见 [LICENSE](LICENSE)。
- **Pi 原始代码**保留 **MIT** 许可证与原版权声明：`Copyright (c) 2025 Mario Zechner`。完整许可文本见 [LICENSE.pi](LICENSE.pi)。
- 其他来源及许可说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；各第三方组件遵循各自的许可证。

本仓库从独立的起始提交维护，不导入 Pi 提交历史。第三方来源、文件边界和原有测试冻结记录通过版本号与校验清单追溯；见 [ADR-023](docs/adr/ADR-023-独立Git历史与冻结快照.md)。
