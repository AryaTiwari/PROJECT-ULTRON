$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$voiceDir = Join-Path $root '.ultron\voice'
$reference = Join-Path $voiceDir 'ultron-reference.mp3'
New-Item -ItemType Directory -Force -Path $voiceDir | Out-Null
if (-not (Test-Path $reference)) {
  $url = 'https://raw.githubusercontent.com/AryaTiwari/Interface1/main/Ultron-2026-08-27-11-05-%5Bsoft%5D-I-was-designed-to-%5Bemphasis%5D-save-the-wor.mp3'
  Invoke-WebRequest -Uri $url -OutFile $reference
}
@{
  provider = 'nvidia-magpie-zeroshot'
  engine = 'nvidia-magpie-zeroshot'
  model = 'nvidia/magpie-tts-zeroshot'
  referencePath = $reference
  referenceSource = 'AryaTiwari/Interface1'
  voiceProfileReady = $true
  setupAt = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json | Set-Content (Join-Path $voiceDir 'voice-clone.json') -Encoding UTF8
Write-Host 'ULTRON NVIDIA Magpie voice reference is ready.'
