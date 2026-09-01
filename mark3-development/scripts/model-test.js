const integrations = require('../core/integrations');
(async () => {
  try {
    const catalog = await integrations.models();
    const ids = integrations.normalizeModelIds(catalog);
    const usable = ids.filter(integrations.isConcreteModelId);
    console.log(`OmniRoute /v1/models: PASS (${ids.length} catalog entries returned).`);
    console.log(`Concrete non-agentic models available: ${usable.length}.`);
    if (!usable.length) throw new Error('No usable concrete non-agentic OmniRoute models are available.');
    const candidates = await integrations.concreteModels(Number(process.env.ULTRON_M3_MODEL_CANDIDATES || 8));
    console.log(`Candidate pool: ${candidates.join(', ')}`);
    const result = await integrations.chat([{ role: 'user', content: 'Reply with exactly: OMNIROUTE_OK' }], null, null);
    const content = result?.choices?.[0]?.message?.content || result?.response || result?.text || '';
    const used = String(result?.model || '').trim();
    if (!String(content).trim()) throw new Error('OmniRoute chat returned no usable text.');
    if (!integrations.isConcreteModelId(used)) throw new Error(`OmniRoute returned non-concrete model ID: ${used || '(missing)'}`);
    console.log(`OmniRoute /v1/chat/completions: PASS (model=${used}).`);
    console.log(`Live response: ${String(content).trim().slice(0, 120)}`);
    console.log('OmniRoute end-to-end test: PASS.');
  } catch (error) {
    console.error(`OmniRoute end-to-end test: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
})();
