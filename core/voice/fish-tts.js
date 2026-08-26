const fs = require('fs');
const path = require('path');
const { config, available } = require('./config');

async function synthesize(text, options = {}) {
  const input = String(text || '').trim();
  if (!input) throw new Error('TTS requires text.');
  if (!available()) throw new Error('Fish Audio TTS is not configured. Set FISH_API_KEY.');

  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      model: options.model || config.model,
    },
    body: JSON.stringify({
      text: input,
      reference_id: options.referenceId || config.referenceId,
      format: options.format || config.format,
    }),
  });

  if (!response.ok) {
    throw new Error(`Fish Audio TTS HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(config.outputDir, { recursive: true });
  const filename = options.filename || `ultron-${Date.now()}.${config.format}`;
  const outputPath = path.resolve(config.outputDir, filename);
  fs.writeFileSync(outputPath, audio);
  return { ok: true, provider: 'fish', model: options.model || config.model, referenceId: options.referenceId || config.referenceId, path: outputPath, bytes: audio.length };
}

module.exports = { synthesize };
