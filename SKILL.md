---
name: trae-cn-checkin
description: "自动完成 Trae CN 桌面端（TraeWork / Trae Code）每日签到领取积分。当用户要求立即签到、查看签到记录、配置每日随机时间签到或开机自动签到时使用。"
---

# Trae CN 每日自动签到

读取本机 Trae CN 已登录账号的加密登录态，调用官方签到接口：已签到则跳过，未签到则领取积分，并把每次执行写入 SQLite。

签到时间不固定：每天在用户设定的时间窗口内随机一个时刻执行，降低被官方风控判定为机器行为的概率。失败自动重试。

## 一、AI 安装流程

按顺序执行，全部成功后再向用户汇报。

如果本地还没有技能目录，先把本仓库克隆到技能目录（仓库地址见 README）；已有目录时跳过：

```powershell
git clone https://github.com/xiaolong14/trae-cn-checkin "$env:USERPROFILE\.agents\skills\trae-cn-checkin"
```

### 1. 检查依赖

唯一依赖是 **Node.js 22.5 及以上**（需要内置 `fetch` 和 `node:sqlite`），不需要 `npm install`，不下载任何第三方包。

```powershell
node -p "process.versions.node"
```

低于 22.5 时先安装：

```powershell
winget install OpenJS.NodeJS.LTS
```

或从 <https://nodejs.org/zh-cn/download> 安装后重开终端。

### 2. 执行安装

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.agents\skills\trae-cn-checkin\scripts\install.ps1"
```

安装脚本会依次完成：

1. 校验 Node.js 版本。
2. 读取并解密 `storage.json`，调用签到状态接口做自检（不领取积分）。
3. 注册计划任务 `TraeCNCheckin`：每天从 `08:00` 起，在 `08:00` 至次日 `02:00`（共 18 小时）内随机选一个时刻执行一次。
4. 写入失败重试参数：最多重试 2 次、每次间隔 10 分钟。
5. 开启“错过时间后尽快补跑”（`StartWhenAvailable`）和“同一时间只跑一个实例”。

自定义随机窗口与重试：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "...\install.ps1" -WindowStart "08:00" -WindowEnd "02:00" -Retries 2 -RetryDelayMinutes 10
```

| 参数 | 默认值 | 说明 |
|---|---|---|
| `-WindowStart` | `08:00` | 随机窗口开始时间 |
| `-WindowEnd` | `02:00` | 随机窗口结束时间；早于开始时间表示次日 |
| `-Retries` | `2` | 失败后的重试次数，0-10 |
| `-RetryDelayMinutes` | `10` | 每次重试间隔分钟数 |
| `-EnableLogonCatchup` | 关闭 | 额外注册登录触发器，登录后 1 分钟检查一次；会降低随机性 |
| `-TaskName` | `TraeCNCheckin` | 计划任务名称 |
| `-SkipSelftest` | 关闭 | 跳过安装前自检（不建议） |

默认不注册登录触发器，以保持签到时间随机。需要“开机即补签”时加 `-EnableLogonCatchup`，代价是每次登录都会触发一次检查。

计划任务直接引用技能目录中的 `checkin.js` 和当前 Node.js 路径；移动技能目录、升级或移动 Node.js 后，重新运行一次 `install.ps1` 即可更新任务。

计划任务从下一个随机窗口开始生效；如果今天还没签到，安装后直接运行一次 `node "scripts\checkin.js"` 即可立即补上。

### 3. 验证安装

```powershell
Get-ScheduledTask -TaskName "TraeCNCheckin" | Select-Object TaskName, State
(Get-ScheduledTask -TaskName "TraeCNCheckin").Triggers | Select-Object StartBoundary, RandomDelay
(Get-ScheduledTask -TaskName "TraeCNCheckin").Actions | Select-Object Arguments
Get-ScheduledTaskInfo -TaskName "TraeCNCheckin" | Select-Object LastTaskResult, NextRunTime
node "$env:USERPROFILE\.agents\skills\trae-cn-checkin\scripts\checkin.js" --history
```

预期：

- 任务状态 `Ready`，`MultipleInstances` 为 `IgnoreNew`，任务时限 `PT35M`。
- 触发器 `StartBoundary` 为本地 `08:00`，`RandomDelay` 为 `PT18H`。
- `NextRunTime` 落在“今天的 08:00 至次日 02:00”或其后的窗口内。
- 动作参数包含 `--trigger=auto --retries=2 --retry-delay-seconds=600`。
- 历史记录出现 `trigger=auto`、`尝试 1/3` 的记录。

### 4. 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "...\uninstall.ps1"
```

加 `-PurgeData` 同时删除 SQLite 记录。

## 二、自动签到策略

| 机制 | 作用 |
|---|---|
| 每日随机窗口 | 每天 08:00 至次日 02:00 内随机一个时刻执行，不固定时间 |
| 失败重试 | 退出码 1（网络/接口/业务失败）时最多重试 2 次，间隔 10 分钟 |
| 不做重试的情况 | 成功（0）、登录失效（2）、未开通（3） |
| StartWhenAvailable | 休眠/关机错过触发后，系统恢复可用时尽快补跑 |
| 可选登录补签 | `-EnableLogonCatchup` 时登录后 1 分钟检查一次，会降低随机性 |
| 仅当前用户、交互式运行 | 能读取该用户的 Trae 登录态，不越权 |
| 手动执行 | 任何时候运行 `node scripts/checkin.js` 立即检查 |

Windows 计划任务的 `RandomDelay` 每次触发都会重新随机，因此每天的签到时刻不同。电脑关机期间任务无法运行；开机后由 `StartWhenAvailable` 补跑，或由可选的登录触发器补签。当天已签到则不会再领取。

## 三、幂等与 SQLite 记录

防重复分三层：

1. 先调用 `status`，`checked_in` 为真直接结束，不调用领取接口。
2. 本地 `daily_claims` 表记录当天已领取日期，即使状态接口短暂异常也不会重复领取。
3. 领取接口返回 `9004` 时回查状态，若已签到则按成功处理。

数据库默认位于 `%LOCALAPPDATA%\trae-cn-checkin\checkin.db`，可用 `TRAE_CHECKIN_DB` 覆盖。旧库自动补列，无需删除历史数据。

| 表 | 用途 |
|---|---|
| `checkin_runs` | 每次尝试的完整记录：时间、触发来源、阶段、结果、HTTP 状态、业务码、积分余额、耗时、第几次尝试 |
| `daily_claims` | 每个日期一条成功记录，作为本地防重依据 |

查看记录（每次尝试显示“尝试 1/3”，便于确认重试是否发生）：

```powershell
node "$env:USERPROFILE\.agents\skills\trae-cn-checkin\scripts\checkin.js" --history
node "$env:USERPROFILE\.agents\skills\trae-cn-checkin\scripts\checkin.js" --history --json --limit=50
```

## 四、手动使用

| 命令 | 作用 |
|---|---|
| `node scripts/checkin.js` | 立即签到 / 查询状态 |
| `node scripts/checkin.js --json` | JSON 结果，含 `attempts` 尝试明细与 `retry` 配置 |
| `node scripts/checkin.js --selftest` | 只做登录态、SQLite、接口自检，不领取 |
| `node scripts/checkin.js --history` | 查看历史记录与统计 |
| `node scripts/checkin.js --trigger=auto` | 记录触发来源（计划任务使用） |
| `node scripts/checkin.js --retries=2` | 失败重试次数，默认 2，范围 0-10 |
| `node scripts/checkin.js --retry-delay-seconds=600` | 重试间隔秒数，默认 600，范围 0-3600 |

退出码：`0` 成功或今日已签到；`1` 网络/协议/数据库等失败（会按配置重试）；`2` 登录态失效（不重试）；`3` 未开通签到（不重试）。

## 五、配置项

| 环境变量 | 作用 | 默认值 |
|---|---|---|
| `TRAE_USER_DATA_DIR` | Trae 用户数据目录，多个用 `;` 分隔 | 自动探测 `%APPDATA%\Trae CN` 等 |
| `TRAE_CHECKIN_DB` | SQLite 数据库完整路径 | `%LOCALAPPDATA%\trae-cn-checkin\checkin.db` |
| `TRAE_CHECKIN_ENDPOINT` | 接口根地址 | `https://api.trae.cn` |
| `TRAE_CHECKIN_RETRIES` | 重试次数默认值 | `2` |
| `TRAE_CHECKIN_RETRY_DELAY_SECONDS` | 重试间隔默认值（秒） | `600` |

命令行参数优先于环境变量。

## 六、实现依据

来自客户端安装目录 `resources\app\out\main.js` 的静态解析（REA 证据 `ev_4d7892e6a64adb2318cdd514d865c83f33d90efd8d20bb2b6a70e09ede207c82`）：

- 登录态键：`iCubeAuthInfo://icube.cloudide`；加密格式：Base64 后前 6 字节 `74 63 05 10 00 00`，随后 32 字节盐值，AES-128-CBC 密文。
- 密钥/IV：`SHA-512(盐值)` 与固定 64 字节掩码拼接后再 `SHA-512`，前 16 字节密钥、接着 16 字节 IV；明文前 64 字节为 `SHA-512(明文)` 校验。
- 签到接口：`POST /trae/api/v2/ug/checkin_credits/status`、`POST /trae/api/v2/ug/checkin_credits/claim`；请求头 `Authorization: Cloud-IDE-JWT <token>`、`x-device-id: <telemetry.devDeviceId>`；请求体 `{"req_source":1}`。
- 2026-11-27 起领取接口要求 `x-device-id`，缺失会返回 9004“参数错误”；状态接口不强制。设备标识从 `storage.json` 的 `telemetry.devDeviceId` 读取，不额外采集硬件信息。

## 七、安全约束

- 只读 `storage.json`，不修改、不复制登录态文件。
- 令牌只在内存中使用，不打印、不写日志、不落盘。
- 只访问 `api.trae.cn` 官方域名。
- 数据库只记录签到结果、积分余额、用户 ID，不记录令牌。

## 八、维护与经验沉淀

- 所有逆向得到的协议常量集中在 [checkin.js](scripts/checkin.js) 顶部“协议常量区”，官方更新时只改这一处。
- 完整排查顺序、检索关键词、验证清单和变更记录见 [references/maintenance.md](references/maintenance.md)。
- 每次官方更新后按 `--selftest` → 手动签到 → `--history` 三步回归，并把结论追加到维护文档的“验证记录”。

## 九、排障

| 现象 | 处理 |
|---|---|
| 安装脚本提示 Node 版本过低 | 升级到 Node.js 22.5+，重开终端 |
| 自检退出码 2 / HTTP 401、403 | 打开 Trae CN 重新登录后重试 |
| 返回 `code` 9004 | 缺少 `x-device-id` 或并发领取；脚本已自动带设备标识，仍出现时先看 `--history` |
| 返回 `code` 9074 | 服务端限流“参与用户太多”，稍后重试；任务级重试会自动处理 |
| 找不到 `storage.json` | 用 `TRAE_USER_DATA_DIR` 指定用户数据目录 |
| 计划任务未执行 | `Get-ScheduledTaskInfo -TaskName TraeCNCheckin` 查看上次结果；确认任务为 `Ready`、用户已登录 |
| 任务结果 267011 / 未启动 | 随机延迟尚未到点，看 `NextRunTime` 是否在未来窗口内 |
| 升级或移动 Node.js 后任务失败 | 重新运行 `install.ps1`，更新任务中的 Node 路径 |
| 数据库锁定 | 任务已设置 `IgnoreNew`；手动并发时等待数秒重试 |
| 想确认重试是否发生 | `--history` 看“尝试 x/y”，或 `--json` 看 `attempts` 数组 |

## 十、验证记录

- 2026-11-26：`status` 返回 HTTP 200、`checked_in: true`、余额 100；脚本输出“今日已签到”。
- 2026-11-26：`claim` 在已签到时返回 `9004`，回查逻辑按已签到处理。
- 2026-11-26：计划任务注册、每日双触发器、手动启动、SQLite 写入均实测通过。
- 2026-11-26：计划任务以 `--trigger=auto` 运行，`checkin_runs` 正确记录触发来源。
- 2026-11-26：临时库 + 无效接口验证重试：`--retries=2 --retry-delay-seconds=1` 共 3 次尝试、总耗时 11.3 秒，写入 3 条 `attempt/max_attempts` 记录。
- 2026-11-26：计划任务改为随机窗口版：触发器 `StartBoundary` 08:00、`RandomDelay` `PT18H`，`NextRunTime` 落在次日 01:46（窗口内）；动作参数含 `--retries=2 --retry-delay-seconds=600`，时限 `PT35M`，手动启动 `LastTaskResult=0` 并记录 `尝试 1/3`。
- 2026-11-27：领取接口缺少 `x-device-id` 时返回 9004；补齐后返回 9074（服务端限流），确认设备标识为必需项。
