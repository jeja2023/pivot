@echo off
setlocal
chcp 65001 > nul
cd /d "%~dp0\..\.."

where node > nul 2> nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found. Please install Node.js or check PATH.
    echo.
    pause
    exit /b 1
)

node "scripts\git_push.js"
if errorlevel 1 (
    echo.
    echo [ERROR] GitHub push script failed. Please check the message above.
    echo.
    pause
    exit /b 1
)

echo.
pause
endlocal
