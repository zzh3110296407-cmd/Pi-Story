# 测试内容

测试集及运行记录位于story/testing；依赖、缓存和临时目录按项目规则位于D:/开源/test/pi-Story/p1。当前工作区状态及运行ID见[当前P1验收报告](<D:/AI/Story Dome/新版综合方案/测试结果/P1/P1验收报告.md>)。

## 当前正式认可版本

| 测试集 | 当前版本 | 说明 |
|---|---|---|
| DS01-sentences | v3 | 69份文档；自然中文验收430句独立计分，671句界待复核 |
| DS02-author-quotes | v3 | 87例；来源与指令授权分开 |
| DS03-state-deltas | v2 | 60例；说话人、推断来源及整章净数量证据修正 |
| DS04-eligibility-flow | v2 | 60个资格、流程与批内写入场景 |
| DS05-program-check | v2 | 75例；四项程序检查及3份P0摘录观察 |
| DS06-input-estimate | v2 | 20份P0实测，计费包含缓存输入 |
| DS07-replay | v3 | 37对原始请求响应；37项独立归类及2份单列修订参考 |

作者已于2026-10-29直接认可当前人工金标及设计终审，确认记录见docs/p1/author-acceptance-20261029.json与方案目录P1-作者终审确认.md。逐项空表保留历史，不冒充已填写评分。仓库共17个当前/历史版本，四个新版本已在c54444e56中提交冻结。旧版本不修改；DS07 v3的37对原始文件与v2及pairs.json摘要一致。

## 消费与结果范围

套件及数据依赖以scripts/eval/suites.json为准。UNIT登记全部7组；FOLD/FLOW登记所用的DS03、DS04。DS03的DOMAIN_INVALID按字段路径匹配，D3须成功且降级；D5语义识别由P2验证。

DS07使用原请求的编号正文，不擅自重编号或猜人物键。judgments.json提供独立预期，corrections.json是明确标记的修订参考，不能加入原始模型成功率；首个格式或身份拒绝不代表没有其他语义问题。

[可编辑人工复核入口](<D:/AI/Story Dome/新版综合方案/测试结果/P1/人工复核/数据集候选复核入口.md>)在方案目录；仓库labels里的表单是冻结模板，不直接填写。

## 保存规则

- 一个测试集版本在测量前提交；提交后只读，修订发布新版本。每个版本含清单、逐文件 SHA-256、来源、许可、划分与标注记录。
- `.gitattributes` 禁止换行转换。迁移保留原字节；新材料使用 UTF-8 无 BOM 与 LF。格式、类型及测试发现范围均排除本目录。
- 运行 ID 为 UTC 时间加代码提交短号。`runs/` 以外有未提交改动时加 `-dirty`，只留本机，不提交、不作为验收证据。运行结束后提交记录，之后不覆盖。
- 不提交认证信息、个人隐私或未获准再分发的材料；私人材料放在被忽略的 `private/`。密钥不得写入任何测试内容。
- 单文件不超过 10 MB；超过 1 MB 的原始产物压缩为 `.jsonl.gz`；单次运行的 `raw/` 压缩后不超过 20 MB。本目录超过 500 MB 时由作者决定存储方案。
- 项目检查校验清单、摘要、额外文件及敏感内容。缺失或摘要不符直接失败，不静默跳过。
- 结果与结论仍在方案目录的 `测试结果/P1/`，引用运行 ID 与代码提交。AI 预标注、人工核对与作者复核分别记录。

## 历史证据

旧代码5f45b06的216项测试与归档重跑保留于既有runs/P1目录；它们不能替代当前修改的最终提交测量。所有本轮dirty运行只作过程验证，最终验收需提交代码/数据、干净测量及git archive重跑。

## P1最终验收

2026-10-29：P1通过。作者金标与设计终审已认可；代码c54444e56的245/245测试、11套件、按DD13的隔离复现及最终扫描通过。原始metrics中的pending_author是程序生成时的静态字段，人工作为独立judgments补充，不改写测量文件。最终报告与作者确认单为当前结论；旧dirty与待审批叙述只保留历史。P2尚未启动。

## P2测试集索引

| 测试集 | 版本/位置 | 状态 | 说明 |
|---|---|---|---|
| DS12-context-cases | datasets/DS12-context-cases/v2（v1保留） | 正式（作者认可AI 20%抽查） | J1；5/25抽查同意；仅补复核记录，28个用例/示例文件同v1 |
| DS08-opening-prompts | datasets/DS08-opening-prompts/v2（v1保留） | 正式（作者认可AI代核及修订） | J-R1；仅12条全新valid验收提示；159约束、59作者给定圣经、12篇幅；v1全部作为开发按摘要引用，不复制 |
| DS09-state-gold | datasets/DS09-state-gold/v2（v1保留） | 历史冻结版（保留复现） | J-R2；仅3个新故事×3章；72关键事实、27伏笔、27陷阱、219复核项；v1全部供开发按摘要引用，不复制 |
| DS09-state-gold | datasets/DS09-state-gold/v3（旧版保留） | 正式（已认可金标继承，AI输入核验） | J-R2输入修复；v2正文/金标不改；验收伏笔语义18/18；另交付v1全量15章R4开发输入补丁，35/35 |
| DS10-review-defects | datasets/DS10-review-defects/v1 | 历史冻结版（原P2复现） | J3；45变体、36验收缺陷（六类各6）、4处structural；依赖DS09 v1 |
| DS10-review-defects | datasets/DS10-review-defects/v2（v1保留） | 历史冻结版（保留复现） | J-R3；27新验收变体、36注入、12一致对照；48/48同意，4处major/structural确认；依赖冻结DS09 v2，v1全部供开发按摘要引用 |
| DS10-review-defects | datasets/DS10-review-defects/v3（旧版保留） | 正式（已认可金标继承，AI输入核验） | J-R3输入同步；依赖DS09 v3；27变体/48金标不改；另交付v1全量45变体R4开发输入补丁 |

## P3测试集索引

| 测试集 | 位置 | 状态 | 说明 |
|---|---|---|---|
| DS11-showrunner-scenarios | datasets/DS11-showrunner-scenarios/v1 | 历史冻结版（保留复现） | 开发与验收H01的极小全局预算阻止主笔请求；由v2修正，既有运行不改 |
| DS11-showrunner-scenarios | datasets/DS11-showrunner-scenarios/v2 | 历史冻结版（P3 V4复现） | 开发15、验收32；H01修复版保留，既有运行不重算 |
| DS11-showrunner-scenarios | datasets/DS11-showrunner-scenarios/v3 | 正式（AI构造与差异自检、作者整体认可） | P3R2；开发18、验收32；@2决定性动作，全部argsMatch复查，新增3个开发场景 |
| DS14-author-control-e2e | datasets/DS14-author-control-e2e/v1 | 历史冻结版（P3 V4复现） | 开发5、验收15；旧版及运行保留 |
| DS14-author-control-e2e | datasets/DS14-author-control-e2e/v2 | 正式（AI构造与差异自检、作者整体认可） | P3R2；开发7、验收15；验收15用例与索引均逐字节同v1，新增E05/E11开发变体 |

[P3R2正式冻结交接](<D:/AI/Story Dome/新版综合方案/测试结果/P3/人工复核/P3R2-J2-测试集冻结交付.md>)为当前入口；[核对单](<D:/AI/Story Dome/新版综合方案/测试结果/P3/人工复核/DS11-v3-DS14-v2-核对单.md>)是冻结前的历史审核快照，真实整体认可见两套新版本的labels/author-acceptance.json。场景与split索引均逐字节继承已认可草稿。全部72个准备段经实际core命令重放：122次提交、366次本地替身调用，10次B类合理表示验证，无付费调用。

开发只读取新版本dev/index.json、其引用dev文件，以及build/CONTRACT.md与build/scenario-contract.mjs；后两者不含验收文本。其余build文件、labels、完整复核表和acceptance均不供调参。DS11采用story/p3-scenario@2，允许最多3次准备读取，最多6个主笔请求，运行到决定性动作；F类须有正确答复。DS14保留@1 E2E流程。执行会话仍须按30 S5完成@2加载／采集／停止逻辑和正常session/extension替身准备重放；数据侧检查不等于V5模型验收。

31 J2数据冻结完成；正式验收还需满足30 S7的产品V5冻结及S8全部先决条件。新运行与判定放runs/P3R2/，原版本、V4原始证据／费用／判定不改；31 §5的V4遗留14项已列于方案目录P3-J3-V4遗留-已取代.md。后续J3等待V5归档，仍由已校准AI判定、作者整体认可。原P3 J1/J2与DS11 v2交付说明只保留历史快照。

## P2R J-R4判定与作者抽查

2026-10-31：[正式AI判定交付](runs/P2R/P2R-JUDGE/20261031-j-r4/README.md)及[机器索引](runs/P2R/P2R-JUDGE/20261031-j-r4/summary.json)已完成，31份逐运行`judgments/<指标>.json`覆盖15指标、1,715条判定；复核身份为Codex / GPT-6、AI裁判（已校准），附D0资格引用。原始运行与metrics不改。

[原始抽查模板](runs/P2R/P2R-JUDGE/20261031-j-r4/author-spotcheck.md) / [原始JSON](runs/P2R/P2R-JUDGE/20261031-j-r4/author-spotcheck.json)共176项，种子`P2R-JR4-20261031-v1`，保留提交时的空表。[已完成的AI代核结果](runs/P2R/P2R-JUDGE/20261031-j-r4-spotcheck-ai/author-spotcheck.md) / [填写JSON](runs/P2R/P2R-JUDGE/20261031-j-r4-spotcheck-ai/author-spotcheck.json)由作者本次委托的Codex / GPT-6实际逐项完成：174项维持、2项改判、6项仅更正理由、0项存疑；同因另补正样本外2项判定及3项说明。每项保留原判和真实AI身份，不称作者亲审或独立第二模型。

[纠错补充](runs/P2R/P2R-JUDGE/20261031-j-r4-spotcheck-ai/corrections.json)与[最新AI观察值](runs/P2R/P2R-JUDGE/20261031-j-r4-spotcheck-ai/summary.json)单独存放：K03由91%升至93%，K05由87%升至89%，T06、K04、K05仍低于阈值；state类改判2/40（5%），其他类别0%，没有超过20%的类别。原始raw、metrics、judgments和冻结数据保持原样，未伪填author_approved或P2通过。按作者已有范围使用OPEN两轮、CHAP一轮、KEEP两轮、EDIT一轮，缺失第二轮的原聚合null与W01原样本最低要求不获豁免。外部可编辑入口见[方案目录](<D:/AI/Story Dome/新版综合方案/测试结果/P2/人工复核/P2测试集复核入口.md>)。

2026-10-31 D4复检（Codex / GPT-6，受作者委托的AI代核）：176项最终判定全部维持；新增修正第70、89项理由，累计6项理由更正。原始E02的36条共用说明另作指标定义勘误，不计作新增改判或36条内容复评。31份原判共1,715条已重算，15项指标及T06/K04/K05未达标结论不变；复检仍不称真人独立审核，详情见已填写结果的reinspection和纠错补充的metricNoteErrata。本次修正尚未提交。
