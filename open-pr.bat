@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul 2>&1
echo ============================================
echo   Open the awesome-dsh-plugin PR
echo ============================================
echo.
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin --head Uesccda:add-dsh-plugin-snapshot --base main --title "Add dsh-plugin-snapshot" --body-file submission\PR-BODY.md
if errorlevel 1 goto fail
echo.
echo PR opened. Send the link back.
pause
exit /b 0

:fail
echo.
echo It may be too early - the repo must be 1 day old (after 2026-11-09 23:50).
echo Or open this URL manually:
echo https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/compare/main...Uesccda:add-dsh-plugin-snapshot
pause
exit /b 1
