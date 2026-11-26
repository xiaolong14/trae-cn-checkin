@echo off
chcp 65001 >nul
rem 双击或命令行运行均可；参数透传给 install.ps1
rem 例如：install_task.cmd -WindowStart "08:00" -WindowEnd "02:00" -Retries 2 -RetryDelayMinutes 10
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %errorlevel%
