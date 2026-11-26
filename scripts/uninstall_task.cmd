@echo off
chcp 65001 >nul
rem 默认只删除计划任务；加 -PurgeData 同时删除本地签到数据库
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
exit /b %errorlevel%
