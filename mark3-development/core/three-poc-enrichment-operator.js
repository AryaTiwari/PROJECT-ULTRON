const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const localExcel = require('./local-excel-operator');
const googleSheets = require('./google-sheets-operator');
const fileVault = require('./file-vault');
const apollo = require('./apollo-enrichment');
const modelRouter = require('./model-router');

const STATE_FILE = path.join(config.projectRoot, '.ultron', 'three-poc-enrichment', 'jobs.json');
let watcherTimer = null;
let watcherRemaining = 0;

function sourceProvider(source) {
  if (localExcel.isLocalExcelSource(source)) return 'local-excel';
  if (googleSheets.extractSheetUrl(source) || /docs\.google\.com\/spreadsheets\/d\//i.test(String(source || ''))) return 'google';
  return null;
}

async function readGoogleWorkbookSheets(source) {
  const spreadsheetId = googleSheets.spreadsheetId(source);
  const meta = await googleSheets.metadata(spreadsheetId);
  const requestedGid = googleSheets.sheetGid(source);
  const tabs = (meta.sheets || []).filter((sheet) => requestedGid == null || Number(sheet?.properties?.sheetId) === Number(requestedGid));
  const out = [];

  for (const sheet of tabs) {
    const sheetName = sheet?.properties?.title;
    if (!sheetName) continue;
    const rows = await googleSheets.values(spreadsheetId, `${googleSheets.quoteSheet(sheetName)}!A:ZZ`);

    // Preserve actual LinkedIn profile targets when a cell displays a name but
    // stores the URL as a hyperlink. We only know the correct LinkedIn column
    // after detecting the 3-POC schema.
    let layout = null;
    try { layout = detectThreePocLayout(rows); } catch (error) {
      if (error.code !== 'THREE_POC_LAYOUT_NOT_FOUND') throw error;
    }
    if (layout && Number.isInteger(layout.linkedinIndex) && layout.linkedinIndex >= 0) {
      const links = await googleSheets.linkedInHyperlinks(spreadsheetId, sheetName, layout.linkedinIndex, Math.max(rows.length, layout.headerRowNumber));
      for (const [rowNumber, link] of links.entries()) {
        const index = rowNumber - 1;
        if (!rows[index]) rows[index] = [];
        rows[index][layout.linkedinIndex] = link;
      }
    }

    out.push({
      sheetName,
      sheetId: sheet.properties.sheetId,
      spreadsheetId,
      spreadsheetTitle: meta?.properties?.title || '',
      rows,
      layout,
    });
  }
  return out;
}

async function readSourceSheets(source) {
  const provider = sourceProvider(source);
  if (provider === 'local-excel') return localExcel.readWorkbookSheets(source);
  if (provider === 'google') return readGoogleWorkbookSheets(source);
  const error = new Error('3-POC enrichment requires an attached Excel workbook or a valid Google Sheets URL.');
  error.code = 'THREE_POC_SOURCE_REQUIRED';
  throw error;
}

function sourceCellRange(sheetName, rowNumber, columnIndex) {
  return googleSheets.cellRange(sheetName, rowNumber, columnIndex);
}

async function writeSourceCells(source, changes) {
  const provider = sourceProvider(source);
  const protectedChanges = (changes || []).filter((change) => change?.range && String(change.value ?? '').trim()).map((change) => ({
    ...change,
    nonDestructive: true,
  }));
  if (!protectedChanges.length) return { updatedCells: 0 };

  if (provider === 'local-excel') return localExcel.writeCells(source, protectedChanges);

  if (provider === 'google') {
    const spreadsheetId = googleSheets.spreadsheetId(source);
    const live = await googleSheets.batchValues(spreadsheetId, protectedChanges.map((change) => change.range));
    const safe = [];
    for (let index = 0; index < protectedChanges.length; index++) {
      const change = protectedChanges[index];
      const current = String(live[index]?.[0]?.[0] ?? '').trim();
      const incoming = String(change.value ?? '').trim();
      if (!incoming || current === incoming) continue;
      if (current) {
        const deliberateReplacement = change.allowReplace === true
          && String(change.replaces ?? '').trim() === current
          && change.replacementReason === 'same-identity-designation-upgrade';
        if (!deliberateReplacement) {
          const error = new Error(`Protected enrichment refused to overwrite populated cell ${change.range}.`);
          error.code = 'THREE_POC_NON_DESTRUCTIVE_CONFLICT';
          error.subsystem = 'IDENTITY';
          error.errorType = 'CONFLICT';
          error.stage = 'google-sheet-live-write-validation';
          error.range = change.range;
          throw error;
        }
      }
      safe.push(change);
    }
    return safe.length ? googleSheets.writeCells(spreadsheetId, safe) : { updatedCells: 0 };
  }

  const error = new Error('Unsupported 3-POC spreadsheet provider.');
  error.code = 'THREE_POC_PROVIDER_UNSUPPORTED';
  throw error;
}

async function readSourceCell(source, range) {
  const provider = sourceProvider(source);
  if (provider === 'local-excel') return localExcel.readCell(source, range);
  if (provider === 'google') return googleSheets.readCell(googleSheets.spreadsheetId(source), range);
  return '';
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { version: 1, jobs: [] };
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { version: 1, jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] };
  } catch {
    return { version: 1, jobs: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  state.jobs = (state.jobs || []).slice(-20);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function headerMatch(value, patterns) {
  const text = normalizeHeader(value);
  return patterns.some((pattern) => pattern.test(text));
}

function findHeader(row, patterns, start = 0, end = row.length) {
  for (let i = Math.max(0, start); i < Math.min(row.length, end); i++) {
    if (headerMatch(row[i], patterns)) return i;
  }
  return -1;
}

const P1 = [/\b1st\s+poc\b/, /\bfirst\s+poc\b/, /\bpoc\s*1\b/, /\bprimary\s+poc\b/];
const P2 = [/\b2nd\s+poc\b/, /\bsecond\s+poc\b/, /\bpoc\s*2\b/];
const P3 = [/\b3rd\s+poc\b/, /\bthird\s+poc\b/, /\bpoc\s*3\b/];
const PHONE = [/\bphone\b/, /\bmobile\b/, /\bcontact\s+number\b/, /\bnumber\b/];
const EMAIL = [/\bemail\b/, /\be\s+mail\b/];
const DETAILS = [/\bpost\s+details?\b/, /\bjob\s+details?\b/, /\bdescription\b/];
const LINKEDIN = [/\blinkedin\b/];
const P1_LINKEDIN = [/\b1st\s+poc\s+linkedin\b/, /\bfirst\s+poc\s+linkedin\b/, /\bpoc\s*1\s+linkedin\b/];
const P2_LINKEDIN = [/\b2nd\s+poc\s+linkedin\b/, /\bsecond\s+poc\s+linkedin\b/, /\bpoc\s*2\s+linkedin\b/];
const P3_LINKEDIN = [/\b3rd\s+poc\s+linkedin\b/, /\bthird\s+poc\s+linkedin\b/, /\bpoc\s*3\s+linkedin\b/];
const COMPANY = [/^company$/, /^company\s+name$/, /^organization$/, /^organisation$/];
const LEGACY_NAME = [/^person\s+or\s+company\s+name$/, /^person\s+name$/, /^lead\s+name$/];

function contactSlot(row, nameIndex, nextNameIndex, explicitLinkedInPatterns = []) {
  if (nameIndex < 0) return null;
  const end = nextNameIndex >= 0 ? nextNameIndex : row.length;
  const phoneIndex = findHeader(row, PHONE, nameIndex + 1, end);
  const emailIndex = findHeader(row, EMAIL, nameIndex + 1, end);
  const inlineLinkedInIndex = findHeader(row, LINKEDIN, nameIndex + 1, end);
  const explicitLinkedInIndex = explicitLinkedInPatterns.length ? findHeader(row, explicitLinkedInPatterns) : -1;
  if (phoneIndex < 0 || emailIndex < 0) return null;
  return {
    nameIndex,
    phoneIndex,
    emailIndex: emailIndex,
    // A POC-specific header must win over a generic LinkedIn match. Without
    // this, the third slot can accidentally bind to "1st POC LinkedIn"
    // simply because it appears earlier later in the same row.
    linkedinIndex: explicitLinkedInIndex >= 0 ? explicitLinkedInIndex : inlineLinkedInIndex,
  };
}

function legacyFirstSlot(row, secondNameIndex) {
  const nameIndex = findHeader(row, LEGACY_NAME);
  if (nameIndex < 0 || secondNameIndex < 0) return null;
  const linkedinIndex = findHeader(row, LINKEDIN, nameIndex + 1, secondNameIndex);
  const start = linkedinIndex >= 0 ? linkedinIndex + 1 : nameIndex + 1;
  const phoneIndex = findHeader(row, PHONE, start, secondNameIndex);
  const emailIndex = findHeader(row, EMAIL, start, secondNameIndex);
  if (phoneIndex < 0 || emailIndex < 0) return null;
  return { nameIndex, phoneIndex, emailIndex, linkedinIndex, legacy: true };
}

function detectThreePocLayout(rows) {
  let best = null;
  for (let r = 0; r < Math.min(20, rows.length); r++) {
    const row = rows[r] || [];
    const secondName = findHeader(row, P2);
    if (secondName < 0) continue;
    const thirdName = findHeader(row, P3);
    if (thirdName >= 0 && thirdName <= secondName) continue;
    const explicitFirst = findHeader(row, P1);
    const first = explicitFirst >= 0 ? contactSlot(row, explicitFirst, secondName, P1_LINKEDIN) : legacyFirstSlot(row, secondName);
    const second = contactSlot(row, secondName, thirdName >= 0 ? thirdName : row.length, P2_LINKEDIN);
    const third = thirdName >= 0 ? contactSlot(row, thirdName, row.length, P3_LINKEDIN) : null;
    if (!first || !second || (thirdName >= 0 && !third)) continue;

    const companyIndex = findHeader(row, COMPANY);
    const postDetailsIndex = findHeader(row, DETAILS);
    const linkedinIndex = findHeader(row, LINKEDIN);
    const slotCount = third ? 3 : 2;
    const score = 100 + slotCount * 5 + (explicitFirst >= 0 ? 20 : 0) + (companyIndex >= 0 ? 6 : 0) + (postDetailsIndex >= 0 ? 4 : 0) + (linkedinIndex >= 0 ? 2 : 0) - r * 0.1;
    const candidate = {
      headerRowIndex: r,
      headerRowNumber: r + 1,
      schema: explicitFirst >= 0
        ? (third ? 'explicit_three_poc' : 'explicit_two_poc')
        : (third ? 'anchored_first_poc' : 'anchored_first_poc_two'),
      first,
      second,
      third,
      slotCount,
      companyIndex,
      postDetailsIndex,
      linkedinIndex,
      score,
    };
    if (!best || candidate.score > best.score) best = candidate;
  }
  if (!best) {
    const error = new Error('No safe two- or three-POC column layout was detected in this worksheet.');
    error.code = 'THREE_POC_LAYOUT_NOT_FOUND';
    throw error;
  }
  return best;
}

async function ensurePocLinkedInColumns(source, sheet) {
  const layout = sheet.layout;
  if (String(layout.schema || '').startsWith('anchored_first_poc')) return [];
  const slots = [
    { slot: layout.first, label: '1st POC LinkedIn' },
    { slot: layout.second, label: '2nd POC LinkedIn' },
    layout.third ? { slot: layout.third, label: '3rd POC LinkedIn' } : null,
  ].filter(Boolean);
  let nextIndex = (sheet.rows || []).reduce((max, row) => Math.max(max, (row || []).length), 0);
  const changes = [];
  const created = [];
  for (const item of slots) {
    if (Number.isInteger(item.slot.linkedinIndex) && item.slot.linkedinIndex >= 0) continue;
    item.slot.linkedinIndex = nextIndex++;
    changes.push({
      range: sourceCellRange(sheet.sheetName, layout.headerRowNumber, item.slot.linkedinIndex),
      value: item.label,
    });
    created.push(item.label);
  }
  if (changes.length) await writeSourceCells(source, changes);
  return created;
}

function linkedInProfileKind(value) {
  const raw = String(value || '').trim();
  if (/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/in\//i.test(raw)) return 'person';
  if (/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/company\//i.test(raw)) return 'company';
  return 'unknown';
}

function personNameKey(value) {
  return String(value || '')
    .replace(/\s+[—–]\s+.*$/, '')
    .replace(/\s*\([^)]{2,120}\)\s*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slotSnapshot(row, slot) {
  return {
    name: String(row?.[slot?.nameIndex] || '').trim(),
    phone: apollo.validPhone(row?.[slot?.phoneIndex]),
    email: apollo.validEmail(row?.[slot?.emailIndex]),
  };
}

function matchExistingCandidate(name, candidates = []) {
  const key = personNameKey(name);
  if (!key) return null;
  const matches = candidates.filter((candidate) => personNameKey(candidate?.name) === key);
  return matches.length === 1 ? matches[0] : null;
}

function allEmails(row) {
  const out = [];
  const seen = new Set();
  const re = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/ig;
  for (const value of row || []) {
    for (const match of String(value || '').match(re) || []) {
      const email = match.replace(/[),.;:!?]+$/, '').trim().toLowerCase();
      if (email && !seen.has(email)) { seen.add(email); out.push(email); }
    }
  }
  return out.slice(0, 12);
}

function emailDomains(emails) {
  return [...new Set((emails || []).map((email) => email.split('@')[1]).filter(Boolean))];
}

function rowContext(layout, row, sheetName, rowNumber) {
  const emails = allEmails(row);
  const cells = (row || []).map((value, index) => ({ index, value: String(value ?? '').trim() }))
    .filter((item) => item.value)
    .filter((item) => ![
      layout.first.phoneIndex, layout.first.emailIndex,
      layout.second.phoneIndex, layout.second.emailIndex,
      layout.third?.phoneIndex, layout.third?.emailIndex,
      layout.first.linkedinIndex, layout.second.linkedinIndex, layout.third?.linkedinIndex,
    ].filter((index) => Number.isInteger(index) && index >= 0).includes(item.index))
    .slice(0, 30);
  const linkedin = layout.linkedinIndex >= 0 ? String(row[layout.linkedinIndex] || '').trim() : '';
  return {
    sheetName,
    rowNumber,
    schema: layout.schema || 'unknown',
    anchorName: layout.first?.nameIndex >= 0 ? String(row[layout.first.nameIndex] || '').trim() : '',
    explicitCompany: layout.companyIndex >= 0 ? String(row[layout.companyIndex] || '').trim() : '',
    postDetails: layout.postDetailsIndex >= 0 ? String(row[layout.postDetailsIndex] || '').trim().slice(0, 6500) : '',
    linkedin,
    linkedinProfileKind: linkedInProfileKind(linkedin),
    visibleEmails: emails,
    visibleDomains: emailDomains(emails),
    cells,
  };
}

function modelText(result) {
  return String(result?.content || result?.text || result?.response || '').trim();
}

function parseJson(text) {
  const raw = String(text || '').trim().replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/i, '');
  try { return JSON.parse(raw); } catch {}
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch {}
  }
  const error = new Error('AI agent did not return valid JSON.');
  error.code = 'POC_AGENT_INVALID_JSON';
  throw error;
}

async function companyContextAgent(context) {
  const system = [
    'You are the Company Context Analyst inside ULTRON Mark 3.',
    'Analyze one spreadsheet row from a hiring lead workbook and identify the organization whose hiring process this row should be enriched for.',
    'Use the explicit company cell, hiring post, source person/profile, email domains, and row evidence together.',
    'Do not invent a company or domain. If evidence is genuinely ambiguous, return company as an empty string.',
    'The domain must be selected only from visibleDomains when possible; otherwise return an empty domain.',
    'Return strict JSON only: {"company":"...","domain":"...","hiringContext":"...","confidence":0.0,"evidence":["..."]}.',
  ].join(' ');
  const user = JSON.stringify({
    explicitCompany: context.explicitCompany,
    postDetails: context.postDetails,
    linkedin: context.linkedin,
    visibleEmails: context.visibleEmails,
    visibleDomains: context.visibleDomains,
    cells: context.cells,
  });
  const result = await modelRouter.chatOmniRouteOnly({
    model: 'auto/best-reasoning',
    taskType: 'research',
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  const parsed = parseJson(modelText(result));
  const company = String(parsed.company || '').trim();
  let domain = String(parsed.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (domain && !context.visibleDomains.map((x) => x.toLowerCase()).includes(domain)) domain = '';
  return {
    company,
    domain,
    hiringContext: String(parsed.hiringContext || context.postDetails || '').trim().slice(0, 1800),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0))),
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String).slice(0, 8) : [],
    model: result?.model || null,
    provider: result?.provider || null,
  };
}

function candidateView(person, index) {
  return {
    candidateKey: String(person.id || person.linkedinUrl || `candidate-${index + 1}`),
    id: person.id || null,
    name: person.name || '',
    title: person.title || '',
    headline: person.headline || '',
    seniority: person.seniority || '',
    departments: person.departments || [],
    functions: person.functions || [],
    location: person.location || '',
    linkedinUrl: person.linkedinUrl || '',
    organizationName: person.organizationName || '',
    organizationDomain: person.organizationDomain || '',
    searchLimitedIdentity: Boolean(person.searchLimitedIdentity),
    lastNameObfuscated: Boolean(person.lastNameObfuscated),
  };
}

function localHiringScore(candidate, context = {}) {
  const title = String(candidate?.title || '').toLowerCase();
  const headline = String(candidate?.headline || '').toLowerCase();
  const departments = (candidate?.departments || []).join(' ').toLowerCase();
  const functions = (candidate?.functions || []).join(' ').toLowerCase();
  const combined = `${title} ${headline} ${departments} ${functions}`;
  const hiringContext = String(context?.postDetails || context?.hiringContext || '').toLowerCase();

  let score = 0;
  if (/talent acquisition|recruitment|recruiter|recruiting/.test(combined)) score += 80;
  if (/human resources|\bhr\b|people operations|people partner/.test(combined)) score += 55;
  if (/hiring/.test(combined)) score += 45;
  if (/head|lead|manager|director|vp|vice president/.test(title)) score += 24;
  if (/founder|co-founder|owner|managing director/.test(title)) score += 12;
  if (/sap/.test(hiringContext) && /sap/.test(combined)) score += 28;
  if (String(candidate?.seniority || '').match(/owner|founder|c[_-]?suite|vp|head|director|manager/i)) score += 12;
  if (title) score += 4;
  return score;
}

function preRankCandidates(candidates, context = {}, limit = 10) {
  const max = Math.max(6, Math.min(14, Number(limit || 10)));
  const ranked = [...(candidates || [])]
    .map((candidate, index) => ({ candidate, index, score: localHiringScore(candidate, context) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const chosen = [];
  const seen = new Set();
  const add = (entry) => {
    if (!entry) return;
    const key = String(entry.candidate?.candidateKey || '');
    if (!key || seen.has(key) || chosen.length >= max) return;
    seen.add(key);
    chosen.push(entry.candidate);
  };

  // Keep category diversity so OmniRoute still makes the contextual decision.
  const categoryPatterns = [
    /talent acquisition|recruitment|recruiter|recruiting/i,
    /human resources|\bhr\b|people operations|people partner/i,
    /founder|co-founder|owner|managing director|director|vice president|\bvp\b/i,
    /head|lead|manager/i,
  ];
  for (const pattern of categoryPatterns) {
    add(ranked.find((entry) => pattern.test(`${entry.candidate.title || ''} ${entry.candidate.headline || ''}`)));
  }
  for (const entry of ranked) add(entry);
  return chosen;
}

function compactCandidate(candidate) {
  return {
    candidateKey: candidate.candidateKey,
    name: candidate.name || '',
    title: candidate.title || '',
    seniority: candidate.seniority || '',
    departments: candidate.departments || [],
    functions: candidate.functions || [],
    searchLimitedIdentity: Boolean(candidate.searchLimitedIdentity),
  };
}

function reviewerRequired(ranking, requested) {
  const needed = Math.max(1, Math.min(3, Number(requested || 1)));
  if (!Array.isArray(ranking) || ranking.length < needed) return true;
  return ranking.slice(0, needed).some((item) => Number(item?.confidence || 0) < 0.55);
}

function validKeys(output, candidates, max = 8) {
  const allowed = new Set(candidates.map((candidate) => candidate.candidateKey));
  const source = Array.isArray(output?.pocs) ? output.pocs : Array.isArray(output?.ranking) ? output.ranking : [];
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const key = String(item?.candidateKey || item?.key || '').trim();
    if (!allowed.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      candidateKey: key,
      reason: String(item?.reason || '').trim().slice(0, 700),
      confidence: Math.max(0, Math.min(1, Number(item?.confidence || 0))),
    });
    if (out.length >= max) break;
  }
  return out;
}

async function selectorAgent(context, companyContext, candidates, options = {}) {
  const requested = Math.max(1, Math.min(3, Number(options.count || 3)));
  const system = [
    'You are ULTRON Hiring-Authority Selector.',
    'Rank real people by how responsible or influential they are for hiring for THIS specific company and hiring context.',
    'Do not use a static title hierarchy and do not rank by prestige alone. Company size and actual recruiting responsibility matter.',
    'A founder or CEO can be highly relevant in a small company but less operationally responsible than a talent/recruiting leader in a large company.',
    'Likewise a recruiter who owns the vacancy can outrank a distant executive when the evidence supports it.',
    'Contact-data availability must NOT influence responsibility ranking.',
    options.anchorPerson ? 'The supplied anchorPerson is already POC-1. Do not select that person again; rank additional employees only.' : '',
    'Select only supplied candidateKey values. Never invent people.',
    'Return up to 8 candidates, strongest first, as strict JSON only: {"pocs":[{"candidateKey":"...","reason":"...","confidence":0.0}]}.',
  ].filter(Boolean).join(' ');
  const result = await modelRouter.chatOmniRouteOnly({
    model: 'auto/best-reasoning',
    taskType: 'research',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({
        company: companyContext.company,
        hiringContext: companyContext.hiringContext,
        requestedAdditionalPocs: requested,
        anchorPerson: options.anchorPerson || null,
        rowEvidence: { postDetails: context.postDetails, sourceLinkedIn: context.linkedin },
        candidates: candidates.map(compactCandidate),
      }) },
    ],
  });
  return {
    ranking: validKeys(parseJson(modelText(result)), candidates, 8),
    model: result?.model || null,
    provider: result?.provider || null,
    transport: result?.transport || null,
    routingMode: result?.routingMode || null,
  };
}

async function reviewerAgent(context, companyContext, candidates, selectorRanking, options = {}) {
  const requested = Math.max(1, Math.min(3, Number(options.count || 3)));
  const system = [
    'You are ULTRON Independent Hiring-Responsibility Reviewer.',
    'Audit another agent\'s shortlist for a workplace POC enrichment task.',
    `Choose the ${requested} supplied people most likely to have meaningful responsibility, authority, or operational ownership over hiring in this exact context.`,
    'Reason from company scale, function, seniority, vacancy ownership, recruiting scope and row evidence. Do not follow any fixed Founder > Manager > Recruiter rule.',
    'Do not rank by whether phone/email is available. Do not invent or alter candidate identities.',
    options.anchorPerson ? 'The anchorPerson is already POC-1 and must never be selected again.' : '',
    'You may reorder or replace the first agent\'s choices using the supplied candidates.',
    `Return strict JSON only: {"pocs":[{"candidateKey":"...","reason":"...","confidence":0.0}]} with at most ${requested} unique people.`,
  ].filter(Boolean).join(' ');
  const result = await modelRouter.chatOmniRouteOnly({
    model: 'auto/best-reasoning',
    taskType: 'research',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({
        company: companyContext.company,
        hiringContext: companyContext.hiringContext,
        postDetails: context.postDetails,
        requestedAdditionalPocs: requested,
        anchorPerson: options.anchorPerson || null,
        selectorRanking,
        candidates: candidates.map(compactCandidate),
      }) },
    ],
  });
  return {
    ranking: validKeys(parseJson(modelText(result)), candidates, requested),
    model: result?.model || null,
    provider: result?.provider || null,
    transport: result?.transport || null,
    routingMode: result?.routingMode || null,
  };
}

function selectedPeople(candidates, ranking, max = 3) {
  const byKey = new Map(candidates.map((candidate) => [candidate.candidateKey, candidate]));
  return (ranking || []).map((item) => {
    const candidate = byKey.get(item.candidateKey);
    return candidate ? { ...candidate, selectionReason: item.reason, selectionConfidence: item.confidence } : null;
  }).filter(Boolean).slice(0, Math.max(1, Math.min(3, Number(max || 3))));
}

function safeDesignation(person) {
  const title = String(person?.title || '').replace(/\s+/g, ' ').trim();
  if (!title || title.length > 180) return '';
  if (/https?:\/\/|@/.test(title)) return '';
  const name = String(person?.name || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (name && title.toLowerCase() === name) return '';
  return title;
}

function hasNameAndDesignation(person) {
  return Boolean(String(person?.name || '').trim() && safeDesignation(person));
}

function hasVerifiedPocIdentity(person) {
  return Boolean(
    hasNameAndDesignation(person)
    && apollo.normalizeLinkedIn(person?.linkedinUrl)
    && String(person?.apolloPersonId || person?.id || '').trim()
    && person?.identityVerified !== false
  );
}

function displayName(person) {
  const name = String(person?.name || '').replace(/\s+/g, ' ').trim();
  if (!name) return '';
  const title = safeDesignation(person);
  return title ? `${name} — ${title}` : name;
}

async function enrichSelectedPerson(person, existing = {}, options = {}) {
  const existingEmail = apollo.validEmail(existing.email);
  const existingPhone = apollo.validPhone(existing.phone);
  const company = String(options.company || person.organizationName || '').trim();
  const domain = String(options.domain || person.organizationDomain || '').trim();
  let linkedIn = apollo.normalizeLinkedIn(person.linkedinUrl);
  let resolvedIdentity = null;

  // People API Search intentionally returns Apollo IDs without LinkedIn URLs.
  // Hydrate only the selected candidate by Apollo ID after AI ranking.
  if (!linkedIn && person.id && (company || domain)) {
    resolvedIdentity = await apollo.resolveDecisionMaker(person, company, domain, {
      needEmail: !existingEmail,
      needPhone: !existingPhone,
    });
    linkedIn = apollo.normalizeLinkedIn(resolvedIdentity.linkedinUrl);
  } else if (linkedIn) {
    const result = await apollo.enrich(linkedIn, {
      needEmail: !existingEmail,
      needPhone: !existingPhone,
      force: false,
    });
    if (result && !result.noMatch && !result.ambiguous) {
      const sameEmployer = (company || domain) ? apollo.sameOrganization(result, company, domain) : true;
      if (sameEmployer) resolvedIdentity = { ...result, identityVerified: true };
    }
  }

  if (!resolvedIdentity || !linkedIn) {
    return {
      ...person,
      email: existingEmail || apollo.validEmail(person.email),
      phone: existingPhone || apollo.validPhone(person.phone),
      phonePending: false,
      apolloPersonId: person.id || null,
      identityVerified: false,
    };
  }

  return {
    ...person,
    ...resolvedIdentity,
    name: String(resolvedIdentity.name || person.name || '').trim(),
    title: String(resolvedIdentity.title || person.title || '').trim(),
    headline: String(resolvedIdentity.headline || person.headline || '').trim(),
    linkedinUrl: linkedIn,
    email: existingEmail || apollo.validEmail(resolvedIdentity.email) || apollo.validEmail(person.email),
    phone: existingPhone || apollo.validPhone(resolvedIdentity.phone) || apollo.validPhone(person.phone),
    phonePending: !existingPhone && resolvedIdentity.phoneStatus === 'pending' && Boolean(resolvedIdentity.apolloPersonId || person.id),
    apolloPersonId: resolvedIdentity.apolloPersonId || person.id || null,
    matchConfidence: resolvedIdentity.matchConfidence || null,
    identityVerified: true,
  };
}

async function resolveAnchorPerson(context, layout, row) {
  const linkedinUrl = apollo.normalizeLinkedIn(context.linkedin);
  if (!linkedinUrl || context.linkedinProfileKind !== 'person') return null;

  const existing = slotSnapshot(row, layout.first);
  const profile = await apollo.resolvePersonProfile(linkedinUrl, {
    needEmail: !existing.email,
    needPhone: !existing.phone,
    force: false,
  });

  if (!profile?.ok || profile.noMatch || profile.ambiguous) return null;
  const organizationName = String(profile.organizationName || profile.organization?.name || '').trim();
  if (!organizationName) return null;

  return {
    id: profile.apolloPersonId || null,
    name: String(profile.name || context.anchorName || '').trim(),
    title: String(profile.title || '').trim(),
    headline: String(profile.headline || '').trim(),
    linkedinUrl,
    organizationName,
    organizationDomain: String(profile.organizationDomain || '').trim(),
    email: existing.email || apollo.validEmail(profile.email),
    phone: existing.phone || apollo.validPhone(profile.phone),
    phonePending: !existing.phone && profile.phoneStatus === 'pending' && Boolean(profile.apolloPersonId),
    apolloPersonId: profile.apolloPersonId || null,
    matchConfidence: profile.matchConfidence || null,
  };
}

function anchorCompanyContext(anchor, context) {
  return {
    company: anchor.organizationName,
    domain: anchor.organizationDomain || '',
    hiringContext: String(context.postDetails || '').trim().slice(0, 1800),
    confidence: 1,
    evidence: ['Exact POC-1 LinkedIn profile -> current Apollo organization'],
    model: null,
    provider: 'apollo-exact-profile',
  };
}

function rowChanges(sheetName, rowNumber, layout, people, existingRow = null) {
  const slots = [layout.first, layout.second, layout.third].filter(Boolean);
  const changes = [];
  const hasExistingRow = Array.isArray(existingRow);
  const current = (index) => hasExistingRow ? String(existingRow?.[index] ?? '').trim() : '';
  const pushMissing = (index, value) => {
    if (!Number.isInteger(index) || index < 0) return;
    const clean = String(value || '').trim();
    if (!clean) return;
    if (hasExistingRow && current(index)) return;
    changes.push({ range: sourceCellRange(sheetName, rowNumber, index), value: clean });
  };
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const person = people[i] || null;
    if (!person) continue;
    pushMissing(slot.nameIndex, displayName(person));
    pushMissing(slot.linkedinIndex, person.linkedinUrl);
    pushMissing(slot.phoneIndex, person.phone);
    pushMissing(slot.emailIndex, person.email);
  }
  return changes;
}

function anchoredRowChanges(sheetName, rowNumber, layout, anchor, slotPeople = [], lockedSlots = [], existingRow = null) {
  const changes = [];
  const hasExistingRow = Array.isArray(existingRow);
  const current = (index) => hasExistingRow ? String(existingRow?.[index] ?? '').trim() : '';
  const pushMissing = (index, value) => {
    const clean = String(value || '').trim();
    if (!clean) return;
    if (hasExistingRow && current(index)) return;
    changes.push({ range: sourceCellRange(sheetName, rowNumber, index), value: clean });
  };

  // Anchored POC-1 is immutable except for genuinely missing phone/email cells.
  pushMissing(layout.first.phoneIndex, anchor?.phone);
  pushMissing(layout.first.emailIndex, anchor?.email);

  const slots = [layout.second, layout.third].filter(Boolean);
  for (let i = 0; i < slots.length; i++) {
    if (lockedSlots[i]) continue;
    const person = slotPeople[i] || null;
    if (!person) continue;
    const slot = slots[i];
    const display = displayName(person);
    const existingName = current(slot.nameIndex);

    if (display) {
      if (!hasExistingRow || !existingName) {
        changes.push({ range: sourceCellRange(sheetName, rowNumber, slot.nameIndex), value: display });
      } else if (
        personNameKey(existingName)
        && personNameKey(existingName) === personNameKey(display)
        && existingName !== display
      ) {
        // Same verified identity: designation completion is safe, but mark the
        // exact expected old value so the live-write guard can reject races.
        changes.push({
          range: sourceCellRange(sheetName, rowNumber, slot.nameIndex),
          value: display,
          allowReplace: true,
          replaces: existingName,
          replacementReason: 'same-identity-designation-upgrade',
        });
      }
    }

    pushMissing(slot.phoneIndex, person.phone);
    pushMissing(slot.emailIndex, person.email);
  }
  return changes;
}

function anchoredChangeCounts(changes, sheetName, rowNumber, layout) {
  const ranges = new Set((changes || []).map((change) => change.range));
  const has = (slot, field) => Boolean(slot && Number.isInteger(slot[field]) && slot[field] >= 0 && ranges.has(sourceCellRange(sheetName, rowNumber, slot[field])));
  return {
    poc1Phone: has(layout.first, 'phoneIndex') ? 1 : 0,
    poc1Email: has(layout.first, 'emailIndex') ? 1 : 0,
    poc2Name: has(layout.second, 'nameIndex') ? 1 : 0,
    poc2Phone: has(layout.second, 'phoneIndex') ? 1 : 0,
    poc2Email: has(layout.second, 'emailIndex') ? 1 : 0,
    poc3Name: has(layout.third, 'nameIndex') ? 1 : 0,
    poc3Phone: has(layout.third, 'phoneIndex') ? 1 : 0,
    poc3Email: has(layout.third, 'emailIndex') ? 1 : 0,
  };
}

function pendingRecord(source, sheetName, rowNumber, slot, person) {
  return {
    source,
    sheetName,
    rowNumber,
    phoneColumnIndex: slot.phoneIndex,
    apolloPersonId: String(person.apolloPersonId || ''),
    name: person.name || '',
    linkedinUrl: person.linkedinUrl || '',
    pending: true,
    requestedAt: new Date().toISOString(),
  };
}

async function syncPendingPhones(options = {}) {
  const state = loadState();
  const pending = [];
  for (const job of state.jobs || []) {
    for (const record of job.pendingPhones || []) if (record?.pending) pending.push({ job, record });
  }
  if (!pending.length) return { received: 0, resolved: 0, pending: 0 };

  const results = await apollo.fetchPhoneResults();
  let resolved = 0;
  for (const result of results || []) {
    const id = String(result?.apollo_person_id || '').trim();
    if (!id) continue;
    const phone = apollo.validPhone(result?.phone);
    if (!phone) continue;
    apollo.recordPhoneResult(id, phone);
    for (const match of pending.filter((item) => String(item.record.apolloPersonId) === id && item.record.pending)) {
      try {
        await writeSourceCells(match.record.source, [{
          range: sourceCellRange(match.record.sheetName, match.record.rowNumber, match.record.phoneColumnIndex),
          value: phone,
        }]);
        match.record.pending = false;
        match.record.phone = phone;
        match.record.resolvedAt = new Date().toISOString();
        match.job.updatedAt = new Date().toISOString();
        resolved++;
      } catch (error) {
        match.record.lastError = error.message;
      }
    }
  }
  saveState(state);
  const left = pending.filter((item) => item.record.pending).length;
  if (!options.quiet && left) startPhoneWatcher();
  return { received: results.length, resolved, pending: left };
}

function startPhoneWatcher() {
  if (watcherTimer) return;
  const state = loadState();
  const count = (state.jobs || []).flatMap((job) => job.pendingPhones || []).filter((record) => record?.pending).length;
  if (!count) return;
  watcherRemaining = 30;
  const tick = async () => {
    watcherTimer = null;
    if (watcherRemaining-- <= 0) return;
    try {
      const status = await syncPendingPhones({ quiet: true });
      if (status.pending > 0) {
        watcherTimer = setTimeout(tick, 45000);
        watcherTimer.unref?.();
      }
    } catch {
      watcherTimer = setTimeout(tick, 45000);
      watcherTimer.unref?.();
    }
  };
  watcherTimer = setTimeout(tick, 15000);
  watcherTimer.unref?.();
}

async function inspectSource(source) {
  const provider = sourceProvider(source);
  if (!provider) {
    return { compatible: false, provider: null, compatibleCount: 0, sheets: [] };
  }

  const sourceSheets = await readSourceSheets(source);
  const sheets = [];
  for (const sheet of sourceSheets) {
    let layout = sheet.layout || null;
    if (!layout) {
      try { layout = detectThreePocLayout(sheet.rows || []); }
      catch (error) {
        if (error.code !== 'THREE_POC_LAYOUT_NOT_FOUND') throw error;
      }
    }
    if (!layout) continue;
    sheets.push({
      sheetName: sheet.sheetName,
      sheetId: sheet.sheetId ?? null,
      schema: layout.schema,
      headerRowNumber: layout.headerRowNumber,
      first: {
        nameIndex: layout.first?.nameIndex ?? -1,
        linkedinIndex: layout.first?.linkedinIndex ?? -1,
        phoneIndex: layout.first?.phoneIndex ?? -1,
        emailIndex: layout.first?.emailIndex ?? -1,
      },
      second: {
        nameIndex: layout.second?.nameIndex ?? -1,
        phoneIndex: layout.second?.phoneIndex ?? -1,
        emailIndex: layout.second?.emailIndex ?? -1,
      },
      third: {
        nameIndex: layout.third?.nameIndex ?? -1,
        phoneIndex: layout.third?.phoneIndex ?? -1,
        emailIndex: layout.third?.emailIndex ?? -1,
      },
    });
  }

  return {
    compatible: sheets.length > 0,
    provider,
    compatibleCount: sheets.length,
    sheets,
  };
}

function backupWorkbook(source) {
  const id = String(source || '').replace(/^vault:/i, '').trim();
  const entry = fileVault.get(id);
  if (!entry?.path || !fs.existsSync(entry.path)) return null;
  const dir = path.join(config.projectRoot, '.ultron', 'three-poc-enrichment', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = path.basename(entry.name || 'workbook.xlsx').replace(/[^a-z0-9._-]+/gi, '_');
  const target = path.join(dir, `${stamp}-${safeName}`);
  fs.copyFileSync(entry.path, target);
  return target;
}

async function enrichWorkbook(source, options = {}) {
  const provider = sourceProvider(source);
  if (!provider) {
    const error = new Error('Agentic 3-POC enrichment requires an attached .xlsx workbook or a valid Google Sheets URL.');
    error.code = 'THREE_POC_SOURCE_REQUIRED';
    throw error;
  }
  const backupPath = provider === 'local-excel' ? backupWorkbook(source) : null;
  const workbookSheets = await readSourceSheets(source);
  const compatible = [];
  for (const sheet of workbookSheets) {
    try { compatible.push({ ...sheet, layout: sheet.layout || detectThreePocLayout(sheet.rows) }); }
    catch (error) { if (error.code !== 'THREE_POC_LAYOUT_NOT_FOUND') throw error; }
  }
  if (!compatible.length) {
    const error = new Error('No worksheet has at least two safely writable POC blocks (name + phone + email).');
    error.code = 'THREE_POC_LAYOUT_NOT_FOUND';
    throw error;
  }

  const createdLinkedInColumns = {};
  for (const sheet of compatible) {
    createdLinkedInColumns[sheet.sheetName] = await ensurePocLinkedInColumns(source, sheet);
  }

  const job = {
    id: `three-poc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    source,
    provider,
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sheets: {},
    pendingPhones: [],
  };
  const state = loadState();
  state.jobs.push(job);
  saveState(state);

  const stats = {
    jobId: job.id,
    provider,
    spreadsheetUrl: provider === 'google' ? source : null,
    compatibleSheets: compatible.map((sheet) => sheet.sheetName),
    maxPocSlots: Math.max(...compatible.map((sheet) => Number(sheet.layout?.slotCount || (sheet.layout?.third ? 3 : 2)))),
    scannedRows: 0,
    completedRows: 0,
    unresolvedRows: 0,
    failedRows: 0,
    candidatesSeen: 0,
    candidateSearchCalls: 0,
    candidateSearchFallbacks: 0,
    candidatePoolCacheHits: 0,
    candidateHydrations: 0,
    candidateHydrationFailures: 0,
    candidateHydrationFallbacks: 0,
    selectorEmptyOrFailedRows: 0,
    reviewerRescuedRows: 0,
    omniRouteSelectorCalls: 0,
    omniRouteReviewerCalls: 0,
    personalModelFallbacks: 0,
    locallyPrerankedCandidates: 0,
    existingPocVerificationAttempts: 0,
    existingPocVerificationFailures: 0,
    aiSelections: 0,
    contactsWritten: 0,
    emailsWritten: 0,
    phonesWritten: 0,
    pendingPhones: 0,
    linkedInsWritten: 0,
    poc1PhonesWritten: 0,
    poc1EmailsWritten: 0,
    poc2NamesWritten: 0,
    poc2PhonesWritten: 0,
    poc2EmailsWritten: 0,
    poc3NamesWritten: 0,
    poc3PhonesWritten: 0,
    poc3EmailsWritten: 0,
    existingPocSlotsRepaired: 0,
    createdLinkedInColumns,
    anchoredRows: 0,
    anchorsResolved: 0,
    explicitRows: 0,
    skippedNonPersonAnchorRows: 0,
    preservedExistingPocSlots: 0,
    matchedExistingPocSlots: 0,
    updatedCells: 0,
    agentModels: new Set(),
  };

  const rowLimit = Math.max(1, Math.min(500, Number(options.rowLimit || process.env.ULTRON_M3_THREE_POC_ROW_LIMIT || 500)));
  const candidatePoolCache = new Map();
  const hiringCandidateTitles = [
    'recruiter', 'technical recruiter', 'talent acquisition', 'recruitment',
    'human resources', 'HR manager', 'HR business partner', 'people partner',
    'people operations', 'hiring manager', 'talent partner',
    'founder', 'co-founder', 'owner', 'managing director', 'director'
  ];

  const candidatePoolFor = async (companyContext) => {
    const key = String(companyContext.domain || companyContext.company || '').trim().toLowerCase();
    if (key && candidatePoolCache.has(key)) {
      stats.candidatePoolCacheHits++;
      return candidatePoolCache.get(key);
    }
    stats.candidateSearchCalls++;
    let pool = null;
    try {
      pool = await apollo.searchCompanyPeopleBroad({
        company: companyContext.company,
        domain: companyContext.domain,
        limit: Math.max(12, Math.min(60, Number(options.candidateLimit || process.env.ULTRON_M3_THREE_POC_CANDIDATES || 40))),
        titles: hiringCandidateTitles,
      });
    } catch {
      stats.candidateSearchFallbacks++;
    }
    // Smaller firms sometimes expose no HR/recruiting titles. Fall back to a broad
    // employer search and let the selector reason from company/hiring context.
    if (!pool || (pool.people || []).length < 2) {
      if (pool) stats.candidateSearchFallbacks++;
      pool = await apollo.searchCompanyPeopleBroad({
        company: companyContext.company,
        domain: companyContext.domain,
        limit: Math.max(12, Math.min(60, Number(options.candidateLimit || process.env.ULTRON_M3_THREE_POC_CANDIDATES || 40))),
      });
    }
    if (key) candidatePoolCache.set(key, pool);
    return pool;
  };

  for (const sheet of compatible) {
    const layout = sheet.layout;
    const sheetStats = { scannedRows: 0, completedRows: 0, unresolvedRows: 0, failedRows: 0 };
    job.sheets[sheet.sheetName] = sheetStats;
    for (let index = layout.headerRowIndex + 1; index < sheet.rows.length && stats.scannedRows < rowLimit; index++) {
      const row = sheet.rows[index] || [];
      if (!row.some((value) => String(value ?? '').trim())) continue;
      const rowNumber = index + 1;
      stats.scannedRows++;
      sheetStats.scannedRows++;
      const context = rowContext(layout, row, sheet.sheetName, rowNumber);

      try {
        if (String(layout.schema || '').startsWith('anchored_first_poc')) {
          stats.anchoredRows++;
          if (context.linkedinProfileKind !== 'person') {
            stats.skippedNonPersonAnchorRows++;
            stats.unresolvedRows++; sheetStats.unresolvedRows++;
            continue;
          }

          const anchor = await resolveAnchorPerson(context, layout, row);
          if (!anchor?.organizationName) {
            stats.unresolvedRows++; sheetStats.unresolvedRows++;
            continue;
          }

          const companyContext = anchorCompanyContext(anchor, context);
          const pool = await candidatePoolFor(companyContext);

          const anchorLinkedIn = apollo.normalizeLinkedIn(anchor.linkedinUrl);
          const anchorNameKey = personNameKey(anchor.name || context.anchorName);
          const candidates = (pool.people || []).map(candidateView).filter((candidate) => {
            if (anchor.apolloPersonId && String(candidate.id || '') === String(anchor.apolloPersonId)) return false;
            const candidateLinkedIn = apollo.normalizeLinkedIn(candidate.linkedinUrl);
            if (anchorLinkedIn && candidateLinkedIn === anchorLinkedIn) return false;
            if (anchorNameKey && !candidate.searchLimitedIdentity && personNameKey(candidate.name) === anchorNameKey) return false;
            return true;
          });
          stats.candidatesSeen += candidates.length;

          const slotDefs = [layout.second, layout.third].filter(Boolean);
          const slotPeople = slotDefs.map(() => null);
          const lockedSlots = slotDefs.map(() => false);
          const usedKeys = new Set();

          for (let slotIndex = 0; slotIndex < slotDefs.length; slotIndex++) {
            const existing = slotSnapshot(row, slotDefs[slotIndex]);
            if (!existing.name && (existing.phone || existing.email)) {
              lockedSlots[slotIndex] = true;
              stats.preservedExistingPocSlots++;
              continue;
            }
            if (!existing.name) continue;

            stats.existingPocVerificationAttempts++;
            try {
              const verified = await apollo.resolvePersonByNameCompany(
                existing.name,
                companyContext.company,
                companyContext.domain,
                { needEmail: !existing.email, needPhone: !existing.phone }
              );
              const enrichedExisting = {
                candidateKey: String(verified.apolloPersonId || verified.id || verified.linkedinUrl),
                id: verified.apolloPersonId || verified.id || null,
                ...verified,
                email: existing.email || verified.email || null,
                phone: existing.phone || verified.phone || null,
                phonePending: !existing.phone && verified.phoneStatus === 'pending' && Boolean(verified.apolloPersonId),
                identityVerified: true,
              };
              if (!hasVerifiedPocIdentity(enrichedExisting)) throw new Error('EXISTING_POC_IDENTITY_NOT_VERIFIED');
              slotPeople[slotIndex] = enrichedExisting;
              usedKeys.add(enrichedExisting.candidateKey);
              stats.matchedExistingPocSlots++;
            } catch {
              lockedSlots[slotIndex] = true;
              stats.existingPocVerificationFailures++;
              stats.preservedExistingPocSlots++;
              continue;
            }
          }

          const openSlots = slotDefs.map((_, index) => index).filter((index) => !lockedSlots[index] && !slotPeople[index]);
          const available = candidates.filter((candidate) => !usedKeys.has(candidate.candidateKey));
          if (openSlots.length && available.length) {
            const reasoningCandidates = preRankCandidates(available, {
              postDetails: context.postDetails,
              hiringContext: companyContext.hiringContext,
            }, Number(options.aiCandidateLimit || process.env.ULTRON_M3_THREE_POC_AI_CANDIDATES || 10));
            stats.locallyPrerankedCandidates += reasoningCandidates.length;

            let selected = { ranking: [], model: null, provider: null };
            let selectorFailed = false;
            try {
              stats.omniRouteSelectorCalls++;
              selected = await selectorAgent(context, companyContext, reasoningCandidates, {
                count: openSlots.length,
                anchorPerson: { name: anchor.name || context.anchorName, title: anchor.title || '', linkedinUrl: anchor.linkedinUrl },
              });
              if (selected.model) stats.agentModels.add(`${selected.provider || 'unknown'}/${selected.model}`);
              if (selected.transport !== 'omniroute' || selected.routingMode !== 'omniroute-only') {
                stats.personalModelFallbacks++;
                throw new Error('THREE_POC_NON_OMNIROUTE_SELECTOR_BLOCKED');
              }
            } catch {
              selectorFailed = true;
            }
            if (selectorFailed || !selected.ranking.length) stats.selectorEmptyOrFailedRows++;

            let finalRanking = selected.ranking.slice(0, Math.max(openSlots.length * 3, 4));
            if (reviewerRequired(selected.ranking, openSlots.length)) {
              try {
                stats.omniRouteReviewerCalls++;
                const reviewed = await reviewerAgent(context, companyContext, reasoningCandidates, selected.ranking, {
                  count: openSlots.length,
                  anchorPerson: { name: anchor.name || context.anchorName, title: anchor.title || '', linkedinUrl: anchor.linkedinUrl },
                });
                if (reviewed.model) stats.agentModels.add(`${reviewed.provider || 'unknown'}/${reviewed.model}`);
                if (reviewed.transport !== 'omniroute' || reviewed.routingMode !== 'omniroute-only') {
                  stats.personalModelFallbacks++;
                  throw new Error('THREE_POC_NON_OMNIROUTE_REVIEWER_BLOCKED');
                }
                if (reviewed.ranking.length) {
                  if (!selected.ranking.length) stats.reviewerRescuedRows++;
                  const reviewedKeys = new Set(reviewed.ranking.map((item) => item.candidateKey));
                  finalRanking = [
                    ...reviewed.ranking,
                    ...selected.ranking.filter((item) => !reviewedKeys.has(item.candidateKey)),
                  ].slice(0, Math.max(openSlots.length * 3, 4));
                }
              } catch {}
            }

            const rankedPeople = selectedPeople(reasoningCandidates, finalRanking, Math.min(6, Math.max(openSlots.length * 3, 4)));
            let rankedIndex = 0;
            for (const slotIndex of openSlots) {
              let filled = false;
              while (!filled && rankedIndex < rankedPeople.length) {
                const person = rankedPeople[rankedIndex++];
                if (!person) continue;
                stats.candidateHydrations++;
                try {
                  const enrichedPerson = await enrichSelectedPerson(person, {}, {
                    company: companyContext.company,
                    domain: companyContext.domain,
                  });
                  if (!hasVerifiedPocIdentity(enrichedPerson)) {
                    stats.candidateHydrationFailures++;
                    stats.candidateHydrationFallbacks++;
                    continue;
                  }
                  slotPeople[slotIndex] = enrichedPerson;
                  usedKeys.add(String(enrichedPerson.apolloPersonId || enrichedPerson.id || enrichedPerson.linkedinUrl));
                  stats.aiSelections++;
                  filled = true;
                } catch {
                  stats.candidateHydrationFailures++;
                  stats.candidateHydrationFallbacks++;
                }
              }
            }
          }

          const changes = anchoredRowChanges(sheet.sheetName, rowNumber, layout, anchor, slotPeople, lockedSlots, row);
          const counts = anchoredChangeCounts(changes, sheet.sheetName, rowNumber, layout);
          const written = changes.length ? await writeSourceCells(source, changes) : { updatedCells: 0 };
          const writtenPeople = [anchor, ...slotPeople.filter(Boolean)];
          stats.updatedCells += written.updatedCells || 0;
          stats.contactsWritten += slotPeople.filter(Boolean).length;
          stats.poc1PhonesWritten += counts.poc1Phone;
          stats.poc1EmailsWritten += counts.poc1Email;
          stats.poc2NamesWritten += counts.poc2Name;
          stats.poc2PhonesWritten += counts.poc2Phone;
          stats.poc2EmailsWritten += counts.poc2Email;
          stats.poc3NamesWritten += counts.poc3Name;
          stats.poc3PhonesWritten += counts.poc3Phone;
          stats.poc3EmailsWritten += counts.poc3Email;
          stats.phonesWritten += counts.poc1Phone + counts.poc2Phone + counts.poc3Phone;
          stats.emailsWritten += counts.poc1Email + counts.poc2Email + counts.poc3Email;
          if (String(row?.[layout.second.nameIndex] || '').trim() && (counts.poc2Phone || counts.poc2Email || counts.poc2Name)) {
            stats.existingPocSlotsRepaired++;
          }
          if (layout.third && String(row?.[layout.third.nameIndex] || '').trim() && (counts.poc3Phone || counts.poc3Email || counts.poc3Name)) {
            stats.existingPocSlotsRepaired++;
          }
          stats.anchorsResolved += anchor.linkedinUrl ? 1 : 0;
          stats.completedRows++; sheetStats.completedRows++;

          if (anchor.phonePending && anchor.apolloPersonId) {
            job.pendingPhones.push(pendingRecord(source, sheet.sheetName, rowNumber, layout.first, anchor));
            stats.pendingPhones++;
          }
          slotPeople.forEach((person, slotIndex) => {
            if (!person?.phonePending || !person.apolloPersonId) return;
            job.pendingPhones.push(pendingRecord(source, sheet.sheetName, rowNumber, slotDefs[slotIndex], person));
            stats.pendingPhones++;
          });
          job.updatedAt = new Date().toISOString();
          saveState(state);
          continue;
        }

        stats.explicitRows++;
        const companyContext = await companyContextAgent(context);
        if (!companyContext.company || companyContext.confidence < 0.35) {
          stats.unresolvedRows++; sheetStats.unresolvedRows++;
          continue;
        }
        if (companyContext.model) stats.agentModels.add(`${companyContext.provider || 'unknown'}/${companyContext.model}`);

        const pool = await candidatePoolFor(companyContext);
        const candidates = (pool.people || []).map(candidateView);
        stats.candidatesSeen += candidates.length;
        if (!candidates.length) {
          stats.unresolvedRows++; sheetStats.unresolvedRows++;
          continue;
        }

        const reasoningCandidates = preRankCandidates(candidates, {
          postDetails: context.postDetails,
          hiringContext: companyContext.hiringContext,
        }, Number(options.aiCandidateLimit || process.env.ULTRON_M3_THREE_POC_AI_CANDIDATES || 10));
        stats.locallyPrerankedCandidates += reasoningCandidates.length;

        const explicitSlots = [layout.first, layout.second, layout.third].filter(Boolean);
        const requestedSlotCount = explicitSlots.length;
        let selected = { ranking: [], model: null, provider: null };
        let selectorFailed = false;
        try {
          stats.omniRouteSelectorCalls++;
          selected = await selectorAgent(context, companyContext, reasoningCandidates, { count: requestedSlotCount });
          if (selected.model) stats.agentModels.add(`${selected.provider || 'unknown'}/${selected.model}`);
          if (selected.transport !== 'omniroute' || selected.routingMode !== 'omniroute-only') {
            stats.personalModelFallbacks++;
            throw new Error('THREE_POC_NON_OMNIROUTE_SELECTOR_BLOCKED');
          }
        } catch {
          selectorFailed = true;
        }
        if (selectorFailed || !selected.ranking.length) stats.selectorEmptyOrFailedRows++;

        let finalRanking = selected.ranking.slice(0, 8);
        if (reviewerRequired(selected.ranking, requestedSlotCount)) {
          try {
            stats.omniRouteReviewerCalls++;
            const reviewed = await reviewerAgent(context, companyContext, reasoningCandidates, selected.ranking, { count: requestedSlotCount });
            if (reviewed.model) stats.agentModels.add(`${reviewed.provider || 'unknown'}/${reviewed.model}`);
            if (reviewed.transport !== 'omniroute' || reviewed.routingMode !== 'omniroute-only') {
              stats.personalModelFallbacks++;
              throw new Error('THREE_POC_NON_OMNIROUTE_REVIEWER_BLOCKED');
            }
            if (reviewed.ranking.length) {
              if (!selected.ranking.length) stats.reviewerRescuedRows++;
              finalRanking = reviewed.ranking;
            }
          } catch {}
        }

        if (!finalRanking.length) {
          stats.unresolvedRows++; sheetStats.unresolvedRows++;
          continue;
        }

        const people = selectedPeople(reasoningCandidates, finalRanking, 6);
        if (!people.length) {
          stats.unresolvedRows++; sheetStats.unresolvedRows++;
          continue;
        }

        const enriched = [];
        for (const person of people) {
          if (enriched.length >= requestedSlotCount) break;
          stats.candidateHydrations++;
          try {
            const hydrated = await enrichSelectedPerson(person, {}, { company: companyContext.company, domain: companyContext.domain });
            if (!hasVerifiedPocIdentity(hydrated)) {
              stats.candidateHydrationFailures++;
              stats.candidateHydrationFallbacks++;
              continue;
            }
            enriched.push(hydrated);
          } catch {
            stats.candidateHydrationFailures++;
            stats.candidateHydrationFallbacks++;
          }
        }
        if (!enriched.length) {
          stats.unresolvedRows++; sheetStats.unresolvedRows++;
          continue;
        }
        const changes = rowChanges(sheet.sheetName, rowNumber, layout, enriched, row);
        const written = await writeSourceCells(source, changes);
        stats.updatedCells += written.updatedCells || 0;
        stats.contactsWritten += enriched.length;
        stats.emailsWritten += enriched.filter((person) => person.email).length;
        stats.phonesWritten += enriched.filter((person) => person.phone).length;
        stats.linkedInsWritten += enriched.filter((person) => person.linkedinUrl).length;
        stats.aiSelections += enriched.length;
        stats.completedRows++; sheetStats.completedRows++;

        const slots = [layout.first, layout.second, layout.third].filter(Boolean);
        enriched.forEach((person, slotIndex) => {
          if (!person.phonePending || !person.apolloPersonId) return;
          job.pendingPhones.push(pendingRecord(source, sheet.sheetName, rowNumber, slots[slotIndex], person));
          stats.pendingPhones++;
        });
        job.updatedAt = new Date().toISOString();
        saveState(state);
      } catch (error) {
        stats.failedRows++; sheetStats.failedRows++;
        sheetStats.lastError = error.message;
      }
    }
  }

  stats.agentModels = [...stats.agentModels];
  job.status = stats.failedRows ? 'completed_with_errors' : (stats.pendingPhones ? 'waiting_for_phone_webhooks' : 'completed');
  job.stats = stats;
  job.updatedAt = new Date().toISOString();
  saveState(state);
  if (stats.pendingPhones) startPhoneWatcher();

  return {
    ...stats,
    artifact: provider === 'local-excel' ? localExcel.artifact(source) : null,
    spreadsheetUrl: provider === 'google' ? source : null,
    status: job.status,
    backupPath,
  };
}

function pendingCount() {
  const state = loadState();
  return (state.jobs || []).flatMap((job) => job.pendingPhones || []).filter((record) => record?.pending).length;
}

function formatResult(result) {
  const pending = result.pendingPhones
    ? ` ${result.pendingPhones} phone reveal${result.pendingPhones === 1 ? ' is' : 's are'} still pending Apollo webhook delivery and will auto-fill when received.`
    : '';
  const unresolved = result.unresolvedRows
    ? ` ${result.unresolvedRows} row${result.unresolvedRows === 1 ? '' : 's'} were left unchanged because company/candidate evidence was not strong enough.`
    : '';
  const anchored = result.anchoredRows
    ? ` Anchored-format rows: ${result.anchoredRows}; preserved ${result.preservedExistingPocSlots || 0} already-populated/unsafe-to-reassign POC slot${Number(result.preservedExistingPocSlots || 0) === 1 ? '' : 's'}; safely verified ${result.matchedExistingPocSlots || 0} existing POC identit${Number(result.matchedExistingPocSlots || 0) === 1 ? 'y' : 'ies'}; skipped ${result.skippedNonPersonAnchorRows || 0} company/unknown LinkedIn anchor row${Number(result.skippedNonPersonAnchorRows || 0) === 1 ? '' : 's'} without changing them.`
    : '';
  const discovery = ` Candidate discovery: ${result.candidatesSeen || 0} usable Apollo ID candidates from ${result.candidateSearchCalls || 0} employer search call${Number(result.candidateSearchCalls || 0) === 1 ? '' : 's'} (${result.candidatePoolCacheHits || 0} employer-pool cache hits, ${result.candidateSearchFallbacks || 0} broad fallback searches); hydrated ${result.candidateHydrations || 0} selected candidate${Number(result.candidateHydrations || 0) === 1 ? '' : 's'} by exact Apollo ID, with ${result.candidateHydrationFailures || 0} hydration failure${Number(result.candidateHydrationFailures || 0) === 1 ? '' : 's'} and ${result.candidateHydrationFallbacks || 0} fallback attempt${Number(result.candidateHydrationFallbacks || 0) === 1 ? '' : 's'}; selector empty/failed rows ${result.selectorEmptyOrFailedRows || 0}, reviewer rescues ${result.reviewerRescuedRows || 0}. Heavy reasoning used OmniRoute-only: ${result.omniRouteSelectorCalls || 0} selector call${Number(result.omniRouteSelectorCalls || 0) === 1 ? '' : 's'}, ${result.omniRouteReviewerCalls || 0} reviewer call${Number(result.omniRouteReviewerCalls || 0) === 1 ? '' : 's'}, ${result.personalModelFallbacks || 0} personal-API fallback${Number(result.personalModelFallbacks || 0) === 1 ? '' : 's'}; ${result.locallyPrerankedCandidates || 0} locally pre-ranked candidate rows were sent in compact form. Existing-POC exact name+employer verification failures: ${result.existingPocVerificationFailures || 0}/${result.existingPocVerificationAttempts || 0}.`;
  const anchoredWrites = result.anchoredRows
    ? ` Actual anchored writes: POC-1 F/G = ${result.poc1PhonesWritten || 0} phone, ${result.poc1EmailsWritten || 0} email; POC-2 H/I/J = ${result.poc2NamesWritten || 0} name/designation, ${result.poc2PhonesWritten || 0} phone, ${result.poc2EmailsWritten || 0} email; POC-3 K/L/M = ${result.poc3NamesWritten || 0} name/designation, ${result.poc3PhonesWritten || 0} phone, ${result.poc3EmailsWritten || 0} email. Existing POC slots repaired/upgraded: ${result.existingPocSlotsRepaired || 0}.`
    : '';
  return `Agentic ${result.maxPocSlots || 3}-POC enrichment finished. Processed ${result.scannedRows} row${result.scannedRows === 1 ? '' : 's'} across ${result.compatibleSheets.join(', ')}; completed ${result.completedRows}; selected ${result.aiSelections} NEW AI-ranked additional POCs; resolved ${result.anchorsResolved || 0} exact POC-1 LinkedIn anchor${Number(result.anchorsResolved || 0) === 1 ? '' : 's'}; changed ${result.updatedCells || 0} spreadsheet cell${Number(result.updatedCells || 0) === 1 ? '' : 's'}.${anchored}${anchoredWrites}${discovery}${pending}${unresolved}`;
}

module.exports = {
  STATE_FILE,
  detectThreePocLayout,
  writeSourceCells,
  rowChanges,
  anchoredRowChanges,
  rowContext,
  linkedInProfileKind,
  personNameKey,
  slotSnapshot,
  matchExistingCandidate,
  localHiringScore,
  preRankCandidates,
  compactCandidate,
  reviewerRequired,
  validKeys,
  selectedPeople,
  safeDesignation,
  hasNameAndDesignation,
  hasVerifiedPocIdentity,
  displayName,
  ensurePocLinkedInColumns,
  resolveAnchorPerson,
  anchorCompanyContext,
  anchoredRowChanges,
  anchoredChangeCounts,
  companyContextAgent,
  selectorAgent,
  reviewerAgent,
  inspectSource,
  enrichWorkbook,
  syncPendingPhones,
  startPhoneWatcher,
  pendingCount,
  formatResult,
  backupWorkbook,
};
