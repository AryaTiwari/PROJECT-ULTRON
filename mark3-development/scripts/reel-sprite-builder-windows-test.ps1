$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Join-Path $env:TEMP ("ultron-sprite-builder-" + [Guid]::NewGuid().ToString('N'))
$reference = Join-Path $root 'reference.jpg'
$output = Join-Path $root 'sprites'
New-Item -ItemType Directory -Path $root -Force | Out-Null
New-Item -ItemType Directory -Path $output -Force | Out-Null

try {
  $bitmap = New-Object System.Drawing.Bitmap 1536,839
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::FromArgb(246,246,244))
    $defs = @(
      @{ X=25; Y=90; W=260; H=690; C=[System.Drawing.Color]::FromArgb(37,99,235) },
      @{ X=335; Y=135; W=165; H=650; C=[System.Drawing.Color]::FromArgb(236,72,153) },
      @{ X=530; Y=150; W=165; H=640; C=[System.Drawing.Color]::FromArgb(245,158,11) },
      @{ X=720; Y=125; W=165; H=665; C=[System.Drawing.Color]::FromArgb(100,116,139) },
      @{ X=920; Y=85; W=195; H=710; C=[System.Drawing.Color]::FromArgb(220,38,38) },
      @{ X=1140; Y=150; W=155; H=640; C=[System.Drawing.Color]::FromArgb(219,39,119) },
      @{ X=1320; Y=125; W=190; H=665; C=[System.Drawing.Color]::FromArgb(2,132,199) }
    )
    foreach ($def in $defs) {
      $brush = New-Object System.Drawing.SolidBrush $def.C
      try { $graphics.FillRectangle($brush, $def.X, $def.Y, $def.W, $def.H) }
      finally { $brush.Dispose() }
    }
    # Put a white enclosed detail inside the female doctor. Flood-fill background
    # removal must preserve this enclosed white area rather than deleting it.
    $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    try { $graphics.FillRectangle($white, 1170, 260, 90, 180) }
    finally { $white.Dispose() }
  }
  finally { $graphics.Dispose() }
  $bitmap.Save($reference, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  $bitmap.Dispose()

  $builder = Join-Path $PSScriptRoot 'build-elevate-character-sprites.ps1'
  & $builder -ReferencePath $reference -OutputDir $output
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "Sprite builder exited with code $LASTEXITCODE" }

  $expected = @(
    'gym_creator.png',
    'fashion_creator.png',
    'ugc_creator.png',
    'info_creator.png',
    'retention_devil.png',
    'content_doctor_female.png',
    'content_doctor_male.png'
  )
  foreach ($name in $expected) {
    $file = Join-Path $output $name
    if (-not (Test-Path -LiteralPath $file)) { throw "Missing transparent sprite: $name" }
    if ((Get-Item -LiteralPath $file).Length -lt 4096) { throw "Sprite is unexpectedly small: $name" }
  }

  $doctorPath = Join-Path $output 'content_doctor_female.png'
  $doctor = New-Object System.Drawing.Bitmap $doctorPath
  try {
    $transparent = 0
    $opaque = 0
    for ($y = 0; $y -lt $doctor.Height; $y += 20) {
      for ($x = 0; $x -lt $doctor.Width; $x += 20) {
        $alpha = $doctor.GetPixel($x,$y).A
        if ($alpha -lt 16) { $transparent++ }
        if ($alpha -gt 220) { $opaque++ }
      }
    }
    if ($transparent -lt 5) { throw 'Sprite builder did not create meaningful transparent background.' }
    if ($opaque -lt 5) { throw 'Sprite builder removed too much foreground detail.' }
  }
  finally { $doctor.Dispose() }

  Write-Output 'ULTRON Windows character sprite acceptance passed: seven transparent PNG sprites generated from one reference sheet with foreground detail preserved.'
}
finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
