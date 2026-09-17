// Scoped exact-profile fallback for anchored 3-POC POC-1 employer resolution.
//
// Apollo remains the primary identity/contact source. During a 3-POC workbook run
// only, if Apollo cannot supply POC-1's current employer, this wrapper reads the
// exact LinkedIn profile already present in the row through the authenticated,
// read-only LinkedIn MCP. The Apollo resolver is restored immediately after the
// workbook run, so generic lead enrichment is not changed.

const apollo = require('./apollo-enrichment');
const threePoc = require('./three-poc-enrichment-operator');
const linkedinMcp = require('./linkedin-mcp-client');
const modelRouter = require('./model-router');

const INSTALL_FLAG = Symbol.for('ultron.mark3.threePocLinkedinAnchorFallback.installed');
let runState = freshState();

function freshState() {
  return {
    attempts: 0,
    structuredSuccesses: 0,
    omniRouteAttempts: 0,
    omniRouteSuccesses: 0,
    omniRouteBlocked: 0,
    failures: 0,
    budgetSkips: 0,
  };
}

function numericSetting(name, fallback, min = 0, max = 50) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function maxFallbacks() {
  return Math.floor(numericSetting('ULTRON_M3_THREE_POC_LINKEDIN_ANCHOR_FALLBACK_MAX', 8, 0, 25));
}

function linkedinSlug(input) {
  const url = apollo.normalizeLinkedIn(input);
  if (!url) return '';
  try {
    return decodeURIComponent(new URL(url).pathname.match(/^\/in\/([^/]+)/i)?.[1] || '').trim();
  } catch {
    return '';
  }
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function companyName(value) {
  if (!value) return '';
  if (typeof value === 'string') return cleanText(value);
  if (typeof value !== 'object') return '';
  return cleanText(
    value.name
    || value.company
    || value.company_name
    || value.organization_name
    || value.institution_name
    || value.title
    || ''
  );
}

function roleName(value) {
  if (!value || typeof value !== 'object') return '';
  return cleanText(value.position_title || value.title || value.job_title || value.role || value.position || '');
}

function isCurrentExperience(value, index = 0, profile = {}) {
  if (!value || typeof value !== 'object') return false;
  if (value.current === true || value.is_current === true || value.isCurrent === true || value.present === true) return true;
  const end = cleanText(value.to_date || value.end_date || value.endDate || value.date_to || value.dateTo || '').toLowerCase();
  if (/\b(?:present|current|now|ongoing)\b/.test(end)) return true;
  if (end) return false;

  // Several linkedin-scraper variants represent an ongoing role with an empty
  // to_date. Accept that only for the first experience, and when its role is
  // compatible with the top-card job title if both are available.
  if (index !== 0) return false;
  const topRole = cleanText(profile.job_title || profile.jobTitle || profile.headline || '').toLowerCase();
  const itemRole = roleName(value).toLowerCase();
  return !topRole || !itemRole || topRole.includes(itemRole) || itemRole.includes(topRole);
}

function structuredEmployer(profile = {}) {
  if (!profile || typeof profile !== 'object') return null;

  const direct = [
    profile.current_company,
    profile.currentCompany,
    profile.company,
    profile.employer,
    profile.organization,
    profile.current_organization,
    profile.currentOrganization,
    profile.top_card?.company,
    profile.topCard?.company,
  ].map(companyName).find(Boolean);

  if (direct) {
    return {
      company: direct,
      title: cleanText(profile.job_title || profile.jobTitle || profile.title || ''),
      name: cleanText(profile.name || profile.full_name || profile.fullName || ''),
      source: 'linkedin-structured-top-card',
    };
  }

  const experienceLists = [profile.experiences, profile.experience, profile.positions, profile.employment_history]
    .filter(Array.isArray);
  for (const list of experienceLists) {
    for (let index = 0; index < list.length; index++) {
      const item = list[index];
      const company = companyName(item?.company || item?.organization || item?.employer || item?.institution_name || item?.company_name);
      if (!company || !isCurrentExperience(item, index, profile)) continue;
      return {
        company,
        title: roleName(item) || cleanText(profile.job_title || profile.jobTitle || ''),
        name: cleanText(profile.name || profile.full_name || profile.fullName || ''),
        source: 'linkedin-structured-current-experience',
      };
    }
  }
  return null;
}

function flattenStrings(value, out = [], depth = 0) {
  if (out.join('\n').length > 18000 || depth > 7 || value == null) return out;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = cleanText(value);
    if (text) out.push(text);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 80)) flattenStrings(item, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value).slice(0, 120)) {
      if (/image|avatar|photo|tracking|cookie|token/i.test(key)) continue;
      flattenStrings(item, out, depth + 1);
    }
  }
  return out;
}

function profileEvidenceText(profile) {
  return flattenStrings(profile).join('\n').slice(0, 16000);
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
    result?.text
    || result?.content
    || result?.response
    || result?.message?.content
    || result?.choices?.[0]?.message?.content
    || ''
  );
}

function normalizedEvidence(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function companyPresentInEvidence(company, evidence) {
  const needle = normalizedEvidence(company);
  const haystack = normalizedEvidence(evidence);
  return Boolean(needle && haystack && haystack.includes(needle));
}

async function omniRouteEmployer(profile, linkedinUrl) {
  const evidence = profileEvidenceText(profile);
  if (!evidence) return null;
  runState.omniRouteAttempts++;

  const result = await modelRouter.chatOmniRouteOnly({
    model: 'auto/best-reasoning',
    taskType: 'research',
    messages: [
      {
        role: 'system',
        content: [
          'You are ULTRON Exact LinkedIn Employer Resolver.',
          'Extract ONLY the person\'s explicitly current employer from the supplied exact LinkedIn profile payload.',
          'Do not infer employer from an email domain, recruiter post, previous employer, client, school, or job description.',
          'Prefer the current/top Experience entry or explicit top-card company.',
          'If the current employer is not explicit, return resolved=false.',
          'Return strict JSON only: {"resolved":true|false,"company":"","title":"","name":"","confidence":0.0,"evidence":"short exact evidence description"}.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({ linkedinUrl, profileEvidence: evidence }),
      },
    ],
  });

  if (result?.transport !== 'omniroute' || result?.routingMode !== 'omniroute-only') {
    runState.omniRouteBlocked++;
    return null;
  }

  const parsed = parseJson(modelText(result));
  const company = cleanText(parsed?.company);
  const confidence = Number(parsed?.confidence || 0);
  if (
    parsed?.resolved !== true
    || !company
    || !Number.isFinite(confidence)
    || confidence < 0.78
    || !companyPresentInEvidence(company, evidence)
  ) return null;

  runState.omniRouteSuccesses++;
  return {
    company,
    title: cleanText(parsed?.title),
    name: cleanText(parsed?.name),
    source: 'linkedin-omniroute-explicit-current-employer',
    confidence,
    evidence: cleanText(parsed?.evidence).slice(0, 600),
  };
}

async function exactLinkedinEmployer(linkedinUrl) {
  const slug = linkedinSlug(linkedinUrl);
  if (!slug) return null;
  const profile = await linkedinMcp.callTool('get_person_profile', {
    linkedin_username: slug,
    sections: 'experience',
    max_scrolls: 4,
  });

  const structured = structuredEmployer(profile);
  if (structured?.company) {
    runState.structuredSuccesses++;
    return { ...structured, profile };
  }
  const inferred = await omniRouteEmployer(profile, linkedinUrl);
  return inferred ? { ...inferred, profile } : null;
}

function mergeEmployer(original, fallback, linkedinUrl) {
  const company = cleanText(fallback?.company);
  if (!company) return original;
  return {
    ...(original || {}),
    ok: true,
    noMatch: false,
    ambiguous: false,
    linkedinUrl: apollo.normalizeLinkedIn(linkedinUrl),
    returnedLinkedIn: apollo.normalizeLinkedIn(linkedinUrl),
    name: cleanText(original?.name || fallback?.name),
    title: cleanText(original?.title || fallback?.title),
    organizationName: company,
    organization: original?.organization || { name: company },
    organizationDomain: cleanText(original?.organizationDomain),
    linkedinEmployerSource: fallback.source,
    linkedinEmployerConfidence: fallback.confidence || 1,
    linkedinEmployerEvidence: fallback.evidence || null,
    identityVerified: true,
  };
}

async function scopedResolvePersonProfile(originalResolver, input, options = {}) {
  let original = null;
  try {
    original = await originalResolver(input, options);
  } catch (error) {
    // Apollo failures should not silently erase the exact LinkedIn anchor. The
    // fallback is still allowed to resolve employer identity; contact fields may
    // remain empty and will never be fabricated.
    original = { ok: false, noMatch: true, ambiguous: false, linkedinUrl: apollo.normalizeLinkedIn(input), apolloError: error.message };
  }

  if (cleanText(original?.organizationName || original?.organization?.name)) return original;
  if (runState.attempts >= maxFallbacks()) {
    runState.budgetSkips++;
    return original;
  }

  runState.attempts++;
  try {
    const fallback = await exactLinkedinEmployer(input);
    if (!fallback?.company) {
      runState.failures++;
      return original;
    }
    return mergeEmployer(original, fallback, input);
  } catch {
    runState.failures++;
    return original;
  }
}

function startRun() {
  runState = freshState();
  return stats();
}

function stats() {
  return {
    ...runState,
    maxFallbacks: maxFallbacks(),
    source: 'authenticated-linkedin-exact-profile',
    personalApiFallbacks: 0,
  };
}

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];

  const originalEnrichWorkbook = threePoc.enrichWorkbook.bind(threePoc);
  const originalFormatResult = threePoc.formatResult.bind(threePoc);

  threePoc.enrichWorkbook = async function linkedinAnchorFallbackEnrichWorkbook(...args) {
    startRun();
    const previousResolvePersonProfile = apollo.resolvePersonProfile;
    const boundOriginal = previousResolvePersonProfile.bind(apollo);
    apollo.resolvePersonProfile = (input, options = {}) => scopedResolvePersonProfile(boundOriginal, input, options);
    try {
      const result = await originalEnrichWorkbook(...args);
      return { ...result, linkedinAnchorEmployerFallback: stats() };
    } finally {
      apollo.resolvePersonProfile = previousResolvePersonProfile;
    }
  };

  threePoc.formatResult = function linkedinAnchorFallbackFormatResult(result) {
    const base = originalFormatResult(result);
    const fallback = result?.linkedinAnchorEmployerFallback;
    if (!fallback) return base;
    return `${base} Exact-LinkedIn POC-1 employer fallback: ${fallback.structuredSuccesses + fallback.omniRouteSuccesses}/${fallback.attempts} resolved (${fallback.structuredSuccesses} structured, ${fallback.omniRouteSuccesses} OmniRoute); ${fallback.failures} unresolved, ${fallback.budgetSkips} safety-cap skips, ${fallback.omniRouteBlocked} non-OmniRoute blocks. Personal-API fallbacks: 0.`;
  };

  const api = Object.freeze({ startRun, stats, structuredEmployer, linkedinSlug, profileEvidenceText });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = {
  install,
  startRun,
  stats,
  structuredEmployer,
  linkedinSlug,
  profileEvidenceText,
};
