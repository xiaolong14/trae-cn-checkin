# 维护手册

本文件记录 Trae CN 签到技能的实现依据、官方更新后的排查顺序和回归验证方法。目标是在客户端升级后，用最少步骤判断“哪里变了、改哪一处、如何验证”。

## 1. 代码位置与检索关键词

客户端安装目录示例（以下用 `<Trae CN 安装目录>` 代指）：

```text
<Trae CN 安装目录>
```

关键文件：

| 文件 | 作用 |
|---|---|
| `resources\app\out\main.js` | 主进程：登录态读写、加密解密、签到接口调用 |
| `resources\app\out\vs\workbench\workbench.desktop.main.js` | 渲染进程：签到入口、状态展示 |
| `resources\app\product.json` | 版本号 |

在 `main.js` 中按以下关键词定位：

| 关键词 | 对应逻辑 |
|---|---|
| `checkin_credits` | 签到接口路径与状态/领取方法 |
| `_requestCheckinCredits` | 状态、领取接口的请求封装 |
| `mixAuthorization` | `Authorization: Cloud-IDE-JWT` 头拼接 |
| `iCubeAuthInfo://` | 登录态存储键 |
| `AES_PRIVATE` / `byteCrypto` | 登录态加解密实现与掩码常量 |
| `decrypt(` + `sha512` | 密钥派生与校验逻辑 |

Windows PowerShell 快速提取上下文：

```powershell
$p='<Trae CN 安装目录>\resources\app\out\main.js'
$s=[IO.File]::ReadAllText($p)
$i=$s.IndexOf('checkin_credits')
$s.Substring([Math]::Max(0,$i-1500), 3000)
```

## 2. 协议常量表

| 项 | 当前值 | 代码位置 |
|---|---|---|
| 接口根地址 | `https://api.trae.cn` | `checkin.js` 协议常量区 |
| 状态接口 | `POST /trae/api/v2/ug/checkin_credits/status` | 同上 |
| 领取接口 | `POST /trae/api/v2/ug/checkin_credits/claim` | 同上 |
| 请求体 | `{"req_source":1}` | 同上 |
| 鉴权头 | `Authorization: Cloud-IDE-JWT <accessToken>` | 同上 |
| 登录态键 | `iCubeAuthInfo://icube.cloudide` | `readAuthInfo()` |
| 密文魔数 | `74 63 05 10 00 00`（`tc` + 版本） | 协议常量区 `MAGIC` |
| 盐值长度 | 32 字节 | `decryptAuthValue()` |
| 密钥派生 | `SHA-512(SHA-512(salt) + (MASK_A ^ MASK_B))` | `deriveAesKey()` |
| 加密算法 | AES-128-CBC + PKCS#7 | `decryptAuthValue()` |
| 完整性校验 | 明文前 64 字节 = `SHA-512(其余明文)` | `decryptAuthValue()` |

## 3. 官方更新后的排查顺序

按以下顺序执行，每一步都能把问题范围缩小一半。

### 第一步：跑自检

```powershell
node "$env:USERPROFILE\.agents\skills\trae-cn-checkin\scripts\checkin.js" --selftest --json
```

| 结果 | 结论 | 下一步 |
|---|---|---|
| 退出码 0 | 登录态、SQLite、接口都正常 | 无需修改 |
| 退出码 2 / HTTP 401 | 登录态过期或鉴权头变化 | 先打开 Trae CN 刷新登录；仍失败看第三步 |
| JSON 解码失败 / 校验失败 | 登录态加密格式变化 | 看第二步 |
| SQLite 不可用 | Node 版本或模块变化 | 检查 Node 版本与 `node:sqlite` |
| 网络错误 | 域名、代理或证书问题 | 检查网络后重试 |

### 第二步：登录态解密失败

1. 在 `main.js` 搜索 `iCubeAuthInfo://`、`AES_PRIVATE`、`sha512`。
2. 确认魔数、盐值长度、密钥派生顺序、掩码数组是否变化。
3. 只修改 `checkin.js` 顶部协议常量区与 `deriveAesKey()` / `decryptAuthValue()`。
4. 用 `--selftest` 验证。

注意：只读取 `storage.json`，不要修改或复制登录态文件。

### 第三步：接口返回 401/403 或 404

1. 在 `main.js` 搜索 `checkin_credits`、`mixAuthorization`、`Cloud-IDE-JWT`。
2. 检查接口路径、请求方法、请求体字段、鉴权头名称是否变化。
3. 修改协议常量区，保持函数结构不变。
4. 用 `--selftest` 验证状态接口，再用手动签到验证领取接口。

### 第四步：响应字段变化

客户端依赖的字段：`enable`、`checked_in`、`did_checked_in`、`credits`、`extra_credits`、`code`、`message`。

字段改名或新增时：

1. 修改 `parseStatus()` 的必填字段校验。
2. 修改 `runCheckinAttempt()` 中对余额、额外积分的读取。
3. 如需持久化新字段，同步修改 `checkin_runs` 建表语句、`recordRun()` 和 `ensureColumn()` 迁移。
4. 旧数据库无需删除，新增列由 `ensureColumn()` 自动 `ALTER TABLE ... ADD COLUMN` 补齐。

### 第五步：回归验证

```powershell
node "$env:USERPROFILE\.agents\skills\trae-cn-checkin\scripts\checkin.js" --selftest
node "$env:USERPROFILE\.agents\skills\trae-cn-checkin\scripts\checkin.js"
node "$env:USERPROFILE\.agents\skills\trae-cn-checkin\scripts\checkin.js" --history
```

确认：

- 自检通过且积分余额可读。
- 今日已签到时不会重复调用领取接口。
- `checkin_runs` 新增一条记录，结果、触发来源、耗时正确。
- 计划任务存在且为 `Ready`。

## 4. 经验与设计决策

- **先查询再领取**：客户端本身也是先 `status` 再 `claim`，这是最可靠的防重方式。
- **本地日期表只做兜底**：`daily_claims` 防止状态接口短暂异常时重复领取，不作为服务端事实来源。
- **9004 不是绝对失败**：已签到、并发领取都会返回 9004，必须回查状态。
- **余额不等于当日收益**：`credits` 记录的是当前余额，统计只累计签到天数，不累计积分，避免误导。
- **交互式计划任务**：必须能读取当前用户的 `%APPDATA%`，所以使用 `Interactive` 登录类型，而不是 SYSTEM。
- **随机时间用计划任务原生能力**：`New-ScheduledTaskTrigger -Daily -At 08:00` 加 `RandomDelay='PT18H'`，由 Task Scheduler 每次触发重新随机，覆盖 08:00 至次日 02:00，脚本无需常驻。
- **默认不做登录即签到**：登录触发器会让“开机时间”成为签到时间，破坏随机性；默认关闭，用 `StartWhenAvailable` 在系统恢复后补跑，需要时再开 `-EnableLogonCatchup`。
- **重试按失败类型区分**：网络、HTTP 5xx、业务失败（退出码 1）才重试，默认 2 次、间隔 10 分钟；登录失效（2）和未开通（3）重试无意义，成功（0）不重试。
- **每次尝试单独入库**：`attempt` / `max_attempts` 记录第几次尝试，便于确认重试是否发生，而不是覆盖成一条。
- **任务时限跟着重试配置走**：`重试次数 × 间隔 + 15 分钟`，默认 35 分钟，防止 Task Scheduler 在最后一次重试前强杀进程。
- **常量集中**：所有易变协议信息集中在协议常量区，官方更新时改动最小。

## 5. 回归验证清单

安装或修改后逐项确认：

- [ ] `node -p "process.versions.node"` ≥ 22.5
- [ ] `checkin.js --selftest` 退出码 0
- [ ] `checkin.js` 输出“签到完成”或“今日已签到”
- [ ] 同一天重复运行不产生第二次领取调用
- [ ] `checkin.js --history` 能看到记录与本月签到天数
- [ ] `Get-ScheduledTask -TaskName TraeCNCheckin` 状态为 `Ready`
- [ ] 触发器 `StartBoundary` 为窗口开始时间、`RandomDelay` 与窗口时长一致
- [ ] 任务动作含 `--retries` 与 `--retry-delay-seconds`，时限覆盖全部重试
- [ ] `Start-ScheduledTask` 后数据库新增 `trigger=auto`、`尝试 1/3` 的记录
- [ ] 临时库 + 无效接口验证失败时确实产生 3 条尝试记录

## 6. 验证记录

| 日期 | 客户端版本 | 结果 |
|---|---|---|
| 2026-11-26 | 1.107.1 | 登录态解密、状态/领取接口、SQLite、每日与登录触发器全部通过；已签到时返回 9004 并正确回查 |
| 2026-11-26 | 1.107.1 | 整体重试通过：临时库 + 无效接口，`--retries=2 --retry-delay-seconds=1` 产生 3 次尝试（耗时 11.3 秒），3 条记录均带 `attempt/max_attempts` |
| 2026-11-26 | 1.107.1 | 随机窗口任务通过：`StartBoundary` 08:00、`RandomDelay` `PT18H`、动作 `--retries=2 --retry-delay-seconds=600`、时限 `PT35M`；手动启动 `LastTaskResult=0`，记录 `尝试 1/3` |
| 2026-11-26 | 1.107.1 | 旧库迁移通过：`checkin_runs` 自动新增 `attempt`、`max_attempts` 列，历史数据保留 |

## 7. 已知限制

- 计划任务只在当前用户登录后运行；关机期间不会执行，开机后由 `StartWhenAvailable` 补跑（默认无登录触发器）。
- 随机延迟由 Task Scheduler 在每次触发时重新计算，脚本无法预知或指定当天具体时刻。
- 重试会延长任务运行时间；重试间隔调大时，任务时限需同步保持“重试次数 × 间隔 + 15 分钟”。
- 登录态过期需要用户打开 Trae CN 刷新，技能不会自动登录。
- Node.js 内置 SQLite 在 22.x 标记为实验特性，会向 stderr 输出一条警告，不影响结果。
- 只适配桌面端 `Trae CN` 系列；移动端和网页端不适用。
