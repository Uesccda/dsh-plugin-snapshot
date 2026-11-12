@echo off
setlocal
chcp 65001 >nul 2>&1
echo ============================================
echo   Emergency restore: newest snapshot
echo   Use this when DSH cannot start.
echo ============================================
node "%~dp0restore-latest.mjs"
echo.
echo If DSH still fails, run: pnpm install in the profile directory
pause
