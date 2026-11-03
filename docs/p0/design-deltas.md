# P0 设计差异

日期：2026-10-28。此处记录执行差异和实测结果，不修改现行方案。

## 路径与现有仓库

14 中的目标目录已改为 pi-Story，但 §1.1 的整个 Story Dome 只读、§1.5 的 story-forge、§3 的 pi-Story 测试根和残缺的 S0.2 仍不一致。本次以作者指定的现有目标仓库为代码位置，沿用既有 Git 和上游文件；所有运行产物统一使用 D:\开源\test\pi-Story\p0。fixtures 与 node_modules 在目标下仅为指向 D 盘隔离内容的 junction，均已忽略，不提交测试数据。

## 模型目录也需要固定

固定提交的普通 npm run build 成功，但它刷新在线模型目录。随后完整 npm run check 因旧测试引用的型号不在新目录中而失败，例如 mimo-v2.5-pro。 tracked Pi 源码没有变化，变化来自 ignored 的 providers/data JSON。

执行取舍：复制同一固定提交参考仓库中的43份已水合 JSON 数据，记录逐文件 SHA-256；用 npm run build:offline 构建，再执行完整 npm run check，均成功。未给 Pi 打补丁。复现需要同时固定提交与这份目录快照，不能只固定 Git 提交而每次拉最新目录。

## 许可证与提交

目标本身为 Pi 上游仓库。按S0的AGPL选择设置根LICENSE和探针许可，同时将原MIT全文保留在LICENSE.pi并记录THIRD_PARTY_NOTICES。README增加P0入口，原上游说明继续保留；没有用新说明覆盖上游源码与归属。

逐项提交已由作者执行 P0 的指令授权；沿用现有 main，不创建任务分支。只暂存当前任务文件，不推送远程。

## V07 文件确认与承诺范围

只读会话文件的实测中，Pi 发出 tool_execution_end、message_end 并正常 settled，get_entries 内存可见1条提交，但磁盘0条，文件字节未变。不能依靠“工具失败时Pi会可靠报错”来实现保存回执；适配层必须读文件确认，确认失败时结束该故事进程并从文件重建。V28 单独验证桥接的这条替代路径。

20次5MiB提交的强杀都落在工具结束后、写入前；20次文件中都没有本章且没有残行。这只覆盖指定窗口，不证明任意写入中断或掉电耐久。残行样例重开可继续，父链合法，但原文件仍保留1条无效行；“丢弃残行”应理解为加载时忽略，不能写成物理删除。

两个Pi进程原生均可打开并写同一个会话。探针适配器使用独占创建的锁，在启动第二个Pi之前拒绝，已实测。产品应沿用适配层单写者限制。

## V22 空白会话的控制条目

首次普通对话前，扩展命令虽可handled并在get_entries内存视图中出现控制条目，Pi却不创建会话文件。源码session-manager.ts的_hasConversation要求至少一条普通user或assistant消息。未初始化夹具在实际等待十分钟并成功回答后，由文件核对捕获ENOENT，不能宣称已保存。

修正夹具先完成一轮替身对话，确认文件存在再开始十分钟等待；实际600005.8641ms后回答并核对文件通过，证据见ADR-010。正式新故事在首条普通消息前接受作者控制命令时，也必须定义保存回执；不能把handled解释为持久化成功。这里未修改Pi或替产品另建权威状态。

## V18 请求取消

before_provider_request中的throw会被捕获，请求仍然发出；V18的ctx.abort对照在HTTP之前实际取消。探针预算开关同步改为ctx.abort，并增加实际派发边界回归。不能把payload已准备的日志当作已经发送；V12分别记录preparedPayloads与providerDispatches。

## V19 结构化输出与修复

thinking low加forced tool_choice在本次API实测中返回400；不能根据supportsStrictMode元数据宣称这一组合可用。原JSON组2048输出上限经一次修复仍只有25/30。提高上限后的独立JSON组首轮23/30，一次附validator错误路径的模型修复后30/30，因此按13允许的JSON与一次修复方式落地，结论为不成立·已用替代。

先导混用了State层字段，未进入正式成功率；所有费用保留。三章重复结果只支持格式和句号引用范围，不证明语义提取正确。业务合同与来源范围见ADR-008。

## V25 网页组件边界

完整ui-primitives清单及invariant companion仍有Cordis peer/type import，不能按包描述宣称整包零依赖。按13允许的替代，只取Markdown闭包与clipboard.ts并保留MIT，独立构建及真实中文渲染已通过。其余layout、sidebar、theme的slot、workspace/session与设置装配需要替换，静态清单和估算见ADR-011。

独立构建有大chunk警告；没有用提高警告阈值掩盖。P6须按实际需要裁剪语法高亮和评估加载成本，本次不承诺产品加载性能。
