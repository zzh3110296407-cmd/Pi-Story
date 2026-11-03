# ADR-001 Pi 构建与启动

日期：2026-10-28。依据：V01 自动打印与 RPC 实测，以及 runs/S0 的安装、构建与检查记录。

固定 Pi 提交 b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6，在 D:\开源\test\pi-Story\p0\pi 以 detached HEAD 克隆。使用 npm ci --ignore-scripts；模型目录取只读参考仓库同提交的已水合快照后，用 npm run build:offline 构建。普通构建成功但刷新目录导致上游静态检查的测试型号漂移，因此不把在线刷新作为后续复现的默认步骤。

自动实测使用已构建的 packages/coding-agent/dist/cli.js；p0/scripts/pi.ps1 同时提供上游 source-resolver 的源码启动方式。故事形态参数关闭内置工具、其他扩展、Skill、模板与上下文文件，并显式加载探针。

V01 的打印模式与 RPC 均调用 probe_write 并实际生成会话文件。交互终端仍为人工项。所有模式必须设置独立 PI_CODING_AGENT_DIR，且会话、缓存和临时文件均位于 D 盘测试根。

V02 实际请求只暴露探针工具，get_commands 只出现四个探针命令；模型请求 read、bash、write、edit、codemode 均被拒绝，没有执行。当前采用关闭内置工具后由扩展 setActiveTools 装配的路径，无需额外 --tools 白名单替代。
