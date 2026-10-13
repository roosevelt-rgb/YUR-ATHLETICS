@echo off
setlocal
title YUR Athletics
rem YUR Athletics: the YUR AI Desktop with the Athletics edition and its own profile.
rem It configures the edition, then uses the existing Desktop launcher and its checks.
set "YUR_DESKTOP_GLIDER_CONFIGURED=1"
set "YUR_EDITION=athletics"
if not defined YUR_UNIFIED_ROOT for %%I in ("%~dp0..\..") do set "YUR_UNIFIED_ROOT=%%~fI"
rem Coding, terminal, files and sub-agents stay on the IntelliFlow (RC6) path.
set "YUR_GLIDER_RC6=1"
set "YUR_HARNESS_AUTOSTART=0"
set "YUR_DESKTOP_HOME=%APPDATA%\yur-ai-athletics\conversations"
set "YUR_FACTORY_HOME=%APPDATA%\yur-ai-athletics\factory"
rem Franklin's model until one is picked in the app: an Ollama Cloud model with tool calling,
rem reached through the local Ollama daemon's :cloud proxy, so no model runs on this computer.
rem Set YUR_FRANKLIN_MODEL to choose another. With a dedicated endpoint (YUR_FRANKLIN_OPENAI_URL)
rem its model name stays the user's to set.
if not defined YUR_FRANKLIN_MODEL if not defined YUR_FRANKLIN_OPENAI_URL set "YUR_FRANKLIN_MODEL=ollama:deepseek-v4-pro:cloud"
if not defined YUR_MUSIC_APP_ROOT if exist "D:\YUR-UNIFIED\apps\music-studio\music\server.py" set "YUR_MUSIC_APP_ROOT=D:\YUR-UNIFIED\apps\music-studio"
if not defined YUR_WORKFORCE_SOURCE if exist "%USERPROFILE%\YUR AI WORKING RP\src\yur_workforce\genome.py" set "YUR_WORKFORCE_SOURCE=%USERPROFILE%\YUR AI WORKING RP\src\yur_workforce"
if not defined YUR_WORKFORCE_ROOT if defined YUR_WORKFORCE_SOURCE set "YUR_WORKFORCE_ROOT=%YUR_WORKFORCE_SOURCE%"
if not exist "%~dp0editions\athletics.json" (
  echo The YUR Athletics edition manifest is missing. Keep this launcher in the project folder.
  pause
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE="
call "%~dp0Start YUR AI Desktop.cmd" %*
exit /b %errorlevel%
