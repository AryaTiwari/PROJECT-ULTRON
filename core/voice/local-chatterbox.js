const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { config } = require('./config');
const { processMetallic } = require('./metallic-postprocess');

function runPython(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.python, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `Local Chatterbox process exited with code ${code}`)));
  });
}

async function synthesize(text, options = {}) {
  const input = String(text || '').trim();
  if (!input) throw new Error('TTS requires text.');
  if (!fs.existsSync(config.referencePath)) throw new Error('Local Chatterbox reference audio is not installed.');
  const outputDir = path.resolve(options.outputDir || config.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const format = String(options.format || config.format).toLowerCase() === 'mp3' ? 'mp3' : 'wav';
  const outputPath = path.resolve(outputDir, options.filename || `ultron-${Date.now()}.${format}`);
  const script = path.resolve(__dirname, 'chatterbox_tts.py');
  const raw = await runPython(['--text', input, '--reference', config.referencePath, '--output', outputPath, '--language', options.language || 'en', '--model', 'ResembleAI/chatterbox-turbo']);
  let result = {};
  try { result = raw ? JSON.parse(raw) : {}; } catch { result = { ok: true, path: outputPath }; }
  const generatedPath = path.resolve(result.path || outputPath);
  let processed = { applied: false, path: generatedPath };
  if (format === 'mp3' && fs.existsSync(generatedPath)) processed = await processMetallic(generatedPath, generatedPath);
  const finalPath = processed.path || generatedPath;
  return { ok: true, provider: 'chatterbox-turbo-local', model: 'ResembleAI/chatterbox-turbo', path: finalPath, bytes: fs.statSync(finalPath).size, metallicApplied: processed.applied, metallicMix: config.metallicMix };
}

module.exports = { synthesize };
