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

## 下一步

- 在全新机器按 README 走一遍 clone → `install.ps1` → 触发器与任务验证（尚未实测）。
- 后续官方客户端更新按 `references/maintenance.md` 的五步流程回归。
