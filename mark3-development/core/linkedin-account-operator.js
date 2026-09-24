const fs = require('fs');
const path = require('path');
const googleAuth = require('./google-sheets-auth');
const sheets = require('./google-sheets-operator');
const v2 = require('./lead-workspace-operator-v2');
const linkedinPublic = require('./linkedin-public-research');
const mcp = require('./linkedin-mcp-client');
const joeyism = require('./linkedin-joeyism-bridge');
const policy = require('./linkedin-account-policy');
const apollo = require('./apollo-enrichment');
const config = require('./config');
const missionRunner = require('./linkedin-mission-runner');
const finalMaster = require('./linkedin-final-master');
const sheetProgress = require('./linkedin-sheet-progress');
const missionContract = require('./linkedin-mission-contract');
const queryStrategist = require('./linkedin-query-strategist');
const leadIntent = require('./linkedin-lead-intent');
const locationExpander = require('./linkedin-location-expander');
const sheetSchema = require('./linkedin-sheet-schema-resolver');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const STATE_FILE = path.join(config.projectRoot, '.ultron', 'linkedin-account', 'operator-state.json');
const PENDING_TTL_MS = 45 * 60 * 1000;

const COMPANY_HEADERS = ['NAME', 'COMPANY NAME', 'COMPANY LINK', 'NO. OF APPLICANTS', 'PHONE NUMBER', 'EMAIL', 'REMARKS'];
const LEAD_DISCOVERY_HEADERS = ['COMPANY NAME', 'COMPANY LINK', 'LOCATION', 'JOB TITLE', 'JOB LINK', 'POSTED', 'WORKPLACE TYPE', 'NO. OF APPLICANTS', 'COMPANY SIZE', 'REMARKS'];
const PERSON_HEADERS = ['Name', 'Company', 'Role', 'LinkedIn', 'Location', 'Post Details', 'Email', 'Phone No', 'Source', 'Lead Score'];
const INTERNAL_CONTACT_HEADER = '__ULTRON CONTACT LINKEDIN';
const APOLLO_SECTION_HEADERS = ['APOLLO CONTACT', 'APOLLO ROLE', 'APOLLO LINKEDIN', 'APOLLO PHONE', 'APOLLO EMAIL', 'APOLLO STATUS'];

function defaultHeadersFor(request = {}) {
  if (request.entityMode !== 'company') return PERSON_HEADERS;
  return request.wantsContacts ? COMPANY_HEADERS : LEAD_DISCOVERY_HEADERS;
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: 2,
    pending: null,
    missions: [],
    workspace: {
      sheetUrl: null,
      sheetName: null,
      spreadsheetTitle: null,
      entityMode: null,
      updatedAt: null,
    },
  };
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return defaultState();
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const base = defaultState();
    return {
      ...base,
      ...parsed,
      missions: Array.isArray(parsed.missions) ? parsed.missions : [],
      workspace: { ...base.workspace, ...(parsed.workspace || {}) },
    };
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { fs.chmodSync(STATE_FILE, 0o600); } catch {}
}

function latestCompletedMission(state = loadState()) {
  return [...(state.missions || [])].reverse().find((mission) => mission?.status === 'completed') || null;
}

function workspaceSheetUrl(state = loadState()) {
  const direct = String(state?.workspace?.sheetUrl || '').trim();
  if (direct) return direct;
  return String(latestCompletedMission(state)?.sheetUrl || '').trim() || null;
}

function rememberWorkspaceSheet(sheetUrl, metadata = {}, state = null) {
  const target = state || loadState();
  if (!sheetUrl) return target.workspace || null;
  target.workspace = {
    sheetUrl: String(sheetUrl),
    sheetName: metadata.sheetName || target.workspace?.sheetName || null,
    spreadsheetTitle: metadata.spreadsheetTitle || target.workspace?.spreadsheetTitle || null,
    entityMode: metadata.entityMode || target.workspace?.entityMode || null,
    updatedAt: nowIso(),
  };
  if (!state) saveState(target);
  return target.workspace;
}

function isRequest(text) {
  const value = String(text || '').trim();
  if (!/linkedin\.com\/(?:in|company)\//i.test(value) && !/\blinkedin\b/i.test(value) && !leadIntent.isDiscoveryRequest(value)) return false;
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

function parseExplicitCount(text) {
  const value = String(text || '');
  const match = value.match(/\b(?:find|get|bring|research|source|collect|search|list|show|extract|continue|add|append)\s+(?:me\s+)?(\d{1,3})\b/i)
    || value.match(/\b(\d{1,3})\s+(?:more\s+)?(?:companies|company|people|profiles?|professionals?|recruiters?|founders?|leads?|results?)\b/i)
    || value.match(/\b(?:until|to)\s+(\d{1,3})\b/i);
  return match ? Math.max(1, Math.min(100, Number(match[1]))) : null;
}

function wantsContacts(text) {
  return /\b(?:email|e-mail|phone|mobile|number|contact info|contact details?)\b/i.test(String(text || ''));
}

function compactEmployeeNumber(value) {
  const match = String(value || '').trim().match(/^(\d[\d,]*(?:\.\d+)?)\s*([km])?$/i);
  if (!match) return null;
  const base = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const multiplier = /^k$/i.test(match[2] || '') ? 1000 : /^m$/i.test(match[2] || '') ? 1000000 : 1;
  return Math.round(base * multiplier);
}

function parseEmployeeRange(text) {
  const value = String(text || '');
  const number = '(\\d[\\d,]*(?:\\.\\d+)?\\s*[kKmM]?)';
  const range = value.match(new RegExp('\\b' + number + '\\s*(?:-|to)\\s*' + number + '\\s+employees?\\b', 'i'));
  if (range) return { min: compactEmployeeNumber(range[1]), max: compactEmployeeNumber(range[2]) };
  const upper = '(?:under|below|fewer than|less than|up to|maximum|max)';
  const lower = '(?:over|above|more than|at least|minimum|min)';
  const employeePrefix = '(?:employees?|employee\\s+count|company\\s+(?:size|headcount))(?:\\s+(?:should|must|needs?\s+to)\s+be|\\s+are)?';
  const max = value.match(new RegExp('\\b' + upper + '\\s*' + number + '(?:\\s+employees?)?\\b', 'i'))
    || value.match(new RegExp('\\b' + employeePrefix + '\\s*' + upper + '\\s*' + number + '\\b', 'i'));
  const min = value.match(new RegExp('\\b' + lower + '\\s*' + number + '(?:\\s+employees?)?\\b', 'i'))
    || value.match(new RegExp('\\b' + employeePrefix + '\\s*' + lower + '\\s*' + number + '\\b', 'i'));
  return {
    min: min ? compactEmployeeNumber(min[1]) : null,
    max: max ? compactEmployeeNumber(max[1]) : null,
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
  const compiled = leadIntent.compile(value);
  const datePosted = compiled.postingAge?.linkedinPreset || null;
  return {
    employeeMin: Number.isFinite(employeeRange.min) ? employeeRange.min : null,
    employeeMax: Number.isFinite(employeeRange.max) ? employeeRange.max : null,
    workType: compiled.workplaceTypes.length > 1 || compiled.preferredWorkplaceTypes.length ? null : workType,
    jobType,
    experienceLevel,
    datePosted,
    postingAge: compiled.postingAge,
    postingAgeDays: compiled.postingAge?.maxAgeDays ?? null,
    workplaceTypes: compiled.workplaceTypes,
    preferredWorkplaceTypes: compiled.preferredWorkplaceTypes,
    applicantMax: compiled.applicantMax,
    lowCompetition: compiled.lowCompetition,
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
    .replace(/\b(?:posted\s+)?(?:today|yesterday|this\s+month|past|last)\s+(?:\d+\s+)?(?:hours?|days?|weeks?|months?|week|month|24\s+hours?)\b/gi, ' ')
    .replace(/\bwithin\s+\d+(?:\.\d+)?\s*(?:km|kilomet(?:er|re)s?|mi|miles?)(?:\s+of)?\b/gi, ' ')
    .replace(/\b(?:under|below|fewer\s+than|less\s+than|maximum|max|up\s+to)\s+\d[\d,]*\s+(?:applicants?|applications?)\b/gi, ' ')
    .replace(/\b(?:remote|hybrid|on[- ]?site)\s+(?:preferred|only)\b/gi, ' ')
    .replace(/\b(?:roles?|positions?|should be|must be|located|location|with|employees?|and|from|in|at|near|around)\b/gi, ' ')
    .replace(/[.,;:!?()[\]{}]+/g, ' ');
  if (location) {
    value = value.replace(
      new RegExp(`\\b${String(location).replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')}\\b`, 'gi'),
      ' ',
    );
  }
  value = value.replace(/\s+/g, ' ').trim();

  // Generic SAP requests must canonicalize to "SAP". Preserve a module only
  // when the user explicitly named one, e.g. SAP FICO or SAP ABAP.
  if (/\bsap\b/i.test(value)) {
    const module = value.match(/\bsap\s+(fico|mm|sd|abap|basis|s\/?4hana|successfactors|hana|bw|bpc|ariba|ewm|tm)\b/i);
    if (!module) return 'SAP';
    const raw = module[1];
    return /^s\/?4hana$/i.test(raw) ? 'SAP S/4HANA' : `SAP ${raw.toUpperCase()}`;
  }

  return value || (entityMode === 'company' ? 'companies' : 'professionals');
}


function hiringIntentFromText(text, filters = {}) {
  const value = String(text || '').trim();
  if (!value) return false;

  if (/\b(?:hiring|recruiting|jobs?|vacanc(?:y|ies)|openings?|roles?|positions?|careers?)\b/i.test(value)) return true;

  // Explicit company-attribute language should stay a company search even
  // when words such as "remote" appear.
  const explicitCompanyAttribute = /\b(?:companies?|employers?)\b[\s\S]{0,55}\b(?:based|headquartered|hq|located|remote[- ]?first|distributed|fully\s+remote\s+company|uses?|using|implements?|runs?|partners?\s+with)\b/i.test(value)
    || /\b(?:remote[- ]?first|distributed|fully\s+remote)\b[\s\S]{0,55}\b(?:companies?|employers?|firms?|organizations?|organisations?)\b/i.test(value)
    || /\b(?:headquarters?|hq|company\s+location|company\s+headcount)\b/i.test(value);
  if (explicitCompanyAttribute) return false;

  const companyTarget = /\b(?:companies?|company|employers?|firms?|organizations?|organisations?)\b/i.test(value);
  if (!companyTarget) return false;

  // These are job-level filters in LinkedIn. If a user applies them to
  // companies plus a non-empty skill/topic, they almost certainly mean
  // companies with matching openings, even if they omit "jobs".
  const jobLevelConstraint = Boolean(
    filters.workType
    || filters.jobType
    || filters.experienceLevel
    || filters.datePosted
    || filters.easyApply
  );
  if (!jobLevelConstraint) return false;

  const stripped = value
    .replace(/\b(?:find|get|bring|research|source|collect|search|list|show|extract)\b/gi, ' ')
    .replace(/\b\d{1,3}\b/g, ' ')
    .replace(/\b(?:companies?|company|employers?|firms?|organizations?|organisations?|linkedin|remote|hybrid|on[- ]?site|in[- ]?office|full[- ]?time|part[- ]?time|contract|internship|entry[- ]?level|associate|mid[- ]?senior|executive|easy\s+apply|under|below|over|above|employees?|employee|in|from|at|near|around|and|the|my|master|sheet|spreadsheet)\b/gi, ' ')
    .replace(/\d[\d,]*/g, ' ')
    .replace(/[.,;:!?()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return stripped.length >= 2;
}

function locationScopeFromText(text, hiring = false) {
  const value = String(text || '');
  const explicitJobGeography = /\b(?:jobs?|roles?|openings?|vacancies|positions?)\b[\s\S]{0,35}\bin\s+india\b/i.test(value);
  const explicitIndiaCompany = /\b(?:indian|india[-\s]?based)\s+companies?\b/i.test(value)
    || /\bcompanies?\s+(?:based\s+)?(?:in|from)\s+india\b/i.test(value)
    || /\bcompanies?\s+on\s+linkedin\s+(?:based\s+)?(?:in|from)\s+india\b/i.test(value);
  if ((explicitIndiaCompany && !explicitJobGeography)
      || /\bcompanies?\b[\s\S]{0,45}\b(?:that\s+are\s+)?(?:based|headquartered|located)\b/i.test(value)
      || /\b(?:company|employer)\s+(?:headquarters?|hq)\b/i.test(value)) {
    return 'company';
  }
  return hiring ? 'job' : 'company';
}

function parseRequest(text) {
  const value = String(text || '').trim();
  if (!isRequest(value)) return null;
  const explicitSheetUrl = sheets.extractSheetUrl(value);
  const wantsWorkspaceSheet = /\b(?:current|same|existing|last|latest|master|consolidated)\s+(?:google\s+)?(?:sheet|spreadsheet)\b/i.test(value);
  const wantsFinalMaster = /\b(?:master|final\s+master|final\s+(?:lead\s+)?database)\b/i.test(value);
  const destinationSheetUrl = explicitSheetUrl || (wantsFinalMaster
    ? (finalMaster.masterSheetUrl() || workspaceSheetUrl())
    : (wantsWorkspaceSheet ? workspaceSheetUrl() : null));
  const criteriaText = String(explicitSheetUrl ? value.replace(explicitSheetUrl, ' ') : value)
    .replace(/\b(?:and\s+)?(?:put|write|add|fill|save|append|send|keep)\s+(?:(?:them|it|these|those)\s+)?(?:the\s+)?(?:results?|companies|leads?|rows?)?\s*(?:into|in|to)?\s*(?:my|this|the)?\s*(?:current|same|existing|last|latest|master|consolidated)?\s*(?:google\s+)?(?:sheet|spreadsheet)\b/gi, ' ')
    .replace(/\b(?:in|into|to|on)\s+(?:the\s+)?(?:current|same|existing|last|latest|master|consolidated)\s+(?:google\s+)?(?:sheet|spreadsheet)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const entity = linkedinPublic.normalizeLinkedInEntityUrl(criteriaText);
  const phraseLocation = criteriaText.match(/\b(?:near|around)\s+([A-Za-z][A-Za-z .-]{1,60}?)(?=\s+(?:within|posted|in\s+the|remote|hybrid|onsite|on-site|under|with|and\s+(?:put|fill|write))\b|[,.;]|$)/i)?.[1]
    || criteriaText.match(/\bwithin\s+\d+(?:\.\d+)?\s*(?:km|kilomet(?:er|re)s?|mi|miles?)\s+of\s+([A-Za-z][A-Za-z .-]{1,60}?)(?=\s+(?:posted|in\s+the|remote|hybrid|onsite|on-site|under|with|and\s+(?:put|fill|write))\b|[,.;]|$)/i)?.[1];
  const location = linkedinPublic.locationFromText(criteriaText) || String(phraseLocation || '').trim();
  const filters = parseFilters(criteriaText);
  const hiring = hiringIntentFromText(criteriaText, filters);

  // Employee-count constraints describe company size, not a request for
  // LinkedIn people. Strip those phrases before inferring person intent.
  const peopleIntentText = criteriaText
    .replace(/\b(?:under|below|fewer\s+than|less\s+than|up\s+to|maximum|max|over|above|more\s+than|at\s+least|minimum|min)\s*\d[\d,]*\s+employees?\b/gi, ' ')
    .replace(/\b\d[\d,]*\s*(?:-|to)\s*\d[\d,]*\s+employees?\b/gi, ' ')
    .replace(/\b(?:employee\s+count|company\s+size|headcount)\b/gi, ' ');
  const explicitlyPeople = /\b(?:people|persons?|professionals?|recruiters?|founders?|employees?|candidates?|profiles?)\b/i.test(peopleIntentText);
  const inferredMode = linkedinPublic.entityModeFromText(criteriaText);
  const entityMode = entity?.type || (hiring && !explicitlyPeople ? 'company' : inferredMode);
  const compiledLeadIntent = leadIntent.compile(criteriaText);
  const compiledTopic = leadIntent.roleFromText(criteriaText) || requestTopic(criteriaText, entityMode, location);
  const baseRequest = {
    originalMessage: value,
    criteriaText,
    count: entity ? 1 : parseCount(criteriaText),
    entityMode,
    exactUrl: entity?.url || null,
    exactSlug: entity?.slug || null,
    location,
    locationScope: locationScopeFromText(criteriaText, hiring),
    hiring,
    topic: compiledTopic,
    wantsContacts: compiledLeadIntent.contactEnrichment,
    outputMode: compiledLeadIntent.outputMode,
    contactEnrichment: compiledLeadIntent.contactEnrichment,
    locationExpansion: compiledLeadIntent.locationExpansion,
    companyFilters: compiledLeadIntent.company,
    roleFamily: leadIntent.roleVariants(compiledTopic),
    filters,
    destinationSheetUrl,
    useFinalMaster: wantsFinalMaster,
    allowPreviouslySeenCompanies: finalMaster.allowRepeatFromText(value),
    explicitHeaders: v2.headersFromText(value),
    usePrevious: /\b(?:use|same as|like)\b[\s\S]{0,30}\b(?:previous|last)\b|\bprevious format\b|\bsame format\b/i.test(value),
    useDefault: /\b(?:default|standard)\s+(?:format|layout|headers?|columns?)\b/i.test(value),
  };
  const knownLocations = Object.values(LOCATION_SEARCH_HUBS).flat();
  const contract = missionContract.compile(value, baseRequest, { knownLocations });
  const applied = missionContract.apply(contract, baseRequest);
  if (applied.hiring && applied.destinationSheetUrl && applied.targetMode === 'additional' && Number(applied.count || 0) > 0) {
    applied.persistentUntilTarget = true;
    applied.targetRequested = Number(applied.count);
    applied.autoContinue = true;
  }
  return applied;
}

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function headerKey(value, mappings = null) {
  const mapped = sheetSchema.mappedKey(value, mappings);
  if (mapped) return mapped;
  const h = normalizeHeader(value);
  if (/ultron contact linkedin/.test(h)) return 'contactLinkedin';
  if (/^(?:person or company name|name|person|full name|contact name)$/.test(h)) return 'name';
  if (/^(?:company|company name|organization|organisation|organization name|organisation name|employer|business|business name)$/.test(h)) return 'company';
  if (/^(?:role|title|job title|job role|sap role|opening|job opening|position)$/.test(h)) return 'role';
  if (/^(?:job link|job url|linkedin job|linkedin job link|job posting link|job opening link|opening url|posting url)$/.test(h)) return 'jobLink';
  if (/linkedin|company link|company url|company profile/.test(h)) return 'linkedin';
  if (/^(?:location|job location|city|region|state)$/.test(h)) return 'location';
  if (/^(?:hiring signal|job signal|hiring activity|hiring evidence|job evidence)$/.test(h)) return 'hiring';
  if (/^(?:work type|workplace type|workplace|remote status|work mode|working mode)$/.test(h)) return 'workType';
  if (/^(?:employees?|employee count|company size|headcount|team size)$/.test(h)) return 'employees';
  if (/^(?:post details|details|description|profile details|linkedin details|notes)$/.test(h)) return 'details';
  if (/^(?:website|company website|site)$/.test(h)) return 'website';
  if (/phone|mobile|contact number|telephone/.test(h)) return 'phone';
  if (/email|e mail/.test(h)) return 'email';
  if (/^(?:remarks?|contact remarks?|contact person|contact identity)$/.test(h)) return 'remarks';
  if (/applicants?/.test(h)) return 'applicants';
  if (/^(?:posted|posted date|posting date|date posted|job age|posting age)$/.test(h)) return 'posted';
  if (/^(?:industry|company industry|sector)$/.test(h)) return 'industry';
  if (/^(?:company size confidence|size confidence|headcount confidence)$/.test(h)) return 'companySizeConfidence';
  if (/^(?:source|source url|linkedin source)$/.test(h)) return 'source';
  if (/^(?:lead score|score|quality|relevance)$/.test(h)) return 'score';
  return null;
}

function isFinalMasterRequest(request = {}) {
  return request.entityMode === 'company'
    && Boolean(request.useFinalMaster || request.targetMode === 'master_total');
}

function ensureHeaders(headers, request, options = {}) {
  if (isFinalMasterRequest(request)) return [...finalMaster.FINAL_MASTER_HEADERS];
  const defaults = request.entityMode === 'company' && !request.wantsContacts ? LEAD_DISCOVERY_HEADERS : (request.entityMode === 'company' ? COMPANY_HEADERS : PERSON_HEADERS);
  const source = Array.isArray(headers) && headers.length ? headers : defaults;
  const out = source.map((value) => String(value ?? '').trim()).slice(0, 30);
  if (options.preserveExisting) return out;
  const keys = new Set(out.map((header) => headerKey(header, request.headerMappings)).filter((key) => key && key !== 'ignore'));
  const needed = request.entityMode === 'company'
    ? [['company', 'COMPANY NAME'], ['linkedin', 'COMPANY LINK'], ['location', 'LOCATION']]
    : [['name', 'Name'], ['company', 'Company'], ['role', 'Role'], ['linkedin', 'LinkedIn'], ['location', 'Location'], ['details', 'Post Details'], ['source', 'Source'], ['score', 'Lead Score']];
  if (request.entityMode === 'company') {
    if (request.hiring) needed.push(['role', 'SAP ROLE'], ['jobLink', 'JOB LINK']);
    if (request.location) needed.push(['location', 'LOCATION']);
    if (request.filters?.workType) needed.push(['workType', 'WORK TYPE']);
    if (request.filters?.employeeMin != null || request.filters?.employeeMax != null) needed.push(['employees', 'EMPLOYEES']);
    if (request.hiring) needed.push(['hiring', 'HIRING SIGNAL']);
  }
  if (request.wantsContacts) {
    needed.push(['email', 'Email'], ['phone', 'Phone No']);
  }
  for (const [key, label] of needed) if (!keys.has(key)) { out.push(label); keys.add(key); }
  if (request.entityMode === 'company' && request.wantsContacts && !keys.has('remarks')) {
    const emailIndex = out.findIndex((header) => headerKey(header, request.headerMappings) === 'email');
    out.splice(emailIndex >= 0 ? emailIndex + 1 : out.length, 0, 'REMARKS');
  }
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
    suggestedHeaders: template?.headers || defaultHeadersFor(request),
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

function destinationHeaderCandidate(rows) {
  let best = null;
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const row = Array.isArray(rows[r]) ? rows[r] : [];
    const nonEmpty = row.filter((value) => String(value ?? '').trim()).length;
    if (!nonEmpty) continue;
    const recognized = row.map(headerKey).filter(Boolean).length;
    const score = recognized * 20 + Math.min(nonEmpty, 12) - r * 0.1;
    if (!best || score > best.score) {
      best = { rowIndex: r, rowNumber: r + 1, headers: row.map((value) => String(value ?? '').trim()), recognized, score };
    }
  }
  return best;
}

async function inspectDestinationSheet(url, request) {
  const spreadsheetId = sheets.spreadsheetId(url);
  const meta = await sheets.metadata(spreadsheetId);
  const requestedGid = sheets.sheetGid(url);
  const tabs = [...(meta.sheets || [])].sort((a, b) => {
    if (requestedGid != null) {
      if (a?.properties?.sheetId === requestedGid) return -1;
      if (b?.properties?.sheetId === requestedGid) return 1;
    }
    return Number(a?.properties?.index || 0) - Number(b?.properties?.index || 0);
  });

  let chosen = null;
  for (const tab of tabs) {
    const title = tab?.properties?.title;
    if (!title) continue;
    const preview = await sheets.values(spreadsheetId, `${sheets.quoteSheet(title)}!A1:ZZ80`);
    const candidate = destinationHeaderCandidate(preview);
    if (candidate && (candidate.recognized > 0 || candidate.headers.filter(Boolean).length >= 2)) {
      chosen = { ...candidate, sheetName: title, sheetId: tab.properties.sheetId, preview };
      break;
    }
    if (!chosen && preview.length === 0) {
      chosen = { rowIndex: 0, rowNumber: 1, headers: [], recognized: 0, score: 0, sheetName: title, sheetId: tab.properties.sheetId, preview: [] };
      if (requestedGid != null && tab.properties.sheetId === requestedGid) break;
    }
  }

  if (!chosen) {
    const error = new Error('The provided Google Sheet does not contain a usable header row, and ULTRON stopped rather than guessing where to write.');
    error.code = 'LINKEDIN_DESTINATION_HEADERS_NOT_FOUND';
    throw error;
  }

  const schema = await sheetSchema.resolve(chosen.headers, request, headerKey, {
    allowModel: request.resolveUnknownHeaders !== false,
  });
  const requestWithMappings = { ...request, headerMappings: schema.mappings };
  const baseHeaders = chosen.headers.some(Boolean)
    ? chosen.headers
    : defaultHeadersFor(requestWithMappings);
  const headers = ensureHeaders(baseHeaders, requestWithMappings, { preserveExisting: chosen.headers.some(Boolean) });
  const fullRows = await sheets.values(spreadsheetId, `${sheets.quoteSheet(chosen.sheetName)}!A:ZZ`);
  let lastNonEmptyRow = 0;
  for (let i = 0; i < fullRows.length; i++) {
    if ((fullRows[i] || []).some((value) => String(value ?? '').trim())) lastNonEmptyRow = i + 1;
  }

  return {
    spreadsheetId,
    spreadsheetTitle: meta?.properties?.title || 'Google Sheet',
    sheetName: chosen.sheetName,
    sheetId: chosen.sheetId,
    gridColumnCount: Number(tabs.find((tab) => tab?.properties?.sheetId === chosen.sheetId)?.properties?.gridProperties?.columnCount || 0),
    gridRowCount: Number(tabs.find((tab) => tab?.properties?.sheetId === chosen.sheetId)?.properties?.gridProperties?.rowCount || 0),
    headerRowNumber: chosen.rowNumber,
    originalHeaders: chosen.headers,
    headers,
    headerMappings: schema.mappings,
    unresolvedHeaders: schema.unresolved,
    schemaModel: schema.model,
    schemaProvider: schema.provider,
    rows: fullRows,
    lastNonEmptyRow,
    url,
  };
}

async function syncDestinationHeaders(destination, headers) {
  await sheets.ensureGridSize(destination.spreadsheetId, destination.sheetId, {
    minColumns: Math.max(1, headers.length),
    minRows: Math.max(2, destination.lastNonEmptyRow + 2),
  });
  const changes = [];
  for (let index = 0; index < headers.length; index++) {
    const current = String(destination.rows?.[destination.headerRowNumber - 1]?.[index] ?? '').trim();
    const next = String(headers[index] ?? '').trim();
    if (current !== next) {
      changes.push({
        range: sheets.cellRange(destination.sheetName, destination.headerRowNumber, index),
        value: next,
      });
    }
  }
  if (changes.length) await sheets.writeCells(destination.spreadsheetId, changes);
  destination.headers = headers;
  destination.rows[destination.headerRowNumber - 1] = headers.slice();
  return changes.length;
}

function plausiblePhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return true;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

function plausibleEmail(value) {
  const raw = String(value || '').trim();
  if (!raw) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
}

async function repairFinalMasterSheetSchema(url = finalMaster.masterSheetUrl()) {
  if (!url) return { repaired: false, reason: 'missing-master' };
  const spreadsheetId = sheets.spreadsheetId(url);
  const state = finalMaster.loadState();
  const meta = await sheets.metadata(spreadsheetId);
  const tab = (meta.sheets || []).find((item) => item?.properties?.title === (state.sheetName || 'Leads'))
    || (meta.sheets || [])[0];
  if (!tab?.properties?.title) {
    const error = new Error('Final Master Sheet tab could not be resolved.');
    error.code = 'LINKEDIN_FINAL_MASTER_TAB_NOT_FOUND';
    throw error;
  }

  const sheetName = tab.properties.title;
  const sheetId = tab.properties.sheetId;
  const gridColumns = Number(tab.properties?.gridProperties?.columnCount || 0);
  await sheets.ensureGridSize(spreadsheetId, sheetId, { minColumns: finalMaster.FINAL_MASTER_HEADERS.length, minRows: 2 });

  const headerChanges = finalMaster.FINAL_MASTER_HEADERS.map((value, index) => ({
    range: sheets.cellRange(sheetName, 1, index),
    value,
  }));
  await sheets.writeCells(spreadsheetId, headerChanges);

  const rows = await sheets.values(spreadsheetId, `${sheets.quoteSheet(sheetName)}!A2:H`);
  const cleanup = [];
  let cleanedContacts = 0;
  let cleanedNames = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] || [];
    const rowNumber = index + 2;
    const company = String(row[0] || '').trim();
    const cleanCompany = finalMaster.cleanCompanyDisplay(company);
    if (company && cleanCompany && cleanCompany !== company) {
      cleanup.push({ range: sheets.cellRange(sheetName, rowNumber, 0), value: cleanCompany });
      cleanedNames++;
    }

    const applicants = String(row[4] || '').trim();
    const phone = String(row[5] || '').trim();
    const email = String(row[6] || '').trim();
    const remarks = String(row[7] || '').trim();
    if (phone && (!plausiblePhone(phone) || phone === applicants)) cleanedContacts++;
    if (email && (!plausibleEmail(email) || email === applicants)) cleanedContacts++;
    if (remarks && (remarks === applicants || /^\d+(?:\.\d+)?$/.test(remarks))) cleanedContacts++;
  }
  if (cleanup.length) await sheets.writeCells(spreadsheetId, cleanup);

  finalMaster.setMasterSheet({
    url,
    spreadsheetId,
    sheetName,
    title: meta?.properties?.title || state.spreadsheetTitle,
  });
  return {
    repaired: true,
    spreadsheetId,
    sheetId,
    sheetName,
    trimmedColumns: 0,
    preservedExtraColumns: Math.max(0, gridColumns - finalMaster.FINAL_MASTER_HEADERS.length),
    cleanedContacts: 0,
    preservedQuestionableCells: cleanedContacts,
    cleanedNames,
  };
}

function destinationExistingKeys(destination, headers, request = {}) {
  const linkedinIndex = headers.findIndex((header) => headerKey(header, request.headerMappings) === 'linkedin');
  const jobIndex = headers.findIndex((header) => headerKey(header, request.headerMappings) === 'jobLink');
  const companyIndex = headers.findIndex((header) => headerKey(header, request.headerMappings) === 'company');
  const keys = new Set();
  for (let r = destination.headerRowNumber; r < (destination.rows || []).length; r++) {
    const row = destination.rows[r] || [];
    const linkedin = linkedinIndex >= 0 ? String(row[linkedinIndex] || '').trim().toLowerCase() : '';
    const job = jobIndex >= 0 ? String(row[jobIndex] || '').trim().toLowerCase() : '';
    const company = companyIndex >= 0 ? normalizeHeader(row[companyIndex]) : '';
    if (linkedin) keys.add(`linkedin:${linkedin}`);
    if (job) keys.add(`job:${job}`);
    if (company) keys.add(`company:${company}`);
  }
  return keys;
}

function recordDestinationKeys(record) {
  const keys = [];
  if (record?.linkedin) keys.push(`linkedin:${String(record.linkedin).trim().toLowerCase()}`);
  if (record?.jobUrl) keys.push(`job:${String(record.jobUrl).trim().toLowerCase()}`);
  if (record?.company) keys.push(`company:${normalizeHeader(record.company)}`);
  return keys.filter((key) => !/:$/.test(key));
}

async function prepare(request) {
  if (request.destinationSheetUrl) {
    try {
      const destination = await inspectDestinationSheet(request.destinationSheetUrl, request);
      if (destination.unresolvedHeaders?.length) {
        const pending = setPending({
          ...request,
          schemaClarification: true,
          headerMappings: destination.headerMappings,
          unresolvedHeaders: destination.unresolvedHeaders,
        }, { headers: destination.headers, sourceTitle: destination.spreadsheetTitle });
        return { type: 'clarification', pending, text: sheetSchema.clarificationText(destination.unresolvedHeaders) };
      }
      const nextRequest = {
        ...request,
        headerMappings: destination.headerMappings,
        destinationSheet: {
          spreadsheetId: destination.spreadsheetId,
          spreadsheetTitle: destination.spreadsheetTitle,
          sheetName: destination.sheetName,
          sheetId: destination.sheetId,
          headerRowNumber: destination.headerRowNumber,
        },
      };
      return { type: 'run', request: nextRequest, headers: destination.headers };
    } catch (error) {
      if (!isGoogleSheetsError(error)) throw error;
      const fallbackHeaders = ensureHeaders(
        defaultHeadersFor(request),
        request,
      );
      return {
        type: 'run',
        request: {
          ...request,
          destinationPreflightError: sheetErrorSnapshot(error),
        },
        headers: fallbackHeaders,
      };
    }
  }
  if (request.entityMode === 'company' && !request.explicitHeaders?.length && !request.usePrevious) {
    return { type: 'run', request, headers: ensureHeaders([...defaultHeadersFor(request)], request) };
  }
  if (request.exactUrl || request.explicitHeaders?.length || request.useDefault || request.usePrevious) {
    let headers = request.explicitHeaders;
    if (!headers && request.usePrevious) {
      const template = v2.latestTemplate();
      headers = template?.headers;
    }
    if (!headers) headers = defaultHeadersFor(request);
    return { type: 'run', request, headers: ensureHeaders(headers, request) };
  }
  const template = v2.latestTemplate();
  const pending = setPending(request, template);
  const previous = template?.headers?.length ? v2.templatePreview(template) : 'none remembered yet';
  const defaults = defaultHeadersFor(request).join(' | ');
  return {
    type: 'clarification',
    pending,
    text: `This is a dedicated LinkedIn-only mission. I will not use Google Jobs, Maps, TinyFish, SerpApi or Apollo for discovery. Contact enrichment runs only when you explicitly request it. Previous sheet headings: ${previous}. LinkedIn default: ${defaults}. Use previous format, default format, send headers: ..., or send a Google Sheets URL and I will fill that sheet directly.`,
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
  if (pending.schemaClarification && pending.destinationSheetUrl) {
    const automaticMappings = sheetSchema.deterministicIgnoreMappings(pending.unresolvedHeaders || []);
    const exclusiveMappings = sheetSchema.exclusiveUserMappings(value, pending.suggestedHeaders || [], headerKey);
    const supplied = { ...automaticMappings, ...(exclusiveMappings || sheetSchema.userMappings(value, pending.unresolvedHeaders || [], headerKey)) };
    if (!Object.keys(supplied).length) {
      return { type: 'clarification', pending, text: sheetSchema.clarificationText(pending.unresolvedHeaders || []) };
    }
    const request = {
      ...pending,
      schemaClarification: false,
      resolveUnknownHeaders: false,
      headerMappings: { ...(pending.headerMappings || {}), ...supplied },
    };
    const destination = await inspectDestinationSheet(request.destinationSheetUrl, request);
    if (destination.unresolvedHeaders?.length) {
      const nextPending = setPending({
        ...request,
        schemaClarification: true,
        unresolvedHeaders: destination.unresolvedHeaders,
        headerMappings: destination.headerMappings,
      }, { headers: destination.headers, sourceTitle: destination.spreadsheetTitle });
      return { type: 'clarification', pending: nextPending, text: sheetSchema.clarificationText(destination.unresolvedHeaders) };
    }
    clearPending();
    request.headerMappings = destination.headerMappings;
    request.destinationSheet = {
      spreadsheetId: destination.spreadsheetId,
      spreadsheetTitle: destination.spreadsheetTitle,
      sheetName: destination.sheetName,
      sheetId: destination.sheetId,
      headerRowNumber: destination.headerRowNumber,
    };
    return { type: 'run', request, headers: destination.headers };
  }
  const destinationSheetUrl = sheets.extractSheetUrl(value);
  if (destinationSheetUrl) {
    const request = { ...pending, destinationSheetUrl };
    const destination = await inspectDestinationSheet(destinationSheetUrl, request);
    if (destination.unresolvedHeaders?.length) {
      const nextPending = setPending({
        ...request,
        schemaClarification: true,
        headerMappings: destination.headerMappings,
        unresolvedHeaders: destination.unresolvedHeaders,
      }, { headers: destination.headers, sourceTitle: destination.spreadsheetTitle });
      return { type: 'clarification', pending: nextPending, text: sheetSchema.clarificationText(destination.unresolvedHeaders) };
    }
    clearPending();
    request.headerMappings = destination.headerMappings;
    request.destinationSheet = {
      spreadsheetId: destination.spreadsheetId,
      spreadsheetTitle: destination.spreadsheetTitle,
      sheetName: destination.sheetName,
      sheetId: destination.sheetId,
      headerRowNumber: destination.headerRowNumber,
    };
    return { type: 'run', request, headers: destination.headers };
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
    const defaults = defaultHeadersFor(pending);
    return { type: 'run', request: pending, headers: ensureHeaders(defaults, pending) };
  }
  if (/\b(?:different|custom|new)\b[\s\S]{0,30}\b(?:format|headers?|columns?|layout)\b/i.test(value)) {
    return { type: 'clarification', pending, text: 'Send the layout as: headers: NAME, COMPANY NAME, COMPANY LINK, NO. OF APPLICANTS, PHONE NUMBER, EMAIL, REMARKS.' };
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
  const direct = [];
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 12) return;
    if (Array.isArray(value.job_ids)) direct.push(...value.job_ids);
    if (value.job_id != null) direct.push(value.job_id);
    for (const [key, child] of Object.entries(value)) {
      if (!/cookie|token|password|session/i.test(key)) visit(child, depth + 1);
    }
  };
  visit(result);
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
  const scopes = [];
  if (companyKey && index >= 0) {
    scopes.push(source.slice(Math.max(0, index - 500), index + companyKey.length + 1400));
  }
  scopes.push(source);
  const patterns = [
    /\b(\d[\d,]*\+?)\s+(?:people\s+clicked\s+apply|applicants?|applications?)\b/i,
    /\b(?:over|more\s+than)\s+(\d[\d,]*\+?)\s+(?:applicants?|applications?)\b/i,
    /\b(?:applicant(?:_|\s)?count|applications?)\s*[:=]\s*(\d[\d,]*\+?)\b/i,
  ];
  for (const scoped of scopes) {
    for (const pattern of patterns) {
      const match = scoped.match(pattern);
      if (match?.[1]) return match[1];
    }
  }
  return '';
}

function applicantCountFromDetail(detail, company = '') {
  const visited = new Set();
  function scan(value, depth = 0) {
    if (depth > 7 || value == null || typeof value !== 'object') return '';
    if (visited.has(value)) return '';
    visited.add(value);
    for (const [key, item] of Object.entries(value)) {
      if (/applicant|application|people.*clicked.*apply/i.test(String(key))) {
        if (typeof item === 'number' && Number.isFinite(item)) return String(item);
        const direct = String(item ?? '').match(/\b(\d[\d,]*\+?)\b/);
        if (direct?.[1]) return direct[1];
      }
      const nested = scan(item, depth + 1);
      if (nested) return nested;
    }
    return '';
  }
  return scan(detail) || applicantCountFromText(flattenText(detail), company);
}

function postedEvidenceFromText(text) {
  const source = String(text || '');
  const match = source.match(/\b(?:posted\s+)?(?:just\s+now|today|yesterday|\d{1,3}\s+(?:minutes?|hours?|days?|weeks?|months?)\s+ago)\b/i)
    || source.match(/\b20\d{2}-\d{2}-\d{2}\b/);
  return match?.[0] || '';
}

function employeeCountFromText(text) {
  const source = String(text || '');
  const range = source.match(/\b(\d[\d,]*)\s*(?:-|–|to)\s*(\d[\d,]*)\s+employees?\b/i);
  if (range) {
    return {
      min: compactNumber(range[1]),
      max: compactNumber(range[2]),
      label: `${range[1]}-${range[2]}`,
      openEnded: false,
    };
  }

  const plus = source.match(/\b(?:company size\s*[:·-]?\s*)?(\d[\d,]*)\+\s*employees?\b/i);
  if (plus) {
    const count = compactNumber(plus[1]);
    return count == null ? null : { min: count, max: null, label: `${plus[1]}+`, openEnded: true };
  }

  const exact = source.match(/\b(?:company size|employees?)\s*[:·-]?\s*(\d[\d,]*)\b/i)
    || source.match(/\b(\d[\d,]*)\s+employees?\b/i);
  if (!exact) return null;
  const count = compactNumber(exact[1]);
  return count == null ? null : { min: count, max: count, label: exact[1], openEnded: false };
}

function companyEvidenceFromJobDetail(detail) {
  const posting = String(detail?.sections?.job_posting || '');
  if (!posting) return '';
  const marker = /(?:^|\n)About the company\s*\n/i;
  const match = marker.exec(posting);
  if (!match) return '';
  const start = Number(match.index || 0) + match[0].length;
  let evidence = posting.slice(start);
  const boundary = evidence.search(/\n(?:Show more|More jobs|Job search smarter with Premium|Looking for talent\?)\b/i);
  if (boundary >= 0) evidence = evidence.slice(0, boundary);
  return evidence.trim().slice(0, 12000);
}

function companyProfileRequired(record, request = {}) {
  const filters = request.filters || {};
  const companyFilters = request.companyFilters || {};
  const needsEmployeeEvidence = filters.employeeMin != null || filters.employeeMax != null;
  if (needsEmployeeEvidence && !record?.employeeCount) return true;
  if (request.locationScope === 'company' && requestedLocations(request).length
      && !locationEvidenceMatchesRequest(record, request, { allowJobEvidence: false, allowCompanyEvidence: true })) return true;
  if (companyFilters.industry || companyFilters.startup) return true;
  return false;
}

function indirectEmployerPosting(text) {
  const value = String(text || '');
  return /\b(?:listed|posted)\s+on\s+behalf\s+of\s+(?:a|an|the|our)\s+(?:partner|client)(?:\s+company)?\b/i.test(value)
    || /\bour\s+(?:partner|client)\s+(?:company\s+)?is\s+(?:currently\s+)?(?:looking|hiring|seeking)\b/i.test(value)
    || /\b(?:one|any)\s+of\s+our\s+(?:clients?|customers?|partners?)(?:\s+(?:is|are))?\s+(?:currently\s+)?(?:looking|hiring|seeking)\b/i.test(value)
    || /\b(?:we(?:'re|\s+are)|currently)\s+hiring\s+(?:for|on\s+behalf\s+of)\s+(?:one\s+of\s+)?(?:our|a|an|the)?\s*(?:clients?|customers?|partners?|top\s+(?:it|technology)\s+(?:services?\s+)?compan(?:y|ies))\b/i.test(value)
    || /\bclient\s*(?:\/|and|&)\s*implementation\s+partner\s+(?:is|:)\b/i.test(value);
}

function passesEmployeeFilter(record, filters = {}) {
  if (filters.employeeMin == null && filters.employeeMax == null) return true;
  const size = record.employeeCount;
  if (!size || !Number.isFinite(Number(size.min))) return false;

  // Hard filters use the whole LinkedIn company-size interval. A company in
  // "1,000-5,000" cannot be claimed as under 1,000 merely because the lower
  // bound touches the requested ceiling.
  if (filters.employeeMin != null && Number(size.min) < filters.employeeMin) return false;
  if (filters.employeeMax != null && (size.openEnded || !Number.isFinite(Number(size.max)) || Number(size.max) > filters.employeeMax)) return false;
  return true;
}

const LOCATION_REGION_ALIASES = {
  india: [
    'india', 'bengaluru', 'bangalore', 'hyderabad', 'pune', 'mumbai', 'navi mumbai',
    'chennai', 'delhi', 'new delhi', 'gurugram', 'gurgaon', 'noida', 'kolkata',
    'ahmedabad', 'vadodara', 'surat', 'kochi', 'cochin', 'thiruvananthapuram',
    'jaipur', 'indore', 'bhopal', 'bhubaneswar', 'chandigarh', 'mohali',
    'visakhapatnam', 'vijayawada', 'lucknow', 'nagpur', 'nashik', 'coimbatore',
  ],
  maharashtra: [
    'maharashtra', 'mumbai', 'navi mumbai', 'thane', 'pune', 'nagpur', 'nashik',
    'aurangabad', 'chhatrapati sambhajinagar', 'kolhapur', 'solapur', 'amravati',
    'satara', 'sangli', 'jalgaon', 'akola', 'latur', 'ratnagiri',
  ],
  karnataka: ['karnataka', 'bengaluru', 'bangalore', 'mysuru', 'mysore', 'mangaluru', 'mangalore', 'hubballi', 'dharwad'],
  telangana: ['telangana', 'hyderabad', 'secunderabad', 'warangal'],
  'tamil nadu': ['tamil nadu', 'chennai', 'coimbatore', 'madurai', 'tiruchirappalli', 'trichy', 'hosur'],
  'west bengal': ['west bengal', 'kolkata', 'calcutta', 'howrah', 'durgapur', 'siliguri'],
  gujarat: ['gujarat', 'ahmedabad', 'gandhinagar', 'vadodara', 'baroda', 'surat', 'rajkot'],
  haryana: ['haryana', 'gurugram', 'gurgaon', 'faridabad', 'panipat'],
  'uttar pradesh': ['uttar pradesh', 'noida', 'greater noida', 'ghaziabad', 'lucknow', 'kanpur', 'prayagraj', 'agra'],
  rajasthan: ['rajasthan', 'jaipur', 'jodhpur', 'udaipur', 'kota'],
  kerala: ['kerala', 'kochi', 'cochin', 'thiruvananthapuram', 'trivandrum', 'kozhikode', 'calicut'],
  'madhya pradesh': ['madhya pradesh', 'indore', 'bhopal', 'jabalpur', 'gwalior'],
  odisha: ['odisha', 'orissa', 'bhubaneswar', 'cuttack', 'rourkela'],
  punjab: ['punjab', 'mohali', 'sahibzada ajit singh nagar', 'ludhiana', 'amritsar', 'jalandhar', 'chandigarh'],
  'andhra pradesh': ['andhra pradesh', 'visakhapatnam', 'vizag', 'vijayawada', 'tirupati', 'guntur'],
  bihar: ['bihar', 'patna'],
  jharkhand: ['jharkhand', 'ranchi', 'jamshedpur'],
  chhattisgarh: ['chhattisgarh', 'raipur', 'bilaspur'],
  assam: ['assam', 'guwahati'],
  'arunachal pradesh': ['arunachal pradesh', 'itanagar'],
  manipur: ['manipur', 'imphal'],
  meghalaya: ['meghalaya', 'shillong'],
  mizoram: ['mizoram', 'aizawl'],
  nagaland: ['nagaland', 'kohima', 'dimapur'],
  sikkim: ['sikkim', 'gangtok'],
  tripura: ['tripura', 'agartala'],
  uttarakhand: ['uttarakhand', 'dehradun', 'haridwar'],
  goa: ['goa', 'panaji', 'margao'],
  'himachal pradesh': ['himachal pradesh', 'shimla'],
  'jammu and kashmir': ['jammu and kashmir', 'jammu', 'srinagar'],
  'jammu & kashmir': ['jammu & kashmir', 'jammu and kashmir', 'jammu', 'srinagar'],
  ladakh: ['ladakh', 'leh', 'kargil'],
  chandigarh: ['chandigarh'],
  puducherry: ['puducherry', 'pondicherry'],
  'andaman and nicobar islands': ['andaman and nicobar islands', 'port blair'],
  lakshadweep: ['lakshadweep', 'kavaratti'],
  'dadra and nagar haveli and daman and diu': ['dadra and nagar haveli and daman and diu', 'silvassa', 'daman', 'diu'],
  delhi: ['delhi', 'new delhi', 'delhi ncr', 'ncr'],
  'delhi ncr': ['delhi ncr', 'delhi', 'new delhi', 'gurugram', 'gurgaon', 'noida', 'greater noida', 'faridabad', 'ghaziabad'],
};

const LOCATION_SEARCH_HUBS = {
  india: ['India', 'Bengaluru', 'Hyderabad', 'Pune', 'Mumbai', 'Chennai', 'Delhi NCR', 'Gurugram', 'Noida', 'Kolkata', 'Ahmedabad'],
  maharashtra: ['Maharashtra', 'Pune', 'Mumbai', 'Navi Mumbai', 'Thane', 'Nagpur', 'Nashik'],
  karnataka: ['Karnataka', 'Bengaluru', 'Mysuru', 'Mangaluru', 'Hubballi'],
  telangana: ['Telangana', 'Hyderabad', 'Secunderabad'],
  'tamil nadu': ['Tamil Nadu', 'Chennai', 'Coimbatore', 'Hosur', 'Madurai'],
  'west bengal': ['West Bengal', 'Kolkata', 'Howrah', 'Durgapur'],
  gujarat: ['Gujarat', 'Ahmedabad', 'Gandhinagar', 'Vadodara', 'Surat'],
  haryana: ['Haryana', 'Gurugram', 'Faridabad'],
  'uttar pradesh': ['Uttar Pradesh', 'Noida', 'Greater Noida', 'Ghaziabad', 'Lucknow'],
  rajasthan: ['Rajasthan', 'Jaipur', 'Jodhpur', 'Udaipur'],
  kerala: ['Kerala', 'Kochi', 'Thiruvananthapuram', 'Kozhikode'],
  'madhya pradesh': ['Madhya Pradesh', 'Indore', 'Bhopal'],
  odisha: ['Odisha', 'Bhubaneswar', 'Cuttack'],
  punjab: ['Punjab', 'Mohali', 'Ludhiana', 'Amritsar', 'Chandigarh'],
  'andhra pradesh': ['Andhra Pradesh', 'Visakhapatnam', 'Vijayawada', 'Tirupati'],
  bihar: ['Bihar', 'Patna'],
  jharkhand: ['Jharkhand', 'Ranchi', 'Jamshedpur'],
  chhattisgarh: ['Chhattisgarh', 'Raipur'],
  assam: ['Assam', 'Guwahati'],
  'arunachal pradesh': ['Arunachal Pradesh', 'Itanagar'],
  manipur: ['Manipur', 'Imphal'],
  meghalaya: ['Meghalaya', 'Shillong'],
  mizoram: ['Mizoram', 'Aizawl'],
  nagaland: ['Nagaland', 'Dimapur', 'Kohima'],
  sikkim: ['Sikkim', 'Gangtok'],
  tripura: ['Tripura', 'Agartala'],
  uttarakhand: ['Uttarakhand', 'Dehradun'],
  goa: ['Goa', 'Panaji'],
  'himachal pradesh': ['Himachal Pradesh', 'Shimla'],
  'jammu and kashmir': ['Jammu and Kashmir', 'Jammu', 'Srinagar'],
  'jammu & kashmir': ['Jammu and Kashmir', 'Jammu', 'Srinagar'],
  ladakh: ['Ladakh', 'Leh'],
  chandigarh: ['Chandigarh'],
  puducherry: ['Puducherry'],
  'andaman and nicobar islands': ['Andaman and Nicobar Islands', 'Port Blair'],
  lakshadweep: ['Lakshadweep'],
  'dadra and nagar haveli and daman and diu': ['Dadra and Nagar Haveli and Daman and Diu', 'Silvassa', 'Daman'],
  delhi: ['Delhi', 'New Delhi', 'Delhi NCR'],
  'delhi ncr': ['Delhi NCR', 'Delhi', 'New Delhi', 'Gurugram', 'Noida', 'Faridabad', 'Ghaziabad'],
};

function evidenceRegexEscape(value) {
  return String(value || '').replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
}

function containsEvidenceTerm(text, term) {
  const needle = String(term || '').trim();
  if (!needle) return false;
  return new RegExp(`\\b${evidenceRegexEscape(needle).replace(/\\ /g, '\\s+')}\\b`, 'i').test(String(text || ''));
}

function mergeEvidenceText(left, right, max = 12000) {
  const parts = [left, right].map((value) => String(value || '').trim()).filter(Boolean);
  return [...new Set(parts)].join('\n').slice(0, max);
}

function scopedCompanyEvidence(text, company, radius = 1400) {
  const source = String(text || '');
  const needle = String(company || '').trim();
  if (!source || !needle) return '';
  const lower = source.toLowerCase();
  const at = lower.indexOf(needle.toLowerCase());
  if (at < 0) return '';
  return source.slice(Math.max(0, at - radius), Math.min(source.length, at + needle.length + radius));
}

function detectWorkType(text) {
  const value = String(text || '');
  const patterns = [
    { value: 'remote', regex: /workplace\s+type\s*[:·-]?\s*remote\b/i },
    { value: 'hybrid', regex: /workplace\s+type\s*[:·-]?\s*hybrid\b/i },
    { value: 'on_site', regex: /workplace\s+type\s*[:·-]?\s*on[- ]?site\b/i },
    { value: 'remote', regex: /(?:^|\n)\s*remote(?:\s*\([^\n)]+\))?\s*(?:$|\n)/im },
    { value: 'hybrid', regex: /(?:^|\n)\s*hybrid(?:\s*\([^\n)]+\))?\s*(?:$|\n)/im },
    { value: 'on_site', regex: /(?:^|\n)\s*on[- ]?site(?:\s*\([^\n)]+\))?\s*(?:$|\n)/im },
    { value: 'remote', regex: /(?:^|[·|,])\s*remote\s*(?=$|[·|,\n])/im },
    { value: 'hybrid', regex: /(?:^|[·|,])\s*hybrid\s*(?=$|[·|,\n])/im },
    { value: 'on_site', regex: /(?:^|[·|,])\s*on[- ]?site\s*(?=$|[·|,\n])/im },
    { value: 'remote', regex: /\b(?:this|the)\s+(?:position|role|job)\s+is\s+(?:fully\s+)?remote\b/i },
    { value: 'hybrid', regex: /\b(?:this|the)\s+(?:position|role|job)\s+is\s+hybrid\b/i },
    { value: 'on_site', regex: /\b(?:this|the)\s+(?:position|role|job)\s+is\s+on[- ]?site\b/i },
    { value: 'remote', regex: /\bwork\s+from\s+(?:home|anywhere)\b/i },
  ];
  for (const item of patterns) if (item.regex.test(value)) return item.value;
  return '';
}

function companyLocationEvidence(record) {
  return [
    record?.companyEvidenceText,
    record?.companySearchEvidenceText,
    record?.companyLocation,
  ].filter(Boolean).join('\n');
}

function jobEvidence(record) {
  return [
    record?.role,
    record?.searchProvenance?.title,
    record?.jobEvidenceText,
    record?.hiringSignal,
  ].filter(Boolean).join('\n');
}

function locationLabelMatchesRequested(label, requestedLocation) {
  const requested = String(requestedLocation || '').trim().toLowerCase();
  const value = String(label || '').trim();
  if (!requested) return true;
  if (!value) return false;
  const aliases = LOCATION_REGION_ALIASES[requested] || [requested];
  return aliases.some((candidate) => containsEvidenceTerm(value, candidate));
}

function locationEvidenceDetails(record, requestedLocation, options = {}) {
  const requested = String(requestedLocation || '').trim().toLowerCase();
  if (!requested) return { matched: true, source: 'none', label: '' };
  const allowJobEvidence = Boolean(options.allowJobEvidence);
  const allowCompanyEvidence = options.allowCompanyEvidence == null ? !allowJobEvidence : Boolean(options.allowCompanyEvidence);
  const aliases = LOCATION_REGION_ALIASES[requested] || [requested];

  if (allowJobEvidence) {
    const explicit = jobEvidence(record);
    const alias = aliases.find((candidate) => containsEvidenceTerm(explicit, candidate));
    if (alias) return { matched: true, source: 'job', label: alias };

    // If LinkedIn's actual job page names a recognised location outside the
    // requested region, do not let a retained search facet overrule it.
    const observedJobLocation = linkedinPublic.locationFromText(explicit);
    if (observedJobLocation && !locationLabelMatchesRequested(observedJobLocation, requested)) {
      const knownIndianLocations = new Set([
        'india',
        ...Object.keys(LOCATION_SEARCH_HUBS),
        ...Object.values(LOCATION_SEARCH_HUBS).flat().map((value) => String(value || '').trim().toLowerCase()),
      ]);
      const indiaWideRemote = /^india$/i.test(observedJobLocation)
        && knownIndianLocations.has(requested)
        && detectWorkType(explicit) === 'remote';
      if (indiaWideRemote) return { matched: true, source: 'job_remote_country', label: observedJobLocation };
      return { matched: false, source: 'job_conflict', label: observedJobLocation };
    }

    const trustedLocations = Array.isArray(record?.searchProvenance?.trustedLocations)
      ? record.searchProvenance.trustedLocations
      : [];
    const trusted = trustedLocations.find((value) => locationLabelMatchesRequested(value, requested));
    if (trusted) return { matched: true, source: 'linkedin_search_filter', label: trusted };
  }

  if (allowCompanyEvidence) {
    const evidence = companyLocationEvidence(record);
    const alias = aliases.find((candidate) => containsEvidenceTerm(evidence, candidate));
    if (alias) return { matched: true, source: 'company', label: alias };
  }

  return { matched: false, source: '', label: '' };
}

function locationEvidenceMatches(record, requestedLocation, options = {}) {
  return locationEvidenceDetails(record, requestedLocation, options).matched;
}

function requestedLocations(request = {}) {
  const allowed = Array.isArray(request.allowedLocations) ? request.allowedLocations.filter(Boolean) : [];
  const explicit = String(request.location || '').trim();
  const expansionRoots = allowed.length ? allowed : (explicit ? [explicit] : []);
  const expanded = request.locationExpansion
    ? expansionRoots.flatMap((root) => locationExpander.stages(root, request.locationExpansion).map((stage) => stage.location))
    : [];
  const combined = leadIntent.uniq([...allowed, ...expanded]);
  if (explicit && allowed.length && !allowed.some((item) => String(item).toLowerCase() === explicit.toLowerCase())) {
    return leadIntent.uniq([explicit, ...expanded]);
  }
  if (combined.length) return combined;
  return explicit ? [explicit] : [];
}

function locationEvidenceDetailsForRequest(record, request = {}, options = {}) {
  const preferred = Array.isArray(request.preferredLocations) && request.preferredLocations.length
    ? request.preferredLocations
    : requestedLocations(request);
  const allowed = requestedLocations(request);
  if (!allowed.length) return { matched: true, source: 'none', label: '', requestedLocation: '' };

  const ordered = [...preferred, ...allowed].filter((value, index, list) =>
    list.findIndex((item) => String(item).toLowerCase() === String(value).toLowerCase()) === index
  );

  let firstConflict = null;
  for (const location of ordered) {
    const details = locationEvidenceDetails(record, location, options);
    if (details.matched) return { ...details, requestedLocation: location };
    if (!firstConflict && details.source === 'job_conflict') firstConflict = { ...details, requestedLocation: location };
  }
  return firstConflict || { matched: false, source: '', label: '', requestedLocation: ordered[0] || '' };
}

function locationEvidenceMatchesRequest(record, request = {}, options = {}) {
  return locationEvidenceDetailsForRequest(record, request, options).matched;
}

function workTypeEvidenceDetails(record, requestedWorkType) {
  const requested = String(requestedWorkType || '').trim().toLowerCase();
  if (!requested) return { matched: true, source: 'none', value: '' };

  const explicit = detectWorkType(jobEvidence(record));
  if (explicit) return { matched: explicit === requested, source: 'job', value: explicit };

  const trusted = Array.isArray(record?.searchProvenance?.trustedWorkTypes)
    ? record.searchProvenance.trustedWorkTypes.map((value) => String(value || '').toLowerCase())
    : [];
  if (trusted.includes(requested)) return { matched: true, source: 'linkedin_search_filter', value: requested };

  return { matched: false, source: '', value: '' };
}

function workTypeEvidenceMatches(record, requestedWorkType) {
  return workTypeEvidenceDetails(record, requestedWorkType).matched;
}

function topicEvidenceMatches(record, topic) {
  const requested = String(topic || '').trim().toLowerCase();
  if (!requested || /^(?:companies|professionals)$/.test(requested)) return true;
  const evidence = jobEvidence(record);
  if (!evidence) return false;

  if (/^sap(?:\s|$)/i.test(requested)) {
    const rest = requested.replace(/^sap\s*/i, '').trim();
    const literalSap = containsEvidenceTerm(evidence, 'SAP');

    if (!rest) {
      if (literalSap) return true;
      const titleEvidence = [record?.role, record?.searchProvenance?.title].filter(Boolean).join(' ');
      if (/\b(?:ABAP|FICO|S\/?4HANA|HANA|SuccessFactors|Ariba|BTP|CPI|EWM|TM|BW|BPC)\b/i.test(titleEvidence)) return true;
      const keywords = Array.isArray(record?.searchProvenance?.keywords) ? record.searchProvenance.keywords : [];
      const queryBackedModules = ['Basis', 'MM', 'SD', 'EWM', 'TM', 'BW', 'BPC', 'BTP', 'CPI', 'Security'];
      for (const module of queryBackedModules) {
        const queryRegex = new RegExp('^SAP\\s+' + evidenceRegexEscape(module) + '$', 'i');
        if (containsEvidenceTerm(titleEvidence, module)
            && keywords.some((value) => queryRegex.test(String(value)))) return true;
      }
      return false;
    }

    const knownModule = rest.match(/^(fico|mm|sd|abap|basis|s\/?4hana|successfactors|hana|bw|bpc|ariba|ewm|tm|btp|cpi|security)\b/i);
    if (!knownModule) return literalSap;

    const module = knownModule[1];
    if (/^s\/?4hana$/i.test(module)) return /\bS\/?4HANA\b/i.test(evidence);
    if (containsEvidenceTerm(evidence, module)) return true;

    const titleEvidence = [record?.role, record?.searchProvenance?.title].filter(Boolean).join(' ');
    return containsEvidenceTerm(titleEvidence, module);
  }

  if (containsEvidenceTerm(evidence, requested)) return true;
  const stop = new Set(['role', 'roles', 'job', 'jobs', 'opening', 'openings', 'position', 'positions', 'hiring', 'in', 'from', 'at', 'near']);
  const tokens = requested
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9+#.-]/g, ''))
    .filter((token) => token.length >= 2 && !stop.has(token));
  return tokens.length > 0 && tokens.every((token) => containsEvidenceTerm(evidence, token));
}

function companyFilterFailures(record, request = {}) {
  const failures = [];
  if (request.hiring && !record?.hiringVerified) failures.push('hiring');
  if (!passesEmployeeFilter(record, request.filters || {})) failures.push('employee_count');
  if (requestedLocations(request).length && !locationEvidenceMatchesRequest(record, request, {
    allowJobEvidence: Boolean(request.hiring),
    allowCompanyEvidence: request.locationScope !== 'job',
  })) failures.push('location');
  if (request.filters?.workType && !workTypeEvidenceMatches(record, request.filters.workType)) failures.push('work_type');
  if (request.hiring && request.topic && !topicEvidenceMatches(record, request.topic)) failures.push('topic');
  const companyName = String(record?.company || record?.name || '').toLowerCase();
  const companyFilters = request.companyFilters || {};
  if ((companyFilters.excludeCompanies || []).some((name) => companyName.includes(String(name).toLowerCase()))) failures.push('excluded_company');
  if ((companyFilters.includeCompanies || []).length && !(companyFilters.includeCompanies || []).some((name) => companyName.includes(String(name).toLowerCase()))) failures.push('included_company');
  if (companyFilters.industry) {
    const evidence = `${record?.companyEvidenceText || ''} ${record?.companySearchEvidenceText || ''}`;
    if (!containsEvidenceTerm(evidence, companyFilters.industry)) failures.push('industry');
  }
  if (companyFilters.startup) {
    const evidence = `${record?.companyEvidenceText || ''} ${record?.companySearchEvidenceText || ''}`;
    if (!/\bstartup\b/i.test(evidence)) failures.push('startup');
  }
  return [...new Set(failures)];
}

function passesCompanyHardFilters(record, request = {}) {
  return companyFilterFailures(record, request).length === 0;
}

function rejectedRecordSnapshot(record, reasons = [], request = {}) {
  const locationMatch = locationEvidenceDetails(record, request.location, {
    allowJobEvidence: Boolean(request.hiring),
    allowCompanyEvidence: request.locationScope !== 'job',
  });
  const jobLocation = linkedinPublic.locationFromText(record?.jobEvidenceText || '');
  const workTypeMatch = workTypeEvidenceDetails(record, request.filters?.workType);
  return {
    company: String(record?.company || record?.name || '').trim(),
    linkedin: String(record?.linkedin || '').trim(),
    role: String(record?.role || '').trim(),
    jobId: String(record?.jobId || '').trim(),
    jobUrl: String(record?.jobUrl || '').trim(),
    location: locationMatch.source === 'job'
      ? (jobLocation || locationMatch.label || request.location || '')
      : (locationMatch.label || record?.companyLocation || linkedinPublic.locationFromText(record?.companySearchEvidenceText || '') || ''),
    locationEvidenceSource: locationMatch.source || '',
    workType: workTypeMatch.value || record?.workType || detectWorkType(record?.jobEvidenceText || ''),
    workTypeEvidenceSource: workTypeMatch.source || '',
    employeeCount: record?.employeeCount || null,
    applicants: record?.applicants || '',
    relevanceScore: Number(record?.relevanceScore || 0),
    hiringSignal: String(record?.hiringSignal || '').slice(0, 1000),
    jobEvidenceText: String(record?.jobEvidenceText || '').slice(0, 2500),
    companyEvidenceText: String(record?.companyEvidenceText || record?.companySearchEvidenceText || '').slice(0, 2500),
    rejectionReasons: [...new Set((reasons || []).map((value) => String(value || '').trim()).filter(Boolean))],
    sourceEvidence: [...new Set(record?.sourceEvidence || [])],
  };
}

function mergeDuplicateRecord(target, source) {
  if (!target || !source) return target || source;
  for (const key of ['name', 'company', 'role', 'jobId', 'jobUrl', 'website', 'applicants', 'email', 'phone', 'companyLocation']) {
    if (!target[key] && source[key]) target[key] = source[key];
  }
  for (const key of ['snippet', 'hiringSignal', 'jobEvidenceText', 'companySearchEvidenceText', 'companyEvidenceText']) {
    target[key] = mergeEvidenceText(target[key], source[key], key === 'snippet' ? 5000 : 12000);
  }
  if (!target.employeeCount && source.employeeCount) target.employeeCount = source.employeeCount;
  target.hiringVerified = Boolean(target.hiringVerified || source.hiringVerified);
  target.relevanceScore = Math.max(Number(target.relevanceScore || 0), Number(source.relevanceScore || 0));
  target.sourceEvidence = [...new Set([...(target.sourceEvidence || []), ...(source.sourceEvidence || [])])];
  return target;
}

function isBudgetStop(error) {
  return /LINKEDIN_(?:BURST|HOURLY|DAILY)_CAP/.test(String(error?.code || ''));
}

function isTransientMcpFailure(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || error || '');
  return /TIMEOUT|TIMED_OUT|ECONNRESET|EPIPE|ETIMEDOUT/i.test(code)
    || /timed out|timeout|connection reset|socket hang up|temporary browser failure/i.test(message);
}

function safetyBudgetBlock(safety = policy.status()) {
  if (safety.localBudgetBypass) return null;
  const now = Date.now();
  if (safety.manualLock) return { code: 'LINKEDIN_MANUAL_LOCK', message: 'LinkedIn is locked behind a manual checkpoint.' };
  if (safety.cooldownUntil && Date.parse(safety.cooldownUntil) > now) {
    return { code: 'LINKEDIN_COOLDOWN', message: 'LinkedIn rate-limit cooldown is still active.' };
  }
  if (Number(safety.burstUsed || 0) >= Number(safety.burstMax || Infinity)) {
    return { code: 'LINKEDIN_BURST_CAP', message: 'LinkedIn short-window safety cap is still active.' };
  }
  if (Number(safety.hourlyUsed || 0) >= Number(safety.hourlyMax || Infinity)) {
    return { code: 'LINKEDIN_HOURLY_CAP', message: 'LinkedIn hourly safety cap is still active.' };
  }
  if (Number(safety.dailyUsed || 0) >= Number(safety.dailyMax || Infinity)) {
    return { code: 'LINKEDIN_DAILY_CAP', message: 'LinkedIn daily safety cap is still active.' };
  }
  return null;
}

function missionCallBudget() {
  const safety = policy.status();
  const maximum = safety.localBudgetBypass
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, Math.min(
      safety.missionToolMax,
      safety.burstMax - safety.burstUsed,
      safety.hourlyMax - safety.hourlyUsed,
      safety.dailyMax - safety.dailyUsed,
    ));
  return {
    maximum,
    used: 0,
    stopped: null,
    localBudgetBypass: Boolean(safety.localBudgetBypass),
    safetyBlock: maximum < 1 ? safetyBudgetBlock(safety) : null,
    nextEligibleAt: policy.nextEligibleAt?.() || null,
  };
}

async function budgetedCall(budget, tool, args) {
  // Always enter missionRunner.call first so cached discovery can be replayed
  // even while fresh LinkedIn calls are safety-blocked.
  try {
    const result = await missionRunner.call(tool, args, async () => {
      if (budget.used >= budget.maximum) {
        if (budget.used === 0 && budget.safetyBlock) {
          const error = new Error(budget.safetyBlock.message);
          error.code = budget.safetyBlock.code;
          error.cooldownUntil = budget.nextEligibleAt;
          error.linkedinSafetyGate = true;
          throw error;
        }
        const error = new Error('mission LinkedIn-call budget reached');
        error.code = 'LINKEDIN_LOCAL_MISSION_BUDGET';
        throw error;
      }
      const value = await mcp.callTool(tool, args);
      budget.used++;
      return value;
    });
    return result;
  } catch (error) {
    if (error?.linkedinSafetyGate) throw error;
    if (String(error?.code || '') === 'LINKEDIN_LOCAL_MISSION_BUDGET') {
      budget.stopped = budget.stopped || error.message;
      return null;
    }
    if (isBudgetStop(error)) {
      budget.stopped = error.message;
      if (missionRunner.isSafetyWaitCode?.(error.code)) {
        budget.maximum = Math.min(budget.maximum, budget.used);
        budget.safetyBlock = { code: String(error.code || 'LINKEDIN_SAFETY_WAIT'), message: String(error.message || error.code || 'LinkedIn safety wait') };
        budget.nextEligibleAt = error.cooldownUntil || policy.nextEligibleAt?.() || budget.nextEligibleAt || null;
      }
      return null;
    }
    throw error;
  }
}

function safetyGateError(budget) {
  if (!budget?.safetyBlock) return null;
  const error = new Error(budget.safetyBlock.message || 'LinkedIn safety window is unavailable.');
  error.code = budget.safetyBlock.code || 'LINKEDIN_SAFETY_WAIT';
  error.cooldownUntil = budget.nextEligibleAt || policy.nextEligibleAt?.() || null;
  error.linkedinSafetyGate = true;
  return error;
}

async function cacheAwareVerificationCall(budget, tool, args) {
  const cached = missionRunner.cachedExact?.(tool, args) || { hit: false, value: null, sourceMissionId: null };
  if (cached.hit) {
    return {
      value: cached.value,
      cacheOnly: true,
      cacheHit: true,
      sourceMissionId: cached.sourceMissionId || null,
    };
  }

  if (budget.used >= budget.maximum) {
    return {
      value: null,
      cacheOnly: true,
      cacheHit: false,
      sourceMissionId: null,
    };
  }

  const value = await budgetedCall(budget, tool, args);
  return {
    value,
    cacheOnly: false,
    cacheHit: false,
    sourceMissionId: null,
  };
}

function referenceRecord(ref, request) {
  const cleanReferenceText = String(ref?.text || '')
    .replace(/\s+\d[\d,.]*\s+followers?\s*$/i, '')
    .replace(/\s+logo\s*$/i, '')
    .trim();
  const snippet = [cleanReferenceText || ref.text, ref.context].filter(Boolean).join(' · ').trim();
  if (request.entityMode === 'company') {
    const parsed = linkedinPublic.parseResult({
      title: cleanReferenceText || ref.slug,
      snippet,
      url: ref.url,
    }, { entityMode: 'company' });
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
  const byUrl = new Map();
  const byName = new Map();
  const out = [];
  for (const record of records || []) {
    const normalized = linkedinPublic.normalizeLinkedInEntityUrl(record?.linkedin, mode);
    if (!normalized) continue;
    const secondary = String(record.company || record.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const existing = byUrl.get(normalized.url) || (secondary ? byName.get(secondary) : null);
    if (existing) {
      mergeDuplicateRecord(existing, { ...record, linkedin: normalized.url });
      continue;
    }
    const next = { ...record, linkedin: normalized.url };
    byUrl.set(normalized.url, next);
    if (secondary) byName.set(secondary, next);
    out.push(next);
  }
  return out;
}

function searchKeyword(request) {
  const topic = String(request.topic || '').trim();
  return topic && !/^(?:companies|professionals)$/i.test(topic) ? topic : (request.entityMode === 'company' ? 'technology' : 'professional');
}

function sapRoleKeywordVariants(topic) {
  const base = String(topic || '').trim();
  if (!/^sap$/i.test(base)) return leadIntent.roleVariants(base);
  return [
    'SAP Consultant',
    'SAP',
    'SAP Developer',
    'SAP Functional Consultant',
    'SAP Technical Consultant',
    'SAP FICO',
    'SAP ABAP',
    'SAP MM',
    'SAP SD',
    'SAP Basis',
    'SAP S/4HANA',
    'SAP SuccessFactors',
    'SAP BTP',
    'SAP CPI',
    'SAP EWM',
    'SAP TM',
    'SAP BW',
    'SAP HANA',
    'SAP Ariba',
    'SAP Security',
  ];
}

function jobSearchPlan(request) {
  const keywords = sapRoleKeywordVariants(searchKeyword(request));
  const allowed = requestedLocations(request);
  const preferredSource = Array.isArray(request.preferredLocations) && request.preferredLocations.length
    ? request.preferredLocations
    : allowed;
  const preferred = preferredSource.filter((item) =>
    allowed.some((allowedItem) => String(allowedItem).toLowerCase() === String(item).toLowerCase())
  );
  const roots = [...preferred, ...allowed].filter((value, index, list) =>
    list.findIndex((item) => String(item).toLowerCase() === String(value).toLowerCase()) === index
  );
  if (!roots.length && request.location) roots.push(request.location);
  if (!roots.length) roots.push('');

  const hubs = [];
  const addHub = (location, metadata = {}) => {
    if (!location) return;
    if (!hubs.some((item) => String(item.location).toLowerCase() === String(location).toLowerCase())) hubs.push({ location, ...metadata });
  };
  for (const root of roots) {
    const stages = locationExpander.stages(root, request.locationExpansion);
    const initial = stages[0] || { location: root, radiusKm: 0, expanded: false };
    const normalized = String(initial.location || '').trim().toLowerCase();
    const regional = request.locationExpansion ? [initial.location] : (LOCATION_SEARCH_HUBS[normalized] || [initial.location]);
    for (const place of regional) addHub(place, { radiusKm: initial.radiusKm || 0, expanded: false, rootLocation: root });
    for (const stage of stages.slice(1)) {
      addHub(stage.location, stage);
    }
  }

  const plan = [];
  const hardWorkTypes = leadIntent.uniq(request.filters?.workplaceTypes?.length ? request.filters.workplaceTypes : [request.filters?.workType].filter(Boolean));
  const preferredWorkTypes = !hardWorkTypes.length
    ? leadIntent.uniq(request.filters?.preferredWorkplaceTypes?.length ? request.filters.preferredWorkplaceTypes : [request.preferredWorkType].filter(Boolean))
    : [];
  const defaultWorkTypes = hardWorkTypes.length ? hardWorkTypes : (preferredWorkTypes.length ? preferredWorkTypes : [null]);
  const add = (keyword, hub, workType = defaultWorkTypes[0] || null) => {
    const loc = typeof hub === 'object' ? hub.location : hub;
    const key = String(keyword || '').trim().toLowerCase() + '|' + String(loc || '').trim().toLowerCase() + '|' + String(workType || '').trim().toLowerCase();
    if (!keyword || plan.some((item) => item.key === key)) return;
    plan.push({
      key,
      keyword: String(keyword).trim(),
      location: String(loc || '').trim() || null,
      workType: workType || null,
      radiusKm: Number(typeof hub === 'object' ? hub.radiusKm || 0 : 0),
      expanded: Boolean(typeof hub === 'object' && hub.expanded),
      rootLocation: typeof hub === 'object' ? hub.rootLocation || null : null,
    });
  };

  // Search preferences first.
  for (const hub of hubs) for (const workType of defaultWorkTypes) add(keywords[0], hub, workType);

  // Preferences are not hard filters. Add broader equivalents so the adaptive
  // strategist can relax them when preferred queries underperform.
  if (preferredWorkTypes.length) {
    for (const hub of hubs) add(keywords[0], hub, null);
  }

  const broadLocations = roots.filter(Boolean);
  for (const keyword of keywords.slice(1)) {
    for (const root of broadLocations.length ? broadLocations : [null]) {
      const hub = hubs.find((item) => String(item.location).toLowerCase() === String(root).toLowerCase()) || { location: root };
      for (const workType of defaultWorkTypes) add(keyword, hub, workType);
      if (preferredWorkTypes.length) add(keyword, hub, null);
      if (plan.length >= 30) break;
    }
    if (plan.length >= 30) break;
  }

  return plan.slice(0, 20).map(({ key, ...item }) => item);
}

function droppedSearchFilters(result) {
  const warning = result?.section_errors?.search_results || null;
  const text = `${warning?.error_type || ''} ${warning?.error_message || ''}`.toLowerCase();
  if (!/filters?_dropped|did not keep/.test(text)) return new Set();
  const dropped = new Set();
  const rules = [
    ['location', /\blocation\b/],
    ['work_type', /\bwork[_ ]?type\b|\bworkplace\b|\bf_wt\b/],
    ['date_posted', /\bdate[_ ]?posted\b|\bposting date\b|\bf_tpr\b/],
    ['job_type', /\bjob[_ ]?type\b|\bf_jt\b/],
    ['experience_level', /\bexperience[_ ]?level\b|\bf_e\b/],
    ['easy_apply', /\beasy[_ ]?apply\b|\bf_ea\b/],
  ];
  for (const [name, regex] of rules) if (regex.test(text)) dropped.add(name);
  return dropped;
}

function searchFilterTrust(result, step, request) {
  const dropped = droppedSearchFilters(result);
  const requestedWorkType = step?.workType || request?.filters?.workType || request?.preferredWorkType || '';
  return {
    dropped: [...dropped],
    trustedLocation: step?.location && !dropped.has('location') ? String(step.location) : '',
    trustedWorkType: requestedWorkType && !dropped.has('work_type') ? String(requestedWorkType) : '',
  };
}

function jobReferenceMap(result) {
  const map = new Map();
  for (const ref of collectReferences(result)) {
    const match = String(ref.url || '').match(/\/jobs\/view\/(?:[^\d/]*-)?(\d{6,})/i);
    if (!match) continue;
    const id = match[1];
    const current = map.get(id) || { id, title: '', context: '', url: '' };
    if (!current.title && ref.text) current.title = String(ref.text).trim();
    if (!current.context && ref.context) current.context = String(ref.context).trim();
    if (!current.url && ref.url) current.url = absoluteLinkedInUrl(ref.url);
    map.set(id, current);
  }
  return map;
}

function searchLocationMatches(trustedValue, requestedValue) {
  const trusted = String(trustedValue || '').trim().toLowerCase();
  const requested = String(requestedValue || '').trim().toLowerCase();
  if (!trusted || !requested) return false;
  if (requested === 'india') return true;
  const hubs = (LOCATION_SEARCH_HUBS[requested] || [requested])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  return hubs.some((hub) => trusted === hub || trusted.includes(hub) || hub.includes(trusted));
}

function jobIdPriority(meta = {}, request = {}) {
  let score = 0;
  const title = String(meta.title || '');
  const keyword = String(meta.bestKeyword || '');
  const trustedLocations = (Array.isArray(meta.trustedLocations) ? meta.trustedLocations : []).map((value) => String(value).trim().toLowerCase());
  const trustedWorkTypes = (Array.isArray(meta.trustedWorkTypes) ? meta.trustedWorkTypes : []).map((value) => String(value).trim().toLowerCase());
  const allowedLocations = requestedLocations(request).map((value) => String(value).trim().toLowerCase());
  const preferredLocations = (Array.isArray(request.preferredLocations) ? request.preferredLocations : []).map((value) => String(value).trim().toLowerCase());

  if (/\bSAP\b/i.test(title)) score += 60;
  if (/\b(?:FICO|ABAP|S\/4HANA|S4HANA|SuccessFactors|Basis|BTP|CPI|EWM|TM|BW|HANA|Ariba)\b/i.test(title)) score += 18;
  if (/\bSAP\b/i.test(keyword)) score += 8;
  if (/\b(?:FICO|ABAP|MM|SD|Basis|S\/4HANA|SuccessFactors|BTP|CPI|EWM|TM|BW|HANA|Ariba)\b/i.test(keyword)) score += 10;

  if (trustedLocations.some((value) => allowedLocations.some((allowed) => searchLocationMatches(value, allowed)))) score += 18;
  if (trustedLocations.some((value) => preferredLocations.some((preferred) => searchLocationMatches(value, preferred)))) score += 10;

  const preferredRemote = String(request.preferredWorkType || '').toLowerCase() === 'remote';
  const hardRemote = String(request.filters?.workType || '').toLowerCase() === 'remote';
  if (trustedWorkTypes.includes('remote')) score += hardRemote ? 14 : (preferredRemote ? 10 : 4);

  score += Math.max(0, Number(meta.hits || 1) - 1) * 12;
  score += Math.max(0, 12 - Number(meta.firstRank || 12));
  return score;
}

function searchTopicConfidence(meta = {}, request = {}) {
  const topic = String(request.topic || '').trim();
  if (!/^SAP(?:\s|$)/i.test(topic)) return 1;
  const evidence = [meta.title, ...(meta.contexts || [])].filter(Boolean).join(' ');
  if (!evidence.trim()) return 1;
  return /\bSAP\b|\bABAP\b|\bFICO\b|S\/?4HANA|SuccessFactors?|\bAriba\b|\bBTP\b|\bCPI\b|\bEWM\b|\bHANA\b|\bSAP\s+(?:MM|SD|TM|BW|Basis|Security)\b/i.test(evidence)
    ? 2
    : 0;
}

function prioritizedJobIds(jobMeta, request = {}) {
  return [...jobMeta.values()]
    .sort((a, b) =>
      searchTopicConfidence(b, request) - searchTopicConfidence(a, request)
      || jobIdPriority(b, request) - jobIdPriority(a, request)
      || Number(a.firstSeen || 0) - Number(b.firstSeen || 0))
    .map((item) => item.id);
}

function verificationReadyJobIds(jobMeta, request = {}, previouslyChecked = new Set(), destinationJobIds = new Set()) {
  return prioritizedJobIds(jobMeta, request).filter((jobId) =>
    !previouslyChecked.has(String(jobId))
    && !destinationJobIds.has(String(jobId))
    && searchTopicConfidence(jobMeta.get(jobId) || {}, request) > 0
  );
}

function jobLevelFailures(record, request = {}) {
  const failures = [];
  if (request.hiring && !record?.hiringVerified) failures.push('hiring');
  if (request.hiring && indirectEmployerPosting(record?.jobEvidenceText)) failures.push('employer_identity');
  if (requestedLocations(request).length && !locationEvidenceMatchesRequest(record, request, {
    allowJobEvidence: true,
    allowCompanyEvidence: request.locationScope === 'company',
  })) failures.push('location');
  const hardWorkTypes = leadIntent.uniq(request.filters?.workplaceTypes?.length ? request.filters.workplaceTypes : [request.filters?.workType].filter(Boolean));
  if (hardWorkTypes.length) {
    if (!hardWorkTypes.some((workType) => workTypeEvidenceMatches(record, workType))) failures.push('work_type');
  }
  if (request.hiring && request.topic && !topicEvidenceMatches(record, request.topic)) failures.push('topic');
  if (request.filters?.postingAge) {
    const age = leadIntent.postedAgeDays(record?.jobEvidenceText || '');
    const spec = request.filters.postingAge;
    if (spec.preset === 'custom') {
      const date = leadIntent.postedDate(record?.jobEvidenceText || '');
      if (!date || date < spec.from || date > spec.to) failures.push('posting_age');
    } else if (age == null
      || (spec.minAgeDays != null && age < spec.minAgeDays)
      || (spec.maxAgeDays != null && age > spec.maxAgeDays)) failures.push('posting_age');
  }
  if (request.filters?.applicantMax != null) {
    const count = leadIntent.applicantNumber(record?.applicants);
    if (count == null || count >= Number(request.filters.applicantMax)) failures.push('applicant_count');
  }
  return [...new Set(failures)];
}

function activeJobPosting(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  return !/\b(?:no longer accepting applications|not accepting applications|job (?:is )?no longer available|job has expired|posting has expired|position has been filled|applications? (?:are )?closed|role (?:is )?closed|vacancy (?:is )?closed)\b/i.test(value);
}

function jobTitleFromDetail(detail, fallback = '') {
  const cleanFallback = String(fallback || '').replace(/\s+with verification\s*$/i, '').trim();
  if (cleanFallback) return cleanFallback;
  const raw = String(detail?.sections?.job_posting || '').trim();
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const ignored = /^(?:about the job|job description|show more|save|apply|easy apply)$/i;
  const companyNames = new Set(linkedInReferences(detail, 'company')
    .map((ref) => String(ref.text || '').replace(/\s+\d[\d,.]*\s+followers?\s*$/i, '').trim().toLowerCase())
    .filter(Boolean));
  const title = lines.find((line) => line.length >= 3
    && line.length <= 140
    && !ignored.test(line)
    && !companyNames.has(line.toLowerCase())
    && !/^https?:\/\//i.test(line));
  return title || '';
}

function joeyismJobToDetail(job, jobId = '') {
  if (!job || typeof job !== 'object') return null;
  const companyUrl = String(job.company_linkedin_url || '').trim();
  const lines = [
    job.job_title,
    job.company,
    job.location,
    job.posted_date,
    job.applicant_count,
    job.job_description,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  if (!lines.length) return null;
  const result = {
    url: String(job.linkedin_url || (jobId ? `https://www.linkedin.com/jobs/view/${jobId}` : '')).trim(),
    sections: { job_posting: lines.join('\n') },
    references: {},
    structuredFallback: true,
  };
  if (companyUrl) {
    result.references.job_posting = [{
      kind: 'company',
      url: companyUrl,
      text: String(job.company || '').trim(),
      context: 'job posting',
    }];
  }
  return result;
}

function joeyismCompanyText(company) {
  if (!company || typeof company !== 'object') return '';
  return [
    company.name,
    company.about_us,
    company.company_size ? `Company size: ${company.company_size}` : '',
    company.headquarters ? `Headquarters: ${company.headquarters}` : '',
    company.industry ? `Industry: ${company.industry}` : '',
    company.website ? `Website: ${company.website}` : '',
    company.phone ? `Phone: ${company.phone}` : '',
  ].filter(Boolean).join('\n');
}

function shouldPropagateFallbackError(error) {
  const code = String(error?.code || '');
  const kind = String(error?.linkedinSafety?.kind || '');
  return /LINKEDIN_(?:COOLDOWN_ACTIVE|MANUAL_LOCK|BURST_CAP|HOURLY_CAP|DAILY_CAP)/.test(code)
    || /^(?:rate-limit|manual-lock)$/.test(kind);
}

async function optionalStructuredJobFallback(budget, jobId) {
  if (!joeyism.enabled() || budget.used >= budget.maximum) return null;
  try {
    const job = await joeyism.call('job', {
      job_id: String(jobId),
      url: `https://www.linkedin.com/jobs/view/${jobId}`,
    });
    budget.used++;
    return joeyismJobToDetail(job, jobId);
  } catch (error) {
    if (shouldPropagateFallbackError(error)) throw error;
    return null;
  }
}

async function optionalStructuredCompanyFallback(budget, linkedinUrl) {
  if (!joeyism.enabled() || budget.used >= budget.maximum || !linkedinUrl) return null;
  try {
    const company = await joeyism.call('company', { url: linkedinUrl });
    budget.used++;
    return company;
  } catch (error) {
    if (shouldPropagateFallbackError(error)) throw error;
    return null;
  }
}

async function callPrimaryWithExactFallback(tool, args, fallback = null) {
  try {
    return await missionRunner.call(tool, args, () => mcp.callTool(tool, args));
  } catch (error) {
    const eligible = fallback && joeyism.enabled()
      && /LINKEDIN_MCP_|auth|session|browser|profile/i.test(`${error.code || ''} ${error.message || ''}`);
    if (!eligible) throw error;
    return joeyism.call(fallback.action, fallback.args);
  }
}

function criteriaSignature(request = {}) {
  const filters = request.filters || {};
  return JSON.stringify({
    entityMode: request.entityMode || '',
    topic: String(request.topic || '').trim().toLowerCase(),
    location: String(request.location || '').trim().toLowerCase(),
    locationScope: request.locationScope || '',
    hiring: Boolean(request.hiring),
    employeeMin: filters.employeeMin ?? null,
    employeeMax: filters.employeeMax ?? null,
    workType: filters.workType || null,
    jobType: filters.jobType || null,
    experienceLevel: filters.experienceLevel || null,
    datePosted: filters.datePosted || null,
    easyApply: Boolean(filters.easyApply),
  });
}

function previousCheckedJobIds(request = {}) {
  const signature = criteriaSignature(request);
  const ids = new Set();
  for (const mission of loadState().missions || []) {
    if (mission?.status !== 'completed') continue;
    if (criteriaSignature(mission.request || {}) !== signature) continue;
    for (const id of mission?.toolCalls?.checkedJobIds || []) {
      const value = String(id || '').trim();
      if (value) ids.add(value);
    }
  }
  return ids;
}

function reconsiderRejectedCandidates(request = {}) {
  if (request.reuseCachedEvidence === false) return [];
  const topic = String(request.topic || '').trim().toLowerCase();
  const state = loadState();
  const byKey = new Map();
  const now = Date.now();
  const freshnessMs = 7 * 24 * 60 * 60 * 1000;
  for (const mission of state.missions || []) {
    if (mission?.status !== 'completed' || mission?.request?.entityMode !== 'company') continue;
    if (String(mission.request?.topic || '').trim().toLowerCase() !== topic) continue;
    const completedAt = Date.parse(mission.completedAt || mission.createdAt || '');
    if (!request.continueFromPrevious && Number.isFinite(completedAt) && now - completedAt > freshnessMs) continue;
    for (const rejected of mission.rejectedRecords || []) {
      if (!rejected?.jobUrl || !rejected?.linkedin) continue;
      const record = {
        entityType: 'company',
        company: rejected.company || '',
        linkedin: rejected.linkedin || '',
        role: rejected.role || '',
        jobId: rejected.jobId || '',
        jobUrl: rejected.jobUrl || '',
        location: rejected.location || '',
        locationEvidenceSource: rejected.locationEvidenceSource || '',
        workType: rejected.workType || '',
        workTypeEvidenceSource: rejected.workTypeEvidenceSource || '',
        employeeCount: rejected.employeeCount || null,
        applicants: rejected.applicants || '',
        relevanceScore: Number(rejected.relevanceScore || 0),
        hiringSignal: rejected.hiringSignal || '',
        jobEvidenceText: rejected.jobEvidenceText || '',
        companyEvidenceText: rejected.companyEvidenceText || '',
        sourceEvidence: [...new Set([...(rejected.sourceEvidence || []), 'cross-mission-reconsidered'])],
      };
      if (!request.allowPreviouslySeenCompanies && finalMaster.seen(record)) continue;
      if (companyFilterFailures(record, request).length) continue;
      const key = finalMaster.companyKey(record);
      if (!key) continue;
      const previous = byKey.get(key);
      if (!previous || record.relevanceScore > previous.relevanceScore) byKey.set(key, record);
    }
  }
  return [...byKey.values()];
}

async function companyMission(request) {
  const reconsidered = reconsiderRejectedCandidates(request);
  const records = reconsidered.slice();
  const budget = missionCallBudget();
  if (request.resumeExistingPool && !budget.localBudgetBypass) {
    // Normal mode stays safety-bounded. Explicit emergency/local-budget bypass
    // must never be silently turned back off by resume logic.
    budget.maximum = Math.min(budget.maximum, Number(policy.settings().burstMax || 12));
  }
  // Zero live-call budget does not mean zero useful work. Rejected candidates
  // and compatible saved discovery may still satisfy part or all of the mission.
  // Fresh MCP calls will be blocked inside budgetedCall until the safety window reopens.

  let jobDetails = 0;
  let jobIdsDiscovered = 0;
  let jobCandidatesLinked = 0;
  let jobCandidatesPassed = 0;
  let deepProfiles = 0;
  let verifiedDuringRun = 0;
  let cachedJobDetailHits = 0;
  let cachedJobDetailMisses = 0;
  let cachedCompanyProfileHits = 0;
  let cachedCompanyProfileMisses = 0;
  const searchCalls = [];
  const searchWarnings = [];
  const jobMeta = new Map();
  const profileCheckedCompanies = new Map();
  const checkedJobIds = [];
  const previouslyChecked = request.continueFromPrevious ? previousCheckedJobIds(request) : new Set();
  // These metrics are reported after the hiring branch, so they must exist at
  // function scope even when all verification work is cache-only.
  const destinationJobIds = new Set((request.existingDestinationJobIds || []).map((value) => String(value)));
  const destinationCompanyKeys = new Set((request.existingDestinationCompanyKeys || []).map((value) => String(value)));
  let weakLiveDeferred = 0;
  let searchStrategiesExhausted = false;
  const acceptedCompanies = new Set(
    reconsidered.map((record) => finalMaster.companyKey(record)).filter(Boolean)
  );
  verifiedDuringRun = acceptedCompanies.size;

  if (request.hiring) {
    const plan = jobSearchPlan(request);
    const normalSearchAllowance = budget.localBudgetBypass
      ? plan.length
      : Math.min(plan.length, queryStrategist.searchAllowance(budget, Math.max(0, request.count - acceptedCompanies.size)));
    // LinkedIn can return broad promoted jobs even when its page claims the SAP
    // keyword was retained. Reserve at least three calls for verification, but
    // spend at most two searches so a ten-company run retains ten verification calls.
    const sapSearch = /^SAP(?:\s|$)/i.test(String(request.topic || ''));
    const adaptiveSearchAllowance = sapSearch && budget.maximum >= 5
      ? Math.min(plan.length, 2, Math.max(normalSearchAllowance, budget.maximum - 3))
      : normalSearchAllowance;
    // Even with zero fresh-call budget, enter one search step. missionRunner.call
    // will replay saved discovery at zero cost; if no cache exists, budgetedCall
    // raises the real safety gate and the mission parks instead of completing 0/target.
    const liveSearchAllowance = budget.maximum < 1 ? 1 : adaptiveSearchAllowance;
    const maxSearchSteps = acceptedCompanies.size >= request.count ? 0 : plan.length;
    let liveSearches = 0;
    let freshSearchDeferredForVerification = 0;

    for (let searchIndex = 0; searchIndex < maxSearchSteps; searchIndex++) {
      const step = queryStrategist.selectNext(plan, {
        history: searchCalls,
        preferredLocations: request.preferredLocations || requestedLocations(request),
        topic: request.topic,
      });
      if (!step) break;
      const uniqueBefore = jobMeta.size;
      const searchArgs = {
        keywords: step.keyword,
        location: step.location || undefined,
        max_pages: budget.localBudgetBypass ? Math.max(2, Math.min(3, policy.settings().maxJobPages + 1)) : policy.settings().maxJobPages,
        date_posted: request.filters?.datePosted || undefined,
        job_type: request.filters?.jobType || undefined,
        experience_level: request.filters?.experienceLevel || undefined,
        work_type: step.workType || request.filters?.workType || request.preferredWorkType || undefined,
        easy_apply: Boolean(request.filters?.easyApply),
        sort_by: 'relevance',
      };
      const cachedSearch = Boolean(missionRunner.cachedExact?.('search_jobs', searchArgs, { recordHit: false })?.hit);
      if (!cachedSearch) {
        const ready = verificationReadyJobIds(jobMeta, request, previouslyChecked, destinationJobIds);
        const remaining = Math.max(1, request.count - acceptedCompanies.size);
        const reserveThreshold = Math.max(4, Math.min(12, remaining * 2));
        if (ready.length >= reserveThreshold) {
          freshSearchDeferredForVerification++;
          break;
        }
      }
      if (!cachedSearch && liveSearches >= liveSearchAllowance) break;
      const budgetBeforeSearch = Number(budget.used || 0);
      let result;
      try {
        result = await budgetedCall(budget, 'search_jobs', searchArgs);
        if (Number(budget.used || 0) > budgetBeforeSearch) liveSearches++;
      } catch (error) {
        if (!isTransientMcpFailure(error)) throw error;
        searchWarnings.push({
          keyword: step.keyword,
          location: step.location,
          error_type: 'transient_timeout',
          error_message: error.message,
        });
        missionRunner.updateProgress({
          phase: 'searching',
          transientFailures: Number(missionRunner.active()?.progress?.transientFailures || 0) + 1,
          lastTransientFailure: 'search_jobs',
          budgetUsed: budget.used,
          budgetMaximum: budget.maximum,
        });
        continue;
      }
      if (!result) break;

      const ids = jobIdsFromResult(result);
      const refs = jobReferenceMap(result);
      const warning = result?.section_errors?.search_results || null;
      const trust = searchFilterTrust(result, step, request);
      if (warning?.error_message) {
        searchWarnings.push({ keyword: step.keyword, location: step.location, ...warning });
      }

      ids.forEach((id, rank) => {
        const ref = refs.get(id) || {};
        const current = jobMeta.get(id) || {
          id,
          title: '',
          hits: 0,
          locations: [],
          trustedLocations: [],
          trustedWorkTypes: [],
          keywords: [],
          contexts: [],
          searches: [],
          bestKeyword: '',
          firstRank: rank,
          firstSeen: jobMeta.size,
        };
        current.hits += 1;
        current.firstRank = Math.min(Number(current.firstRank ?? rank), rank);
        if (!current.title && ref.title) current.title = ref.title;
        if (ref.context && !current.contexts.includes(String(ref.context))) current.contexts.push(String(ref.context));
        if (step.location && !current.locations.includes(step.location)) current.locations.push(step.location);
        if (trust.trustedLocation && !current.trustedLocations.includes(trust.trustedLocation)) current.trustedLocations.push(trust.trustedLocation);
        if (trust.trustedWorkType && !current.trustedWorkTypes.includes(trust.trustedWorkType)) current.trustedWorkTypes.push(trust.trustedWorkType);
        if (step.keyword && !current.keywords.includes(step.keyword)) current.keywords.push(step.keyword);
        current.searches.push({
          keyword: step.keyword,
          location: step.location || '',
          requestedWorkType: step.workType || request.filters?.workType || request.preferredWorkType || '',
          trustedLocation: trust.trustedLocation,
          trustedWorkType: trust.trustedWorkType,
          dropped: trust.dropped,
        });
        if (!current.bestKeyword || String(step.keyword).length > String(current.bestKeyword).length) current.bestKeyword = step.keyword;
        jobMeta.set(id, current);
      });

      searchCalls.push({
        keyword: step.keyword,
        location: step.location,
        jobIds: ids.length,
        uniqueJobIds: jobMeta.size,
        uniqueJobIdsAdded: Math.max(0, jobMeta.size - uniqueBefore),
        trustedLocation: trust.trustedLocation || null,
        trustedWorkType: trust.trustedWorkType || null,
        droppedFilters: trust.dropped,
        warning: warning?.error_type || null,
        workType: step.workType || null,
        radiusKm: Number(step.radiusKm || 0),
        expanded: Boolean(step.expanded),
        rootLocation: step.rootLocation || null,
        cached: cachedSearch && Number(budget.used || 0) === budgetBeforeSearch,
      });
      missionRunner.updateProgress({
        phase: 'searching',
        searchesCompleted: searchCalls.length,
        uniqueJobIds: jobMeta.size,
        cachedReconsidered: reconsidered.length,
        verifiedCompanies: acceptedCompanies.size,
        remaining: Math.max(0, request.count - acceptedCompanies.size),
        budgetUsed: budget.used,
        budgetMaximum: budget.maximum,
        cachedJobDetailHits,
        cachedJobDetailMisses,
        cachedCompanyProfileHits,
        cachedCompanyProfileMisses,
      });
    }

    jobIdsDiscovered = jobMeta.size;
    request.transientJobAttempts = { ...(request.transientJobAttempts || {}) };
    request.transientCompanyAttempts = { ...(request.transientCompanyAttempts || {}) };
    // Verify every fresh cached detail before spending an account call. Cache
    // probes do not increment hit counters; consumption records the actual hit.
    const cachedDetailIds = new Set([...jobMeta.keys()].filter(jobId =>
      missionRunner.cachedExact?.('get_job_details', { job_id: jobId }, { recordHit: false })?.hit));
    const availableJobIds = prioritizedJobIds(jobMeta, request)
      .filter((jobId) => !previouslyChecked.has(String(jobId)) && !destinationJobIds.has(String(jobId)));

    const cachedOrdered = availableJobIds.filter((jobId) => cachedDetailIds.has(jobId));
    const liveStrong = availableJobIds.filter((jobId) =>
      !cachedDetailIds.has(jobId) && searchTopicConfidence(jobMeta.get(jobId) || {}, request) > 0);
    const liveWeak = availableJobIds.filter((jobId) =>
      !cachedDetailIds.has(jobId) && searchTopicConfidence(jobMeta.get(jobId) || {}, request) === 0);
    const strictSearchTopic = /^SAP(?:\s|$)/i.test(String(request.topic || ''));
    const strongEnough = liveStrong.length >= Math.max(request.count * 2, request.count + 5);
    // A retained search keyword is not job-level topic evidence. For SAP
    // missions, never spend account calls opening a title with zero SAP signal.
    const orderedJobIds = [...cachedOrdered, ...liveStrong, ...(!strictSearchTopic && !strongEnough ? liveWeak : [])]
      .sort((left, right) =>
        Number(cachedDetailIds.has(right)) - Number(cachedDetailIds.has(left))
        || searchTopicConfidence(jobMeta.get(right) || {}, request) - searchTopicConfidence(jobMeta.get(left) || {}, request)
        || Number(request.transientJobAttempts[String(left)] || 0)
        - Number(request.transientJobAttempts[String(right)] || 0)
        || jobIdPriority(jobMeta.get(right) || {}, request) - jobIdPriority(jobMeta.get(left) || {}, request)
      );
    weakLiveDeferred = strictSearchTopic || strongEnough ? liveWeak.length : 0;
    searchStrategiesExhausted = searchCalls.length >= plan.length
      && liveSearches === 0
      && orderedJobIds.length === 0;
    let verificationCandidatesProcessed = 0;
    missionRunner.updateProgress({
      phase: 'verifying_jobs',
      verificationCandidatesQueued: orderedJobIds.length,
      verificationCandidatesRemaining: orderedJobIds.length,
      freshSearchDeferredForVerification,
    });

    for (const jobId of orderedJobIds) {
      if (acceptedCompanies.size >= request.count) break;
      verificationCandidatesProcessed++;

      let detail;
      try {
        const fetched = await cacheAwareVerificationCall(budget, 'get_job_details', { job_id: jobId });
        if (fetched.cacheOnly) {
          if (fetched.cacheHit) cachedJobDetailHits++;
          else {
            cachedJobDetailMisses++;
            continue;
          }
        }
        detail = fetched.value;
      } catch (error) {
        if (!isTransientMcpFailure(error)) throw error;
        const transientKey = String(jobId);
        const attempts = Number(request.transientJobAttempts[transientKey] || 0) + 1;
        request.transientJobAttempts[transientKey] = attempts;

        // Give a timed-out candidate one later-batch retry, but never let one
        // pathological job block the whole mission forever.
        if (attempts >= 2) checkedJobIds.push(transientKey);

        missionRunner.updateProgress({
          phase: 'verifying_jobs',
          uniqueJobIds: jobMeta.size,
          jobDetailsChecked: jobDetails,
          transientFailures: Number(missionRunner.active()?.progress?.transientFailures || 0) + 1,
          deferredJobCandidates: Object.values(request.transientJobAttempts).filter((count) => Number(count) < 2).length,
          lastTransientFailure: 'get_job_details',
          lastTimedOutJobId: transientKey,
          lastTimedOutJobAttempt: attempts,
          verifiedCompanies: acceptedCompanies.size,
          remaining: Math.max(0, request.count - acceptedCompanies.size),
          budgetUsed: budget.used,
          budgetMaximum: budget.maximum,
        });
        continue;
      }
      if (!detail) {
        if (budget.used >= budget.maximum) continue;
        break;
      }
      jobDetails++;
      checkedJobIds.push(String(jobId));
      missionRunner.updateProgress({
        phase: 'verifying_jobs',
        uniqueJobIds: jobMeta.size,
        jobDetailsChecked: jobDetails,
        companiesLinked: jobCandidatesLinked,
        verifiedCompanies: acceptedCompanies.size,
        remaining: Math.max(0, request.count - acceptedCompanies.size),
        budgetUsed: budget.used,
        budgetMaximum: budget.maximum,
        cachedJobDetailHits,
        cachedJobDetailMisses,
        cachedCompanyProfileHits,
        cachedCompanyProfileMisses,
        verificationCandidatesQueued: orderedJobIds.length,
        verificationCandidatesRemaining: Math.max(0, orderedJobIds.length - verificationCandidatesProcessed),
      });

      let detailText = flattenText(detail);
      let companyRefs = linkedInReferences(detail, 'company');
      let preferred = companyRefs.find((ref) => /job posting|job/i.test(String(ref.context || '')))
        || companyRefs.find((ref) => String(ref.kind || '').toLowerCase() === 'company')
        || companyRefs[0];
      let structuredFallbackUsed = false;

      if (!preferred && joeyism.enabled()) {
        const fallbackDetail = await optionalStructuredJobFallback(budget, jobId);
        if (fallbackDetail) {
          structuredFallbackUsed = true;
          detail = fallbackDetail;
          detailText = flattenText(detail);
          companyRefs = linkedInReferences(detail, 'company');
          preferred = companyRefs.find((ref) => /job posting|job/i.test(String(ref.context || '')))
            || companyRefs[0];
        }
      }
      if (!preferred) continue;

      const record = referenceRecord(preferred, request);
      if (!record) continue;

      const meta = jobMeta.get(jobId) || {};
      record.jobId = String(jobId);
      record.jobUrl = `https://www.linkedin.com/jobs/view/${jobId}`;
      record.role = jobTitleFromDetail(detail, meta.title || '');
      record.jobEvidenceText = detailText;
      record.hiringSignal = detailText.slice(0, 1000) || `Verified LinkedIn job ${jobId}.`;
      record.hiringVerified = Boolean(detailText && preferred && activeJobPosting(detailText));
      record.workType = detectWorkType(detailText);
      record.applicants = applicantCountFromDetail(detail, record.company);
      record.posted = postedEvidenceFromText(detailText);
      record.relevanceScore = qualityScore(record, request, { hiring: record.hiringVerified, deep: true });
      record.searchProvenance = {
        title: meta.title || '',
        hits: Number(meta.hits || 0),
        keywords: meta.keywords || [],
        locations: meta.locations || [],
        trustedLocations: meta.trustedLocations || [],
        trustedWorkTypes: meta.trustedWorkTypes || [],
        searches: meta.searches || [],
        priority: jobIdPriority(meta),
      };
      record.sourceEvidence = [...new Set([...(record.sourceEvidence || []), `linkedin-job-${jobId}`, 'linkedin-job-detail'])];
      const embeddedCompanyEvidence = companyEvidenceFromJobDetail(detail);
      if (embeddedCompanyEvidence) {
        record.companyEvidenceText = embeddedCompanyEvidence;
        record.employeeCount = employeeCountFromText(embeddedCompanyEvidence) || record.employeeCount || null;
        record.companyLocation = linkedinPublic.locationFromText(embeddedCompanyEvidence) || record.companyLocation || '';
        record.website = websiteFromText(embeddedCompanyEvidence) || record.website || '';
        record.sourceEvidence = [...new Set([...(record.sourceEvidence || []), 'linkedin-job-company-section'])];
      }
      jobCandidatesLinked++;

      let jobFailures = jobLevelFailures(record, request);
      if (jobFailures.length && joeyism.enabled() && !structuredFallbackUsed && budget.used < budget.maximum) {
        const fallbackDetail = await optionalStructuredJobFallback(budget, jobId);
        if (fallbackDetail) {
          structuredFallbackUsed = true;
          const fallbackText = flattenText(fallbackDetail);
          const fallbackRefs = linkedInReferences(fallbackDetail, 'company');
          const fallbackCompany = fallbackRefs.find((ref) => /job posting|job/i.test(String(ref.context || ''))) || fallbackRefs[0];
          record.jobEvidenceText = mergeEvidenceText(record.jobEvidenceText, fallbackText, 16000);
          record.hiringSignal = mergeEvidenceText(record.hiringSignal, fallbackText.slice(0, 1200), 2200);
          record.role = jobTitleFromDetail(fallbackDetail, record.role || meta.title || '');
          record.workType = detectWorkType(record.jobEvidenceText);
          record.applicants = record.applicants || applicantCountFromDetail(fallbackDetail, fallbackCompany?.text || record.company);
          record.posted = record.posted || postedEvidenceFromText(fallbackText);
          record.sourceEvidence = [...new Set([...(record.sourceEvidence || []), 'joeyism-structured-job-fallback'])];

          if (fallbackCompany) {
            const fallbackRecord = referenceRecord(fallbackCompany, request);
            if (fallbackRecord?.linkedin && !record.linkedin) record.linkedin = fallbackRecord.linkedin;
            if (fallbackRecord?.company && !record.company) record.company = fallbackRecord.company;
          }
          jobFailures = jobLevelFailures(record, request);
        }
      }

      if (jobFailures.length) {
        record.preProfileFailures = jobFailures;
        records.push(record);
        continue;
      }

      jobCandidatesPassed++;

      // A company already present in the destination Sheet or canonical
      // master cannot contribute to a new-company target. Exclude it before
      // spending a company-profile verification call.
      const destinationKey = finalMaster.companyKey(record);
      if (!request.allowPreviouslySeenCompanies && (
        finalMaster.inMaster(record)
        || (destinationKey && destinationCompanyKeys.has(destinationKey))
      )) {
        record.globalSeen = true;
        continue;
      }

      const normalizedCompany = linkedinPublic.normalizeLinkedInEntityUrl(record.linkedin, 'company');
      const companyKey = normalizedCompany?.slug || String(record.company || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!companyKey) {
        records.push(record);
        continue;
      }

      const existingCompany = profileCheckedCompanies.get(companyKey);
      if (existingCompany) {
        // Another individually-valid SAP job at a company we already checked.
        // Keep the stronger job evidence without paying for the profile twice.
        if (Number(record.relevanceScore || 0) > Number(existingCompany.relevanceScore || 0)) {
          mergeDuplicateRecord(existingCompany, record);
        }
        continue;
      }

      if (companyProfileRequired(record, request)) try {
        const fetched = await cacheAwareVerificationCall(
          budget,
          'get_company_profile',
          { company_name: normalizedCompany?.slug || record.company },
        );
        if (fetched.cacheOnly) {
          if (fetched.cacheHit) cachedCompanyProfileHits++;
          else {
            cachedCompanyProfileMisses++;
            records.push(record);
            continue;
          }
        }
        const deep = fetched.value;
        if (!deep) {
          records.push(record);
          if (budget.used >= budget.maximum) continue;
          break;
        }
        deepProfiles++;
        const text = flattenText(deep);
        record.companyEvidenceText = text;
        record.snippet = [record.snippet, text.slice(0, 3500)].filter(Boolean).join('\n').slice(0, 5000);
        record.website = websiteFromText(text);
        record.email = '';
        record.phone = '';
        record.employeeCount = employeeCountFromText(text) || record.employeeCount || null;
        record.companyLocation = linkedinPublic.locationFromText(text) || '';
        record.applicants = record.applicants || applicantCountFromText(record.jobEvidenceText, record.company);
        record.relevanceScore = qualityScore(record, request, { hiring: true, deep: true });
        record.sourceEvidence = [...new Set([...(record.sourceEvidence || []), 'linkedin-account-company-profile'])];

        const needsCompanySize = request.filters?.employeeMin != null || request.filters?.employeeMax != null;
        if (needsCompanySize && !record.employeeCount && joeyism.enabled() && budget.used < budget.maximum) {
          const fallbackCompany = await optionalStructuredCompanyFallback(budget, record.linkedin);
          if (fallbackCompany) {
            const fallbackText = joeyismCompanyText(fallbackCompany);
            record.companyEvidenceText = mergeEvidenceText(record.companyEvidenceText, fallbackText, 16000);
            record.employeeCount = employeeCountFromText(String(fallbackCompany.company_size || ''))
              || employeeCountFromText(fallbackText)
              || record.employeeCount;
            record.companyLocation = record.companyLocation || String(fallbackCompany.headquarters || '').trim();
            record.website = record.website || String(fallbackCompany.website || '').trim();
            record.sourceEvidence = [...new Set([...(record.sourceEvidence || []), 'joeyism-structured-company-fallback'])];
          }
        }
      } catch (error) {
        if (error.code === 'LINKEDIN_COOLDOWN_ACTIVE' || error.code === 'LINKEDIN_MANUAL_LOCK') throw error;

        if (isTransientMcpFailure(error)) {
          const attempts = Number(request.transientCompanyAttempts[companyKey] || 0) + 1;
          request.transientCompanyAttempts[companyKey] = attempts;

          missionRunner.updateProgress({
            phase: 'verifying_companies',
            uniqueJobIds: jobMeta.size,
            jobDetailsChecked: jobDetails,
            companyProfilesChecked: deepProfiles,
            transientFailures: Number(missionRunner.active()?.progress?.transientFailures || 0) + 1,
            deferredCompanyCandidates: Object.values(request.transientCompanyAttempts).filter((count) => Number(count) < 2).length,
            lastTransientFailure: 'get_company_profile',
            lastTimedOutCompany: record.company || companyKey,
            lastTimedOutCompanyAttempt: attempts,
            verifiedCompanies: acceptedCompanies.size,
            remaining: Math.max(0, request.count - acceptedCompanies.size),
            budgetUsed: budget.used,
            budgetMaximum: budget.maximum,
          });

          if (attempts < 2) {
            const checkedIndex = checkedJobIds.lastIndexOf(String(jobId));
            if (checkedIndex >= 0) checkedJobIds.splice(checkedIndex, 1);
            continue;
          }
        }

        record.deepError = error.message;
      }

      profileCheckedCompanies.set(companyKey, record);
      records.push(record);

      if (companyFilterFailures(record, request).length === 0) {
        const globallySeen = !request.allowPreviouslySeenCompanies && finalMaster.seen(record);
        if (!globallySeen) {
          acceptedCompanies.add(companyKey);
          verifiedDuringRun = acceptedCompanies.size;
          missionRunner.updateProgress({
            phase: 'verifying_companies',
            uniqueJobIds: jobMeta.size,
            jobDetailsChecked: jobDetails,
            companiesLinked: jobCandidatesLinked,
            jobCandidatesPassed,
            companyProfilesChecked: deepProfiles,
            verifiedCompanies: verifiedDuringRun,
            remaining: Math.max(0, request.count - verifiedDuringRun),
            budgetUsed: budget.used,
            budgetMaximum: budget.maximum,
          });
        } else {
          record.globalSeen = true;
        }
      }
    }
  } else {
    const keyword = searchKeyword(request);
    const searches = [keyword, request.location ? `${keyword} ${request.location}` : ''].filter(Boolean);
    for (const query of [...new Set(searches)].slice(0, 2)) {
      const result = await budgetedCall(budget, 'search_companies', { keywords: query });
      if (!result) break;
      for (const ref of linkedInReferences(result, 'company')) {
        const record = referenceRecord(ref, request);
        if (!record) continue;
        record.companySearchEvidenceText = [ref.text, ref.context].filter(Boolean).join(' · ');
        record.employeeCount = employeeCountFromText(record.companySearchEvidenceText) || employeeCountFromText(record.snippet);
        record.relevanceScore = qualityScore(record, request);
        records.push(record);
      }
    }
  }

  if (request.hiring && acceptedCompanies.size < request.count && budget.used >= budget.maximum && budget.safetyBlock) {
    budget.stopped = budget.stopped || budget.safetyBlock.message || 'LinkedIn safety window is unavailable.';
    missionRunner.updateProgress({
      phase: acceptedCompanies.size > 0 ? 'writing_cached_verified' : 'waiting_safety',
      uniqueJobIds: jobMeta.size,
      jobDetailsChecked: jobDetails,
      companyProfilesChecked: deepProfiles,
      verifiedCompanies: acceptedCompanies.size,
      remaining: Math.max(0, request.count - acceptedCompanies.size),
      budgetUsed: budget.used,
      budgetMaximum: budget.maximum,
      cachedReconsidered: reconsidered.length,
      cachedJobDetailHits,
      cachedJobDetailMisses,
      cachedCompanyProfileHits,
      cachedCompanyProfileMisses,
      cacheVerificationExhausted: true,
    });

    // If cache produced valid companies, return them so run() can append them
    // immediately. The runner will park the remaining target after the write.
    // Only a zero-result cache pass throws directly into waiting_safety.
    if (acceptedCompanies.size === 0) {
      const error = safetyGateError(budget);
      if (error) throw error;
    }
  }

  const preProfileRejected = request.hiring
    ? records.filter((record) => jobLevelFailures(record, request).length > 0)
    : [];

  let merged = dedupeRecords(
    request.hiring
      ? records.filter((record) => jobLevelFailures(record, request).length === 0)
      : records,
    'company',
  ).sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0));

  // Non-hiring missions still need bounded company-profile verification.
  if (!request.hiring) {
    const remainingForProfiles = Math.max(0, budget.maximum - budget.used);
    const deepMax = budget.localBudgetBypass
      ? Math.min(merged.length, request.count, remainingForProfiles)
      : Math.min(policy.settings().deepProfilesPerMission, merged.length, request.count, remainingForProfiles);
    for (let index = 0; index < deepMax; index++) {
      const record = merged[index];
      const slug = linkedinPublic.normalizeLinkedInEntityUrl(record.linkedin, 'company')?.slug;
      if (!slug) continue;
      try {
        const deep = await budgetedCall(budget, 'get_company_profile', { company_name: slug });
        if (!deep) break;
        deepProfiles++;
        const text = flattenText(deep);
        record.companyEvidenceText = text;
        record.employeeCount = employeeCountFromText(text) || record.employeeCount || null;
        record.companyLocation = linkedinPublic.locationFromText(text) || '';
        record.relevanceScore = qualityScore(record, request, { deep: true });
      } catch (error) {
        if (error.code === 'LINKEDIN_COOLDOWN_ACTIVE' || error.code === 'LINKEDIN_MANUAL_LOCK') throw error;
        record.deepError = error.message;
      }
    }
  }

  const candidateCountBeforeGate = merged.length + preProfileRejected.length;
  const rejected = {
    low_relevance: 0,
    hiring: 0,
    employee_count: 0,
    location: 0,
    work_type: 0,
    topic: 0,
  };
  const accepted = [];
  const rejectedRecords = [];
  let rejectedCandidates = 0;

  for (const record of preProfileRejected) {
    const failures = jobLevelFailures(record, request);
    rejectedCandidates++;
    for (const reason of failures) rejected[reason] = Number(rejected[reason] || 0) + 1;
    rejectedRecords.push(rejectedRecordSnapshot(record, failures, request));
  }

  for (const record of merged) {
    const failures = companyFilterFailures(record, request);
    if (failures.length) {
      rejectedCandidates++;
      for (const reason of failures) rejected[reason] = Number(rejected[reason] || 0) + 1;
      rejectedRecords.push(rejectedRecordSnapshot(record, failures, request));
      continue;
    }

    if (!request.allowPreviouslySeenCompanies && finalMaster.seen(record)) {
      record.globalSeen = true;
      continue;
    }

    const locationMatch = locationEvidenceDetailsForRequest(record, request, {
      allowJobEvidence: Boolean(request.hiring),
      allowCompanyEvidence: request.locationScope !== 'job',
    });
    const jobLocation = linkedinPublic.locationFromText(record.jobEvidenceText);
    record.location = ['job', 'linkedin_search_filter'].includes(locationMatch.source)
      ? (jobLocation || locationMatch.label || locationMatch.requestedLocation || request.location || '')
      : (record.companyLocation || linkedinPublic.locationFromText(record.companySearchEvidenceText) || locationMatch.label || locationMatch.requestedLocation || '');
    record.locationEvidenceSource = locationMatch.source;
    const preferredWorkTypes = leadIntent.uniq(request.filters?.preferredWorkplaceTypes?.length
      ? request.filters.preferredWorkplaceTypes
      : [request.preferredWorkType].filter(Boolean));
    const desiredWorkType = request.filters?.workType || request.filters?.workplaceTypes?.[0] || preferredWorkTypes[0] || null;
    const workTypeMatch = workTypeEvidenceDetails(record, desiredWorkType);
    record.workType = workTypeMatch.value || detectWorkType(record.jobEvidenceText);
    record.workTypeEvidenceSource = workTypeMatch.source;
    record.preferenceScore = 0;
    const preferredWorkTypeIndex = preferredWorkTypes.indexOf(record.workType);
    if (preferredWorkTypeIndex >= 0) record.preferenceScore += Math.max(4, 12 - preferredWorkTypeIndex * 4);
    const preferredLocationIndex = (request.preferredLocations || []).findIndex((item) =>
      String(item).toLowerCase() === String(locationMatch.requestedLocation || '').toLowerCase()
    );
    if (preferredLocationIndex >= 0) record.preferenceScore += Math.max(0, 8 - preferredLocationIndex * 2);
    accepted.push(record);
  }

  merged = accepted
    .sort((a, b) => (Number(b.relevanceScore || 0) + Number(b.preferenceScore || 0))
      - (Number(a.relevanceScore || 0) + Number(a.preferenceScore || 0))
      || (leadIntent.postedAgeDays(a.jobEvidenceText) ?? 9999) - (leadIntent.postedAgeDays(b.jobEvidenceText) ?? 9999)
      || (leadIntent.applicantNumber(a.applicants) ?? 999999) - (leadIntent.applicantNumber(b.applicants) ?? 999999))
    .slice(0, request.count);

  return {
    records: merged,
    toolCalls: {
      searchJobs: searchCalls.length,
      searchPlan: searchCalls,
      parsedTopic: request.topic,
      jobIdsDiscovered,
      jobDetails,
      jobCandidatesLinked,
      jobCandidatesPassed,
      deepCompanyProfiles: deepProfiles,
      verifiedDuringRun,
      total: budget.used,
      callsPerVerifiedCompany: merged.length ? Number((budget.used / merged.length).toFixed(2)) : null,
      maximum: budget.maximum,
      checkedJobIds: request.hiring ? checkedJobIds : [],
      skippedPreviouslyChecked: request.hiring && request.continueFromPrevious ? previouslyChecked.size : 0,
      skippedDestinationJobs: request.hiring ? destinationJobIds.size : 0,
      destinationCompaniesKnown: request.hiring ? destinationCompanyKeys.size : 0,
      weakLiveJobsDeferred: request.hiring ? weakLiveDeferred : 0,
      globallySeenSkipped: records.filter((record) => record.globalSeen).length,
      cachedReconsidered: reconsidered.length,
      cachedJobDetailHits,
      cachedJobDetailMisses,
      cachedCompanyProfileHits,
      cachedCompanyProfileMisses,
      locationExpansion: locationExpander.summarize(searchCalls, request.location),
    },
    budgetStopped: budget.stopped,
    searchStrategiesExhausted,
    filters: request.filters,
    linkedinSearchWarnings: searchWarnings,
    filterVerification: {
      hardGate: true,
      requestedLocation: request.location || null,
      locationScope: request.locationScope || null,
      requestedWorkType: request.filters?.workType || null,
      employeeMin: request.filters?.employeeMin ?? null,
      employeeMax: request.filters?.employeeMax ?? null,
      topic: request.topic || null,
      rejected,
      rejectedCandidates,
      candidateCount: candidateCountBeforeGate,
    },
    rejectedRecords,
  };
}

function personSearchPlan(request) {
  const topic = searchKeyword(request);
  const criteria = String(request.criteriaText || request.originalMessage || '');
  const roleVariants = [];
  const addRole = (value) => {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    if (clean && !roleVariants.some((item) => item.toLowerCase() === clean.toLowerCase())) roleVariants.push(clean);
  };

  if (/\b(?:recruiters?|talent\s+acquisition|hr|human\s+resources?)\b/i.test(criteria)) {
    addRole(`${topic} recruiter`);
    addRole(`${topic} talent acquisition`);
    addRole(`${topic} HR recruiter`);
    addRole(`technical recruiter ${topic}`);
  } else {
    addRole(topic);
    addRole(`${topic} professional`);
    addRole(`${topic} specialist`);
  }

  const locations = /^maharashtra$/i.test(String(request.location || ''))
    ? ['Maharashtra', 'Pune', 'Mumbai', 'Navi Mumbai', 'Thane']
    : [request.location || null];

  const plan = [];
  for (const location of locations) {
    for (const keyword of roleVariants) {
      const key = `${keyword.toLowerCase()}|${String(location || '').toLowerCase()}`;
      if (!plan.some((item) => item.key === key)) plan.push({ key, keyword, location });
      if (plan.length >= 12) break;
    }
    if (plan.length >= 12) break;
  }
  return plan.map(({ key, ...item }) => item);
}

async function personMission(request) {
  const budget = missionCallBudget();
  if (budget.maximum < 1) {
    const error = new Error('No LinkedIn account calls remain in the current safety budget.');
    error.code = 'LINKEDIN_BURST_CAP';
    throw error;
  }

  const results = [];
  const searches = [];
  const plan = personSearchPlan(request);
  const maxSearches = budget.localBudgetBypass ? Math.min(plan.length, 12) : Math.min(plan.length, 2);

  for (const step of plan.slice(0, maxSearches)) {
    const search = await budgetedCall(budget, 'search_people', {
      keywords: step.keyword,
      location: step.location || undefined,
    });
    if (!search) break;
    searches.push({ keyword: step.keyword, location: step.location || null });

    for (const ref of linkedInReferences(search, 'person')) {
      const record = referenceRecord(ref, request);
      if (!record) continue;
      record.searchProvenance = {
        keywords: [step.keyword],
        locations: step.location ? [step.location] : [],
      };
      record.relevanceScore = qualityScore(record, request);
      results.push(record);
    }

    const unique = dedupeRecords(results, 'person').length;
    if (unique >= Math.max(request.count * 2, request.count + 10)) break;
  }

  let merged = dedupeRecords(results, 'person')
    .sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0));

  const remaining = Math.max(0, budget.maximum - budget.used);
  const deepMax = budget.localBudgetBypass
    ? Math.min(merged.length, request.count, remaining)
    : Math.min(policy.settings().deepProfilesPerMission, merged.length, request.count, remaining);

  let deepProfiles = 0;
  for (let index = 0; index < deepMax; index++) {
    const record = merged[index];
    const slug = linkedinPublic.normalizeLinkedInEntityUrl(record.linkedin, 'person')?.slug;
    if (!slug) continue;
    try {
      const deep = await budgetedCall(budget, 'get_person_profile', {
        linkedin_username: slug,
        sections: request.wantsContacts ? 'experience,contact_info' : 'experience',
        max_scrolls: 5,
      });
      if (!deep) break;
      deepProfiles++;
      const text = flattenText(deep);
      record.snippet = [record.snippet, text.slice(0, 5000)].filter(Boolean).join('\n').slice(0, 6500);
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
    toolCalls: {
      searchPeople: searches.length,
      searchPlan: searches,
      deepPersonProfiles: deepProfiles,
      total: budget.used,
      maximum: budget.maximum,
    },
    budgetStopped: budget.stopped,
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
        email: '',
        phone: '',
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

function isGoogleSheetsError(error) {
  const code = String(error?.code || '');
  return /^GOOGLE_SHEETS_/.test(code) || Number(error?.status || 0) >= 400;
}

function sheetErrorSnapshot(error) {
  return {
    code: String(error?.code || 'GOOGLE_SHEETS_API_ERROR'),
    message: String(error?.message || 'Google Sheets API error'),
    status: Number(error?.status || 0) || null,
    googleStatus: error?.googleStatus || null,
    googleCode: error?.googleCode || null,
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
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Google Sheets API failed (${response.status}).`);
    error.status = response.status;
    error.googleStatus = data?.error?.status || null;
    error.googleCode = data?.error?.code || response.status;
    error.googleDetails = Array.isArray(data?.error?.details) ? data.error.details : [];
    error.code = response.status === 403
      ? 'GOOGLE_SHEETS_FORBIDDEN'
      : response.status === 404
        ? 'GOOGLE_SHEETS_NOT_FOUND'
        : 'GOOGLE_SHEETS_API_ERROR';
    throw error;
  }
  return data;
}

async function appendRows(spreadsheetId, sheetName, rows, receipt = {}) {
  if (!rows.length) return 0;
  const width = Math.max(1, ...rows.map((row) => Array.isArray(row) ? row.length : 0));
  const full = `${sheets.quoteSheet(sheetName)}!A:${sheets.columnName(width - 1)}`;
  const result = await apiRequest(`${API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(full)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
  });
  Object.assign(receipt, await verifyAppend(result, rows, range => sheets.values(spreadsheetId, range)));
  return receipt.rows;
}

async function verifyAppend(result, rows, read) {
  const range = result?.updates?.updatedRange;
  const count = Number(result?.updates?.updatedRows);
  if (!range || count !== rows.length) throw Object.assign(new Error('Google Sheets did not confirm the expected appended rows. Research remains saved; do not repeat discovery.'), { code: 'LINKEDIN_SHEET_WRITE_UNVERIFIED' });
  const actual = await read(range);
  const verified = actual.length === rows.length && rows.every((row, i) => row.every((cell, j) => String(cell ?? '') === String(actual[i]?.[j] ?? '')));
  if (!verified) throw Object.assign(new Error(`Appended range ${range} could not be verified by readback. Check this range before retrying the write.`), { code: 'LINKEDIN_SHEET_WRITE_UNVERIFIED' });
  return { range, rows: count, verified: true };
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

function websiteDomain(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function rejectedSheetHeaders() {
  return [
    'COMPANY NAME',
    'COMPANY LINK',
    'SAP ROLE',
    'JOB LINK',
    'LOCATION',
    'LOCATION EVIDENCE',
    'WORK TYPE',
    'EMPLOYEES',
    'NO. OF APPLICANTS',
    'LEAD SCORE',
    'REJECTION REASONS',
    'HIRING SIGNAL',
    'JOB EVIDENCE',
    'COMPANY EVIDENCE',
  ];
}

function rejectedSheetRow(record) {
  return [
    record?.company || '',
    record?.linkedin || '',
    record?.role || '',
    record?.jobUrl || '',
    record?.location || '',
    record?.locationEvidenceSource || '',
    record?.workType || '',
    record?.employeeCount?.label || '',
    record?.applicants || '',
    record?.relevanceScore ?? '',
    Array.isArray(record?.rejectionReasons) ? record.rejectionReasons.join(', ') : '',
    record?.hiringSignal || '',
    record?.jobEvidenceText || '',
    record?.companyEvidenceText || '',
  ];
}

function latestRejectedMission() {
  return [...loadState().missions].reverse().find((mission) =>
    mission?.status === 'completed'
    && mission?.request?.entityMode === 'company'
    && mission?.filterVerification?.hardGate
    && Number(mission?.filterVerification?.rejectedCandidates || 0) > 0
  ) || null;
}

function isRejectedSheetRequest(text) {
  const value = String(text || '').trim();
  if (!/\b(?:sheet|spreadsheet|google\s+sheet)\b/i.test(value)) return false;
  if (/\b(?:rejected|failed|filtered\s*out|excluded|disqualified)\b/i.test(value)) return true;
  if (/\bthose\b[\s\S]{0,25}\b(?:candidates?|companies|results?|leads?)\b/i.test(value)) {
    return Boolean(latestRejectedMission());
  }
  return false;
}

async function createRejectedCandidatesSheet() {
  const state = loadState();
  const mission = [...state.missions].reverse().find((item) =>
    item?.status === 'completed'
    && item?.request?.entityMode === 'company'
    && item?.filterVerification?.hardGate
    && Number(item?.filterVerification?.rejectedCandidates || 0) > 0
  );
  if (!mission) {
    const error = new Error('No completed LinkedIn company mission with rejected candidates is available.');
    error.code = 'LINKEDIN_REJECTED_MISSION_NOT_FOUND';
    throw error;
  }

  const rejectedRecords = Array.isArray(mission.rejectedRecords) ? mission.rejectedRecords : [];
  if (!rejectedRecords.length) {
    return {
      ok: false,
      legacyMissing: true,
      missionId: mission.id,
      rejectedCandidates: Number(mission.filterVerification?.rejectedCandidates || 0),
      message: 'That mission recorded only rejection counts, not the rejected candidate rows. The exact old candidates cannot be reconstructed without rerunning the LinkedIn mission.',
    };
  }

  const headers = rejectedSheetHeaders();
  const topic = String(mission.request?.topic || 'Candidates').replace(/[^a-z0-9 ()&+._-]+/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
  const title = `ULTRON LinkedIn Rejected - ${topic} - ${new Date().toISOString().slice(0, 10)}`;
  const created = await v2.createSpreadsheet(title, headers, rejectedRecords.length);
  const added = await appendRows(created.spreadsheetId, created.sheetName, rejectedRecords.map(rejectedSheetRow));

  mission.rejectedSheetUrl = created.url;
  mission.rejectedSheetName = created.sheetName;
  mission.rejectedSheetTitle = created.title;
  mission.rejectedSheetAdded = added;
  mission.rejectedSheetCreatedAt = nowIso();
  saveState(state);

  return {
    ok: true,
    missionId: mission.id,
    sheetUrl: created.url,
    sheetName: created.sheetName,
    spreadsheetTitle: created.title,
    added,
    rejectedCandidates: rejectedRecords.length,
  };
}

function apolloSearchDelayMs() {
  const value = Number(apollo.setting('ULTRON_M3_APOLLO_PEOPLE_SEARCH_DELAY_MS', '900'));
  return Math.max(300, Math.min(10000, Number.isFinite(value) ? value : 900));
}

function contactRemark(name, role) {
  const person = String(name || '').trim();
  const title = String(role || '').trim();
  if (!person) return '';
  return title ? `${person} (${title})` : person;
}


function exactHeaderIndex(headers, label) {
  const wanted = normalizeHeader(label);
  return (headers || []).findIndex((value) => normalizeHeader(value) === wanted);
}

function baseHeaderIndex(headers, key) {
  return (headers || []).findIndex((value) =>
    !/^apollo\b/i.test(String(value || '').trim())
    && headerKey(value) === key
  );
}

async function ensureApolloSection(sheetUrl, options = {}) {
  const request = {
    entityMode: 'company',
    hiring: true,
    wantsContacts: false,
    filters: {},
    destinationSheetUrl: sheetUrl,
  };
  const destination = await inspectDestinationSheet(sheetUrl, request);
  const headerRow = (destination.rows[destination.headerRowNumber - 1] || []).map((value) => String(value || '').trim());
  const headers = headerRow.slice();
  let cursor = headers.reduce((last, value, index) => String(value || '').trim() ? index + 1 : last, 0);
  const changes = [];

  for (const label of APOLLO_SECTION_HEADERS) {
    if (exactHeaderIndex(headers, label) >= 0) continue;
    headers[cursor] = label;
    changes.push({
      range: sheets.cellRange(destination.sheetName, destination.headerRowNumber, cursor),
      value: label,
    });
    cursor++;
  }

  await sheets.ensureGridSize(destination.spreadsheetId, destination.sheetId, {
    minColumns: Math.max(cursor, APOLLO_SECTION_HEADERS.length),
    minRows: Math.max(2, destination.lastNonEmptyRow + 2),
  });
  if (changes.length) await sheets.writeCells(destination.spreadsheetId, changes);

  return {
    ...destination,
    rawHeaders: headers,
    apolloIndexes: Object.fromEntries(APOLLO_SECTION_HEADERS.map((label) => [label, exactHeaderIndex(headers, label)])),
  };
}

async function prepareApolloSheetContacts(sheetUrl, options = {}) {
  if (!sheetUrl) {
    const error = new Error('Apollo Sheet enrichment requires a Google Sheets URL.');
    error.code = 'LINKEDIN_APOLLO_SHEET_NOT_FOUND';
    throw error;
  }

  const layout = await ensureApolloSection(sheetUrl, options);
  const rows = await sheets.values(layout.spreadsheetId, `${sheets.quoteSheet(layout.sheetName)}!A:ZZ`);
  const headers = rows[layout.headerRowNumber - 1] || layout.rawHeaders || [];
  const companyIndex = baseHeaderIndex(headers, 'company');
  const linkedinIndex = baseHeaderIndex(headers, 'linkedin');
  const websiteIndex = baseHeaderIndex(headers, 'website');
  const contactIndex = exactHeaderIndex(headers, 'APOLLO CONTACT');
  const roleIndex = exactHeaderIndex(headers, 'APOLLO ROLE');
  const personLinkedinIndex = exactHeaderIndex(headers, 'APOLLO LINKEDIN');
  const phoneIndex = exactHeaderIndex(headers, 'APOLLO PHONE');
  const emailIndex = exactHeaderIndex(headers, 'APOLLO EMAIL');
  const statusIndex = exactHeaderIndex(headers, 'APOLLO STATUS');

  if (companyIndex < 0 || linkedinIndex < 0 || personLinkedinIndex < 0 || phoneIndex < 0 || emailIndex < 0) {
    const error = new Error('Apollo could not resolve the company and dedicated Apollo columns in this Sheet.');
    error.code = 'LINKEDIN_APOLLO_COLUMNS_MISSING';
    throw error;
  }

  const max = Math.max(1, Math.min(100, Number(apollo.setting('ULTRON_M3_APOLLO_COMPANY_SEARCH_MAX', '50')) || 50));
  const master = finalMaster.loadState();
  const changes = [];
  const selected = [];
  const unresolved = [];
  let skippedComplete = 0;
  let reusedSelectedContact = 0;
  let attempted = 0;

  for (let rowIndex = layout.headerRowNumber; rowIndex < rows.length && attempted < max; rowIndex++) {
    const row = rows[rowIndex] || [];
    const company = String(row[companyIndex] || '').trim();
    const companyLinkedin = String(row[linkedinIndex] || '').trim();
    if (!company || !/linkedin\.com\/company\//i.test(companyLinkedin)) continue;

    const existingApolloEmail = String(row[emailIndex] || '').trim();
    const existingApolloPhone = String(row[phoneIndex] || '').trim();
    const hasApolloEmail = Boolean(apollo.validEmail(existingApolloEmail));
    const hasApolloPhone = Boolean(apollo.validPhone(existingApolloPhone));
    if (hasApolloEmail && hasApolloPhone) {
      skippedComplete++;
      continue;
    }

    const existingPersonLinkedin = apollo.normalizeLinkedIn(row[personLinkedinIndex]);
    if (existingPersonLinkedin) {
      reusedSelectedContact++;
      selected.push({
        rowNumber: rowIndex + 1,
        company,
        linkedin: existingPersonLinkedin,
        reused: true,
      });
      continue;
    }

    attempted++;
    const key = finalMaster.companyKey({ company, linkedin: companyLinkedin });
    const companyState = master.companies?.[key] || {};
    const sheetWebsite = websiteIndex >= 0 ? String(row[websiteIndex] || '').trim() : '';
    const domain = finalMaster.hostname(sheetWebsite || companyState.website || '');

    try {
      const result = await apollo.searchCompanyDecisionMaker({
        company,
        domain,
        priorityMode: options.priorityMode || 'hiring',
      });
      const person = result.candidate ? await apollo.resolveDecisionMaker(result.candidate, company, domain) : null;
      if (!person?.linkedinUrl) {
        unresolved.push({ rowNumber: rowIndex + 1, company, reason: 'No verified priority decision-maker matched the company.' });
        if (statusIndex >= 0) changes.push({ range: sheets.cellRange(layout.sheetName, rowIndex + 1, statusIndex), value: 'NO_MATCH' });
      } else {
        const name = String(person.name || [person.first_name, person.last_name].filter(Boolean).join(' ') || '').trim();
        const title = String(person.title || '').trim();
        if (contactIndex >= 0 && name) changes.push({ range: sheets.cellRange(layout.sheetName, rowIndex + 1, contactIndex), value: name });
        if (roleIndex >= 0 && title) changes.push({ range: sheets.cellRange(layout.sheetName, rowIndex + 1, roleIndex), value: title });
        changes.push({ range: sheets.cellRange(layout.sheetName, rowIndex + 1, personLinkedinIndex), value: person.linkedinUrl });
        if (statusIndex >= 0) changes.push({ range: sheets.cellRange(layout.sheetName, rowIndex + 1, statusIndex), value: 'SELECTED' });
        selected.push({
          rowNumber: rowIndex + 1,
          company,
          name,
          title,
          linkedin: person.linkedinUrl,
          priority: person.decisionPriority,
          reused: false,
        });
      }
    } catch (error) {
      if (/APOLLO_(?:PEOPLE_SEARCH_ACCESS_REQUIRED|NOT_CONFIGURED)/.test(String(error.code || '')) || Number(error.status) === 429) throw error;
      unresolved.push({ rowNumber: rowIndex + 1, company, reason: error.message });
      if (statusIndex >= 0) changes.push({ range: sheets.cellRange(layout.sheetName, rowIndex + 1, statusIndex), value: 'ERROR' });
    }

    await new Promise((resolve) => setTimeout(resolve, apolloSearchDelayMs()));
  }

  if (changes.length) await sheets.writeCells(layout.spreadsheetId, changes);

  return {
    sheetUrl,
    spreadsheetId: layout.spreadsheetId,
    sheetName: layout.sheetName,
    selected: selected.length,
    unresolved: unresolved.length,
    skippedComplete,
    reusedSelectedContact,
    contacts: selected,
    failures: unresolved,
    apolloColumns: APOLLO_SECTION_HEADERS.slice(),
  };
}

function apolloValuePresent(value) {
  const text = String(value || '').trim();
  return Boolean(text && !/^null$/i.test(text));
}

function apolloStatusForValues(personLinkedin, phone, email, existingStatus = '') {
  const person = apollo.normalizeLinkedIn(personLinkedin);
  const hasPhone = Boolean(apollo.validPhone(phone));
  const hasEmail = Boolean(apollo.validEmail(email));
  const phoneNull = /^null$/i.test(String(phone || '').trim());
  const emailNull = /^null$/i.test(String(email || '').trim());

  if (hasPhone && hasEmail) return 'ENRICHED';
  if (hasEmail && phoneNull) return 'EMAIL_ONLY';
  if (hasPhone && emailNull) return 'PHONE_ONLY';
  if (phoneNull && emailNull) return 'NO_CONTACT';
  if (hasEmail && person) return 'EMAIL_FOUND';
  if (hasPhone && person) return 'PHONE_FOUND';
  if (person) return 'SELECTED';
  return String(existingStatus || '').trim();
}

async function finalizeApolloSheetStatuses(sheetUrl) {
  if (!sheetUrl) return { updated: 0, statuses: {}, sheetUrl: null };
  const layout = await ensureApolloSection(sheetUrl);
  const rows = await sheets.values(layout.spreadsheetId, `${sheets.quoteSheet(layout.sheetName)}!A:ZZ`);
  const headers = rows[layout.headerRowNumber - 1] || layout.rawHeaders || [];
  const companyIndex = baseHeaderIndex(headers, 'company');
  const personLinkedinIndex = exactHeaderIndex(headers, 'APOLLO LINKEDIN');
  const phoneIndex = exactHeaderIndex(headers, 'APOLLO PHONE');
  const emailIndex = exactHeaderIndex(headers, 'APOLLO EMAIL');
  const statusIndex = exactHeaderIndex(headers, 'APOLLO STATUS');
  if ([companyIndex, personLinkedinIndex, phoneIndex, emailIndex, statusIndex].some((index) => index < 0)) {
    return { updated: 0, statuses: {}, sheetUrl, sheetName: layout.sheetName };
  }

  const changes = [];
  const statuses = {};
  for (let rowIndex = layout.headerRowNumber; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] || [];
    const company = String(row[companyIndex] || '').trim();
    if (!company) continue;
    const current = String(row[statusIndex] || '').trim();
    if (/^(?:NO_MATCH|ERROR)$/i.test(current) && !apollo.normalizeLinkedIn(row[personLinkedinIndex])) {
      statuses[current.toUpperCase()] = Number(statuses[current.toUpperCase()] || 0) + 1;
      continue;
    }
    const next = apolloStatusForValues(
      row[personLinkedinIndex],
      row[phoneIndex],
      row[emailIndex],
      current,
    );
    if (!next) continue;
    statuses[next] = Number(statuses[next] || 0) + 1;
    if (next !== current) {
      changes.push({
        range: sheets.cellRange(layout.sheetName, rowIndex + 1, statusIndex),
        value: next,
      });
    }
  }
  if (changes.length) await sheets.writeCells(layout.spreadsheetId, changes);
  return {
    updated: changes.length,
    statuses,
    sheetUrl,
    sheetName: layout.sheetName,
  };
}

async function prepareApolloCompanyContacts(missionId = null, sheetUrl = null) {
  const state = loadState();
  const mission = missionId ? state.missions.find((item) => item.id === missionId) : null;
  const resolvedSheetUrl = sheetUrl || mission?.sheetUrl || workspaceSheetUrl(state) || finalMaster.masterSheetUrl();
  if (!resolvedSheetUrl) {
    const error = new Error('There is no LinkedIn company Sheet available for Apollo enrichment.');
    error.code = 'LINKEDIN_APOLLO_SHEET_NOT_FOUND';
    throw error;
  }

  const prepared = await prepareApolloSheetContacts(resolvedSheetUrl, {
    priorityMode: mission?.request?.hiring === false ? 'general' : 'hiring',
  });
  if (mission) {
    mission.apolloDecisionMakers = prepared.contacts;
    mission.apolloDecisionMakerUnresolved = prepared.failures;
    mission.apolloDecisionMakerPreparedAt = nowIso();
    saveState(state);
  }
  return { mission: mission || null, ...prepared };
}

async function enrichFinalMasterContacts() {
  const master = finalMaster.loadState();
  if (!master.sheetUrl) {
    const error = new Error('The Final Master does not exist yet. Build it before Apollo enrichment.');
    error.code = 'LINKEDIN_FINAL_MASTER_NOT_FOUND';
    throw error;
  }

  const selection = await prepareApolloSheetContacts(master.sheetUrl, { priorityMode: 'hiring' });
  const leadEnrichment = require('./lead-enrichment-operator');
  const stats = await leadEnrichment.enrichSheet(master.sheetUrl, {
    provider: 'google',
    ensureContactColumns: false,
    strictApolloColumns: true,
  });
  let phoneSync = { received: 0, resolved: 0, pending: stats.pendingPhones || 0 };
  try { phoneSync = await leadEnrichment.syncPhoneResults({ quiet: false }); } catch {}
  const enrichmentState = leadEnrichment.loadState();
  const enrichmentJob = (enrichmentState.jobs || []).find((item) => item.id === stats.jobId);
  const pendingPhones = Object.values(enrichmentJob?.rows || {}).filter((row) => row?.phonePending).length;
  const statusSummary = await finalizeApolloSheetStatuses(master.sheetUrl);
  const fullyEnriched = Number(statusSummary.statuses?.ENRICHED || 0);

  return {
    selected: selection.selected,
    enriched: fullyEnriched,
    profilesChecked: Number(stats.enrichedProfiles || 0) + Number(stats.cachedProfiles || 0),
    unresolved: Number(selection.unresolved || 0) + Number(stats.unresolvedRows || 0) + Number(stats.failedRows || 0),
    skippedComplete: Number(selection.skippedComplete || 0) + Number(stats.skippedComplete || 0),
    reusedSelectedContact: selection.reusedSelectedContact || 0,
    emailsWritten: stats.emailsWritten || 0,
    phonesWritten: stats.phonesWritten || 0,
    phonesResolvedFromWebhook: Number(phoneSync.resolved || 0),
    pendingPhones,
    contacts: selection.contacts,
    failures: selection.failures,
    apolloColumns: selection.apolloColumns,
    apolloStatuses: statusSummary.statuses,
    apolloStatusCellsUpdated: statusSummary.updated,
    sheetUrl: master.sheetUrl,
  };
}

function verifiedRecordSnapshot(record) {
  return {
    entityType: record?.entityType || (record?.jobUrl ? 'company' : ''),
    name: record?.name || '',
    company: record?.company || '',
    role: record?.role || '',
    jobId: record?.jobId || '',
    jobUrl: record?.jobUrl || '',
    linkedin: record?.linkedin || '',
    location: record?.location || '',
    locationEvidenceSource: record?.locationEvidenceSource || '',
    workType: record?.workType || '',
    workTypeEvidenceSource: record?.workTypeEvidenceSource || '',
    employeeCount: record?.employeeCount || null,
    applicants: record?.applicants || '',
    relevanceScore: Number(record?.relevanceScore || 0),
    hiringSignal: record?.hiringSignal || '',
    website: record?.website || '',
    email: record?.email || '',
    phone: record?.phone || '',
    sourceEvidence: [...new Set(record?.sourceEvidence || [])],
  };
}

function isExistingSheetFillRequest(text) {
  const value = String(text || '').trim();
  if (isRequest(value)) return false;
  const state = loadState();
  const mission = [...state.missions].reverse().find((item) =>
    item?.status === 'completed' && Array.isArray(item?.verifiedRecords) && item.verifiedRecords.length
  );
  if (!mission) return false;
  const url = sheets.extractSheetUrl(value);
  const currentSheet = /\b(?:current|same|existing|last|latest)\s+(?:google\s+)?(?:sheet|spreadsheet)\b/i.test(value);
  if (!url && !(currentSheet && workspaceSheetUrl(state))) return false;
  return /\b(?:fill|put|write|copy|add|append|use|move|send)\b/i.test(value)
    || /^https:\/\/docs\.google\.com\/spreadsheets\//i.test(value);
}

async function fillLatestMissionIntoSheet(sheetUrl = null) {
  const state = loadState();
  const mission = [...state.missions].reverse().find((item) =>
    item?.status === 'completed' && Array.isArray(item?.verifiedRecords) && item.verifiedRecords.length
  );
  if (!mission) {
    const error = new Error('No completed LinkedIn mission with reusable verified records is available.');
    error.code = 'LINKEDIN_VERIFIED_RECORDS_NOT_FOUND';
    throw error;
  }

  const resolvedSheetUrl = sheetUrl || workspaceSheetUrl(state) || mission.sheetUrl;
  if (!resolvedSheetUrl) {
    const error = new Error('There is no current LinkedIn Sheet to update. Provide a Google Sheets URL once, then ULTRON can reuse it.');
    error.code = 'LINKEDIN_WORKSPACE_SHEET_NOT_FOUND';
    throw error;
  }

  const request = { ...mission.request, destinationSheetUrl: resolvedSheetUrl };
  const destination = await inspectDestinationSheet(resolvedSheetUrl, request);
  const outputHeaders = ensureHeaders(destination.headers, request);
  const storageHeaders = [...outputHeaders];
  const needsInternalContact = request.entityMode === 'company' && request.wantsContacts;
  if (needsInternalContact && !storageHeaders.some((header) => headerKey(header) === 'contactLinkedin')) {
    storageHeaders.push(INTERNAL_CONTACT_HEADER);
  }
  await syncDestinationHeaders(destination, storageHeaders);

  const existingKeys = destinationExistingKeys(destination, storageHeaders, request);
  const records = mission.verifiedRecords.filter((record) => {
    const keys = recordDestinationKeys(record);
    const duplicate = keys.some((key) => existingKeys.has(key));
    if (!duplicate) for (const key of keys) existingKeys.add(key);
    return !duplicate;
  });
  const rows = records.map((record) => rowFor(record, storageHeaders, request));
  const firstAppendedRow = Math.max(destination.lastNonEmptyRow + 1, destination.headerRowNumber + 1);
  const added = await appendRows(destination.spreadsheetId, destination.sheetName, rows);

  if (needsInternalContact) {
    const helperIndex = storageHeaders.findIndex((header) => headerKey(header) === 'contactLinkedin');
    if (helperIndex >= 0) {
      try { await hideInternalContactColumn(destination.spreadsheetId, destination.sheetId, helperIndex); } catch {}
    }
  }

  mission.copiedToSheet = {
    url: resolvedSheetUrl,
    sheetName: destination.sheetName,
    added,
    skippedDuplicates: mission.verifiedRecords.length - records.length,
    copiedAt: nowIso(),
  };
  if (request.entityMode === 'company' && records.length) {
    mission.copiedContactTargets = records.map((record, index) => ({
      rowNumber: firstAppendedRow + index,
      company: record.company,
      companyLinkedin: record.linkedin,
      website: record.website || '',
      domain: websiteDomain(record.website),
    }));
  }
  rememberWorkspaceSheet(resolvedSheetUrl, {
    sheetName: destination.sheetName,
    spreadsheetTitle: destination.spreadsheetTitle,
    entityMode: request.entityMode,
  }, state);
  saveState(state);

  return {
    ok: true,
    sheetUrl: resolvedSheetUrl,
    spreadsheetTitle: destination.spreadsheetTitle,
    sheetName: destination.sheetName,
    added,
    skippedDuplicates: mission.verifiedRecords.length - records.length,
    sourceMissionId: mission.id,
  };
}

function isContinueSearchRequest(text) {
  const value = String(text || '').trim();
  if (!/\b(?:continue|resume|keep\s+searching|search\s+more|find\s+more|more\s+results?|another\s+batch)\b/i.test(value)) return false;
  return Boolean(latestCompletedMission());
}

async function prepareContinuation(text) {
  const state = loadState();
  const mission = [...(state.missions || [])].reverse().find((item) =>
    item?.status === 'completed' && item?.request && !item?.request?.exactUrl
  );
  if (!mission) {
    const error = new Error('There is no completed LinkedIn research mission to continue.');
    error.code = 'LINKEDIN_CONTINUATION_NOT_FOUND';
    throw error;
  }

  const explicitCount = parseExplicitCount(text);
  const explicitSheetUrl = sheets.extractSheetUrl(text);
  const wantsNewSheet = /\b(?:new|separate|fresh)\s+(?:google\s+)?(?:sheet|spreadsheet)\b/i.test(String(text || ''));
  const destinationSheetUrl = explicitSheetUrl || (!wantsNewSheet ? (workspaceSheetUrl(state) || mission.sheetUrl) : null);

  const request = {
    ...mission.request,
    originalMessage: String(text || '').trim(),
    count: explicitCount || Number(mission.requested || mission.request?.count || 25),
    destinationSheetUrl,
    destinationSheet: undefined,
    continueFromPrevious: true,
    usePrevious: false,
    useDefault: true,
    explicitHeaders: undefined,
  };
  return prepare(request);
}

function isConsolidateRequest(text) {
  const value = String(text || '').trim();
  return /\b(?:consolidate|merge|combine|collect)\b[\s\S]{0,80}\b(?:linkedin|results?|missions?|leads?|companies|profiles?)\b/i.test(value)
    || /\b(?:all|every)\s+(?:linkedin\s+)?(?:results?|missions?|leads?)\b[\s\S]{0,60}\b(?:one|single|same|consolidated)\s+(?:google\s+)?(?:sheet|spreadsheet)\b/i.test(value);
}

function consolidatedRecordKey(record) {
  const linkedin = String(record?.linkedin || '').trim().toLowerCase();
  const company = normalizeHeader(record?.company || '');
  const name = normalizeHeader(record?.name || '');
  if (linkedin) return `linkedin:${linkedin}`;
  if (company) return `company:${company}`;
  if (name) return `person:${name}`;
  return '';
}

async function consolidateVerifiedMissions(text = '') {
  const state = loadState();
  const explicitSheetUrl = sheets.extractSheetUrl(text);
  const wantsCurrent = /\b(?:current|same|existing|last|latest)\s+(?:google\s+)?(?:sheet|spreadsheet)\b/i.test(String(text || ''));
  const latest = latestCompletedMission(state);
  const requestedEntity = /\b(?:people|persons?|profiles?|recruiters?|professionals?)\b/i.test(String(text || ''))
    ? 'person'
    : /\b(?:companies|company|employers?|businesses?)\b/i.test(String(text || ''))
      ? 'company'
      : (state.workspace?.entityMode || latest?.request?.entityMode || 'company');

  const missions = (state.missions || []).filter((mission) =>
    mission?.status === 'completed'
    && mission?.request?.entityMode === requestedEntity
    && Array.isArray(mission?.verifiedRecords)
    && mission.verifiedRecords.length
  );
  if (!missions.length) {
    const error = new Error(`No completed LinkedIn ${requestedEntity} missions with verified records are available to consolidate.`);
    error.code = 'LINKEDIN_CONSOLIDATION_EMPTY';
    throw error;
  }

  const byKey = new Map();
  for (const mission of missions) {
    for (const source of mission.verifiedRecords) {
      const record = { ...source, entityType: requestedEntity, sourceMissionId: mission.id };
      const key = consolidatedRecordKey(record);
      if (!key) continue;
      const existing = byKey.get(key);
      if (!existing || Number(record.relevanceScore || 0) > Number(existing.relevanceScore || 0)) {
        byKey.set(key, record);
      }
    }
  }
  const records = [...byKey.values()];
  const templateMission = [...missions].reverse()[0];
  const request = {
    ...templateMission.request,
    entityMode: requestedEntity,
    destinationSheetUrl: null,
    wantsContacts: true,
  };

  const destinationUrl = explicitSheetUrl || (wantsCurrent ? workspaceSheetUrl(state) : null);
  let destination = null;
  let outputHeaders = ensureHeaders(
    requestedEntity === 'company'
      ? [...COMPANY_HEADERS, 'ROLE', 'JOB LINK', 'LOCATION', 'WORK TYPE', 'EMPLOYEES', 'WEBSITE', 'LEAD SCORE']
      : [...PERSON_HEADERS],
    request,
  );
  let sheet;
  let firstAppendedRow = 2;

  if (destinationUrl) {
    destination = await inspectDestinationSheet(destinationUrl, request);
    outputHeaders = ensureHeaders(destination.headers, request);
    await syncDestinationHeaders(destination, outputHeaders);
    sheet = {
      spreadsheetId: destination.spreadsheetId,
      sheetId: destination.sheetId,
      sheetName: destination.sheetName,
      title: destination.spreadsheetTitle,
      url: destinationUrl,
    };
    firstAppendedRow = Math.max(destination.lastNonEmptyRow + 1, destination.headerRowNumber + 1);
  } else {
    const title = `ULTRON LinkedIn Consolidated - ${requestedEntity === 'company' ? 'Companies' : 'People'} - ${new Date().toISOString().slice(0, 10)}`;
    sheet = await v2.createSpreadsheet(title, outputHeaders, records.length);
  }

  const existingKeys = destination ? destinationExistingKeys(destination, outputHeaders, request) : new Set();
  const writeRecords = records.filter((record) => {
    const keys = recordDestinationKeys(record);
    const duplicate = keys.some((key) => existingKeys.has(key));
    if (!duplicate) for (const key of keys) existingKeys.add(key);
    return !duplicate;
  });
  const added = await appendRows(sheet.spreadsheetId, sheet.sheetName, writeRecords.map((record) => rowFor(record, outputHeaders, request)));

  rememberWorkspaceSheet(sheet.url, {
    sheetName: sheet.sheetName,
    spreadsheetTitle: sheet.title,
    entityMode: requestedEntity,
  }, state);
  state.consolidated = {
    sheetUrl: sheet.url,
    sheetName: sheet.sheetName,
    entityMode: requestedEntity,
    missions: missions.length,
    uniqueRecords: records.length,
    added,
    updatedAt: nowIso(),
  };
  saveState(state);

  return {
    ok: true,
    sheetUrl: sheet.url,
    spreadsheetTitle: sheet.title,
    sheetName: sheet.sheetName,
    entityMode: requestedEntity,
    missions: missions.length,
    uniqueRecords: records.length,
    added,
    skippedDuplicates: records.length - writeRecords.length,
    firstAppendedRow,
  };
}

function explicitDeletionIntent(text = '') {
  const value = String(text || '').trim();
  return /\b(?:delete|remove|erase|purge|drop)\b/i.test(value)
    && /\b(?:duplicates?|rows?|records?|leads?|companies?|columns?|data)\b/i.test(value);
}

function isDedupeSheetRequest(text) {
  const value = String(text || '').trim();
  return /\b(?:dedupe|de-duplicate|remove\s+duplicates?|clean\s+duplicates?)\b/i.test(value)
    && /\b(?:sheet|spreadsheet|linkedin\s+results?)\b/i.test(value);
}

async function dedupeWorkspaceSheet(text = '') {
  const state = loadState();
  const sheetUrl = sheets.extractSheetUrl(text) || workspaceSheetUrl(state);
  if (!sheetUrl) {
    const error = new Error('There is no current LinkedIn Sheet to dedupe. Provide a Google Sheets URL.');
    error.code = 'LINKEDIN_WORKSPACE_SHEET_NOT_FOUND';
    throw error;
  }

  const latest = latestCompletedMission(state);
  const request = latest?.request || { entityMode: state.workspace?.entityMode || 'company', wantsContacts: true, filters: {} };
  const destination = await inspectDestinationSheet(sheetUrl, request);
  const headers = destination.headers;
  const linkedinIndex = headers.findIndex((header) => headerKey(header) === 'linkedin');
  const jobIndex = headers.findIndex((header) => headerKey(header) === 'jobLink');
  const companyIndex = headers.findIndex((header) => headerKey(header) === 'company');
  const nameIndex = headers.findIndex((header) => headerKey(header) === 'name');

  const seen = new Set();
  const duplicateRows = [];
  for (let index = destination.headerRowNumber; index < destination.rows.length; index++) {
    const row = destination.rows[index] || [];
    const keys = [];
    if (linkedinIndex >= 0 && row[linkedinIndex]) keys.push(`linkedin:${String(row[linkedinIndex]).trim().toLowerCase()}`);
    if (jobIndex >= 0 && row[jobIndex]) keys.push(`job:${String(row[jobIndex]).trim().toLowerCase()}`);
    if (companyIndex >= 0 && row[companyIndex]) keys.push(`company:${normalizeHeader(row[companyIndex])}`);
    if (!keys.length && nameIndex >= 0 && row[nameIndex]) keys.push(`name:${normalizeHeader(row[nameIndex])}`);
    if (!keys.length) continue;
    if (keys.some((key) => seen.has(key))) {
      duplicateRows.push(index);
      continue;
    }
    for (const key of keys) seen.add(key);
  }

  const deletionApproved = explicitDeletionIntent(text);
  if (duplicateRows.length && deletionApproved) {
    const requests = duplicateRows
      .sort((a, b) => b - a)
      .map((rowIndex) => ({
        deleteDimension: {
          range: {
            sheetId: destination.sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex,
            endIndex: rowIndex + 1,
          },
        },
      }));
    await apiRequest(`${API}/${encodeURIComponent(destination.spreadsheetId)}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    });
  }

  rememberWorkspaceSheet(sheetUrl, {
    sheetName: destination.sheetName,
    spreadsheetTitle: destination.spreadsheetTitle,
    entityMode: request.entityMode,
  }, state);
  saveState(state);
  return {
    ok: true,
    sheetUrl,
    spreadsheetTitle: destination.spreadsheetTitle,
    sheetName: destination.sheetName,
    removed: deletionApproved ? duplicateRows.length : 0,
    duplicatesFound: duplicateRows.length,
    deletionApproved,
  };
}


function rowFor(record, headers, request = {}) {
  return headers.map((header) => {
    const key = headerKey(header, request.headerMappings);
    if (key === 'ignore') return '';
    if (request.wantsContacts === false && ['contactLinkedin', 'phone', 'email', 'remarks'].includes(key)) return '';
    if (key === 'name') return record.name || '';
    if (key === 'company') return finalMaster.cleanCompanyDisplay(record.company || '');
    if (key === 'role') return record.role || '';
    if (key === 'jobLink') return record.jobUrl || '';
    if (key === 'linkedin') return record.linkedin || '';
    if (key === 'contactLinkedin') return record.contactLinkedin || '';
    if (key === 'location') return record.location || record.companyLocation || '';
    if (key === 'workType') return record.workType || detectWorkType(record.jobEvidenceText) || '';
    if (key === 'employees') return record.employeeCount?.label || '';
    if (key === 'hiring') return record.hiringSignal || '';
    if (key === 'details') return record.snippet || '';
    if (key === 'website') return record.website || '';
    if (key === 'phone') return record.phone || '';
    if (key === 'email') return record.email || '';
    if (key === 'remarks') return record.remarks || contactRemark(record.name, record.role);
    if (key === 'applicants') return record.applicants || '';
    if (key === 'posted') return record.posted || postedEvidenceFromText(record.jobEvidenceText) || '';
    if (key === 'industry') return record.industry || '';
    if (key === 'companySizeConfidence') return record.employeeCount ? (record.employeeCount.estimated ? 'estimated' : 'verified') : 'unknown';
    if (key === 'source') return record.source || record.linkedin || '';
    if (key === 'score') return record.relevanceScore ?? '';
    return '';
  });
}

function isBuildFinalMasterRequest(text) {
  const value = String(text || '').trim();
  const explicitBuild = /\b(?:build|create|rebuild|migrate|generate)\b[\s\S]{0,40}\b(?:final(?:\s+linkedin)?\s+master|final\s+(?:lead\s+)?database|clean\s+master)\b/i.test(value)
    || /^make\s+(?:me\s+)?(?:a|the)\s+(?:clean\s+)?final(?:\s+linkedin)?\s+master\b/i.test(value);
  if (!explicitBuild) return false;

  // A research request that merely mentions the Final Master as its destination
  // must stay a LinkedIn research mission. The runner will build/migrate the
  // master automatically before calculating the remaining target.
  const researchIntent = /\b(?:find|search|research|source|collect|add|get|bring)\b[\s\S]{0,100}\b(?:companies?|jobs?|roles?|leads?)\b/i.test(value)
    || /\b(?:reach|go\s+to|make\s+(?:the\s+)?(?:list|final\s+master|master))\b[\s\S]{0,30}\b\d{1,3}\b/i.test(value);
  return !researchIntent;
}

function historicalVerifiedCompanyRecords(options = {}) {
  const state = loadState();
  const topic = String(options.topic || 'SAP');
  const workType = options.workType === undefined ? null : options.workType;
  const employeeMax = options.employeeMax === undefined ? 1000 : options.employeeMax;
  const records = [];
  for (const mission of state.missions || []) {
    if (mission?.status !== 'completed' || mission?.request?.entityMode !== 'company') continue;
    if (topic && !String(mission.request?.topic || '').toLowerCase().startsWith(topic.toLowerCase())) continue;
    for (const record of mission.verifiedRecords || []) {
      if (!finalMaster.qualifies(record, { topic, workType, employeeMax })) continue;
      records.push({ ...record, sourceMissionId: mission.id, sourceMissionCreatedAt: mission.createdAt });
    }
  }
  const byKey = new Map();
  for (const record of records) {
    const key = finalMaster.companyKey(record);
    if (!key) continue;
    const previous = byKey.get(key);
    if (!previous || Number(record.relevanceScore || 0) > Number(previous.relevanceScore || 0)) byKey.set(key, record);
  }
  return [...byKey.values()];
}

async function finalMasterSheetSchemaCurrent(url = finalMaster.masterSheetUrl()) {
  if (!url) return false;
  try {
    const spreadsheetId = sheets.spreadsheetId(url);
    const state = finalMaster.loadState();
    const sheetName = state.sheetName || 'Leads';
    const rows = await sheets.values(spreadsheetId, `${sheets.quoteSheet(sheetName)}!A1:ZZ1`);
    const actual = (rows[0] || []).map((value) => String(value || '').trim().toUpperCase());
    while (actual.length && !actual[actual.length - 1]) actual.pop();
    const expected = finalMaster.FINAL_MASTER_HEADERS.map((value) => String(value).trim().toUpperCase());
    return actual.length === expected.length && expected.every((value, index) => actual[index] === value);
  } catch {
    return false;
  }
}

async function buildFinalMaster(text = '') {
  const existingUrl = finalMaster.masterSheetUrl();
  const currentSchema = existingUrl ? await finalMasterSheetSchemaCurrent(existingUrl) : false;
  if (existingUrl && currentSchema && !/\b(?:rebuild|replace|new)\b/i.test(String(text || ''))) {
    return {
      ok: true,
      sheetUrl: existingUrl,
      spreadsheetTitle: finalMaster.loadState().spreadsheetTitle,
      sheetName: finalMaster.loadState().sheetName,
      added: 0,
      uniqueRecords: finalMaster.masterCount(),
      alreadyExists: true,
    };
  }

  const records = historicalVerifiedCompanyRecords({ topic: 'SAP', employeeMax: 1000 });
  const sheet = await v2.createSpreadsheet('ULTRON LinkedIn Final Lead Master', finalMaster.FINAL_MASTER_HEADERS, Math.max(100, records.length + 20));
  await sheets.ensureGridSize(sheet.spreadsheetId, sheet.sheetId, {
    minColumns: finalMaster.FINAL_MASTER_HEADERS.length,
    minRows: Math.max(200, records.length + 10),
  });
  const rows = records.map((record) => finalMaster.rowFor(record, { missionId: record.sourceMissionId, firstSeenAt: record.sourceMissionCreatedAt }));
  const added = await appendRows(sheet.spreadsheetId, sheet.sheetName, rows);
  finalMaster.setMasterSheet(sheet);
  finalMaster.registerRecords(records, { missionId: 'historical-migration', master: true });

  const state = loadState();
  rememberWorkspaceSheet(sheet.url, {
    sheetName: sheet.sheetName,
    spreadsheetTitle: sheet.title,
    entityMode: 'company',
  }, state);
  saveState(state);

  return {
    ok: true,
    sheetUrl: sheet.url,
    spreadsheetTitle: sheet.title,
    sheetName: sheet.sheetName,
    added,
    uniqueRecords: records.length,
    alreadyExists: false,
  };
}

async function reconcileFinalMasterRegistry(request = {}) {
  const masterUrl = finalMaster.masterSheetUrl();
  if (!masterUrl) return { count: 0, records: [], removedInvalid: 0 };

  const registry = finalMaster.loadState();
  const spreadsheetId = sheets.spreadsheetId(masterUrl);
  const sheetName = registry.sheetName || 'Leads';
  const meta = await sheets.metadata(spreadsheetId);
  const tab = (meta.sheets || []).find((item) => item?.properties?.title === sheetName);
  const sheetId = tab?.properties?.sheetId;
  const rows = await sheets.values(spreadsheetId, `${sheets.quoteSheet(sheetName)}!A2:H`);
  const records = [];
  const invalidRows = [];

  const requirements = {
    topic: request.topic || 'SAP',
    employeeMax: request.filters?.employeeMax ?? null,
    workType: request.filters?.workType || null,
    allowedLocations: request.allowedLocations || requestedLocations(request),
    hiringRequired: request.hiring !== false,
  };

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] || [];
    const company = finalMaster.cleanCompanyDisplay(String(row[0] || '').trim());
    const linkedin = String(row[1] || '').trim();
    if (!company || !linkedin) {
      if ((row || []).some((value) => String(value || '').trim())) invalidRows.push(index + 1);
      continue;
    }

    const shell = { company, linkedin };
    const key = finalMaster.companyKey(shell);
    const existing = registry.companies?.[key];
    if (!existing || existing.status !== 'verified') {
      invalidRows.push(index + 1);
      continue;
    }

    const merged = {
      ...existing,
      company,
      linkedin,
      jobUrl: String(row[2] || '').trim() || existing.primaryJobUrl || '',
      primaryJobUrl: String(row[2] || '').trim() || existing.primaryJobUrl || '',
      location: String(row[3] || '').trim() || existing.location || '',
      applicants: String(row[4] || '').trim() || existing.applicants || '',
      phone: plausiblePhone(row[5]) ? String(row[5] || '').trim() : '',
      email: plausibleEmail(row[6]) ? String(row[6] || '').trim() : '',
      remarks: /^\d+(?:\.\d+)?$/.test(String(row[7] || '').trim()) ? '' : String(row[7] || '').trim(),
    };

    if (!finalMaster.qualifies(merged, requirements)) {
      invalidRows.push(index + 1);
      continue;
    }
    records.push(merged);
  }

  // Reconciliation may affect how many rows count toward the current mission,
  // but it must never delete historical verified rows from the canonical master.
  // Keep the registry additive instead of replacing it with a filtered subset.
  finalMaster.registerRecords(records, { missionId: 'sheet-reconciliation', master: true });
  for (const record of records) {
    const key = finalMaster.companyKey(record);
    if (!key) continue;
    finalMaster.contactUpdate(key, {
      phone: record.phone || '',
      email: record.email || '',
      remarks: record.remarks || '',
    });
  }
  return {
    count: records.length,
    records,
    removedInvalid: 0,
    preservedNonMatchingRows: invalidRows.length,
    requirements,
  };
}

async function run(request, headers) {
  if (request?.entityMode === 'company') {
    request.allowPreviouslySeenCompanies = Boolean(request.allowPreviouslySeenCompanies || finalMaster.allowRepeatFromText(request.originalMessage));
    if (request.useFinalMaster || request.targetMode === 'master_total') {
      const masterUrl = finalMaster.masterSheetUrl();
      if (masterUrl) {
        await repairFinalMasterSheetSchema(masterUrl);
      }
      const currentSchema = masterUrl ? await finalMasterSheetSchemaCurrent(masterUrl) : false;
      if (!masterUrl || !currentSchema) {
        await buildFinalMaster(masterUrl ? 'rebuild final master' : 'build final master');
      }
    }
    if (request.targetMode === 'master_total' && request.targetTotal) {
      const reconciled = await reconcileFinalMasterRegistry(request);
      const desired = Math.max(0, Number(request.targetTotal || 0));
      const masterUrl = finalMaster.masterSheetUrl() || request.destinationSheetUrl || null;
      const authoritative = masterUrl
        ? await sheetProgress.snapshot(masterUrl, { requireJob: Boolean(request.hiring) })
        : null;
      // Completion counts only companies that are both present in the Sheet
      // and verified in ULTRON's registry against the active hard requirements.
      // All Sheet rows still participate in dedupe and Apollo enrichment.
      const current = Number(reconciled.count || 0);
      const target = {
        desired,
        current,
        remaining: Math.max(0, desired - current),
        sheetUniqueCompanies: Number(authoritative?.uniqueCompanies || 0),
        source: authoritative ? 'verified-sheet-registry' : 'registry',
      };
      request.count = target.remaining;
      request.masterTarget = target;
      request.existingDestinationJobIds = authoritative?.jobIds || [];
      request.existingDestinationCompanyKeys = authoritative?.companyKeys || [];
      request.authoritativeSheetProgress = authoritative ? {
        uniqueCompanies: authoritative.uniqueCompanies,
        verifiedTargetCompanies: current,
        validRows: authoritative.validRows,
        totalDataRows: authoritative.totalDataRows,
        readAt: authoritative.readAt,
      } : null;
    }
    if (request.useFinalMaster || request.targetMode === 'master_total') {
      request.destinationSheetUrl = finalMaster.masterSheetUrl() || request.destinationSheetUrl;
    }
  }

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

    missionRunner.persistResearch(researched);
    const persisted = loadState();
    const checkpointMission = persisted.missions.find(item => item.id === mission.id);
    if (checkpointMission) Object.assign(checkpointMission, { verifiedRecords: researched.records, status: 'writing_sheet' });
    saveState(persisted);
    const title = `ULTRON LinkedIn - ${String(request.topic || request.entityMode).replace(/[^a-z0-9 ()&+._-]+/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 65)} - ${new Date().toISOString().slice(0, 10)}`;
    const needsInternalContact = request.entityMode === 'company' && request.wantsContacts && !isFinalMasterRequest(request);

    let destination = null;
    let destinationWriteError = null;
    let outputHeaders = ensureHeaders(headers, request);
    let storageHeaders = [...outputHeaders];
    if (needsInternalContact && !storageHeaders.some((header) => headerKey(header) === 'contactLinkedin')) {
      storageHeaders.push(INTERNAL_CONTACT_HEADER);
    }

    let sheet;
    let recordsToWrite = researched.records.slice();
    let duplicateRowsSkipped = 0;
    let firstAppendedRow = 2;
    let added = 0;
    const writeReceipt = {};

    try {
      if (request.destinationSheetUrl) {
        destination = await inspectDestinationSheet(request.destinationSheetUrl, request);
        outputHeaders = ensureHeaders(destination.headers, request, { preserveExisting: true });
        storageHeaders = [...outputHeaders];
        if (needsInternalContact && !storageHeaders.some((header) => headerKey(header) === 'contactLinkedin')) {
          storageHeaders.push(INTERNAL_CONTACT_HEADER);
        }

        await syncDestinationHeaders(destination, storageHeaders);
        const existingKeys = destinationExistingKeys(destination, storageHeaders, request);
        recordsToWrite = researched.records.filter((record) => {
          const keys = recordDestinationKeys(record);
          const duplicate = keys.some((key) => existingKeys.has(key));
          if (!duplicate) for (const key of keys) existingKeys.add(key);
          return !duplicate;
        });
        duplicateRowsSkipped = researched.records.length - recordsToWrite.length;
        firstAppendedRow = Math.max(destination.lastNonEmptyRow + 1, destination.headerRowNumber + 1);
        sheet = {
          spreadsheetId: destination.spreadsheetId,
          sheetId: destination.sheetId,
          sheetName: destination.sheetName,
          title: destination.spreadsheetTitle,
          url: request.destinationSheetUrl,
          formatted: true,
        };
      } else {
        sheet = await v2.createSpreadsheet(title, storageHeaders, request.count);
      }

      await sheets.ensureGridSize(sheet.spreadsheetId, sheet.sheetId, {
        minColumns: Math.max(1, storageHeaders.length),
        minRows: Math.max(200, firstAppendedRow + recordsToWrite.length + 5),
      });
      const rows = recordsToWrite.map((record) => rowFor(record, storageHeaders, request));
      added = await appendRows(sheet.spreadsheetId, sheet.sheetName, rows, writeReceipt);
    } catch (error) {
      if (!request.destinationSheetUrl || !isGoogleSheetsError(error)) throw error;

      destinationWriteError = sheetErrorSnapshot(error);
      destination = null;
      duplicateRowsSkipped = 0;
      recordsToWrite = researched.records.slice();
      outputHeaders = ensureHeaders(headers, request);
      storageHeaders = [...outputHeaders];
      if (needsInternalContact && !storageHeaders.some((header) => headerKey(header) === 'contactLinkedin')) {
        storageHeaders.push(INTERNAL_CONTACT_HEADER);
      }

      const recoveryTitle = `${title} - Recovery`;
      try {
        sheet = await v2.createSpreadsheet(recoveryTitle, storageHeaders, request.count);
        firstAppendedRow = 2;
        const rows = recordsToWrite.map((record) => rowFor(record, storageHeaders, request));
        added = await appendRows(sheet.spreadsheetId, sheet.sheetName, rows);
      } catch (fallbackError) {
        const combined = new Error(
          `Master Sheet failed: ${destinationWriteError.message}. Recovery Sheet also failed: ${fallbackError.message}`
        );
        combined.code = fallbackError.code || error.code || 'GOOGLE_SHEETS_API_ERROR';
        combined.status = fallbackError.status || error.status || null;
        throw combined;
      }
    }

    if (needsInternalContact) {
      const helperIndex = storageHeaders.findIndex((header) => headerKey(header) === 'contactLinkedin');
      if (helperIndex >= 0) {
        try { await hideInternalContactColumn(sheet.spreadsheetId, sheet.sheetId, helperIndex); } catch {}
      }
    }

    mission.status = 'completed';
    mission.writeReceipt = writeReceipt;
    if (writeReceipt.range) {
      const link = new URL(sheet.url);
      link.hash = `gid=${sheet.sheetId}&range=${encodeURIComponent(writeReceipt.range.split('!').pop())}`;
      sheet.url = link.toString();
    }
    mission.completedAt = nowIso();
    mission.criteriaSignature = criteriaSignature(request);
    mission.sheetUrl = sheet.url;
    mission.sheetName = sheet.sheetName;
    mission.spreadsheetTitle = sheet.title;
    mission.headers = outputHeaders;
    mission.storageHeaders = storageHeaders;
    mission.destinationMode = destination
      ? 'existing-sheet'
      : destinationWriteError
        ? 'recovery-sheet'
        : 'created-sheet';
    mission.requestedDestinationSheetUrl = request.destinationSheetUrl || null;
    mission.destinationWriteError = destinationWriteError;
    mission.destinationHeaderRow = destination?.headerRowNumber || 1;
    mission.requested = request.count;
    mission.found = researched.records.length;
    mission.added = added;
    mission.duplicateRowsSkipped = duplicateRowsSkipped;
    mission.toolCalls = researched.toolCalls;
    mission.locationExpansion = researched.toolCalls?.locationExpansion || null;
    mission.outputMode = request.wantsContacts ? 'contact-enrichment' : 'lead-discovery';
    mission.apolloCalls = 0;
    mission.averageScore = researched.records.length
      ? Math.round(researched.records.reduce((sum, record) => sum + Number(record.relevanceScore || 0), 0) / researched.records.length)
      : 0;
    mission.contactsFromLinkedIn = request.entityMode === 'company' ? { emails: 0, phones: 0 } : {
      emails: recordsToWrite.filter((record) => record.email).length,
      phones: recordsToWrite.filter((record) => record.phone).length,
    };
    mission.contactTargets = request.entityMode === 'company'
      ? recordsToWrite.map((record, index) => ({
        rowNumber: firstAppendedRow + index,
        company: record.company,
        companyLinkedin: record.linkedin,
        website: record.website || '',
        domain: websiteDomain(record.website),
      }))
      : [];
    mission.contactCandidates = request.entityMode === 'company'
      ? mission.contactTargets.length
      : recordsToWrite.filter((record) => record.linkedin).length;
    mission.missingContacts = recordsToWrite.filter((record) => !record.email || !record.phone).length;
    mission.internalContactColumnHidden = needsInternalContact;
    mission.budgetStopped = researched.budgetStopped || null;
    mission.searchStrategiesExhausted = Boolean(researched.searchStrategiesExhausted);
    mission.filters = researched.filters || request.filters || {};
    mission.filterVerification = researched.filterVerification || null;
    mission.linkedinSearchWarning = researched.linkedinSearchWarning || null;
    mission.linkedinSearchWarnings = Array.isArray(researched.linkedinSearchWarnings) ? researched.linkedinSearchWarnings : [];
    mission.rejectedRecords = Array.isArray(researched.rejectedRecords) ? researched.rejectedRecords : [];
    mission.verifiedRecords = researched.records.map(verifiedRecordSnapshot);
    mission.safety = policy.status();
    mission.globalSeenSkipped = Number(researched.toolCalls?.globallySeenSkipped || 0);
    mission.masterTarget = request.masterTarget || null;

    if (request.entityMode === 'company' && recordsToWrite.length) {
      finalMaster.registerRecords(recordsToWrite, { missionId: mission.id });
      if (request.useFinalMaster || request.targetMode === 'master_total') {
        finalMaster.setMasterSheet({
          url: sheet.url,
          spreadsheetId: sheet.spreadsheetId,
          sheetName: sheet.sheetName,
          title: sheet.title,
        });
      }
    }

    const latest = loadState();
    const target = latest.missions.find((item) => item.id === mission.id);
    if (target) Object.assign(target, mission);
    latest.pending = null;
    if (!destinationWriteError) {
      rememberWorkspaceSheet(sheet.url, {
        sheetName: sheet.sheetName,
        spreadsheetTitle: sheet.title,
        entityMode: request.entityMode,
      }, latest);
    }
    saveState(latest);
    v2.rememberTemplate(outputHeaders, { sourceTitle: sheet.title, sourceUrl: sheet.url, provider: 'linkedin-account' });
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
  const state = loadState();
  return {
    readyForRouting: true,
    stateFile: STATE_FILE,
    workspace: state.workspace || null,
    mcp: mcp.status(),
    joeyism: joeyism.status(),
    safety: policy.status(),
    pending: Boolean(pendingRequest()),
    latestMission: latestMission(),
    linkedinOnlyResearch: true,
    externalSourceFusionDisabledForExplicitLinkedIn: true,
    companyLinkType: 'linkedin-company-profile',
    apolloDecisionMakerSelection: true,
    apolloDecisionMakerPriority: {
      hiring: ['director/founder/owner', 'lead recruiter/general manager', 'HR recruiter'],
      general: ['director/founder/owner', 'lead recruiter/general manager', 'HR recruiter'],
    },
  };
}

function statusText() {
  const s = status();
  const safety = s.safety;
  const lock = safety.manualLock ? ` LOCKED: ${safety.manualLock.reason}` : safety.cooldownUntil ? ` Cooldown until ${safety.cooldownUntil}.` : '';
  const apolloReady = apollo.status().apiKeyReady && apollo.status().webhookReady;
  const testMode = safety.localBudgetBypass ? ' TEMP TEST MODE: local burst/hourly/daily budgets are bypassed; real LinkedIn cooldowns, checkpoints and write-action blocks remain enforced.' : '';
  const mcpStatus = mcp.status();
  return `LinkedIn Account Research: dedicated LinkedIn-only routing is ready. Primary backend: ${mcpStatus.provider} ${mcpStatus.package} through ${mcpStatus.transport} MCP using ${mcpStatus.sdk}; connected=${mcpStatus.sessionInitialized ? 'yes' : 'no'}, required tools discovered=${mcpStatus.discoveredTools?.length || 0}. Apollo company-head selection/contact enrichment ${apolloReady ? 'ready' : 'needs API key + webhook setup'}. Optional joeyism fallback ${s.joeyism.enabled ? (s.joeyism.sessionReady ? 'enabled and session-ready' : 'enabled but needs manual session setup') : 'disabled'}. Usage: ${safety.hourlyUsed}/${safety.hourlyMax} this hour, ${safety.dailyUsed}/${safety.dailyMax} today. Minimum call gap ${Math.round(safety.minGapMs / 1000)}s, deep-profile cap ${safety.deepProfilesPerMission}/mission. LinkedIn write actions are disabled.${testMode}${lock}`;
}

function formatMission(mission) {
  const masterTargetText = mission.masterTarget
    ? ` Master target: ${mission.masterTarget.desired} unique companies total; ${mission.masterTarget.current} already existed before this run; ${mission.masterTarget.remaining} additional unique companies were required.`
    : '';
  const globalSkipText = mission.globalSeenSkipped
    ? ` Global dedupe skipped ${mission.globalSeenSkipped} previously seen compan${mission.globalSeenSkipped === 1 ? 'y' : 'ies'}.`
    : '';
  const shortfall = mission.found < mission.requested ? ` I found ${mission.found}/${mission.requested} high-confidence LinkedIn records within the account-safety budget.` : '';
  const contact = mission.request?.entityMode === 'company' && !mission.request?.wantsContacts
    ? ' POC/contact enrichment: not requested. Apollo calls: 0.'
    : mission.request?.entityMode === 'company'
      ? ` ${mission.contactCandidates || 0} verified company rows are ready for explicitly requested contact enrichment.`
    : ` ${mission.contactCandidates || 0} LinkedIn person profiles are ready for direct Apollo matching.`;
  const budget = mission.budgetStopped ? ` Safety stop: ${mission.budgetStopped}.` : '';
  const rejected = mission.filterVerification?.rejected || {};
  const rejectedCandidates = Number(mission.filterVerification?.rejectedCandidates || 0);
  const reasonText = Object.entries(rejected)
    .filter(([, value]) => Number(value || 0) > 0)
    .map(([key, value]) => `${key.replace(/_/g, ' ')}:${value}`)
    .join(', ');
  const hardGate = mission.filterVerification?.hardGate
    ? ` Hard-filter gate rejected ${rejectedCandidates} candidate${rejectedCandidates === 1 ? '' : 's'}${reasonText ? ` (${reasonText})` : ''}.`
    : '';
  const jobTrace = mission.request?.entityMode === 'company' && mission.request?.hiring
    ? ` Target-driven verification: topic “${mission.toolCalls?.parsedTopic || mission.request?.topic || ''}”, ${mission.toolCalls?.searchJobs || 0} searches, ${mission.toolCalls?.jobIdsDiscovered || 0} unique LinkedIn job IDs, ${mission.toolCalls?.jobDetails || 0} prioritized job details checked, ${mission.toolCalls?.jobCandidatesLinked || 0} linked to companies, ${mission.toolCalls?.jobCandidatesPassed || 0} passed job-level SAP/location/remote checks, ${mission.toolCalls?.deepCompanyProfiles || 0} company profiles checked, ${mission.toolCalls?.verifiedDuringRun || 0} verified companies reached during the run.`
    : '';
  const warnings = Array.isArray(mission.linkedinSearchWarnings) ? mission.linkedinSearchWarnings : [];
  const searchWarning = warnings.length
    ? ` LinkedIn reported ${warnings.length} search warning${warnings.length === 1 ? '' : 's'}; results were still re-verified individually.`
    : mission.linkedinSearchWarning?.error_message
      ? ` LinkedIn search warning: ${mission.linkedinSearchWarning.error_message}`
      : '';
  const destination = mission.destinationMode === 'existing-sheet'
    ? ` Filled your existing Sheet and added ${mission.added} new row${mission.added === 1 ? '' : 's'}${mission.duplicateRowsSkipped ? `; skipped ${mission.duplicateRowsSkipped} duplicate${mission.duplicateRowsSkipped === 1 ? '' : 's'} already present` : ''}.`
    : mission.destinationMode === 'recovery-sheet'
      ? ` The requested master Sheet could not be written (${mission.destinationWriteError?.code || 'GOOGLE_SHEETS_API_ERROR'}: ${mission.destinationWriteError?.message || 'unknown Sheets error'}). I preserved the verified results in this recovery Sheet instead; your remembered master Sheet was not changed.`
      : '';
  const label = mission.found < mission.requested || mission.budgetStopped
    ? 'Partial result — safe search exhausted'
    : 'LinkedIn lead discovery complete';
  const expansion = mission.locationExpansion
    ? ` Location expansion: ${mission.locationExpansion.requested || mission.request?.location || 'requested area'} → approximately ${mission.locationExpansion.currentRadiusKm} km (${mission.locationExpansion.searchedLocations.join(', ')}).`
    : '';
  const destinationLabel = mission.sheetName
    ? `worksheet “${mission.sheetName}” in “${mission.spreadsheetTitle}”`
    : `“${mission.spreadsheetTitle}”`;
  return `${label}, Sir. Added ${mission.added} records to ${destinationLabel}.${destination}${masterTargetText}${globalSkipText} Discovery and filter verification used only the authenticated LinkedIn account tool; Google Jobs, Maps, TinyFish, public-index SerpApi and Apollo were not used for discovery. Average quality score ${mission.averageScore}/100.${jobTrace}${hardGate}${expansion}${contact}${shortfall}${budget}${searchWarning} ${mission.sheetUrl}`;
}

module.exports = {
  verifyAppend,
  COMPANY_HEADERS,
  LEAD_DISCOVERY_HEADERS,
  PERSON_HEADERS,
  INTERNAL_CONTACT_HEADER,
  APOLLO_SECTION_HEADERS,
  isRequest,
  parseCount,
  parseExplicitCount,
  parseRequest,
  parseEmployeeRange,
  parseFilters,
  hiringIntentFromText,
  requestTopic,
  locationScopeFromText,
  headerKey,
  ensureHeaders,
  isFinalMasterRequest,
  pendingRequest,
  latestCompletedMission,
  workspaceSheetUrl,
  isGoogleSheetsError,
  sheetErrorSnapshot,
  rememberWorkspaceSheet,
  prepare,
  resolvePending,
  flattenText,
  collectReferences,
  linkedInReferences,
  jobIdsFromResult,
  qualityScore,
  applicantCountFromText,
  applicantCountFromDetail,
  postedEvidenceFromText,
  employeeCountFromText,
  companyEvidenceFromJobDetail,
  companyProfileRequired,
  indirectEmployerPosting,
  passesEmployeeFilter,
  scopedCompanyEvidence,
  detectWorkType,
  locationLabelMatchesRequested,
  locationEvidenceDetails,
  locationEvidenceMatches,
  workTypeEvidenceDetails,
  workTypeEvidenceMatches,
  topicEvidenceMatches,
  companyFilterFailures,
  passesCompanyHardFilters,
  rejectedRecordSnapshot,
  dedupeRecords,
  sapRoleKeywordVariants,
  jobSearchPlan,
  droppedSearchFilters,
  searchFilterTrust,
  jobReferenceMap,
  searchLocationMatches,
  jobIdPriority,
  searchTopicConfidence,
  prioritizedJobIds,
  verificationReadyJobIds,
  jobLevelFailures,
  activeJobPosting,
  jobTitleFromDetail,
  joeyismJobToDetail,
  joeyismCompanyText,
  criteriaSignature,
  previousCheckedJobIds,
  reconsiderRejectedCandidates,
  isTransientMcpFailure,
  companyMission,
  personSearchPlan,
  personMission,
  exactMission,
  contactRemark,
  verifiedRecordSnapshot,
  isExistingSheetFillRequest,
  fillLatestMissionIntoSheet,
  isContinueSearchRequest,
  prepareContinuation,
  isConsolidateRequest,
  consolidatedRecordKey,
  consolidateVerifiedMissions,
  explicitDeletionIntent,
  isDedupeSheetRequest,
  dedupeWorkspaceSheet,
  rowFor,
  destinationHeaderCandidate,
  destinationExistingKeys,
  recordDestinationKeys,
  websiteDomain,
  rejectedSheetHeaders,
  rejectedSheetRow,
  latestRejectedMission,
  isRejectedSheetRequest,
  createRejectedCandidatesSheet,
  ensureApolloSection,
  prepareApolloSheetContacts,
  apolloValuePresent,
  apolloStatusForValues,
  finalizeApolloSheetStatuses,
  prepareApolloCompanyContacts,
  enrichFinalMasterContacts,
  isBuildFinalMasterRequest,
  finalMasterSheetSchemaCurrent,
  repairFinalMasterSheetSchema,
  historicalVerifiedCompanyRecords,
  buildFinalMaster,
  reconcileFinalMasterRegistry,
  run,
  latestMission,
  status,
  statusText,
  formatMission,
};
