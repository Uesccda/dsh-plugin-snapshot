@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul 2>&1
echo ============================================
echo   Publish dsh-plugin-snapshot to npmjs.org
echo   (forced registry: registry.npmjs.org)
echo ============================================
echo.
echo Paste the token from npmjs.com (starts with npm_)
set /p NPM_TOKEN=Token: 
if "%NPM_TOKEN%"=="" goto fail
set TMPRC=%TEMP%\npmrc_dsh_publish
> "%TMPRC%" echo registry=https://registry.npmjs.org/
>> "%TMPRC%" echo //registry.npmjs.org/:_authToken=%NPM_TOKEN%
echo.
echo --- Step 1: verify token ---
call npm whoami --registry=https://registry.npmjs.org/ --userconfig="%TMPRC%"
if errorlevel 1 goto badtoken
echo.
echo --- Step 2: publish ---
call npm publish --access public --registry=https://registry.npmjs.org/ --userconfig="%TMPRC%"
if errorlevel 1 goto fail
echo.
echo --- Step 3: verify on registry ---
call npm view dsh-plugin-snapshot version --registry=https://registry.npmjs.org/
del "%TMPRC%" >nul 2>&1
echo.
echo ============================================
echo   DONE - published successfully
echo   Delete that token on npmjs.com now
echo   The marketplace entry is already merged,
echo   it will show this version once npm is updated.
echo ============================================
pause
exit /b 0

:badtoken
del "%TMPRC%" >nul 2>&1
echo TOKEN INVALID or lacks publish permission
pause
exit /b 1

:fail
del "%TMPRC%" >nul 2>&1
echo PUBLISH FAILED - see messages above
pause
exit /b 1
