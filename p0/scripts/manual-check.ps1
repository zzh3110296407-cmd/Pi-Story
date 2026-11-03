# Reproduce: pwsh -File p0/scripts/manual-check.ps1 -CheckId V26
param([ValidateSet('V01','V26')][string]$CheckId = 'V01')
$ErrorActionPreference = 'Stop'
$testRoot = 'D:\开源\test\pi-Story\p0'
$runDir = Join-Path $testRoot ('runs\' + $CheckId + '\manual-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$scriptFile = Join-Path $runDir 'script.json'
if ($CheckId -eq 'V01') {
    $turns = @(@{content=@(@{type='toolCall';id='manual-write';name='probe_write';arguments=@{n=101}})},@{text='Manual write finished.'})
    Write-Host 'Enter a message. Confirm that probe_write succeeds and a session file is saved.'
} else {
    $turns = @(@{content=@(@{type='toolCall';id='manual-slow';name='probe_slow';arguments=@{ms=30000}})},@{text='Manual interjection observed.'})
    Write-Host 'Enter a message to start probe_slow. While it is waiting, enter another message.'
    Write-Host 'Confirm that the slow tool returns INTERJECTED; inspect the input event in events.jsonl.'
}
$json = @{turns=$turns} | ConvertTo-Json -Depth 12
$secret = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','Process')
if (($secret -and $json.Contains($secret)) -or $json -match 'sk-[A-Za-z0-9_-]{20,}') { throw 'Secret detected: fixture not saved' }
[IO.File]::WriteAllText($scriptFile,$json,[Text.UTF8Encoding]::new($false))
$env:PROBE_RUN_DIR = $runDir
$env:PROBE_SCRIPT = $scriptFile
$extension = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\ext\probe'))
$launch = @('--session-dir',(Join-Path $runDir 'sessions'),'--no-builtin-tools','-ne','-e',$extension,'-ns','-np','-nc','--provider','probe-faux','--model','script')
Write-Host "Evidence: $runDir"
Push-Location -LiteralPath $runDir
try { & (Join-Path $PSScriptRoot 'pi.ps1') @launch }
finally { Pop-Location }
