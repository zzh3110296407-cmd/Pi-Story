# P3R2 J3 独立判定交接

V5产品提交：1f4ea4686b2d11527e5d65593d1130452ff3833f；评分p3r2-32@1。离线视图：D:\AI\Story Dome\Story\pi-Story\story\testing\runs\P3R2\P3R2-ACCEPTANCE\20261102T080614Z-1f4ea46。

仅判本轮正式验收，不改V4记录，不调用付费测量模型。初判ai_preliminary，作者整体认可后author_approved并附approval.evidence。沿用story/p2-judgments@1/@2和readJudgments(folder,"P3")；详细理由放judgments/support。

- T02/decision：每个SCEN场景的决定性动作与全部禁止条件。sampleId=场景id，runId=整轮manifest.runId；读取超过3次或请求上限无决定必须失败，传输缺测保留。
- T03/recovery：SCEN的G/H/I/J/L，sampleId=场景id、runId=整轮；BOOK见BOOK-T03-samples.json的runId/sampleId，取下一决定性动作，无后续决定保留缺测。
- T04/relevance：T04-samples.json保留全部真实模式调用作分母；只判invalid=false、repeated=false、hostDeferred=false的项。使用逐项runId和sampleId（原生助手entryId:toolCallId）；程序无效/重复与无关取并集，不要求裁判重复确认已知无效。
- S09/effect：E2E的场景id:check:零起始索引，runId=整轮；逐字不可证明的输入可见性用S09/program、场景id:program:索引。程序failed不能用认可覆盖；首次写手请求边界不因后续成功改变。
- BOOK未全部归档，W03/W04正式抽样尚未冻结，不判临时样本。

正式批次：
- D:\AI\Story Dome\Story\pi-Story\story\testing\runs\P3R2\P3R2-SCEN\20261102T055954Z-56915a7-acceptance-r1
- D:\AI\Story Dome\Story\pi-Story\story\testing\runs\P3R2\P3R2-SCEN\20261102T060212Z-56915a7-acceptance-r2
- D:\AI\Story Dome\Story\pi-Story\story\testing\runs\P3R2\P3R2-E2E\20261102T061120Z-535d07e-acceptance-r1
- D:\AI\Story Dome\Story\pi-Story\story\testing\runs\P3R2\P3R2-BOOK\20261102T065906Z-11effeb-acceptance-r1

现有未判项和缺测均保持，不推定作者已认可运行结果。后续材料会更新同一交接文件，已认可样本不重复判定。

## BOOK 527新增交接与暂停状态

既有212项认可沿用43295a9f4、32a7f20b3、4edeb9f15，均不重复判。527已正常完成7/7章，归档为BOOK同一批次527/book；本次只新增14次T04/relevance，均非程序无效、重复或宿主延后，按本视图T04-samples.json逐项runId/sampleId判定。合并分母129，已知无效1，新增14项待判；BOOK单列34次。527没有新增T03恢复样本，仍22/24。W03/W04等整批结束后固定抽样。

1587在作者要求下暂停，第1章未提交；写手/编辑输出与记录员未知用量预留均保留。当前仅做零费用续接检查，不将暂停误记为外部中断重跑，不改837/527或SCEN/E2E的原始结果。E12的402和第3章缺口继续保留。

更新：527的14项现已由a5d4e16a4整体认可，既有212项保持，共226项。生产评分复算合并T04=1/129，待判0；BOOK单列0/34，无新增T03。恢复测量器的本地回归中误发14次夹具角色请求（0.02251176 USD），单独归档并计入费用，不进正式质量样本；后续只追加正式BOOK的新调用。W03/W04仍等整批结束再固定抽样。

重要更新：1587首次续接已提交第1章，但测量器180秒RPC命令超时在第2章写手期间终止；原超时保留。作者已明确允许“仅补齐1587未完成部分”，授权和第1章摘要在BOOK批次technical-completion/1587/authorization.json。须等当前批次与这次授权补齐全部结束，才能冻结W03/W04；不能把主批次summary.json单独视为最终抽样完成。已完成的第1章、837/527及其他正式样本不重跑，费用与未知预留全部保留。14次夹具误调用另按完整原HTTP和产品检查点离线关联审计，五项硬门槛通过；不进入正式质量样本。
