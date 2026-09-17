// Translate the raw-text profile contract published by linkedin-mcp-server into
// the structured employer fields expected by the anchored 3-POC resolver.
//
// linkedin-mcp-server returns { url, sections: { main_profile, experience, ... } }.
// It explicitly expects an LLM to parse those raw sections. The older 3-POC
// fallback looked for current_company / experiences[] directly, so a perfectly
// successful profile scrape could still produce no employer. This scoped layer
// resolves only an employer explicitly present in the exact profile evidence.

const threePoc = require('./three-poc-enrichment-operator');
const linkedinMcp = require('./linkedin-mcp-client');
const modelRouter = require('./model-router');

const INSTALL_FLAG = Symbol.for('ultron.mark3.threePocLinkedinProfileNormalizer.installed');
let runState = freshState();

function freshState() {
  return {
    rawSectionProfiles: 0,
    normalizationAttempts: 0,
    normalizationSuccesses: 0,
    lowConfidence: 0,
    noEvidence: 0,
    modelErrors: 0,
    providers: {},
    models: {},
  };
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    try { return JSON.parse(fenced); } catch {}
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return null;
}

function modelText(result) {
  return String(
    result?.content
    || result?.text
    || result?.response
    || result?.message?.content
    || result?.choices?.[0]?.message?.content
    || ''
  ).trim();
}

function parsedRawObject(value) {
  if (!value || typeof value !== 'object') return null;
  const raw = typeof value.rawText === 'string' ? value.rawText.trim() : '';
  if (!raw || (!raw.startsWith('{') && !raw.startsWith('['))) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function profileCandidates(payload) {
  const out = [];
  const push = (value) => {
    if (value && typeof value === 'object' && !out.includes(value)) out.push(value);
  };
  push(payload);
  push(payload?.data);
  push(payload?.result);
  push(payload?.profile);
  push(payload?.person);
  push(parsedRawObject(payload));
  return out;
}

function sectionsFrom(payload) {
  for (const candidate of profileCandidates(payload)) {
    const sections = candidate?.sections;
    if (sections && typeof sections === 'object' && !Array.isArray(sections)) return sections;
  }
  return null;
}

function sectionText(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(sectionText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    return Object.values(value).map(sectionText).filter(Boolean).join('\n');
  }
  return '';
}

function evidenceFrom(payload) {
  const sections = sectionsFrom(payload);
  if (!sections) return '';
  const ordered = [
    ['MAIN PROFILE', sections.main_profile || sections.profile || sections.main],
    ['EXPERIENCE', sections.experience],
  ];
  for (const [name, value] of Object.entries(sections)) {
    if (['main_profile', 'profile', 'main', 'experience'].includes(name)) continue;
    ordered.push([String(name).toUpperCase(), value]);
  }
  return ordered
    .map(([name, value]) => {
      const text = sectionText(value);
      return text ? `--- ${name} ---\n${text}` : '';
    })
    .filter(Boolean)
    .join('\n')
    .slice(0, 24000);
}

function existingEmployer(payload) {
  for (const candidate of profileCandidates(payload)) {
    const company = clean(
      candidate?.current_company
      || candidate?.currentCompany
      || candidate?.organization?.name
      || candidate?.current_organization?.name
      || candidate?.currentOrganization?.name
      || ''
    );
    if (company) return company;
  }
  return '';
}

function normalized(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function evidenceContains(value, evidence) {
  const needle = normalized(value);
  const haystack = normalized(evidence);
  return Boolean(needle && haystack && haystack.includes(needle));
}

function increment(target, key) {
  if (!key) return;
  target[key] = Number(target[key] || 0) + 1;
}

async function resolveEmployerFromSections(payload) {
  const evidence = evidenceFrom(payload);
  if (!evidence) {
    runState.noEvidence++;
    return null;
  }

  runState.rawSectionProfiles++;
  runState.normalizationAttempts++;
  try {
    const result = await modelRouter.chatOmniRouteOnly({
      model: 'auto/best-reasoning',
      taskType: 'research',
      messages: [
        {
          role: 'system',
          content: [
            'You are ULTRON Profile Employer Normalizer.',
            'The payload is raw text scraped from ONE exact LinkedIn member profile.',
            'Identify only the employer that is explicitly CURRENT for this person.',
            'Use the main profile headline/top card and the current/Present experience entry together.',
            'Never use a previous employer, client mentioned in a role description, school, recruiter vacancy client, email domain, or guessed company.',
            'If current employment is not explicit enough, return resolved=false.',
            'Return strict JSON only: {"resolved":true|false,"company":"","title":"","name":"","confidence":0.0,"evidence":"brief evidence"}.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({ exactLinkedInProfileEvidence: evidence }),
        },
      ],
    });

    increment(runState.providers, result?.provider || 'unknown');
    increment(runState.models, result?.model || 'unknown');
    if (result?.transport !== 'omniroute' || result?.personalApiFallbackAllowed !== false) return null;

    const parsed = parseJson(modelText(result));
    const company = clean(parsed?.company);
    const confidence = Number(parsed?.confidence || 0);
    if (
      parsed?.resolved !== true
      || !company
      || !Number.isFinite(confidence)
      || confidence < 0.76
      || !evidenceContains(company, evidence)
    ) {
      runState.lowConfidence++;
      return null;
    }

    runState.normalizationSuccesses++;
    return {
      company,
      title: clean(parsed?.title),
      name: clean(parsed?.name),
      confidence,
      evidence: clean(parsed?.evidence).slice(0, 600),
    };
  } catch {
    runState.modelErrors++;
    return null;
  }
}

async function normalizeProfile(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (existingEmployer(payload)) return payload;
  const resolved = await resolveEmployerFromSections(payload);
  if (!resolved?.company) return payload;
  return {
    ...payload,
    current_company: resolved.company,
    currentCompany: resolved.company,
    job_title: resolved.title || payload.job_title || '',
    full_name: resolved.name || payload.full_name || '',
    _ultronCurrentEmployerSource: 'linkedin-raw-sections-omniroute',
    _ultronCurrentEmployerConfidence: resolved.confidence,
    _ultronCurrentEmployerEvidence: resolved.evidence,
  };
}

function startRun() {
  runState = freshState();
  return stats();
}

function stats() {
  return {
    ...runState,
    providers: { ...runState.providers },
    models: { ...runState.models },
    personalApiFallbacks: 0,
  };
}

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];

  const originalEnrichWorkbook = threePoc.enrichWorkbook.bind(threePoc);
  const originalFormatResult = threePoc.formatResult.bind(threePoc);

  threePoc.enrichWorkbook = async function normalizedLinkedinProfileThreePocRun(...args) {
    startRun();
    const previous = linkedinMcp.callTool;
    const boundPrevious = previous.bind(linkedinMcp);
    linkedinMcp.callTool = async (tool, args = {}) => {
      const result = await boundPrevious(tool, args);
      if (tool !== 'get_person_profile') return result;
      return normalizeProfile(result);
    };
    try {
      const result = await originalEnrichWorkbook(...args);
      return { ...result, linkedinProfileNormalizer: stats() };
    } finally {
      linkedinMcp.callTool = previous;
    }
  };

  threePoc.formatResult = function profileNormalizerFormatResult(result) {
    const base = originalFormatResult(result);
    const s = result?.linkedinProfileNormalizer;
    if (!s) return base;
    const providers = Object.entries(s.providers || {}).map(([name, count]) => `${name}:${count}`).join(', ') || 'none';
    return `${base} Raw LinkedIn profile normalization: ${s.normalizationSuccesses}/${s.normalizationAttempts} current employers resolved from published sections; ${s.lowConfidence} safely rejected, ${s.noEvidence} no-evidence payloads, ${s.modelErrors} model errors; providers [${providers}]. Personal-API fallbacks: 0.`;
  };

  const api = Object.freeze({ startRun, stats, sectionsFrom, evidenceFrom, existingEmployer, normalizeProfile });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = {
  install,
  startRun,
  stats,
  sectionsFrom,
  evidenceFrom,
  existingEmployer,
  normalizeProfile,
};
