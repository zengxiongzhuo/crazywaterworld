@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
pushd "%~dp0" || exit /b 1
where node >nul 2>nul
if errorlevel 1 goto missing_node
node -e "var v=/^(\d+)\.(\d+)\.(\d+)$/.exec(process.versions.node); if(!v || !((+v[1]===20 && +v[2]>=19) || (+v[1]===22 && +v[2]>=12) || +v[1]>22)) process.exit(1)"
if errorlevel 1 goto old_node
node tools/start-console.mjs %*
set "code=%ERRORLEVEL%"
if not "%code%"=="0" goto failed
popd
exit /b 0

:missing_node
echo 未找到 Node.js。请安装 Node.js 22.12 或更高稳定版本（包含 npm），然后重新打开此窗口。
echo 下载地址：https://nodejs.org/
set "code=1"
goto failed

:old_node
echo 当前 Node.js 版本不受支持。请安装 Node.js 22.12 或更高稳定版本，或 Node.js 20.19+ 的 20.x。
node --version
set "code=1"
goto failed

:failed
echo.
echo 启动未完成，请根据上方错误处理后重试。
if not "%CW_NO_PAUSE%"=="1" pause
popd
exit /b %code%
