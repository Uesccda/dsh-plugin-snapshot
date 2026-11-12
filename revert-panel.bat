@echo off
setlocal
chcp 65001 >nul 2>&1
echo ============================================
echo   Rollback: disable the Settings panel
echo   (the 3 tools keep working)
echo ============================================
node -e "const fs=require('fs');const p='%USERPROFILE%\.dsh\profiles\desktop/node_modules/dsh-plugin-snapshot/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));if(j.dsh&&j.dsh.client){delete j.dsh.client;fs.writeFileSync(p,JSON.stringify(j,null,2)+String.fromCharCode(10));console.log('removed dsh.client - panel disabled');}else{console.log('dsh.client already absent');}"
echo.
echo Done. Start DSH again.
pause
