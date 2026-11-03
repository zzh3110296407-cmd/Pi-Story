# Pi Story 项目规则

当前工作仓库：`D:\AI\Story Dome\Story\pi-Story`。本项目采用独立 Git 历史，远程为 `https://github.com/zzh3110296407-cmd/Pi-Story.git`。Pi 为固定版本的第三方源码，不继承其贡献、提交格式或发布流程。

## 代码与依赖边界

- 根目录 `packages/` 是 Pi 提交 `b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6` 的只读源码，不添加、修改或删除其中的文件；升级须由作者明确授权。按 `story/scripts/baselines/pi.json` 校验，不要求保存上游提交对象。
- 自有代码位于 `story/`。规划中的业务单元为 `story/packages/{core,pi-story,runner,evals}` 和 `story/apps/{bridge,web}`；按阶段独立建包，不合并桥接与网页或 runner 与 evals。
- Pi 依赖只允许出现在 pi-story、bridge、runner；core 保持纯 TypeScript，不引用 Pi、pi-story、bridge；web 经 HTTP/WebSocket 访问桥接，不直接依赖后端。
- runner 负责无界面成书、L0 循环和基线；evals 负责评测、评分与报告。产品代码不引用评测或测试代码。
- `story/` 独立管理依赖；根 npm 工作区服务 Pi 源码。第三方包内的文档和许可证原样保留。

## 执行与验证

- 每次任务先运行 `npm run check:upstream`。发现漂移立即停止并报告路径，不覆盖作者改动。
- 上游检查覆盖 HEAD、暂存区、工作区与未忽略的新文件；受保护源码不能通过恢复工作文件隐藏已提交或已暂存的变更。
- 修改代码后运行相关回归及 `npm --prefix story run check`；不要运行会改写只读上游的根全量 check。不要直接运行所有可能启用真实提供方的测试。
- 本地回归使用替身，明确移除真实密钥并设置 `PI_OFFLINE=1`；付费测量仅按当前阶段及作者授权执行。保留失败、费用和未知预留，不重复已完成的付费测试。
- 公开数据集与归档位于 `story/testing/{datasets,runs}`；依赖、缓存、构建、临时文件和运行中会话位于 `story/testing/exec/`。不触碰作者的 Pi 用户目录或认证文件。
- 正式冻结版本只读，修订须发布新版本。不能将验收金标传给测量模型；遵守各阶段的开发/验收读取边界。
- 不恢复或执行已退役的自定义 Harness、钩子、验证器、计划或租约。

## Git 与进度保护

- 不创建任务分支或分支工作树；不推送、发布或改变远程权限，除非作者明确要求相应操作。独立仓库初始化已由作者于 2026-11-03 授权。
- 日常只暂存当前任务明确修改的路径；保留其他会话工作。禁止 `git add .`、`git add -A`、`git reset --hard`、`git clean -fd`、`git stash`。
- 提交使用 `feat(story):`、`fix(story):`、`docs(story):`、`chore(story):` 等项目格式；提交范围由作者或有效方案决定，不继承上游贡献门禁。
- 初始化提交是迁移时全部公开工作文件的快照；旧索引、未提交差异和 Git 元数据备份在仓库外。后续按日常规则提交。
- P3 第二轮于 2026-11-03 按作者要求恢复离线收尾：保留已完成的 837、527、42，1587（作者误写 1578）与 1769 不再补齐，后备书不跑。遵守 BOOK 批次的 `book-closure.json`；全部旧结果、部分章、费用与未知预留保留，不重跑已完成的付费测试。先核对暂停快照与 ADR-023 的 Git 迁移说明。
- 历史报告中的旧提交号用于证据溯源，不代表新仓库包含这些祖先。V5 产品摘要、数据集与模型配置必须保持原冻结值；仓库迁移不算重新冻结或验收通过。

