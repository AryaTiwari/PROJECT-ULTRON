const integrations = require('../core/integrations');
const intelligence = require('../core/model-intelligence');

(async () => {
  try {
    const catalog = await integrations.models();
    const ids = integrations.payloadModels(catalog);
    if (!ids.length) throw new Error('No usable Mark 3 OmniRoute models are available.');
    if (ids.some((id) => integrations.isOpenCodeModel(id) || integrations.isNvidiaModel(id) || integrations.isDevinModel(id))) {
      throw new Error('Blocked inference models leaked into the Mark 3 catalog.');
    }

    const live = await intelligence.catalog();
    console.log(`Mark 3 eligible models: ${live.count}.`);
    if (live.providerCounts) console.log(`Providers: ${Object.entries(live.providerCounts).map(([provider, count]) => `${provider}=${count}`).join(', ')}`);

    const result = await integrations.chat(
      [
        { role: 'system', content: 'Reply with exactly: OMNIROUTE_OK' },
        { role: 'user', content: 'Reply with exactly: OMNIROUTE_OK' },
      ],
      'auto',
      null,
      { taskType: 'simple_qa' },
    );
    const content = String(result?.content || result?.response || result?.text || '').trim();
    const used = String(result?.model || '').trim();
    const provider = String(result?.provider || integrations.providerFromModel(used) || '').trim();
    if (!content) throw new Error('OmniRoute chat returned no usable text.');
    if (!integrations.isDirectProviderModel(used)) throw new Error(`OmniRoute returned an ineligible model ID: ${used || '(missing)'}`);
    if (integrations.isOpenCodeModel(used) || integrations.isNvidiaModel(used) || integrations.isDevinModel(used)) throw new Error(`Blocked model selected at runtime: ${used}`);

    console.log(`OmniRoute inference: PASS (provider=${provider}, model=${used}).`);
    console.log(`Live response: ${content.slice(0, 120)}`);
    console.log('Mark 3 model policy: PASS.');
  } catch (error) {
    console.error(`OmniRoute end-to-end test: FAIL: ${error.message}`);
    if (Array.isArray(error?.failures)) {
      for (const failure of error.failures) console.error(`  ${failure.model} [${failure.kind}]: ${failure.message}`);
    }
    process.exitCode = 1;
  }
})();
