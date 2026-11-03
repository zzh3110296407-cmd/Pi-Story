# ADR-017 Pi扩展依赖与会话适配

日期：2026-10-29。P2执行中的决定；行为证据随步骤补充。

## 固定构建与依赖

沿用ADR-001的Pi提交b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6，使用prepare-p2.mjs导出本地Git对象，在D:/开源/test/pi-Story/p2/exec/pi中安装并离线构建。模型目录取P0快照，先核对manifest逐文件摘要。源码仓库packages/保持只读。

pi-story以file:依赖引用该构建的pi-ai与pi-coding-agent，均为1.2.0；直接使用原包的dist与依赖，不拷贝上游源码进业务包，不发布本地路径依赖。准备构建是安装Story依赖的前提。项目依赖装在exec/runtime，story/node_modules只切换junction目标，旧P1运行时保留。除固定Pi依赖外未新增第三方依赖，TypeBox沿用1.3.27。

## 分支与同批追踪

固定Pi的SessionMessageEntry含entry.id与message；assistant消息含toolCall.id。agent-loop.ts的streamAssistantResponse先await message_end，agent-session.ts的_handleAgentEvent在message_end分支appendMessage，随后才执行工具。适配层用执行上下文的getBranch找到包含当前toolCallId的assistant条目，按该条目ID共享batch.committed；不按整个作者回合共享，避免错误阻止后续助手回复。找不到来源时拒绝执行，不默认为新批次。

E2验证：原生faux产生作者回合，适配后与core直接折叠逐字段一致；缓存接收后续Story自定义条目，丢弃其他自定义条目；外来工具及读取工具复制提交schema均不能注入正史。同一助手条目的两个调用共享标记，新助手条目重置。回执包装另检查返回时的取消信号，取消后删除成功宏的commit、保留已知用量并以失败结果交给Pi持久化。真实开书与提交工具的SDK路径在E4/E7继续验证。

## 边界

只允许pi-story依赖core与Pi；不依赖bridge、web、runner或evals。真实模型调用与测量留到E12/E13，SDK测试只使用Pi原生faux提供方。
