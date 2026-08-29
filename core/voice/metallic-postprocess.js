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
  const mix = Math.max(0, Math.min(0.35, Number(config.metallicMix) || 0));
  if (!mix || !(await hasFfmpeg())) {
    return { applied: false, path: inputPath, reason: 'ffmpeg-unavailable-or-disabled' };
  }

  const tempPath = outputPath.replace(/\.mp3$/i, '.metallic.mp3');
  const presence = (0.9 + mix * 2.5).toFixed(2);
  const air = (0.4 + mix * 2.0).toFixed(2);

  // Keep a single voice signal. Metallic character comes from EQ/compression,
  // not from a delayed/echoed duplicate of the voice.
  const filter = [
    'highpass=f=70',
    `equalizer=f=2400:t=q:w=1:g=${presence}`,
    `equalizer=f=7200:t=q:w=1:g=${air}`,
    'acompressor=threshold=-18dB:ratio=2.5:attack=5:release=90:makeup=2',
    'volume=4.0',
    'alimiter=limit=0.97',
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
      loudnessBoost: 4.0,
      limiter: 0.97,
      clarityProcessing: true,
      echoRemoved: true,
    };
  } finally {
    if (fs.existsSync(tempPath) && tempPath !== outputPath) fs.rmSync(tempPath, { force: true });
  }
}

module.exports = { processMetallic };
