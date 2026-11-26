# 经验与纠正

## 每次开工先读根规范与工作记忆

- 适用：所有开发任务。
- 纠正：创建仓库时只加载了技能，未按“开工入口”读取 `AGENTS.md` 与 `memory-bank/`，收尾也未写回进度。
- 做法：开工运行 `project_memory.py start --project ... --task ...`，收尾更新 `active.md` 与 `progress.md`。
- 验证：根规范索引存在，四份记忆文件与当前代码一致。

## Windows PowerShell 5.1 脚本编码

- 适用：包含中文的 `.ps1` 与 `.cmd`。
- 依据：PS 5.1 读取无 BOM 的 UTF-8 `.ps1` 会乱码；`.cmd` 使用 LF 会解析异常。
- 做法：`.ps1` 保存为 UTF-8 with BOM + CRLF；`.cmd` 保存为 CRLF；`.gitattributes` 固定 `eol=crlf`。
- 验证：`[IO.File]::ReadAllBytes()` 检查 BOM，`Parser::ParseFile()` 检查语法。

## 旧库升级用补列而不是重建

- 适用：`checkin_runs` 增加字段。
- 做法：`PRAGMA table_info` 检查后用 `ALTER TABLE ... ADD COLUMN`，保留历史记录。
- 验证：旧库打开后列存在，`--history` 正常读取。

## 重试要用临时库验证

- 适用：验证失败重试与任务时限。
- 做法：`TRAE_CHECKIN_DB` 指向临时库、`TRAE_CHECKIN_ENDPOINT` 指向无效地址、`--retry-delay-seconds=1`，核对尝试次数与记录条数，避免污染正式数据。
- 验证：`attempts` 数组长度、`checkin_runs` 新增行数与时间间隔。
