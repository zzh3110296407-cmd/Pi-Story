# V4 → V5 开书冻结检查

V4：a44db87ad272879275b0b2db30b8889ae8518893。V5产品提交：1f4ea4686b2d11527e5d65593d1130452ff3833f。

- submit_constraints / submit_bible / submit_outline 参数 schema、适配映射及相关辅助定义：逐字一致。文件：story/packages/pi-story/src/tools.ts；V4摘要15967a967f61767885447cb9a0ebdf2ce55d7686d2c47819717a8acc5b00684f；V5摘要15967a967f61767885447cb9a0ebdf2ce55d7686d2c47819717a8acc5b00684f。
- 主笔开书规则：逐字一致。文件：story/packages/pi-story/rules/story-showrunner/SKILL.md；V4摘要5c8edd772183de03a308a089f72d5622a3d10a16da6c4f8eb789432079d68443；V5摘要5c8edd772183de03a308a089f72d5622a3d10a16da6c4f8eb789432079d68443。

OPEN沿用V4：T05=12/12；T06精确率113/126、召回率145/159；T07=50/50。不派发第二次开书测量。

比较范围覆盖完整开书工具定义（含schema与映射）及主笔规则中After opening succeeds之前的全部文本。后续章节输入中的writerLengthFactor不改变大纲目标或开书映射。
