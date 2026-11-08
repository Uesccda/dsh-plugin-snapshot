@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul 2>&1
echo ============================================
echo   Publish v2: verify token first, then publish
echo ============================================
echo.
echo Paste the token from npmjs.com (starts with npm_)
set /p NPM_TOKEN=Token: 
if "%NPM_TOKEN%"=="" goto fail
set TMPRC=%TEMP%\npmrc_dsh_publish
> "%TMPRC%" echo //registry.npmjs.org/:_authToken=%NPM_TOKEN%
echo.
echo --- Step 1: verify token (whoami) ---
call npm whoami --userconfig="%TMPRC%"
if errorlevel 1 goto badtoken
echo.
echo --- Step 2: publish ---
call npm publish --access public --userconfig="%TMPRC%"
if errorlevel 1 goto fail
echo.
echo --- Step 3: verify on registry ---
call npm view dsh-plugin-snapshot version
del "%TMPRC%" >nul 2>&1
echo.
echo ============================================
echo   DONE - published successfully
echo   Delete that token on npmjs.com now
echo   Next: run open-pr.bat after 2026-11-09 23:50
echo ============================================
pause
exit /b 0

:badtoken
del "%TMPRC%" >nul 2>&1
echo.
echo ============================================
echo   TOKEN REJECTED (whoami failed)
echo   The token is invalid, expired, or lacks access.
echo   Regenerate it and make sure:
echo     - Permissions = Read and write
echo     - Bypass 2FA = checked
echo ============================================
pause
exit /b 1

:fail
del "%TMPRC%" >nul 2>&1
echo.
echo ============================================
echo   PUBLISH FAILED - copy the error above
echo ============================================
pause
exit /b 1
