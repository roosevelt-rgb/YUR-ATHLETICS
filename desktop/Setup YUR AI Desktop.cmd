@echo off
setlocal
pushd "%~dp0" || exit /b 1
if not exist ".desktop-python\Scripts\python.exe" (
  python -s -m venv .desktop-python
  if errorlevel 1 goto failed
)
".desktop-python\Scripts\python.exe" -s -m pip install -r requirements-desktop.txt
if errorlevel 1 goto failed
call npm ci
if errorlevel 1 goto failed
echo YUR AI Desktop dependencies are ready. Use Start YUR AI Desktop.cmd.
popd
exit /b 0
:failed
echo Setup failed. Review the error above before starting the desktop.
popd
exit /b 1
