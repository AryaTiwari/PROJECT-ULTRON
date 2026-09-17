'use strict';

// Model-free exact-profile parser used by universal enrichment. It accepts several
// LinkedIn MCP/scraper response shapes and resolves a current employer only when the
// payload contains explicit current/present evidence or a safely corroborated structured field.

const LEGAL_SUFFIXES = new Set(['pvt','private','ltd','limited','llp','llc','inc','incorporated','corp','corporation','co','company','plc','gmbh','pte']);

function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function normalized(value) { return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function companyTokens(value) { return normalized(value).split(' ').filter((token) => token && !LEGAL_SUFFIXES.has(token)); }

function parsedRawObject(value) {
  if (!value || typeof value !== 'object') return null;
  const raw = typeof value.rawText === 'string' ? value.rawText.trim() : '';
  if (!raw || (!raw.startsWith('{') && !raw.startsWith('['))) return null;
  try { const parsed = JSON.parse(raw); return parsed && typeof parsed === 'object' ? parsed : null; } catch { return null; }
}

function profileCandidates(payload) {
  const out = [];
  const push = (value) => { if (value && typeof value === 'object' && !out.includes(value)) out.push(value); };
  push(payload); push(payload?.data); push(payload?.result); push(payload?.profile); push(payload?.person); push(parsedRawObject(payload));
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
  if (Array.isArray(value)) return value.map(sectionText).filter(Boolean).join('\n\n');
  if (value && typeof value === 'object') return Object.values(value).map(sectionText).filter(Boolean).join('\n');
  return '';
}

function evidenceFrom(payload) {
  const sections = sectionsFrom(payload);
  if (!sections) return '';
  return Object.entries(sections).map(([name, value]) => {
    const body = sectionText(value);
    return body ? `--- ${String(name).toUpperCase()} ---\n${body}` : '';
  }).filter(Boolean).join('\n').slice(0, 30000);
}

function companyMatchesEvidence(company, evidence) {
  const needle = normalized(company); const haystack = normalized(evidence);
  if (!needle || !haystack) return false;
  if (haystack.includes(needle)) return true;
  const tokens = companyTokens(company);
  if (!tokens.length) return false;
  const matched = tokens.filter((token) => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(haystack));
  return tokens.length <= 2 ? matched.length === tokens.length : matched.length / tokens.length >= 0.8;
}

function structuredCurrentEmployer(payload) {
  for (const candidate of profileCandidates(payload)) {
    const direct = clean(candidate.current_company || candidate.currentCompany || candidate.current_organization?.name || candidate.currentOrganization?.name || '');
    if (direct) return { company: direct, title: clean(candidate.job_title || candidate.jobTitle || candidate.title), source: 'structured-current-company', confidence: 0.99 };
    const lists = [candidate.experiences, candidate.experience, candidate.positions, candidate.employment_history].filter(Array.isArray);
    for (const list of lists) {
      for (let index = 0; index < list.length; index++) {
        const item = list[index] || {};
        const end = clean(item.to_date || item.end_date || item.endDate || item.date_to || item.dateTo).toLowerCase();
        const current = item.current === true || item.is_current === true || item.isCurrent === true || item.present === true || /\b(?:present|current|now|ongoing)\b/.test(end);
        if (!current) continue;
        const company = clean(item.organization_name || item.company_name || item.company?.name || item.organization?.name || item.employer?.name || item.employer);
        if (!company) continue;
        return { company, title: clean(item.position_title || item.title || item.job_title || item.role), source: 'structured-current-experience', confidence: 0.99 };
      }
    }
  }
  return null;
}

function explicitCurrentMarker(line) { return /\b(?:present|current|currently|ongoing|now)\b/i.test(line); }
function dateLike(line) { return /\b(?:19|20)\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(line); }
function employmentMeta(line) { return /^(?:full[- ]?time|part[- ]?time|contract|freelance|self[- ]?employed|internship|temporary|apprenticeship|seasonal)(?:\s|$)/i.test(clean(line)); }
function locationLike(line) { return /\b(?:india|united states|uk|usa|remote|hybrid|onsite|greater|area|metropolitan)\b/i.test(line) && /,|area|remote|hybrid|onsite/i.test(line); }
function stripEmploymentMeta(line) { return clean(String(line || '').split(/\s+[·•]\s+(?:Full[- ]?time|Part[- ]?time|Contract|Freelance|Self[- ]?employed|Internship|Temporary|Apprenticeship|Seasonal)\b/i)[0]); }

function experienceBlocks(payload) {
  const sections = sectionsFrom(payload);
  if (!sections) return [];
  const experience = sections.experience || sections.experiences || sections.employment;
  if (Array.isArray(experience)) return experience.map(sectionText).filter(Boolean);
  const raw = sectionText(experience);
  if (!raw) return [];
  const blocks = raw.split(/\n\s*\n|\r\n\s*\r\n/).map((value) => value.trim()).filter(Boolean);
  return blocks.length > 1 ? blocks : [raw];
}

function explicitCurrentEmployer(payload) {
  const evidence = evidenceFrom(payload);
  for (const block of experienceBlocks(payload)) {
    const lines = String(block).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (!explicitCurrentMarker(lines[i])) continue;
      const before = lines.slice(Math.max(0, i - 6), i).filter((line) => !dateLike(line) && !employmentMeta(line) && !locationLike(line));
      if (!before.length) continue;
      const company = stripEmploymentMeta(before[before.length - 1]);
      const title = clean(before.length > 1 ? before[before.length - 2] : '');
      if (!company || company.length < 2 || /^(?:experience|employment)$/i.test(company)) continue;
      if (!companyMatchesEvidence(company, evidence)) continue;
      return { company, title, source: 'explicit-current-experience', confidence: 0.98, evidence: `${company} + explicit current marker` };
    }
  }
  return null;
}

function topCardEmployer(payload) {
  const sections = sectionsFrom(payload);
  const main = sectionText(sections?.main_profile || sections?.profile || sections?.main);
  const experience = sectionText(sections?.experience || sections?.experiences || sections?.employment);
  if (!main || !experience) return null;
  const patterns = [
    /\b(?:at|@)\s+([^|\n,]{2,100})/i,
    /\b(?:with)\s+([^|\n,]{2,100})/i,
  ];
  for (const pattern of patterns) {
    const company = clean(main.match(pattern)?.[1]);
    if (!company || !companyMatchesEvidence(company, experience)) continue;
    const currentBlock = experienceBlocks(payload).find((block) => explicitCurrentMarker(block) && companyMatchesEvidence(company, block));
    if (!currentBlock) continue;
    return { company, title: '', source: 'top-card-current-experience-corroboration', confidence: 0.92, evidence: `${company} in top card and current experience` };
  }
  return null;
}

function resolveCurrentEmployer(payload) {
  if (!payload || typeof payload !== 'object') return { resolved: false, reason: 'invalid-payload' };
  const structured = structuredCurrentEmployer(payload);
  if (structured?.company) return { resolved: true, ...structured };
  const explicit = explicitCurrentEmployer(payload);
  if (explicit?.company) return { resolved: true, ...explicit };
  const corroborated = topCardEmployer(payload);
  if (corroborated?.company) return { resolved: true, ...corroborated };
  return { resolved: false, reason: sectionsFrom(payload) ? 'no-explicit-current-employer' : 'no-profile-sections' };
}

module.exports = {
  clean,
  normalized,
  profileCandidates,
  sectionsFrom,
  sectionText,
  evidenceFrom,
  companyMatchesEvidence,
  structuredCurrentEmployer,
  explicitCurrentEmployer,
  topCardEmployer,
  resolveCurrentEmployer,
};
