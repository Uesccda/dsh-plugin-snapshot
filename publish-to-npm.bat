@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   Publish dsh-plugin-snapshot to npm
echo ============================================
echo.
echo Step 1/3: npm login (browser will open, click Authorize)
call npm login
if errorlevel 1 goto fail
echo.
echo Step 2/3: npm publish
call npm publish --access public
if errorlevel 1 goto fail
echo.
echo Step 3/3: verify
call npm view dsh-plugin-snapshot version
if errorlevel 1 goto fail
echo.
echo ============================================
echo   DONE. Published successfully.
echo   Next: run 提PR.bat after 2026-11-09 23:50
echo ============================================
pause
exit /b 0

:fail
echo.
echo ============================================
echo   FAILED. Copy the error above and send it back.
echo ============================================
pause
exit /b 1

