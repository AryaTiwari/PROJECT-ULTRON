'use strict';

const COMPANY_WORDS = /\b(?:compan(?:y|ies)|startups?|businesses|firms|organizations?|organisations?|accounts?)\b/i;
const PEOPLE_WORDS = /\b(?:founders?|co[- ]?founders?|owners?|directors?|recruiters?|hr\s+managers?|talent\s+acquisition|people|persons?|contacts?|decision[- ]?makers?|pocs?)\b/i;
const ACTION_WORDS = /\b(?:find|discover|search|source|list|show|bring|get|identify|build|fill|add|enrich|repair|complete)\b/i;

const EXPANSIONS = Object.freeze({
  ai: ['artificial intelligence', 'machine learning', 'generative ai', 'ai saas', 'ai platform', 'ai product'],
  saas: ['software as a service', 'cloud software', 'b2b software'],
  cybersecurity: ['cyber security', 'information security', 'network security'],
  'hr tech': ['hrtech', 'human resources technology', 'talent technology'],
  fintech: ['financial technology', 'payments technology'],
  sap: ['enterprise resource planning', 'erp', 'sap services'],
});

function text(value) { return String(value == null ? '' : value).trim(); }
function unique(values = []) { return [...new Set(values.map((v) => text(v).toLowerCase()).filter(Boolean))]; }

function parseCount(input, fallback = 20) {
  const match = text(input).match(/\b(?:find|discover|search|source|list|show|bring|get|identify|build|fill|add)\s+(?:me\s+)?(\d{1,3})\b/i)
    || text(input).match(/\b(\d{1,3})\s+(?:unique\s+)?(?:compan(?:y|ies)|startups?|people|persons?|founders?|recruiters?|contacts?)\b/i);
  return Math.max(1, Math.min(100, Number(match?.[1] || fallback)));
}

function parseEmployeeRange(input) {
  const value = text(input);
  const range = value.match(/\b(?:with\s+)?(\d[\d,]*)\s*(?:-|to|–|—)\s*(\d[\d,]*)\s+employees?\b/i);
  if (range) return { min: Number(range[1].replace(/,/g, '')), max: Number(range[2].replace(/,/g, '')), explicit: true };
  const under = value.match(/\b(?:under|below|fewer\s+than|less\s+than|up\s+to|max(?:imum)?)\s+(\d[\d,]*)\s+employees?\b/i);
  if (under) return { min: 1, max: Number(under[1].replace(/,/g, '')), explicit: true };
  const over = value.match(/\b(?:over|above|more\s+than|at\s+least|min(?:imum)?)\s+(\d[\d,]*)\s+employees?\b/i);
  if (over) return { min: Number(over[1].replace(/,/g, '')), max: null, explicit: true };
  return { min: 10, max: 500, preferredMin: 20, preferredMax: 300, explicit: false };
}

function parseGeography(input) {
  const value = text(input);
  const known = value.match(/\b(India|Bangalore|Bengaluru|Mumbai|Maharashtra|Delhi|Hyderabad|Pune|Chennai|Kolkata|Gurugram|Gurgaon|Noida|United States|USA|United Kingdom|UK|Singapore|Dubai)\b/i);
  if (known) return known[1].replace(/^usa$/i, 'United States').replace(/^uk$/i, 'United Kingdom');
  const clause = value.match(/\b(?:based|headquartered|located)\s+in\s+([A-Za-z][A-Za-z .-]{1,40}?)(?=\s+(?:with|and|that|under|having)|[,.]|$)/i);
  return text(clause?.[1]);
}

function baseKeywords(input) {
  const value = text(input).toLowerCase();
  const found = [];
  const known = [
    ['ai', /\b(?:ai|artificial intelligence|machine learning|generative ai)\b/i],
    ['saas', /\bsaas\b|software as a service/i],
    ['cybersecurity', /\bcyber\s*security\b|\binformation security\b/i],
    ['hr tech', /\bhr[- ]?tech\b|human resources technology/i],
    ['fintech', /\bfintech\b|financial technology/i],
    ['sap', /\bsap\b/i],
  ];
  for (const [key, re] of known) if (re.test(value)) found.push(key);
  if (/\bproduct\b/i.test(value)) found.push('product');
  if (/\btechnology|\btech\b/i.test(value)) found.push('technology');
  if (/\bsoftware\b/i.test(value)) found.push('software');
  if (/\bstartup/i.test(value)) found.push('startup');
  return unique(found.length ? found : ['technology']);
}

function keywordExpansion(keywords) {
  const out = [...keywords];
  for (const keyword of keywords) out.push(...(EXPANSIONS[keyword] || []));
  return unique(out).slice(0, 12);
}

function parseSheet(input) {
  const value = text(input);
  const url = value.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+[^\s)]*/i)?.[0]?.replace(/[),.;!?]+$/, '') || '';
  const name = value.match(/\b(?:worksheet|tab|sheet)\s+(?:named\s+)?["'`“”]?([^\n,.;"'`“”]{1,100})["'`“”]?/i)?.[1]?.trim() || '';
  return { url, sheetName: /^(?:at|below|link)$/i.test(name) ? '' : name };
}

function enrichmentRequested(input) {
  const value = text(input);
  if (/\b(?:do\s+not|don't|without|no)\s+(?:find\s+)?(?:pocs?|contacts?|phones?|emails?|apollo|enrich)/i.test(value)) return false;
  return /\b(?:enrich|fill|repair|complete)\b[\s\S]{0,80}\b(?:pocs?|contacts?|phones?|emails?)\b|\b(?:enrich|with)\s+both\s+pocs?\b/i.test(value);
}

function existingSheetEnrichment(input) {
  const value = text(input);
  const sheet = parseSheet(value);
  const spreadsheetContext = Boolean(sheet.url || (/@[\w .()\-]{2,}/.test(value) && /\b(?:sheet|spreadsheet|workbook|tab|worksheet)\b/i.test(value)));
  return Boolean(spreadsheetContext && /\b(?:enrich(?:ment)?|fill|repair|complete|update)\b/i.test(value) && /\b(?:poc|contact|phone|email)/i.test(value));
}

function peopleEntity(input) {
  const value = text(input);
  return PEOPLE_WORDS.test(value) && !COMPANY_WORDS.test(value.split(/\b(?:from|at|of)\b/i)[0] || '')
    && /\b(?:founders?|co[- ]?founders?|owners?|directors?|recruiters?|hr\s+managers?|talent\s+acquisition|people|persons?|contacts?)\b/i.test(value);
}

function titleTerms(input) {
  const value = text(input);
  const groups = [];
  if (/\bfounder|co[- ]?founder|owner/i.test(value)) groups.push('Founder', 'Co-Founder', 'Owner');
  if (/\bdirector/i.test(value)) groups.push('Director', 'Managing Director');
  if (/\brecruit|talent acquisition|staffing|hiring/i.test(value)) groups.push('Recruiter', 'Talent Acquisition', 'Recruitment Manager');
  if (/\bhr\b|human resources/i.test(value)) groups.push('HR Manager', 'Human Resources Manager');
  return [...new Set(groups)];
}

function compile(input) {
  const query = text(input);
  const sheet = parseSheet(query);
  const existing = existingSheetEnrichment(query);
  const people = !existing && peopleEntity(query);
  const enrich = enrichmentRequested(query);
  const targetCount = parseCount(query);
  const size = parseEmployeeRange(query);
  const keywords = baseKeywords(query);
  const reserveCount = enrich ? Math.min(15, Math.max(5, Math.ceil(targetCount * 0.5))) : 0;
  return Object.freeze({
    query,
    missionType: existing ? 'apollo_existing_sheet_enrichment' : people ? 'apollo_people_discovery' : enrich ? 'apollo_company_discovery_and_enrichment' : 'apollo_company_discovery',
    entityType: existing ? 'sheet' : people ? 'person' : 'organization',
    targetCount,
    reserveCount,
    geography: parseGeography(query),
    employeeRange: size,
    keywords,
    expandedKeywords: keywordExpansion(keywords),
    titles: titleTerms(query),
    startupPreference: /\bstartups?|founder[- ]led|growing\b/i.test(query),
    productPreference: /\bproduct\b/i.test(query),
    enrichmentRequested: enrich,
    requestedPocs: /\b(?:both|first\s+and\s+second|1st\s+and\s+2nd|poc[- ]?1\s+and\s+poc[- ]?2|two)\s+pocs?\b/i.test(query) ? 2 : /\b(?:poc[- ]?2|second\s+poc|2nd\s+poc)\b/i.test(query) ? 2 : 1,
    sheet,
  });
}

function isApolloLeadRequest(input) {
  const value = text(input);
  if (!value || /\blinkedin\b/i.test(value) || /\bgoogle\s+maps?\b/i.test(value)) return false;
  if (/\b(?:active|ongoing|current)\s+(?:job|hiring)|\bjob\s+(?:openings?|roles?|vacancies)|\bposted\s+(?:within|in)|\bpast\s+(?:week|month|\d+\s+days)|\bremote\s+jobs?\b/i.test(value)) return false;
  // Existing-sheet POC repair stays owned by the proven universal controller;
  // Apollo lead discovery remains a distinct first-class source domain.
  if (existingSheetEnrichment(value)) return false;
  return ACTION_WORDS.test(value) && (COMPANY_WORDS.test(value) || PEOPLE_WORDS.test(value)) && (/\bapollo\b/i.test(value) || /\b(?:startups?|saas|ai|cyber|fintech|product|technology|software|founders?|recruiters?)\b/i.test(value));
}

module.exports = { compile, isApolloLeadRequest, parseCount, parseEmployeeRange, parseGeography, baseKeywords, keywordExpansion, parseSheet, enrichmentRequested, existingSheetEnrichment, titleTerms };
