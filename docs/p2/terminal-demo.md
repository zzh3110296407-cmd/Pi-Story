# P2作者终端检查

状态：作者于2026-10-30实际运行并确认交互终端、开书写章与书稿三个结果符合预期，P2-D通过。会话及书稿证据见[演示归档](../../story/testing/runs/P2/P2-DEMO/20261030T025618Z-terminal-demo/run-manifest.json)。下列命令保留供复现，本轮不需要再次执行付费演示。不要在作者日常Pi目录中运行。

以下命令在PowerShell执行。DEEPSEEK_API_KEY须已由作者通过环境变量提供；不把它填入命令、文件或聊天。

```powershell
Set-Location -LiteralPath 'D:\AI\Story Dome\Story\pi-Story'
if (-not $env:DEEPSEEK_API_KEY) { throw 'DEEPSEEK_API_KEY未设置' }
$env:PI_STORY_WORK_DIR = 'D:\AI\Story Dome\Story\pi-Story\story\testing\exec'
$env:TEMP = 'D:\AI\Story Dome\Story\pi-Story\story\testing\exec\temp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$env:NODE_COMPILE_CACHE = 'D:\AI\Story Dome\Story\pi-Story\story\testing\exec\node-compile-cache'
$env:PI_OFFLINE = '1'
$env:PI_TELEMETRY = '0'
$demo = node story/scripts/eval/p2/main.ts --prepare-demo | ConvertFrom-Json
$env:PI_CODING_AGENT_DIR = $demo.agentDir
Set-Location -LiteralPath $demo.work
node 'D:\AI\Story Dome\Story\pi-Story\story\testing\exec\pi\packages\coding-agent\dist\cli.js' `
  --offline --no-extensions --no-skills --no-prompt-templates --no-themes `
  --no-context-files --no-builtin-tools --no-mcp `
  --extension 'D:\AI\Story Dome\Story\pi-Story\story\packages\pi-story\src\index.ts' `
  --model deepseek/deepseek-flash --thinking low `
  --session-dir (Join-Path -Path $demo.work -ChildPath 'sessions') `
  --name 'P2 terminal check' `
  'Write a ten-chapter English mystery about Ada arriving at a flooded harbor. Ada must survive. Target 1200 words per chapter. Open the book and write only the first chapter now.'
```

每次准备命令生成独立的terminal-demo-*目录，使用当前冻结参数，保留旧设置和会话。预期：终端可见三项开书提交、标准写章进度及第1章提交回执；本轮结束，不自动写第2章。`$demo.storiesDir`下的故事文件包含第1章正文，原始会话保留在该演示目录的sessions下。若写盘通知失败，应保留会话并反馈错误，不把草稿预览当成已写入书稿。

作者已明确确认“三个结果均符合预期，确认通过”。程序核对第1章成功提交，书稿包含完整的已提交正文；7次主笔请求与3次内部调用的已知费用0.033602136美元已归档并补入P2总账。原交互命令未使用正式HTTP测量驱动，费用从原会话和CallRecord事后恢复，未补造输入来源或请求体；缺失的独立核对证据继续计入全部真实运行门槛。P2-D通过不代表P2整体通过，最终状态以外部P2验收报告为准。`--offline`只关闭启动时联网，不关闭显式模型请求。
