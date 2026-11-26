@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
node checkin.js %*
exit /b %errorlevel%
