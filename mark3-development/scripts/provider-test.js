const integrations = require('../core/integrations');

(async () => {
  try {
    const health = await integrations.health();
    console.log(`Routing mode: ${health.mode || 'unknown'}.`);
    console.log(`Primary transport: ${health.primary || 'unknown'}.`);

    const direct = health.direct || {};
    console.log(`Direct strategy: ${direct.strategy || 'not reported'}.`);
    for (const [provider, row] of Object.entries(direct.providers || {})) {
      const keyCount = Number(row?.keyCount || 0);
      const keyStates = (row?.keys || []).map((key) => `${key.slot}:${key.status}`).join(', ') || 'none';
      console.log(`${provider}: configured=${Boolean(row?.configured)}, keys=${keyCount}, keyStates=[${keyStates}], models=${(row?.models || []).length}.`);
    }

    const omni = health.omniroute || {};
    console.log(`OmniRoute fallback: ${omni.ok ? 'online' : 'standby/offline'}${omni.endpoint ? ` at ${omni.endpoint}` : ''}; gateway models=${omni.gatewayModelCount || 0}.`);

    if (!health.ok) throw new Error(health.catalogError || omni.error || 'No direct or OmniRoute model transport is available.');

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
    if (!text) throw new Error('Model transport inference returned no text.');
    const model = String(result?.model || '').trim();
    const nativeAlias = integrations.isRoutingAlias(model) && result?.provider === 'omniroute-auto';
    if (!nativeAlias && !integrations.isDirectProviderModel(model)) {
      throw new Error(`Router returned an ineligible model: ${model || '(missing)'}`);
    }

    console.log(`Inference: PASS (mode=${result.routingMode || result.transport || 'unknown'}, provider=${result.provider || integrations.providerFromModel(model)}, model=${model}, credentialSlot=${result.credentialSlot || 'not-exposed'}).`);
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
