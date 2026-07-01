@echo off
chcp 65001 > nul
node scripts/build_installer.js
pause
