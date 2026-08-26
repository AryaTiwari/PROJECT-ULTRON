$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$omniCandidates = @(
  $env:OMNIROUTE_DIR,
  "$HOME\Downloads\OmniRoute-release-v3.8.51\OmniRoute-release-v3.8.51",
  "$HOME\Downloads\OmniRoute"
) | Where-Object { $_ -and (Test-Path (Join-Path $_ 'package.json')) }

if ($omniCandidates.Count -gt 0) {
  $omni = $omniCandidates[0]
  Write-Host "Starting OmniRoute from $omni" -ForegroundColor Cyan
  Start-Process powershell -ArgumentList '-NoExit','-Command',"Set-Location '$omni'; npm run dev"
  Start-Sleep -Seconds 3
} else {
  Write-Host 'OmniRoute folder not auto-detected. ULTRON will still start; configure OMNIROUTE_DIR when needed.' -ForegroundColor Yellow
}

Write-Host 'Starting ULTRON Core...' -ForegroundColor Green
Start-Process powershell -ArgumentList '-NoExit','-Command',"Set-Location '$root'; npm run core:start"
Write-Host 'ULTRON Mark 2 Core launch requested.' -ForegroundColor Green
