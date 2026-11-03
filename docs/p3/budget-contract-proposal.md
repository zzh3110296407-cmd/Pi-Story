# S6 主笔预算契约缺口与最小调整提案

日期：2026-11-01。作者已明确同意“允许最小预算契约调整”；已实施，S6开发验证及P1全部套件回归通过；正式V4验收待运行。

27 S6要求主笔发出请求前预留，并与内部角色共享预算。原core的BudgetGuard.reserve接受role:string，但具体实现的settle只接受CallRecord，其role仅writer/editor/keeper/verifier。不能在类型层如实结算showrunner。伪装为writer会污染角色归因；只检查不预留会漏掉并行与未持久化义务。

建议只扩展预算结算的类型边界：新增BudgetCallRecord（Omit<CallRecord,'role'> & {role:string}），BudgetGuard的settle及私有待确认表使用此类型；预算统计只读取usage与预留字段。内部角色CallRecord的schema、Role、所有领域校验、角色输入输出均不改。主笔记录只在适配层用于预留结算，已知用量仍以Pi回复条目为权威，持久化后按预留ID确认；未知用量保留预留。补回归：主笔预留阻止内部超额；结算与确认不重复计费；取消保留未知费用；预算变动立即生效。

最初将27的core限制理解为全部源码不改，已向作者说明这项解释过宽：原文冻结的是领域校验。此后作者仍明确授权最小预算类型调整。实际仅放宽具体BudgetGuard的预算记账类型，领域端口与内部角色CallRecord schema不变；新增无副作用check与包含在途/待确认义务的summary，避免另建预算状态。涉及core，按27重跑P1全部套件。
