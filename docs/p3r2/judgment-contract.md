# P3R2 独立判定接口

依据30、31、32。只使用V5正式验收记录，不混入开发或V4判定。格式沿用`story/p2-judgments@1/@2`，读取用`readJudgments(folder,"P3")`；schema名称不表示沿用旧评分。原始输出、初判、纠错、理由和原生证据均保留。

初判为`ai_preliminary`；作者实际整体认可后才标`author_approved`，附`approval.evidence`。数据冻结认可不代替运行结果认可。归一化JSON放正式批次或单本书的`judgments/`；详细材料放`judgments/support/`。

| metric/component | runId | sampleId |
|---|---|---|
| T02/decision | SCEN整轮manifest.runId | 场景id |
| T03/recovery（SCEN） | SCEN整轮 | G/H/I/J/L场景id |
| T03/recovery（BOOK） | 单次书籍运行 | BOOK-T03-samples.json给出的原生错误entryId:toolCallId |
| T04/relevance | T04-samples.json逐项runId | 原生助手entryId:toolCallId |
| S09/effect | E2E整轮 | 场景id:check:零起始索引 |
| S09/program | E2E整轮 | 场景id:program:索引，仅程序标pending_judgment的语义可见性条件 |
| W03/compliance | 单次书籍运行 | quality-sample.json的台账候选sampleId |
| W04/coverage | 单次书籍运行 | 章节sampleId:point:point.id |

T02取首个非只读工具或无工具的实质回复；读取超过3次、6次请求无决定为已观测失败。T03同样取下一个决定性动作。缺少模型决定、传输缺测、预算阻断不得记成功或不适用。T04只含真实模式测量段，宿主延后单列、非无效；程序必然失败、相同调用及人工判无关取并集，BOOK另列。

按31 §5，T04只把尚未被程序判无效或重复、且不是宿主延后的调用交裁判判相关性。已知无效仍留在总调用数及无效并集，不因缺少重复的人工确认而挂起计分。首批SCEN实际有63次调用，其中1次程序已判无效，只有其余62次需要相关性判定。

S09核对完整预期及正文效果，不能用效果认可覆盖程序failed，也不能让后续成功输入覆盖第一次写手请求的时间与内容。主笔转述不是自动失败，需裁判核对完整条件是否保留。

W03使用固定种子P3R2-W03排序全部候选，按顺序取前60对适用项；@2不适用项必须`pass:null`、`applicability:not_applicable`及理由，不能因为某项失败换样。未审查的较早候选不能静默跳过。W04使用P3R2-W04固定20章，逐项核对大纲purpose、turn、每个hookSeeds；一项含多个要求时，全部实现才通过。完整意图仅作上下文。全部20章的全部要点均须有判定，不按“整章大致符合”给一条分数。

正式样本、归档路径及后续新增材料统一见`story/testing/runs/P3R2/P3R2-J3-handoff.md`。缺测及不足最少样本如实保留；已认可样本不重复判定。
