@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ZSWAP system prompt switcher starting...
node server.js
pause
