# P3 独立判定接口

依据27 S12、28 J3与29 §4。执行会话只计算程序结果；语义判定交已校准的独立裁判会话，作者整体认可后才计入正式门槛。正式运行的具体路径将在交接文件中列出。开发结果与旧P2判定不能混入。

判定保存到对应正式运行的`judgments/`，保留逐项理由、原生消息/工具ID、正文行号和原始文件摘要。归一化计分文件复用`readJudgments(folder, "P3")`校验器及`story/p2-judgments@1`封装（格式名沿用，不表示混入P2结果）；覆盖协议也接受@2，其显式不适用条目保留理由并排除计分。例如：

```json
{
  "schema": "story/p2-judgments@1",
  "approval": { "evidence": "结果获作者认可的记录路径，初判时可省略approval" },
  "scores": [{
    "metric": "T02",
    "component": "decision",
    "sampleId": "ds11-某验收场景",
    "runId": "对应整轮manifest.runId",
    "pass": true,
    "status": "ai_preliminary"
  }]
}
```

只有作者实际认可后才使用`author_approved`，同时附作者认可记录，不以数据冻结认可代替结果认可。重复样本不得覆盖或双计。缺测、预算阻断、模型未决策均保留为未完成，不记为模型错误或不适用。T02/T03/T04/S09不得静默排除样本；T06/T07按既有协议确认为不适用的条目须保留理由及计数（@2可直接保留applicability=not_applicable、pass=null及reason，@1另放审计记录）。完整判定材料放入judgments/support/，避免把其他JSON误作归一化计分文件。

| 指标 | component | sampleId / runId | 判定范围 |
|---|---|---|---|
| T02 | decision | 场景id / SCEN整轮runId | DS11 v2全部32场景×2，第一动作是否符合可接受集合；回复语义、参数语义及禁止动作均核对 |
| T03 | recovery | 场景id / SCEN整轮runId；BOOK为错误toolCallId / 单本result.runId | SCEN G/H/I/J/L错误场景及BOOK实际工具错误，错误后的下一步是否合理；保留全部样本 |
| T04 | relevance | toolCallId / BOOK单本result.runId | 每个主笔工具调用是否与当时任务相关，pass=true表示相关；程序无效、重复及人工无关取并集，不重复计数 |
| S09 | effect | 场景id加`:check:0`等零起始索引 / E2E整轮runId | 对result.judgeChecks逐条判断作者输入在实际正文中的效果；15例全部程序与适用语义检查通过才达标 |
| T06 | precision或recall | 独立唯一逐项id / OPEN整轮runId | 按既有覆盖判定协议核对台账；最低60条金标，精确率≥85%、召回≥80% |
| T07 | source | 独立唯一逐项id / OPEN整轮runId | 原话来源正确，最低50项，≥90% |

SCEN的`firstAcceptable`只是程序匹配辅助信息，不代替独立语义判定。E2E的首动作差异保留，S09按该用例完整预期与实际效果判定；不得仅凭程序检查通过宣布通过。T04至少100次调用，样本不足时如实保留，不制造多余调用。

冻结评分版本为`p3-29@1`：场景使用`scenario-score.ts`；BOOK使用`scoreBookArchives`；OPEN使用`scoreOpeningArchives`；全部真实运行的参数与输入审计使用`scoreAllRealArchives`。原始输出不改；重算另存并带输入摘要。正式结果与作者终端确认未齐前，P3状态保持待验收。
