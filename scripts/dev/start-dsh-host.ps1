#requires -Version 7.0
<#
.SYNOPSIS
  启动 dssaas 开发用真实 DSH Host（t18 联调）。

.DESCRIPTION
  - 复用本机已安装的 DSH（默认 E:\DSH\DSH Desktop\resources\app，内核 0.2.1-rc.2）；
  - 在 dsh-bundle/.dev-home 下维护独立 profile（不写 DSH 安装目录、不复用桌面 profile 的会话）；
  - 把 dsh-bundle/bridge/{business-agent,business-bridge}.mjs 作为 Cordis 插件挂入；
  - 生成/复用桥接令牌，启动 127.0.0.1:43181，等待 /internal/health 并打印真实健康 JSON。

.PARAMETER Port
  监听端口，默认 43181（生产约定 43180；dev 避开桌面/其他实例）。

.PARAMETER ForceRestart
  若端口上已有本项目的 Host，先停掉再启动。

.EXAMPLE
  pwsh -File scripts/dev/start-dsh-host.ps1
  pwsh -File scripts/dev/start-dsh-host.ps1 -Port 43181 -ForceRestart
#>
param(
  [int]$Port = 43181,
  [string]$InstallDir = 'E:\DSH\DSH Desktop\resources\app',
  [string]$ProfileName = 'dssaas-host',
  [switch]$ForceRestart
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$DevHome = Join-Path $RepoRoot 'dsh-bundle\.dev-home'
$ProfileDir = Join-Path $DevHome "profiles\$ProfileName"
$TokenFile = Join-Path $DevHome 'secrets\bridge-token'
$PidFile = Join-Path $DevHome 'host.pid'
$LogDir = Join-Path $DevHome 'logs'
$PatchFile = Join-Path $RepoRoot 'dsh-bundle\config\dev-host.patch.yml'
$ManifestFile = Join-Path $RepoRoot 'dsh-bundle\manifest.json'
$BridgeNodeModules = Join-Path $RepoRoot 'dsh-bundle\bridge\node_modules'
$InstallNodeModules = Join-Path $InstallDir 'node_modules'
$DshBin = Join-Path $InstallNodeModules '@deepseek-ai\dsh\lib\bin.js'

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

if (-not (Test-Path $DshBin)) { throw "找不到 DSH CLI：$DshBin（用 -InstallDir 指定安装目录）" }
if (-not (Test-Path $PatchFile)) { throw "找不到 patch：$PatchFile" }
if (-not (Test-Path $ManifestFile)) { throw "找不到 manifest：$ManifestFile" }
$DshVersion = (Get-Content (Join-Path $InstallNodeModules '@deepseek-ai\dsh\package.json') -Raw | ConvertFrom-Json).version

New-Item -ItemType Directory -Force -Path $DevHome, (Join-Path $DevHome 'secrets'), $LogDir | Out-Null

# 1) 插件 import 解析：junction 到 Host 安装的 node_modules（不复制包、不改安装目录）。
if (-not (Test-Path $BridgeNodeModules)) {
  Write-Step "创建插件依赖 junction：dsh-bundle\bridge\node_modules -> $InstallNodeModules"
  New-Item -ItemType Junction -Path $BridgeNodeModules -Target $InstallNodeModules | Out-Null
}

# 2) 独立 profile（首次从 shipped web 模板生成；幂等：已存在则复用）。
if (-not (Test-Path (Join-Path $ProfileDir 'package.json'))) {
  Write-Step "生成独立 profile：$ProfileName（dsh --from-default-profile web）"
  $env:DSH_HOME = $DevHome
  & node $DshBin --profile $ProfileName --from-default-profile web --dump-config | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "生成 profile 失败（exit=$LASTEXITCODE）" }
}

# 3) 桥接令牌（0600 意图；Windows 上 ACL 由目录继承，生产用 POSIX 0600）。
New-Item -ItemType Directory -Force -Path (Split-Path $TokenFile) | Out-Null
if (-not (Test-Path $TokenFile)) {
  Write-Step "生成桥接令牌：$TokenFile"
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $token = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
  Set-Content -Path $TokenFile -Value $token -NoNewline -Encoding utf8
}
$tokenValue = (Get-Content $TokenFile -Raw).Trim()

# 4) 凭据：只读引用本机 DSH 凭据存储，不复制密钥。
$CredentialsPath = if ($env:DSSAAS_DEV_CREDENTIALS_PATH) { $env:DSSAAS_DEV_CREDENTIALS_PATH } else { Join-Path $env:USERPROFILE '.dsh\.credentials.yaml' }
if (-not (Test-Path $CredentialsPath)) {
  throw "找不到凭据文件：$CredentialsPath（先在本机 DSH 登录，或设置 DSSAAS_DEV_CREDENTIALS_PATH）"
}

# 5) 若已有实例：先看是否为同一项目 Host。
$existingPid = if (Test-Path $PidFile) { (Get-Content $PidFile -Raw).Trim() } else { $null }
if ($existingPid -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
  if (-not $ForceRestart) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/internal/health" -Headers @{ Authorization = "Bearer $tokenValue" } -TimeoutSec 3
      Write-Host "Host 已在运行：pid=$existingPid http://127.0.0.1:$Port" -ForegroundColor Green
      $health | ConvertTo-Json -Depth 8
      exit 0
    } catch {
      throw "pid=$existingPid 占用但健康检查失败；用 -ForceRestart 重启。$($_.Exception.Message)"
    }
  }
  Write-Step "停止旧 Host（pid=$existingPid）"
  Stop-Process -Id $existingPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}

# 6) 启动 Host。
$env:DSH_HOME = $DevHome
$env:DSH_VERSION = $DshVersion
$env:DSSAAS_DEV_CREDENTIALS_PATH = $CredentialsPath
$logFile = Join-Path $LogDir ("host-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
Write-Step "启动真实 DSH Host（profile=$ProfileName version=$DshVersion port=$Port）"
Write-Host "    DSH_HOME=$DevHome"
Write-Host "    credentials=$CredentialsPath（只读引用）"
Write-Host "    log=$logFile" -ForegroundColor DarkGray
$process = Start-Process -FilePath 'node' `
  -ArgumentList @("`"$DshBin`"", '--profile', $ProfileName, '--patch', "`"$PatchFile`"", '--host', '127.0.0.1', '--port', "$Port", '--no-open') `
  -WorkingDirectory $RepoRoot -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $logFile -RedirectStandardError ($logFile -replace '\.log$', '.err.log')
Set-Content -Path $PidFile -Value $process.Id -NoNewline

# 7) 等待健康检查（真实 Host 加载插件/模型目录需要几秒）。
Write-Step "等待 /internal/health（≤90s）"
$deadline = (Get-Date).AddSeconds(90)
$health = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  if ($process.HasExited) {
    $tail = Get-Content $logFile -Tail 40 -ErrorAction SilentlyContinue
    $tailErr = Get-Content ($logFile -replace '\.log$', '.err.log') -Tail 40 -ErrorAction SilentlyContinue
    throw "Host 进程提前退出（exit=$($process.ExitCode)）。stdout:`n$($tail -join "`n")`nstderr:`n$($tailErr -join "`n")"
  }
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/internal/health" -Headers @{ Authorization = "Bearer $tokenValue" } -TimeoutSec 2
    break
  } catch {
    # 未就绪，继续等
  }
}
if ($null -eq $health) { throw "Host 90s 内未就绪；查看 $logFile" }

Write-Host "`nHost 就绪：http://127.0.0.1:$Port" -ForegroundColor Green
Write-Host "  桥接令牌文件：$TokenFile（Bearer）"
Write-Host "  健康检查：GET /internal/health"
$health | ConvertTo-Json -Depth 8
Write-Host "`n下一步（真实联调 smoke）：" -ForegroundColor Cyan
Write-Host "  `$env:DSH_BRIDGE_URL='http://127.0.0.1:$Port'"
Write-Host "  `$env:DSH_BRIDGE_TOKEN_FILE='$TokenFile'"
Write-Host "  `$env:AGENT_FIRST_TOKEN_TIMEOUT_MS='60000'   # 真实模型冷启动可能 >8s（见验收记录 F1）"
Write-Host "  pnpm --filter @dssaas/api smoke:agent"
Write-Host "`n停止：pwsh -File scripts/dev/stop-dsh-host.ps1"
