#!/usr/bin/env pwsh
#Requires -Version 7.0
<#
.SYNOPSIS
  DSSAAS 恢复演练编排（一次性容器 → 恢复 → 三条核对 SQL → 报告 → 销毁）。

.DESCRIPTION
  依据 docs/20 §6 / docs/16 §7.5：
    1) 启动一次性 pgvector 容器（随机临时口令，不打印）；
    2) 把 pg_dump -Fc 备份恢复到演练库；
    3) 跑三条核对 SQL：表数、关键表行数、最新迁移版本；
    4) 输出 JSON 报告（含 checks 与 pass/fail）；
    5) 销毁容器（-Keep 可保留以便排查）。

  安全边界：
    - 演练会创建/销毁一次性容器，属“变更”，默认拒绝；必须 -Force（等价 -Confirm:$false）；
    - 口令在内存随机生成，不写入磁盘/报告/日志；
    - -DryRun 只打印命令，不创建容器、不执行恢复。

.EXAMPLE
  pwsh -File scripts/ops/drill.ps1 -BackupFile backups/pg/pg-20261020-120000.dump -Docker 'wsl -e docker' -Force
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BackupFile,

    [switch]$DryRun,
    [switch]$Force,
    [switch]$Keep,

    [string]$OutDir = '',
    [string]$Docker = 'docker',
    [string]$Image = 'pgvector/pgvector:pg16',
    [string]$ContainerName = '',
    [string]$DrillDb = 'dssaas_drill',
    [string]$PgUser = 'dssaas',
    [int]$ReadyTimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/common.ps1')

$RepoRoot = Get-DssaasRepoRoot -ScriptDir $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = Join-Path $RepoRoot 'backups' }
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$dockerCtx = ConvertTo-DockerContext -DockerCommand $Docker
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if ([string]::IsNullOrWhiteSpace($ContainerName)) {
    $ContainerName = 'dssaas-drill-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
}

$backupPath = [System.IO.Path]::GetFullPath($BackupFile)
$hostDumpPath = ConvertTo-DockerHostPath -Path $backupPath -DockerContext $dockerCtx
$remoteDump = '/tmp/drill-restore.dump'
$ephemeralPassword = [guid]::NewGuid().ToString('N') + 'Aa1'  # 仅内存；不打印、不落盘

$checks = [System.Collections.Generic.List[object]]::new()
$report = [ordered]@{
    generatedAt   = (Get-Date).ToString('o')
    host          = $env:COMPUTERNAME
    dryRun        = [bool]$DryRun
    backupFile    = $backupPath
    container     = $ContainerName
    image         = $Image
    drillDb       = $DrillDb
    keep          = [bool]$Keep
    checks        = $checks
    passed        = $false
    destroyed     = $false
    exitCode      = 1
    note          = '一次性演练容器；口令内存随机生成，不打印、不落盘'
}

function Format-DockerCommand {
    param([string[]]$Arguments)
    return (@($dockerCtx.Exe) + @($dockerCtx.Prefix) + @($Arguments | ForEach-Object {
                if ($_ -match '\s') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
            })) -join ' '
}

function Add-Check {
    param([string]$Name, [string]$Sql, [string]$Value, [bool]$Pass, [string]$Expect = '')
    $checks.Add([ordered]@{ name = $Name; sql = $Sql; value = $Value; expect = $Expect; pass = $Pass })
    $flag = if ($Pass) { '✔' } else { '✖' }
    Write-Host "  $flag $Name = $Value $(if ($Expect) { "(expect $Expect)" })"
}

function Invoke-PsqlScalar {
    param([string]$Container, [string]$Sql)
    $sh = 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "' + $Sql + '"'
    $result = Invoke-Docker -DockerContext $dockerCtx -Arguments @('exec', $Container, 'sh', '-c', $sh)
    $value = (($result.Output -split "`n") | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1)
    if ($null -eq $value) { $value = '' }
    return [pscustomobject]@{ ExitCode = $result.ExitCode; Value = $value.Trim(); Raw = $result.Output }
}

$sqlTables = 'select count(*) from information_schema.tables where table_schema=''public'' and table_type=''BASE TABLE'' and table_name <> ''_prisma_migrations'';'
$sqlRows = 'select ''product=''||(select count(*) from product)||'';product_sku=''||(select count(*) from product_sku)||'';listing=''||(select count(*) from listing)||'';users=''||(select count(*) from users)||'';audit_log=''||(select count(*) from audit_log);'
$sqlMigration = 'select coalesce(migration_name,'''') from _prisma_migrations order by finished_at desc nulls last limit 1;'

$runArgs = @(
    'run', '-d', '--name', $ContainerName,
    '-e', "POSTGRES_USER=$PgUser",
    '-e', "POSTGRES_PASSWORD=$ephemeralPassword",
    '-e', "POSTGRES_DB=$DrillDb",
    $Image
)
$cpArgs = @('cp', $hostDumpPath, "${ContainerName}:$remoteDump")
$restoreSh = 'pg_restore --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB" ' + $remoteDump
$restoreArgs = @('exec', $ContainerName, 'sh', '-c', $restoreSh)

if (-not $DryRun -and -not (Assert-Confirmed -Force:$Force -Action "恢复演练（创建并销毁容器 $ContainerName）")) {
    exit 1
}

if (-not (Test-Path -LiteralPath $backupPath)) {
    Write-Host "拒绝执行：备份文件不存在：$backupPath" -ForegroundColor Red
    exit 1
}

if ($DryRun) {
    $maskedRun = $runArgs | ForEach-Object { if ($_ -match '^POSTGRES_PASSWORD=') { 'POSTGRES_PASSWORD=<ephemeral>' } else { $_ } }
    Write-Host "  [dry-run] $(Format-DockerCommand -Arguments $maskedRun)"
    Write-Host "  [dry-run] $(Format-DockerCommand -Arguments @('exec', $ContainerName, 'pg_isready', '-U', $PgUser, '-d', $DrillDb))  # 等待就绪"
    Write-Host "  [dry-run] $(Format-DockerCommand -Arguments $cpArgs)"
    Write-Host "  [dry-run] $(Format-DockerCommand -Arguments $restoreArgs)"
    Write-Host "  [dry-run] psql -U `$POSTGRES_USER -d `$POSTGRES_DB -tAc `"$sqlTables`""
    Write-Host "  [dry-run] psql -U `$POSTGRES_USER -d `$POSTGRES_DB -tAc `"$sqlRows`""
    Write-Host "  [dry-run] psql -U `$POSTGRES_USER -d `$POSTGRES_DB -tAc `"$sqlMigration`""
    Write-Host "  [dry-run] $(Format-DockerCommand -Arguments @('rm', '-f', $ContainerName))  # 演练结束销毁"
    $report.passed = $false
    $report.exitCode = 0
    $report | ConvertTo-Json -Depth 8
    exit 0
}

$started = $false
$exitCode = 1
try {
    Write-Host "drill: 启动一次性容器 $ContainerName（$Image）"
    $runResult = Invoke-Docker -DockerContext $dockerCtx -Arguments $runArgs
    if ($runResult.ExitCode -ne 0) { throw "docker run 失败：$($runResult.Output)" }
    $started = $true

    $ready = $false
    for ($i = 0; $i -lt $ReadyTimeoutSeconds; $i++) {
        $ping = Invoke-Docker -DockerContext $dockerCtx -Arguments @('exec', $ContainerName, 'pg_isready', '-U', $PgUser, '-d', $DrillDb)
        if ($ping.Output -match 'accepting connections') { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw "演练库在 ${ReadyTimeoutSeconds}s 内未就绪" }

    $copy = Invoke-Docker -DockerContext $dockerCtx -Arguments $cpArgs
    if ($copy.ExitCode -ne 0) { throw "docker cp 失败：$($copy.Output)" }

    $restore = Invoke-Docker -DockerContext $dockerCtx -Arguments $restoreArgs
    if ($restore.ExitCode -ne 0) { throw "pg_restore 失败（exit=$($restore.ExitCode)）：$($restore.Output)" }

    Write-Host 'drill: 恢复完成，执行三条核对 SQL'
    $tables = Invoke-PsqlScalar -Container $ContainerName -Sql $sqlTables
    $rows = Invoke-PsqlScalar -Container $ContainerName -Sql $sqlRows
    $migration = Invoke-PsqlScalar -Container $ContainerName -Sql $sqlMigration

    $tablesValue = if ($tables.Value -match '^\d+$') { [int]$tables.Value } else { -1 }
    Add-Check -Name 'table_count' -Sql $sqlTables -Value "$tablesValue" -Pass ($tablesValue -ge 39) -Expect '>= 39（31+8 业务表）'
    Add-Check -Name 'key_table_rows' -Sql $sqlRows -Value "$($rows.Value)" -Pass ($rows.ExitCode -eq 0 -and $rows.Value -match 'product=')
    Add-Check -Name 'latest_migration' -Sql $sqlMigration -Value "$($migration.Value)" -Pass ($migration.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($migration.Value)) -Expect '非空'

    $report.passed = ($checks | Where-Object { -not $_.pass }).Count -eq 0
    $exitCode = if ($report.passed) { 0 } else { 1 }
}
catch {
    $report.error = $_.Exception.Message
    Write-Host "drill 失败：$($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
}
finally {
    if ($started -and -not $Keep) {
        $rm = Invoke-Docker -DockerContext $dockerCtx -Arguments @('rm', '-f', $ContainerName)
        $report.destroyed = ($rm.ExitCode -eq 0)
        Write-Host "drill: 销毁容器 $ContainerName -> $(if ($report.destroyed) { 'ok' } else { '失败，请手工 docker rm -f' })"
    }
    elseif ($started -and $Keep) {
        Write-Host "drill: -Keep 保留容器 $ContainerName（排查后手工删除）"
    }
}

$report.exitCode = $exitCode
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$reportPath = Join-Path $OutDir "drill-$timestamp.json"
Write-JsonReport -Path $reportPath -Report $report | Out-Null
Write-Host "报告：$reportPath"
Write-Host "drill 结束：passed=$($report.passed) exitCode=$exitCode"
exit $exitCode
