# P3R2 J3 独立判定交接

V5产品提交：1f4ea4686b2d11527e5d65593d1130452ff3833f；评分p3r2-32@1。离线视图：D:\AI\Story Dome\Story\pi-Story\story\testing\runs\P3R2\P3R2-ACCEPTANCE\20261103T022557Z-1f4ea46。

仅判本轮正式验收，不改V4记录，不调用付费测量模型。初判ai_preliminary，作者整体认可后author_approved并附approval.evidence。沿用story/p2-judgments@1/@2和readJudgments(folder,"P3")；详细理由放judgments/support。

- T02/decision：每个SCEN场景的决定性动作与全部禁止条件。sampleId=场景id，runId=整轮manifest.runId；读取超过3次或请求上限无决定必须失败，传输缺测保留。
- T03/recovery：SCEN的G/H/I/J/L，sampleId=场景id、runId=整轮；BOOK见BOOK-T03-samples.json的runId/sampleId，取下一决定性动作，无后续决定保留缺测。
- T04/relevance：T04-samples.json保留全部真实模式调用作分母；只判invalid=false、repeated=false、hostDeferred=false的项。使用逐项runId和sampleId（原生助手entryId:toolCallId）；程序无效/重复与无关取并集，不要求裁判重复确认已知无效。
- S09/effect：E2E的场景id:check:零起始索引，runId=整轮；逐字不可证明的输入可见性用S09/program、场景id:program:索引。程序failed不能用认可覆盖；首次写手请求边界不因后续成功改变。
- W03/compliance：quality-sample.json按P3R2-W03固定顺序核对适用性，取前60对适用项；不适用须@2保留null、理由，不能因失败换样。W04/coverage：P3R2-W04固定20章，sampleId=chapter sampleId:point:point.id；purpose、turn、hookSeeds所有非空项逐项判定，复合项所有要求实现才通过。正文行号和意图均保留。

正式批次：
- D:\AI\Story Dome\Story\pi-Story\story\testing\runs\P3R2\P3R2-SCEN\20261102T055954Z-56915a7-acceptance-r1
- D:\AI\Story Dome\Story\pi-Story\story\testing\runs\P3R2\P3R2-SCEN\20261102T060212Z-56915a7-acceptance-r2
- D:\AI\Story Dome\Story\pi-Story\story\testing\runs\P3R2\P3R2-E2E\20261102T061120Z-535d07e-acceptance-r1
- D:\AI\Story Dome\Story\pi-Story\story\testing\runs\P3R2\P3R2-BOOK\20261102T065906Z-11effeb-acceptance-r1

现有未判项和缺测均保持，不推定作者已认可运行结果。后续材料会更新同一交接文件，已认可样本不重复判定。

## 本批已正式认可并合并（2026-11-03）

作者整体认可167条，本地提交8be85a93；新增125项适用、42条NA，原226项不变，合计393原始记录/351项适用。W03=60/60、NA42保留null；W04固定20章35/42通过，7项未覆盖保留。T04分母152、已知无效1、结果缺口1，value/passed仍null。没有新增BOOK T03恢复样本。

当前正式离线视图：D:\AI\Story Dome\Story\pi-Story\story\testing\runs\P3R2\P3R2-ACCEPTANCE\20261103T022557Z-1f4ea46，测量源码3168eaaf10ad49cdf8e66aa5255242f93c81dcc0。质量样本与原020418固定样本SHA-256完全相同，未重新抽样。硬门槛、程序指标、费用均复算一致；新归档与判定增量扫描通过。

此批J3不再待判，不重复请求裁判。剩余本人V5终端检查按docs/p3r2/terminal-check.md；BOOK已关闭，1587/1769与后备不再运行。原五本S01和不足样本仍如实保留，不宣布P3整体通过。
