# P0 RPC 桥接探针

`server.ts` 为仅监听 `127.0.0.1` 的最小 HTTP/WebSocket 桥接，复用 `ProbeRpcClient`。会话、事件、启动比较、依赖和浏览器资料均在 `D:\开源\test\pi-Story\p0`。网页只展示探针能力，不进入正式产品。

0c 放行后，按顺序执行：

```powershell
node p0/scripts/verify-bridge.ts V21
node p0/scripts/verify-bridge.ts V23
node p0/scripts/verify-bridge.ts V22
node p0/scripts/verify-bridge.ts V28
```

V22 打开真实 Pi 编辑框后保留至少十分钟，每三十秒输出进度；它不压缩时间、不通过模拟时钟代替等待。执行者可将该 Node 进程保留为后台会话并短轮询，保持与作者沟通。

V22 对这次命令显式设置十五分钟的 RPC 等待，未改 `ProbeRpcClient` 默认三十秒。HTTP 发出命令后立即返回 `202 accepted`，十分钟期间没有悬挂的 HTTP 响应；最终结果通过 WebSocket 返回。证据记录实际等待时长、打开与回答时间、HTTP 接受耗时，并从会话文件核对回答后新增的作者控制条目。

V21/V28 会在 D 盘安装锁定的 Playwright 依赖，使用本机 Edge/Chrome 二进制并创建独立资料目录，测试真实网页和 WebSocket。若没有浏览器，可先按 V25 README 在 D 盘安装 Chromium。

V28 另复现 V07 的只读文件反例：在自有探针提交开始后设置该会话为只读，确认 Pi 仍可能在内存中暴露提交，但桥接在两秒内找不到文件条目便标错并终止该 Pi，绝不发出“已提交”。清理恢复文件属性，显式重开后仍没有该提交。两秒是本探针的确认超时，不是正式产品耐久承诺。
