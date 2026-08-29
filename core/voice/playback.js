const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
let playbackTail = Promise.resolve();
let lastPlayback = { key: '', at: 0, promise: null };

async function playOnce(file, outputRoot = '.ultron/audio') {
  const resolvedRoot = require('path').resolve(outputRoot);
  const resolved = require('path').resolve(file);
  if (!resolved.startsWith(resolvedRoot + require('path').sep) || !fs.existsSync(resolved)) throw new Error('Audio file not found.');
  if (process.platform !== 'win32') return { ok: false, played: false, error: 'Local direct playback currently targets Windows.' };
  const escaped = resolved.replace(/'/g, "''");
  const ps = `$p = New-Object System.Windows.Media.MediaPlayer; $p.Open([Uri]::new('${escaped}')); Start-Sleep -Milliseconds 350; while ($p.NaturalDuration.HasTimeSpan -eq $false) { Start-Sleep -Milliseconds 50 }; $p.Play(); Start-Sleep -Milliseconds ([int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 350); $p.Stop(); $p.Close()`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName PresentationCore; ' + ps], { timeout: 180000, windowsHide: true, maxBuffer: 1024 * 1024 });
  return { ok: true, played: true, path: resolved };
}

function playLocalAudio(file, outputRoot = '.ultron/audio') {
  const key = require('path').resolve(file);
  const now = Date.now();
  if (lastPlayback.key === key && now - lastPlayback.at < 8000 && lastPlayback.promise) return lastPlayback.promise;
  const run = playbackTail.then(() => playOnce(file, outputRoot));
  playbackTail = run.catch(() => {});
  lastPlayback = { key, at: now, promise: run };
  run.finally(() => {
    if (lastPlayback.promise === run && Date.now() - lastPlayback.at >= 8000) lastPlayback = { key: '', at: 0, promise: null };
  });
  return run;
}

module.exports = { playLocalAudio };
