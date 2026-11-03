# Reproduce: powershell -File p0/scripts/pi.ps1 --help
$ErrorActionPreference = 'Stop'
$runtimeRoot = 'D:\开源\test\pi-Story\p0'
$env:PI_CODING_AGENT_DIR = Join-Path $runtimeRoot 'agent-home'
$env:TEMP = Join-Path $runtimeRoot 'temp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$env:NPM_CONFIG_CACHE = Join-Path $runtimeRoot 'cache\npm'
$piRoot = Join-Path $runtimeRoot 'pi'
$resolver = ([Uri](Join-Path $piRoot 'packages\coding-agent\src\experimental\source-resolver.ts')).AbsoluteUri
$cli = Join-Path $piRoot 'packages\coding-agent\src\cli.ts'
& node --import $resolver $cli @args
exit $LASTEXITCODE
