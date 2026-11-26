#requires -Version 5.1
<#
.SYNOPSIS
  安装 Trae CN 每日自动签到计划任务。
.DESCRIPTION
  校验 Node.js 与登录态，注册“每日随机时间签到”的 Windows 计划任务。
  任务以 WindowStart 为基准，在 WindowStart 到次日 WindowEnd 的窗口内随机延迟一次执行，
  默认 08:00-02:00 共 18 小时，避免每天固定时间签到。
  签到失败（退出码 1）时按 Retries 重试，默认重试 2 次、间隔 10 分钟。
.PARAMETER WindowStart
  随机窗口开始时间，24 小时制 HH:mm，默认 08:00。
.PARAMETER WindowEnd
  随机窗口结束时间，24 小时制 HH:mm，默认 02:00（次日）。
.PARAMETER Retries
  失败后的重试次数，默认 2，范围 0-10。
.PARAMETER RetryDelayMinutes
  每次重试的间隔分钟数，默认 10。
.PARAMETER EnableLogonCatchup
  额外注册“用户登录时补签”触发器。默认关闭以保持随机性；开启后登录即检查，随机性会降低。
.PARAMETER TaskName
  计划任务名称，默认 TraeCNCheckin。
.PARAMETER SkipSelftest
  跳过安装前自检（不建议）。
#>
param(
  [string]$WindowStart = '08:00',
  [string]$WindowEnd = '02:00',
  [ValidateRange(0, 10)]
  [int]$Retries = 2,
  [ValidateRange(1, 60)]
  [int]$RetryDelayMinutes = 10,
  [switch]$EnableLogonCatchup,
  [string]$TaskName = 'TraeCNCheckin',
  [switch]$SkipSelftest
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$checkinPath = Join-Path $scriptDir 'checkin.js'

# 解析 24 小时制时间
function ConvertTo-DailyTime([string]$value) {
  if ($value -notmatch '^([01]\d|2[0-3]):([0-5]\d)$') {
    throw "时间格式错误：$value，应为 24 小时制 HH:mm，例如 08:00"
  }
  return New-Object TimeSpan ([int]$Matches[1]), ([int]$Matches[2]), 0
}

# 把时长格式化为计划任务 RandomDelay 需要的 ISO 8601 形式，如 PT18H、PT18H30M、P1D
function Format-IsoDuration([TimeSpan]$duration) {
  if ($duration.TotalMinutes -ge 1440) { return 'P1D' }
  $text = 'PT'
  $hours = [int][math]::Floor($duration.TotalHours)
  $minutes = $duration.Minutes
  if ($hours -gt 0) { $text += "${hours}H" }
  if ($minutes -gt 0) { $text += "${minutes}M" }
  if ($text -eq 'PT') { $text = 'PT0M' }
  return $text
}

# 计算随机窗口时长，结束时间不晚于开始时间时视为跨天
$startTime = ConvertTo-DailyTime $WindowStart
$endTime = ConvertTo-DailyTime $WindowEnd
$window = $endTime - $startTime
$crossesMidnight = $false
if ($window.TotalMinutes -le 0) {
  $window = $window.Add((New-TimeSpan -Days 1))
  $crossesMidnight = $true
}
if ($window.TotalMinutes -lt 30) {
  throw "随机窗口过短（$([int]$window.TotalMinutes) 分钟），至少需要 30 分钟"
}
$randomDelay = Format-IsoDuration $window
$windowText = if ($crossesMidnight) { "$WindowStart - 次日 $WindowEnd" } else { "$WindowStart - $WindowEnd" }

# 解析 Node.js 可执行文件
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { '' }
if (-not $nodePath) {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { $nodePath = $candidate; break }
  }
}
if (-not $nodePath) {
  throw '未找到 Node.js。请先安装 Node.js 22.5 或更高版本：https://nodejs.org/zh-cn/download'
}

$nodeVersionText = & $nodePath -p "process.versions.node"
$nodeVersion = [version]$nodeVersionText.Trim()
if ($nodeVersion -lt [version]'22.5.0') {
  throw "Node.js 版本过低（当前 $nodeVersionText），需要 22.5 及以上版本以支持内置 SQLite"
}
Write-Host "Node.js：$nodePath（v$nodeVersionText）"

# 安装前自检：验证登录态、SQLite 和签到接口
if (-not $SkipSelftest) {
  Write-Host '正在检查 Trae CN 登录态与签到接口...'
  & $nodePath $checkinPath --selftest
  if ($LASTEXITCODE -ne 0) {
    throw '安装前自检失败。请先打开 Trae CN 确认已登录后重试，或加 -SkipSelftest 跳过自检'
  }
}

# 构造计划任务：每日随机窗口 + 可选登录补签
$retryDelaySeconds = $RetryDelayMinutes * 60
$argument = "`"$checkinPath`" --trigger=auto --retries=$Retries --retry-delay-seconds=$retryDelaySeconds"
$action = New-ScheduledTaskAction -Execute $nodePath -Argument $argument -WorkingDirectory $scriptDir

$dailyTrigger = New-ScheduledTaskTrigger -Daily -At $WindowStart
# 在窗口内随机延迟，避免每天同一时刻签到
$dailyTrigger.RandomDelay = $randomDelay
$triggers = @($dailyTrigger)

if ($EnableLogonCatchup) {
  $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  # 登录后延迟 1 分钟，等待网络与用户配置就绪
  $logonTrigger.Delay = 'PT1M'
  $triggers += $logonTrigger
}

# 任务时限覆盖全部重试与间隔，并预留单次请求耗时
$limitMinutes = [math]::Max(15, ($Retries * $RetryDelayMinutes) + 15)
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes $limitMinutes) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $triggers `
  -Settings $settings `
  -Principal $principal `
  -Description "Trae CN 每日自动签到：每天在 $windowText 内随机时间执行，失败重试 $Retries 次、间隔 $RetryDelayMinutes 分钟" `
  -Force | Out-Null

$dbPath = Join-Path $env:LOCALAPPDATA 'trae-cn-checkin\checkin.db'
Write-Host ''
Write-Host "安装完成。计划任务：$TaskName"
Write-Host "随机窗口：$windowText（每天窗口内随机一个时间执行，延迟上限 $randomDelay）"
Write-Host "失败重试：最多 $Retries 次，每次间隔 $RetryDelayMinutes 分钟；登录失效、未开通不重试"
if ($EnableLogonCatchup) { Write-Host '已启用登录时补签：开机并登录后检查一次（会降低随机性）' }
Write-Host "任务时限：$limitMinutes 分钟"
Write-Host "签到数据库：$dbPath"
Write-Host ''
Write-Host '手动验证：node "scripts\checkin.js"'
Write-Host '查看记录：node "scripts\checkin.js" --history'
