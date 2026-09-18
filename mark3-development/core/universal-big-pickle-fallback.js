'use strict';

// Narrow reasoning fallback for the universal deterministic spreadsheet engine.
// It never owns source routing, schema inference, tab selection, hydration or writes.
// It may only resolve a bounded ambiguity from evidence/candidate keys supplied by
// the deterministic engine. No personal-provider fallback is permitted.

const omniRoute = require('../../core/omniroute');
const control = require('./command-control-plane');
const ranker = require('./universal-authority-ranker');

const state = {
  calls: 0,
  successes: 0,
  failures: 0,
  abstains: 0,
  employerCalls: 0,
  candidateCalls: 0,
  actualModels: new Set(),
  lastError: null,
};

function enabled() {
  const raw = String(process.env.ULTRON_M3_UNIVERSAL_BIG_PICKLE_FALLBACK ?? '1').trim();
  return !/^(0|false|no|off)$/i.test(raw);
}

function openCodeDisabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_DISABLE_OPENCODE || ''));
}

function resetRun() {
  state.calls = 0;
  state.successes = 0;
  state.failures = 0;
  state.abstains = 0;
  state.employerCalls = 0;
  state.candidateCalls = 0;
  state.actualModels = new Set();
  state.lastError = null;
}

function snapshot() {
  return {
    enabled: enabled(),
    calls: state.calls,
    successes: state.successes,
    failures: state.failures,
    abstains: state.abstains,
    employerCalls: state.employerCalls,
    candidateCalls: state.candidateCalls,
    actualModels: [...state.actualModels],
    lastError: state.lastError,
    personalApiFallbacks: 0,
  };
}

async function selectRoute() {
  const preferred = ['oc/big-pickle', 'opencode/big-pickle', 'opencode-zen/big-pickle', 'big-pickle'];
  try {
    const catalog = await omniRoute.listModels({ force: false });
    for (const id of preferred) if ((catalog || []).includes(id)) return id;
  } catch {}
  return 'oc/big-pickle';
}

function parseJson(value) {
  const raw = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const direct = (() => { try { return JSON.parse(raw); } catch { return null; } })();
  if (direct && typeof direct === 'object') return direct;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return null;
}

function resultText(result) {
  return String(result?.content || result?.text || result?.response || '').trim();
}

async function chat(messages, purpose) {
  if (!enabled()) return null;
  if (openCodeDisabled()) {
    state.failures++;
    state.lastError = 'BIG_PICKLE_OPENCODE_DISABLED';
    return null;
  }

  // The spreadsheet domain is exclusive. Any bounded model fallback must run
  // inside its explicit internal-inference scope rather than weakening the route
  // invariant or escaping to a generic provider path. Big Pickle is optional:
  // routing/model-control failures therefore fail closed as an abstention instead
  // of escaping and turning a successful deterministic row into an INTERNAL error.
  try {
    return await control.runInternalInference('spreadsheet-enrichment', async () => {
      try {
        control.assertAllowed('general-model', { messages });
        const model = await selectRoute();
        state.calls++;
        if (purpose === 'employer') state.employerCalls++;
        if (purpose === 'candidate') state.candidateCalls++;
        const result = await omniRoute.chat({
          messages,
          model,
          taskType: 'research',
          timeoutMs: Math.max(15000, Number(process.env.ULTRON_M3_UNIVERSAL_BIG_PICKLE_TIMEOUT_MS || 55000)),
          maxAttempts: 1,
          skipModelValidation: true,
        });
        const actual = String(result?.raw?.model || result?.model || model).trim() || model;
        state.actualModels.add(actual);
        state.successes++;
        return { result, model: actual };
      } catch (error) {
        state.failures++;
        state.lastError = String(error?.code || error?.message || error || '').slice(0, 500);
        return null;
      }
    });
  } catch (error) {
    state.failures++;
    state.lastError = String(error?.code || error?.message || error || '').slice(0, 500);
    return null;
  }
}

function evidenceText(raw) {
  let serialized = '';
  try { serialized = typeof raw === 'string' ? raw : JSON.stringify(raw); } catch { serialized = String(raw || ''); }
  return serialized.replace(/\s+/g, ' ').slice(0, 12000);
}

function evidenceContainsCompany(company, evidence) {
  const expected = ranker.companyKey(company);
  const haystack = ranker.normalize(evidence);
  if (!expected || !haystack) return false;
  if (haystack.includes(expected)) return true;
  const tokens = expected.split(' ').filter((token) => token.length >= 2);
  if (!tokens.length) return false;
  const matched = tokens.filter((token) => haystack.includes(token)).length;
  return matched / tokens.length >= (tokens.length <= 2 ? 1 : 0.8);
}

async function resolveEmployerFromEvidence({ rawProfile, anchorName = '', linkedinUrl = '' } = {}) {
  if (!enabled() || !rawProfile) return null;
  const evidence = evidenceText(rawProfile);
  if (!evidence) return null;
  const messages = [
    {
      role: 'system',
      content: [
        'You are a bounded verifier inside a spreadsheet enrichment engine.',
        'Use ONLY the supplied LinkedIn-profile evidence. Do not infer from email domains, clients, schools, or general knowledge.',
        'Return strict JSON only: {"resolved":boolean,"company":"","title":"","confidence":0.0,"evidence":""}.',
        'Resolve only a CURRENT employer. If the evidence does not clearly support a current employer, return resolved=false.',
        'Copy company/title wording as closely as possible from the evidence. Do not expand abbreviations or invent legal suffixes.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({ anchorName, linkedinUrl, profileEvidence: evidence }),
    },
  ];
  const answered = await chat(messages, 'employer');
  if (!answered) return null;
  const parsed = parseJson(resultText(answered.result));
  if (!parsed || parsed.resolved !== true) { state.abstains++; return null; }
  const company = String(parsed.company || '').trim();
  const title = String(parsed.title || '').trim();
  const confidence = Number(parsed.confidence || 0);
  const quotedEvidence = String(parsed.evidence || '').trim();
  if (!company || confidence < Number(process.env.ULTRON_M3_UNIVERSAL_BIG_PICKLE_EMPLOYER_CONFIDENCE || 0.8)) {
    state.abstains++;
    return null;
  }
  if (!evidenceContainsCompany(company, evidence) || (quotedEvidence && !ranker.normalize(evidence).includes(ranker.normalize(quotedEvidence).slice(0, 100)))) {
    state.abstains++;
    return null;
  }
  return {
    company,
    title,
    confidence,
    evidence: quotedEvidence,
    source: 'big-pickle-evidence-fallback',
    model: answered.model,
  };
}

function candidateKey(candidate = {}) {
  return String(candidate.apolloPersonId || candidate.id || candidate.linkedinUrl || candidate.linkedin_url || '').trim();
}

function compactCandidate(item) {
  const candidate = item?.candidate || {};
  return {
    candidateKey: candidateKey(candidate),
    name: String(candidate.name || '').trim(),
    title: String(candidate.title || '').trim(),
    seniority: String(candidate.seniority || '').trim(),
    functions: Array.isArray(candidate.functions) ? candidate.functions.slice(0, 6) : [],
    departments: Array.isArray(candidate.departments) ? candidate.departments.slice(0, 6) : [],
    deterministicScore: Number(item.score || 0),
    deterministicConfidence: Number(item.confidence || 0),
    proof: Array.isArray(item.proof) ? item.proof.slice(0, 10) : [],
  };
}

function ambiguityReason(ranking, minimumConfidence = 0.54) {
  const list = Array.isArray(ranking?.ranked) ? ranking.ranked : [];
  if (!list.length) return null;
  const top = list[0];
  const second = list[1];
  if (Number(top.confidence || 0) < minimumConfidence) return 'low-confidence';
  const marginLimit = Number(process.env.ULTRON_M3_UNIVERSAL_BIG_PICKLE_MARGIN || 5);
  if (second && Number(top.score || 0) - Number(second.score || 0) <= marginLimit) return 'close-score';
  return null;
}

async function chooseCandidate({ ranking, context = {}, target = {}, minimumConfidence = 0.54, excludeKeys = [] } = {}) {
  if (!enabled()) return null;
  const reason = ambiguityReason(ranking, minimumConfidence);
  if (!reason) return null;
  const excluded = new Set((excludeKeys || []).map(String));
  const pool = (ranking.ranked || [])
    .filter((item) => candidateKey(item.candidate) && !excluded.has(candidateKey(item.candidate)))
    .slice(0, Math.max(2, Math.min(8, Number(process.env.ULTRON_M3_UNIVERSAL_BIG_PICKLE_CANDIDATES || 6))));
  if (pool.length < 2 && reason === 'close-score') return null;
  if (!pool.length) return null;

  const allowed = new Map(pool.map((item) => [candidateKey(item.candidate), item]));
  const messages = [
    {
      role: 'system',
      content: [
        'You are a bounded tie-breaker inside a deterministic spreadsheet enrichment engine.',
        'You may select ONLY one candidateKey from the supplied shortlist or abstain.',
        'Do not invent people or facts. Treat the deterministic evidence/proof as authoritative.',
        'Prefer the person most likely to own or directly influence hiring for the supplied requirement, considering function relevance and authority together.',
        'Return strict JSON only: {"candidateKey":"","confidence":0.0,"reason":""}. Use an empty candidateKey to abstain.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({
        ambiguity: reason,
        requirement: String(context.details || context.postDetails || context.requirement || context.roleContext || '').slice(0, 2500),
        company: String(context.company || ''),
        targetGroup: { id: target?.group?.id || '', ordinal: target?.group?.ordinal || null },
        candidates: pool.map(compactCandidate),
      }),
    },
  ];
  const answered = await chat(messages, 'candidate');
  if (!answered) return null;
  const parsed = parseJson(resultText(answered.result));
  const key = String(parsed?.candidateKey || '').trim();
  if (!key) { state.abstains++; return null; }
  const selected = allowed.get(key);
  if (!selected || Number(parsed?.confidence || 0) < Number(process.env.ULTRON_M3_UNIVERSAL_BIG_PICKLE_SELECTION_CONFIDENCE || 0.62)) {
    state.abstains++;
    return null;
  }
  return {
    ...selected,
    fallbackSelected: true,
    fallbackReason: reason,
    fallbackConfidence: Number(parsed.confidence || 0),
    fallbackExplanation: String(parsed.reason || '').slice(0, 500),
    fallbackModel: answered.model,
  };
}

module.exports = {
  enabled,
  resetRun,
  snapshot,
  selectRoute,
  resolveEmployerFromEvidence,
  chooseCandidate,
  ambiguityReason,
  evidenceContainsCompany,
  candidateKey,
};
