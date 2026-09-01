const integrations = require('../core/integrations');
const intelligence = require('../core/model-intelligence');

(async () => {
  try {
    const catalog = await integrations.models();
    const ids = integrations.payloadModels(catalog);
    const usable = ids.filter(integrations.isDirectProviderModel);
    console.log(`OmniRoute /v1/models: PASS (${ids.length} catalog entries returned).`);
    console.log(`Direct provider models available: ${usable.length}.`);
    if (!usable.length) throw new Error('No usable direct-provider OmniRoute models are available.');

    const live = await intelligence.catalog();
    console.log(`Mark 3 eligible models after policy filtering: ${live.count}.`);
    console.log(`Devin/DVA excluded: ${live.devinExcludedCount || 0}.`);
    if (live.providerCounts) console.log(`Provider counts: ${Object.entries(live.providerCounts).map(([provider, count]) => `${provider}=${count}`).join(', ')}`);
    console.log('Probe order: opencode -> pollinations -> nvidia -> zenmux -> bytez -> vertex');
    console.log(`Candidate pool: ${live.models.slice(0, 12).join(', ')}`);

    const result = await integrations.chat([
      { role: 'system', content: 'Reply with exactly: OMNIROUTE_OK' },
      { role: 'user', content: 'Reply with exactly: OMNIROUTE_OK' },
    ], null, null);
    const content = result?.choices?.[0]?.message?.content || result?.response || result?.text || '';
    const used = String(result?.model || result?.__ultron?.model || '').trim();
    const provider = String(result?.__ultron?.provider || integrations.providerFromModel(used) || '').trim();
    if (!String(content).trim()) throw new Error('OmniRoute chat returned no usable text.');
    if (!integrations.isDirectProviderModel(used)) throw new Error(`OmniRoute returned an ineligible model ID: ${used || '(missing)'}`);
    if (live.models.length && !live.models.includes(used)) throw new Error(`Runtime selected a model outside the Mark 3 eligible catalog: ${used}`);
    console.log(`OmniRoute /v1/chat/completions: PASS (provider=${provider}, model=${used}).`);
    console.log(`Live response: ${String(content).trim().slice(0, 120)}`);
    console.log(`Provider probe health: ${JSON.stringify(integrations.providerHealthSnapshot())}`);
    console.log('OmniRoute provider-only end-to-end test: PASS.');
  } catch (error) {
    console.error(`OmniRoute end-to-end test: FAIL: ${error.message}`);
    if (error?.model) console.error(`Failed model: ${error.model}`);
    if (Array.isArray(error?.failures)) console.error(`Provider failures: ${JSON.stringify(error.failures)}`);
    process.exitCode = 1;
  }
})();
