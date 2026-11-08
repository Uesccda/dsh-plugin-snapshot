@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul 2>&1
echo ============================================
echo   Publish dsh-plugin-snapshot (token mode)
echo ============================================
echo.
echo Paste the token you just created on npmjs.com
echo (it starts with npm_ and is NOT shown on screen)
echo.
set /p NPM_TOKEN=Token: 
if "%NPM_TOKEN%"=="" goto fail
echo.
echo Publishing...
call npm publish --access public --//registry.npmjs.org/:_authToken=%NPM_TOKEN%
if errorlevel 1 goto fail
echo.
echo Verifying...
call npm view dsh-plugin-snapshot version
echo.
echo ============================================
echo   DONE - published successfully
echo   Remember to delete that token on npmjs.com
echo   Next: run open-pr.bat after 2026-11-09 23:50
echo ============================================
pause
exit /b 0

:fail
echo.
echo ============================================
echo   FAILED - copy the error above and send it back
echo ============================================
pause
exit /b 1
