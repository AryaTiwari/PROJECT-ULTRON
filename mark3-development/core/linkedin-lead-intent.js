'use strict';

const CONTACT_RE = /\b(?:enrich(?:ment)?|apollo|find\s+(?:me\s+)?(?:pocs?|recruiters?|hr\s+contacts?|decision[- ]?makers?)|find\s+(?:phone|email)s?|phones?|emails?|phone\s+numbers?|email\s+addresses?|fill\s+poc(?:[- ]?[123])?|contact\s+(?:info|information|details?))\b/i;
const DISCOVERY_RE = /\b(?:find|get|search|source|collect|discover|list|show|bring|fill|add)\b[\s\S]{0,100}\b(?:companies?|jobs?|openings?|roles?|leads?|startups?|employers?)\b/i;

function uniq(values = []) {
  const seen = new Set();
  return values.map((value) => String(value || '').trim()).filter(Boolean).filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function contactEnrichmentRequested(text) {
  const value = String(text || '');
  if (/\b(?:no|without)\s+(?:(?:contact\s+)?enrichment|apollo)\b|\b(?:do\s+not|don['’]t)\s+(?:use\s+)?(?:apollo|enrich)\b/i.test(value)) return false;
  return CONTACT_RE.test(value);
}

function isDiscoveryRequest(text) {
  const value = String(text || '').trim();
  return DISCOVERY_RE.test(value)
    || /\b(?:continue|resume|broaden|expand)\b[\s\S]{0,60}\b(?:linkedin|lead|mission|location|search)\b/i.test(value);
}

function postingAge(text) {
  const value = String(text || '');
  const range = value.match(/\b(?:from|between)\s+(\d{4}-\d{2}-\d{2})\s+(?:to|and)\s+(\d{4}-\d{2}-\d{2})\b/i);
  if (range) return { preset: 'custom', linkedinPreset: null, maxAgeDays: null, from: range[1], to: range[2] };
  if (/\b(?:today|past\s+(?:day|24\s+hours?)|last\s+24\s+hours?)\b/i.test(value)) return { preset: 'past_24_hours', linkedinPreset: 'past_24_hours', maxAgeDays: 1 };
  if (/\byesterday\b/i.test(value)) return { preset: 'yesterday', linkedinPreset: 'past_week', maxAgeDays: 2 };
  const days = value.match(/\b(?:past|last)\s+(\d{1,2})\s+days?\b/i);
  if (days) {
    const count = Math.max(1, Math.min(30, Number(days[1])));
    return { preset: `past_${count}_days`, linkedinPreset: count <= 1 ? 'past_24_hours' : count <= 7 ? 'past_week' : 'past_month', maxAgeDays: count };
  }
  const weeks = value.match(/\b(?:past|last)\s+(\d{1,2})\s+weeks?\b/i);
  if (weeks) {
    const count = Math.max(1, Math.min(4, Number(weeks[1]))) * 7;
    return { preset: `past_${count}_days`, linkedinPreset: count <= 7 ? 'past_week' : 'past_month', maxAgeDays: count };
  }
  if (/\b(?:past|last)\s+week\b|\blast\s+7\s+days\b/i.test(value)) return { preset: 'past_week', linkedinPreset: 'past_week', maxAgeDays: 7 };
  if (/\b(?:past|last)\s+month\b|\blast\s+30\s+days\b|\bthis\s+month\b/i.test(value)) return { preset: 'past_month', linkedinPreset: 'past_month', maxAgeDays: 30 };
  return null;
}

function radius(text) {
  const value = String(text || '');
  const match = value.match(/\bwithin\s+(\d{1,3}(?:\.\d+)?)\s*(km|kilomet(?:er|re)s?|mi|miles?)\b/i);
  const around = /\b(?:near|nearby|around|metro(?:\s+area)?)\b/i.test(value);
  const explicitExpand = /\b(?:expand|broaden|widen|gradually|until\s+(?:you\s+)?reach)\b/i.test(value);
  if (!match && !around && !explicitExpand) return null;
  const raw = match ? Number(match[1]) : 0;
  const km = match && /^mi/i.test(match[2]) ? Math.round(raw * 1.60934) : Math.round(raw);
  const maximum = explicitExpand ? Math.max(km || 0, 100) : (match ? km : 75);
  return {
    requestedRadiusKm: match ? km : null,
    initialRadiusKm: match ? km : 0,
    currentRadiusKm: match ? km : 0,
    maximumRadiusKm: maximum,
    expandable: Boolean(around || explicitExpand),
    stepsKm: [...new Set([0, 10, 25, 50, 75, 100].filter((step) => step <= maximum || step === km).concat(match ? [km] : []))].sort((a, b) => a - b),
  };
}

function workplace(text) {
  const value = String(text || '');
  if (/\b(?:any\s+work\s+mode|any\s+workplace|work\s+mode\s+doesn['’]?t\s+matter)\b/i.test(value)) return { hard: [], preferred: [] };
  const mentioned = [];
  if (/\bremote\b/i.test(value)) mentioned.push('remote');
  if (/\bhybrid\b/i.test(value)) mentioned.push('hybrid');
  if (/\b(?:on[- ]?site|onsite|in[- ]?office)\b/i.test(value)) mentioned.push('on_site');
  const preference = /\b(?:prefer(?:red|ably)?|ideally|mostly|priority|if\s+possible|okay|ok)\b/i.test(value)
    && !/\b(?:only|must|mandatory|required|strictly)\b[\s\S]{0,20}\b(?:remote|hybrid|on[- ]?site)\b|\b(?:remote|hybrid|on[- ]?site)\s+only\b/i.test(value);
  return preference ? { hard: [], preferred: uniq(mentioned) } : { hard: uniq(mentioned), preferred: [] };
}

function applicantFilter(text) {
  const value = String(text || '');
  const match = value.match(/\b(?:under|below|fewer\s+than|less\s+than|maximum|max|up\s+to)\s+(\d[\d,]*)\s+(?:applicants?|applications?)\b/i);
  if (match) return { max: Number(match[1].replace(/,/g, '')), lowCompetition: false };
  if (/\blow[- ]competition\s+jobs?\b/i.test(value)) return { max: 100, lowCompetition: true };
  return { max: null, lowCompetition: false };
}

function companyQualifiers(text) {
  const value = String(text || '');
  const excludes = [...value.matchAll(/\b(?:exclude|except|not)\s+(?:company|companies)?\s*["']?([A-Za-z0-9& .-]{2,60})["']?(?=,|\.|\band\b|$)/gi)].map((match) => match[1]);
  const includes = [...value.matchAll(/\binclude\s+(?:company|companies)?\s*["']?([A-Za-z0-9& .-]{2,60})["']?(?=,|\.|\band\b|$)/gi)].map((match) => match[1]);
  const industry = value.match(/\b(SaaS|software|manufacturing|fintech|healthcare|pharmaceutical|consulting|retail|e-?commerce)\s+(?:companies|company|startups?|firms?)\b/i)?.[1] || null;
  return { industry, startup: /\bstartups?\b/i.test(value), includeCompanies: uniq(includes), excludeCompanies: uniq(excludes) };
}

function roleVariants(topic) {
  const base = String(topic || '').trim();
  if (!base) return [];
  if (/^sap(?:\s+consultants?)?$/i.test(base)) return ['SAP Consultant', 'SAP Functional Consultant', 'SAP Technical Consultant', 'SAP ABAP Consultant', 'SAP FICO Consultant', 'SAP MM Consultant', 'SAP SD Consultant', 'SAP Basis Consultant'];
  if (/^(?:hr|human resources?)(?:\s+(?:executives?|roles?))?$/i.test(base)) return ['HR Executive', 'HR Recruiter', 'Talent Acquisition', 'Human Resources Specialist'];
  if (/^(?:ai|artificial intelligence)(?:\s+engineers?)?$/i.test(base)) return ['AI Engineer', 'Machine Learning Engineer', 'Applied AI Engineer', 'Generative AI Engineer'];
  if (/^sales(?:\s+(?:people|person|professional|roles?|executives?))?$/i.test(base)) return ['Sales Executive', 'Sales Representative', 'Business Development Executive', 'Account Executive'];
  return [base];
}

function roleFromText(text) {
  const value = String(text || '');
  const match = value.match(/\b(?:hiring|recruiting\s+for)\s+(.+?)(?=\s+(?:in|around|near|within|posted|during|from|under|below|with|remote|hybrid|on[- ]?site|maximum|max|past|last|this\s+month)\b|[,.]|$)/i)
    || value.match(/\bwith\s+(.+?)\s+(?:job\s+)?(?:openings?|vacancies|roles?|positions?)\b/i)
    || value.match(/\b(?:find|get|search(?:\s+for)?)\s+(.+?)\s+jobs?\b/i);
  if (!match?.[1]) return '';
  const role = match[1]
    .replace(/^(?:companies?|startups?|employers?)\s+/i, '')
    .replace(/^\d{1,3}\s+/, '')
    .replace(/^(?:(?:remote|hybrid|on[- ]?site|full[- ]?time|part[- ]?time|contract|internship)\s+)+/i, '')
    .replace(/\b(?:people|persons?)\b/i, 'professional')
    .replace(/\bconsultants\b/i, 'consultant')
    .replace(/\bengineers\b/i, 'engineer')
    .replace(/\bexecutives\b/i, 'executive')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^SAP\s+professionals?$/i.test(role)) return 'SAP';
  return role;
}

function applicantNumber(value) {
  const match = String(value || '').match(/\b(\d[\d,]*)\+?\b/);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function postedAgeDays(text, now = new Date()) {
  const value = String(text || '');
  if (/\b(?:just\s+now|today|\d+\s+(?:minutes?|hours?)\s+ago)\b/i.test(value)) return 0;
  if (/\byesterday\b/i.test(value)) return 1;
  const days = value.match(/\b(\d{1,3})\s+days?\s+ago\b/i);
  if (days) return Number(days[1]);
  const weeks = value.match(/\b(\d{1,2})\s+weeks?\s+ago\b/i);
  if (weeks) return Number(weeks[1]) * 7;
  const months = value.match(/\b(\d{1,2})\s+months?\s+ago\b/i);
  if (months) return Number(months[1]) * 30;
  const iso = value.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) {
    const date = new Date(`${iso[1]}T00:00:00Z`);
    if (!Number.isNaN(date.getTime())) return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86400000));
  }
  return null;
}

function compile(text, legacy = {}) {
  const age = postingAge(text);
  const work = workplace(text);
  const applicants = applicantFilter(text);
  const locationExpansion = radius(text);
  const company = companyQualifiers(text);
  return {
    outputMode: contactEnrichmentRequested(text) ? 'contact-enrichment' : 'lead-discovery',
    contactEnrichment: contactEnrichmentRequested(text),
    postingAge: age,
    workplaceTypes: work.hard,
    preferredWorkplaceTypes: work.preferred,
    applicantMax: applicants.max,
    lowCompetition: applicants.lowCompetition,
    locationExpansion,
    company,
    roleFamily: roleVariants(legacy.topic),
  };
}

module.exports = {
  CONTACT_RE,
  uniq,
  contactEnrichmentRequested,
  isDiscoveryRequest,
  postingAge,
  radius,
  workplace,
  applicantFilter,
  companyQualifiers,
  roleVariants,
  roleFromText,
  applicantNumber,
  postedAgeDays,
  compile,
};
