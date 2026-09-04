// Keep the health probe deterministic while allowing NVIDIA free endpoints to cold-start
// or return an asynchronous 202 response. These overrides affect only this test process;
// real Forge missions retain their normal production timeout and fallback model pool.
process.env.ULTRON_M3_FORGE_MODEL_TIMEOUT_MS = '60000';
process.env.ULTRON_M3_FORGE_CODE_BUILD_MODELS = 'poolside/laguna-xs-2.1';

const governor = require('../core/forge/model-governor');

(async () => {
  const status = governor.status();
  if (!status.configuredKeySlots.length) {
    throw new Error('No NVIDIA key is configured. Add NVIDIA_API_KEY to ../.env; do not paste the key into chat or commit it.');
  }
  console.log(`Probing NVIDIA Forge coding route: model=poolside/laguna-xs-2.1; keySlots=${status.configuredKeySlots.join(',')}; timeout=60s; asyncPolling=${status.asyncPolling}.`);
  const result = await governor.nvidiaChat({
    role: 'code_build',
    temperature: 0,
    maxTokens: 64,
    messages: [
      { role: 'system', content: 'You are a coding API health probe. Follow the user instruction exactly.' },
      { role: 'user', content: 'Reply with exactly: FORGE_NVIDIA_OK' },
    ],
  });
  if (!/FORGE_NVIDIA_OK/i.test(result.text)) throw new Error(`NVIDIA responded but failed the deterministic probe: ${result.text.slice(0, 200)}`);
  console.log(`ULTRON Forge live NVIDIA test passed: model=${result.model}; keySlot=${result.keySlot}; tokens=${result.usage.totalTokens}.`);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
