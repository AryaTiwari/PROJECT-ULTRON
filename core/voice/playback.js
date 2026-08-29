const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

async function playLocalAudio(file, outputRoot = '.ultron/audio') {
  const resolvedRoot = path.resolve(outputRoot);
  const resolved = path.resolve(file);
  if (!resolved.startsWith(resolvedRoot + path.sep) || !fs.existsSync(resolved)) {
    throw new Error('Audio file not found.');
  }
  if (process.platform !== 'win32') {
    return { ok: false, played: false, error: 'Local direct playback currently targets Windows.' };
  }

  const escaped = resolved.replace(/'/g, "''");
  const ps = `$p = New-Object System.Windows.Media.MediaPlayer; $p.Open([Uri]::new('${escaped}')); Start-Sleep -Milliseconds 500; $p.Play(); while ($p.NaturalDuration.HasTimeSpan -eq $false) { Start-Sleep -Milliseconds 100 }; Start-Sleep -Milliseconds ([int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 250); $p.Close()`;
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName PresentationCore; ' + ps],
    { timeout: 120000, windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  return { ok: true, played: true, path: resolved };
}

module.exports = { playLocalAudio };