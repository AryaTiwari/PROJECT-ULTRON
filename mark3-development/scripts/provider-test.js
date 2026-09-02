const integrations = require('../core/integrations');

(async () => {
  try {
    const health = await integrations.health();
    const providers = await integrations.providerHealthSnapshot();
    console.log(`OmniRoute endpoint: ${health.endpoint || process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128/v1'}`);
    console.log(`Gateway catalog: ${health.gatewayModelCount || 0}; managed chat models: ${health.eligibleChatModelCount || 0}.`);
    for (const row of providers.providers || []) {
      if (!row.enabled && row.tier === 'experimental') continue;
      console.log(`${row.provider}: tier=${row.tier}, enabled=${row.enabled}, credential=${row.credentialDetected}, models=${row.catalogModels}, healthy=${row.healthyModel || 'none'}${row.lastFailureKind ? `, lastFailure=${row.lastFailureKind}` : ''}`);
    }
    if (!health.ok) throw new Error(health.error || health.catalogError || 'OmniRoute health check failed.');

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
    if (!text) throw new Error('Managed OmniRoute inference returned no text.');
    if (!integrations.isDirectProviderModel(result?.model)) throw new Error(`Router returned an ineligible model: ${result?.model || '(missing)'}`);

    console.log(`Managed inference: PASS (provider=${result.provider || integrations.providerFromModel(result.model)}, model=${result.model}).`);
    console.log(`Response: ${text.slice(0, 120)}`);
    console.log('Provider health test: PASS.');
  } catch (error) {
    console.error(`Provider health test: FAIL: ${error.message}`);
    if (Array.isArray(error?.failures)) {
      for (const failure of error.failures) console.error(`  ${failure.provider}/${failure.model} [${failure.kind}]: ${failure.message}`);
    }
    process.exitCode = 1;
  }
})();
