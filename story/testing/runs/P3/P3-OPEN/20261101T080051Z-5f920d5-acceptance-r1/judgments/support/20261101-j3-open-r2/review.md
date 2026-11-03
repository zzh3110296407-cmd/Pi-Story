# P3 J3 OPEN r2 修订复核（待整体认可）

2026-11-01。Codex（AI）按用户逐项检查反馈核对原始证据并修订。原初判提交 `5c44fe8e758251e7a13f1b67990c0351c0a990ec` 及全部原文件保留。

| 指标 | r2结果 | 门槛 | 状态 |
|---|---:|---:|---|
| T06精确率 | 113/126 = 89.68% | ≥85% | 数值达标，待整体认可 |
| T06召回率 | 145/159 = 91.19% | ≥80% | 数值达标，待整体认可 |
| T07来源正确率 | 50/50 = 100% | ≥90% | 数值达标，待整体认可 |

335项及原固定抽样不变；333项结论维持、2项从正确改为错误，另1项只更正理由。0项不适用。不改原始证据、测试集、原metrics或已提交初判，不调用付费模型。

用户回复为“建议先修正，再整体认可”，因此当前没有记录作者整体认可或生成author_approved计分文件。

## 三处修订

### T07/source 1253:rule:thirty_nights

原判：True；现判：True；类别：reason_only_erratum。

更正后理由：一个月试炼来自作者；朔月至朔月、不得在屋顶下睡觉、不得说出爱人的名字及违约转债等具体条款是AI创设，整项model正确。

证据：session第9行；entry `fc9a8669`；toolCall `call_00_kSuyGDmCeeXg8vvGwK3m4175`；原始压缩SHA256 `8649f5648a669d29f5ecd53d579317bb0209b756764e76f22d32866d3c35c359`。

原始规则短语：`must not sleep under a roof`。这是禁止在屋顶下睡觉，未禁止睡眠本身。

整项继续标model：作者给定试炼一个月，但该具体规则由模型扩写。

### T06/precision 378:L-5

原判：True；现判：False；类别：verdict_correction。

更正后理由：作者只称隔壁双方为couple，没有指定婚姻身份；L-5将其写为“夫妻”，新增已婚限定，缩窄人物关系的允许范围。原话引用正确不能抵消台账正文新增的条件。

证据：session第7行；entry `138f0b3d`；toolCall `call_00_QF0g2ehymF6ollTqFJ2C9658`；原始压缩SHA256 `5315bc1f6f3abac378b5de5586a01b3800269795bbe9799b85cc8ea354ae3b39`。

作者原话：Show how this discovery reshapes his assumptions about intimacy, privacy, and the couple next door

实际台账：故事要展现这一发现如何重塑他对亲密关系、隐私以及隔壁那对夫妻的既有假设。

### T06/recall 378:378-g10

原判：True；现判：False；类别：verdict_correction。

更正后理由：金标要求发现改变主角对隔壁那对couple的假设；唯一候选L-5改成对“夫妻”的假设，加入原提示未给出的婚姻身份，缩窄该主体关系条件，不能算完整且不改范围的覆盖。

证据：session第7行；entry `138f0b3d`；toolCall `call_00_QF0g2ehymF6ollTqFJ2C9658`；原始压缩SHA256 `5315bc1f6f3abac378b5de5586a01b3800269795bbe9799b85cc8ea354ae3b39`。

金标：Show the discovery changing his assumptions about the neighbouring couple.

候选L-5：故事要展现这一发现如何重塑他对亲密关系、隐私以及隔壁那对夫妻的既有假设。

匹配项现为空；L-5仅保留为未命中的候选证据。

## 完整判定与历史

本目录items.json为修订后的全部335项完整视图，T06-preliminary.json及T07-preliminary.json为同步归一化初判，均保持ai_preliminary。原有逐项阅读版保持历史快照，不用旧表覆盖本次修订。

原24份压缩证据与其余固定原输入摘要一致。执行会话已更新V4.json行政测量来源记录；该外部变化单独记录，未覆盖原输入pin，不影响本次两处原始证据与固定抽样。

按29 §4，需作者整体认可修订后的完整批次，才能另行交付正式计分文件；不把本次改判建议当作整体认可。
