# Start Gridiron Scout: database check, the web app (http://127.0.0.1:3000) and Franklin in the YUR AI Athletics desktop,
# then open both. Safe to run twice: anything already running is left alone. Stop everything with "Stop Gridiron Scout.cmd".
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
# a real connect test (Get-NetTCPConnection does not show the listen state of ports owned by Windows services such as MongoDB)
function Listening([int]$port) {
  try { $c = New-Object Net.Sockets.TcpClient; $r = $c.BeginConnect('127.0.0.1', $port, $null, $null); $ok = $r.AsyncWaitHandle.WaitOne(400) -and $c.Connected; $c.Close(); $ok }
  catch { $false }
}
function WaitFor([int]$port, [int]$seconds) { for ($i = 0; $i -lt $seconds * 2 -and -not (Listening $port); $i++) { Start-Sleep -Milliseconds 500 }; Listening $port }

Write-Host "`n  GRIDIRON SCOUT`n" -ForegroundColor Cyan

# 0. First run: with no athlete records yet, start from the fictional sample (recruit/data/sample/athletes).
$athletes = Join-Path $root 'recruit\data\athletes'
if (-not (Get-ChildItem -Path $athletes -Filter *.json -ErrorAction SilentlyContinue)) {
  New-Item -ItemType Directory -Force -Path $athletes | Out-Null
  Copy-Item (Join-Path $root 'recruit\data\sample\athletes\*.json') $athletes
  Write-Host "  [ok] sample athlete copied to recruit\data\athletes (fictional; load it with: python -P recruit\load_mongo.py)" -ForegroundColor Green
}

# 1. Database (MongoDB, the app's data)
if (Listening 27017) { Write-Host "  [ok] database" -ForegroundColor Green }
else {
  try { Start-Service MongoDB -ErrorAction Stop; if (WaitFor 27017 15) { Write-Host "  [ok] database started" -ForegroundColor Green } }
  catch { Write-Host "  [!!] MongoDB is not running and could not be started here. Start the 'MongoDB' service (Services app) and run this again." -ForegroundColor Yellow }
}

# 2. Agent brain (Ollama daemon -> DeepSeek V4 Pro on Ollama Cloud)
if (Listening 11434) { Write-Host "  [ok] agent brain (Ollama)" -ForegroundColor Green }
elseif (Get-Command ollama -ErrorAction SilentlyContinue) {
  Start-Process ollama -ArgumentList 'serve' -WindowStyle Minimized
  if (WaitFor 11434 15) { Write-Host "  [ok] agent brain started" -ForegroundColor Green } else { Write-Host "  [!!] Ollama did not start; the agent will run without its brain." -ForegroundColor Yellow }
}
else { Write-Host "  [!!] Ollama is not installed or not on PATH; the agent needs it." -ForegroundColor Yellow }

# 3. Web app. DISABLE_HMR=true (vite.config.ts) turns hot reload off for the desktop: pages do not reload while agents
#    edit files, and no page dials Vite's hot-reload socket (none is started either), which the desktop's side browser
#    would block (it only admits http://127.0.0.1:3000). An instance that is already running keeps the settings it was
#    started with.
if (Listening 3000) { Write-Host "  [ok] web app already running" -ForegroundColor Green }
else {
  $env:DISABLE_HMR = 'true'
  Start-Process cmd -ArgumentList '/k', "title Gridiron Scout - web app && cd /d `"$root`" && npm run dev" -WindowStyle Minimized
  if (WaitFor 3000 60) { Write-Host "  [ok] web app started" -ForegroundColor Green } else { Write-Host "  [!!] web app did not come up; open the 'Gridiron Scout - web app' window to see why." -ForegroundColor Yellow }
}

# 4. Franklin in the YUR AI Athletics desktop: Gridiron's scout tools (agent_runtime/gridiron_mcp.py) plus a side browser
#    that shows the Gridiron sections at http://127.0.0.1:3000. The desktop's own launcher picks the build (Electron
#    Athletics edition) and sets its profile; the studio-tauri exe and its profile variables are no longer used here.
$desktopLauncher = Join-Path (Split-Path -Parent $root) 'desktop\Start YUR AI Athletics.cmd'
if (-not (Test-Path $desktopLauncher)) { Write-Host "  [!!] YUR AI Athletics launcher not found at $desktopLauncher" -ForegroundColor Yellow }
elseif (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*YUR AI Athletics*' }) {
  Write-Host "  [!!] YUR AI Athletics is already open. Use that window, or close it and run this again to open Franklin with Gridiron's tools." -ForegroundColor Yellow
}
else {
  Start-Process -FilePath $desktopLauncher -WorkingDirectory (Split-Path $desktopLauncher)
  Write-Host "  [ok] YUR AI Athletics opened with Franklin + Gridiron tools" -ForegroundColor Green
}

$athlete = if ($env:GRIDIRON_ATHLETE) { $env:GRIDIRON_ATHLETE } else { 'quinn-placeholder' }
if (Listening 3000) { Start-Process "http://127.0.0.1:3000/player/$athlete" }
Write-Host "`n  App:    http://127.0.0.1:3000   (athlete page: /player/$athlete)"
Write-Host "  Agent:  Franklin in the YUR AI Athletics window (Gridiron tools and sections)"
Write-Host "  Both only answer this computer. Close with 'Stop Gridiron Scout.cmd'.`n"
