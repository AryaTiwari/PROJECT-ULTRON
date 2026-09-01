const integrations = require('../core/integrations');

const PRIORITY = ['opencode', 'pollinations', 'nvidia', 'zenmux', 'bytez', 'vertex'];

function canonicalCandidates(provider, models) {
  const prefix = `${provider}/`;
  const canonical = models.filter((model) => String(model).toLowerCase().startsWith(prefix));
  const aliases = models.filter((model) => !canonical.includes(model));
  return [...canonical, ...aliases].slice(0, 3);
}

function classifyFailure(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || error || 'Unknown error');
  const lower = message.toLowerCase();
  if (/missing api key|invalid_api_key|no active credentials|authentication failed|provider authentication|you have no permission to access this resource|requires an opencode api key|requires an api key|billing_error|payment_required/.test(lower) || status === 402) return 'CREDENTIALS_OR_ACCESS';
  if (status === 429 || /quota|rate limit|exhausted/.test(lower)) return 'QUOTA_OR_RATE_LIMIT';
  if (status === 404 || /model does not exist|model_not_found|not available in the active live catalog/.test(lower)) return 'MODEL_UNAVAILABLE';
  if (status >= 500 || /endpoint is unavailable|upstream request failed|timed out|fetch failed|econnrefused|connect/.test(lower)) return 'UPSTREAM_OR_NETWORK';
  return 'UNKNOWN';
}

function diagnosisFor(provider, failures) {
  const classes = failures.map((item) => item.kind);
  if (classes.includes('CREDENTIALS_OR_ACCESS')) {
    if (provider === 'opencode') return 'OpenCode is listed but OmniRoute needs a valid OpenCode API key for the tested paid models.';
    if (provider === 'pollinations') return 'Pollinations is reachable but the tested routes require a valid Pollinations API key.';
    if (provider === 'nvidia') return 'NVIDIA is listed but the tested routes require a valid NVIDIA credential.';
    if (provider === 'zenmux') return 'ZenMux is reachable but the current account/key has no permission for the tested models.';
    if (provider === 'bytez') return 'Bytez is reachable but its current authentication/connection is invalid or expired.';
    if (provider === 'vertex') return 'Vertex is listed but no active usable Vertex credential is available.';
  }
  if (classes.includes('QUOTA_OR_RATE_LIMIT')) return 'Provider is configured but currently quota/rate-limit constrained.';
  if (classes.includes('MODEL_UNAVAILABLE')) return 'OmniRoute contains catalog entries that the provider currently does not expose; stale candidates must be skipped.';
  if (classes.includes('UPSTREAM_OR_NETWORK')) return 'OmniRoute or the provider upstream endpoint is temporarily unavailable.';
  return 'Provider failed without a recognized diagnostic classification.';
}

(async () => {
  const results = [];
  try {
    console.log(`OmniRoute endpoint: ${process.env.OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128/v1'}`);
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
        results.push({ provider, ok: false, reason: 'no catalog models', diagnosis: 'No models published for this provider.' });
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
          failures.push({ model, kind: 'EMPTY_RESPONSE', message: 'empty response' });
        } catch (error) {
          const mismatch = error?.requestedProvider && error?.actualProvider
            ? `provider-mismatch requested=${error.requestedProvider}/${error.requestedModel} actual=${error.actualProvider}/${error.actualModel}`
            : '';
          failures.push({ model, kind: classifyFailure(error), message: mismatch || error?.message || String(error) });
        }
      }

      if (passed) {
        results.push({ provider, ok: true, model: passed.model, actualModel: passed.actualModel });
        console.log(`${provider}: PASS (model=${passed.model}${passed.actualModel && passed.actualModel !== passed.model ? `, actual=${passed.actualModel}` : ''})`);
      } else {
        const diagnosis = diagnosisFor(provider, failures);
        results.push({ provider, ok: false, reason: failures.map((failure) => `${failure.model}: ${failure.message}`).join(' | '), diagnosis });
        console.log(`${provider}: FAIL`);
        console.log(`  ${diagnosis}`);
        console.log(`  ${failures.map((failure) => `${failure.model}: [${failure.kind}] ${failure.message}`).join('\n  ')}`);
      }
    }

    const working = results.filter((item) => item.ok);
    console.log(`\nWorking providers: ${working.length}/${results.length}`);
    for (const item of working) console.log(`  ${item.provider} -> ${item.model}`);

    if (!working.length) {
      console.error('No configured provider produced a usable response through OmniRoute.');
      console.error('Provider remediation is required before Mark 3 can pass end-to-end inference.');
      process.exitCode = 1;
      return;
    }

    console.log('Provider health test: PASS.');
  } catch (error) {
    const kind = classifyFailure(error);
    console.error(`Provider health test: FAIL [${kind}]`);
    console.error(`  ${error?.message || String(error)}`);
    console.error('  Ensure OmniRoute is running before provider diagnostics.');
    process.exitCode = 1;
  }
})();
