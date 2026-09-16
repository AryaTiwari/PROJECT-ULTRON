$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required. FreeLLMAPI test runtime uses Docker Desktop on Windows."
  }
}

Require-Command docker

try {
  docker info *> $null
} catch {
  throw "Docker is installed but the Docker engine is not running. Start Docker Desktop, then run npm run freellm:setup again."
}
if ($LASTEXITCODE -ne 0) {
  throw "Docker engine is not available. Start Docker Desktop, then run npm run freellm:setup again."
}

$Runtime = Join-Path $Root ".runtime\freellmapi"
$Compose = Join-Path $Runtime "docker-compose.yml"
$FreeEnv = Join-Path $Runtime ".env"
New-Item -ItemType Directory -Force -Path $Runtime | Out-Null

if (-not (Test-Path $FreeEnv)) {
  $Bytes = New-Object byte[] 32
  $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $Rng.GetBytes($Bytes) } finally { $Rng.Dispose() }
  $EncryptionKey = ($Bytes | ForEach-Object { $_.ToString("x2") }) -join ""
  @(
    "ENCRYPTION_KEY=$EncryptionKey",
    "PORT=3001",
    "HOST_BIND=127.0.0.1"
  ) | Set-Content -Path $FreeEnv -Encoding UTF8
}

@'
services:
  freellmapi:
    image: ghcr.io/tashfeenahmed/freellmapi:v0.10.1
    env_file:
      - .env
    environment:
      NODE_ENV: production
      PORT: 3001
    ports:
      - "127.0.0.1:3001:3001"
    volumes:
      - freellmapi-data:/app/server/data
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped
    healthcheck:
      test: ["CMD","node","-e","fetch('http://127.0.0.1:3001/api/ping').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      start_period: 10s
      retries: 6
volumes:
  freellmapi-data:
'@ | Set-Content -Path $Compose -Encoding UTF8

Write-Host "Starting pinned FreeLLMAPI v0.10.1..." -ForegroundColor DarkCyan
docker compose -f $Compose --env-file $FreeEnv pull
if ($LASTEXITCODE -ne 0) { throw "Failed to pull FreeLLMAPI v0.10.1." }
docker compose -f $Compose --env-file $FreeEnv up -d
if ($LASTEXITCODE -ne 0) { throw "Failed to start FreeLLMAPI." }

$Deadline = (Get-Date).AddSeconds(90)
$Ready = $false
while ((Get-Date) -lt $Deadline) {
  try {
    $Response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3001/api/ping" -TimeoutSec 3
    if ($Response.StatusCode -ge 200 -and $Response.StatusCode -lt 300) {
      $Ready = $true
      break
    }
  } catch {}
  Start-Sleep -Milliseconds 750
}
if (-not $Ready) {
  docker compose -f $Compose --env-file $FreeEnv ps
  throw "FreeLLMAPI container started but did not become healthy on http://127.0.0.1:3001/api/ping."
}

$ProjectEnv = Join-Path $Root ".env"
if (-not (Test-Path $ProjectEnv)) { New-Item -ItemType File -Path $ProjectEnv | Out-Null }
$Current = Get-Content $ProjectEnv -Raw -ErrorAction SilentlyContinue
if ($Current -notmatch "(?m)^FREELLM_API_BASE=") {
  Add-Content -Path $ProjectEnv -Value "FREELLM_API_BASE=http://127.0.0.1:3001/v1"
}
if ($Current -notmatch "(?m)^FREELLM_MODEL=") {
  Add-Content -Path $ProjectEnv -Value "FREELLM_MODEL=auto"
}

Write-Host ""
Write-Host "FreeLLMAPI is running locally." -ForegroundColor Green
Write-Host "Dashboard: http://127.0.0.1:3001"
Write-Host ""
Write-Host "One-time setup:" -ForegroundColor Cyan
Write-Host "1. Open the dashboard and create the local admin account."
Write-Host "2. On Keys / Fallback Chain, keep at least one usable free route enabled (anonymous routes or your free-tier provider keys)."
Write-Host "3. Copy the generated unified API key (freellmapi-...)."
Write-Host "4. Add this line to $ProjectEnv"
Write-Host "   FREELLM_API_KEY=freellmapi-YOUR-KEY"
Write-Host "5. Then run: npm run dev:freellm-test"
Write-Host ""
Write-Host "Normal ULTRON remains: npm run dev"
