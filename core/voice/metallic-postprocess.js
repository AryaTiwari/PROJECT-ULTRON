const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { config } = require('./config');

const execFileAsync = promisify(execFile);

async function hasFfmpeg() {
  try {
    await execFileAsync('ffmpeg', ['-version'], { windowsHide: true, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function processMetallic(inputPath, outputPath = inputPath) {
  const mix = Math.max(0, Math.min(0.24, Number(config.metallicMix) || 0));
  if (!mix || !(await hasFfmpeg())) {
    return { applied: false, path: inputPath, reason: 'ffmpeg-unavailable-or-disabled' };
  }

  const tempPath = outputPath.replace(/\.mp3$/i, '.metallic.mp3');
  const presence = (0.55 + mix * 1.5).toFixed(2);
  const air = (0.2 + mix * 1.1).toFixed(2);

  // Keep the metallic character subtle: one voice signal, light EQ,
  // gentler compression, and a small loudness lift instead of heavy gain.
  const filter = [
    'highpass=f=85',
    `equalizer=f=2400:t=q:w=1:g=${presence}`,
    `equalizer=f=7200:t=q:w=1:g=${air}`,
    'acompressor=threshold=-20dB:ratio=2:attack=8:release=100:makeup=1',
    'volume=1.5',
    'alimiter=limit=0.96',
  ].join(',');

  try {
    await execFileAsync(
      'ffmpeg',
      ['-y', '-i', inputPath, '-af', filter, '-codec:a', 'libmp3lame', '-q:a', '2', tempPath],
      { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 }
    );
    fs.renameSync(tempPath, outputPath);
    return {
      applied: true,
      path: outputPath,
      mix,
      loudnessBoost: 1.5,
      limiter: 0.96,
      clarityProcessing: true,
      echoRemoved: true,
    };
  } finally {
    if (fs.existsSync(tempPath) && tempPath !== outputPath) fs.rmSync(tempPath, { force: true });
  }
}

module.exports = { processMetallic };
