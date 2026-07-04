@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 钉钉打卡确认助手 - 手动启动
echo 用法: start-helper.bat [morning^|evening]
set TASK=%1
if "%TASK%"=="" set TASK=morning
node src/main.js %TASK%
pause
