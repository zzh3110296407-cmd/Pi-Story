# P3-D 作者终端检查（V5）

在V5冻结、确定性检查和正式运行归档后使用。每书2 USD，P3R2累计6.5 USD停止、7.5 USD上限；退出自动归档原生会话及费用。完成前不记为作者通过。

2026-11-03：BOOK已按作者决定以837、527、42三本完整运行收尾，1587/1769和后备不再派发；J3已合并，只有本节的本人交互确认仍待交付。最后一次提供方停止是HTTP402，请先确认DeepSeek余额可用。此检查由作者在真实终端操作；不把它的章节并入已冻结的BOOK质量抽样，费用和真实调用仍需归档审计。执行前工作源码应已提交，书稿建议用Visual Studio Code核对。

在交互式PowerShell中运行，变量名必须带`$`：

```powershell
Set-Location -LiteralPath 'D:\AI\Story Dome\Story\pi-Story'
$env:PI_STORY_WORK_DIR = 'D:\AI\Story Dome\Story\pi-Story\story\testing\exec'
$demo = node story/scripts/eval/p3r2/terminal.ts --prepare | ConvertFrom-Json
node story/scripts/eval/p3r2/terminal.ts --run $demo.config
```

1. 初始提示开一本英文三章故事并写第1章。确认已提交后输入`/intent Emphasize Ada choosing cooperation over working alone.`，按Enter。
2. 输入`/goal 3`，按Enter；再输入`Continue writing toward the goal.`，按Enter。
3. 第2章写手工作时输入`In the rewritten second chapter, Bo gives Ada a blue notebook. Keep chapter 1 unchanged.`，按Enter立即插话。旧尝试应返回INTERJECTED、不提交，随后重写第2章。
4. 重写第2章时输入`In chapter 3, Ada returns the blue notebook to Bo. Apply this after the current chapter.`，按Ctrl+Q排队。第2章应正常提交；请特别确认该消息在第3章开始写之前出现在对话中。
5. 等第3章完成，确认不会自动写第4章，主笔汇报章号、风险与停止原因。输入`/quit`退出，等待返回PowerShell，归档前不要关窗口。

```powershell
Get-Content -LiteralPath (Join-Path $demo.archive 'finalization.json')
Get-ChildItem -LiteralPath (Join-Path $demo.work 'stories\manuscripts') -Filter '*.md'
```

用Visual Studio Code打开书稿，核对第1章未改、第2章获得蓝色笔记本、第3章归还笔记本、合作意图生效、最终只有3章。交回`$demo.archive`路径及实际结果，并确认排队消息是否在下一章开始写前出现。作者确认后才记P3-D及P0 V01/V26完成。
