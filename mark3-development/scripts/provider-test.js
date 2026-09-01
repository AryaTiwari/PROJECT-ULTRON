const integrations = require('../core/integrations');

const PRIORITY = integrations.PROVIDER_PRIORITY || [
  'gemini-cli', 'kiro', 'qoder', 'qwen', 'github-copilot',
  'opencode', 'pollinations', 'nvidia', 'zenmux', 'bytez', 'vertex',
];
const MAX_CANDIDATES_PER_PROVIDER = Math.max(6, Number(process.env.ULTRON_M3_PROVIDER_PROBE_CANDIDATES || 18));

function canonicalPrefixes(provider) {
  const prefixes = {
    'gemini-cli': ['gemini-cli/'],
    kiro: ['kr/', 'kiro/'],
    qoder: ['if/', 'qoder/'],
    qwen: ['qw/', 'qwen/'],
    'github-copilot': ['gh/', 'github-copilot/'],
  };
  return prefixes[provider] || [`${provider}/`];
}

function canonicalCandidates(provider, models) {
  const prefixes = canonicalPrefixes(provider).map((x) => x.toLowerCase());
  const canonical = models.filter((model) => prefixes.some((prefix) => String(model).toLowerCase().startsWith(prefix)));
  const aliases = models.filter((model) => !canonical.includes(model));
  return [...canonical, ...aliases].slice(0, MAX_CANDIDATES_PER_PROVIDER);
}

function classifyFailure(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || error || 'Unknown error');
  const lower = message.toLowerCase();
  if (status === 402 || /payment_required|requires an opencode api key|billing_error|requires .* api key|paid model/.test(lower)) return 'PAID_MODEL';
  if ([401, 403].includes(status) || /missing api key|invalid_api_key|no active credentials|authentication failed|provider authentication|you have no permission to access this resource/.test(lower)) return 'CREDENTIALS_OR_ACCESS';
  if (status === 429 || /quota|rate limit|exhausted/.test(lower)) return 'QUOTA_OR_RATE_LIMIT';
  if (status === 404 || /model does not exist|model_not_found|not available in the active live catalog|invalid model or alias/.test(lower)) return 'MODEL_UNAVAILABLE';
  if (status >= 500 || /endpoint is unavailable|upstream request failed|timed out|fetch failed|econnrefused|connect/.test(lower)) return 'UPSTREAM_OR_NETWORK';
  return 'UNKNOWN';
}

function diagnosisFor(provider, failures) {
  const classes = failures.map((item) => item.kind);
  if (classes.includes('PAID_MODEL') && !classes.some((kind) => ['CREDENTIALS_OR_ACCESS', 'QUOTA_OR_RATE_LIMIT', 'MODEL_UNAVAILABLE', 'UPSTREAM_OR_NETWORK', 'UNKNOWN'].includes(kind))) {
    return 'All tested models are paid-only; skipped without selecting any paid model.';
  }
  if (classes.includes('CREDENTIALS_OR_ACCESS')) return `${provider}: authentication or account access is required for the currently probed candidates.`;
  if (classes.includes('QUOTA_OR_RATE_LIMIT')) return `${provider}: configured, but currently quota/rate-limit constrained.`;
  if (classes.includes('MODEL_UNAVAILABLE')) return `${provider}: some catalog entries are stale/unavailable upstream; those candidates are skipped.`;
  if (classes.includes('UPSTREAM_OR_NETWORK')) return `${provider}: provider/upstream endpoint is temporarily unavailable.`;
  return `${provider}: no usable model found in the tested candidate set.`;
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
    console.log(`Free/OAuth-first provider order: ${PRIORITY.join(' -> ')}`);
    console.log(`Provider probe depth: ${MAX_CANDIDATES_PER_PROVIDER} candidates/provider (paid models are skipped).`);

    for (const provider of PRIORITY) {
      const candidates = canonicalCandidates(provider, groups.get(provider) || []);
      if (!candidates.length) {
        results.push({ provider, ok: false, reason: 'no catalog models', diagnosis: 'No models published for this provider.' });
        console.log(`${provider}: SKIP (no catalog models)`);
        continue;
      }

      let passed = null;
      const failures = [];
      let paidSkipped = 0;
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
          const kind = classifyFailure(error);
          if (kind === 'PAID_MODEL') paidSkipped += 1;
          const mismatch = error?.requestedProvider && error?.actualProvider
            ? `provider-mismatch requested=${error.requestedProvider}/${error.requestedModel} actual=${error.actualProvider}/${error.actualModel}`
            : '';
          failures.push({ model, kind, message: mismatch || error?.message || String(error) });
        }
      }

      if (passed) {
        results.push({ provider, ok: true, model: passed.model, actualModel: passed.actualModel, paidSkipped });
        console.log(`${provider}: PASS (model=${passed.model}${passed.actualModel && passed.actualModel !== passed.model ? `, actual=${passed.actualModel}` : ''}${paidSkipped ? `, paidSkipped=${paidSkipped}` : ''})`);
      } else {
        const diagnosis = diagnosisFor(provider, failures);
        results.push({ provider, ok: false, reason: failures.map((failure) => `${failure.model}: ${failure.message}`).join(' | '), diagnosis, paidSkipped });
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