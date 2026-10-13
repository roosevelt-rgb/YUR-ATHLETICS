# Refresh everything the app reads: ledger -> seed JSON -> MongoDB (db gridiron). Run after any crawl.
#   powershell -File refresh.ps1            (local Mongo)
#   $env:MONGO_URL="mongodb://<runpod-host>:27017"; powershell -File refresh.ps1   (cloud Mongo)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$env:PYTHONIOENCODING = "utf-8"
python -P export_firestore.py
python -P load_mongo.py
Write-Host "refresh complete $(Get-Date -Format s)"
