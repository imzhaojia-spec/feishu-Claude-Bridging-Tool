@echo off
REM 飞书桥接 — 进程监督脚本
REM exit 0 = 正常退出不重启, exit 1 = 崩溃重启

:loop
echo [%date% %time%] 飞书桥接启动...
node src\main.js
if %errorlevel% equ 0 goto end
echo [%date% %time%] 桥接崩溃，3 秒后重启...
timeout /t 3 /nobreak >nul
goto loop

:end
echo [%date% %time%] 桥接正常退出。
pause
