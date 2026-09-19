const fs = require('fs');
const path = require('path');
const config = require('./config');
const companyIdentity = require('./company-identity');

const APOLLO_MATCH = 'https://api.apollo.io/api/v1/people/match';
const APOLLO_PEOPLE_SEARCH = 'https://api.apollo.io/api/v1/mixed_people/api_search';
const CACHE_FILE = path.join(config.projectRoot, '.ultron', 'lead-enrichment', 'apollo-cache.json');
const CACHE_VERSION = 4;

function envFileValue(name) {
  for (const file of [path.join(config.projectRoot, '.env'), path.join(config.mark3Root, '.env')]) {
    try {
      if (!fs.existsSync(file)) continue;
      const match = fs.readFileSync(file, 'utf8').match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`, 'm'));
      if (match) return String(match[1] || '').trim().replace(/^['"]|['"]$/g, '');
    } catch {}
  }
  return '';
}

function setting(name, fallback = '') {
  return String(process.env[name] || envFileValue(name) || fallback).trim();
}

function normalizeLinkedIn(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  // Office lead sheets often store values such as
  // "ID: https://www.linkedin.com/in/person-name/" rather than a bare URL.
  // Extract the profile URL from surrounding labels/text before normalizing it.
  const embedded = raw.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/in\/[a-z0-9%._~-]+\/?(?:[?#][^\s<>'"`]*)?/i)?.[0];
  let value = (embedded || raw).replace(/[),.;!?]+$/, '');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^(?:[a-z]{2,3}\.)?www\./, '').replace(/^[a-z]{2,3}\./, '');
    if (host !== 'linkedin.com') return null;
    const match = url.pathname.match(/^\/in\/([^/]+)/i);
    if (!match?.[1]) return null;
    const slug = decodeURIComponent(match[1]).trim().replace(/\/+$/, '');
    if (!slug) return null;
    return `https://www.linkedin.com/in/${encodeURIComponent(slug).replace(/%2D/gi, '-').replace(/%5F/gi, '_').replace(/%2E/gi, '.')}`;
  } catch {
    return null;
  }
}

function migrateCache(parsed) {
  const version = Number(parsed?.version || 0);
  if (version === CACHE_VERSION) return { version: CACHE_VERSION, people: parsed.people || {} };

  const people = {};
  for (const [url, record] of Object.entries(parsed?.people || {})) {
    if (!record) continue;

    if (version === 2 || version === 3) {
      if (!record.ambiguous) people[url] = record;
      continue;
    }

    if (record.noMatch === false && record.apolloPersonId) people[url] = record;
  }
  return { version: CACHE_VERSION, people };
}

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return { version: CACHE_VERSION, people: {} };
    return migrateCache(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')));
  } catch {
    return { version: CACHE_VERSION, people: {} };
  }
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ version: CACHE_VERSION, people: cache.people || {} }, null, 2));
}

function numericSetting(name, fallback) {
  const value = Number(setting(name, String(fallback)));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function cacheDays(record) {
  // Positive data is expensive to reveal again, especially mobile numbers. Keep it
  // much longer than negatives. Pending/ambiguous records are intentionally short-lived
  // so quality does not get frozen merely to save credits.
  if (record?.phoneStatus === 'found' || record?.phone || record?.email) {
    return numericSetting('ULTRON_M3_APOLLO_POSITIVE_CACHE_DAYS', 180);
  }
  if (record?.phoneStatus === 'pending') {
    return numericSetting('ULTRON_M3_APOLLO_PENDING_CACHE_DAYS', 1);
  }
  if (record?.ambiguous) {
    return numericSetting('ULTRON_M3_APOLLO_AMBIGUOUS_CACHE_DAYS', 7);
  }
  if (record?.noMatch || record?.emailKnown || record?.phoneStatus === 'not_found') {
    return numericSetting('ULTRON_M3_APOLLO_NEGATIVE_CACHE_DAYS', 30);
  }
  return numericSetting('ULTRON_M3_APOLLO_CACHE_DAYS', 30);
}

function isFresh(record) {
  const checked = Date.parse(record?.checkedAt || '');
  return Number.isFinite(checked) && Date.now() - checked < cacheDays(record) * 86400000;
}

function pendingPhoneRequestFresh(record) {
  if (record?.phoneStatus !== 'pending') return false;
  const requestedAt = Date.parse(record?.phoneRequestedAt || record?.checkedAt || '');
  if (!Number.isFinite(requestedAt)) return false;
  const retryMinutes = Math.max(
    1,
    Math.min(60, numericSetting('ULTRON_M3_APOLLO_PENDING_PHONE_RETRY_MINUTES', 3)),
  );
  return Date.now() - requestedAt < retryMinutes * 60_000;
}

function satisfies(record, { needEmail, needPhone }) {
  if (!record || !isFresh(record)) return false;
  if (record.noMatch || record.ambiguous) return true;
  if (needEmail && !record.emailKnown) return false;
  if (needEmail && record.email != null && !validEmail(record.email)) return false;
  if (needPhone) {
    if (!['found', 'not_found', 'pending'].includes(record.phoneStatus)) return false;
    if (record.phoneStatus === 'found' && !validPhone(record.phone)) return false;
    if (record.phoneStatus === 'pending' && !pendingPhoneRequestFresh(record)) return false;
  }
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(30_000, retryAfter * 1000);
  return Math.min(12_000, 800 * (2 ** attempt));
}

function apolloBodyReadError(cause, attempts, endpoint) {
  const message = String(cause?.message || cause || 'unknown body-read failure');
  const error = new Error('Apollo response body could not be read after ' + attempts + ' attempt' + (attempts === 1 ? '' : 's') + ': ' + message);
  error.code = 'APOLLO_NETWORK_BODY_READ_FAILED';
  error.subsystem = 'APOLLO';
  error.errorType = 'NETWORK';
  error.stage = 'apollo-http-body-read';
  error.retryAttempts = attempts;
  error.endpoint = String(endpoint || '');
  error.cause = cause;
  error.hint = 'Apollo returned a connection but the response body was interrupted. ULTRON retried the body/request before stopping safely.';
  return error;
}

async function fetchApolloResponse(input, init, options = {}) {
  const bodyRetries = Math.max(0, Math.min(3, Number(options.bodyRetries ?? 2)));
  const endpoint = input instanceof URL ? input.toString() : String(input || '');
  let lastBodyError = null;

  for (let attempt = 0; attempt <= bodyRetries; attempt++) {
    const response = await fetch(input, init);
    try {
      const text = await response.text();
      return { response, text };
    } catch (cause) {
      lastBodyError = cause;
      if (attempt >= bodyRetries) break;
      await sleep(250 * (2 ** attempt));
    }
  }

  throw apolloBodyReadError(lastBodyError, bodyRetries + 1, endpoint);
}

function webhookUrl() {
  const raw = setting('APOLLO_WEBHOOK_URL');
  const secret = setting('APOLLO_WEBHOOK_SECRET');
  if (!raw || !secret) return '';
  const url = new URL(raw);
  url.searchParams.set('token', secret);
  return url.toString();
}

function workerUrl(pathname) {
  const raw = setting('APOLLO_WEBHOOK_URL');
  const secret = setting('APOLLO_WEBHOOK_SECRET');
  if (!raw || !secret) return '';
  const source = new URL(raw);
  const url = new URL(pathname, source.origin);
  url.searchParams.set('token', secret);
  return url.toString();
}

function validEmail(value) {
  const text = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : null;
}

function validPhone(value) {
  const text = String(value || '').trim();
  if (!text || /^(?:null|none|n\/?a|unknown|not\s+found|unavailable|-+)$/i.test(text)) return null;
  const digits = text.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? text : null;
}

function normalizedWords(value) {
  return String(value || '').toLowerCase().replace(/\b(?:private|pvt|limited|ltd|llp|plc|inc|incorporated|corp|corporation|company|co)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function hostname(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return raw.toLowerCase().replace(/^www\./, '').split('/')[0];
  }
}

const COMPANY_DECISION_PRIORITY = Object.freeze([
  Object.freeze({
    priority: 1,
    key: 'founder_director',
    label: 'Founder / Director / Owner',
    titles: Object.freeze([
      'founder', 'co-founder', 'owner', 'director', 'managing director', 'executive director',
    ]),
  }),
  Object.freeze({
    priority: 2,
    key: 'head_recruiter_manager',
    label: 'Head Recruiter / Manager',
    titles: Object.freeze([
      'head recruiter', 'lead recruiter', 'head of recruitment', 'recruitment head',
      'recruitment lead', 'recruiting lead', 'head of talent acquisition',
      'talent acquisition head', 'talent acquisition lead', 'head of HR', 'head of people',
      'recruitment manager', 'recruiting manager', 'hiring manager',
      'talent acquisition manager', 'HR manager', 'human resources manager',
      'general manager', 'manager',
    ]),
  }),
  Object.freeze({
    priority: 3,
    key: 'hr_recruiter',
    label: 'HR Recruiter',
    titles: Object.freeze([
      'HR recruiter', 'human resources recruiter', 'recruiter',
      'technical recruiter', 'talent acquisition recruiter',
    ]),
  }),
]);

function decisionPriority(title, mode = 'general') {
  const value = normalizedWords(title);
  if (!value) return 99;

  // One canonical scale for every company-based lead workflow.
  // Mode is retained only for backwards compatibility with existing callers.
  if (/\b(?:founder|co founder|owner|director)\b/.test(value)) return 1;

  const exactManager = value === 'manager';
  if (
    /\b(?:head recruiter|lead recruiter|recruitment head|head of recruitment|recruitment lead|recruiting lead|head of talent acquisition|talent acquisition head|talent acquisition lead|head of hr|head of people|recruitment manager|recruiting manager|hiring manager|talent acquisition manager|hr manager|human resources manager|general manager)\b/.test(value)
    || exactManager
  ) return 2;

  if (/\b(?:hr recruiter|human resources recruiter|technical recruiter|talent acquisition recruiter|recruiter)\b/.test(value)) return 3;
  return 99;
}


function personOrganization(person = {}) {
  const organization = person?.organization || {};
  const organizationName = String(
    person?.organization_name
    || organization?.name
    || person?.employment_history?.find?.((item) => item?.current)?.organization_name
    || ''
  ).trim();
  const organizationDomain = hostname(
    organization?.website_url
    || organization?.primary_domain
    || organization?.domain
    || ''
  );
  return {
    organization: person?.organization || null,
    organizationName,
    organizationDomain,
  };
}

function domainBrand(value) {
  return companyIdentity.domainBrand(value);
}

function organizationNameOf(person = {}) {
  return String(
    person?.organizationName
    || person?.organization_name
    || person?.organization?.name
    || person?.employment_history?.find?.((item) => item?.current)?.organization_name
    || person?.employment_history?.[0]?.organization_name
    || ''
  ).trim();
}

function organizationDomainOf(person = {}) {
  return hostname(
    person?.organizationDomain
    || person?.organization?.website_url
    || person?.organization?.primary_domain
    || person?.organization?.domain
    || ''
  );
}

function organizationNameMatches(expectedValue, actualValue) {
  return companyIdentity.nameMatch(expectedValue, actualValue);
}

function sameOrganization(person, company, domain = '') {
  return companyIdentity.sameOrganization({
    expectedCompany: company,
    expectedDomain: domain,
    actualCompany: organizationNameOf(person),
    actualDomain: organizationDomainOf(person),
  });
}

function searchCandidateFromPerson(person, cleanCompany, cleanDomain) {
  if (!sameOrganization(person, cleanCompany, cleanDomain)) return null;

  const apolloId = String(person?.id || '').trim();
  const linkedinUrl = normalizeLinkedIn(person?.linkedin_url || person?.linkedin || '');
  if (!apolloId && !linkedinUrl) return null;

  const limitedName = String(
    person?.name
    || [person?.first_name, person?.last_name || person?.last_name_obfuscated].filter(Boolean).join(' ')
    || ''
  ).trim();

  return {
    id: apolloId || null,
    name: limitedName,
    title: String(person?.title || '').trim(),
    headline: String(person?.headline || '').trim(),
    seniority: String(person?.seniority || '').trim(),
    departments: Array.isArray(person?.departments) ? person.departments.filter(Boolean) : [],
    functions: Array.isArray(person?.functions) ? person.functions.filter(Boolean) : [],
    location: String(person?.city || person?.state || person?.country || '').trim(),
    linkedinUrl: linkedinUrl || null,
    organizationName: String(person?.organization_name || person?.organization?.name || cleanCompany).trim(),
    organizationDomain: hostname(person?.organization?.website_url || person?.organization?.primary_domain || person?.organization?.domain || cleanDomain),
    email: null,
    phone: null,
    searchLimitedIdentity: !linkedinUrl,
    lastNameObfuscated: Boolean(person?.last_name_obfuscated && !person?.last_name),
  };
}

async function searchCompanyPeopleBroad({ company, domain = '', location = '', limit = 50, titles = [] } = {}) {
  const apiKey = setting('APOLLO_API_KEY');
  if (!apiKey) {
    const error = new Error('APOLLO_API_KEY is missing.');
    error.code = 'APOLLO_NOT_CONFIGURED';
    throw error;
  }
  const cleanCompany = String(company || '').trim();
  const cleanDomain = hostname(domain);
  if (!cleanCompany && !cleanDomain) {
    const error = new Error('Company name or domain is required for broad Apollo people discovery.');
    error.code = 'APOLLO_COMPANY_REQUIRED';
    throw error;
  }

  const wanted = Math.max(5, Math.min(100, Number(limit || 50)));
  const perPage = Math.min(50, wanted);
  const pages = Math.min(3, Math.ceil(wanted / perPage));
  const found = [];
  const seen = new Set();

  for (let page = 1; page <= pages && found.length < wanted; page++) {
    const url = new URL(APOLLO_PEOPLE_SEARCH);
    if (cleanDomain) url.searchParams.append('q_organization_domains_list[]', cleanDomain);
    else url.searchParams.set('q_keywords', cleanCompany);
    for (const title of (Array.isArray(titles) ? titles : []).map((value) => String(value || '').trim()).filter(Boolean).slice(0, 30)) {
      url.searchParams.append('person_titles[]', title);
    }
    if (Array.isArray(titles) && titles.length) url.searchParams.set('include_similar_titles', 'true');
    if (location) url.searchParams.append('person_locations[]', String(location).trim());
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));

    let data = {};
    let completed = false;
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const { response, text: raw } = await fetchApolloResponse(url, { method: 'POST', headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Cache-Control': 'no-cache' } });
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
      if (response.ok) {
        completed = true;
        break;
      }
      const message = data?.error || data?.error_message || data?.message || `Apollo broad people search failed (${response.status}).`;
      const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
      error.status = response.status;
      error.code = response.status === 403 ? 'APOLLO_PEOPLE_SEARCH_ACCESS_REQUIRED' : 'APOLLO_PEOPLE_SEARCH_FAILED';
      lastError = error;
      if (response.status !== 429 && response.status < 500) throw error;
      if (attempt < 3) await sleep(retryDelay(response, attempt));
    }
    if (!completed) throw lastError || new Error('Apollo broad people search failed.');

    const people = Array.isArray(data.people) ? data.people : Array.isArray(data.contacts) ? data.contacts : [];
    for (const person of people) {
      const candidate = searchCandidateFromPerson(person, cleanCompany, cleanDomain);
      if (!candidate) continue;
      const key = String(candidate.id || candidate.linkedinUrl).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(candidate);
      if (found.length >= wanted) break;
    }
    if (!people.length) break;
  }

  return { ok: true, company: cleanCompany, domain: cleanDomain, people: found, candidatesChecked: found.length };
}

function rankedDecisionMakers(people, company, domain = '', priorityMode = 'general') {
  return (Array.isArray(people) ? people : [])
    .filter((person) => sameOrganization(person, company, domain))
    .map((person) => ({
      ...person,
      decisionPriority: decisionPriority(person.title || person.headline || '', priorityMode),
      linkedinUrl: normalizeLinkedIn(person.linkedin_url || person.linkedin || ''),
    }))
    .filter((person) => person.decisionPriority < 99 && (person.id || person.linkedinUrl))
    .sort((a, b) => a.decisionPriority - b.decisionPriority || String(a.name || '').localeCompare(String(b.name || '')));
}

async function searchCompanyDecisionMaker({ company, domain = '', location = '', priorityMode = 'general' } = {}) {
  const apiKey = setting('APOLLO_API_KEY');
  if (!apiKey) {
    const error = new Error('APOLLO_API_KEY is missing.');
    error.code = 'APOLLO_NOT_CONFIGURED';
    throw error;
  }

  const cleanDomain = hostname(domain);
  let candidatesChecked = 0;

  // Query Apollo in priority order rather than asking for every title at once.
  // This guarantees that a lower-priority recruiter cannot beat an available
  // founder/director merely because Apollo returned that recruiter earlier.
  for (const tier of COMPANY_DECISION_PRIORITY) {
    const url = new URL(APOLLO_PEOPLE_SEARCH);
    for (const title of tier.titles) url.searchParams.append('person_titles[]', title);
    if (cleanDomain) url.searchParams.append('q_organization_domains_list[]', cleanDomain);
    else url.searchParams.set('q_keywords', String(company || '').trim());
    if (location) url.searchParams.append('person_locations[]', String(location).trim());
    url.searchParams.set('include_similar_titles', 'true');
    url.searchParams.set('page', '1');
    url.searchParams.set('per_page', '25');

    let lastError;
    let tierCompleted = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const { response, text } = await fetchApolloResponse(url, { method: 'POST', headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Cache-Control': 'no-cache' } });
      let data = {};
      try { data = JSON.parse(text); } catch {}
      if (response.ok) {
        const people = data.people || data.contacts || [];
        candidatesChecked += Array.isArray(people) ? people.length : 0;
        const ranked = rankedDecisionMakers(people, company, cleanDomain, priorityMode);
        const candidate = ranked.find((person) => person.decisionPriority <= tier.priority) || null;
        if (candidate) {
          return {
            ok: true,
            company,
            domain: cleanDomain,
            candidate,
            candidatesChecked,
            selectedPriority: candidate.decisionPriority,
            selectedPriorityLabel: COMPANY_DECISION_PRIORITY.find((item) => item.priority === candidate.decisionPriority)?.label || null,
          };
        }
        tierCompleted = true;
        break;
      }
      const message = data?.error || data?.error_message || data?.message || `Apollo people search failed (${response.status}).`;
      const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
      error.status = response.status;
      error.code = response.status === 403 ? 'APOLLO_PEOPLE_SEARCH_ACCESS_REQUIRED' : 'APOLLO_PEOPLE_SEARCH_FAILED';
      lastError = error;
      if (response.status !== 429 && response.status < 500) throw error;
      if (attempt < 3) await sleep(retryDelay(response, attempt));
    }
    if (!tierCompleted && lastError) throw lastError;
  }

  return { ok: true, company, domain: cleanDomain, candidate: null, candidatesChecked, selectedPriority: null, selectedPriorityLabel: null };
}

function personFromResponse(data) {
  return data?.person || data?.contact || null;
}

function matchDecision(requestedLinkedIn, data) {
  const person = personFromResponse(data);
  const confidence = String(data?.match_confidence || person?.match_confidence || '').toLowerCase();
  if (!person?.id || confidence === 'none') return { state: 'no_match', confidence, person: person || null };

  const returned = normalizeLinkedIn(person.linkedin_url || person.linkedin || '');
  if (confidence !== 'low' || !returned || returned === requestedLinkedIn) {
    return { state: 'accepted', confidence, person, returnedLinkedIn: returned || null };
  }

  return { state: 'ambiguous', confidence, person, returnedLinkedIn: returned };
}

async function apiCall(linkedinUrl, { needPhone }) {
  const apiKey = setting('APOLLO_API_KEY');
  if (!apiKey) {
    const error = new Error('APOLLO_API_KEY is missing.');
    error.code = 'APOLLO_NOT_CONFIGURED';
    throw error;
  }
  const url = new URL(APOLLO_MATCH);
  if (linkedinUrl && typeof linkedinUrl === 'object') {
    if (linkedinUrl.id) url.searchParams.set('id', String(linkedinUrl.id));
    if (linkedinUrl.name) url.searchParams.set('name', String(linkedinUrl.name));
    if (linkedinUrl.domain) url.searchParams.set('domain', hostname(linkedinUrl.domain));
    if (linkedinUrl.organizationName) url.searchParams.set('organization_name', String(linkedinUrl.organizationName));
  } else {
    url.searchParams.set('linkedin_url', linkedinUrl);
  }
  // Credit-saver defaults: do not run personal-email or waterfall enrichment here.
  // The office Sheet/post itself is checked first by the lead operator.
  url.searchParams.set('reveal_personal_emails', 'false');
  url.searchParams.set('run_waterfall_email', 'false');
  url.searchParams.set('run_waterfall_phone', 'false');
  url.searchParams.set('reveal_phone_number', needPhone ? 'true' : 'false');
  if (needPhone) {
    const callback = webhookUrl();
    if (!callback) {
      const error = new Error('Apollo phone enrichment needs APOLLO_WEBHOOK_URL and APOLLO_WEBHOOK_SECRET.');
      error.code = 'APOLLO_WEBHOOK_NOT_CONFIGURED';
      throw error;
    }
    url.searchParams.set('webhook_url', callback);
  }

  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    const { response, text } = await fetchApolloResponse(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
    });
    let data = {};
    try { data = JSON.parse(text); } catch {}
    if (response.ok) return data;
    const message = data?.error || data?.error_message || data?.message || `Apollo enrichment failed (${response.status}).`;
    const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = response.status;
    lastError = error;
    if (response.status !== 429 && response.status < 500) throw error;
    if (attempt < 3) await sleep(retryDelay(response, attempt));
  }
  throw lastError || new Error('Apollo enrichment failed.');
}

function candidateEmployerContext(candidate = {}, company = '', domain = '') {
  const discoveredCompany = String(
    candidate.organizationName
    || candidate.organization_name
    || candidate.organization?.name
    || ''
  ).trim();
  const discoveredDomain = hostname(
    candidate.organizationDomain
    || candidate.organization?.website_url
    || candidate.organization?.primary_domain
    || candidate.organization?.domain
    || ''
  );
  return {
    requestedCompany: String(company || '').trim(),
    requestedDomain: hostname(domain),
    discoveredCompany,
    discoveredDomain,
  };
}

function hydratedEmployerMatchesCandidate(person, candidate = {}, company = '', domain = '') {
  const ctx = candidateEmployerContext(candidate, company, domain);
  if (sameOrganization(person, ctx.requestedCompany, ctx.requestedDomain)) return true;
  if (ctx.discoveredCompany || ctx.discoveredDomain) {
    if (sameOrganization(person, ctx.discoveredCompany, ctx.discoveredDomain)) return true;
  }

  // Authenticated LinkedIn current-experience evidence is fresher than Apollo's
  // employer metadata. Trust it only when the candidate itself was explicitly
  // verified on LinkedIn against the requested employer.
  if (
    candidate.linkedinEmployerVerified === true
    && sameOrganization(candidate, ctx.requestedCompany, ctx.requestedDomain)
  ) return true;

  // Candidate came from an employer-constrained Apollo search. If its discovered
  // employer matches the requested employer, tolerate missing hydrated org metadata,
  // but never tolerate a clearly different hydrated organization unless LinkedIn
  // explicitly verified the current employer above.
  const candidateMatchesRequested = sameOrganization(candidate, ctx.requestedCompany, ctx.requestedDomain);
  const hydratedOrg = personOrganization(person);
  const hydratedHasOrg = Boolean(hydratedOrg.organizationName || hydratedOrg.organizationDomain);
  return Boolean(candidateMatchesRequested && !hydratedHasOrg);
}

function hydratedIdentityMatchesCandidate(person, candidate = {}) {
  if (!person || !candidate?.id || String(person.id) !== String(candidate.id)) return false;
  const hydratedLinkedin = normalizeLinkedIn(person?.linkedin_url || person?.linkedin || '');
  const candidateLinkedin = normalizeLinkedIn(candidate.linkedinUrl || candidate.linkedin_url || '');
  return !(candidateLinkedin && hydratedLinkedin && candidateLinkedin !== hydratedLinkedin);
}

async function resolveDecisionMaker(candidate, company, domain, options = {}) {
  if (!candidate.id) return { ...candidate, identityVerified: Boolean(normalizeLinkedIn(candidate.linkedinUrl)) };

  const needEmail = options.needEmail !== false;
  const needPhone = options.needPhone !== false;
  const cache = readCache();
  const cached = Object.entries(cache.people).find(([, p]) =>
    p.apolloPersonId === String(candidate.id)
    && p.name
    && satisfies(p, { needEmail, needPhone })
  );

  if (cached && hydratedEmployerMatchesCandidate(cached[1], candidate, company, domain)) {
    return { ...candidate, ...cached[1], linkedinUrl: cached[0], identityVerified: true };
  }

  const data = await apiCall({ id: candidate.id }, { needPhone });
  const person = data.person;
  const hydratedLinkedin = normalizeLinkedIn(person?.linkedin_url || person?.linkedin || '');
  const candidateLinkedin = normalizeLinkedIn(candidate.linkedinUrl || candidate.linkedin_url || '');
  if (!hydratedIdentityMatchesCandidate(person, candidate)) {
    const error = new Error('APOLLO_IDENTITY_MISMATCH');
    error.code = 'APOLLO_IDENTITY_MISMATCH';
    error.candidateId = String(candidate.id || '');
    error.hydratedId = String(person?.id || '');
    error.candidateLinkedIn = candidateLinkedin || '';
    error.hydratedLinkedIn = hydratedLinkedin || '';
    throw error;
  }
  // Apollo person ID equality is exact identity evidence. Some match/reveal
  // responses omit linkedin_url even when the search candidate already carried it.
  const linkedinUrl = hydratedLinkedin || candidateLinkedin || null;
  if (!hydratedEmployerMatchesCandidate(person, candidate, company, domain)) {
    const error = new Error('APOLLO_COMPANY_MISMATCH_AFTER_HYDRATION');
    error.code = 'APOLLO_COMPANY_MISMATCH_AFTER_HYDRATION';
    error.requestedCompany = String(company || '');
    error.requestedDomain = hostname(domain);
    error.candidateOrganizationName = String(candidate.organizationName || candidate.organization_name || '');
    error.candidateOrganizationDomain = hostname(candidate.organizationDomain || '');
    const hydrated = personOrganization(person);
    error.hydratedOrganizationName = hydrated.organizationName;
    error.hydratedOrganizationDomain = hydrated.organizationDomain;
    throw error;
  }

  const organization = personOrganization(person);
  const immediatePhone = validPhone(person.phone_number || person.sanitized_phone || '');
  const phoneStatus = needPhone ? (immediatePhone ? 'found' : 'pending') : null;
  const record = {
    name: String(person.name || [person.first_name, person.last_name].filter(Boolean).join(' ') || candidate.name || '').trim(),
    title: String(person.title || candidate.title || '').trim(),
    headline: String(person.headline || candidate.headline || '').trim(),
    organization: organization.organization,
    organizationName: organization.organizationName,
    organizationDomain: organization.organizationDomain,
    apolloPersonId: String(person.id),
    noMatch: false,
    ambiguous: false,
    emailKnown: needEmail,
    email: needEmail ? validEmail(person.email) : null,
    phone: immediatePhone,
    phoneStatus,
    returnedLinkedIn: linkedinUrl,
    checkedAt: new Date().toISOString(),
    phoneRequestedAt: needPhone && !immediatePhone ? new Date().toISOString() : null,
    identityVerified: true,
  };
  if (linkedinUrl) {
    cache.people[linkedinUrl] = record;
    saveCache(cache);
  }
  return { ...candidate, ...record, linkedinUrl: linkedinUrl || candidateLinkedin || null, identityVerified: true };
}

async function resolvePersonByNameCompany(name, company, domain, options = {}) {
  const cleanName = String(name || '').replace(/\s+[—–]\s+.*$/, '').replace(/\s*\([^)]{2,120}\)\s*$/, '').replace(/\s+/g, ' ').trim();
  const cleanCompany = String(company || '').trim();
  const cleanDomain = hostname(domain);
  if (!cleanName || (!cleanCompany && !cleanDomain)) {
    const error = new Error('Apollo exact person verification requires a person name and employer.');
    error.code = 'APOLLO_PERSON_COMPANY_REQUIRED';
    throw error;
  }

  const needEmail = options.needEmail !== false;
  const needPhone = options.needPhone !== false;
  const data = await apiCall({
    name: cleanName,
    domain: cleanDomain,
    organizationName: cleanCompany,
  }, { needPhone });

  const person = data.person;
  const confidence = String(data?.match_confidence || person?.match_confidence || '').toLowerCase();
  const linkedinUrl = normalizeLinkedIn(person?.linkedin_url || person?.linkedin || '');
  const returnedName = String(person?.name || [person?.first_name, person?.last_name].filter(Boolean).join(' ') || '').trim();

  if (
    !person?.id
    || !linkedinUrl
    || ['none', 'low'].includes(confidence)
    || normalizedWords(returnedName) !== normalizedWords(cleanName)
    || !sameOrganization(person, cleanCompany, cleanDomain)
  ) {
    const error = new Error('APOLLO_PERSON_NAME_COMPANY_MISMATCH');
    error.code = 'APOLLO_PERSON_NAME_COMPANY_MISMATCH';
    throw error;
  }

  const organization = personOrganization(person);
  const immediatePhone = validPhone(person.phone_number || person.sanitized_phone || '');
  const record = {
    name: returnedName,
    title: String(person.title || '').trim(),
    headline: String(person.headline || '').trim(),
    organization: organization.organization,
    organizationName: organization.organizationName,
    organizationDomain: organization.organizationDomain,
    apolloPersonId: String(person.id),
    noMatch: false,
    ambiguous: false,
    emailKnown: needEmail,
    email: needEmail ? validEmail(person.email) : null,
    phone: immediatePhone,
    phoneStatus: needPhone ? (immediatePhone ? 'found' : 'pending') : null,
    returnedLinkedIn: linkedinUrl,
    checkedAt: new Date().toISOString(),
    phoneRequestedAt: needPhone && !immediatePhone ? new Date().toISOString() : null,
    identityVerified: true,
    matchConfidence: confidence || null,
  };

  const cache = readCache();
  cache.people[linkedinUrl] = record;
  saveCache(cache);
  return { ...record, id: String(person.id), linkedinUrl, identityVerified: true };
}

async function enrich(input, options = {}) {
  const linkedinUrl = normalizeLinkedIn(input);
  if (!linkedinUrl) return { ok: false, invalidLinkedIn: true, linkedinUrl: null };
  const needEmail = Boolean(options.needEmail);
  const needPhone = Boolean(options.needPhone);
  const cache = readCache();
  const existing = cache.people[linkedinUrl];
  if (!options.force && satisfies(existing, { needEmail, needPhone })) {
    return { ok: true, cached: true, linkedinUrl, ...existing };
  }

  const data = await apiCall(linkedinUrl, { needPhone });
  const decision = matchDecision(linkedinUrl, data);
  const previous = existing || {};
  let record;

  if (decision.state === 'no_match') {
    record = {
      ...previous,
      noMatch: true,
      ambiguous: false,
      apolloPersonId: null,
      emailKnown: needEmail ? true : Boolean(previous.emailKnown),
      email: needEmail ? null : (previous.email ?? null),
      phoneStatus: needPhone ? 'not_found' : (previous.phoneStatus || null),
      phone: needPhone ? null : (previous.phone ?? null),
      matchConfidence: decision.confidence || 'none',
      returnedLinkedIn: null,
      checkedAt: new Date().toISOString(),
    };
  } else if (decision.state === 'ambiguous') {
    record = {
      ...previous,
      noMatch: false,
      ambiguous: true,
      apolloPersonId: null,
      emailKnown: false,
      phoneStatus: null,
      matchConfidence: decision.confidence || '',
      returnedLinkedIn: decision.returnedLinkedIn || null,
      checkedAt: new Date().toISOString(),
    };
  } else {
    const person = decision.person;
    const organization = personOrganization(person);
    record = {
      ...previous,
      noMatch: false,
      ambiguous: false,
      apolloPersonId: String(person.id),
      name: String(person.name || [person.first_name, person.last_name].filter(Boolean).join(' ') || previous.name || '').trim(),
      title: String(person.title || previous.title || '').trim(),
      headline: String(person.headline || previous.headline || '').trim(),
      organization: organization.organization || previous.organization || null,
      organizationName: organization.organizationName || previous.organizationName || '',
      organizationDomain: organization.organizationDomain || previous.organizationDomain || '',
      emailKnown: needEmail ? true : Boolean(previous.emailKnown),
      email: needEmail ? validEmail(person.email) : (previous.email ?? null),
      phoneStatus: needPhone ? 'pending' : (previous.phoneStatus || null),
      phone: needPhone ? null : (previous.phone ?? null),
      matchConfidence: decision.confidence || '',
      returnedLinkedIn: decision.returnedLinkedIn || null,
      checkedAt: new Date().toISOString(),
      phoneRequestedAt: needPhone ? new Date().toISOString() : (previous.phoneRequestedAt || null),
    };
  }

  cache.people[linkedinUrl] = record;
  saveCache(cache);
  return { ok: true, cached: false, linkedinUrl, ...record };
}

async function resolvePersonProfile(input, options = {}) {
  const linkedinUrl = normalizeLinkedIn(input);
  if (!linkedinUrl) return { ok: false, invalidLinkedIn: true, linkedinUrl: null };

  const needEmail = Boolean(options.needEmail);
  const needPhone = Boolean(options.needPhone);
  const cache = readCache();
  const cached = cache.people[linkedinUrl];

  if (!options.force && cached && isFresh(cached) && (cached.noMatch || cached.ambiguous)) {
    return { ok: true, cached: true, linkedinUrl, ...cached };
  }

  const hasIdentity = Boolean(
    cached
    && cached.apolloPersonId
    && cached.name
    && (cached.organizationName || cached.organization?.name)
  );

  if (!options.force && hasIdentity && satisfies(cached, { needEmail, needPhone })) {
    return { ok: true, cached: true, linkedinUrl, ...cached };
  }

  return enrich(linkedinUrl, {
    needEmail,
    needPhone,
    force: Boolean(options.force || !hasIdentity),
  });
}

async function fetchPhoneResults() {
  const url = workerUrl('/results');
  if (!url) return [];
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const error = new Error(data.error || `Apollo webhook results failed (${response.status}).`);
    error.code = 'APOLLO_PHONE_RESULTS_FAILED';
    error.subsystem = 'APOLLO';
    error.errorType = response.status === 429 ? 'RATE_LIMIT' : (response.status >= 500 ? 'API' : 'BAD_REQUEST');
    error.stage = 'apollo-phone-results-read';
    error.status = response.status;
    throw error;
  }
  return Array.isArray(data.results) ? data.results : [];
}

async function consumePhoneResult(apolloPersonId) {
  const url = workerUrl('/results/consume');
  if (!url) return false;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ apollo_person_id: apolloPersonId }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const error = new Error(data.error || `Apollo webhook consume failed (${response.status}).`);
    error.code = 'APOLLO_PHONE_RESULT_CONSUME_FAILED';
    error.subsystem = 'APOLLO';
    error.errorType = response.status === 429 ? 'RATE_LIMIT' : (response.status >= 500 ? 'API' : 'BAD_REQUEST');
    error.stage = 'apollo-phone-result-consume';
    error.status = response.status;
    throw error;
  }
  return true;
}

function recordPhoneResult(apolloPersonId, phone) {
  const id = String(apolloPersonId || '').trim();
  if (!id) return [];
  const cache = readCache();
  const changed = [];
  for (const [linkedinUrl, record] of Object.entries(cache.people)) {
    if (String(record?.apolloPersonId || '') !== id) continue;
    record.phone = validPhone(phone);
    record.phoneStatus = record.phone ? 'found' : 'not_found';
    record.phoneResolvedAt = new Date().toISOString();
    record.checkedAt = new Date().toISOString();
    changed.push(linkedinUrl);
  }
  if (changed.length) saveCache(cache);
  return changed;
}

function status() {
  return {
    apiKeyReady: Boolean(setting('APOLLO_API_KEY')),
    webhookReady: Boolean(setting('APOLLO_WEBHOOK_URL') && setting('APOLLO_WEBHOOK_SECRET')),
    peopleSearchReady: Boolean(setting('APOLLO_API_KEY')),
    companySearchMax: Math.max(1, Math.min(100, numericSetting('ULTRON_M3_APOLLO_COMPANY_SEARCH_MAX', 50))),
    decisionMakerPriority: {
      company: COMPANY_DECISION_PRIORITY.map((tier) => `${tier.priority}. ${tier.label}`),
      people: 'Exact LinkedIn person only -> enrich that person phone/email; never substitute a company contact.',
    },
    cacheFile: CACHE_FILE,
    positiveCacheDays: numericSetting('ULTRON_M3_APOLLO_POSITIVE_CACHE_DAYS', 180),
    negativeCacheDays: numericSetting('ULTRON_M3_APOLLO_NEGATIVE_CACHE_DAYS', 30),
  };
}

module.exports = {
  setting,
  validEmail,
  validPhone,
  normalizeLinkedIn,
  personOrganization,
  matchDecision,
  COMPANY_DECISION_PRIORITY,
  decisionPriority,
  domainBrand,
  organizationNameOf,
  organizationDomainOf,
  organizationNameMatches,
  sameOrganization,
  hydratedIdentityMatchesCandidate,
  searchCandidateFromPerson,
  rankedDecisionMakers,
  searchCompanyDecisionMaker,
  fetchApolloResponse,
  apolloBodyReadError,
  searchCompanyPeopleBroad,
  candidateEmployerContext,
  hydratedEmployerMatchesCandidate,
  resolveDecisionMaker,
  resolvePersonByNameCompany,
  readCache,
  saveCache,
  cacheDays,
  pendingPhoneRequestFresh,
  status,
  enrich,
  resolvePersonProfile,
  fetchPhoneResults,
  consumePhoneResult,
  recordPhoneResult,
};
