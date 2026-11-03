# P3 J3 独立判定交接

产品V4：`a44db87ad272879275b0b2db30b8889ae8518893`，见本目录V4.json。评分版本p3-29@1；产品、规则、数值公式、阈值与样本保持冻结，测量修订见下文。DS11统一v2（8a853518b76880de860118789a5a55838a237c46），DS14 v1（c4fa1d5e0f409cb18e0cb6ac66836873c87d6069）。DS08 v2沿用已冻结验收数据。开发材料不混入正式判定。

测量修订`17417e4a387b1ecbc091ad3d21f3cb045514a2ba`：E2E首次在派发前因E01空storyPrompt被过严加载器拒绝，零费用；修复加载器及无消息会话的归档/错误收尾，并以限定文件清单固定测量来源。V4产品提交保持原值，数据、规则、模型、样本、阈值与评分公式未变。43项相关回归及项目check通过；原OPEN指标与SCEN 64例动作/程序检查按归档JSON离线重算相等，已有结果保留。证据在`P3-E2E/20261101T081545Z-ccbd53f-acceptance-r1/loader-repair.json`；V4.json同时记录产品与测量来源。

后续测量修订`e7245caa28e8fc68c40379cc7d63444b6caeaaee`补齐了DS14先前遗漏及合并错位的程序条件；数值标准未变。E2E实际执行仍用17417e4，原manifest/result/raw不改，离线检查视图另存并标明e7245ca。20项回归、项目check、SCEN全部64例相等及OPEN认可视图335项相等已核对。证据为E2E运行目录的measurement-check-repair.json。E09原执行仅探测core预算；另用原生会话与原生成设置重建生产SessionPorts，执行同一ProviderBudget.start主笔预留检查，补充探针须绑定原会话SHA256，零模型请求、不增作者输入、不改原状态。

E2E的输入可见性若不是逐字出现而可能被主笔转述，离线检查标pending_judgment，由J3按实际首个写手输入判定原条件是否成立。需额外归一化S09、component=program、sampleId=`场景id:program:索引`（如ds14-e05:program:3），runId仍为E2E整轮。它独立于正文effect，缺测仍是incomplete，程序failed不得用人工认可覆盖。缺失所有报告证据仍失败；已有错误回执时，语义充分性按下述E09勘误核对。

E09停止报告口径勘误（测量f2920aa32673a29bed95935178f3365e29444289）：原条件没有限定必须出现story.stop。原生记录中无该自定义消息，但存在可见BUDGET_EXHAUSTED工具回执；因此“回执是否充分报告停止原因”应由J3核对，标pending_judgment，sampleId=`ds14-e09:program:5`。它不自动通过，缺失全部报告证据仍失败。原e724的初始失败解释保留，由measurement-stop-receipt-review.json单独更正；数值、产品、原始运行不变，15项针对性回归及项目check通过。

依据27 S12、28 J3、29 §4，由已校准的独立裁判会话判定，作者整体认可后计入门槛；请附D0资格、裁判模型/提示/版本及认可记录。请只读冻结数据与原始输出，不修改测试集、raw或既有结果，不重新运行主笔或内部角色。expect/referenceAction等金标从未传入测量模型。

| 部分 | 正式运行位置（相对于本目录） | 状态与判定任务 |
|---|---|---|
| OPEN | P3-OPEN/20261101T080051Z-5f920d5-acceptance-r1 | r2共335项已获作者整体认可，正式提交fabdd09bd；执行端读取根目录判定并离线重算与认可视图完全一致。T05=12/12，T06精确率113/126、召回率145/159，T07=50/50，均通过。support材料不重复计分 |
| SCEN第1轮 | P3-SCEN/20261101T081051Z-82484b9-acceptance-r1 | 已作者认可：T02 25/32，T03 11/12 |
| SCEN第2轮 | P3-SCEN/20261101T081318Z-0b153b6-acceptance-r2 | 已作者认可：T02 22/32，T03 11/12；合并T02 47/64未达80%，T03 SCEN 22/24待合并BOOK。根目录共88项已读取并重算与认可视图一致；0不适用/缺测；合同扣分不等于操作不合理 |
| BOOK | P3-BOOK/20261101T103609Z-9a54cb7-acceptance-r1（批次已结束） | 527=7/7、1587=8/8、42=5/5、1769=10/10，均无作者干预且goal_reached；837保留5/6技术缺测，无重跑。前四本53项正式判定已认可，1769新增13项T04待判，无新T03工具错误。63次工具调用不足100最少样本 |
| E2E | P3-E2E/20261101T082501Z-052d61a-acceptance-r1 | 14例9项语义判定已认可（58b897dd0），E05失败、E09回执充分。E11获准的一次补齐已封存，见E11-completion-finalization.json；新来源未调用ask_author，UI暂停/回答均0、驱动错误0，检查2/3失败，属于有效测量未满足条件。S09 n=15、judged=14、successes=13、pending_author；只剩新E11正文effect待J3。旧失效E11及全部费用保留 |

每个用例的result.json及raw/session.jsonl.gz、raw/evidence.jsonl.gz、raw/checksums.json共同构成证据。selection.json固定样本与版本摘要，manifest.json固定产品及规则来源。费用从usage-ledger.jsonl和request-reservations.jsonl计算，OPEN评分文件内沿用的空执行观察字段不代表实际零调用或零费用。

判定格式与sampleId/runId约定见仓库`docs/p3/judgment-contract.md`。归一化文件放对应整轮judgments/（BOOK也可按单本放），详细材料放judgments/support/；兼容story/p2-judgments@1/@2，读取须显式P3阶段。初判标ai_preliminary；作者实际认可后才标author_approved并附approval.evidence。T02/T03/T04/S09缺测不得算不适用；T06/T07不适用保留理由与审计计数。

SCEN按合同stopAfterFirstAction在第一个工具回合结束后由测量驱动中止；这种采样中止与作者取消分开，T02判真实第一个动作，T03判准备历史中的错误之后的下一步，不要求采样边界后继续完整成书。缺测仍不算模型成功、错误或不适用。

请将判定与交付说明交回本执行会话，再统一离线重算。OPEN和SCEN两轮已就绪，后续在同一交接文件补充，不重跑已有付费结果。其余正式运行期间请只写运行判定与外部交付说明，保持仓库其他源文件/索引冻结。

BOOK 837/527的26项已按8处目标状态证据勘误后整体认可，提交26a6fff48；前4次开书调用当时尚无story.goal，targetChapter=null，不能用最终目标倒填。执行端根目录读取26项，T04完整重算及3个真实错误toolCallId与认可视图一致：BOOK T03=3/3，连SCEN截至本批25/27；T04相关性23/23、程序无效并集2/23，低于100次最少样本，不判达标。后续三本及E11尚未纳入本批认可；837中断缺口保持。

BOOK 1587现已完成8/8章、无作者干预、goal_reached停止，原生会话、引用证据摘要、最终目标与费用账校验一致；目录为同一整轮下1587/，可以补判其全部T04调用及实际错误的T03。最后一章编辑的一次length截断及后续既有调用均留在raw和费用中，最终第8章clean提交。此前837/527的认可不覆盖1587；不要改写或重复计入前26项。

1587新增12项T04已整体认可，提交78d732beb；根目录现38项正式判定。执行端以原评分函数重算与认可视图一致：累计T04无效并集2/35=5.71%，n<100仍不判达标；1587无主笔收到的工具错误，不新增T03，连SCEN保持25/27。1587第1/4/8章的3次内部编辑length截断及后续处理留在raw和费用中；不伪造为主笔恢复样本。42/1769及E11仍待各自正式交付。

BOOK 42现已完整5/5章、goal_reached停止、无作者干预，原生会话、证据摘要、目标状态和费用账校验一致。新增可判同一整轮下42/的全部T04调用及实际错误的T03；前38项正式判定保持，不重复。1769正在继续，E11尚未启动。

42新增15项T04已更正第9项理由后整体认可，提交4bfd17a3a；根目录累计53项正式判定，执行端重算T04与认可视图一致：无效并集2/50=4.00%，n<100不判达标；42无工具错误，T03连SCEN仍25/27。主笔此前收到的是提交状态，本次read_chapter返回带行号正文用于连续性核对；不得把归档details.commit.text视为模型此前已见全文。原判、原理由与勘误记录保留；1769/E11不在此次认可范围。

BOOK批次现已结束，1769完整10/10章、goal_reached停止、无作者干预，费用0.986235372USD、未知0；引用摘要、原生会话、目标和账本校验一致。新增1769/共13个实际工具结果可判T04及实际错误的T03；此前53项不重复。整轮4本到达目标，837仍为5/6后的技术缺测，不重跑；总目标36章、已观测提交35章，S03最少40章无法由本轮目标覆盖，不加章凑样本。原始metrics.json保留；S01的原始4/5值不能替代缺测披露，最终视图需保留measurement_incomplete。

唯一获准的E11技术补齐已结束并封存：P3-E2E/20261101T152513Z-518a5e2-e11-completion/ds14-e11。selection/finalization排他固定来源，结果及原始摘要均已重核；新运行UI暂停/回答均0、驱动错误0，主笔只调用两次write_next_chapter并到达目标，没有调用ask_author，程序条件2/3失败。不是旧误读reply的技术缺测，也不再补跑。原费用0.039406392USD及原始输出保留；新已知0.050011896USD、未知预留0.0416802USD；含旧合计0.131098488USD，小于原1USD额度。其余14例原始文件与HEAD无差异，没有重跑。

本次剩余J3只需：1769的13项T04（runId=20261101T103609Z-9a54cb7-acceptance-r1-1769，sampleId为真实toolCallId），以及新E11的1项S09/effect（逻辑runId仍为20261101T082501Z-052d61a-acceptance-r1，sampleId=ds14-e11:check:0，证据指向上述补齐目录）。新E11效果包含“问题区分照明与情绪”这一条件，请按实际内容判定，程序failed不得由人工认可覆盖。已有53项BOOK和9项E2E不重复；offline-rescore-9a54cb7-e11-completed.json中的原始pending条件清单不表示这些已认可项仍待重判。

2026-11-02离线快照已就绪：P3-ACCEPTANCE/20261101T153542Z-ff39c31-offline/metrics.json，逐项绑定原始摘要和本次读取的正式判定摘要；结论not_accepted，T02/W02明确失败，S09/T04末项待认可，S01/S03保留缺测/样本不足。相同目录project-check.json/log记录项目check退出0；secret-scan.json记录全仓及整个exec扫描110370文件、未确认候选0。新J3或本人P3-D确有新输入时另存新视图，不覆盖此快照，不重新派发已结束的付费测试。

E11测量修复9a54cb7634eafe55c38dcd6152fb2e54dd588bdf：严格验证on/reply/delayUntilAssertion，按固定Pi公开RPC的select/input value合同返回原脚本回答；不替换成模型选项，不把回答塞进隐藏提示。实际SDK的input、select、缺答中止及旧measured误标回放等22项回归、项目check通过。证据dialog-measurement-repair.json，原E11费用0.039406392USD保留。作者已明确批准仅补齐E11（E11-technical-completion-approval.json），排在当前BOOK批次之后；其余14例不重跑，仍使用原每例1USD额度并包含旧费用。S09仍按全部15例计，不能删除E11或计不适用。其余14例的9项语义判定现已认可并重算一致（58b897dd0）：E05输入时序与正文效果失败，E09回执充分；E11正文effect条目仍待有效测量及单独J3。原E11后续继续写作的实际行为也完整保留，不用缺失作者回答的运行推定“已回答”用例成功。
