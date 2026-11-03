# 第三轮判定接口

25 §4的裁判拥有judgments/。执行会话只读，不自填判定或作者认可。J1新增T06-coverage.json、K04-rev20261031.json，历史评分器跳过这两个新解释文件，旧结果不改。该跳过只限历史P2/P2R；V3中的同名J2文件正常读取，不保留文件名禁用名单。

J2可继续用story/p2-judgments@1；需要不适用项时，用story/p2-judgments@2（只接受P2R3运行）。scores中的每项有metric、component、sampleId、runId、pass、status；保留原有身份、时间、理由及证据。

- 适用项pass为true或false。
- 不适用项写applicability="not_applicable"、pass=null和非空reason；不得写false，也不计入评分分母。原文件中仍完整保留，报告单列。
- status为ai_preliminary或author_approved。后者表示作者整体认可，document.approval.evidence必须指向真实批准依据；不表示本人逐项亲审。尚未认可时保留待判状态。
- 同一运行/指标/分项/sampleId不能重复；itemId如存在须等于sampleId，final如存在须等于pass。不能以NA补齐最少样本。

T06按16当日修订的覆盖匹配，K04按词表外谓词及首次物品/组织实体的语义匹配；这些语义由裁判判定，不以字符串算法代替。作者明确只有item:/org:可新建键，char:/place:仍遵守既有D1。

程序入口使用--round3，P2R3评分版本为p2r3-26@1，E02–E05沿用V2，不作为本轮CHAP的新待判指标；E01/E06仍重测。历史P2/P2R评分版本不变。

2026-11-01作者改单轮后，当前派生汇总版本为p2r3-26-single@1，只取第一次完整OPEN、CHAP、KEEP，最少样本按修订26减半向上取整；原始评分版本及通过比例不改。OPEN批准视图即使有两次702项，正式只取第一次349项，不从第二次借样本。CHAP首轮判定归属P2R3-COMPOSITION/20261031T154922Z-102c3ed-r1-complete；KEEP为P2-KEEP/20261101T015406Z-102c3ed-r1。三个物理CHAP段不再重复判同一正文，费用仍各计一次。

抽样单位继承20 §5：W04至少10章，按固定种子选章，每章全部大纲要点逐项判定，不能用单章10个要点冒充10章；E06仍判全部复查结论，至少10条。K03/K05/K06/K07按分层样本判定，各自至少50个适用项，每类至少8、不足则全取；NA不占对应分母，不足适用样本时补取并保留固定种子、身份与全部原判。已经完成的更多首轮判定不丢弃。新作者认可视图应与原ai_preliminary文件分开保存并绑定源哈希，供执行会话显式选取，避免原始metrics被覆盖或重复计分。
