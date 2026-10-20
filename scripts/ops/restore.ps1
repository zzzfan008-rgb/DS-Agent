#!/usr/bin/env pwsh
#Requires -Version 7.0
<#
.SYNOPSIS
  DSSAAS 恢复骨架（Postgres / MinIO / DSH 目录）。

.DESCRIPTION
  依据 docs/20 §6 与 docs/16 §7.4 实现：
    - Postgres：pg_restore --clean --if-exists --no-owner --no-acl 到指定库；
    - MinIO：mc mirror --overwrite 回灌；
    - DSH：校验 sha256 后解包到 dsh-data 卷（排除凭据的包由 backup.ps1 生成）。

  安全边界：
    - 恢复是“变更”：默认拒绝，必须 -Force（等价 -Confirm:$false）；
    - 目标库为 dssaas / postgres 时额外要求 -AllowProductionTarget；
    - -DryRun 只打印将要执行的命令，不执行任何恢复/删除；
    - 不读取、不打印任何密钥值。

.EXAMPLE
  pwsh -File scripts/ops/restore.ps1 -Target pg -BackupFile backups/pg/pg-20261020-120000.dump -PgDatabase dssaas_restore -DryRun

.EXAMPLE
  pwsh -File scripts/ops/restore.ps1 -Target dsh -BackupFile backups/dsh/dsh-20261020-120000.tar.gz -ChecksumFile backups/SHA256SUMS-20261020-120000 -DshVolume dssaas_dsh-data -Force
#>
[CmdletBinding()]
param(
    [ValidateSet('all', 'pg', 'minio', 'dsh')]
    [string]$Target = 'pg',

    # pg=dump 文件；minio=本地镜像目录；dsh=tar.gz
    [Parameter(Mandatory = $true)]
    [string]$BackupFile,

    [switch]$DryRun,
    [switch]$Force,

    # 目标库为 dssaas/postgres 时必须显式加此开关
    [switch]$AllowProductionTarget,

    [string]$OutDir = '',
    [string]$Docker = 'docker',

    [string]$PgContainer = 'dssaas-postgres',
    [string]$PgUser = 'dssaas',
    [string]$PgDatabase = 'dssaas_restore',

    [string]$McExe = 'mc',
    [string]$MinioAlias = 'minio',
    [string]$MinioBucket = 'dssaas-media',

    [string]$DshVolume = 'dssaas_dsh-data',
    [string]$BackupVolume = 'dssaas_backup',
    [string]$ChecksumFile = ''
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

function Format-DockerCommand {
    param([string[]]$Arguments)
    return (@($dockerCtx.Exe) + @($dockerCtx.Prefix) + @($Arguments | ForEach-Object {
                if ($_ -match '\s') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
            })) -join ' '
}

function Add-Step {
    param([string]$Object, [string]$Method, [string]$Status, [string]$Detail = '', [string]$Ref = '')
    $steps.Add([ordered]@{ object = $Object; method = $Method; status = $Status; detail = $Detail; ref = $Ref })
    if ($Status -eq 'failed') { $failures.Add("$Object/$Method") | Out-Null }
    Write-StepLine -Step $steps[$steps.Count - 1]
}

$targetPath = [System.IO.Path]::GetFullPath($BackupFile)
$targetExists = Test-Path -LiteralPath $targetPath
$runPg = $Target -in @('all', 'pg')
$runMinio = $Target -in @('all', 'minio')
$runDsh = $Target -in @('all', 'dsh')

Write-Host "DSSAAS restore · target=$Target · dryRun=$([bool]$DryRun) · backup=$targetPath"

if (-not $DryRun) {
    if (-not (Assert-Confirmed -Force:$Force -Action "restore $Target（覆盖/写入目标）")) {
        exit 1
    }
}

if (-not $targetExists) {
    Write-Host "拒绝执行：备份文件/目录不存在：$targetPath" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# 1) Postgres
# ---------------------------------------------------------------------------
if ($runPg) {
    if ($PgDatabase -in @('dssaas', 'postgres') -and -not $AllowProductionTarget) {
        Write-Host "拒绝执行：PgDatabase=$PgDatabase 疑似生产库；请恢复到 *_restore 库，或显式 -AllowProductionTarget。" -ForegroundColor Red
        exit 1
    }

    $remoteDump = "/tmp/dssaas-restore-$timestamp.dump"
    $checkDbSh = 'psql -U "$POSTGRES_USER" -d postgres -tAc "select 1 from pg_database where datname=''' + $PgDatabase + '''"'
    $createDbSh = 'createdb -U "$POSTGRES_USER" ' + $PgDatabase
    $restoreSh = 'pg_restore --clean --if-exists --no-owner --no-acl -U "$POSTGRES_USER" -d ' + $PgDatabase + ' ' + $remoteDump
    $cleanSh = "rm -f $remoteDump"

    if ($DryRun) {
        Write-Host "  [dry-run] $(Format-DockerCommand -Arguments @('cp', (ConvertTo-DockerHostPath -Path $targetPath -DockerContext $dockerCtx), "${PgContainer}:$remoteDump"))"
        Write-Host "  [dry-run] $(Format-DockerCommand -Arguments @('exec', $PgContainer, 'sh', '-c', $checkDbSh))"
        Write-Host "  [dry-run] $(Format-DockerCommand -Arguments @('exec', $PgContainer, 'sh', '-c', $createDbSh))  # 仅当目标库不存在"
        Write-Host "  [dry-run] $(Format-DockerCommand -Arguments @('exec', $PgContainer, 'sh', '-c', $restoreSh))"
        Write-Host "  [dry-run] $(Format-DockerCommand -Arguments @('exec', $PgContainer, 'sh', '-c', $cleanSh))"
        Add-Step -Object 'pg' -Method 'pg_restore --clean --if-exists' -Status 'skipped' -Detail 'dry-run：仅打印命令' -Ref $targetPath
    }
    else {
        try {
            $copy = Invoke-Docker -DockerContext $dockerCtx -Arguments @('cp', (ConvertTo-DockerHostPath -Path $targetPath -DockerContext $dockerCtx), "${PgContainer}:$remoteDump")
            if ($copy.ExitCode -ne 0) { throw "docker cp 失败：$($copy.Output)" }

            $exists = Invoke-Docker -DockerContext $dockerCtx -Arguments @('exec', $PgContainer, 'sh', '-c', $checkDbSh)
            if ($exists.ExitCode -ne 0) { throw "检查目标库失败：$($exists.Output)" }
            if ((($exists.Output) -join '').Trim() -ne '1') {
                $created = Invoke-Docker -DockerContext $dockerCtx -Arguments @('exec', $PgContainer, 'sh', '-c', $createDbSh)
                if ($created.ExitCode -ne 0) { throw "创建目标库失败：$($created.Output)" }
            }

            $restored = Invoke-Docker -DockerContext $dockerCtx -Arguments @('exec', $PgContainer, 'sh', '-c', $restoreSh)
            # pg_restore 对空库的 --clean 会产生 warning，但退出码 0；非 0 才视为失败
            if ($restored.ExitCode -ne 0) { throw "pg_restore 失败（exit=$($restored.ExitCode)）：$($restored.Output)" }
            Invoke-Docker -DockerContext $dockerCtx -Arguments @('exec', $PgContainer, 'sh', '-c', $cleanSh) | Out-Null

            Add-Step -Object 'pg' -Method 'pg_restore --clean --if-exists' -Status 'success' `
                -Detail "database=$PgDatabase; dump=$targetPath" -Ref $targetPath
        }
        catch {
            Add-Step -Object 'pg' -Method 'pg_restore --clean --if-exists' -Status 'failed' -Detail $_.Exception.Message -Ref $targetPath
        }
    }
}

# ---------------------------------------------------------------------------
# 2) MinIO
# ---------------------------------------------------------------------------
if ($runMinio) {
    $mirrorArgs = @('mirror', '--overwrite', $targetPath, "$MinioAlias/$MinioBucket")
    $mc = Get-Command $McExe -ErrorAction SilentlyContinue
    if ($DryRun) {
        Write-Host "  [dry-run] $McExe $($mirrorArgs -join ' ')"
        Add-Step -Object 'minio' -Method 'mc mirror --overwrite' -Status 'skipped' -Detail 'dry-run：仅打印命令' -Ref $targetPath
    }
    elseif ($null -eq $mc) {
        Add-Step -Object 'minio' -Method 'mc mirror --overwrite' -Status 'failed' -Detail "未找到 $McExe（生产在备份容器内执行）" -Ref $targetPath
    }
    else {
        try {
            $result = Invoke-Process -Exe $McExe -Arguments $mirrorArgs
            if ($result.ExitCode -ne 0) { throw "mc mirror 失败：$($result.Output)" }
            Add-Step -Object 'minio' -Method 'mc mirror --overwrite' -Status 'success' -Detail "dest=$MinioAlias/$MinioBucket; src=$targetPath" -Ref $targetPath
        }
        catch {
            Add-Step -Object 'minio' -Method 'mc mirror --overwrite' -Status 'failed' -Detail $_.Exception.Message -Ref $targetPath
        }
    }
}

# ---------------------------------------------------------------------------
# 3) DSH 目录
# ---------------------------------------------------------------------------
if ($runDsh) {
    $checksumHost = ''
    if (-not [string]::IsNullOrWhiteSpace($ChecksumFile)) { $checksumHost = [System.IO.Path]::GetFullPath($ChecksumFile) }

    $expectedHash = ''
    if ($checksumHost -and (Test-Path -LiteralPath $checksumHost)) {
        $leaf = [System.IO.Path]::GetFileName($targetPath)
        foreach ($line in Get-Content -LiteralPath $checksumHost) {
            if ($line -match '^([0-9a-fA-F]{64})\s+(.+)$' -and (Split-Path -Leaf $Matches[2]) -eq $leaf) {
                $expectedHash = $Matches[1].ToLowerInvariant()
            }
        }
    }

    $hostTar = ConvertTo-DockerHostPath -Path $targetPath -DockerContext $dockerCtx
    $mountArgs = @(
        'run', '--rm',
        '-v', "${DshVolume}:/dsh",
        '-v', "${hostTar}:/backup/in.tar.gz:ro"
    )
    if ($checksumHost) {
        $hostSha = ConvertTo-DockerHostPath -Path $checksumHost -DockerContext $dockerCtx
        $mountArgs += @('-v', "${hostSha}:/backup/SHA256SUMS:ro")
    }
    $mountArgs += 'alpine:3.20'

    $hashForCmd = if ($expectedHash) { $expectedHash } else { '<sha256-from-checksum-file>' }
    $verifySh = 'cd /backup && echo "' + $hashForCmd + '  in.tar.gz" | sha256sum -c -'
    $extractSh = 'tar -C /dsh -xzf /backup/in.tar.gz'

    if ($DryRun) {
        Write-Host "  [dry-run] $(Format-DockerCommand -Arguments $mountArgs) sh -c '$verifySh'   # EXPECTED_HASH 由校验和文件解析"
        Write-Host "  [dry-run] $(Format-DockerCommand -Arguments $mountArgs) sh -c '$extractSh'"
        Add-Step -Object 'dsh' -Method 'sha256 校验 + tar 解包' -Status 'skipped' -Detail 'dry-run：仅打印命令；解包会覆盖 /dsh' -Ref $targetPath
    }
    else {
        try {
            if (-not $expectedHash) { throw '缺少可用校验和（-ChecksumFile 未提供或未找到对应行）；DSH 恢复要求先校验' }

            $verify = Invoke-Docker -DockerContext $dockerCtx -Arguments (@($mountArgs) + @('sh', '-c', $verifySh))
            if ($verify.ExitCode -ne 0) { throw "sha256 校验失败：$($verify.Output)" }

            $extract = Invoke-Docker -DockerContext $dockerCtx -Arguments (@($mountArgs) + @('sh', '-c', $extractSh))
            if ($extract.ExitCode -ne 0) { throw "解包失败：$($extract.Output)" }

            Add-Step -Object 'dsh' -Method 'sha256 校验 + tar 解包' -Status 'success' `
                -Detail "target=dsh volume $DshVolume; checksum=$expectedHash" -Ref $targetPath
        }
        catch {
            Add-Step -Object 'dsh' -Method 'sha256 校验 + tar 解包' -Status 'failed' -Detail $_.Exception.Message -Ref $targetPath
        }
    }
}

# ---------------------------------------------------------------------------
# 4) 报告
# ---------------------------------------------------------------------------
$failedCount = @($steps | Where-Object { $_.status -eq 'failed' }).Count
$okCount = @($steps | Where-Object { $_.status -eq 'success' }).Count
$exitCode = if ($failedCount -eq 0) { 0 } else { 1 }

$report = [ordered]@{
    generatedAt = (Get-Date).ToString('o')
    host        = $env:COMPUTERNAME
    dryRun      = [bool]$DryRun
    target      = $Target
    backupFile  = $targetPath
    steps       = $steps
    failures    = @($failures)
    exitCode    = $exitCode
    note        = '恢复属变更操作；生产恢复须带 CHANGE_ID 与审批（docs/16 §7.4）'
}

if ($DryRun) {
    Write-Host ''
    Write-Host '--- dry-run report (not written) ---'
    $report | ConvertTo-Json -Depth 6
}
else {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    $reportPath = Join-Path $OutDir "restore-$timestamp.json"
    Write-JsonReport -Path $reportPath -Report $report | Out-Null
    Write-Host ''
    Write-Host "报告：$reportPath"
}

Write-Host ''
Write-Host "restore 结束：success=$okCount failed=$failedCount exitCode=$exitCode"
exit $exitCode
