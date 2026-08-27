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
  if (!mix || !(await hasFfmpeg())) return { applied: false, path: inputPath, reason: 'ffmpeg-unavailable-or-disabled' };

  const tempPath = outputPath.replace(/\.mp3$/i, '.metallic.mp3');
  const delayMs = Math.round(18 + mix * 55);
  const feedback = Math.min(0.2, mix * 0.75).toFixed(3);
  const wet = Math.min(0.45, mix * 1.8).toFixed(3);
  const dry = (1 - Number(wet)).toFixed(3);
  const filter = `asplit=2[a][b];[a]adelay=${delayMs}|${delayMs},aecho=1:0.8:${delayMs}:${feedback}[wet];[b][wet]amix=inputs=2:weights=${dry} ${wet}:normalize=0`;

  try {
    await execFileAsync('ffmpeg', ['-y', '-i', inputPath, '-filter_complex', filter, '-codec:a', 'libmp3lame', '-q:a', '3', tempPath], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
    fs.renameSync(tempPath, outputPath);
    return { applied: true, path: outputPath, mix };
  } finally {
    if (fs.existsSync(tempPath) && tempPath !== outputPath) fs.rmSync(tempPath, { force: true });
  }
}

module.exports = { processMetallic };
