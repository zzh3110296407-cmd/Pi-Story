# P3-D 作者终端检查

本页命令在P3产品V4冻结并完成正式运行后使用；当前尚不记为作者通过。运行使用独立执行目录、固定Pi的真实交互界面及P3费用账，每次先核对余额，每本上限2USD，阶段12USD停止/15USD总上限。完成后退出会自动归档原生会话和费用。

在交互式PowerShell中运行（第一行变量名带`$`）：

```powershell
Set-Location -LiteralPath 'D:\AI\Story Dome\Story\pi-Story'
$env:PI_STORY_WORK_DIR = 'D:\AI\Story Dome\Story\pi-Story\story\testing\exec'
$demo = node story/scripts/eval/p3/terminal.ts --prepare | ConvertFrom-Json
node story/scripts/eval/p3/terminal.ts --run $demo.config
```

1. 初始提示会开一本新的英文三章故事并写第1章。等第1章确认提交后输入`/intent Emphasize Ada choosing cooperation over working alone.`并按Enter。
2. 输入`/goal 3`并按Enter，再输入`Continue writing toward the goal.`并按Enter。
3. 看到第2章写手正在工作时，输入`In the rewritten second chapter, Bo gives Ada a blue notebook. Keep chapter 1 unchanged.`并按Enter。这是“立即插话”：旧第2章尝试应返回INTERJECTED，不提交；随后重写仍为第2章。
4. 在重写的第2章正在工作时，输入`In chapter 3, Ada returns the blue notebook to Bo. Apply this after the current chapter.`并按**Ctrl+Q**。固定Pi在Windows的默认followUp键是Ctrl+Q；它应排队等待本轮结束，第2章正常提交，后续第3章体现该要求。
5. 等到目标3章完成，确认不会自行写第4章；观察主笔汇报的章号、风险与停止原因。退出使用`/quit`并按Enter，等待返回PowerShell。不要在退出归档前关闭窗口。

返回PowerShell后查看归档与书稿：

```powershell
Get-Content -LiteralPath (Join-Path $demo.archive 'finalization.json')
Get-ChildItem -LiteralPath (Join-Path $demo.work 'stories\manuscripts') -Filter '*.md'
```

用Visual Studio Code打开上一步列出的书稿，核对第1章未改、蓝色笔记本出现在重写后的第2章及第3章、合作意图被遵守、最终只有3章。请向执行会话交回`$demo.archive`的路径，并确认交互过程及书稿是否符合预期；若失败，说明发生在哪一步。作者确认后才记录P3-D及P0遗留V01/V26通过。
