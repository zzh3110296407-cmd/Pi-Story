# 固定 Pi 压缩预算兼容处理（作者已采纳）

日期：2026-11-01。作者明确确认“接受临时兼容层用于 P3”。仅离线验证；未冻结、未调用付费模型。

## 原因与边界

固定Pi的`core/sdk.ts`把`before_provider_request`接在Agent的onPayload上，但压缩经`agent-session._runDefaultCompaction`直接复用streamFunction，没有传这些Agent回调。因此U6的前置检查可用，压缩内部两个摘要请求、以及Pi自身摘要重试不会进入主笔请求的逐次预留。实际SDK反例：成功压缩发了2次替身HTTP请求，取到的在途预留为`[0,0]`。

上游源码由仓库AGENTS.md的“根目录 packages/…只读”限制，不能在本任务改。此处属于固定SDK的临时兼容处理，按作者提供的Global Codex Rules关于“原因不能改时，标为temporary并取得认可后才作为最终修复”的要求，已获作者采纳；不将其写为正式验收已通过。

## 已实现、可审阅的处理

- `story/packages/pi-story/src/provider-budget.ts`：在session_before_compact期间通过SDK公开的provider注册接口，仅为所选provider的streamSimple加预算预留和结算；每次真实摘要与Pi重试都先预留。
- Pi原摘要算法、路由、模型、认证及重试策略仍执行原逻辑；不复制摘要算法、不读写密钥文件。注册对象只在当前进程中临时替换。
- 成功和失败的压缩结束事件均恢复原provider注册；每次费用保持独立。只有与Pi已保存压缩条目聚合用量相符时才确认已知预留，未知费用保留。
- 主笔请求继续走before_provider_request；内部角色继续走core CallSession，三者共享同一BudgetGuard。

## 验证

`p3-provider-budget.test.ts`8例通过，包括：三种主笔预算不足在fetch之前取消；主笔已知用量仅在原生条目保存后确认；传输失败的初始化零用量仍保留预留；压缩预算不足取消；成功压缩每次HTTP之前都有在途预留、原生聚合只计一次、provider恢复；第一段摘要后降低预算，第二段没有派发且原provider恢复。均是实际固定Pi SDK + 替身HTTP，没有真实模型请求。

后续Pi若补齐摘要请求挂点，应先重测该反例，再删除这一临时provider适配。
