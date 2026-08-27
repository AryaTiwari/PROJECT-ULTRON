const fs = require('fs');
const path = require('path');
const { config, available } = require('./config');
const { processMetallic } = require('./metallic-postprocess');

async function synthesize(text, options = {}) {
  const input = String(text || '').trim();
  if (!input) throw new Error('TTS requires text.');
  if (!available()) throw new Error('Fish Audio TTS is not configured. Set FISH_API_KEY.');

  const referenceId = options.referenceId || config.referenceId;
  const model = options.model || config.model;
  const format = options.format || config.format;

  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      model,
    },
    body: JSON.stringify({
      text: input,
      reference_id: referenceId,
      format,
    }),
  });

  if (!response.ok) {
    throw new Error(`Fish Audio TTS HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(config.outputDir, { recursive: true });
  const filename = options.filename || `ultron-${Date.now()}.${format}`;
  const outputPath = path.resolve(config.outputDir, filename);
  fs.writeFileSync(outputPath, audio);

  let processed = { applied: false, path: outputPath, reason: 'disabled' };
  if (format.toLowerCase() === 'mp3') {
    processed = await processMetallic(outputPath, outputPath);
  }

  return {
    ok: true,
    provider: 'fish',
    model,
    referenceId,
    voiceStyle: config.voiceStyle,
    metallicApplied: processed.applied,
    metallicMix: config.metallicMix,
    path: processed.path || outputPath,
    bytes: fs.statSync(processed.path || outputPath).size,
  };
}

module.exports = { synthesize };
