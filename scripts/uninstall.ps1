#requires -Version 5.1
<#
.SYNOPSIS
  卸载 Trae CN 自动签到计划任务。
.PARAMETER TaskName
  计划任务名称，默认 TraeCNCheckin。
.PARAMETER PurgeData
  同时删除本地签到数据库目录。
#>
param(
  [string]$TaskName = 'TraeCNCheckin',
  [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "已删除计划任务：$TaskName"
} else {
  Write-Host "计划任务不存在：$TaskName"
}

if ($PurgeData) {
  $dbDir = Join-Path $env:LOCALAPPDATA 'trae-cn-checkin'
  if (Test-Path $dbDir) {
    Remove-Item $dbDir -Recurse -Force
    Write-Host "已删除签到数据：$dbDir"
  }
}
