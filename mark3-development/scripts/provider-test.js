const integrations = require('../core/integrations');

(async () => {
  try {
    const health = await integrations.health();
    console.log(`OmniRoute endpoint: ${health.endpoint || process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128/v1'}`);
    console.log(`Catalog models: ${health.modelCount || 0}; Mark 3 usable: ${health.usableModelCount || 0}.`);
    if (!health.ok) throw new Error(health.error || health.catalogError || 'OmniRoute health check failed.');

    const catalog = await integrations.models();
    const ids = integrations.payloadModels(catalog);
    if (!ids.length) throw new Error('No Mark 3-eligible OmniRoute models are available.');

    // Deliberately perform ONE routed inference. The old provider test probed many
    // models per provider and could create unnecessary rate-limit pressure.
    const result = await integrations.chat(
      [
        { role: 'system', content: 'Reply with exactly: PROVIDER_OK' },
        { role: 'user', content: 'Reply with exactly: PROVIDER_OK' },
      ],
      'auto',
      null,
      { taskType: 'simple_qa' },
    );
    const text = String(result?.content || result?.response || result?.text || '').trim();
    if (!text) throw new Error('OmniRoute routed inference returned no text.');
    if (!integrations.isDirectProviderModel(result?.model)) throw new Error(`Router returned an ineligible model: ${result?.model || '(missing)'}`);

    console.log(`Routed inference: PASS (provider=${result.provider || integrations.providerFromModel(result.model)}, model=${result.model}).`);
    console.log(`Response: ${text.slice(0, 120)}`);
    console.log('Provider health test: PASS.');
  } catch (error) {
    console.error(`Provider health test: FAIL: ${error.message}`);
    if (Array.isArray(error?.failures)) {
      for (const failure of error.failures) console.error(`  ${failure.model} [${failure.kind}]: ${failure.message}`);
    }
    process.exitCode = 1;
  }
})();
