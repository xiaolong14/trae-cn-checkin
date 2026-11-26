# Trae CN 每日自动签到

> 一句话让 AI 接手：**「安装 https://github.com/&lt;你的GitHub用户名&gt;/trae-cn-checkin 这个 Skill，然后开启 Trae CN 每天自动签到。」**

读取本机 Trae CN 桌面端已登录账号的加密登录态，调用官方签到接口领取每日积分。签到时间每天在 08:00 至次日 02:00 内随机，失败自动重试，结果写入本地 SQLite。

## 特性

- **随机时间签到**：Windows 计划任务在 08:00–次日 02:00 内随机取一个时刻执行，不固定时间。
- **失败自动重试**：网络或业务失败最多重试 2 次、间隔 10 分钟；登录失效、未开通不重试。
- **今日不会重复领取**：先查服务端状态，本地 `daily_claims` 兜底，领取返回 9004 时回查确认。
- **全程留痕**：每次尝试写入 SQLite，可查结果、积分余额、第几次尝试与耗时。
- **零第三方依赖**：只需 Node.js 22.5+，不需要 `npm install`。
- **数据只留本机**：令牌只在内存中使用，不打印、不上传；数据库只存签到结果与余额。

## 环境要求

| 项 | 要求 |
|---|---|
| 系统 | Windows 10 / 11 |
| 运行时 | Node.js 22.5 及以上（需要内置 `fetch` 与 `node:sqlite`） |
| 客户端 | Trae CN 桌面端已安装并保持登录 |
| 权限 | 当前用户即可，无需管理员 |

## 安装

### 方式一：让 AI 安装（推荐）

把仓库链接填进下面这句话，发给支持 Skill 的 AI 助手：

> 安装 https://github.com/&lt;你的GitHub用户名&gt;/trae-cn-checkin 这个 Skill，然后开启 Trae CN 每天自动签到。

AI 会读取本 README，完成克隆、依赖检查、登录态自检和计划任务注册。同样的说明也写在 [SKILL.md](SKILL.md) 里，安装后 AI 可继续按技能文档维护。

### 方式二：手动安装

```powershell
git clone https://github.com/<你的GitHub用户名>/trae-cn-checkin "$env:USERPROFILE\.agents\skills\trae-cn-checkin"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.agents\skills\trae-cn-checkin\scripts\install.ps1"
```

安装脚本会依次完成：

1. 校验 Node.js 版本；
2. 解密登录态并调用签到状态接口自检（不领取积分）；
3. 注册计划任务 `TraeCNCheckin`：每天 08:00 起，在 08:00–次日 02:00 内随机执行一次；
4. 写入重试参数（2 次 / 10 分钟）；
5. 开启“错过时间后尽快补跑”和“同一时间只跑一个实例”。

安装后立即签到一次：

```powershell
node "$env:USERPROFILE\.agents\skills\trae-cn-checkin\scripts\checkin.js"
```

### 验证安装

```powershell
Get-ScheduledTask -TaskName "TraeCNCheckin" | Select-Object TaskName, State
(Get-ScheduledTask -TaskName "TraeCNCheckin").Triggers | Select-Object StartBoundary, RandomDelay
(Get-ScheduledTask -TaskName "TraeCNCheckin").Actions | Select-Object Arguments
Get-ScheduledTaskInfo -TaskName "TraeCNCheckin" | Select-Object LastTaskResult, NextRunTime
node "$env:USERPROFILE\.agents\skills\trae-cn-checkin\scripts\checkin.js" --history
```

预期：任务为 `Ready`；触发器 `StartBoundary` 为本地 08:00、`RandomDelay` 为 `PT18H`；动作参数包含 `--retries=2 --retry-delay-seconds=600`；`NextRunTime` 落在窗口内。

## 使用

| 命令 | 作用 |
|---|---|
| `node scripts/checkin.js` | 立即签到 / 查询状态 |
| `node scripts/checkin.js --json` | JSON 结果，含 `attempts` 尝试明细 |
| `node scripts/checkin.js --selftest` | 只做登录态、SQLite、接口自检，不领取 |
| `node scripts/checkin.js --history` | 查看历史记录与统计 |
| `node scripts/checkin.js --retries=2` | 失败重试次数，默认 2，范围 0–10 |
| `node scripts/checkin.js --retry-delay-seconds=600` | 重试间隔秒数，默认 600，范围 0–3600 |

退出码：`0` 成功或今日已签到；`1` 网络/协议/数据库失败（会按配置重试）；`2` 登录态失效（不重试）；`3` 未开通签到（不重试）。

## 定时与重试策略

| 机制 | 说明 |
|---|---|
| 每日随机窗口 | 计划任务以 08:00 为基准，`RandomDelay=PT18H`，每次触发重新随机，覆盖 08:00–次日 02:00 |
| 失败重试 | 退出码 1 时最多重试 2 次、间隔 10 分钟（共 3 次尝试） |
| 不重试 | 成功（0）、登录失效（2）、未开通（3） |
| 错过补跑 | `StartWhenAvailable`：休眠/关机错过触发后，系统恢复可用时尽快执行 |
| 可选登录补签 | `-EnableLogonCatchup` 登录后 1 分钟检查一次；会降低随机性，默认关闭 |
| 任务时限 | 重试次数 × 间隔 + 15 分钟，默认 35 分钟 |

电脑关机期间计划任务无法执行，这是 Windows 的限制；开机后由 `StartWhenAvailable` 补跑。

## 配置

### 安装参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `-WindowStart` | `08:00` | 随机窗口开始时间 |
| `-WindowEnd` | `02:00` | 随机窗口结束时间；早于开始时间表示次日 |
| `-Retries` | `2` | 失败后的重试次数，0–10 |
| `-RetryDelayMinutes` | `10` | 每次重试间隔分钟数 |
| `-EnableLogonCatchup` | 关闭 | 额外注册登录触发器 |
| `-TaskName` | `TraeCNCheckin` | 计划任务名称 |
| `-SkipSelftest` | 关闭 | 跳过安装前自检（不建议） |

示例：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "...\install.ps1" -WindowStart "09:00" -WindowEnd "23:00" -Retries 3 -RetryDelayMinutes 15
```

### 环境变量

| 变量 | 作用 | 默认值 |
|---|---|---|
| `TRAE_USER_DATA_DIR` | Trae 用户数据目录，多个用 `;` 分隔 | 自动探测 `%APPDATA%\Trae CN` 等 |
| `TRAE_CHECKIN_DB` | SQLite 数据库完整路径 | `%LOCALAPPDATA%\trae-cn-checkin\checkin.db` |
| `TRAE_CHECKIN_ENDPOINT` | 接口根地址 | `https://api.trae.cn` |
| `TRAE_CHECKIN_RETRIES` | 重试次数默认值 | `2` |
| `TRAE_CHECKIN_RETRY_DELAY_SECONDS` | 重试间隔默认值（秒） | `600` |

命令行参数优先于环境变量。

## 数据与隐私

- 数据库默认位于 `%LOCALAPPDATA%\trae-cn-checkin\checkin.db`。
- `checkin_runs` 记录每次尝试：时间、触发来源、阶段、结果、HTTP 状态、业务码、余额、耗时、第几次尝试。
- `daily_claims` 每个日期一条成功记录，作为本地防重依据。
- 只读取 `storage.json`，不修改、不复制登录态文件。
- accessToken 只在内存中使用，不打印、不写日志、不落盘。
- 不访问 `api.trae.cn` 以外的域名。

## 工作原理

客户端把登录态以 `tc` 魔数 + 32 字节盐值 + AES-128-CBC 的形式保存在 `storage.json`。脚本按客户端逻辑派生密钥解密，拿到 accessToken 后调用：

- `POST /trae/api/v2/ug/checkin_credits/status`：查询是否可签到 / 已签到；
- `POST /trae/api/v2/ug/checkin_credits/claim`：领取积分。

官方客户端升级后如何快速定位和修复，见 [references/maintenance.md](references/maintenance.md)。

## 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.agents\skills\trae-cn-checkin\scripts\uninstall.ps1"
```

加 `-PurgeData` 同时删除 SQLite 记录。

## 风险声明

- 本项目非官方项目，与 Trae / 字节跳动无关。
- 脚本只操作本机已登录的账号，不收集、不上传任何凭据。
- 自动化调用官方接口可能受风控策略影响，请自行评估账号风险；因使用本项目产生的后果由使用者承担。
- 建议保持随机时间与默认低频策略，不要改成短时间内高频调用。

## 目录结构

```text
trae-cn-checkin/
├─ SKILL.md                  # 技能说明：AI 安装、策略、排障
├─ README.md                 # 项目介绍
├─ references/
│  └─ maintenance.md         # 官方更新后的排查与回归手册
└─ scripts/
   ├─ checkin.js             # 签到主程序（登录态解密、接口调用、SQLite）
   ├─ install.ps1            # 安装计划任务
   ├─ uninstall.ps1          # 卸载计划任务
   ├─ install_task.cmd       # 双击安装包装器
   ├─ uninstall_task.cmd     # 双击卸载包装器
   └─ run_checkin.cmd        # 立即签到包装器
```
