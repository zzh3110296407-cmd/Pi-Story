# Pi Story 正式代码目录

当前仓库：`D:\AI\Story Dome\Story\pi-Story`。`story/` 承载故事项目代码，与根目录只读的Pi `packages/` 分开；`p0/` 继续保留探针，不直接提升为正式实现。

| 位置 | 用途 |
|---|---|
| `story/packages/core` | P1领域模型、折叠、校验与提交 |
| `story/packages/pi-story` | P2起的Pi扩展、故事工具和作者命令 |
| `story/packages/runner` | 无界面成书、L0循环、B0/B1/B2基线生成 |
| `story/packages/evals` | ConStory批量评测、人工评分工具、报告；子进程调用Python评分器 |
| `story/apps/bridge` | 本机Node桥接服务：Pi RPC进程管理、HTTP接口、WebSocket推送和对话框转发 |
| `story/apps/web` | 浏览器端界面：通过桥接HTTP接口操作，通过WebSocket接收推送 |
| `story/scripts`、`story/test` | 项目检查与对应回归 |
| `story/testing` | 已提交的测试集、运行记录及索引；`private/` 与 dirty 运行仅留本机 |

六个业务单元各自拥有独立的 `package.json`，目录按阶段创建；P1的core实现位于 `packages/core`，公共入口为 `packages/core/src/index.ts`。方案中的自研 `core`、`pi-story`、`runner`、`evals` 映射到 `story/packages/*`，`bridge`、`web` 映射到 `story/apps/*`，根 `packages/*` 始终留给Pi。详见 [ADR-012](../docs/adr/ADR-012-仓库结构与上游边界.md)。

`story/package.json` 独立管理项目依赖和工作区，不加入根Pi npm工作区。P1后半段当前为待正式测试的实现草稿，见 [core说明](packages/core/README.md)。未来消费Pi时复用同一固定版本的一组包，具体打包和运行入口在对应阶段实现。

## 依赖边界

依照总体方案00 §13.2、架构图10 V5与接口设计12 §9：

- 只有 `pi-story`、`bridge`、`runner` 可以引用Pi；`core` 是纯TypeScript领域库，不引用Pi、`pi-story` 或 `bridge`。
- `web` 不引用Pi或任何后端包。网页操作仅通过HTTP发送给 `bridge`，WebSocket仅用于服务器推送；Pi进程、RPC和本机服务由独立的 `bridge` 包负责。
- `runner` 提供成书与基线生成能力；`evals` 调用 `runner` 组织评测，负责数据集、评分和报告。产品包与应用不引用 `evals` 或测试代码。

各包引入时单独声明依赖，并将上述约束纳入依赖/import检查；项目级清单不代替业务包之间的边界。

## 检查

在仓库根目录执行：

```powershell
$env:TEMP = 'D:\开源\test\pi-Story\upstream-guard'
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$env:NPM_CONFIG_CACHE = "$env:TEMP\npm-cache"
$env:NODE_COMPILE_CACHE = "$env:TEMP\node-compile-cache"
npm run check:upstream
npm --prefix story run check
npm --prefix story run test:upstream
```

`check:upstream` 只核对上游基线；`story` 的 `check` 另含依赖方向、测试内容摘要与敏感内容、Biome 和类型检查，需要已安装的隔离依赖。P1 按执行方案只运行根 `check:upstream` 及 `story` 检查，不运行根 Pi 的全量检查。

检查固定完整提交号，不自动获取或升级基线；本地克隆必须包含该提交。检测HEAD、暂存区、工作区的修改/新增/删除以及未忽略的新文件，失败时列出层次与路径；Git忽略的构建产物不进入源树断言。CI的检查作业检出完整历史。

负向回归使用真实 Git，可重建的临时工作区在 `D:\开源\test\pi-Story\p1` 下，不修改工作仓库的 `packages/`，不创建分支、不调用模型。

测试内容见 [testing/README.md](testing/README.md)。工具默认按文件位置找到 `story/testing/`；`PI_STORY_TEST_ROOT` 可覆盖测试集根，`PI_STORY_RUNS_DIR` 可独立覆盖运行记录根，`PI_STORY_WORK_DIR` 可覆盖临时工作区。冻结版本提交后只读，修订发布新版本；项目检查也拒绝同时改写数据与清单的原地更新。Biome、Vitest 发现与类型检查排除 `testing/`。
