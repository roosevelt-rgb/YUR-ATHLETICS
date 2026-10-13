@echo off
setlocal
rem This existing launcher owns the shared Code Glider configuration.
set "YUR_DESKTOP_GLIDER_CONFIGURED=1"
if not defined YUR_UNIFIED_ROOT for %%I in ("%~dp0..\..") do set "YUR_UNIFIED_ROOT=%%~fI"
set "YUR_GLIDER_RC6=1"
set "YUR_HARNESS_AUTOSTART=0"
set "YUR_DESKTOP_HOME=%APPDATA%\yur-intelliflow-glider-rc6\conversations"
set "YUR_FACTORY_HOME=%APPDATA%\yur-intelliflow-glider-rc6\factory"
if not defined YUR_MUSIC_APP_ROOT if exist "D:\YUR-UNIFIED\apps\music-studio\music\server.py" set "YUR_MUSIC_APP_ROOT=D:\YUR-UNIFIED\apps\music-studio"
if not defined YUR_WORKFORCE_SOURCE if exist "%USERPROFILE%\YUR AI WORKING RP\src\yur_workforce\genome.py" set "YUR_WORKFORCE_SOURCE=%USERPROFILE%\YUR AI WORKING RP\src\yur_workforce"
if not defined YUR_WORKFORCE_ROOT if defined YUR_WORKFORCE_SOURCE set "YUR_WORKFORCE_ROOT=%YUR_WORKFORCE_SOURCE%"
set "ELECTRON_RUN_AS_NODE="
call "%~dp0Start YUR AI Desktop.cmd" %*
exit /b %errorlevel%
