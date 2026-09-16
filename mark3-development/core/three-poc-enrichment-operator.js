const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const localExcel = require('./local-excel-operator');
const fileVault = require('./file-vault');
const apollo = require('./apollo-enrichment');
const modelRouter = require('./model-router');

const STATE_FILE = path.join(config.projectRoot, '.ultron', 'three-poc-enrichment', 'jobs.json');
let watcherTimer = null;
let watcherRemaining = 0;

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
    const thirdName = findHeader(row, P3);
    if (secondName < 0 || thirdName < 0 || thirdName <= secondName) continue;
    const explicitFirst = findHeader(row, P1);
    const first = explicitFirst >= 0 ? contactSlot(row, explicitFirst, secondName, P1_LINKEDIN) : legacyFirstSlot(row, secondName);
    const second = contactSlot(row, secondName, thirdName, P2_LINKEDIN);
    const third = contactSlot(row, thirdName, row.length, P3_LINKEDIN);
    if (!first || !second || !third) continue;

    const companyIndex = findHeader(row, COMPANY);
    const postDetailsIndex = findHeader(row, DETAILS);
    const linkedinIndex = findHeader(row, LINKEDIN);
    const score = 100 + (explicitFirst >= 0 ? 20 : 0) + (companyIndex >= 0 ? 6 : 0) + (postDetailsIndex >= 0 ? 4 : 0) + (linkedinIndex >= 0 ? 2 : 0) - r * 0.1;
    const candidate = {
      headerRowIndex: r,
      headerRowNumber: r + 1,
      schema: explicitFirst >= 0 ? 'explicit_three_poc' : 'anchored_first_poc',
      first,
      second,
      third,
      companyIndex,
      postDetailsIndex,
      linkedinIndex,
      score,
    };
    if (!best || candidate.score > best.score) best = candidate;
  }
  if (!best) {
    const error = new Error('No safe 3-POC column layout was detected in this worksheet.');
    error.code = 'THREE_POC_LAYOUT_NOT_FOUND';
    throw error;
  }
  return best;
}

async function ensurePocLinkedInColumns(source, sheet) {
  const layout = sheet.layout;
  if (layout.schema === 'anchored_first_poc') return [];
  const slots = [
    { slot: layout.first, label: '1st POC LinkedIn' },
    { slot: layout.second, label: '2nd POC LinkedIn' },
    { slot: layout.third, label: '3rd POC LinkedIn' },
  ];
  let nextIndex = (sheet.rows || []).reduce((max, row) => Math.max(max, (row || []).length), 0);
  const changes = [];
  const created = [];
  for (const item of slots) {
    if (Number.isInteger(item.slot.linkedinIndex) && item.slot.linkedinIndex >= 0) continue;
    item.slot.linkedinIndex = nextIndex++;
    changes.push({
      range: localExcel.cellRange(sheet.sheetName, layout.headerRowNumber, item.slot.linkedinIndex),
      value: item.label,
    });
    created.push(item.label);
  }
  if (changes.length) await localExcel.writeCells(source, changes);
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
      layout.third.phoneIndex, layout.third.emailIndex,
      layout.first.linkedinIndex, layout.second.linkedinIndex, layout.third.linkedinIndex,
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
  const result = await modelRouter.chat({ taskType: 'research', messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
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
    name: person.name || '',
    title: person.title || '',
    headline: person.headline || '',
    seniority: person.seniority || '',
    departments: person.departments || [],
    functions: person.functions || [],
    location: person.location || '',
    linkedinUrl: person.linkedinUrl || '',
    organizationName: person.organizationName || '',
  };
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
  const result = await modelRouter.chat({
    taskType: 'research',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({
        company: companyContext.company,
        hiringContext: companyContext.hiringContext,
        requestedAdditionalPocs: requested,
        anchorPerson: options.anchorPerson || null,
        rowEvidence: { postDetails: context.postDetails, sourceLinkedIn: context.linkedin },
        candidates,
      }) },
    ],
  });
  return { ranking: validKeys(parseJson(modelText(result)), candidates, 8), model: result?.model || null, provider: result?.provider || null };
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
  const result = await modelRouter.chat({
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
        candidates,
      }) },
    ],
  });
  return { ranking: validKeys(parseJson(modelText(result)), candidates, requested), model: result?.model || null, provider: result?.provider || null };
}

function selectedPeople(candidates, ranking, max = 3) {
  const byKey = new Map(candidates.map((candidate) => [candidate.candidateKey, candidate]));
  return (ranking || []).map((item) => {
    const candidate = byKey.get(item.candidateKey);
    return candidate ? { ...candidate, selectionReason: item.reason, selectionConfidence: item.confidence } : null;
  }).filter(Boolean).slice(0, Math.max(1, Math.min(3, Number(max || 3))));
}

function displayName(person) {
  const name = String(person?.name || '').trim();
  const title = String(person?.title || '').trim();
  return title ? `${name} — ${title}` : name;
}

async function enrichSelectedPerson(person, existing = {}) {
  const existingEmail = apollo.validEmail(existing.email);
  const existingPhone = apollo.validPhone(existing.phone);
  const linkedIn = apollo.normalizeLinkedIn(person.linkedinUrl);
  if (!linkedIn) {
    return {
      ...person,
      email: existingEmail || apollo.validEmail(person.email),
      phone: existingPhone || apollo.validPhone(person.phone),
      phonePending: false,
      apolloPersonId: person.id || null,
    };
  }
  const result = await apollo.enrich(linkedIn, {
    needEmail: !existingEmail,
    needPhone: !existingPhone,
    force: false,
  });
  return {
    ...person,
    linkedinUrl: linkedIn,
    email: existingEmail || apollo.validEmail(result.email) || apollo.validEmail(person.email),
    phone: existingPhone || apollo.validPhone(result.phone) || apollo.validPhone(person.phone),
    phonePending: !existingPhone && result.phoneStatus === 'pending' && Boolean(result.apolloPersonId),
    apolloPersonId: result.apolloPersonId || person.id || null,
    matchConfidence: result.matchConfidence || null,
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

function rowChanges(sheetName, rowNumber, layout, people) {
  const slots = [layout.first, layout.second, layout.third];
  const changes = [];
  for (let i = 0; i < 3; i++) {
    const slot = slots[i];
    const person = people[i] || null;
    changes.push({ range: localExcel.cellRange(sheetName, rowNumber, slot.nameIndex), value: person ? displayName(person) : '' });
    if (Number.isInteger(slot.linkedinIndex) && slot.linkedinIndex >= 0) {
      changes.push({ range: localExcel.cellRange(sheetName, rowNumber, slot.linkedinIndex), value: person?.linkedinUrl || '' });
    }
    changes.push({ range: localExcel.cellRange(sheetName, rowNumber, slot.phoneIndex), value: person?.phone || '' });
    changes.push({ range: localExcel.cellRange(sheetName, rowNumber, slot.emailIndex), value: person?.email || '' });
  }
  return changes;
}

function anchoredRowChanges(sheetName, rowNumber, layout, anchor, slotPeople = [], lockedSlots = []) {
  const changes = [];
  changes.push({ range: localExcel.cellRange(sheetName, rowNumber, layout.first.phoneIndex), value: anchor?.phone || '' });
  changes.push({ range: localExcel.cellRange(sheetName, rowNumber, layout.first.emailIndex), value: anchor?.email || '' });

  const slots = [layout.second, layout.third];
  for (let i = 0; i < slots.length; i++) {
    if (lockedSlots[i]) continue;
    const person = slotPeople[i] || null;
    if (!person) continue;
    changes.push({ range: localExcel.cellRange(sheetName, rowNumber, slots[i].nameIndex), value: displayName(person) });
    changes.push({ range: localExcel.cellRange(sheetName, rowNumber, slots[i].phoneIndex), value: person.phone || '' });
    changes.push({ range: localExcel.cellRange(sheetName, rowNumber, slots[i].emailIndex), value: person.email || '' });
  }
  return changes;
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
        await localExcel.writeCells(match.record.source, [{
          range: localExcel.cellRange(match.record.sheetName, match.record.rowNumber, match.record.phoneColumnIndex),
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
  if (!localExcel.isLocalExcelSource(source)) {
    const error = new Error('Agentic 3-POC enrichment currently requires an attached .xlsx workbook.');
    error.code = 'THREE_POC_LOCAL_XLSX_REQUIRED';
    throw error;
  }
  const backupPath = backupWorkbook(source);
  const workbookSheets = await localExcel.readWorkbookSheets(source);
  const compatible = [];
  for (const sheet of workbookSheets) {
    try { compatible.push({ ...sheet, layout: detectThreePocLayout(sheet.rows) }); }
    catch (error) { if (error.code !== 'THREE_POC_LAYOUT_NOT_FOUND') throw error; }
  }
  if (!compatible.length) {
    const error = new Error('No worksheet has three safely writable POC blocks (name + phone + email).');
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
    compatibleSheets: compatible.map((sheet) => sheet.sheetName),
    scannedRows: 0,
    completedRows: 0,
    unresolvedRows: 0,
    failedRows: 0,
    candidatesSeen: 0,
    aiSelections: 0,
    contactsWritten: 0,
    emailsWritten: 0,
    phonesWritten: 0,
    pendingPhones: 0,
    linkedInsWritten: 0,
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
        if (layout.schema === 'anchored_first_poc') {
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
          const pool = await apollo.searchCompanyPeopleBroad({
            company: companyContext.company,
            domain: companyContext.domain,
            limit: Math.max(12, Math.min(60, Number(options.candidateLimit || process.env.ULTRON_M3_THREE_POC_CANDIDATES || 40))),
          });

          const anchorLinkedIn = apollo.normalizeLinkedIn(anchor.linkedinUrl);
          const anchorNameKey = personNameKey(anchor.name || context.anchorName);
          const candidates = (pool.people || []).map(candidateView).filter((candidate) => {
            const candidateLinkedIn = apollo.normalizeLinkedIn(candidate.linkedinUrl);
            if (anchorLinkedIn && candidateLinkedIn === anchorLinkedIn) return false;
            if (anchorNameKey && personNameKey(candidate.name) === anchorNameKey) return false;
            return true;
          });
          stats.candidatesSeen += candidates.length;

          const slotDefs = [layout.second, layout.third];
          const slotPeople = [null, null];
          const lockedSlots = [false, false];
          const usedKeys = new Set();

          for (let slotIndex = 0; slotIndex < slotDefs.length; slotIndex++) {
            const existing = slotSnapshot(row, slotDefs[slotIndex]);
            if (!existing.name && (existing.phone || existing.email)) {
              lockedSlots[slotIndex] = true;
              stats.preservedExistingPocSlots++;
              continue;
            }
            if (!existing.name) continue;
            if (existing.phone && existing.email) {
              lockedSlots[slotIndex] = true;
              stats.preservedExistingPocSlots++;
              continue;
            }

            const matched = matchExistingCandidate(existing.name, candidates);
            if (!matched) {
              lockedSlots[slotIndex] = true;
              stats.preservedExistingPocSlots++;
              continue;
            }

            const enrichedExisting = await enrichSelectedPerson(matched, existing);
            slotPeople[slotIndex] = enrichedExisting;
            usedKeys.add(enrichedExisting.candidateKey);
            stats.matchedExistingPocSlots++;
          }

          const openSlots = slotDefs.map((_, index) => index).filter((index) => !lockedSlots[index] && !slotPeople[index]);
          const available = candidates.filter((candidate) => !usedKeys.has(candidate.candidateKey));
          if (openSlots.length && available.length) {
            const selected = await selectorAgent(context, companyContext, available, {
              count: openSlots.length,
              anchorPerson: { name: anchor.name || context.anchorName, title: anchor.title || '', linkedinUrl: anchor.linkedinUrl },
            });
            if (selected.model) stats.agentModels.add(`${selected.provider || 'unknown'}/${selected.model}`);

            let finalRanking = selected.ranking.slice(0, openSlots.length);
            if (selected.ranking.length) {
              try {
                const reviewed = await reviewerAgent(context, companyContext, available, selected.ranking, {
                  count: openSlots.length,
                  anchorPerson: { name: anchor.name || context.anchorName, title: anchor.title || '', linkedinUrl: anchor.linkedinUrl },
                });
                if (reviewed.model) stats.agentModels.add(`${reviewed.provider || 'unknown'}/${reviewed.model}`);
                if (reviewed.ranking.length) finalRanking = reviewed.ranking;
              } catch {}
            }

            const additional = selectedPeople(available, finalRanking, openSlots.length);
            for (let i = 0; i < openSlots.length; i++) {
              const person = additional[i];
              if (!person) continue;
              slotPeople[openSlots[i]] = await enrichSelectedPerson(person);
            }
          }

          const changes = anchoredRowChanges(sheet.sheetName, rowNumber, layout, anchor, slotPeople, lockedSlots);
          const written = await localExcel.writeCells(source, changes);
          const writtenPeople = [anchor, ...slotPeople.filter(Boolean)];
          stats.updatedCells += written.updatedCells || 0;
          stats.contactsWritten += writtenPeople.length;
          stats.emailsWritten += writtenPeople.filter((person) => person.email).length;
          stats.phonesWritten += writtenPeople.filter((person) => person.phone).length;
          stats.anchorsResolved += anchor.linkedinUrl ? 1 : 0;
          stats.aiSelections += slotPeople.filter(Boolean).length;
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

        const pool = await apollo.searchCompanyPeopleBroad({
          company: companyContext.company,
          domain: companyContext.domain,
          limit: Math.max(12, Math.min(60, Number(options.candidateLimit || process.env.ULTRON_M3_THREE_POC_CANDIDATES || 40))),
        });
        const candidates = (pool.people || []).map(candidateView);
        stats.candidatesSeen += candidates.length;
        if (!candidates.length) {
          stats.unresolvedRows++; sheetStats.unresolvedRows++;
          continue;
        }

        const selected = await selectorAgent(context, companyContext, candidates, { count: 3 });
        if (selected.model) stats.agentModels.add(`${selected.provider || 'unknown'}/${selected.model}`);
        if (!selected.ranking.length) {
          stats.unresolvedRows++; sheetStats.unresolvedRows++;
          continue;
        }

        let finalRanking = selected.ranking.slice(0, 3);
        try {
          const reviewed = await reviewerAgent(context, companyContext, candidates, selected.ranking, { count: 3 });
          if (reviewed.model) stats.agentModels.add(`${reviewed.provider || 'unknown'}/${reviewed.model}`);
          if (reviewed.ranking.length) finalRanking = reviewed.ranking;
        } catch {}

        const people = selectedPeople(candidates, finalRanking, 3);
        if (!people.length) {
          stats.unresolvedRows++; sheetStats.unresolvedRows++;
          continue;
        }

        const enriched = [];
        for (const person of people) enriched.push(await enrichSelectedPerson(person));
        const changes = rowChanges(sheet.sheetName, rowNumber, layout, enriched);
        const written = await localExcel.writeCells(source, changes);
        stats.updatedCells += written.updatedCells || 0;
        stats.contactsWritten += enriched.length;
        stats.emailsWritten += enriched.filter((person) => person.email).length;
        stats.phonesWritten += enriched.filter((person) => person.phone).length;
        stats.linkedInsWritten += enriched.filter((person) => person.linkedinUrl).length;
        stats.aiSelections += enriched.length;
        stats.completedRows++; sheetStats.completedRows++;

        const slots = [layout.first, layout.second, layout.third];
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

  return { ...stats, artifact: localExcel.artifact(source), status: job.status, backupPath };
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
    ? ` Anchored-format rows: ${result.anchoredRows}; preserved ${result.preservedExistingPocSlots || 0} already-populated/unsafe-to-reassign POC slot${Number(result.preservedExistingPocSlots || 0) === 1 ? '' : 's'}; skipped ${result.skippedNonPersonAnchorRows || 0} company/unknown LinkedIn anchor row${Number(result.skippedNonPersonAnchorRows || 0) === 1 ? '' : 's'} without changing them.`
    : '';
  return `Agentic 3-POC enrichment finished. Processed ${result.scannedRows} row${result.scannedRows === 1 ? '' : 's'} across ${result.compatibleSheets.join(', ')}; completed ${result.completedRows}; selected ${result.aiSelections} AI-ranked additional POCs; resolved ${result.anchorsResolved || 0} exact POC-1 LinkedIn anchor${Number(result.anchorsResolved || 0) === 1 ? '' : 's'}; wrote ${result.linkedInsWritten || 0} LinkedIn link${Number(result.linkedInsWritten || 0) === 1 ? '' : 's'} in explicit layouts, ${result.phonesWritten} person phone${result.phonesWritten === 1 ? '' : 's'} and ${result.emailsWritten} person email${result.emailsWritten === 1 ? '' : 's'}.${anchored}${pending}${unresolved}`;
}

module.exports = {
  STATE_FILE,
  detectThreePocLayout,
  rowContext,
  linkedInProfileKind,
  personNameKey,
  slotSnapshot,
  matchExistingCandidate,
  validKeys,
  selectedPeople,
  displayName,
  ensurePocLinkedInColumns,
  resolveAnchorPerson,
  anchorCompanyContext,
  anchoredRowChanges,
  companyContextAgent,
  selectorAgent,
  reviewerAgent,
  enrichWorkbook,
  syncPendingPhones,
  startPhoneWatcher,
  pendingCount,
  formatResult,
  backupWorkbook,
};
