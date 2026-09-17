// Translate linkedin-mcp raw profile sections into the structured current-employer
// fields required by anchored 3-POC enrichment. Prefer deterministic extraction
// from an explicit Present/current experience entry; use OmniRoute only when the
// raw sections need semantic interpretation. Every accepted employer must remain
// anchored to text from the exact LinkedIn profile.

const threePoc = require('./three-poc-enrichment-operator');
const linkedinMcp = require('./linkedin-mcp-client');
const modelRouter = require('./model-router');

const INSTALL_FLAG = Symbol.for('ultron.mark3.threePocLinkedinProfileNormalizer.installed');
const LEGAL_SUFFIXES = new Set(['pvt','private','ltd','limited','llp','llc','inc','incorporated','corp','corporation','co','company','plc']);
let runState = freshState();

function freshState() {
  return {
    rawSectionProfiles: 0,
    deterministicAttempts: 0,
    deterministicSuccesses: 0,
    normalizationAttempts: 0,
    normalizationSuccesses: 0,
    lowConfidence: 0,
    resolvedFalse: 0,
    malformedJson: 0,
    evidenceMismatch: 0,
    noCompany: 0,
    noEvidence: 0,
    modelErrors: 0,
    providers: {},
    models: {},
  };
}

function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function parseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) { try { return JSON.parse(fenced); } catch {} }
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return JSON.parse(raw.slice(start, end + 1)); } catch {} }
  return null;
}
function modelText(result) {
  return String(result?.content || result?.text || result?.response || result?.message?.content || result?.choices?.[0]?.message?.content || '').trim();
}
function parsedRawObject(value) {
  if (!value || typeof value !== 'object') return null;
  const raw = typeof value.rawText === 'string' ? value.rawText.trim() : '';
  if (!raw || (!raw.startsWith('{') && !raw.startsWith('['))) return null;
  try { const parsed = JSON.parse(raw); return parsed && typeof parsed === 'object' ? parsed : null; } catch { return null; }
}
function profileCandidates(payload) {
  const out = []; const push = (value) => { if (value && typeof value === 'object' && !out.includes(value)) out.push(value); };
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
  const sections = sectionsFrom(payload); if (!sections) return '';
  const ordered = [['MAIN PROFILE', sections.main_profile || sections.profile || sections.main], ['EXPERIENCE', sections.experience]];
  for (const [name, value] of Object.entries(sections)) {
    if (['main_profile','profile','main','experience'].includes(name)) continue;
    ordered.push([String(name).toUpperCase(), value]);
  }
  return ordered.map(([name,value]) => { const text = sectionText(value); return text ? `--- ${name} ---\n${text}` : ''; }).filter(Boolean).join('\n').slice(0,24000);
}
function existingEmployer(payload) {
  for (const candidate of profileCandidates(payload)) {
    const company = clean(candidate?.current_company || candidate?.currentCompany || candidate?.organization?.name || candidate?.current_organization?.name || candidate?.currentOrganization?.name || '');
    if (company) return company;
  }
  return '';
}
function normalized(value) { return clean(value).toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim(); }
function companyTokens(value) { return normalized(value).split(' ').filter((token) => token && !LEGAL_SUFFIXES.has(token)); }
function evidenceContains(value, evidence) {
  const needle = normalized(value); const haystack = normalized(evidence);
  if (!needle || !haystack) return false;
  if (haystack.includes(needle)) return true;
  const tokens = companyTokens(value);
  if (!tokens.length) return false;
  const matched = tokens.filter((token) => haystack.includes(token));
  // Require all meaningful tokens for 1-2 token brands and >=80% for longer legal names.
  return tokens.length <= 2 ? matched.length === tokens.length : matched.length / tokens.length >= 0.8;
}
function increment(target,key) { if (key) target[key] = Number(target[key] || 0) + 1; }
function looksLikeDateLine(line) { return /\b(?:19|20)\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(line); }
function looksLikeEmploymentMeta(line) { return /^(?:full[- ]?time|part[- ]?time|contract|freelance|self[- ]?employed|internship|temporary|apprenticeship|seasonal)(?:\s|$)/i.test(clean(line)); }
function stripEmploymentType(line) { return clean(String(line || '').split(/\s+[·•]\s+(?:Full[- ]?time|Part[- ]?time|Contract|Freelance|Self[- ]?employed|Internship|Temporary|Apprenticeship|Seasonal)\b/i)[0]); }
function explicitCurrentMarker(line) { return /\b(?:present|current|currently|ongoing|now)\b/i.test(line); }

function currentExperienceEntries(payload) {
  const sections = sectionsFrom(payload); if (!sections) return [];
  const raw = sections.experience;
  if (Array.isArray(raw)) return raw.map(sectionText).filter(Boolean);
  const text = sectionText(raw);
  if (!text) return [];
  const blocks = text.split(/\n\s*\n|\r\n\s*\r\n/).map((v) => v.trim()).filter(Boolean);
  return blocks.length > 1 ? blocks : [text];
}

function deterministicCurrentEmployer(payload) {
  runState.deterministicAttempts++;
  const entries = currentExperienceEntries(payload);
  for (const entry of entries) {
    const lines = String(entry).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (!explicitCurrentMarker(lines[i])) continue;
      // LinkedIn experience text normally places company immediately before the date range.
      const before = lines.slice(Math.max(0, i - 5), i).filter((line) => !looksLikeDateLine(line) && !looksLikeEmploymentMeta(line));
      if (!before.length) continue;
      let companyLine = before[before.length - 1];
      if (/\s+[·•]\s+/.test(companyLine)) companyLine = stripEmploymentType(companyLine);
      const company = clean(companyLine);
      const title = clean(before.length > 1 ? before[before.length - 2] : '');
      if (!company || company.length < 2 || /^experience$/i.test(company)) continue;
      const evidence = evidenceFrom(payload);
      if (!evidenceContains(company, evidence)) continue;
      runState.deterministicSuccesses++;
      return { company, title, name: '', confidence: 0.98, evidence: `${company} with explicit current/Present marker`, source: 'linkedin-explicit-current-experience' };
    }
  }
  return null;
}

async function resolveEmployerFromSections(payload) {
  const evidence = evidenceFrom(payload);
  if (!evidence) { runState.noEvidence++; return null; }
  runState.rawSectionProfiles++;

  const deterministic = deterministicCurrentEmployer(payload);
  if (deterministic?.company) return deterministic;

  runState.normalizationAttempts++;
  try {
    const result = await modelRouter.chatOmniRouteOnly({
      model: 'auto/best-reasoning', taskType: 'research',
      messages: [
        { role: 'system', content: [
          'You are ULTRON Profile Employer Normalizer.',
          'The payload is raw text scraped from ONE exact LinkedIn member profile.',
          'Identify only the employer explicitly CURRENT for this person.',
          'Prefer an Experience entry with Present/current/ongoing. Use the top-card headline only as corroboration.',
          'Return the employer using wording copied as closely as possible from the profile evidence; do not expand abbreviations or add legal suffixes that are absent.',
          'Never use a previous employer, client, school, recruiter vacancy client, email domain, or guessed company.',
          'If current employment is not explicit enough, return resolved=false.',
          'Return strict JSON only: {"resolved":true|false,"company":"","title":"","name":"","confidence":0.0,"evidence":"brief evidence"}.'
        ].join(' ') },
        { role: 'user', content: JSON.stringify({ exactLinkedInProfileEvidence: evidence }) },
      ],
    });
    increment(runState.providers, result?.provider || 'unknown'); increment(runState.models, result?.model || 'unknown');
    if (result?.transport !== 'omniroute' || result?.personalApiFallbackAllowed !== false) { runState.modelErrors++; return null; }
    const parsed = parseJson(modelText(result));
    if (!parsed) { runState.malformedJson++; runState.lowConfidence++; return null; }
    if (parsed.resolved !== true) { runState.resolvedFalse++; runState.lowConfidence++; return null; }
    const company = clean(parsed.company); const confidence = Number(parsed.confidence || 0);
    if (!company) { runState.noCompany++; runState.lowConfidence++; return null; }
    if (!Number.isFinite(confidence) || confidence < 0.72) { runState.lowConfidence++; return null; }
    if (!evidenceContains(company, evidence)) { runState.evidenceMismatch++; runState.lowConfidence++; return null; }
    runState.normalizationSuccesses++;
    return { company, title: clean(parsed.title), name: clean(parsed.name), confidence, evidence: clean(parsed.evidence).slice(0,600), source: 'linkedin-raw-sections-omniroute' };
  } catch { runState.modelErrors++; return null; }
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
    _ultronCurrentEmployerSource: resolved.source || 'linkedin-raw-sections',
    _ultronCurrentEmployerConfidence: resolved.confidence,
    _ultronCurrentEmployerEvidence: resolved.evidence,
  };
}
function startRun() { runState = freshState(); return stats(); }
function stats() { return { ...runState, providers:{...runState.providers}, models:{...runState.models}, personalApiFallbacks:0 }; }
function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];
  const originalEnrichWorkbook = threePoc.enrichWorkbook.bind(threePoc);
  const originalFormatResult = threePoc.formatResult.bind(threePoc);
  threePoc.enrichWorkbook = async function normalizedLinkedinProfileThreePocRun(...args) {
    startRun(); const previous = linkedinMcp.callTool; const boundPrevious = previous.bind(linkedinMcp);
    linkedinMcp.callTool = async (tool,args={}) => { const result = await boundPrevious(tool,args); return tool === 'get_person_profile' ? normalizeProfile(result) : result; };
    try { const result = await originalEnrichWorkbook(...args); return { ...result, linkedinProfileNormalizer: stats() }; }
    finally { linkedinMcp.callTool = previous; }
  };
  threePoc.formatResult = function profileNormalizerFormatResult(result) {
    const base = originalFormatResult(result); const s = result?.linkedinProfileNormalizer; if (!s) return base;
    const providers = Object.entries(s.providers || {}).map(([name,count]) => `${name}:${count}`).join(', ') || 'none';
    const reasons = `resolved-false ${s.resolvedFalse}, malformed-json ${s.malformedJson}, no-company ${s.noCompany}, evidence-mismatch ${s.evidenceMismatch}`;
    return `${base} Raw LinkedIn profile normalization: ${s.deterministicSuccesses} deterministic current-employer resolves; ${s.normalizationSuccesses}/${s.normalizationAttempts} OmniRoute resolves; ${s.lowConfidence} safely rejected (${reasons}), ${s.noEvidence} no-evidence payloads, ${s.modelErrors} model/contract errors; providers [${providers}]. Personal-API fallbacks: 0.`;
  };
  const api = Object.freeze({ startRun, stats, sectionsFrom, evidenceFrom, existingEmployer, normalizeProfile, deterministicCurrentEmployer, evidenceContains });
  globalThis[INSTALL_FLAG] = api; return api;
}
module.exports = { install, startRun, stats, sectionsFrom, evidenceFrom, existingEmployer, normalizeProfile, deterministicCurrentEmployer, evidenceContains };
