# Start Vulnexis on Windows (PowerShell).
#   .\demo\start.ps1            live data (needs internet), http://localhost:8787
#   .\demo\start.ps1 -Offline   saved snapshots only (bundled sample + demo data work without internet)
param([switch]$Offline)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$have = (node -p "process.versions.node") 2>$null
if (-not $have -or [int]($have.Split('.')[0]) -lt 22) {
  Write-Error "Vulnexis needs Node.js 22 or newer (found: $have). Install it from https://nodejs.org"
}

if (-not (Test-Path node_modules)) { npm ci --no-audit --no-fund }
if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  Write-Host "Created .env. Add GEMINI_API_KEY=... to it to turn on the AI code check (free key: https://aistudio.google.com/apikey)."
}

npm run build

$port = (Select-String -Path .env -Pattern '^PORT=(\d+)' | ForEach-Object { $_.Matches[0].Groups[1].Value }) | Select-Object -First 1
if (-not $port) { $port = 8787 }
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress
Write-Host ""
Write-Host "Vulnexis is starting:"
Write-Host "  this computer:  http://localhost:$port"
if ($ip) { Write-Host "  your phone (same Wi-Fi):  http://${ip}:$port" }
Write-Host "Stop with Ctrl+C."
Write-Host ""

if ($Offline) { $env:OFFLINE = '1' }
npm start
