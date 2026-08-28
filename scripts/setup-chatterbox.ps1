$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$voiceRoot = Join-Path $root '.ultron\voice\chatterbox'
$venv = Join-Path $voiceRoot '.venv'
$reference = Join-Path $root '.ultron\voice\ultron-reference.mp3'

$python = $null
foreach ($candidate in @('py -3.11','py -3.12','py -3.10','python')) {
  try { $null = & cmd /c "$candidate --version" 2>$null; if ($LASTEXITCODE -eq 0) { $python = $candidate; break } } catch {}
}
if (-not $python) { throw 'Python 3.10, 3.11 or 3.12 is required for local Chatterbox Turbo.' }

New-Item -ItemType Directory -Force -Path $voiceRoot | Out-Null
if (-not (Test-Path (Join-Path $venv 'Scripts\python.exe'))) { & cmd /c "$python -m venv `"$venv`"" }
$vp = Join-Path $venv 'Scripts\python.exe'
& $vp -m pip install --upgrade pip setuptools wheel
& $vp -m pip install torch torchaudio
& $vp -m pip install chatterbox-tts

if (-not (Test-Path $reference)) {
  $url = 'https://raw.githubusercontent.com/AryaTiwari/Interface1/main/Ultron-2026-08-27-11-05-%5Bsoft%5D-I-was-designed-to-%5Bemphasis%5D-save-the-wor.mp3'
  Invoke-WebRequest -Uri $url -OutFile $reference
}

$stateDir = Join-Path $root '.ultron\voice'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
@{
  provider = 'chatterbox-turbo-local'
  engine = 'chatterbox-turbo'
  model = 'ResembleAI/chatterbox-turbo'
  referencePath = $reference
  referenceSource = 'AryaTiwari/Interface1'
  voiceProfileReady = $true
  setupAt = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json | Set-Content (Join-Path $stateDir 'voice-clone.json') -Encoding UTF8

Write-Host 'ULTRON local Chatterbox Turbo is installed and the Interface1 MP3 is configured as the reference voice.'
