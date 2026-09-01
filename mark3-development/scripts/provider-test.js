const integrations = require('../core/integrations');

const PRIORITY = ['opencode', 'pollinations', 'nvidia', 'zenmux', 'bytez', 'vertex'];

function canonicalCandidates(provider, models) {
  const prefix = `${provider}/`;
  const canonical = models.filter((model) => String(model).toLowerCase().startsWith(prefix));
  const aliases = models.filter((model) => !canonical.includes(model));
  return [...canonical, ...aliases].slice(0, 3);
}

(async () => {
  const results = [];
  try {
    const payload = await integrations.models();
    const ids = integrations.payloadModels(payload).filter(integrations.isDirectProviderModel);
    const groups = new Map(PRIORITY.map((provider) => [provider, []]));
    for (const id of ids) {
      const provider = integrations.providerFromModel(id);
      if (!groups.has(provider)) groups.set(provider, []);
      groups.get(provider).push(id);
    }

    console.log(`OmniRoute catalog: ${ids.length} direct-provider models.`);

    for (const provider of PRIORITY) {
      const candidates = canonicalCandidates(provider, groups.get(provider) || []);
      if (!candidates.length) {
        results.push({ provider, ok: false, reason: 'no catalog models' });
        console.log(`${provider}: SKIP (no catalog models)`);
        continue;
      }

      let passed = null;
      const failures = [];
      for (const model of candidates) {
        try {
          const result = await integrations.chatExact(
            [{ role: 'system', content: 'Reply with exactly: PROVIDER_OK' }, { role: 'user', content: 'Reply with exactly: PROVIDER_OK' }],
            model,
            null,
          );
          const text = result?.choices?.[0]?.message?.content || result?.response || result?.text || '';
          if (String(text).trim()) {
            passed = { model: result?.__ultron?.model || model, actualModel: result?.__ultron?.actualModel || result?.model || model };
            break;
          }
          failures.push(`${model}: empty response`);
        } catch (error) {
          const mismatch = error?.requestedProvider && error?.actualProvider
            ? `provider-mismatch requested=${error.requestedProvider}/${error.requestedModel} actual=${error.actualProvider}/${error.actualModel}`
            : '';
          failures.push(`${model}: ${mismatch || error?.message || String(error)}`);
        }
      }

      if (passed) {
        results.push({ provider, ok: true, model: passed.model, actualModel: passed.actualModel });
        console.log(`${provider}: PASS (model=${passed.model}${passed.actualModel && passed.actualModel !== passed.model ? `, actual=${passed.actualModel}` : ''})`);
      } else {
        results.push({ provider, ok: false, reason: failures.join(' | ') });
        console.log(`${provider}: FAIL`);
        console.log(`  ${failures.join('\n  ')}`);
      }
    }

    const working = results.filter((item) => item.ok);
    console.log(`\nWorking providers: ${working.length}/${results.length}`);
    for (const item of working) console.log(`  ${item.provider} -> ${item.model}`);

    if (!working.length) {
      console.error('No configured provider produced a usable response through OmniRoute.');
      process.exitCode = 1;
      return;
    }

    console.log('Provider health test: PASS.');
  } catch (error) {
    console.error(`Provider health test: FAIL: ${error?.message || String(error)}`);
    process.exitCode = 1;
  }
})();
