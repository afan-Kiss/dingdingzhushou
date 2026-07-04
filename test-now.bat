@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ========================================
echo  钉钉打卡确认助手 - 立即测试
echo ========================================
echo.
echo 选择测试模式:
echo   1 = 上班 morning (立即发确认，不随机等待)
echo   2 = 下班 evening (立即发确认，不随机等待)
echo   3 = dry-run 上班 (不实际操作)
echo   4 = dry-run 下班
echo.
set /p choice=请输入 1/2/3/4 [默认1]: 
if "%choice%"=="" set choice=1

if "%choice%"=="1" (
  node src/main.js morning --test-now
) else if "%choice%"=="2" (
  node src/main.js evening --test-now
) else if "%choice%"=="3" (
  node src/main.js morning --dry-run
) else if "%choice%"=="4" (
  node src/main.js evening --dry-run
) else (
  echo 无效选择
  exit /b 1
)
pause
