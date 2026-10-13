@echo off
setlocal
rem Direct Desktop entry uses the same configuration as the other product launchers.
if "%YUR_DESKTOP_GLIDER_CONFIGURED%"=="1" goto launchDesktop
call "%~dp0Start IntelliFlow Unified.cmd" %*
exit /b %errorlevel%

:launchDesktop
rem A product edition's launcher keeps its own console title; the Desktop's is unchanged.
if "%YUR_EDITION%"=="athletics" (
  title YUR Athletics
) else (
  title YUR AI Desktop
)
set "YUR_DESKTOP_DIR=%~dp0"

if not exist "%YUR_DESKTOP_DIR%src\main.js" (
  echo The YUR Desktop source is missing. Keep this launcher in the project folder.
  pause
  exit /b 1
)

if not exist "%YUR_DESKTOP_DIR%node_modules\electron\dist\electron.exe" (
  echo Desktop dependencies are not installed.
  echo Open a terminal in this folder and run npm ci, then try this launcher again.
  pause
  exit /b 1
)

rem Electron must run as a desktop application, even when invoked from a Node tool.
set "ELECTRON_RUN_AS_NODE="
pushd "%YUR_DESKTOP_DIR%" || exit /b 1
start "YUR AI Desktop" "%YUR_DESKTOP_DIR%node_modules\electron\dist\electron.exe" "." %*
set "YUR_DESKTOP_EXIT=%errorlevel%"
popd
if not "%YUR_DESKTOP_EXIT%"=="0" (
  echo Windows could not start YUR AI Desktop.
  pause
)
exit /b %YUR_DESKTOP_EXIT%
