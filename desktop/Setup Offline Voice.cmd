@echo off
setlocal
pushd "%~dp0" || exit /b 1
if not exist ".desktop-python\Scripts\python.exe" (
  echo Run Setup YUR AI Desktop.cmd first.
  popd
  exit /b 1
)
".desktop-python\Scripts\python.exe" -s -m pip install --no-cache-dir -r requirements-voice.txt
if errorlevel 1 goto failed
".desktop-python\Scripts\python.exe" -B scripts/setup_voice.py
if errorlevel 1 goto failed
echo Offline English dictation is ready.
popd
exit /b 0
:failed
echo Voice setup did not complete. Review the error above.
popd
exit /b 1
