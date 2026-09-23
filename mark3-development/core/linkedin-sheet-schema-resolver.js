const direct = require('./direct-provider-router');

const ALLOWED_KEYS = Object.freeze([
  'name', 'company', 'role', 'jobLink', 'linkedin', 'location', 'workType',
  'employees', 'hiring', 'details', 'website', 'applicants', 'posted',
  'industry', 'companySizeConfidence', 'source', 'score', 'ignore',
]);
const ALLOWED = new Set(ALLOWED_KEYS);
const CONTACT_KEYS = new Set(['contactLinkedin', 'phone', 'email', 'remarks']);
const MIN_CONFIDENCE = 0.86;
const MAX_ATTEMPTS = 3;

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeMappings(input = {}) {
  const out = {};
  for (const [header, raw] of Object.entries(input || {})) {
    const name = normalizeHeader(header);
    const key = String(raw?.key || raw || '').trim();
    if (name && ALLOWED.has(key)) out[name] = key;
  }
  return out;
}

function mappedKey(header, mappings = {}) {
  return normalizeMappings(mappings)[normalizeHeader(header)] || null;
}

function deterministicIgnore(header) {
  const value = normalizeHeader(header);
  if (!value) return true;
  return /^(?:s\s*no|sr\s*no|serial(?: number)?|row(?: number)?|index|manual status|review status|owner notes?|internal notes?|outcomes?)$/.test(value)
    || /\b(?:poc|point of contact|contact person|contact name|contact number|contact email|phone|mobile|e mail|email)\b/.test(value);
}

function unresolvedHeaders(headers, headerKey, mappings = {}) {
  const known = normalizeMappings(mappings);
  return [...new Set((headers || [])
    .map((header) => String(header || '').trim())
    .filter(Boolean)
    .filter((header) => {
      const deterministic = headerKey(header);
      if (deterministic && !CONTACT_KEYS.has(deterministic)) return false;
      if (deterministic && CONTACT_KEYS.has(deterministic)) return false;
      return !known[normalizeHeader(header)] && !deterministicIgnore(header);
    }))];
}

function parseCandidate(result) {
  const content = String(result?.content || '').trim();
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1].trim() : content;
  try { return JSON.parse(source); } catch {}
  const object = source.match(/\{[\s\S]*\}/);
  if (!object) return null;
  try { return JSON.parse(object[0]); } catch { return null; }
}

function acceptedMappings(candidate, expectedHeaders) {
  const expected = new Map(expectedHeaders.map((header) => [normalizeHeader(header), header]));
  const mappings = {};
  const unresolved = [];
  const rows = Array.isArray(candidate?.mappings) ? candidate.mappings : [];
  for (const row of rows) {
    const normalized = normalizeHeader(row?.header);
    if (!expected.has(normalized)) continue;
    const key = String(row?.key || '').trim();
    const confidence = Number(row?.confidence || 0);
    if (!ALLOWED.has(key) || confidence < MIN_CONFIDENCE) {
      unresolved.push(expected.get(normalized));
      continue;
    }
    mappings[normalized] = key;
  }
  for (const [normalized, original] of expected) {
    if (!mappings[normalized] && !unresolved.includes(original)) unresolved.push(original);
  }
  return { mappings, unresolved };
}

async function resolve(headers, request, headerKey, options = {}) {
  const existing = normalizeMappings(request?.headerMappings);
  const unknown = unresolvedHeaders(headers, headerKey, existing);
  for (const header of headers || []) {
    if (deterministicIgnore(header) && !headerKey(header)) existing[normalizeHeader(header)] = 'ignore';
  }
  if (!unknown.length || options.allowModel === false) {
    return { mappings: existing, unresolved: unresolvedHeaders(headers, headerKey, existing), model: null, provider: null };
  }

  const candidates = options.models || await direct.candidates('automation', { envOnly: true });
  const chat = options.chat || direct.chat;
  const messages = [
    {
      role: 'system',
      content: [
        'Map unfamiliar Google Sheet headings for a LinkedIn company/job discovery export.',
        'Return JSON only: {"mappings":[{"header":"exact heading","key":"allowed key","confidence":0.0}]}',
        `Allowed keys: ${ALLOWED_KEYS.join(', ')}.`,
        'Use ignore for serial/manual columns and all POC, person, phone, email or contact-enrichment columns.',
        'Map only when the heading clearly asks for data available from a company/job discovery record.',
        'Use confidence below 0.86 when the meaning or source field is ambiguous. Never invent a new key.',
      ].join(' '),
    },
    { role: 'user', content: JSON.stringify({ headings: unknown, context: 'LinkedIn company hiring discovery; no contact enrichment' }) },
  ];

  let last = { mappings: {}, unresolved: unknown };
  for (const model of candidates.slice(0, MAX_ATTEMPTS)) {
    try {
      const result = await require('./command-control-plane').runInternalInference('linkedin', () => chat({
        messages,
        model,
        taskType: 'automation',
        timeoutMs: Number(process.env.ULTRON_M3_LINKEDIN_SCHEMA_TIMEOUT_MS || 14000),
        envOnly: true,
      }));
      const accepted = acceptedMappings(parseCandidate(result), unknown);
      Object.assign(existing, accepted.mappings);
      last = { ...accepted, model: result?.model || model, provider: result?.provider || model.split('/')[0] };
      if (!accepted.unresolved.length) break;
    } catch (error) {
      last = { mappings: {}, unresolved: unknown, error: String(error?.message || error), model, provider: model.split('/')[0] };
    }
  }
  return {
    mappings: existing,
    unresolved: unresolvedHeaders(headers, headerKey, existing),
    model: last.model || null,
    provider: last.provider || null,
    error: last.error || null,
  };
}

function canonicalTarget(value, headerKey) {
  const raw = String(value || '').trim();
  if (/^(?:ignore|leave blank|blank|skip)$/i.test(raw)) return 'ignore';
  const directKey = raw.replace(/\s+/g, '');
  if (ALLOWED.has(directKey)) return directKey;
  const inferred = headerKey(raw);
  return inferred && !CONTACT_KEYS.has(inferred) ? inferred : null;
}

function userMappings(text, expectedHeaders, headerKey) {
  const expected = new Map(expectedHeaders.map((header) => [normalizeHeader(header), header]));
  const mappings = {};
  const body = String(text || '').replace(/^\s*(?:map|mapping|columns?)\s*:\s*/i, '');
  for (const part of body.split(/\s*[;,\n]\s*/)) {
    const match = part.match(/^\s*["']?(.+?)["']?\s*(?:=|->|→|means|should be|is)\s*["']?(.+?)["']?\s*$/i);
    if (!match) continue;
    const source = normalizeHeader(match[1]);
    const target = canonicalTarget(match[2], headerKey);
    if (expected.has(source) && target) mappings[source] = target;
  }
  return mappings;
}

const EXCLUSIVE_FIELD_PATTERNS = Object.freeze([
  ['company', /\b(?:company|business|organisation|organization)\s+name\b/i],
  ['linkedin', /\b(?:company\s+(?:linkedin|profile|link|url)|linkedin\s+company\s+(?:link|url|profile))\b/i],
  ['jobLink', /\b(?:job|vacancy|opening|posting)\s+(?:link|url)\b/i],
  ['role', /\b(?:job\s+role|job\s+title|sap\s+role|role|position)\b/i],
  ['location', /\b(?:job\s+)?location\b/i],
  ['workType', /\b(?:work\s+type|workplace\s+type|work\s+mode|remote\s+status)\b/i],
  ['employees', /\b(?:employees?|employee\s+count|company\s+size|headcount)\b/i],
  ['hiring', /\b(?:hiring|job)\s+(?:evidence|signal)\b/i],
  ['details', /\b(?:details|description|post\s+details)\b/i],
  ['website', /\b(?:company\s+)?website\b/i],
  ['applicants', /\bapplicants?\b/i],
  ['posted', /\b(?:posted|posting)\s+(?:date|age)\b/i],
  ['industry', /\b(?:industry|sector)\b/i],
  ['source', /\bsource\b/i],
  ['score', /\b(?:lead|quality|relevance)\s+score\b/i],
]);

function exclusiveFieldsFromText(text) {
  const value = String(text || '').trim();
  const exclusive = /\bonly\s+(?:add|fill|write|include|keep|use|need|want)\b|\b(?:add|fill|write|include|keep|use|need|want)\s+only\b/i.test(value);
  if (!exclusive) return null;
  const selected = new Set(EXCLUSIVE_FIELD_PATTERNS.filter(([, pattern]) => pattern.test(value)).map(([key]) => key));
  return selected.size ? selected : null;
}

function exclusiveUserMappings(text, headers, headerKey) {
  const selected = exclusiveFieldsFromText(text);
  if (!selected) return null;
  const mappings = {};
  for (const header of headers || []) {
    const normalized = normalizeHeader(header);
    if (!normalized) continue;
    const key = headerKey(header);
    mappings[normalized] = key && selected.has(key) ? key : 'ignore';
  }
  return mappings;
}

function clarificationText(headers) {
  const quoted = headers.map((header) => `“${header}”`).join(', ');
  return `I inspected the destination Sheet before starting LinkedIn research. These headings are still ambiguous: ${quoted}. Reply with mappings such as: map: "Priority" = lead score; "Owner Notes" = ignore. Available discovery fields are company name, company link, job role, job link, location, work type, employees, hiring evidence, details, website, applicants, posted date, industry, source and lead score. POC, phone and email columns will remain blank unless you separately request enrichment.`;
}

module.exports = {
  ALLOWED_KEYS,
  CONTACT_KEYS,
  MIN_CONFIDENCE,
  normalizeHeader,
  normalizeMappings,
  mappedKey,
  deterministicIgnore,
  unresolvedHeaders,
  parseCandidate,
  acceptedMappings,
  resolve,
  canonicalTarget,
  userMappings,
  exclusiveFieldsFromText,
  exclusiveUserMappings,
  clarificationText,
};
