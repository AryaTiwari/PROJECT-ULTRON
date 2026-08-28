$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$voiceRoot = Join-Path $root '.ultron\voice\openvoice'
$venv = Join-Path $voiceRoot '.venv'
$reference = Join-Path $root '.ultron\voice\ultron-reference.mp3'
$python = $null
foreach ($candidate in @('py -3.10','py -3.11','python')) {
  try { $null = & cmd /c "$candidate --version" 2>$null; if ($LASTEXITCODE -eq 0) { $python = $candidate; break } } catch {}
}
if (-not $python) { throw 'Python 3.10/3.11 (or python on PATH) is required for the local OpenVoice V2 engine.' }
New-Item -ItemType Directory -Force -Path $voiceRoot | Out-Null
if (-not (Test-Path (Join-Path $venv 'Scripts\python.exe'))) { & cmd /c "$python -m venv `"$venv`"" }
$vp = Join-Path $venv 'Scripts\python.exe'
& $vp -m pip install --upgrade pip setuptools wheel
& $vp -m pip install torch torchaudio
& $vp -m pip install git+https://github.com/myshell-ai/OpenVoice.git
& $vp -m pip install git+https://github.com/myshell-ai/MeloTTS.git
& $vp -m unidic download
& $vp -m pip install huggingface_hub soundfile
& $vp -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='myshell-ai/OpenVoiceV2', local_dir=r'$voiceRoot\checkpoints_v2', local_dir_use_symlinks=False)"
if (-not (Test-Path $reference)) {
  $url = 'https://raw.githubusercontent.com/AryaTiwari/Interface1/main/Ultron-2026-08-27-11-05-%5Bsoft%5D-I-was-designed-to-%5Bemphasis%5D-save-the-wor.mp3'
  Invoke-WebRequest -Uri $url -OutFile $reference
}
$stateDir = Join-Path $root '.ultron\voice'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
@{
  provider = 'openvoice-v2-local'
  engine = 'openvoice-v2'
  model = 'OpenVoiceV2'
  referencePath = $reference
  referenceSource = 'AryaTiwari/Interface1'
  setupAt = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json | Set-Content (Join-Path $stateDir 'voice-clone.json') -Encoding UTF8
Write-Host 'ULTRON local OpenVoice V2 is installed and the Interface1 MP3 is configured as the reference voice.'
