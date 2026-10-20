#!/usr/bin/env pwsh
#Requires -Version 7.0
<#
.SYNOPSIS
  scripts/ops 公共函数。只做进程调用、报告与安全检查；不读取/打印任何密钥。

.NOTES
  被 backup.ps1 / restore.ps1 / drill.ps1 dot-source。
  设计约束（docs/20 §4/§5、docs/16 §7）：
    - 所有命令执行结果只汇总为文本，不做二进制管道；
    - 报告只记录对象、方式、字节、耗时、排除项、失败项，不记录内容；
    - 删除/覆盖类动作必须显式 -Force（等价 -Confirm:$false 语义）。
#>

function Get-DssaasRepoRoot {
    param([string]$ScriptDir)
    return (Resolve-Path (Join-Path $ScriptDir '../..')).Path
}

function ConvertTo-DockerContext {
    param([string]$DockerCommand)
    $parts = $DockerCommand.Trim() -split '\s+'
    if ([string]::IsNullOrWhiteSpace($parts[0])) {
        throw 'DockerCommand 不能为空'
    }
    return [pscustomobject]@{
        Exe    = $parts[0]
        Prefix = @($parts | Select-Object -Skip 1)
    }
}

<#
.SYNOPSIS
  把 Windows 路径转换为 Docker（在 WSL 内运行时）可识别的宿主路径。
  例：D:\DSSAAS\backups\a.dump -> /mnt/d/DSSAAS/backups/a.dump
  仅当 DockerCommand 以 wsl 开头时转换；本机 Docker Desktop 路径原样返回。
#>
function ConvertTo-DockerHostPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        $DockerContext
    )
    if ($null -eq $DockerContext -or $DockerContext.Exe -notmatch 'wsl') { return $Path }
    $p = $Path -replace '\\', '/'
    if ($p -match '^([A-Za-z]):/(.*)$') {
        return '/mnt/' + $Matches[1].ToLowerInvariant() + '/' + $Matches[2]
    }
    return $p
}

function Invoke-Process {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [string[]]$Arguments = @()
    )
    $out = & $Exe @Arguments 2>&1
    $code = $LASTEXITCODE
    $text = ($out | ForEach-Object { "$_" }) -join "`n"
    return [pscustomobject]@{
        ExitCode = $code
        Output   = $text
    }
}

function Invoke-Docker {
    param(
        [Parameter(Mandatory = $true)]$DockerContext,
        [string[]]$Arguments = @()
    )
    return Invoke-Process -Exe $DockerContext.Exe -Arguments (@($DockerContext.Prefix) + $Arguments)
}

function Format-Bytes {
    param([Nullable[long]]$Bytes)
    if ($null -eq $Bytes) { return 'n/a' }
    if ($Bytes -ge 1GB) { return ('{0:N2} GiB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N2} MiB' -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ('{0:N2} KiB' -f ($Bytes / 1KB)) }
    return ('{0} B' -f $Bytes)
}

function Write-JsonReport {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Report
    )
    $json = $Report | ConvertTo-Json -Depth 8
    Set-Content -LiteralPath $Path -Value $json -Encoding utf8
    return $Path
}

function Write-StepLine {
    param($Step)
    $status = switch ($Step.status) {
        'success' { '✔' }
        'failed' { '✖' }
        'skipped' { '↷' }
        default { '·' }
    }
    $detail = if ($Step.detail) { " — $($Step.detail)" } else { '' }
    Write-Host ("  {0} {1,-6} {2}{3}" -f $status, $Step.object, $Step.method, $detail)
}

function Assert-Confirmed {
    param(
        [bool]$Force,
        [string]$Action,
        [switch]$DryRun
    )
    if ($DryRun) { return $true }
    if ($Force) { return $true }
    Write-Host "拒绝执行：$Action 属于删除/覆盖类动作，需要显式确认。" -ForegroundColor Red
    Write-Host '  请追加 -Force（等价于 -Confirm:$false），或先用 -DryRun 预览命令。' -ForegroundColor Yellow
    return $false
}

function Get-NewStep {
    param(
        [string]$Object,
        [string]$Method,
        [string]$Status = 'success',
        [string]$Detail = '',
        [Nullable[long]]$Bytes = $null,
        [string]$Sha256 = '',
        [Nullable[int]]$Excluded = $null
    )
    return [ordered]@{
        object   = $Object
        method   = $Method
        status   = $Status
        detail   = $Detail
        bytes    = $Bytes
        sha256   = $Sha256
        excluded = $Excluded
        durationMs = 0
    }
}

function Measure-Step {
    param([scriptblock]$Action)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $result = & $Action
    $sw.Stop()
    return [pscustomobject]@{ Result = $result; DurationMs = $sw.ElapsedMilliseconds }
}
