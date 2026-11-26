# 当前任务

当前目标：维护 trae-cn-checkin 公开仓库，并保持本机每日自动签到运行。

## 验收条件

- `main` 分支包含技能、脚本与文档，且不含数据库、日志、登录态和个人路径。
- README 提供给 AI 的一句话安装指令和手动安装步骤。
- 本机计划任务 `TraeCNCheckin` 为随机窗口版本：08:00 触发器 + `RandomDelay=PT18H`，失败重试 2 次、间隔 10 分钟。

## 已完成

- 初始化 git 仓库并提交 `81f1218`。
- README、`.gitignore`、`.gitattributes` 就绪，个人路径已脱敏。
- 发布到 GitHub：<https://github.com/xiaolong14/trae-cn-checkin>，`main` 已推送。
- README 与 SKILL.md 中的仓库地址占位符已替换为真实地址。
- 修正 GitHub 仓库描述乱码（API 写入编码问题），线上描述已为中文。

## 最近一次修复（2026-11-27）

- 根因：`x-device-id` 取值错误。`telemetry.devDeviceId` 是 UUID，服务端不认，claim 返回 9074；真正可用的是 `storage.json` 键名 `iCubeAuthInfo://icube-dc:<数字>` 中的真实设备号。
- 修复：`checkin.js` 新增 `extractDeviceId()`，缺失设备号时直接返回 `missing_device_id`；claim 兼容 9004/9095 已签到码。
- 验证：真实设备号 claim 返回 `{"code":0,"message":"success"}`；官方脚本 `--json --selftest` 显示 `checkedIn: true`、余额 100；正式库记录今日已签到（`manual`，尝试 1/1）。
- 参考 [L0NE-6/Trae-AutoCheckin](https://github.com/L0NE-6/Trae-AutoCheckin) 后确认：其“每轮生成临时 16 位设备号”的做法不采用，避免被判定为规避设备指纹。

## 下一步

- 在全新机器按 README 走一遍 clone → `install.ps1` → 触发器与任务验证（尚未实测）。
- 后续官方客户端更新按 `references/maintenance.md` 的五步流程回归。
- 如需进一步贴近官方客户端，可评估补充 `X-User-Region`、`User-Agent`、`x-device-type` 等设备头；当前仅 `x-device-id` 已验证可成功领取。
