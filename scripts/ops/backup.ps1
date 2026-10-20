#!/usr/bin/env pwsh
#Requires -Version 7.0
<#
.SYNOPSIS
  DSSAAS 备份骨架（Postgres / MinIO / DSH 目录 / 凭据分支）。

.DESCRIPTION
  依据 docs/20（存储边界与备份矩阵）与 docs/16 §7 实现的最小骨架：
    - Postgres：pg_dump -Fc -Z6 全备 + WAL 归档状态检查（只读，不改 archive_command）；
    - MinIO：mc mirror --preserve 到备份目录，记录对象数与字节数；
    - DSH：只备份配置与 sessions/**/*.jsonl 黑匣子，显式排除 .credentials.yaml、secrets/、workspaces/，
            报告打印“已排除 N 个凭据文件”；
    - 凭据：只留加密导出接口占位（age/KEK 由生产侧提供），默认不导出，脚本不读取密钥值。

  安全边界：
    - 不读取、不打印任何密钥值；只报告“存在/已排除”；
    - 删除/覆盖类动作（保留期清理）必须 -Prune + -Force；默认拒绝；
    - -DryRun 只打印将要执行的命令，不写文件、不建卷、不改数据。

.EXAMPLE
  # 全量预演（不落盘）
  pwsh -File scripts/ops/backup.ps1 -Target all -DryRun

.EXAMPLE
  # 本机 Docker 在 WSL 时：
  pwsh -File scripts/ops/backup.ps1 -Target pg -PgContainer dssaas-postgres -Docker 'wsl -e docker' -OutDir D:\DSSAAS\backups

.OUTPUTS
  OutDir/backup-YYYYMMDD-HHmmss.json；退出码 0 成功 / 2 部分成功 / 3 全部失败。
#>
[CmdletBinding()]
param(
    [ValidateSet('all', 'pg', 'minio', 'dsh')]
    [string]$Target = 'all',

    # 备份产物目录（默认仓库根 backups/，已在 .gitignore）
    [string]$OutDir = '',

    [int]$RetentionDays = 14,

    [switch]$DryRun,

    # docker 调用前缀：本机 Docker Desktop 用 'docker'；Docker 在 WSL 时用 'wsl -e docker'
    [string]$Docker = 'docker',

    [string]$PgContainer = 'dssaas-postgres',
    [string]$PgUser = 'dssaas',
    [string]$PgDatabase = 'dssaas',

    [string]$McExe = 'mc',
    [string]$MinioAlias = 'minio',
    [string]$MinioBucket = 'dssaas-media',

    # 卷名与 infra/docker-compose.yml / docs/20 §3.1 对齐（compose 项目名 dssaas_ 前缀）
    [string]$DshVolume = 'dssaas_dsh-data',
    [string]$BackupVolume = 'dssaas_backup',
    [string]$WalVolume = 'dssaas_pg-wal',

    # 凭据加密导出分支：默认关闭；打开也只打印占位命令，不实现密钥管理
    [switch]$ExportCredentials,

    # 保留期清理（删除类动作，必须同时 -Prune -Force）
    [switch]$Prune,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib/common.ps1')

$RepoRoot = Get-DssaasRepoRoot -ScriptDir $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = Join-Path $RepoRoot 'backups' }
$OutDir = [System.IO.Path]::GetFullPath($OutDir)

$dockerCtx = ConvertTo-DockerContext -DockerCommand $Docker
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'

$steps = [System.Collections.Generic.List[object]]::new()
$failures = [System.Collections.Generic.List[string]]::new()

function Add-Step {
    param(
        [string]$Object,
        [string]$Method,
        [string]$Status = 'success',
        [string]$Detail = '',
        [Nullable[long]]$Bytes = $null,
        [string]$Sha256 = '',
        [Nullable[int]]$Excluded = $null,
        [int]$DurationMs = 0
    )
    $steps.Add([ordered]@{
            object     = $Object
            method     = $Method
            status     = $Status
            detail     = $Detail
            bytes      = $Bytes
            sha256     = $Sha256
            excluded   = $Excluded
            durationMs = $DurationMs
        })
    if ($Status -eq 'failed') { $failures.Add("$Object/$Method") | Out-Null }
}

function Format-DockerCommand {
    param([string[]]$Arguments)
    return (@($dockerCtx.Exe) + @($dockerCtx.Prefix) + @($Arguments | ForEach-Object {
                if ($_ -match '\s') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
            })) -join ' '
}

$runPg = $Target -in @('all', 'pg')
$runMinio = $Target -in @('all', 'minio')
$runDsh = $Target -in @('all', 'dsh')

Write-Host "DSSAAS backup · target=$Target · dryRun=$([bool]$DryRun) · outDir=$OutDir"

if (-not $DryRun) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $OutDir 'pg') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $OutDir 'dsh') -Force | Out-Null
}

$shaLines = [System.Collections.Generic.List[string]]::new()

# ---------------------------------------------------------------------------
# 1) Postgres：WAL 状态检查 + pg_dump -Fc -Z6
# ---------------------------------------------------------------------------
if ($runPg) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    # 1.1 WAL 归档状态（只检查，不改 postgresql.conf / archive_command）
    $walSql = "select coalesce((select setting from pg_settings where name='archive_mode'),'unknown'); " +
    "select coalesce(last_archived_time::text,'never') from pg_stat_archiver;"
    $walSh = 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "' + $walSql + '"'
    $walArgs = @('exec', $PgContainer, 'sh', '-c', $walSh)
    $walVolumeArgs = @('volume', 'inspect', $WalVolume)

    if ($DryRun) {
        Write-Host "  [dry-run] $(Format-DockerCommand -Arguments $walArgs)"
        Write-Host "  [dry-run] $(Format-DockerCommand -Arguments $walVolumeArgs)"
        Add-Step -Object 'pg' -Method 'wal-status' -Status 'skipped' -Detail 'dry-run：仅打印检查命令'
    }
    else {
        $walResult = Invoke-Docker -DockerContext $dockerCtx -Arguments $walArgs
        $walLines = @($walResult.Output -split "`n" | Where-Object { $_ -ne '' })
        $archiveMode = if ($walLines.Count -ge 1) { $walLines[0].Trim() } else { 'unknown' }
        $lastArchived = if ($walLines.Count -ge 2) { $walLines[1].Trim() } else { 'never' }
        $volResult = Invoke-Docker -DockerContext $dockerCtx -Arguments $walVolumeArgs
        $walVolumePresent = ($volResult.ExitCode -eq 0)
        $detail = "archive_mode=$archiveMode; last_archived_time=$lastArchived; wal_volume=$WalVolume present=$walVolumePresent（只检查，未改 archive_command）"
        Add-Step -Object 'pg' -Method 'wal-status' -Status 'success' -Detail $detail
        Write-StepLine -Step $steps[$steps.Count - 1]
    }

    # 1.2 全量逻辑备份
    $dumpName = "pg-$timestamp.dump"
    $dumpFile = Join-Path (Join-Path $OutDir 'pg') $dumpName
    $remoteDump = "/tmp/$dumpName"
    $dumpSh = 'pg_dump -Fc -Z6 -U "$POSTGRES_USER" -d "$POSTGRES_DB" > ' + $remoteDump
    $dumpArgs = @('exec', $PgContainer, 'sh', '-c', $dumpSh)
    $copyArgs = @('cp', "${PgContainer}:$remoteDump", (ConvertTo-DockerHostPath -Path $dumpFile -DockerContext $dockerCtx))
    $cleanArgs = @('exec', $PgContainer, 'sh', '-c', "rm -f $remoteDump")

    if ($DryRun) {
        Write-Host "  [dry-run] $(Format-DockerCommand -Arguments $dumpArgs)"
        Write-Host "  [dry-run] $(Format-DockerCommand -Arguments $copyArgs)"
        Write-Host "  [dry-run] $(Format-DockerCommand -Arguments $cleanArgs)"
        Add-Step -Object 'pg' -Method 'pg_dump -Fc -Z6' -Status 'skipped' -Detail 'dry-run：仅打印命令'
    }
    else {
        try {
            $dumpResult = Invoke-Docker -DockerContext $dockerCtx -Arguments $dumpArgs
            if ($dumpResult.ExitCode -ne 0) { throw "pg_dump 失败：$($dumpResult.Output)" }
            $copyResult = Invoke-Docker -DockerContext $dockerCtx -Arguments $copyArgs
            if ($copyResult.ExitCode -ne 0) { throw "docker cp 失败：$($copyResult.Output)" }
            Invoke-Docker -DockerContext $dockerCtx -Arguments $cleanArgs | Out-Null

            $file = Get-Item -LiteralPath $dumpFile
            $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dumpFile).Hash.ToLowerInvariant()
            $shaLines.Add("$hash  pg/$dumpName")
            $sw.Stop()
            Add-Step -Object 'pg' -Method 'pg_dump -Fc -Z6' -Status 'success' `
                -Detail "archive=$dumpFile" -Bytes $file.Length -Sha256 $hash -DurationMs $sw.ElapsedMilliseconds
            Write-StepLine -Step $steps[$steps.Count - 1]
        }
        catch {
            $sw.Stop()
            Add-Step -Object 'pg' -Method 'pg_dump -Fc -Z6' -Status 'failed' `
                -Detail $_.Exception.Message -DurationMs $sw.ElapsedMilliseconds
            Write-StepLine -Step $steps[$steps.Count - 1]
        }
    }
}

# ---------------------------------------------------------------------------
# 2) MinIO：mc mirror --preserve
# ---------------------------------------------------------------------------
if ($runMinio) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $minioDest = Join-Path (Join-Path $OutDir 'minio') $timestamp
    $mirrorArgs = @('mirror', '--preserve', '--overwrite', "$MinioAlias/$MinioBucket", $minioDest)
    $mc = Get-Command $McExe -ErrorAction SilentlyContinue

    if ($DryRun) {
        Write-Host "  [dry-run] $McExe $($mirrorArgs -join ' ')"
        Add-Step -Object 'minio' -Method 'mc mirror --preserve' -Status 'skipped' -Detail 'dry-run：仅打印命令'
    }
    elseif ($null -eq $mc) {
        $sw.Stop()
        Add-Step -Object 'minio' -Method 'mc mirror --preserve' -Status 'failed' `
            -Detail "未找到 $McExe（本机未安装；生产应在备份容器内执行 mc alias set 后运行）" -DurationMs $sw.ElapsedMilliseconds
        Write-StepLine -Step $steps[$steps.Count - 1]
    }
    else {
        try {
            New-Item -ItemType Directory -Path $minioDest -Force | Out-Null
            $mirrorResult = Invoke-Process -Exe $McExe -Arguments $mirrorArgs
            if ($mirrorResult.ExitCode -ne 0) { throw "mc mirror 失败：$($mirrorResult.Output)" }
            $files = @(Get-ChildItem -LiteralPath $minioDest -Recurse -File -ErrorAction SilentlyContinue)
            $bytes = if ($files.Count -gt 0) { ($files | Measure-Object -Property Length -Sum).Sum } else { 0 }
            $sw.Stop()
            Add-Step -Object 'minio' -Method 'mc mirror --preserve' -Status 'success' `
                -Detail "objects=$($files.Count); dest=$minioDest" -Bytes $bytes -DurationMs $sw.ElapsedMilliseconds
            Write-StepLine -Step $steps[$steps.Count - 1]
        }
        catch {
            $sw.Stop()
            Add-Step -Object 'minio' -Method 'mc mirror --preserve' -Status 'failed' `
                -Detail $_.Exception.Message -DurationMs $sw.ElapsedMilliseconds
            Write-StepLine -Step $steps[$steps.Count - 1]
        }
    }
}

# ---------------------------------------------------------------------------
# 3) DSH 目录：配置 + sessions/*.jsonl，排除凭据
# ---------------------------------------------------------------------------
if ($runDsh) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $tarName = "dsh-$timestamp.tar.gz"
    $dshSh = @(
        'excluded=$(find /dsh -maxdepth 6 \( -name .credentials.yaml -o -name bridge-token -o -path "*/secrets/*" \) 2>/dev/null | wc -l);',
        'echo "excluded=$excluded";',
        'mkdir -p /backup/dsh;',
        "tar -C /dsh --exclude=secrets --exclude=.credentials.yaml --exclude=workspaces -czf /backup/dsh/$tarName . &&",
        ('echo "bytes=$(stat -c %s /backup/dsh/' + $tarName + ')" &&'),
        "sha256sum /backup/dsh/$tarName"
    ) -join ' '
    $dshArgs = @(
        'run', '--rm',
        '-v', "${DshVolume}:/dsh:ro",
        '-v', "${BackupVolume}:/backup",
        'alpine:3.20', 'sh', '-c', $dshSh
    )
    $volArgs = @('volume', 'inspect', $DshVolume)
    $backupVolArgs = @('volume', 'inspect', $BackupVolume)

    if ($DryRun) {
        Write-Host "  [dry-run] $(Format-DockerCommand -Arguments $volArgs)"
        Write-Host "  [dry-run] $(Format-DockerCommand -Arguments $backupVolArgs)"
        Write-Host "  [dry-run] $(Format-DockerCommand -Arguments $dshArgs)"
        Add-Step -Object 'dsh' -Method 'tar.gz（排除凭据）' -Status 'skipped' -Detail 'dry-run：仅打印命令；未读取卷内容'
    }
    else {
        try {
            $dshVolResult = Invoke-Docker -DockerContext $dockerCtx -Arguments $volArgs
            if ($dshVolResult.ExitCode -ne 0) {
                throw "卷 $DshVolume 不存在（compose 项目 dssaas 未起或卷名不匹配）"
            }
            $backupVolResult = Invoke-Docker -DockerContext $dockerCtx -Arguments $backupVolArgs
            if ($backupVolResult.ExitCode -ne 0) {
                $createResult = Invoke-Docker -DockerContext $dockerCtx -Arguments @('volume', 'create', $BackupVolume)
                if ($createResult.ExitCode -ne 0) { throw "无法创建备份卷 $BackupVolume：$($createResult.Output)" }
            }

            $dshResult = Invoke-Docker -DockerContext $dockerCtx -Arguments $dshArgs
            if ($dshResult.ExitCode -ne 0) { throw "DSH 打包失败：$($dshResult.Output)" }

            $excluded = $null
            $bytes = $null
            $sha = ''
            foreach ($line in ($dshResult.Output -split "`n")) {
                if ($line -match '^excluded=(\d+)$') { $excluded = [int]$Matches[1] }
                if ($line -match '^bytes=(\d+)$') { $bytes = [long]$Matches[1] }
                if ($line -match '^([0-9a-f]{64})\s+') { $sha = $Matches[1] }
            }
            $shaLines.Add("$sha  dsh/$tarName")
            $sw.Stop()
            Add-Step -Object 'dsh' -Method 'tar.gz（排除凭据）' -Status 'success' `
                -Detail "archive=/backup/dsh/$tarName；已排除 $excluded 个凭据文件（.credentials.yaml/secrets）" `
                -Bytes $bytes -Sha256 $sha -Excluded $excluded -DurationMs $sw.ElapsedMilliseconds
            Write-StepLine -Step $steps[$steps.Count - 1]
            Write-Host "    已排除 $excluded 个凭据文件（未读取内容）"
        }
        catch {
            $sw.Stop()
            Add-Step -Object 'dsh' -Method 'tar.gz（排除凭据）' -Status 'failed' `
                -Detail $_.Exception.Message -DurationMs $sw.ElapsedMilliseconds
            Write-StepLine -Step $steps[$steps.Count - 1]
        }
    }
}

# ---------------------------------------------------------------------------
# 4) 凭据：只留接口占位，默认不导出
# ---------------------------------------------------------------------------
$credentialStep = [ordered]@{
    object     = 'credentials'
    method     = 'age 加密导出（接口占位）'
    status     = 'skipped'
    detail     = if ($ExportCredentials) {
        '未实现：需 age/KEK 与离线私钥（docs/20 §4.3 分支 A/B）；脚本不读取密钥值，仅保留占位命令'
    }
    else {
        '默认不导出；凭据不随普通备份，生产用 age 公钥单独加密导出'
    }
    bytes      = $null
    sha256     = ''
    excluded   = $null
    durationMs = 0
}
$steps.Add($credentialStep)

if ($ExportCredentials) {
    Write-Host "  [placeholder] age -r <BACKUP_AGE_RECIPIENT> -o <out>.age <input>  # 未执行；密钥管理不在本脚本"
}

# ---------------------------------------------------------------------------
# 5) 保留期清理（删除类：默认拒绝，需 -Prune -Force）
# ---------------------------------------------------------------------------
$pruneReport = [ordered]@{
    requested = [bool]$Prune
    performed = $false
    removed   = @()
    reason    = ''
}

if ($Prune) {
    if (-not $DryRun -and -not (Assert-Confirmed -Force:$Force -Action '保留期清理（删除过期备份）')) {
        $pruneReport.reason = '未确认：需要 -Force（等价 -Confirm:$false）'
        Write-Host "  ↷ prune 拒绝：$($pruneReport.reason)"
    }
    else {
        $cutoff = (Get-Date).AddDays(-1 * $RetentionDays)
        $candidates = @(Get-ChildItem -LiteralPath $OutDir -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
                $_.LastWriteTime -lt $cutoff -and
                ($_.Name -match '^(pg-.*\.dump|dsh-.*\.tar\.gz|SHA256SUMS-\d{8}-\d{6}|backup-\d{8}-\d{6}\.json)$' -or
                    $_.PSIsContainer -and $_.FullName -match '[\\/]minio[\\/]\d{8}-\d{6}$')
            } | Select-Object -ExpandProperty FullName)
        if ($DryRun) {
            $pruneReport.removed = @($candidates)
            $pruneReport.reason = "dry-run：将删除 $($candidates.Count) 项（retentionDays=$RetentionDays）"
            foreach ($item in $candidates) { Write-Host "  [dry-run] remove $item" }
        }
        else {
            foreach ($item in $candidates) { Remove-Item -LiteralPath $item -Recurse -Force -ErrorAction SilentlyContinue }
            $pruneReport.performed = $true
            $pruneReport.removed = @($candidates)
            $pruneReport.reason = "已删除 $($candidates.Count) 项（retentionDays=$RetentionDays）"
        }
    }
}
else {
    $pruneReport.reason = '未请求（-Prune 未设置）'
}

# ---------------------------------------------------------------------------
# 6) 校验和文件 + 报告
# ---------------------------------------------------------------------------
if (-not $DryRun -and $shaLines.Count -gt 0) {
    $shaFile = Join-Path $OutDir "SHA256SUMS-$timestamp"
    Set-Content -LiteralPath $shaFile -Value ($shaLines -join "`n") -Encoding utf8
}

$targetSteps = @($steps | Where-Object { $_.object -in @('pg', 'minio', 'dsh') })
$failedCount = @($targetSteps | Where-Object { $_.status -eq 'failed' }).Count
$okCount = @($targetSteps | Where-Object { $_.status -eq 'success' }).Count

if ($failedCount -eq 0) {
    $exitCode = 0
}
elseif ($okCount -eq 0) {
    $exitCode = 3
}
else {
    $exitCode = 2
}

$report = [ordered]@{
    generatedAt    = (Get-Date).ToString('o')
    host           = $env:COMPUTERNAME
    dryRun         = [bool]$DryRun
    target         = $Target
    outDir         = $OutDir
    retentionDays  = $RetentionDays
    postgres       = [ordered]@{ container = $PgContainer; database = $PgDatabase; user = $PgUser }
    minio          = [ordered]@{ alias = $MinioAlias; bucket = $MinioBucket }
    dsh            = [ordered]@{ volume = $DshVolume; backupVolume = $BackupVolume; walVolume = $WalVolume }
    steps          = $steps
    prune          = $pruneReport
    failures       = @($failures)
    exitCode       = $exitCode
    note           = '凭据不随普通备份；脚本不读取/打印密钥值'
}

if ($DryRun) {
    Write-Host ''
    Write-Host '--- dry-run report (not written) ---'
    $report | ConvertTo-Json -Depth 8
}
else {
    $reportPath = Join-Path $OutDir "backup-$timestamp.json"
    Write-JsonReport -Path $reportPath -Report $report | Out-Null
    Write-Host ''
    Write-Host "报告：$reportPath"
    Write-Host "校验和：$(Join-Path $OutDir "SHA256SUMS-$timestamp")"
}

Write-Host ''
Write-Host "backup 结束：success=$okCount failed=$failedCount exitCode=$exitCode"
exit $exitCode
