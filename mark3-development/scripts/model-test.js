const integrations = require('../core/integrations');
const intelligence = require('../core/model-intelligence');

(async () => {
  try {
    const catalog = await integrations.models();
    const ids = integrations.normalizeModelIds(catalog);
    const usable = ids.filter(integrations.isConcreteModelId);
    console.log(`OmniRoute /v1/models: PASS (${ids.length} catalog entries returned).`);
    console.log(`Concrete normal-chat models available: ${usable.length}.`);
    if (!usable.length) throw new Error('No usable normal-chat OmniRoute models are available.');

    const live = await intelligence.catalog();
    console.log(`Assistant-eligible models after policy filtering: ${live.count}.`);
    console.log(`Candidate pool: ${live.models.slice(0, 8).join(', ')}`);

    const result = await integrations.chat([{ role: 'user', content: 'Reply with exactly: OMNIROUTE_OK' }], null, null);
    const content = result?.choices?.[0]?.message?.content || result?.response || result?.text || '';
    const used = String(result?.model || '').trim();
    if (!String(content).trim()) throw new Error('OmniRoute chat returned no usable text.');
    if (!integrations.isConcreteModelId(used)) throw new Error(`OmniRoute returned non-concrete model ID: ${used || '(missing)'}`);
    if (live.models.length && !live.models.includes(used)) throw new Error(`Runtime selected a model outside the Mark 3 assistant catalog: ${used}`);
    console.log(`OmniRoute /v1/chat/completions: PASS (model=${used}).`);
    console.log(`Live response: ${String(content).trim().slice(0, 120)}`);
    console.log('OmniRoute end-to-end test: PASS.');
  } catch (error) {
    console.error(`OmniRoute end-to-end test: FAIL: ${error.message}`);
    if (error?.model) console.error(`Failed model: ${error.model}`);
    process.exitCode = 1;
  }
})();
