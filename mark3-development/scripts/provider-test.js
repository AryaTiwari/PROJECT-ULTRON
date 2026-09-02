const integrations = require('../core/integrations');

(async () => {
  try {
    const health = await integrations.health();
    const providers = await integrations.providerHealthSnapshot();
    console.log(`OmniRoute endpoint: ${health.endpoint || process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128/v1'}`);
    console.log(`Gateway catalog: ${health.gatewayModelCount || 0}; managed fallback models: ${health.eligibleFallbackModelCount || 0}.`);
    console.log(`Routing mode: ${health.mode || 'unknown'}.`);
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
    if (!text) throw new Error('OmniRoute inference returned no text.');
    const model = String(result?.model || '').trim();
    const nativeAlias = integrations.isRoutingAlias(model) && result?.provider === 'omniroute-auto';
    if (!nativeAlias && !integrations.isDirectProviderModel(model)) {
      throw new Error(`Router returned an ineligible model: ${model || '(missing)'}`);
    }

    console.log(`Inference: PASS (mode=${result.routingMode || 'omniroute'}, provider=${result.provider || integrations.providerFromModel(model)}, model=${model}).`);
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
