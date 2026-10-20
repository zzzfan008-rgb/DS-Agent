#requires -Version 7.0
<#
.SYNOPSIS
  停止 dssaas 开发用真实 DSH Host（t18）。

.DESCRIPTION
  读取 dsh-bundle/.dev-home/host.pid 停止进程；验证 43181 端口不再响应 /internal/health。
  不删除 profile/会话/令牌（下次 start 复用）；如需彻底清理见 -Purge。

.PARAMETER Port
  与 start 一致的端口，默认 43181。

.PARAMETER Purge
  额外删除 dsh-bundle/.dev-home（profile、会话、令牌、日志）——不可逆，仅本机 dev 数据。
#>
param(
  [int]$Port = 43181,
  [switch]$Purge
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$DevHome = Join-Path $RepoRoot 'dsh-bundle\.dev-home'
$PidFile = Join-Path $DevHome 'host.pid'

if (Test-Path $PidFile) {
  $pidValue = (Get-Content $PidFile -Raw).Trim()
  $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if ($process) {
    Write-Host "==> 停止 Host pid=$pidValue" -ForegroundColor Cyan
    Stop-Process -Id $pidValue -Force
    $process.WaitForExit(5000) | Out-Null
  } else {
    Write-Host "pid=$pidValue 已不存在（清理 pid 文件）" -ForegroundColor DarkYellow
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
} else {
  Write-Host "未找到 host.pid；尝试按端口查找 node 进程" -ForegroundColor DarkYellow
  $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($connection in $connections) {
    $owner = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
    if ($owner -and $owner.ProcessName -match 'node') {
      Write-Host "==> 停止占用 $Port 的 node pid=$($owner.Id)" -ForegroundColor Cyan
      Stop-Process -Id $owner.Id -Force
    }
  }
}

Start-Sleep -Milliseconds 500
$stillListening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($stillListening) { Write-Warning "端口 $Port 仍在监听，请手动检查。" } else { Write-Host "端口 $Port 已释放。" -ForegroundColor Green }

if ($Purge) {
  if (Test-Path $DevHome) {
    Write-Host "==> 删除 dev home（不可逆）：$DevHome" -ForegroundColor Yellow
    Remove-Item -Recurse -Force $DevHome
  }
}
