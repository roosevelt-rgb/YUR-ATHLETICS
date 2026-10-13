# Stop Gridiron Scout's web app (:3000) and scout agent (:8079). Leaves the database and Ollama running.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$stopped = @()
foreach ($port in 3000, 8079) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    $stopped += $_.OwningProcess; Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}
# the npm / tsx parents of the web app and the cmd windows the start button opened
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -in 'node.exe', 'python.exe', 'cmd.exe') -and $_.CommandLine -and $_.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
  $_.CommandLine -match 'run dev|tsx|server\.ts|scout_harness\.py|Gridiron Scout - '
} | ForEach-Object { $stopped += $_.ProcessId; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host ("Gridiron Scout stopped (" + (($stopped | Sort-Object -Unique) -join ', ') + ")")
