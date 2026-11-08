@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   Open the awesome-dsh-plugin PR
echo ============================================
echo.
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin --head Uesccda:add-dsh-plugin-snapshot --base main --title "Add dsh-plugin-snapshot" --body-file submission\PR-BODY.md
if errorlevel 1 (
  echo.
  echo If it says the repo is too new, wait until 2026-11-09 23:50 and run again.
  echo Or open this URL manually:
  echo https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/compare/main...Uesccda:add-dsh-plugin-snapshot
  pause
  exit /b 1
)
echo.
echo PR opened. Send me the PR link.
pause
exit /b 0

