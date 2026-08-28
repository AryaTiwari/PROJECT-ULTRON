const fs = require('fs');
const path = require('path');
const voice = require('./index');
const { config } = require('./config');
const { getApiKey, ensureReferenceWav } = require('./nvidia-tts');

async function main() {
  const key = await getApiKey();
  const reference = await ensureReferenceWav();
  const result = await voice.synthesize('ULTRON systems online. Voice synthesis test complete.', { filename: `ultron-voice-test-${Date.now()}.wav` });
  console.log(JSON.stringify({
    ok: true,
    provider: config.provider,
    model: config.model,
    reference: path.resolve(reference),
    output: path.resolve(result.path),
    bytes: result.bytes,
    apiKeyConfigured: Boolean(key),
    metallicApplied: result.metallicApplied,
    metallicMix: result.metallicMix,
  }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
