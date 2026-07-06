@echo off
chcp 65001 >nul
title 钉钉打卡助手
cd /d "%~dp0"
echo ========================================
echo   钉钉打卡确认助手
echo ========================================
echo.
echo 已启动常驻自动调度，将根据 config.json 配置：
echo   上班 09:45~09:51 发微信确认
echo   下班 19:01~19:20 发微信确认
echo   每日任务完成后自动等待次日，进程保持运行
echo.
echo 请保持本窗口运行，并确保千帆 wxbot 已启动。
echo.
node src/main.js auto
echo.
pause
