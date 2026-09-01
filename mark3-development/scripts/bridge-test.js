const config = require('../core/config');
const integrations = require('../core/integrations');

(async () => {
  try {
    console.log(`Devin bridge enabled: ${config.agenticBridgeEnabled}`);
    const candidates = await integrations.bridgeModels(12);
    console.log(`Agentic bridge models advertised by OmniRoute: ${candidates.length}.`);
    console.log(`Bridge candidates: ${candidates.join(', ')}`);
    if (!config.agenticBridgeEnabled) throw new Error('Mark 3 Devin bridge is disabled by configuration.');
    const preferred = config.agenticBridgeModel;
    const model = candidates.includes(preferred) ? preferred : candidates[0];
    if (!model) throw new Error('No bridge model is advertised by OmniRoute.');
    console.log(`Bridge smoke model: ${model}`);
    const result = await integrations.chat([
      { role: 'system', content: 'You are running as a bridge health probe. Do not use tools. Reply with exactly BRIDGE_OK.' },
      { role: 'user', content: 'Reply with exactly BRIDGE_OK.' },
    ], model, null);
    const content = result?.choices?.[0]?.message?.content || result?.response || result?.text || '';
    if (String(content).trim() !== 'BRIDGE_OK') throw new Error(`Bridge returned unexpected content: ${String(content).slice(0, 300)}`);
    console.log(`Devin bridge: PASS (model=${result?.model || model}).`);
  } catch (error) {
    console.error(`Devin bridge: FAIL: ${error?.message || String(error)}`);
    if (error?.model) console.error(`Failed bridge model: ${error.model}`);
    process.exitCode = 1;
  }
})();
