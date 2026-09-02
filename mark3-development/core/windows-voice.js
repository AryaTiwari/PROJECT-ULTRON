const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('./config');

const execFileAsync = promisify(execFile);

function cleanSpeechText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' link ')
    .replace(/[#*_`>\[\]{}|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

function psQuote(value) {
  return String(value || '').replace(/'/g, "''");
}

async function synthesize(text, options = {}) {
  const input = cleanSpeechText(text);
  if (!input) throw new Error('Windows voice received empty speech text.');
  if (process.platform !== 'win32') throw new Error('Windows SAPI fallback is available only on Windows.');

  const outputDir = path.resolve(options.outputDir || config.voiceOutputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const requestedName = String(options.filename || '').trim();
  const baseName = requestedName ? path.basename(requestedName, path.extname(requestedName)) : `ultron-${Date.now()}`;
  const outputPath = path.join(outputDir, `${baseName}.wav`);
  const rate = Math.max(-10, Math.min(10, Number(options.rate ?? -1)));
  const volume = Math.max(0, Math.min(100, Number(options.volume ?? 100)));
  const selectedVoice = String(options.voice || process.env.ULTRON_WINDOWS_VOICE || '').trim();

  const selectVoice = selectedVoice
    ? `try { $speaker.SelectVoice('${psQuote(selectedVoice)}') } catch { }`
    : '';
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    selectVoice,
    `$speaker.Rate = ${Math.round(rate)}`,
    `$speaker.Volume = ${Math.round(volume)}`,
    `$speaker.SetOutputToWaveFile('${psQuote(outputPath)}')`,
    `try { $speaker.Speak('${psQuote(input)}') } finally { $speaker.Dispose() }`,
  ].filter(Boolean).join('; ');

  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 120000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size <= 44) {
    throw new Error('Windows SAPI did not produce a valid audio file.');
  }

  return {
    ok: true,
    provider: 'windows-sapi',
    model: selectedVoice || 'windows-default-voice',
    path: outputPath,
    bytes: fs.statSync(outputPath).size,
    fallback: true,
  };
}

module.exports = { synthesize, cleanSpeechText };
