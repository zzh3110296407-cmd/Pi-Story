# P0 V25 网页组件验证

这里只保留手写入口与复现脚本；复制的第三方源码、中文章稿、依赖、构建产物和浏览器资料都由脚本生成到 `D:\开源\test\pi-Story\p0\web-smoke`，证据位于同一测试根的 `runs\V25`。

V01、V03 放行后，在项目根执行：

```powershell
node p0/scripts/verify-web.ts all
```

`prepare` 只准备测试副本与依赖清单，`build` 安装精确依赖并构建，`browser` 检查已有构建。浏览器优先使用本机 Edge 或 Chrome 二进制，独立浏览器资料目录仍位于测试根。若没有浏览器，可先在测试副本中运行 Playwright 的 `install chromium`，并设置 `PLAYWRIGHT_BROWSERS_PATH=D:\开源\test\pi-Story\p0\browsers`。

依赖精确版本来自 DeepSeek Harness 固定提交 `0a53fb55bea101816fa226bb964ae2bed71c343b` 的 `pnpm-lock.yaml`。验证只复制 `ui-primitives/src/markdown` 与其 `clipboard.ts` 支持文件，并保留原仓库 MIT 许可证。原包的独立 `src/invariant.ts` 使用 Cordis，且 package.json 声明 Cordis peerDependency，因此不直接安装该工作区包；Markdown 渲染入口不依赖这两部分。

移植评估覆盖 `ui-layout` 的列宽算法、AppFrame 和 store，`ui-sidebar` 的会话树与 workspace 接口，`ui-theme` 的 token、启动主题、设置与运行时。代码规模、外部导入与实际复制清单会写入 `dependency-inventory.json`，工期是静态估算，不作为已完成的移植工作。
