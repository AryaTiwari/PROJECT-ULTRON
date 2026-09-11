const fs = require('fs');
const path = require('path');
const googleAuth = require('./google-sheets-auth');
const sheets = require('./google-sheets-operator');
const v2 = require('./lead-workspace-operator-v2');
const linkedinPublic = require('./linkedin-public-research');
const mcp = require('./linkedin-mcp-client');
const joeyism = require('./linkedin-joeyism-bridge');
const policy = require('./linkedin-account-policy');
const config = require('./config');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const STATE_FILE = path.join(config.projectRoot, '.ultron', 'linkedin-account', 'operator-state.json');
const PENDING_TTL_MS = 45 * 60 * 1000;

const COMPANY_HEADERS = ['NAME', 'COMPANY NAME', 'COMPANY LINK', 'NO. OF APPLICANTS', 'PHONE NUMBER', 'EMAIL'];
const PERSON_HEADERS = ['Name', 'Company', 'Role', 'LinkedIn', 'Location', 'Post Details', 'Email', 'Phone No', 'Source', 'Lead Score'];
const INTERNAL_CONTACT_HEADER = '__ULTRON CONTACT LINKEDIN';

function nowIso() {
  return new Date().toISOString();
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { version: 1, pending: null, missions: [] };
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { version: 1, pending: null, missions: [], ...parsed, missions: Array.isArray(parsed.missions) ? parsed.missions : [] };
  } catch {
    return { version: 1, pending: null, missions: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { fs.chmodSync(STATE_FILE, 0o600); } catch {}
}

function isRequest(text) {
  const value = String(text || '').trim();
  if (!/linkedin\.com\/(?:in|company)\//i.test(value) && !/\blinkedin\b/i.test(value)) return false;
  if (/\b(?:status|health|doctor|setup|login|unlock)\b/i.test(value) && !/\b(?:find|get|scrape|research|source|bring|collect|search|list)\b/i.test(value)) return false;
  return /\b(?:find|get|scrape|research|source|bring|collect|search|list|show|extract|companies|company|people|profiles?|recruiters?|founders?|hiring)\b/i.test(value)
    || /linkedin\.com\/(?:in|company)\//i.test(value);
}

function parseCount(text) {
  const value = String(text || '');
  const match = value.match(/\b(?:find|get|bring|research|source|collect|search|list|show|extract)\s+(?:me\s+)?(\d{1,3})\b/i)
    || value.match(/\b(\d{1,3})\s+(?:companies|company|people|profiles?|professionals?|recruiters?|founders?|leads?)\b/i);
  return Math.max(1, Math.min(100, match ? Number(match[1]) : 25));
}

function wantsContacts(text) {
  return /\b(?:email|e-mail|phone|mobile|number|contact info|contact details?)\b/i.test(String(text || ''));
}

function parseEmployeeRange(text) {
  const value = String(text || '');
  const range = value.match(/\b(\d[\d,]*)\s*(?:-|to)\s*(\d[\d,]*)\s+employees?\b/i);
  if (range) return { min: Number(range[1].replace(/,/g, '')), max: Number(range[2].replace(/,/g, '')) };
  const max = value.match(/\b(?:under|below|fewer than|less than|up to|maximum|max)\s*(\d[\d,]*)\s+employees?\b/i);
  const min = value.match(/\b(?:over|above|more than|at least|minimum|min)\s*(\d[\d,]*)\s+employees?\b/i);
  return {
    min: min ? Number(min[1].replace(/,/g, '')) : null,
    max: max ? Number(max[1].replace(/,/g, '')) : null,
  };
}

function parseFilters(text) {
  const value = String(text || '');
  const employeeRange = parseEmployeeRange(value);
  const workType = /\bremote\b/i.test(value) ? 'remote'
    : /\bhybrid\b/i.test(value) ? 'hybrid'
      : /\b(?:on[- ]?site|in[- ]?office)\b/i.test(value) ? 'on_site' : null;
  const jobType = /\bpart[- ]?time\b/i.test(value) ? 'part_time'
    : /\bcontract\b/i.test(value) ? 'contract'
      : /\bintern(?:ship)?\b/i.test(value) ? 'internship'
        : /\bfull[- ]?time\b/i.test(value) ? 'full_time' : null;
  const experienceLevel = /\bentry[- ]?level\b/i.test(value) ? 'entry'
    : /\bassociate\b/i.test(value) ? 'associate'
      : /\bmid[- ]?senior\b/i.test(value) ? 'mid_senior'
        : /\bexecutive\b/i.test(value) ? 'executive' : null;
  const datePosted = /\bpast\s+24\s+hours?\b|\blast\s+24\s+hours?\b/i.test(value) ? 'past_24_hours'
    : /\bpast\s+week\b|\blast\s+week\b/i.test(value) ? 'past_week'
      : /\bpast\s+month\b|\blast\s+month\b/i.test(value) ? 'past_month' : 'past_month';
  return {
    employeeMin: Number.isFinite(employeeRange.min) ? employeeRange.min : null,
    employeeMax: Number.isFinite(employeeRange.max) ? employeeRange.max : null,
    workType,
    jobType,
    experienceLevel,
    datePosted,
    easyApply: /\beasy apply\b/i.test(value),
  };
}

function requestTopic(text, entityMode, location) {
  let value = linkedinPublic.coreTopic(text, entityMode);
  value = value
    .replace(/\b(?:under|below|fewer than|less than|up to|maximum|max|over|above|more than|at least|minimum|min)\s*\d[\d,]*\s+employees?\b/gi, ' ')
    .replace(/\b(?:under|below|fewer than|less than|up to|maximum|max|over|above|more than|at least|minimum|min)\s*\d[\d,]*\b/gi, ' ')
    .replace(/\b\d[\d,]*\s*(?:-|to)\s*\d[\d,]*\s+employees?\b/gi, ' ')
    .replace(/\b(?:remote|hybrid|on[- ]?site|in[- ]?office|easy apply|full[- ]?time|part[- ]?time|contract|internship)\b/gi, ' ')
    .replace(/\b(?:roles?|positions?|should be|must be|located|with|employees?|and)\b/gi, ' ')
    .replace(/[,;]+/g, ' ');
  if (location) value = value.replace(new RegExp(`\\b${String(location).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ');
  return value.replace(/\s+/g, ' ').trim() || (entityMode === 'company' ? 'companies' : 'professionals');
}

function parseRequest(text) {
  const value = String(text || '').trim();
  if (!isRequest(value)) return null;
  const entity = linkedinPublic.normalizeLinkedInEntityUrl(value);
  const entityMode = entity?.type || linkedinPublic.entityModeFromText(value);
  const location = linkedinPublic.locationFromText(value);
  const hiring = /\b(?:hiring|recruiting|jobs?|vacanc(?:y|ies)|openings?|roles?)\b/i.test(value);
  return {
    originalMessage: value,
    count: entity ? 1 : parseCount(value),
    entityMode,
    exactUrl: entity?.url || null,
    exactSlug: entity?.slug || null,
    location,
    hiring,
    topic: requestTopic(value, entityMode, location),
    wantsContacts: entityMode === 'company' || wantsContacts(value),
    filters: parseFilters(value),
    explicitHeaders: v2.headersFromText(value),
    usePrevious: /\b(?:use|same as|like)\b[\s\S]{0,30}\b(?:previous|last)\b|\bprevious format\b|\bsame format\b/i.test(value),
    useDefault: /\b(?:default|standard)\s+(?:format|layout|headers?|columns?)\b/i.test(value),
  };
}

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function headerKey(value) {
  const h = normalizeHeader(value);
  if (/ultron contact linkedin/.test(h)) return 'contactLinkedin';
  if (/^(?:person or company name|name|person|full name)$/.test(h)) return 'name';
  if (/^(?:company|company name|organization|organisation|employer)$/.test(h)) return 'company';
  if (/^(?:role|title|job title|position)$/.test(h)) return 'role';
  if (/linkedin|company link|company url/.test(h)) return 'linkedin';
  if (/^(?:location|city|region|state)$/.test(h)) return 'location';
  if (/^(?:hiring signal|job signal|hiring activity)$/.test(h)) return 'hiring';
  if (/^(?:post details|details|description|profile details|linkedin details|notes)$/.test(h)) return 'details';
  if (/^(?:website|company website|site)$/.test(h)) return 'website';
  if (/phone|mobile|contact number|telephone/.test(h)) return 'phone';
  if (/email|e mail/.test(h)) return 'email';
  if (/applicants?/.test(h)) return 'applicants';
  if (/^(?:source|source url|linkedin source)$/.test(h)) return 'source';
  if (/^(?:lead score|score|quality|relevance)$/.test(h)) return 'score';
  return null;
}

function ensureHeaders(headers, request) {
  const defaults = request.entityMode === 'company' ? COMPANY_HEADERS : PERSON_HEADERS;
  const source = Array.isArray(headers) && headers.length ? headers : defaults;
  const out = source.map((value) => String(value ?? '').trim()).slice(0, 30);
  const keys = new Set(out.map(headerKey).filter(Boolean));
  const needed = request.entityMode === 'company'
    ? [['name', 'NAME'], ['company', 'COMPANY NAME'], ['linkedin', 'COMPANY LINK'], ['applicants', 'NO. OF APPLICANTS'], ['phone', 'PHONE NUMBER'], ['email', 'EMAIL']]
    : [['name', 'Name'], ['company', 'Company'], ['role', 'Role'], ['linkedin', 'LinkedIn'], ['location', 'Location'], ['details', 'Post Details'], ['source', 'Source'], ['score', 'Lead Score']];
  if (request.wantsContacts) {
    needed.push(['email', 'Email'], ['phone', 'Phone No']);
  }
  for (const [key, label] of needed) if (!keys.has(key)) { out.push(label); keys.add(key); }
  return out.slice(0, 30);
}

function pendingRequest() {
  const state = loadState();
  if (!state.pending) return null;
  const age = Date.now() - Date.parse(state.pending.createdAt || 0);
  if (!Number.isFinite(age) || age > PENDING_TTL_MS) {
    state.pending = null;
    saveState(state);
    return null;
  }
  return state.pending;
}

function setPending(request, template) {
  const state = loadState();
  state.pending = {
    ...request,
    suggestedHeaders: template?.headers || (request.entityMode === 'company' ? COMPANY_HEADERS : PERSON_HEADERS),
    suggestedSourceTitle: template?.sourceTitle || null,
    createdAt: nowIso(),
  };
  saveState(state);
  return state.pending;
}

function clearPending() {
  const state = loadState();
  state.pending = null;
  saveState(state);
}

async function prepare(request) {
  if (request.entityMode === 'company' && !request.explicitHeaders?.length && !request.usePrevious) {
    return { type: 'run', request, headers: [...COMPANY_HEADERS] };
  }
  if (request.exactUrl || request.explicitHeaders?.length || request.useDefault || request.usePrevious) {
    let headers = request.explicitHeaders;
    if (!headers && request.usePrevious) {
      const template = v2.latestTemplate();
      headers = template?.headers;
    }
    if (!headers) headers = request.entityMode === 'company' ? COMPANY_HEADERS : PERSON_HEADERS;
    return { type: 'run', request, headers: ensureHeaders(headers, request) };
  }
  const template = v2.latestTemplate();
  const pending = setPending(request, template);
  const previous = template?.headers?.length ? v2.templatePreview(template) : 'none remembered yet';
  const defaults = (request.entityMode === 'company' ? COMPANY_HEADERS : PERSON_HEADERS).join(' | ');
  return {
    type: 'clarification',
    pending,
    text: `This is a dedicated LinkedIn-only mission. I will not use Google Jobs, Maps, TinyFish or SerpApi for discovery. Apollo may enrich only a LinkedIn-verified decision-maker after one-run approval. Previous sheet headings: ${previous}. LinkedIn default: ${defaults}. Use previous format, default format, or send headers: ...`,
  };
}

async function resolvePending(text) {
  const pending = pendingRequest();
  if (!pending) return null;
  const value = String(text || '').trim();
  if (/\b(?:cancel|stop|never mind|nevermind)\b/i.test(value)) {
    clearPending();
    return { type: 'cancelled', text: 'LinkedIn-only mission cancelled before account scraping started.' };
  }
  const custom = v2.headersFromText(value);
  if (custom) {
    clearPending();
    return { type: 'run', request: pending, headers: ensureHeaders(custom, pending) };
  }
  if (/\b(?:previous|last|same|use it|like before)\b/i.test(value)) {
    clearPending();
    return { type: 'run', request: pending, headers: ensureHeaders(pending.suggestedHeaders, pending) };
  }
  if (/\b(?:default|standard|linkedin default)\b/i.test(value)) {
    clearPending();
    const defaults = pending.entityMode === 'company' ? COMPANY_HEADERS : PERSON_HEADERS;
    return { type: 'run', request: pending, headers: ensureHeaders(defaults, pending) };
  }
  if (/\b(?:different|custom|new)\b[\s\S]{0,30}\b(?:format|headers?|columns?|layout)\b/i.test(value)) {
    return { type: 'clarification', pending, text: 'Send the layout as: headers: NAME, COMPANY NAME, COMPANY LINK, NO. OF APPLICANTS, PHONE NUMBER, EMAIL.' };
  }
  return null;
}

function flattenText(value, depth = 0) {
  if (depth > 5 || value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => flattenText(item, depth + 1)).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([key]) => !/cookie|token|password|session/i.test(key))
      .map(([, item]) => flattenText(item, depth + 1))
      .filter(Boolean)
      .join('\n');
  }
  return String(value);
}

function collectReferences(value, out = [], depth = 0) {
  if (depth > 7 || value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, out, depth + 1);
    return out;
  }
  if (typeof value !== 'object') return out;
  const url = String(value.url || value.href || '').trim();
  if (url) out.push({
    url,
    kind: String(value.kind || '').trim(),
    text: String(value.text || value.label || value.title || value.aria_label || '').trim(),
    context: String(value.context || value.heading || value.aria_label || '').trim(),
  });
  for (const [key, item] of Object.entries(value)) {
    if (['url', 'href', 'text', 'label', 'title', 'context'].includes(key)) continue;
    collectReferences(item, out, depth + 1);
  }
  return out;
}

function absoluteLinkedInUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return 'https://www.linkedin.com' + raw;
  return raw;
}

function linkedInReferences(result, entityMode = null) {
  const refs = collectReferences(result);
  const out = [];
  const seen = new Set();
  for (const ref of refs) {
    const normalized = linkedinPublic.normalizeLinkedInEntityUrl(absoluteLinkedInUrl(ref.url), entityMode);
    if (!normalized || seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    out.push({ ...ref, ...normalized });
  }
  const raw = flattenText(result);
  const regex = /https?:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/(?:in|company)\/[a-z0-9%._~-]+\/?/gi;
  for (const match of raw.match(regex) || []) {
    const normalized = linkedinPublic.normalizeLinkedInEntityUrl(match, entityMode);
    if (!normalized || seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    out.push({ url: normalized.url, kind: '', text: '', context: '', ...normalized });
  }
  return out;
}

function jobIdsFromResult(result) {
  const direct = Array.isArray(result?.job_ids) ? result.job_ids : [];
  const text = flattenText(result);
  const fromUrls = [...text.matchAll(/linkedin\.com\/jobs\/view\/(?:[^\d\s/]*-)?(\d{6,})/gi)].map((match) => match[1]);
  return [...new Set([...direct, ...fromUrls].map((value) => String(value || '').match(/\d{6,}/)?.[0]).filter(Boolean))];
}

function emailFromText(text) {
  const match = String(text || '').match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return match?.[0] || '';
}

function phoneFromText(text) {
  const matches = String(text || '').match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || [];
  for (const value of matches) {
    const digits = value.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) return value.replace(/\s+/g, ' ').trim();
  }
  return '';
}

function websiteFromText(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s<>'")]+/gi) || [];
  return matches.find((url) => !/linkedin\.com/i.test(url)) || '';
}

function compactNumber(value) {
  const parsed = Number(String(value || '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function applicantCountFromText(text, company = '') {
  const source = String(text || '');
  const companyKey = String(company || '').trim();
  const index = companyKey ? source.toLowerCase().indexOf(companyKey.toLowerCase()) : -1;
  if (companyKey && index < 0) return '';
  const scoped = companyKey ? source.slice(Math.max(0, index - 350), index + companyKey.length + 900) : source;
  const match = scoped.match(/\b(\d[\d,]*\+?)\s+(?:people\s+clicked\s+apply|applicants?|applications?)\b/i);
  return match?.[1] || '';
}

function employeeCountFromText(text) {
  const source = String(text || '');
  const range = source.match(/\b(\d[\d,]*)\s*(?:-|–|to)\s*(\d[\d,]*)\s+employees?\b/i);
  if (range) return { min: compactNumber(range[1]), max: compactNumber(range[2]), label: `${range[1]}-${range[2]}` };
  const exact = source.match(/\b(?:company size|employees?)\s*[:·-]?\s*(\d[\d,]*)\+?\b/i)
    || source.match(/\b(\d[\d,]*)\+?\s+employees?\b/i);
  if (!exact) return null;
  const count = compactNumber(exact[1]);
  return count == null ? null : { min: count, max: count, label: exact[1] };
}

function passesEmployeeFilter(record, filters = {}) {
  if (filters.employeeMin == null && filters.employeeMax == null) return true;
  const size = record.employeeCount;
  if (!size) return false;
  if (filters.employeeMin != null && Number(size.max) < filters.employeeMin) return false;
  if (filters.employeeMax != null && Number(size.min) > filters.employeeMax) return false;
  return true;
}

function isBudgetStop(error) {
  return /LINKEDIN_(?:BURST|HOURLY|DAILY)_CAP/.test(String(error?.code || ''));
}

function missionCallBudget() {
  const safety = policy.status();
  const maximum = Math.max(0, Math.min(
    safety.missionToolMax,
    safety.burstMax - safety.burstUsed,
    safety.hourlyMax - safety.hourlyUsed,
    safety.dailyMax - safety.dailyUsed,
  ));
  return { maximum, used: 0, stopped: null };
}

async function budgetedCall(budget, tool, args) {
  if (budget.used >= budget.maximum) {
    budget.stopped = budget.stopped || 'mission LinkedIn-call budget reached';
    return null;
  }
  try {
    const result = await mcp.callTool(tool, args);
    budget.used++;
    return result;
  } catch (error) {
    if (isBudgetStop(error)) {
      budget.stopped = error.message;
      return null;
    }
    throw error;
  }
}

function personFromReference(ref, request, tier, priority) {
  const snippet = [ref.text, ref.context].filter(Boolean).join(' · ').trim();
  const parsed = linkedinPublic.parseResult({ title: ref.text || ref.slug, snippet, url: ref.url }, {
    entityMode: 'person', location: request.location,
  });
  if (!parsed) return null;
  return { ...parsed, snippet, decisionTier: tier, decisionPriority: priority };
}

function companyMentioned(person, company) {
  const needle = String(company || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const haystack = `${person.company || ''} ${person.role || ''} ${person.snippet || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  return needle.length >= 3 && haystack.includes(needle);
}

function applyDecisionMaker(record, person) {
  if (!person || (record.decisionPriority != null && record.decisionPriority <= person.decisionPriority)) return;
  record.name = person.name || '';
  record.role = person.role || '';
  record.contactLinkedin = person.linkedin || '';
  record.decisionTier = person.decisionTier;
  record.decisionPriority = person.decisionPriority;
}

async function discoverDecisionMakers(records, request, budget) {
  const tiers = [
    { tier: 'director/founder', priority: 1, keywords: 'founder co-founder owner director managing director' },
    { tier: 'head recruiter/manager', priority: 2, keywords: 'head recruiter hiring manager talent acquisition manager recruitment manager' },
    { tier: 'HR recruiter', priority: 3, keywords: 'HR recruiter human resources recruiter' },
  ];
  const companyHints = records.slice(0, 6).map((record) => `"${record.company}"`).filter((value) => value !== '""').join(' OR ');
  for (const tier of tiers.slice(0, policy.settings().decisionMakerSearchMax)) {
    const result = await budgetedCall(budget, 'search_people', {
      keywords: `${tier.keywords} ${companyHints}`.trim().slice(0, 480),
      location: request.location || undefined,
    });
    if (!result) break;
    for (const ref of linkedInReferences(result, 'person')) {
      const person = personFromReference(ref, request, tier.tier, tier.priority);
      if (!person) continue;
      for (const record of records) if (companyMentioned(person, record.company)) applyDecisionMaker(record, person);
    }
  }

  let fallbackUsed = 0;
  const fallbackMax = request.filters?.employeeMin != null || request.filters?.employeeMax != null
    ? 0 : policy.settings().companyEmployeeFallbackMax;
  for (const record of records.filter((item) => !item.contactLinkedin)) {
    if (fallbackUsed >= fallbackMax || budget.used >= budget.maximum) break;
    const slug = linkedinPublic.normalizeLinkedInEntityUrl(record.linkedin, 'company')?.slug;
    if (!slug) continue;
    const result = await budgetedCall(budget, 'get_company_employees', {
      company_name: slug,
      keywords: 'founder director owner recruiter hiring manager talent acquisition HR',
    });
    fallbackUsed++;
    if (!result) break;
    const people = linkedInReferences(result, 'person')
      .map((ref) => personFromReference(ref, request, 'company employee decision-maker', 2))
      .filter(Boolean)
      .sort((a, b) => {
        const score = (person) => /founder|co-founder|owner|managing director|\bdirector\b/i.test(`${person.role} ${person.snippet}`) ? 1
          : /head|manager|talent acquisition/i.test(`${person.role} ${person.snippet}`) ? 2 : 3;
        return score(a) - score(b);
      });
    if (people[0]) applyDecisionMaker(record, people[0]);
  }
}

function referenceRecord(ref, request) {
  const snippet = [ref.text, ref.context].filter(Boolean).join(' · ').trim();
  if (request.entityMode === 'company') {
    const parsed = linkedinPublic.parseResult({
      title: ref.text || ref.slug,
      snippet,
      url: ref.url,
    }, { entityMode: 'company', location: request.location });
    return parsed ? { ...parsed, name: '', company: parsed.company || parsed.name || '', source: parsed.linkedin, sourceEvidence: ['linkedin-account-search'] } : null;
  }
  const parsed = linkedinPublic.parseResult({
    title: ref.text || ref.slug,
    snippet,
    url: ref.url,
  }, { entityMode: 'person', location: request.location });
  return parsed ? { ...parsed, source: parsed.linkedin, sourceEvidence: ['linkedin-account-search'] } : null;
}

function qualityScore(record, request, evidence = {}) {
  let score = 45;
  const text = `${record.name || ''} ${record.company || ''} ${record.role || ''} ${record.snippet || ''}`.toLowerCase();
  const tokens = String(request.topic || '').toLowerCase().split(/\s+/).filter((x) => x.length >= 3);
  score += Math.min(25, tokens.filter((token) => text.includes(token)).length * 7);
  if (request.location && text.includes(request.location.toLowerCase())) score += 12;
  if (evidence.hiring) score += 20;
  if (evidence.deep) score += 8;
  return Math.max(0, Math.min(100, score));
}

function dedupeRecords(records, mode) {
  const seen = new Set();
  const names = new Set();
  const out = [];
  for (const record of records || []) {
    const normalized = linkedinPublic.normalizeLinkedInEntityUrl(record?.linkedin, mode);
    if (!normalized || seen.has(normalized.url)) continue;
    const secondary = String(record.company || record.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (secondary && names.has(secondary)) continue;
    seen.add(normalized.url);
    if (secondary) names.add(secondary);
    out.push({ ...record, linkedin: normalized.url });
  }
  return out;
}

function searchKeyword(request) {
  const topic = String(request.topic || '').trim();
  return topic && !/^(?:companies|professionals)$/i.test(topic) ? topic : (request.entityMode === 'company' ? 'technology' : 'professional');
}

async function callPrimaryWithExactFallback(tool, args, fallback = null) {
  try {
    return await mcp.callTool(tool, args);
  } catch (error) {
    const eligible = fallback && joeyism.enabled()
      && /LINKEDIN_MCP_|auth|session|browser|profile/i.test(`${error.code || ''} ${error.message || ''}`);
    if (!eligible) throw error;
    return joeyism.call(fallback.action, fallback.args);
  }
}

async function companyMission(request) {
  const keyword = searchKeyword(request);
  const records = [];
  const budget = missionCallBudget();
  if (budget.maximum < 1) {
    const error = new Error('No LinkedIn account calls remain in the current short-window/hourly/daily safety budget. Wait for the displayed safety window before starting another mission.');
    error.code = 'LINKEDIN_BURST_CAP';
    throw error;
  }
  let jobsResult = null;
  let jobDetails = 0;
  let companySearches = [];

  if (request.hiring) {
    jobsResult = await budgetedCall(budget, 'search_jobs', {
      keywords: keyword,
      location: request.location || undefined,
      max_pages: policy.settings().maxJobPages,
      date_posted: request.filters?.datePosted || 'past_month',
      job_type: request.filters?.jobType || undefined,
      experience_level: request.filters?.experienceLevel || undefined,
      work_type: request.filters?.workType || undefined,
      easy_apply: Boolean(request.filters?.easyApply),
      sort_by: 'date',
    });
    for (const ref of linkedInReferences(jobsResult || {}, 'company')) {
      const record = referenceRecord(ref, request);
      if (record) {
        record.hiringSignal = [ref.text, ref.context].filter(Boolean).join(' · ').slice(0, 700) || 'Company appeared in LinkedIn job-search evidence.';
        record.hiringVerified = true;
        record.applicants = applicantCountFromText(flattenText(jobsResult), record.company);
        record.employeeCount = employeeCountFromText(record.snippet);
        record.relevanceScore = qualityScore(record, request, { hiring: true });
        records.push(record);
      }
    }
    const needsEmployeeVerification = request.filters?.employeeMin != null || request.filters?.employeeMax != null;
    if (!needsEmployeeVerification) {
      for (const jobId of jobIdsFromResult(jobsResult).slice(0, policy.settings().jobDetailMax)) {
        const detail = await budgetedCall(budget, 'get_job_details', { job_id: jobId });
        if (!detail) break;
        jobDetails++;
        const detailText = flattenText(detail);
        for (const ref of linkedInReferences(detail, 'company')) {
          const record = referenceRecord(ref, request);
          if (!record) continue;
          record.hiringSignal = detailText.slice(0, 700) || `Verified LinkedIn job ${jobId}.`;
          record.hiringVerified = true;
          record.applicants = applicantCountFromText(detailText, record.company);
          record.employeeCount = employeeCountFromText(record.snippet);
          record.relevanceScore = qualityScore(record, request, { hiring: true, deep: true });
          records.push(record);
        }
      }
    }
  }

  const searches = [
    keyword,
    request.location ? `${keyword} ${request.location}` : '',
  ].filter(Boolean);
  for (const query of [...new Set(searches)].slice(0, 1)) {
    const result = await budgetedCall(budget, 'search_companies', { keywords: query });
    if (!result) break;
    companySearches.push(result);
    const jobsText = flattenText(jobsResult).toLowerCase();
    for (const ref of linkedInReferences(result, 'company')) {
      const record = referenceRecord(ref, request);
      if (!record) continue;
      const companyKey = String(record.company || record.name || '').toLowerCase();
      const hiringEvidence = Boolean(request.hiring && companyKey && jobsText.includes(companyKey));
      record.hiringSignal = hiringEvidence ? 'Company also appears in LinkedIn Jobs results for this mission.' : record.hiringSignal || '';
      record.hiringVerified = Boolean(record.hiringVerified || hiringEvidence);
      record.applicants = applicantCountFromText(flattenText(jobsResult), record.company);
      record.employeeCount = employeeCountFromText(record.snippet);
      record.relevanceScore = qualityScore(record, request, { hiring: record.hiringVerified });
      records.push(record);
    }
  }

  let merged = dedupeRecords(records, 'company')
    .sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0));

  await discoverDecisionMakers(merged.slice(0, request.count), request, budget);

  const deepMax = Math.min(policy.settings().deepProfilesPerMission, merged.length, request.count, Math.max(0, budget.maximum - budget.used));
  let deepProfiles = 0;
  for (let index = 0; index < deepMax; index++) {
    const record = merged[index];
    const slug = linkedinPublic.normalizeLinkedInEntityUrl(record.linkedin, 'company')?.slug;
    if (!slug) continue;
    try {
      const deep = await budgetedCall(budget, 'get_company_profile', {
        company_name: slug,
        sections: request.hiring ? 'jobs' : undefined,
      });
      if (!deep) break;
      deepProfiles++;
      const text = flattenText(deep);
      record.snippet = [record.snippet, text.slice(0, 3500)].filter(Boolean).join('\n').slice(0, 5000);
      record.website = websiteFromText(text);
      record.email = request.wantsContacts ? emailFromText(text) : '';
      record.phone = request.wantsContacts ? phoneFromText(text) : '';
      record.employeeCount = employeeCountFromText(text) || record.employeeCount || null;
      record.applicants = record.applicants || applicantCountFromText(text, record.company);
      const hiringDeep = request.hiring && /\b(?:hiring|jobs?|vacanc(?:y|ies)|openings?)\b/i.test(text)
        && String(text).toLowerCase().includes(keyword.toLowerCase().split(/\s+/)[0] || keyword.toLowerCase());
      if (hiringDeep) {
        record.hiringSignal = `LinkedIn company jobs section contains current ${keyword} hiring evidence.`;
        record.hiringVerified = true;
      }
      record.relevanceScore = qualityScore(record, request, { hiring: Boolean(record.hiringVerified), deep: true });
      record.sourceEvidence = [...new Set([...(record.sourceEvidence || []), 'linkedin-account-company-profile'])];
    } catch (error) {
      if (error.code === 'LINKEDIN_COOLDOWN_ACTIVE' || error.code === 'LINKEDIN_MANUAL_LOCK') throw error;
      record.deepError = error.message;
    }
  }

  merged = merged
    .filter((record) => Number(record.relevanceScore || 0) >= 50)
    .filter((record) => !request.hiring || Boolean(record.hiringVerified))
    .filter((record) => passesEmployeeFilter(record, request.filters))
    .sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0))
    .slice(0, request.count);

  return {
    records: merged,
    toolCalls: {
      searchJobs: jobsResult ? 1 : 0,
      jobDetails,
      searchCompanies: companySearches.length,
      deepCompanyProfiles: deepProfiles,
      total: budget.used,
      maximum: budget.maximum,
    },
    budgetStopped: budget.stopped,
    filters: request.filters,
  };
}

async function personMission(request) {
  const keyword = searchKeyword(request);
  const results = [];
  const queries = [keyword];
  if (request.hiring && !/recruit|talent|hr/i.test(keyword)) queries.push(`${keyword} recruiter`);

  for (const query of [...new Set(queries)].slice(0, 2)) {
    const search = await mcp.callTool('search_people', {
      keywords: query,
      location: request.location || undefined,
    });
    for (const ref of linkedInReferences(search, 'person')) {
      const record = referenceRecord(ref, request);
      if (!record) continue;
      record.relevanceScore = qualityScore(record, request);
      results.push(record);
    }
  }

  let merged = dedupeRecords(results, 'person')
    .sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0));

  const deepMax = Math.min(policy.settings().deepProfilesPerMission, merged.length, request.count);
  for (let index = 0; index < deepMax; index++) {
    const record = merged[index];
    const slug = linkedinPublic.normalizeLinkedInEntityUrl(record.linkedin, 'person')?.slug;
    if (!slug) continue;
    try {
      const deep = await mcp.callTool('get_person_profile', {
        linkedin_username: slug,
        sections: request.wantsContacts ? 'experience,contact_info' : 'experience',
        max_scrolls: 5,
      });
      const text = flattenText(deep);
      record.snippet = [record.snippet, text.slice(0, 3500)].filter(Boolean).join('\n').slice(0, 5000);
      if (request.wantsContacts) {
        record.email = emailFromText(text);
        record.phone = phoneFromText(text);
      }
      record.relevanceScore = qualityScore(record, request, { deep: true });
      record.sourceEvidence = [...new Set([...(record.sourceEvidence || []), 'linkedin-account-person-profile'])];
    } catch (error) {
      if (error.code === 'LINKEDIN_COOLDOWN_ACTIVE' || error.code === 'LINKEDIN_MANUAL_LOCK') throw error;
      record.deepError = error.message;
    }
  }

  merged = merged
    .filter((record) => Number(record.relevanceScore || 0) >= 45)
    .sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0))
    .slice(0, request.count);

  return {
    records: merged,
    toolCalls: { searchPeople: Math.min(2, queries.length), deepPersonProfiles: deepMax },
  };
}

async function exactMission(request) {
  if (request.entityMode === 'company') {
    const deep = await callPrimaryWithExactFallback('get_company_profile', {
      company_name: request.exactSlug,
      sections: request.hiring ? 'posts,jobs' : 'posts',
    }, { action: 'company', args: { url: request.exactUrl } });
    const text = flattenText(deep);
    const company = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line && line.length < 120) || request.exactSlug;
    return {
      records: [{
        entityType: 'company',
        name: company,
        company,
        linkedin: request.exactUrl,
        location: request.location,
        hiringSignal: request.hiring && /\b(?:hiring|jobs?|vacanc(?:y|ies)|openings?)\b/i.test(text) ? 'Hiring evidence found in LinkedIn company content.' : '',
        snippet: text.slice(0, 5000),
        website: websiteFromText(text),
        email: request.wantsContacts ? emailFromText(text) : '',
        phone: request.wantsContacts ? phoneFromText(text) : '',
        source: request.exactUrl,
        relevanceScore: 90,
        sourceEvidence: ['linkedin-account-company-profile'],
      }],
      toolCalls: { deepCompanyProfiles: 1 },
    };
  }
  const deep = await callPrimaryWithExactFallback('get_person_profile', {
    linkedin_username: request.exactSlug,
    sections: request.wantsContacts ? 'experience,education,contact_info' : 'experience,education',
    max_scrolls: 5,
  }, { action: 'person', args: { url: request.exactUrl } });
  const text = flattenText(deep);
  const first = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line && line.length < 120) || request.exactSlug;
  return {
    records: [{
      entityType: 'person',
      name: first,
      company: '',
      role: '',
      linkedin: request.exactUrl,
      location: request.location,
      snippet: text.slice(0, 5000),
      email: request.wantsContacts ? emailFromText(text) : '',
      phone: request.wantsContacts ? phoneFromText(text) : '',
      source: request.exactUrl,
      relevanceScore: 90,
      sourceEvidence: ['linkedin-account-person-profile'],
    }],
    toolCalls: { deepPersonProfiles: 1 },
  };
}

async function apiRequest(url, options = {}) {
  const token = await googleAuth.accessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) throw new Error(data?.error?.message || `Google Sheets API failed (${response.status}).`);
  return data;
}

async function appendRows(spreadsheetId, sheetName, rows) {
  if (!rows.length) return 0;
  const full = `${sheets.quoteSheet(sheetName)}!A:ZZ`;
  const result = await apiRequest(`${API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(full)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
  });
  return Number(result?.updates?.updatedRows || rows.length);
}

async function hideInternalContactColumn(spreadsheetId, sheetId, columnIndex) {
  if (!Number.isInteger(sheetId) || !Number.isInteger(columnIndex)) return false;
  await apiRequest(`${API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: columnIndex, endIndex: columnIndex + 1 },
        properties: { hiddenByUser: true },
        fields: 'hiddenByUser',
      },
    }] }),
  });
  return true;
}

function rowFor(record, headers) {
  return headers.map((header) => {
    const key = headerKey(header);
    if (key === 'name') return record.name || '';
    if (key === 'company') return record.company || '';
    if (key === 'role') return record.role || '';
    if (key === 'linkedin') return record.linkedin || '';
    if (key === 'contactLinkedin') return record.contactLinkedin || '';
    if (key === 'location') return record.location || '';
    if (key === 'hiring') return record.hiringSignal || '';
    if (key === 'details') return record.snippet || '';
    if (key === 'website') return record.website || '';
    if (key === 'phone') return record.phone || '';
    if (key === 'email') return record.email || '';
    if (key === 'applicants') return record.applicants || '';
    if (key === 'source') return record.source || record.linkedin || '';
    if (key === 'score') return record.relevanceScore ?? '';
    return '';
  });
}

async function run(request, headers) {
  const mission = {
    id: `linkedin-account-${Date.now()}`,
    createdAt: nowIso(),
    status: 'running',
    request: { ...request, explicitHeaders: undefined },
    headers,
    linkedinOnly: true,
    primaryBackend: 'stickerdaniel/linkedin-mcp-server',
    fallbackBackend: joeyism.enabled() ? 'joeyism/linkedin_scraper (exact URL fallback only)' : 'disabled',
  };
  const state = loadState();
  state.pending = null;
  state.missions.push(mission);
  saveState(state);

  try {
    const researched = request.exactUrl
      ? await exactMission(request)
      : request.entityMode === 'company'
        ? await companyMission(request)
        : await personMission(request);

    const title = `ULTRON LinkedIn - ${String(request.topic || request.entityMode).replace(/[^a-z0-9 ()&+._-]+/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 65)} - ${new Date().toISOString().slice(0, 10)}`;
    const needsInternalContact = request.entityMode === 'company' && request.wantsContacts;
    const storageHeaders = needsInternalContact ? [...headers, INTERNAL_CONTACT_HEADER] : headers;
    const created = await v2.createSpreadsheet(title, storageHeaders, request.count);
    const rows = researched.records.map((record) => rowFor(record, storageHeaders));
    const added = await appendRows(created.spreadsheetId, created.sheetName, rows);
    if (needsInternalContact) {
      try { await hideInternalContactColumn(created.spreadsheetId, created.sheetId, storageHeaders.length - 1); } catch {}
    }

    mission.status = 'completed';
    mission.completedAt = nowIso();
    mission.sheetUrl = created.url;
    mission.sheetName = created.sheetName;
    mission.spreadsheetTitle = created.title;
    mission.requested = request.count;
    mission.found = researched.records.length;
    mission.added = added;
    mission.toolCalls = researched.toolCalls;
    mission.averageScore = researched.records.length
      ? Math.round(researched.records.reduce((sum, record) => sum + Number(record.relevanceScore || 0), 0) / researched.records.length)
      : 0;
    mission.contactsFromLinkedIn = {
      emails: researched.records.filter((record) => record.email).length,
      phones: researched.records.filter((record) => record.phone).length,
    };
    mission.contactCandidates = researched.records.filter((record) => record.contactLinkedin).length;
    mission.missingContacts = researched.records.filter((record) => record.contactLinkedin && (!record.email || !record.phone)).length;
    mission.internalContactColumnHidden = needsInternalContact;
    mission.budgetStopped = researched.budgetStopped || null;
    mission.filters = researched.filters || request.filters || {};
    mission.safety = policy.status();

    const latest = loadState();
    const target = latest.missions.find((item) => item.id === mission.id);
    if (target) Object.assign(target, mission);
    latest.pending = null;
    saveState(latest);
    v2.rememberTemplate(headers, { sourceTitle: created.title, sourceUrl: created.url, provider: 'linkedin-account' });
    return mission;
  } catch (error) {
    mission.status = 'failed';
    mission.lastError = error.message;
    mission.updatedAt = nowIso();
    const latest = loadState();
    const target = latest.missions.find((item) => item.id === mission.id);
    if (target) Object.assign(target, mission);
    saveState(latest);
    throw error;
  }
}

function latestMission() {
  return [...loadState().missions].reverse()[0] || null;
}

function status() {
  return {
    readyForRouting: true,
    stateFile: STATE_FILE,
    mcp: mcp.status(),
    joeyism: joeyism.status(),
    safety: policy.status(),
    pending: Boolean(pendingRequest()),
    latestMission: latestMission(),
    linkedinOnlyResearch: true,
    externalSourceFusionDisabledForExplicitLinkedIn: true,
  };
}

function statusText() {
  const s = status();
  const safety = s.safety;
  const lock = safety.manualLock ? ` LOCKED: ${safety.manualLock.reason}` : safety.cooldownUntil ? ` Cooldown until ${safety.cooldownUntil}.` : '';
  return `LinkedIn Account Research: dedicated LinkedIn-only routing is ready. Primary backend: stickerdaniel/linkedin-mcp-server through loopback-only MCP; optional joeyism fallback ${s.joeyism.enabled ? (s.joeyism.sessionReady ? 'enabled and session-ready' : 'enabled but needs manual session setup') : 'disabled'}. Usage: ${safety.hourlyUsed}/${safety.hourlyMax} this hour, ${safety.dailyUsed}/${safety.dailyMax} today. Minimum call gap ${Math.round(safety.minGapMs / 1000)}s, deep-profile cap ${safety.deepProfilesPerMission}/mission. LinkedIn write actions are disabled.${lock}`;
}

function formatMission(mission) {
  const shortfall = mission.found < mission.requested ? ` I found ${mission.found}/${mission.requested} high-confidence LinkedIn records within the account-safety budget.` : '';
  const contact = mission.contactCandidates ? ` LinkedIn identified ${mission.contactCandidates} prioritized decision-maker profiles for Apollo contact enrichment.` : ' No verified decision-maker profile was found within this run’s LinkedIn-call budget.';
  const budget = mission.budgetStopped ? ` Safety stop: ${mission.budgetStopped}.` : '';
  return `LinkedIn-only mission complete, Sir. Added ${mission.added} records to “${mission.spreadsheetTitle}”. Discovery and filter verification used only the authenticated LinkedIn account tool; Google Jobs, Maps, TinyFish, public-index SerpApi and Apollo were not used for discovery. Average quality score ${mission.averageScore}/100.${contact}${shortfall}${budget} ${mission.sheetUrl}`;
}

module.exports = {
  COMPANY_HEADERS,
  PERSON_HEADERS,
  INTERNAL_CONTACT_HEADER,
  isRequest,
  parseCount,
  parseRequest,
  parseEmployeeRange,
  parseFilters,
  requestTopic,
  headerKey,
  ensureHeaders,
  pendingRequest,
  prepare,
  resolvePending,
  flattenText,
  collectReferences,
  linkedInReferences,
  jobIdsFromResult,
  qualityScore,
  applicantCountFromText,
  employeeCountFromText,
  passesEmployeeFilter,
  dedupeRecords,
  companyMission,
  personMission,
  exactMission,
  rowFor,
  run,
  latestMission,
  status,
  statusText,
  formatMission,
};
