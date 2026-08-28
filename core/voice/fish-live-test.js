const voice = require('./index');
const { config } = require('./config');
const { cloneVoice, getApiKey, MODEL, readState } = require('./fish-tts-free');

async function main() {
  const key = await getApiKey();
  if (!key) throw new Error('FISH_API_KEY is not configured. Add your free Fish Audio developer key to .env or ULTRON credentials.');
  let state = readState();
  if (!state.fishVoiceId) {
    const clone = await cloneVoice({ title: 'ULTRON Voice' });
    console.log(JSON.stringify({ step: 'clone', ...clone }, null, 2));
    state = readState();
  }
  const result = await voice.synthesize('ULTRON systems online. Voice synthesis test complete.', { provider: 'fish-audio-s2.1-pro-free', format: 'mp3', latency: 'balanced' });
  console.log(JSON.stringify({ ok: true, provider: config.provider, model: MODEL, voiceId: state.fishVoiceId, output: result.path, bytes: result.bytes, reference: config.referencePath, metallicApplied: result.metallicApplied }, null, 2));
}
main().catch(error => { console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2)); process.exitCode = 1; });
