@echo off
chcp 65001 > nul
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -File "%~dp0\..\collect_windows_installer_diagnostics.ps1"
pause
