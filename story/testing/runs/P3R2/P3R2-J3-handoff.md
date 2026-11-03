# P3R2 J3 独立判定交接

V5产品提交：1f4ea4686b2d11527e5d65593d1130452ff3833f；评分p3r2-32@1。离线视图：D:\AI\Story Dome\Story\pi-Story\story\testing\runs\P3R2\P3R2-ACCEPTANCE\20261103T020418Z-1f4ea46。

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

## 2026-11-03 最终 BOOK 交接（作者停止扩跑）

作者已决定只保留837、527、42三本完整结束（21章），1587和1769不再补齐、后备不启动。两本部分运行的1+2章及所有调用仍纳入统计；最终质量池为全部24个已提交章。1587的派生封存目录仅复制原生会话并标注未完成请求，不补造工具结果。费用仍3.327187008 USD，全部未知预留保留。

已有226项author_approved沿用，不重新判定。新测量源码提交035aa91311e399ad2715ab38b239fffdc1b64d0f；V5产品标识仍1f4ea4686b2d11527e5d65593d1130452ff3833f。Git历史已迁移，旧认可提交号仍是历史证据标识。

新增T04/relevance共23项，逐项入口为本离线目录J3-pending-T04.json；按原runId/sampleId判定。分布：20261102T065906Z-11effeb-acceptance-r1-1587：5；20261102T065906Z-11effeb-acceptance-r1-42：11；20261102T065906Z-11effeb-acceptance-r1-1769：7。
其中1条没有保存原生工具结果：只判相关性，不补造结果；即使认可相关性，计分器仍保留结果缺口，不自动判T04完整通过。全部实际调用分母为152，不得缩回已认可部分129。

BOOK没有新增T03恢复样本，沿用SCEN22/24。固定质量抽样已封存：D:\AI\Story Dome\Story\pi-Story\story\testing\runs\P3R2\P3R2-ACCEPTANCE\20261103T020418Z-1f4ea46\quality-sample.json，SHA-256=9a2339a3459fc75335cbf63834ecb992e779176a05e21cf168b01045d83ecf71。
W03候选274对，严格依种子顺序先审适用性，取前60适用对；不适用必须保留@2的null、理由及引用，失败不能换样。W04固定20章，purpose、turn、hookSeeds每个非空项都判；复合要点全部实现才通过，不能漏点。当前尚无W03/W04正式判定，不把AI初判当作作者认可。

请把新增判定保存到BOOK原批次的judgments/，或提供独立交付路径与整体认可。原226项和原始输出保持不变。新判定的runId与sampleId来自冻结样本；不得调用付费测量模型。

原S01五本尝试3/5；三本完整书另外列3/3。S03等样本不足如实记录，作者停止扩跑不代表这些门槛自动通过。
