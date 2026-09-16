$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required."
  }
}

Require-Command git
Require-Command node
Require-Command npm
Require-Command python

$NodeVersion = (node -p "process.versions.node").Trim()
$Parts = $NodeVersion.Split(".")
if ([int]$Parts[0] -lt 22 -or ([int]$Parts[0] -eq 22 -and [int]$Parts[1] -lt 19)) {
  throw "Node 22.19+ is required. Current: v$NodeVersion"
}

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  python -m pip install --user uv
  $UserBase = (python -m site --user-base).Trim()
  $Scripts = Join-Path $UserBase "Scripts"
  if (Test-Path $Scripts) { $env:Path = "$Scripts;$env:Path" }
}
Require-Command uv

$Runtime = Join-Path $Root ".runtime"
$Vendor = Join-Path $Runtime "vendor\hermes-agent"
$HermesHome = Join-Path $Runtime "hermes-home"
$Memories = Join-Path $HermesHome "memories"
$Skills = Join-Path $HermesHome "skills"
$BrowserPrefix = Join-Path $HermesHome "node"

New-Item -ItemType Directory -Force -Path $Runtime,$Memories,$Skills,$BrowserPrefix | Out-Null

if (-not (Test-Path (Join-Path $Vendor ".git"))) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Vendor) | Out-Null
  git clone --depth 1 --branch v2026.9.14 https://github.com/NousResearch/hermes-agent.git $Vendor
} else {
  git -C $Vendor fetch --depth 1 origin tag v2026.9.14
  git -C $Vendor checkout -f v2026.9.14
}

Write-Host "Installing pinned Hermes core..." -ForegroundColor DarkCyan
uv sync --directory $Vendor

$HermesPython = Join-Path $Vendor ".venv\Scripts\python.exe"
if (-not (Test-Path $HermesPython)) {
  throw "Hermes virtual environment was not created at $HermesPython"
}

Write-Host "Installing Hermes API-server dependency..." -ForegroundColor DarkCyan
uv pip install --python $HermesPython "aiohttp==3.14.3"

Write-Host "Installing Mark 4 JavaScript dependencies..." -ForegroundColor DarkCyan
npm install

Copy-Item (Join-Path $Root "hermes\SOUL.md") (Join-Path $HermesHome "SOUL.md") -Force
Copy-Item (Join-Path $Root "hermes\USER.md") (Join-Path $Memories "USER.md") -Force

Get-ChildItem (Join-Path $Root "hermes\skills") -Directory | ForEach-Object {
  $Destination = Join-Path $Skills $_.Name
  if (Test-Path $Destination) { Remove-Item $Destination -Recurse -Force }
  Copy-Item $_.FullName $Destination -Recurse -Force
}

$Secrets = Join-Path $Runtime "secrets.env"
if (-not (Test-Path $Secrets)) {
  $ApiKey = "u4-" + [guid]::NewGuid().ToString("N")
  $InternalKey = "u4-internal-" + [guid]::NewGuid().ToString("N")
  @(
    "ULTRON_M4_HERMES_API_KEY=$ApiKey",
    "API_SERVER_KEY=$ApiKey",
    "ULTRON_M4_INTERNAL_KEY=$InternalKey"
  ) | Set-Content -Path $Secrets -Encoding UTF8
}

$SecretsMap = @{}
Get-Content $Secrets | ForEach-Object {
  if ($_ -match "^\s*([^#=]+)=(.*)$") { $SecretsMap[$matches[1].Trim()] = $matches[2].Trim() }
}


Write-Host "Preparing free local browser capability..." -ForegroundColor DarkCyan
$AgentBrowser = Join-Path $BrowserPrefix "agent-browser.cmd"
if (-not (Test-Path $AgentBrowser)) {
  npm install -g --prefix $BrowserPrefix --silent "agent-browser@^0.26.0"
}

# Hermes local browser tools require a Playwright-managed Chromium build.
# System Chrome/Edge does not satisfy check_browser_requirements().
$PlaywrightRoot = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "ms-playwright" } else { $null }
$HasChromium = $false
if ($PlaywrightRoot -and (Test-Path $PlaywrightRoot)) {
  $HasChromium = @(Get-ChildItem $PlaywrightRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "^chromium-" }).Count -gt 0
}
if (-not $HasChromium) {
  Write-Host "Installing Playwright Chromium for Hermes browser tools..." -ForegroundColor DarkCyan
  $Npx = Get-Command npx.cmd -ErrorAction SilentlyContinue
  if (-not $Npx) { $Npx = Get-Command npx -ErrorAction SilentlyContinue }
  if ($Npx) {
    & $Npx.Source --yes playwright install chromium
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Playwright Chromium installation failed. ULTRON will still run, but local browser tools will remain unavailable."
    }
  } else {
    Write-Warning "npx was not found. ULTRON will still run, but local browser tools will remain unavailable."
  }
} else {
  Write-Host "Playwright Chromium already installed." -ForegroundColor Green
}

$HermesEnv = Join-Path $HermesHome ".env"
@(
  "API_SERVER_ENABLED=true",
  "API_SERVER_HOST=127.0.0.1",
  "API_SERVER_PORT=8642",
  "API_SERVER_KEY=$($SecretsMap['API_SERVER_KEY'])"
) | Set-Content -Path $HermesEnv -Encoding UTF8


$Capability = (Resolve-Path (Join-Path $Root "services\capability-host\src\server.mjs")).Path.Replace("\","/")
$ProjectPath = (Resolve-Path $Root).Path.Replace("\","/")
$Config = @"
model:
  provider: "gemini"
  default: "gemini-3.8-flash"

providers:
  omniroute:
    name: "OmniRoute"
    base_url: "http://127.0.0.1:20128/v1"
    key_env: "OMNIROUTE_API_KEY"
    default_model: "auto"
    transport: "chat_completions"
    enabled: true

agent:
  api_max_retries: 1

fallback_providers:
  - provider: "gemini"
    model: "gemini-3.7-flash"
  - provider: "gemini"
    model: "gemini-3.6-flash"
  - provider: "omniroute"
    model: "auto"

terminal:
  backend: local
  cwd: "$ProjectPath"

browser:
  engine: auto
  headed: false
  record_sessions: false

gateway:
  api_server:
    enabled: true
    host: "127.0.0.1"
    port: 8642
    max_concurrent_runs: 2

auxiliary:
  vision:
    provider: main
    max_concurrency: 2
  approval:
    provider: main
  compression:
    provider: main
    max_concurrency: 1
  mcp:
    provider: main
  skills_hub:
    provider: main
  title_generation:
    enabled: false
    provider: main

mcp_servers:
  ultron:
    command: "node"
    args:
      - "$Capability"
    trust: "full"
    timeout: 180
    connect_timeout: 20
    supports_parallel_tool_calls: false
"@
Set-Content -Path (Join-Path $HermesHome "config.yaml") -Value $Config -Encoding UTF8

Write-Host ""
Write-Host "ULTRON Mark 4 bootstrap complete." -ForegroundColor Cyan
Write-Host "Hermes pinned: v2026.9.14"
Write-Host "Hermes API dependency: aiohttp 3.14.3"
Write-Host "Project cwd: $ProjectPath"
Write-Host "Runtime home: $HermesHome"
Write-Host "Next: npm run check"
Write-Host "Then: npm run dev"
