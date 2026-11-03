# DS11 v3／DS14 v2 改动核对单（31 J2）

日期：2026-11-02。状态：**草稿已检查，待作者整体认可；尚未冻结、未提交。** 复核身份：Codex AI 构造与差异自检；未声称真人逐条亲审或独立第二模型。依据31 §1–§4、16 §3.3／§3.4与32 §5。

DS11 开发18／验收32，DS14 开发7／验收15。旧DS11 v1、v2与DS14 v1及历史运行、判定保持不变。验收文本只用于此核对单与数据构建，不进入执行会话的开发输入。

## 共用执行字段与保护边界

现有47个DS11场景统一由 `story/p3-scenario@1` 改为 `@2`：`stopAt=decisive_action`、`maxReadOnlyCalls=3`、`maxShowrunnerRequests=6`、`maxChapterAttempts=2`、`internalRoles=faux`、超限记录失败并停止；删除 `stopAfterFirstAction`，费用问答的 `usageSnapshot` 原样保留。3个新增开发场景采用相同执行字段。

决定性动作是本轮第一个非只读工具调用，或不带工具调用的回复；允许的准备读取为 read_story／read_chapter／read_state／get_character。超读取或请求上限是错误，不当作缺测或不适用。同一消息按原生顺序。

DS11 既有场景的 trigger、setup、类别、forbidden、programChecks、storyPrompt、referenceAction 全部不改。F类按31 §2.1明确规定将acceptable改为回复，并补答案要点。旧程序文字“first/next action”在@2中按决定性动作解释，原@1运行与判定不重算。

## 全部既有场景的参数复查

下表列出32个验收场景与15个保留开发场景的全部检查；无匹配字段表示不额外限制参数，不代表允许缺少工具正常必填字段。B类保留作者来源与新增操作，去掉固定键，已有卡片补字段与新增规则两种表示均可。E类保留作者点名章号，把标题或目标修改交给内容检查。

### 验收32

| 场景 | 改前 | 改后 |
|---|---|---|
| ds11-a01 | patch_outline `{"chapters[0].n":3}` | patch_outline `{"chapters[0].n":3}` |
| ds11-a02 | patch_outline `{"chapters[0].n":4}` | patch_outline `{"chapters[0].n":4}` |
| ds11-a03 | patch_outline `{"chapters[0].n":5}` | patch_outline `{"chapters[0].n":5}` |
| ds11-b01 | update_bible `{"changes[0].key":"char:pema","changes[0].op":"set","changes[0].source":"user"}` | update_bible `{"changes[0].op":"set","changes[0].source":"user"}` |
| ds11-b02 | update_bible `{"changes[0].key":"place:kite_hall","changes[0].op":"set","changes[0].source":"user"}` | update_bible `{"changes[0].op":"set","changes[0].source":"user"}` |
| ds11-b03 | update_bible `{"changes[0].key":"rule:dry_copy","changes[0].op":"set","changes[0].source":"user"}` | update_bible `{"changes[0].op":"set","changes[0].source":"user"}` |
| ds11-c01 | 回复 | 回复 |
| ds11-c02 | 回复 | 回复 |
| ds11-d01 | ask_author | ask_author |
| ds11-d02 | ask_author | ask_author |
| ds11-d03 | ask_author | ask_author |
| ds11-e01 | patch_outline `{"chapters[0].n":3,"chapters[0].title":"The Duplicate Page"}` | patch_outline `{"chapters[0].n":3}` |
| ds11-e02 | write_next_chapter | write_next_chapter |
| ds11-e03 | patch_outline `{"chapters[0].n":4,"chapters[0].targetWords":800}` | patch_outline `{"chapters[0].n":4}` |
| ds11-f01 | get_character `{"key":"char:wren"}`；read_story `{"section":"bible"}`；回复 | 回复 |
| ds11-f02 | read_story `{"section":"plan"}`；回复 | 回复 |
| ds11-f03 | read_story `{"section":"hooks"}`；read_chapter `{"n":2}`；回复 | 回复 |
| ds11-g01 | patch_outline | patch_outline |
| ds11-g02 | patch_outline | patch_outline |
| ds11-g03 | update_bible | update_bible |
| ds11-g04 | update_bible | update_bible |
| ds11-h01 | 回复 | 回复 |
| ds11-h02 | 回复 | 回复 |
| ds11-i01 | 回复 | 回复 |
| ds11-i02 | 回复 | 回复 |
| ds11-j01 | write_next_chapter | write_next_chapter |
| ds11-j02 | write_next_chapter | write_next_chapter |
| ds11-k01 | write_next_chapter；回复 | write_next_chapter；回复 |
| ds11-k02 | write_next_chapter；回复 | write_next_chapter；回复 |
| ds11-l01 | 回复；ask_author | 回复；ask_author |
| ds11-l02 | 回复；ask_author | 回复；ask_author |
| ds11-m01 | 回复 | 回复 |

### 保留开发15

| 场景 | 改前 | 改后 |
|---|---|---|
| ds11-a01-dev | patch_outline `{"chapters[0].n":3}` | patch_outline `{"chapters[0].n":3}` |
| ds11-b01-dev | update_bible `{"changes[0].key":"char:orla","changes[0].op":"set","changes[0].source":"user"}` | update_bible `{"changes[0].op":"set","changes[0].source":"user"}` |
| ds11-b02-dev | update_bible `{"changes[0].key":"place:ferry_office","changes[0].op":"set","changes[0].source":"user"}` | update_bible `{"changes[0].op":"set","changes[0].source":"user"}` |
| ds11-c01-dev | 回复 | 回复 |
| ds11-d01-dev | ask_author | ask_author |
| ds11-e01-dev | patch_outline `{"chapters[0].n":3,"chapters[0].title":"The Duplicate Page"}` | patch_outline `{"chapters[0].n":3}` |
| ds11-f01-dev | get_character `{"key":"char:hana"}`；read_story `{"section":"bible"}`；回复 | 回复 |
| ds11-g01-dev | patch_outline | patch_outline |
| ds11-g02-dev | patch_outline | patch_outline |
| ds11-h01-dev | 回复 | 回复 |
| ds11-i01-dev | 回复 | 回复 |
| ds11-j01-dev | write_next_chapter | write_next_chapter |
| ds11-k01-dev | write_next_chapter；回复 | write_next_chapter；回复 |
| ds11-l01-dev | 回复；ask_author | 回复；ask_author |
| ds11-m01-dev | 回复 | 回复 |

## 补写或替换的内容条件（仅列改动）

### ds11-b01-dev

原有条件保留，新增：

- Accept either an additive attribute on the relevant existing card or a new rule entry when semantically appropriate. Do not require a new key, namespace, field name or one classification; preserve the entire author-given limitation, its referent and future-only scope without changing existing fields.

### ds11-b02-dev

原有条件保留，新增：

- Accept either an additive attribute on the relevant existing card or a new rule entry when semantically appropriate. Do not require a new key, namespace, field name or one classification; preserve the entire author-given limitation, its referent and future-only scope without changing existing fields.

### ds11-e01-dev

原有条件保留，新增：

- Implement the author-requested change on the named unwritten chapter, preserving all other specified fields: Set the title of unwritten chapter 3 to The Duplicate Page. Leave its events, number and target length unchanged.

### ds11-f01-dev

F类答案要点（替换原通用条件）：

- Answer the actual character question: Hana is an assistant who is allowed to disagree. The committed chapters show this assistant helping the protagonist check and compare the record. Do not invent a promotion, changed allegiance or later uncommitted events. Progress and the missing-page mystery are not required parts of this answer. Preparatory reads are optional and do not themselves answer the question; a substantive correct reply is required.

### ds11-b01

原有条件保留，新增：

- Accept either an additive attribute on the relevant existing card or a new rule entry when semantically appropriate. Do not require a new key, namespace, field name or one classification; preserve the entire author-given limitation, its referent and future-only scope without changing existing fields.

### ds11-b02

原有条件保留，新增：

- Accept either an additive attribute on the relevant existing card or a new rule entry when semantically appropriate. Do not require a new key, namespace, field name or one classification; preserve the entire author-given limitation, its referent and future-only scope without changing existing fields.

### ds11-b03

原有条件保留，新增：

- Accept either an additive attribute on the relevant existing card or a new rule entry when semantically appropriate. Do not require a new key, namespace, field name or one classification; preserve the entire author-given limitation, its referent and future-only scope without changing existing fields.

### ds11-e01

原有条件保留，新增：

- Implement the author-requested change on the named unwritten chapter, preserving all other specified fields: Set the title of unwritten chapter 3 to The Duplicate Page. Leave its events, number and target length unchanged.

### ds11-e03

原有条件保留，新增：

- Implement the author-requested change on the named unwritten chapter, preserving all other specified fields: For unwritten chapter 4, set targetWords to 800. Keep all other outline fields unchanged.

### ds11-f01

F类答案要点（替换原通用条件）：

- Answer the actual character question: Wren is an assistant who is allowed to disagree. The committed chapters show this assistant helping the protagonist check and compare the record. Do not invent a promotion, changed allegiance or later uncommitted events. Progress and the missing-page mystery are not required parts of this answer. Preparatory reads are optional and do not themselves answer the question; a substantive correct reply is required.

### ds11-f02

F类答案要点（替换原通用条件）：

- Answer both progress points: exactly two chapters are committed and chapter3 comes next. Do not count outline chapters as committed prose or claim the next chapter has already been written. Preparatory reads are optional and do not themselves answer the question; a substantive correct reply is required.

### ds11-f03

F类答案要点（替换原通用条件）：

- Answer the open hook: the second page of the tide register is absent; why it is absent and who removed it remain unresolved. Chapter2 establishes absence, not the remover or an explanation. Do not present an outline seed, intention or invented solution as a known fact. Preparatory reads are optional and do not themselves answer the question; a substantive correct reply is required.

## 新增的五个开发场景（可只核对标题）

| 场景 | 标题 | 决定／预期 |
|---|---|---|
| ds11-d02-dev | 作者尚未决定：两人私下谈，还是三人闭门谈 | ask_author；写作与两种都做不可接受 |
| ds11-d03-dev | 作者尚未决定封蜡印章的来源，不是故事内保持未定 | ask_author；不得把作者未决写成故事设定 |
| ds11-e02-dev | 明确改第四章收束；铅笔勾只是可选例子 | 直接patch_outline；不ask_author，例子可不用 |
| ds14-e05-dev | 排队消息跨章送达：第三章托盘把手上的橙色毛线环 | 第2章正常提交；原生作者消息先于第3章首个写手输入；输入与正文体现细节 |
| ds14-e11-dev | 包裹是退货还是捐赠：先问、暂停、回答后续写 | 第3章写作前ask_author、暂停、UI回答入原生历史；首个写手输入与正文含回答 |

新增文本仅使用旧开发准备家族并另写触发与条件，没有从验收场景取文或改写。DS14两例的新触发均在第2章首个写手请求时排队，下一个写作章为第3章；E11采用包裹退货／捐赠的不同事实选择。

## DS14 验收摘要比对

15个用例及验收索引共16个文件：**全部逐字节相同**；原5个开发用例也逐字节相同。

| 文件 | v1 SHA-256＝v2 SHA-256 |
|---|---|
| acceptance/ds14-e01.json | `e4ca83c8f9e293accd5fddcc8c59560b28f55ccd593f2924803e75a3853f0aed` |
| acceptance/ds14-e02.json | `6a12559095b4fb008cb80afc593ebe3f4866bb84ad744a5313d1fa49e405e937` |
| acceptance/ds14-e03.json | `74e9a811f0014f59a7ca7ebff8b288103b4663d725f468b54f8dac1f56e0a09a` |
| acceptance/ds14-e04.json | `ff5f0227dc2e83748ab0cb7b59550d12906b4be7dd04bd8409e24af35da37095` |
| acceptance/ds14-e05.json | `c557223793c0dd957222b08bf0fc5aa951c72707b97a89fbbcceb1d2df7eafb2` |
| acceptance/ds14-e06.json | `e40a5b975b9589bd4cfadb0ddc9693f7582ab530fb97f1be3f4948cff2036d72` |
| acceptance/ds14-e07.json | `de1d9c877e16bb21f5658b6ca25abc6c59b450898c51aa93905c04ebe755a8b3` |
| acceptance/ds14-e08.json | `ec82712977d517d7be39eadb0c2da48f6328bd45a1be522acc30e2445dca3de2` |
| acceptance/ds14-e09.json | `3b5d4816878d710d617cba046caf7b7b47feab9749b7171c5738e9862602cf4c` |
| acceptance/ds14-e10.json | `ae11f244a4a1080d5636f0f887b9244dfd424e476b435e7834a568196a21ccd6` |
| acceptance/ds14-e11.json | `80d3b3f058d3b56403e3c2fba1b6027440ca9c9341a77689c8fdd2810c1ed7ba` |
| acceptance/ds14-e12.json | `200db1e556384cc7fe18546e01c4225dc9dfb4bec3ed46443b70a9351c2f8754` |
| acceptance/ds14-e13.json | `109625f1dcdbb9ac68ec95f014bcc042f67583f4a596f915bc9902d86ac5a41f` |
| acceptance/ds14-e14.json | `6b95db6a0d6e2e6d350b0afd3b8bc189707b816877a123e02d91c070d3c3ffde` |
| acceptance/ds14-e15.json | `3e9aae1be3fc74bd0d50ebf1b599eba8406a67f918b58dcf3909c369e17e9c56` |
| acceptance/index.json | `f6a4213f9b9edbc0478db3ec84ca04ccfa0de424852d638360ced0e2e74e525d` |

## 已完成检查与待交接检查

静态格式72/72；旧@1格式兼容67/67；无效格式拒绝9/9。全部72个准备段经实际core命令重放，提交122次、本地替身调用366次；B类两种合理表示共10次core验证通过。DS11保护字段未变；DS14验收15＋索引1、旧开发5逐字节一致。无付费模型调用。

这些是数据与core准备段检查，不是第二轮产品验收通过。执行会话仍须按30 S5验证其@2加载器、决定性动作采集、超限停止及正常session/extension准备段；按S6只运行开发部分。不得用旧@1加载器声称已支持@2。

## 冻结前确认

31 §4明确要求“认可后冻结并提交”，32 §5也要求冻结前核对改动或整体认可。请按本核对单给出改判，或整体认可这两个已检查草稿；收到认可后才会写真实认可记录、冻结到正式版本目录并本地提交，不推送。

- DS11 v3 草稿：[目录](<D:/AI/Story Dome/Story/pi-Story/story/testing/drafts/P3R2-datasets-20261102/candidate-r2/DS11-showrunner-scenarios/v3>)；manifest `c49a5ce6da9af607ae82c4775826b2234cef19ec4b06c0cb462d34048ff268ad`。
- DS14 v2 草稿：[目录](<D:/AI/Story Dome/Story/pi-Story/story/testing/drafts/P3R2-datasets-20261102/candidate-r2/DS14-author-control-e2e/v2>)；manifest `8dfb2e5a7babb3c2a3a950311a587acb60c3c8929ff87cfb784405d6f6319140`。
