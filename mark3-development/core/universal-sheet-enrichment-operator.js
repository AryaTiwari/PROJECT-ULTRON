'use strict';

// Universal deterministic spreadsheet enrichment executor.
// No model/router dependency is permitted in this file.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const sheets = require('./google-sheets-operator');
const apollo = require('./apollo-enrichment');
const linkedinMcp = require('./linkedin-mcp-client');
const linkedinPublic = require('./linkedin-public-research');
const leadSources = require('./lead-source-fusion');
const web = require('./web');
const schemaTools = require('./universal-sheet-schema');
const planner = require('./universal-enrichment-planner');
const ranker = require('./universal-authority-ranker');
const profileParser = require('./universal-linkedin-profile-parser');
const orphanPolicy = require('./universal-orphan-contact-policy');
const engine = require('./universal-enrichment-engine');
const typedErrors = require('./spreadsheet-enrichment-errors');
const diagnostics = require('./universal-enrichment-diagnostics');

function text(value) { return String(value ?? '').trim(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function integer(value, fallback, min = 1, max = 100000) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}
function websiteDomain(value) { return ranker.hostname(value); }

const PHONE_ASSIGNMENTS_FILE = path.join(config.projectRoot, '.ultron', 'lead-enrichment', 'pending-phone-assignments.json');
const backgroundPhoneAssignments = new Map();
let backgroundPhoneWatcher = null;
let backgroundPhoneWatcherRemaining = 0;
let backgroundPhoneAssignmentsLoaded = false;

function persistBackgroundPhoneAssignments() {
  try {
    fs.mkdirSync(path.dirname(PHONE_ASSIGNMENTS_FILE), { recursive: true });
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      assignments: [...backgroundPhoneAssignments.entries()].map(([key, value]) => ({ key, ...value })),
    };
    fs.writeFileSync(PHONE_ASSIGNMENTS_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
    try { fs.chmodSync(PHONE_ASSIGNMENTS_FILE, 0o600); } catch {}
  } catch {}
}

function loadBackgroundPhoneAssignments() {
  if (backgroundPhoneAssignmentsLoaded) return backgroundPhoneAssignments.size;
  backgroundPhoneAssignmentsLoaded = true;
  try {
    if (!fs.existsSync(PHONE_ASSIGNMENTS_FILE)) return 0;
    const parsed = JSON.parse(fs.readFileSync(PHONE_ASSIGNMENTS_FILE, 'utf8'));
    for (const item of Array.isArray(parsed?.assignments) ? parsed.assignments : []) {
      if (!item?.spreadsheetId || !item?.sheetName || !Number.isInteger(Number(item?.rowNumber)) || !Number.isInteger(Number(item?.columnIndex)) || !item?.apolloPersonId) continue;
      const { key: _ignored, ...value } = item;
      const key = `${item.spreadsheetId}|${item.sheetName}|${Number(item.rowNumber)}|${Number(item.columnIndex)}`;
      // Latest persisted owner for a cell wins. Old person-id-qualified keys are
      // deliberately collapsed so one phone cell cannot accumulate callbacks.
      backgroundPhoneAssignments.set(key, value);
    }
  } catch {}
  return backgroundPhoneAssignments.size;
}
function linkedinSlug(value) {
  const normalized = apollo.normalizeLinkedIn(value);
  if (!normalized) return '';
  try { return decodeURIComponent(new URL(normalized).pathname.match(/^\/in\/([^/]+)/i)?.[1] || '').trim(); } catch { return ''; }
}

function schemaLinkedInColumns(schema) {
  const indexes = new Set();
  for (const column of schema.columns || []) {
    if (/^linkedin(?:_|$)/.test(column.role) || /\blinkedin\b/i.test(column.header || '')) indexes.add(column.index);
  }
  return [...indexes].sort((a, b) => a - b);
}

async function patchRichLinkedInLinks(spreadsheetId, sheetName, rows, schema) {
  for (const columnIndex of schemaLinkedInColumns(schema)) {
    const links = await sheets.linkedInHyperlinks(spreadsheetId, sheetName, columnIndex, Math.max(rows.length, schema.headerRowNumber));
    for (const [rowNumber, link] of links.entries()) {
      const rowIndex = rowNumber - 1;
      if (!rows[rowIndex]) rows[rowIndex] = [];
      rows[rowIndex][columnIndex] = link;
    }
  }
  return rows;
}

async function readUniversalSheet(sheetUrl, options = {}) {
  const spreadsheetId = sheets.spreadsheetId(sheetUrl);
  const meta = await sheets.metadata(spreadsheetId);
  const requestedName = text(options.sheetName);
  const tabs = (meta.sheets || []).map((sheet) => ({ name: sheet?.properties?.title, sheetId: sheet?.properties?.sheetId })).filter((sheet) => sheet.name);
  const targets = requestedName ? tabs.filter((tab) => tab.name === requestedName) : tabs;
  if (!targets.length) {
    const error = new Error(requestedName ? `Google Sheet tab not found: ${requestedName}` : 'Spreadsheet has no readable tabs.');
    error.code = 'UNIVERSAL_SHEET_TAB_NOT_FOUND';
    throw error;
  }

  let best = null;
  for (const tab of targets) {
    const rows = await sheets.values(spreadsheetId, `${sheets.quoteSheet(tab.name)}!A:ZZ`);
    let schema;
    try { schema = schemaTools.inferSchema(rows, options.schema || {}); }
    catch (error) { if (requestedName) throw error; else continue; }
    const candidate = { spreadsheetId, spreadsheetTitle: meta?.properties?.title || '', sheetName: tab.name, sheetId: tab.sheetId, rows, schema };
    if (!best || schema.confidence > best.schema.confidence) best = candidate;
  }
  if (!best) {
    const error = new Error('No worksheet has a reliable enrichment schema.');
    error.code = 'UNIVERSAL_SCHEMA_NOT_FOUND';
    throw error;
  }
  await patchRichLinkedInLinks(best.spreadsheetId, best.sheetName, best.rows, best.schema);
  best.schema = schemaTools.inferSchema(best.rows, options.schema || {});
  return best;
}


const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com','googlemail.com','yahoo.com','yahoo.co.in','outlook.com','hotmail.com','live.com',
  'icloud.com','me.com','proton.me','protonmail.com','aol.com','rediffmail.com',
]);

function cleanedCompanyEvidence(value) {
  return text(value)
    .replace(/^[\s:–—-]+|[\s:–—-]+$/g, '')
    .replace(/\s+(?:\||•).*$/s, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function contextEvidenceText(plan = {}) {
  return Object.values(plan?.context || {})
    .filter((value) => typeof value === 'string' && text(value))
    .join('\n');
}

function firstBusinessEmailDomain(value) {
  const matches = String(value || '').match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/ig) || [];
  for (let i = matches.length - 1; i >= 0; i--) {
    const domain = websiteDomain(String(matches[i]).split('@').pop() || '');
    if (domain && !FREE_EMAIL_DOMAINS.has(domain)) return domain;
  }
  return '';
}

function inferHiringCompanyFromEvidence(plan, row = []) {
  const evidence = contextEvidenceText(plan);
  if (!evidence) return null;

  const patterns = [
    { source: 'row-join-company', confidence: 0.98, regex: /\bjoin\s+([A-Z][A-Za-z0-9&.'’()\- ]{2,100}?)\s+as\b/i },
    { source: 'row-company-is-hiring', confidence: 0.97, regex: /(?:^|\n)\s*([A-Z][A-Za-z0-9&.'’()\- ]{2,100}?)\s+(?:is|are)\s+(?:looking|hiring|seeking)\b/i },
    { source: 'row-headline-employer', confidence: 0.96, regex: /\b(?:founder|co[- ]?founder|owner|director|business director|managing director|manager|recruiter|talent acquisition specialist|talent acquisition lead|human resources manager|hr recruiter)\s+(?:at|@)\s+([^\n|•]{2,100})/i },
    { source: 'row-with-company', confidence: 0.94, regex: /(?:^|\n)\s*with\s+([^\n|•]{2,100}?)(?:\s*•|\s*$)/im },
  ];

  for (const rule of patterns) {
    const match = evidence.match(rule.regex);
    const company = cleanedCompanyEvidence(match?.[1] || '');
    if (!company) continue;
    return {
      company,
      domain: '',
      source: rule.source,
      evidenceConfidence: rule.confidence,
      anchorLinkedin: text(plan?.anchor?.snapshot?.values?.linkedin),
      anchorApolloPersonId: '',
      anchorPerson: null,
    };
  }

  const domain = firstBusinessEmailDomain(evidence);
  if (domain) {
    const brand = domain
      .split('.')[0]
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      company: brand || domain,
      domain,
      companyAliases: [...new Set([brand, domain].filter(Boolean))],
      source: 'row-business-email-domain',
      evidenceConfidence: 0.93,
      anchorLinkedin: text(plan?.anchor?.snapshot?.values?.linkedin),
      anchorApolloPersonId: '',
      anchorPerson: null,
    };
  }

  return null;
}

function preferredHiringCompanyContext(plan, row, anchorContext = null) {
  return inferHiringCompanyFromEvidence(plan, row) || anchorContext;
}

function anchorNameTokens(value) {
  return ranker.normalize(value || '')
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter((token) => token.length >= 3);
}

function emailLocalPartMatchesAnchor(email, name) {
  const local = text(email).split('@')[0]?.toLowerCase().replace(/[^a-z0-9]+/g, ' ') || '';
  if (!local) return false;
  if (/^(?:hr|careers?|jobs?|hiring|hello|info|contact|admin|support|recruitment|recruiter|talent|people)$/i.test(local.replace(/\s+/g, ''))) return false;
  const compact = local.replace(/\s+/g, '');
  const tokens = anchorNameTokens(name);
  if (!tokens.length) return false;
  const matched = tokens.filter((token) => compact.includes(token));
  if (matched.length >= 2) return true;
  if (matched.length === 1 && matched[0].length >= 5) return true;
  return matched.length === 1 && matched[0].length >= 4 && compact === matched[0];
}

function extractAnchorContactEvidence(plan = {}) {
  const anchor = plan?.anchor;
  if (!anchor || anchor.type !== 'person') return { email: '', phone: '', source: '' };
  const name = text(anchor.snapshot?.values?.name);
  const evidence = contextEvidenceText(plan);
  if (!name || !evidence) return { email: '', phone: '', source: '' };

  const emailMatches = [...evidence.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig)]
    .map((match) => ({ value: text(match[0]), index: Number(match.index || 0) }))
    .filter((item) => apollo.validEmail(item.value) && emailLocalPartMatchesAnchor(item.value, name));

  if (!emailMatches.length) return { email: '', phone: '', source: '' };

  const email = emailMatches[0];
  const left = Math.max(0, email.index - 140);
  const right = Math.min(evidence.length, email.index + email.value.length + 140);
  const nearby = evidence.slice(left, right);
  const phoneMatches = [...nearby.matchAll(/\+?\d[\d\s().-]{5,20}\d/g)]
    .map((match) => text(match[0]))
    .filter((value) => {
      const digits = value.replace(/\D/g, '');
      return digits.length >= 7 && digits.length <= 15 && Boolean(apollo.validPhone(value));
    });

  return {
    email: email.value,
    phone: phoneMatches[0] || '',
    source: 'row-author-contact-evidence',
  };
}

function anchorNeedsHydration(plan = {}, evidence = {}) {
  const anchor = plan?.anchor;
  if (!anchor || anchor.type !== 'person') return false;
  const values = anchor.snapshot?.values || {};
  const fields = anchor.group?.fields || {};
  if (fields.phone && !text(values.phone) && !text(evidence.phone)) return true;
  if (fields.email && !text(values.email) && !text(evidence.email)) return true;
  if (fields.role && !text(values.role)) return true;
  return false;
}

function companyFromCompanyAnchor(anchor) {
  const values = anchor?.snapshot?.values || {};
  const company = text(values.company || values.name);
  const domain = websiteDomain(values.website || '');
  return company ? {
    company,
    domain,
    source: values.linkedin ? 'sheet-company-linkedin' : 'sheet-company',
    anchorLinkedin: values.linkedin || '',
    anchorApolloPersonId: '',
    anchorPerson: null,
  } : null;
}

function nearestCompanyIdentity(plan) {
  const values = plan.anchor?.snapshot?.values || {};
  if (values.company) return text(values.company);
  for (const item of plan.groups?.existing || []) {
    const company = text(item.snapshot?.values?.company);
    if (company) return company;
  }
  return text(plan.context?.company || '');
}

async function resolvePersonAnchor(plan, row, options = {}) {
  const anchor = plan.anchor;
  if (!anchor || anchor.type !== 'person') return null;
  const values = anchor.snapshot?.values || {};
  const group = anchor.group;
  const completeContacts = options.completeContacts !== false;
  const contactEvidence = options.contactEvidence || {};
  const needEmail = completeContacts && Boolean(group.fields.email && !values.email && !text(contactEvidence.email));
  const needPhone = completeContacts && Boolean(group.fields.phone && !values.phone && !text(contactEvidence.phone));
  const normalizedLinkedin = apollo.normalizeLinkedIn(values.linkedin || '');
  let profile = null;
  let company = '';
  let domain = '';
  let source = '';

  if (normalizedLinkedin) {
    try { profile = await apollo.resolvePersonProfile(normalizedLinkedin, { needEmail, needPhone }); } catch {}
    company = text(profile?.organizationName || profile?.organization?.name);
    domain = websiteDomain(profile?.organizationDomain || profile?.organization?.website_url || profile?.organization?.primary_domain || '');
    source = company ? 'apollo-exact-person' : '';

    if (!company && options.allowLinkedInEmployerFallback !== false) {
      const slug = linkedinSlug(normalizedLinkedin);
      if (slug) {
        try {
          const raw = await linkedinMcp.callTool('get_person_profile', {
            linkedin_username: slug,
            sections: 'experience',
            max_scrolls: integer(options.linkedinMaxScrolls, 3, 1, 6),
          });
          const employer = profileParser.resolveCurrentEmployer(raw);
          if (employer.resolved) {
            company = employer.company;
            source = employer.source;
            profile = { ...(profile || {}), title: profile?.title || employer.title, organizationName: company, linkedinEmployerConfidence: employer.confidence };
          }
        } catch {}
      }
    }
  } else if (values.name) {
    const explicitCompany = nearestCompanyIdentity(plan);
    if (explicitCompany) {
      try {
        profile = await apollo.resolvePersonByNameCompany(values.name, explicitCompany, '', { needEmail, needPhone });
      } catch {}
      if (profile && !profile.noMatch && !profile.ambiguous && profile.identityVerified !== false) {
        company = text(profile.organizationName || profile.organization?.name || explicitCompany);
        domain = websiteDomain(profile.organizationDomain || profile.organization?.website_url || profile.organization?.primary_domain || '');
        source = 'apollo-name-company';
      }
    }
  }

  const exactEvidencePerson = (text(contactEvidence.email) || text(contactEvidence.phone))
    ? {
        name: values.name || profile?.name || '',
        linkedinUrl: normalizedLinkedin || profile?.linkedinUrl || '',
        email: text(profile?.email) || text(contactEvidence.email),
        phone: text(profile?.phone) || text(contactEvidence.phone),
        phoneStatus: text(profile?.phone) || text(contactEvidence.phone) ? 'found' : profile?.phoneStatus,
        identityVerified: true,
        apolloPersonId: text(profile?.apolloPersonId || profile?.id),
      }
    : null;

  if (!company) return {
    unresolved: true,
    anchorProfile: profile,
    anchorPerson: profile && profile.noMatch !== true && profile.ambiguous !== true && profile.identityVerified !== false
      ? {
          ...profile,
          email: text(profile.email) || text(contactEvidence.email),
          phone: text(profile.phone) || text(contactEvidence.phone),
          phoneStatus: text(profile.phone) || text(contactEvidence.phone) ? 'found' : profile.phoneStatus,
          linkedinUrl: normalizedLinkedin || profile.linkedinUrl || '',
          identityVerified: true,
        }
      : exactEvidencePerson,
    anchorLinkedin: normalizedLinkedin || '',
  };
  return {
    company,
    domain,
    source,
    anchorLinkedin: normalizedLinkedin || apollo.normalizeLinkedIn(profile?.linkedinUrl || ''),
    anchorApolloPersonId: text(profile?.apolloPersonId || profile?.id),
    anchorPerson: profile
      ? {
          ...profile,
          email: text(profile.email) || text(contactEvidence.email),
          phone: text(profile.phone) || text(contactEvidence.phone),
          phoneStatus: text(profile.phone) || text(contactEvidence.phone) ? 'found' : profile.phoneStatus,
          linkedinUrl: normalizedLinkedin || profile.linkedinUrl || '',
          identityVerified: profile?.ambiguous !== true && profile?.noMatch !== true && profile?.identityVerified !== false,
        }
      : exactEvidencePerson,
  };
}

function existingIdentityKeys(plan) {
  const names = new Set();
  const linkedins = new Set();
  for (const item of plan.groups?.existing || []) {
    const name = ranker.normalize(String(item.snapshot?.values?.name || '').replace(/\s+[—–-]\s+.*$/, ''));
    const linkedin = ranker.linkedinKey(item.snapshot?.values?.linkedin || '');
    if (name) names.add(name);
    if (linkedin) linkedins.add(linkedin);
  }
  return { names, linkedins };
}

function candidateAlreadyPresent(candidate, existing) {
  const name = ranker.normalize(candidate?.name || '');
  const linkedin = ranker.linkedinKey(candidate?.linkedinUrl || candidate?.linkedin_url || '');
  return Boolean((name && existing.names.has(name)) || (linkedin && existing.linkedins.has(linkedin)));
}

function needsEmbeddedDesignationRepair(item) {
  if (!item || item.isAnchor) return false;
  const name = text(item.snapshot?.values?.name);
  return Boolean(
    item.snapshot?.hasIdentity
    && name
    && planner.shouldEmbedRoleInName(item.group)
    && !planner.hasEmbeddedDesignation(name)
  );
}

function candidateFillTargets(plan) {
  const targets = new Map();
  for (const item of plan.groups?.open || []) {
    if (!item.isAnchor) targets.set(item.group.id, item);
  }
  for (const item of plan.groups?.partial || []) {
    if (orphanPolicy.isOrphanContactTarget(item)) targets.set(item.group.id, item);
  }
  return [...targets.values()].sort((a, b) => (a.group.ordinal || 999) - (b.group.ordinal || 999));
}

function queuePendingPhone(options, rowNumber, group, snapshot, person) {
  const queue = options?.pendingPhoneQueue;
  if (!Array.isArray(queue) || !Number.isInteger(rowNumber) || !group?.fields?.phone) return;
  if (text(snapshot?.values?.phone)) return;

  const apolloPersonId = text(person?.apolloPersonId || person?.id);
  const phoneStatus = text(person?.phoneStatus);
  const phoneWaterfallRequestId = text(person?.phoneWaterfallRequestId);
  const isNativePending = phoneStatus === 'pending';
  const isWaterfallPending = phoneStatus === 'waterfall_pending' && Boolean(phoneWaterfallRequestId);
  if (!apolloPersonId || text(person?.phone) || (!isNativePending && !isWaterfallPending)) return;

  const key = `${rowNumber}|${group.fields.phone.index}`;
  const item = {
    key,
    rowNumber,
    columnIndex: group.fields.phone.index,
    groupId: group.id,
    apolloPersonId,
    personName: text(person?.name),
    phoneMode: isWaterfallPending ? 'waterfall' : 'webhook',
    phoneWaterfallRequestId: isWaterfallPending ? phoneWaterfallRequestId : '',
  };
  const existingIndex = queue.findIndex((entry) => entry.key === key);
  if (existingIndex >= 0) queue[existingIndex] = item;
  else queue.push(item);
}

function phoneSyncPolls(options = {}) {
  const raw = Number(options.phoneSyncPolls ?? process.env.ULTRON_M3_APOLLO_PHONE_SYNC_POLLS ?? 8);
  return Number.isFinite(raw) ? Math.max(1, Math.min(10, Math.floor(raw))) : 8;
}

function phoneSyncWaitMs(options = {}) {
  const raw = Number(options.phoneSyncWaitMs ?? process.env.ULTRON_M3_APOLLO_PHONE_SYNC_WAIT_MS ?? 1800);
  return Number.isFinite(raw) ? Math.max(250, Math.min(5000, Math.floor(raw))) : 1800;
}


function backgroundPhoneKey(source, item) {
  return `${source.spreadsheetId}|${source.sheetName}|${item.rowNumber}|${item.columnIndex}`;
}

function registerBackgroundPhoneAssignments(source, items = []) {
  for (const item of items) {
    if (!item?.apolloPersonId) continue;
    const key = backgroundPhoneKey(source, item);
    backgroundPhoneAssignments.set(key, {
      ...item,
      spreadsheetId: source.spreadsheetId,
      sheetName: source.sheetName,
      registeredAt: new Date().toISOString(),
    });
  }
  persistBackgroundPhoneAssignments();
  return backgroundPhoneAssignments.size;
}

async function syncBackgroundPhoneAssignments() {
  loadBackgroundPhoneAssignments();
  if (!backgroundPhoneAssignments.size) return { resolved: 0, written: 0, pending: 0 };

  const items = [...backgroundPhoneAssignments.entries()];
  const webhookItems = items.filter(([, item]) => item.phoneMode !== 'waterfall');
  let nativeResults = [];
  if (webhookItems.length) {
    try { nativeResults = await apollo.fetchPhoneResults(); } catch {}
  }

  const byId = new Map();
  for (const result of Array.isArray(nativeResults) ? nativeResults : []) {
    const id = text(result?.apollo_person_id);
    if (id) byId.set(id, result);
  }

  let resolved = 0;
  let written = 0;
  const handledIds = new Set();

  for (const [key, item] of items) {
    let phone = null;
    let terminal = false;

    if (item.phoneMode === 'waterfall' && item.phoneWaterfallRequestId) {
      try {
        const quality = require('./apollo-three-poc-quality');
        const polled = await quality.pollPhoneRequest(item.phoneWaterfallRequestId, { polls: 0 });
        phone = apollo.validPhone(polled?.phone);
        terminal = ['found', 'not_found', 'terminal', 'unavailable'].includes(text(polled?.state));
        quality.recordPhoneWaterfallOutcome?.({ apolloPersonId: item.apolloPersonId }, polled);
      } catch (error) {
        item.lastError = text(error?.message || error).slice(0, 300);
        item.lastAttemptAt = new Date().toISOString();
        backgroundPhoneAssignments.set(key, item);
        continue;
      }
    } else {
      const result = byId.get(item.apolloPersonId);
      if (!result) continue;
      phone = apollo.validPhone(result?.phone);
      apollo.recordPhoneResult(item.apolloPersonId, phone);
      handledIds.add(item.apolloPersonId);
      terminal = true;
    }

    if (!terminal) continue;

    try {
      const range = sheets.cellRange(item.sheetName, item.rowNumber, item.columnIndex);
      const current = await sheets.readCell(item.spreadsheetId, range);
      if (phone && sheets.isBlank(current)) {
        await sheets.writeCells(item.spreadsheetId, [{ range, value: phone }]);
        written++;
      }
      backgroundPhoneAssignments.delete(key);
      resolved++;
    } catch (error) {
      item.lastError = text(error?.message || error).slice(0, 300);
      item.lastAttemptAt = new Date().toISOString();
      backgroundPhoneAssignments.set(key, item);
    }
  }

  for (const id of handledIds) {
    const stillPendingForId = [...backgroundPhoneAssignments.values()]
      .some((item) => item.phoneMode !== 'waterfall' && item.apolloPersonId === id);
    if (!stillPendingForId) {
      try { await apollo.consumePhoneResult(id); } catch {}
    }
  }

  persistBackgroundPhoneAssignments();
  return { resolved, written, pending: backgroundPhoneAssignments.size };
}

function startBackgroundPhoneWatcher() {
  loadBackgroundPhoneAssignments();
  if (backgroundPhoneWatcher || !backgroundPhoneAssignments.size) return;
  backgroundPhoneWatcherRemaining = Math.max(
    1,
    Math.min(60, Number(process.env.ULTRON_M3_APOLLO_PHONE_WATCHER_ATTEMPTS || 30)),
  );

  const tick = async () => {
    backgroundPhoneWatcher = null;
    if (!backgroundPhoneAssignments.size || backgroundPhoneWatcherRemaining-- <= 0) return;
    try { await syncBackgroundPhoneAssignments(); } catch {}
    if (backgroundPhoneAssignments.size && backgroundPhoneWatcherRemaining > 0) {
      const delay = Math.max(
        5000,
        Math.min(120000, Number(process.env.ULTRON_M3_APOLLO_PHONE_WATCHER_INTERVAL_MS || 45000)),
      );
      backgroundPhoneWatcher = setTimeout(tick, delay);
      backgroundPhoneWatcher.unref?.();
    }
  };

  const firstDelay = Math.max(
    1000,
    Math.min(60000, Number(process.env.ULTRON_M3_APOLLO_PHONE_WATCHER_FIRST_MS || 15000)),
  );
  backgroundPhoneWatcher = setTimeout(tick, firstDelay);
  backgroundPhoneWatcher.unref?.();
}

function backgroundPhoneStatus() {
  return {
    pending: backgroundPhoneAssignments.size,
    watcherActive: Boolean(backgroundPhoneWatcher),
    attemptsRemaining: backgroundPhoneWatcherRemaining,
  };
}

async function syncPendingPhoneAssignments(source, queue = [], stats, options = {}) {
  const pending = Array.isArray(queue) ? queue.filter((item) => item?.apolloPersonId) : [];
  stats.pendingPhoneRequests = pending.length;
  if (!pending.length) return;

  const waterfallPending = pending.filter((item) => item.phoneMode === 'waterfall' && item.phoneWaterfallRequestId);
  const nativePending = pending.filter((item) => item.phoneMode !== 'waterfall');

  // Poll all waterfall request IDs concurrently after row processing. This avoids
  // serial per-person waiting while still giving Apollo one bounded same-run
  // chance to return numbers before requests move to the background watcher.
  const unresolvedWaterfall = [];
  if (waterfallPending.length) {
    const quality = require('./apollo-three-poc-quality');
    const syncPollsRaw = Number(options.phoneWaterfallSyncPolls ?? process.env.ULTRON_M3_THREE_POC_PHONE_WATERFALL_SYNC_POLLS ?? 1);
    const syncPolls = Number.isFinite(syncPollsRaw) ? Math.max(0, Math.min(3, Math.floor(syncPollsRaw))) : 1;

    const outcomes = await Promise.allSettled(
      waterfallPending.map(async (item) => ({
        item,
        result: await quality.pollPhoneRequest(item.phoneWaterfallRequestId, { polls: syncPolls }),
      }))
    );

    const waterfallChanges = [];
    for (const outcome of outcomes) {
      if (outcome.status !== 'fulfilled') {
        const failedItem = waterfallPending[outcomes.indexOf(outcome)];
        if (failedItem) unresolvedWaterfall.push(failedItem);
        continue;
      }

      const { item, result } = outcome.value;
      const state = text(result?.state);
      const phone = apollo.validPhone(result?.phone);
      quality.recordPhoneWaterfallOutcome?.({ apolloPersonId: item.apolloPersonId }, result);
      if (phone) {
        const range = sheets.cellRange(source.sheetName, item.rowNumber, item.columnIndex);
        let current = '';
        try { current = await sheets.readCell(source.spreadsheetId, range); } catch {}
        if (sheets.isBlank(current)) {
          waterfallChanges.push({ range, value: phone, rowNumber: item.rowNumber });
        } else {
          stats.phoneWriteSkippedPopulated++;
        }
      } else if (['not_found', 'terminal'].includes(state)) {
        stats.phoneNotFound++;
      } else {
        unresolvedWaterfall.push(item);
      }
    }

    if (waterfallChanges.length) {
      await sheets.writeCells(source.spreadsheetId, waterfallChanges);
      stats.phoneCellsFilled += waterfallChanges.length;
      stats.cellsChanged += waterfallChanges.length;
      stats.phoneRowsChanged += new Set(waterfallChanges.map((change) => change.rowNumber)).size;
    }

    stats.phoneWaterfallPendingAssignments = unresolvedWaterfall.length;
    if (unresolvedWaterfall.length && options.backgroundPhoneWatcher !== false) {
      registerBackgroundPhoneAssignments(source, unresolvedWaterfall);
      startBackgroundPhoneWatcher();
      stats.backgroundPhoneWatcher = true;
    }
  }

  if (!nativePending.length) {
    stats.phoneStillPending = unresolvedWaterfall.length;
    stats.backgroundPhonePending = backgroundPhoneAssignments.size;
    return;
  }

  const unresolved = new Map(nativePending.map((item) => [item.key, item]));
  const handledProviderIds = new Set();
  const polls = phoneSyncPolls(options);
  const waitMs = phoneSyncWaitMs(options);

  for (let attempt = 0; attempt < polls && unresolved.size; attempt++) {
    if (attempt > 0) await sleep(waitMs);
    let results = [];
    try {
      results = await apollo.fetchPhoneResults();
      stats.phoneSyncPolls++;
    } catch (error) {
      stats.phoneSyncErrors++;
      stats.phoneSyncLastError = typedFailureSummary(error, { stage: 'apollo-phone-result-sync' });
      break;
    }
    if (!Array.isArray(results) || !results.length) continue;

    const byId = new Map();
    for (const result of results) {
      const id = text(result?.apollo_person_id);
      if (id) byId.set(id, result);
    }

    const changes = [];
    const resolvedKeys = [];
    for (const [key, item] of unresolved.entries()) {
      const result = byId.get(item.apolloPersonId);
      if (!result) continue;
      const phone = apollo.validPhone(result?.phone);
      apollo.recordPhoneResult(item.apolloPersonId, phone);
      handledProviderIds.add(item.apolloPersonId);
      if (!phone) {
        resolvedKeys.push(key);
        stats.phoneNotFound++;
        continue;
      }

      const range = sheets.cellRange(source.sheetName, item.rowNumber, item.columnIndex);
      let current = '';
      try { current = await sheets.readCell(source.spreadsheetId, range); } catch {}
      if (!sheets.isBlank(current)) {
        resolvedKeys.push(key);
        stats.phoneWriteSkippedPopulated++;
        continue;
      }
      changes.push({ range, value: phone, rowNumber: item.rowNumber });
      resolvedKeys.push(key);
    }

    if (changes.length) {
      await sheets.writeCells(source.spreadsheetId, changes);
      stats.phoneCellsFilled += changes.length;
      stats.cellsChanged += changes.length;
      const phoneRows = new Set(changes.map((change) => change.rowNumber));
      stats.phoneRowsChanged += phoneRows.size;
    }
    for (const key of resolvedKeys) unresolved.delete(key);
  }

  for (const apolloPersonId of handledProviderIds) {
    try { await apollo.consumePhoneResult(apolloPersonId); } catch {}
  }
  stats.phoneStillPending = unresolved.size + unresolvedWaterfall.length;
  if (unresolved.size && options.backgroundPhoneWatcher !== false) {
    registerBackgroundPhoneAssignments(source, [...unresolved.values()]);
    startBackgroundPhoneWatcher();
    stats.backgroundPhoneWatcher = true;
  }
  stats.backgroundPhonePending = backgroundPhoneAssignments.size;
}

function existingPersonVerificationContext(item, fallbackContext = {}) {
  const snapshot = item?.snapshot || {};
  const emailDomain = firstBusinessEmailDomain(snapshot?.values?.email || '');
  if (emailDomain) {
    return {
      ...fallbackContext,
      company: fallbackContext?.company || emailDomain,
      domain: emailDomain,
      source: 'existing-poc-business-email-domain',
    };
  }
  return fallbackContext;
}


function existingContactSearchName(value) {
  return text(value)
    .replace(/\s+[—–]\s+.*$/, '')
    .replace(/\s*\([^)]{2,120}\)\s*$/, '')
    .trim();
}

function existingContactRole(value) {
  const raw = text(value);
  const dash = raw.match(/\s+[—–]\s+(.+)$/);
  if (dash?.[1]) return text(dash[1]);
  const paren = raw.match(/\(([^)]{2,120})\)\s*$/);
  return text(paren?.[1] || '');
}

function roleEvidenceMatches(expectedRole, actualRole) {
  const expected = ranker.normalize(expectedRole || '');
  const actual = ranker.normalize(actualRole || '');
  if (!expected) return false;
  if (!actual) return false;
  if (expected === actual || expected.includes(actual) || actual.includes(expected)) return true;
  const stop = new Set(['the','of','and','at','for','a','an','senior','sr','junior','jr','associate']);
  const tokens = (value) => new Set(value.split(/\s+/).filter((token) => token.length >= 3 && !stop.has(token)));
  const left = tokens(expected);
  const right = tokens(actual);
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap++;
  return overlap >= 1 && overlap / Math.max(1, Math.min(left.size, right.size)) >= 0.34;
}

function existingIdentityVerified(snapshot, person, companyContext, verificationPath = '') {
  if (!person || person.noMatch || person.ambiguous || person.identityVerified === false) return false;
  if (!planner.samePerson(snapshot?.values || {}, person)) return false;

  // Existing sheet identity is user-owned evidence. For CONTACT COMPLETION we
  // need to verify the exact human, not rediscover who they should have been.
  // Exact LinkedIn and exact business-email matches are authoritative.
  if (verificationPath === 'exact-linkedin' || verificationPath === 'apollo-business-email') return true;

  // Same-employer remains strong evidence when available.
  if (ranker.sameEmployer(person, companyContext)) return true;

  // POC-2/3 often have no LinkedIn column. Their embedded designation is the
  // second identity factor. Exact name + compatible role is sufficient to fill
  // only missing phone/email fields; it never authorizes replacing the identity.
  const expectedRole = existingContactRole(snapshot?.values?.name || '');
  return roleEvidenceMatches(expectedRole, person?.title || person?.headline || '');
}

async function repairExistingContactFromPublicIndex(item, companyContext, stats, options = {}) {
  if (!publicIndexFallbackEnabled(options)) return null;
  const snapshot = item?.snapshot || {};
  const name = existingContactSearchName(snapshot?.values?.name || '');
  const role = existingContactRole(snapshot?.values?.name || '');
  const company = text(companyContext?.company || companyContext?.domain || '').replace(/"/g, '').trim();
  if (!name) return null;

  const safeName = name.replace(/"/g, '');
  const safeRole = role.replace(/"/g, '');
  const queries = [
    ...(company ? [
      `site:linkedin.com/in "${safeName}" "${company}"`,
      `site:linkedin.com/in "${safeName}" ${company}`,
    ] : []),
    ...(safeRole ? [`site:linkedin.com/in "${safeName}" "${safeRole}"`] : []),
    `site:linkedin.com/in "${safeName}"`,
  ];
  const refs = new Map();
  const addItems = (items, provider) => {
    for (const raw of Array.isArray(items) ? items : []) {
      const record = publicIndexRecord(raw, options.location || '');
      if (!record?.linkedin) continue;
      if (planner.normalizeName(record.name || '') !== planner.normalizeName(name)) continue;
      if (!refs.has(record.linkedin)) refs.set(record.linkedin, { ...record, publicIndexProvider: provider });
    }
  };

  if (leadSources.status()?.serpApiConfigured) {
    for (const query of queries) {
      if (refs.size >= 4) break;
      try {
        const result = await leadSources.serpSearch(query, { limit: 10, timeoutMs: 15000 });
        stats.existingPublicIndexSearches = Number(stats.existingPublicIndexSearches || 0) + 1;
        addItems(result?.results, 'serpapi-google');
      } catch (error) {
        stats.publicIndexFailures = Number(stats.publicIndexFailures || 0) + 1;
      }
    }
  }

  if (!refs.size && web.status()?.configured) {
    for (const query of queries) {
      if (refs.size >= 4) break;
      try {
        const result = await web.searchWeb(query, { limit: 10, timeoutMs: 12000 });
        stats.existingPublicIndexSearches = Number(stats.existingPublicIndexSearches || 0) + 1;
        addItems(result?.results, 'tinyfish-search');
      } catch (error) {
        stats.publicIndexFailures = Number(stats.publicIndexFailures || 0) + 1;
      }
    }
  }

  const needEmail = Boolean(item?.group?.fields?.email && !snapshot?.values?.email);
  const needPhone = Boolean(item?.group?.fields?.phone && !snapshot?.values?.phone);
  for (const record of [...refs.values()].slice(0, 4)) {
    try {
      stats.existingPublicIndexVerificationAttempts = Number(stats.existingPublicIndexVerificationAttempts || 0) + 1;
      const person = await apollo.resolvePersonProfile(record.linkedin, {
        needEmail,
        needPhone,
        force: true,
      });
      if (!existingIdentityVerified(snapshot, person, companyContext, 'public-index-exact')) continue;
      stats.existingPublicIndexVerified = Number(stats.existingPublicIndexVerified || 0) + 1;
      return person;
    } catch {}
  }
  return null;
}

async function repairExistingGroups(row, plan, companyContext, stats, options = {}) {
  const writes = [];
  const targets = new Map();
  const targetOrdinals = Array.isArray(options.targetOrdinals)
    ? new Set(options.targetOrdinals.map((value) => Number(value)).filter(Number.isFinite))
    : null;
  const allowed = (item) => !targetOrdinals || targetOrdinals.has(Number(item?.group?.ordinal || 0));
  for (const item of plan.groups?.partial || []) if (!item.isAnchor && allowed(item)) targets.set(item.group.id, item);
  for (const item of plan.groups?.existing || []) {
    if (allowed(item) && needsEmbeddedDesignationRepair(item)) targets.set(item.group.id, item);
  }

  for (const item of targets.values()) {
    const group = item.group;
    const snapshot = item.snapshot;
    if (!snapshot.hasIdentity) continue;
    const needEmail = Boolean(group.fields.email && !snapshot.values.email);
    const needPhone = Boolean(group.fields.phone && !snapshot.values.phone);
    const verificationContext = existingPersonVerificationContext(item, companyContext);
    let resolved = null;
    let verificationPath = '';
    let verificationError = null;
    stats.existingVerificationAttempts++;

    try {
      if (snapshot.linkedinKind === 'linkedin_person') {
        verificationPath = 'exact-linkedin';
        resolved = await apollo.resolvePersonProfile(snapshot.values.linkedin, { needEmail, needPhone });
      } else if (snapshot.values.email && firstBusinessEmailDomain(snapshot.values.email)) {
        verificationPath = 'apollo-business-email';
        resolved = await apollo.resolvePersonByBusinessEmail(
          snapshot.values.email,
          verificationContext.company,
          verificationContext.domain,
          { needEmail: true, needPhone },
        );
      } else if (snapshot.values.name && (verificationContext.company || verificationContext.domain)) {
        verificationPath = 'apollo-name-company';
        resolved = await apollo.resolvePersonByNameCompany(
          existingContactSearchName(snapshot.values.name),
          verificationContext.company,
          verificationContext.domain,
          { needEmail, needPhone },
        );
      }
    } catch (error) {
      verificationError = error;
      resolved = null;
    }

    const directVerified = existingIdentityVerified(
      snapshot,
      resolved,
      verificationContext,
      verificationPath,
    );

    if (!directVerified) {
      const publicResolved = await repairExistingContactFromPublicIndex(
        item,
        verificationContext,
        stats,
        options,
      );
      if (publicResolved) {
        resolved = publicResolved;
        verificationPath = verificationPath
          ? `${verificationPath}->public-index-exact`
          : 'public-index-exact';
      } else {
        stats.existingVerificationFailures++;
        stats.existingRepairAudit.push({
          rowNumber: options.rowNumber || null,
          groupId: group.id,
          name: snapshot.values.name || '',
          path: verificationPath || 'unresolved',
          status: verificationError ? 'verification-error' : 'identity-or-employer-not-verified',
          ...(verificationError ? {
            code: String(verificationError?.code || 'APOLLO_EXISTING_CONTACT_VERIFY_FAILED'),
            message: String(verificationError?.message || verificationError || '').slice(0, 240),
          } : {}),
        });
        continue;
      }
    }

    queuePendingPhone(options, Number(options.rowNumber), group, snapshot, resolved);
    const planWrite = planner.safeWritesForGroup(row, group, resolved, { allowRoleNormalization: Boolean(options.allowRoleNormalization) });
    if (!planWrite.allowed) {
      stats.identityConflicts++;
      stats.existingRepairAudit.push({
        rowNumber: options.rowNumber || null,
        groupId: group.id,
        name: snapshot.values.name || '',
        path: verificationPath,
        status: 'identity-conflict',
      });
      continue;
    }

    writes.push(...planWrite.writes);
    stats.embeddedDesignationWrites += planWrite.writes.filter((write) => write.embeddedRole).length;
    if (planWrite.writes.length) stats.existingGroupsRepaired++;
    stats.existingRepairAudit.push({
      rowNumber: options.rowNumber || null,
      groupId: group.id,
      name: snapshot.values.name || '',
      path: verificationPath,
      status: planWrite.writes.length ? 'repaired' : (needPhone && resolved.phoneStatus === 'pending' ? 'phone-pending' : 'verified-no-new-data'),
      fields: planWrite.writes.map((write) => write.field),
    });
  }
  return writes;
}

async function enrichAnchorGroup(row, plan, companyContext, stats, options = {}) {
  if (plan.anchor?.type !== 'person' || !companyContext.anchorPerson) return [];
  queuePendingPhone(options, Number(options.rowNumber), plan.anchor.group, plan.anchor.snapshot, companyContext.anchorPerson);
  const writePlan = planner.safeWritesForGroup(row, plan.anchor.group, companyContext.anchorPerson);
  if (!writePlan.allowed) { stats.identityConflicts++; return []; }
  stats.anchorFieldsFilled += writePlan.writes.length;
  stats.embeddedDesignationWrites += writePlan.writes.filter((write) => write.embeddedRole).length;
  return writePlan.writes;
}

function candidateDiscoveryKey(candidate = {}) {
  return String(
    candidate.apolloPersonId
    || candidate.id
    || candidate.linkedinUrl
    || candidate.linkedin_url
    || `${ranker.normalize(candidate.name || '')}|${ranker.normalize(candidate.title || '')}`
  ).trim().toLowerCase();
}

function mergeCandidatePools(...pools) {
  const out = [];
  const seen = new Set();
  for (const pool of pools) {
    for (const candidate of Array.isArray(pool) ? pool : []) {
      const key = candidateDiscoveryKey(candidate);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
    }
  }
  return out;
}

function companyPriorityTitles() {
  return (apollo.COMPANY_DECISION_PRIORITY || [])
    .flatMap((tier) => Array.isArray(tier?.titles) ? tier.titles : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function companyPriorityCandidate(candidate = {}) {
  return Number(apollo.decisionPriority(candidate.title || candidate.headline || '')) < 99;
}

async function discoverCompanyPeople(companyContext, cache, stats, options = {}) {
  const key = `${ranker.companyKey(companyContext.company)}|${ranker.hostname(companyContext.domain)}|${ranker.normalize(options.location || '')}`;
  if (cache.has(key)) { stats.candidateCacheHits++; return cache.get(key); }

  const broadResult = await apollo.searchCompanyPeopleBroad({
    company: companyContext.company,
    domain: companyContext.domain,
    location: options.location || '',
    limit: integer(options.candidateLimit, 100, 10, 100),
    titles: [],
  });
  stats.candidateSearches++;
  stats.candidateBroadSearches++;
  const broadPeople = Array.isArray(broadResult?.people) ? broadResult.people : [];

  // Broad discovery remains first and authoritative. If it happens to return an
  // employee slice with too few useful decision-maker/recruiting contacts, run
  // one cheap title-targeted discovery pass before spending hydration credits.
  const minimumPriorityPool = integer(options.minimumPriorityPool, 6, 2, 20);
  const broadPriorityCount = broadPeople.filter(companyPriorityCandidate).length;
  let targetedPeople = [];
  if (broadPriorityCount < minimumPriorityPool) {
    try {
      const targetedResult = await apollo.searchCompanyPeopleBroad({
        company: companyContext.company,
        domain: companyContext.domain,
        location: options.location || '',
        limit: integer(options.priorityCandidateLimit, 50, 10, 100),
        titles: companyPriorityTitles(),
      });
      stats.candidateSearches++;
      stats.candidatePrioritySearches++;
      targetedPeople = Array.isArray(targetedResult?.people) ? targetedResult.people : [];
    } catch (error) {
      // Supplemental discovery must not erase a successful broad search. Keep the
      // row usable and expose the diagnostic in stats.
      stats.candidatePrioritySearchFailures++;
      stats.discoveryDiagnostics.push({
        company: companyContext.company,
        code: String(error?.code || 'APOLLO_PRIORITY_SEARCH_FAILED'),
        message: String(error?.message || error || '').slice(0, 300),
      });
    }
  }

  const people = mergeCandidatePools(broadPeople, targetedPeople);
  stats.candidatesDiscovered += people.length;
  cache.set(key, people);
  return people;
}

function rowCompanyMetadata(plan) {
  const values = plan.anchor?.snapshot?.values || {};
  return {
    companyHeadcount: Number(values.companyHeadcount || 0) || 0,
    location: plan.context?.location || values.location || '',
  };
}


function companyBrandFromDomain(value) {
  const host = websiteDomain(value);
  if (!host) return '';
  const label = host.split('.')[0] || '';
  return label.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function collectLinkedInPersonUrls(value, out = new Set()) {
  if (value == null) return out;
  if (typeof value === 'string') {
    const raw = value;
    for (const match of raw.matchAll(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9%._~-]+\/?/gi)) {
      const normalized = apollo.normalizeLinkedIn(match[0]);
      if (normalized) out.add(normalized);
    }
    for (const match of raw.matchAll(/(?:^|[\s"'(])\/in\/([A-Za-z0-9%._~-]+)\/?/gi)) {
      const normalized = apollo.normalizeLinkedIn(`https://www.linkedin.com/in/${match[1]}`);
      if (normalized) out.add(normalized);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLinkedInPersonUrls(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectLinkedInPersonUrls(item, out);
  }
  return out;
}


function collectLinkedInCompanySlugs(value, out = new Set()) {
  if (value == null) return out;
  if (typeof value === 'string') {
    const raw = value;
    for (const match of raw.matchAll(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/company\/([A-Za-z0-9._~-]+)\/?/gi)) {
      const slug = text(match[1]).toLowerCase();
      if (slug && !['search','feed','jobs'].includes(slug)) out.add(slug);
    }
    for (const match of raw.matchAll(/(?:^|[\s"'(])\/company\/([A-Za-z0-9._~-]+)\/?/gi)) {
      const slug = text(match[1]).toLowerCase();
      if (slug && !['search','feed','jobs'].includes(slug)) out.add(slug);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLinkedInCompanySlugs(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectLinkedInCompanySlugs(item, out);
  }
  return out;
}

function collectLinkedInCompanyUrns(value, out = new Set()) {
  if (value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectLinkedInCompanyUrns(item, out);
    return out;
  }
  if (typeof value === 'object') {
    if (
      text(value.kind).toLowerCase() === 'company_urn'
      && /^\d+$/.test(text(value.value))
    ) {
      out.add(text(value.value));
    }
    for (const item of Object.values(value)) collectLinkedInCompanyUrns(item, out);
  }
  return out;
}

function companySlugCandidates(companyContext = {}) {
  const out = new Set();
  const company = text(companyContext?.company).toLowerCase();
  const normalizedCompany = company
    .replace(/&/g, ' ')
    .replace(/\b(?:private|pvt|limited|ltd|llp|inc|corporation|corp)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  if (normalizedCompany) out.add(normalizedCompany);

  const brand = companyBrandFromDomain(companyContext?.domain || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  if (brand) out.add(brand);
  return [...out].slice(0, 2);
}

function flattenStructuredText(value, out = [], seen = new WeakSet(), depth = 0) {
  if (value == null || depth > 8) return out;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const item = text(value);
    if (item) out.push(item);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenStructuredText(item, out, seen, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return out;
    seen.add(value);
    for (const item of Object.values(value)) flattenStructuredText(item, out, seen, depth + 1);
  }
  return out;
}

function linkedinCompanyProfileMatches(profile, companyContext = {}) {
  if (!profile) return false;
  const expectedCompany = text(companyContext?.company || '');
  const expectedKey = ranker.companyKey(expectedCompany);
  const domain = websiteDomain(companyContext?.domain || '');
  const brand = companyBrandFromDomain(domain);

  // Strongest evidence first: an actual company URL/slug returned inside the
  // fetched profile must match one of the verified employer-derived slug forms.
  const expectedSlugs = new Set(companySlugCandidates(companyContext));
  const returnedSlugs = collectLinkedInCompanySlugs(profile);
  if ([...returnedSlugs].some((slug) => expectedSlugs.has(text(slug).toLowerCase()))) return true;

  // Common direct name fields from MCP/package variants.
  const directNames = [
    profile?.name,
    profile?.company_name,
    profile?.companyName,
    profile?.organization_name,
    profile?.organizationName,
    profile?.title,
    profile?.sections?.main_profile?.name,
    profile?.sections?.main_profile?.company_name,
    profile?.sections?.about?.name,
  ].map(text).filter(Boolean);
  for (const candidate of directNames) {
    if (expectedCompany && apollo.sameOrganization({ organization_name: candidate }, expectedCompany, domain)) return true;
    if (brand && apollo.sameOrganization({ organization_name: candidate }, brand, domain)) return true;
  }

  // Structured MCP sections are objects/arrays, not guaranteed strings.
  // Flatten their scalar content instead of coercing them to "[object Object]".
  const haystack = ranker.normalize(flattenStructuredText(profile).join(' '));
  if (expectedKey && haystack.includes(expectedKey)) return true;
  if (domain && haystack.includes(domain)) return true;
  const brandKey = ranker.companyKey(brand);
  return Boolean(brandKey && haystack.includes(brandKey));
}

async function verifyLinkedInCompanyEmployee(linkedinUrl, companyContext, stats) {
  const slug = linkedinSlug(linkedinUrl);
  if (!slug) return null;
  let profile = null;
  try {
    profile = await linkedinMcp.callTool('get_person_profile', {
      linkedin_username: slug,
      sections: 'experience',
      max_scrolls: 3,
    });
    stats.linkedinFallbackProfileVerifications = Number(stats.linkedinFallbackProfileVerifications || 0) + 1;
  } catch (error) {
    stats.linkedinFallbackFailures = Number(stats.linkedinFallbackFailures || 0) + 1;
    stats.discoveryDiagnostics.push({
      company: companyContext?.company || companyContext?.domain || '',
      code: String(error?.code || 'LINKEDIN_FALLBACK_PROFILE_VERIFY_FAILED'),
      message: String(error?.message || error || '').slice(0, 300),
    });
    return null;
  }

  const employer = profileParser.resolveCurrentEmployer(profile);
  if (!employer?.resolved || !employer.company) return null;
  if (!apollo.sameOrganization(
    { organization_name: employer.company },
    companyContext?.company || '',
    companyContext?.domain || '',
  )) return null;

  let person = null;
  try {
    person = await apollo.resolvePersonProfile(linkedinUrl, { needEmail: false, needPhone: false });
  } catch {}
  if (!person || person.noMatch || person.ambiguous || person.identityVerified === false) return null;

  return {
    id: text(person.apolloPersonId || person.id) || null,
    apolloPersonId: text(person.apolloPersonId || person.id) || null,
    name: text(person.name),
    title: text(person.title || employer.title),
    headline: text(person.headline),
    linkedinUrl,
    organizationName: text(employer.company),
    organizationDomain: websiteDomain(companyContext?.domain || person.organizationDomain || ''),
    seniority: text(person.seniority),
    departments: Array.isArray(person.departments) ? person.departments : [],
    functions: Array.isArray(person.functions) ? person.functions : [],
    linkedinFallback: true,
    linkedinEmployerVerified: true,
    linkedinEmployerCompany: text(employer.company),
    linkedinEmployerSource: text(employer.source),
  };
}

function linkedinZeroResultFallbackEnabled(options = {}) {
  if (options.linkedinZeroResultFallback === false) return false;
  return !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_UNIVERSAL_LINKEDIN_ZERO_RESULT_FALLBACK ?? '1').trim());
}

function linkedinSafetyCapError(error) {
  const code = text(error?.code).toUpperCase();
  const message = text(error?.message).toUpperCase();
  return /LINKEDIN_(?:DAILY|HOURLY)_CAP|LINKEDIN_SAFETY_CAP/.test(code)
    || /DAILY SAFETY CAP|HOURLY SAFETY CAP|SAFETY CAP REACHED/.test(message);
}

async function discoverLinkedInFallbackPeople(companyContext, stats, options = {}) {
  if (!linkedinZeroResultFallbackEnabled(options)) return [];
  const company = text(companyContext?.company);
  const domain = websiteDomain(companyContext?.domain || '');
  const brand = company && !company.includes('.') ? company : companyBrandFromDomain(domain || company);
  const queryBrand = cleanedCompanyEvidence(brand || company || domain);
  if (!queryBrand) return [];

  const personUrls = new Set();
  const rowNumber = options.rowNumber !== null && options.rowNumber !== undefined && options.rowNumber !== ''
    && Number.isInteger(Number(options.rowNumber))
    ? Number(options.rowNumber)
    : null;
  const pushLinkedInDiagnostic = (payload = {}) => {
    stats.discoveryDiagnostics.push({
      ...payload,
      ...(rowNumber != null ? { rowNumber, groupOrdinal: 2 } : {}),
    });
  };

  // Deep sparse-company path:
  // company search -> exact/derived slug -> verified company profile -> company URN
  // -> current_company people search -> employee page. Generic people search is last.
  let slugs = [];
  try {
    const companySearch = await linkedinMcp.callTool('search_companies', { keywords: queryBrand });
    stats.linkedinFallbackCompanySearches = Number(stats.linkedinFallbackCompanySearches || 0) + 1;
    slugs = [...collectLinkedInCompanySlugs(companySearch)].slice(0, 2);
  } catch (error) {
    stats.linkedinFallbackFailures = Number(stats.linkedinFallbackFailures || 0) + 1;
    pushLinkedInDiagnostic({
      company: queryBrand,
      code: String(error?.code || 'LINKEDIN_COMPANY_SEARCH_FAILED'),
      message: String(error?.message || error || '').slice(0, 300),
    });
    if (linkedinSafetyCapError(error)) throw error;
  }

  if (!slugs.length) slugs = companySlugCandidates(companyContext);

  for (const slug of slugs.slice(0, 2)) {
    if (personUrls.size >= 8) break;
    let companyProfile = null;
    try {
      companyProfile = await linkedinMcp.callTool('get_company_profile', { company_name: slug });
      stats.linkedinFallbackCompanyProfiles = Number(stats.linkedinFallbackCompanyProfiles || 0) + 1;
    } catch (error) {
      stats.linkedinFallbackFailures = Number(stats.linkedinFallbackFailures || 0) + 1;
      pushLinkedInDiagnostic({
        company: queryBrand,
        code: String(error?.code || 'LINKEDIN_COMPANY_PROFILE_FAILED'),
        message: String(error?.message || error || '').slice(0, 300),
      });
      if (linkedinSafetyCapError(error)) throw error;
    }

    const profileVerified = companyProfile && linkedinCompanyProfileMatches(companyProfile, companyContext);
    if (companyProfile && !profileVerified) {
      pushLinkedInDiagnostic({
        company: queryBrand,
        code: 'LINKEDIN_DERIVED_COMPANY_SLUG_MISMATCH',
        message: `LinkedIn company profile for slug ${slug} did not match the verified row employer.`,
      });
      continue;
    }

    if (profileVerified) {
      const urns = [...collectLinkedInCompanyUrns(companyProfile)].slice(0, 1);
      stats.linkedinFallbackCompanyUrns = Number(stats.linkedinFallbackCompanyUrns || 0) + urns.length;
      for (const urn of urns) {
        if (personUrls.size >= 8) break;
        try {
          const constrained = await linkedinMcp.callTool('search_people', {
            keywords: 'recruiter talent acquisition human resources HR founder director owner manager',
            current_company: urn,
            ...(options.location ? { location: String(options.location) } : {}),
          });
          stats.linkedinFallbackCurrentCompanySearches = Number(stats.linkedinFallbackCurrentCompanySearches || 0) + 1;
          collectLinkedInPersonUrls(constrained, personUrls);
        } catch (error) {
          stats.linkedinFallbackFailures = Number(stats.linkedinFallbackFailures || 0) + 1;
          pushLinkedInDiagnostic({
            company: queryBrand,
            code: String(error?.code || 'LINKEDIN_CURRENT_COMPANY_SEARCH_FAILED'),
            message: String(error?.message || error || '').slice(0, 300),
          });
          if (linkedinSafetyCapError(error)) throw error;
        }
      }
    }

    try {
      const employees = await linkedinMcp.callTool('get_company_employees', {
        company_name: slug,
        keywords: 'recruiter talent acquisition human resources HR founder director owner manager',
      });
      stats.linkedinFallbackEmployeeSearches = Number(stats.linkedinFallbackEmployeeSearches || 0) + 1;
      collectLinkedInPersonUrls(employees, personUrls);

      if (!personUrls.size) {
        const allEmployees = await linkedinMcp.callTool('get_company_employees', { company_name: slug });
        stats.linkedinFallbackEmployeeSearches = Number(stats.linkedinFallbackEmployeeSearches || 0) + 1;
        collectLinkedInPersonUrls(allEmployees, personUrls);
      }
    } catch (error) {
      stats.linkedinFallbackFailures = Number(stats.linkedinFallbackFailures || 0) + 1;
      pushLinkedInDiagnostic({
        company: queryBrand,
        code: String(error?.code || 'LINKEDIN_COMPANY_EMPLOYEE_SEARCH_FAILED'),
        message: String(error?.message || error || '').slice(0, 300),
      });
      if (linkedinSafetyCapError(error)) throw error;
    }
  }

  // Fallback when LinkedIn does not expose a company slug/people page.
  if (!personUrls.size) {
    const queries = [
      `${queryBrand} recruiter`,
      `${queryBrand} talent acquisition human resources`,
      `${queryBrand} founder director owner manager`,
    ];
    for (const keywords of queries) {
      if (personUrls.size >= 8) break;
      try {
        const result = await linkedinMcp.callTool('search_people', {
          keywords,
          ...(options.location ? { location: String(options.location) } : {}),
        });
        stats.linkedinFallbackSearches = Number(stats.linkedinFallbackSearches || 0) + 1;
        collectLinkedInPersonUrls(result, personUrls);
      } catch (error) {
        stats.linkedinFallbackFailures = Number(stats.linkedinFallbackFailures || 0) + 1;
        pushLinkedInDiagnostic({
          company: queryBrand,
          code: String(error?.code || 'LINKEDIN_ZERO_RESULT_SEARCH_FAILED'),
          message: String(error?.message || error || '').slice(0, 300),
        });
        if (linkedinSafetyCapError(error)) throw error;
      }
    }
  }

  const urls = [...personUrls];
  stats.linkedinFallbackProfilesFound = Number(stats.linkedinFallbackProfilesFound || 0) + urls.length;
  if (!urls.length) return [];

  const limit = integer(
    options.linkedinFallbackVerifyLimit ?? process.env.ULTRON_M3_UNIVERSAL_LINKEDIN_FALLBACK_VERIFY_LIMIT,
    5,
    1,
    8,
  );

  const verified = [];
  for (const linkedinUrl of urls.slice(0, limit)) {
    const candidate = await verifyLinkedInCompanyEmployee(linkedinUrl, companyContext, stats);
    if (!candidate?.id || !candidate?.title) continue;
    verified.push(candidate);
  }

  stats.linkedinFallbackVerifiedCandidates = Number(stats.linkedinFallbackVerifiedCandidates || 0) + verified.length;
  return verified;
}


function publicIndexFallbackEnabled(options = {}) {
  if (options.publicIndexFallback === false) return false;
  return !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_UNIVERSAL_PUBLIC_INDEX_FALLBACK ?? '1').trim());
}

function publicIndexQueries(companyContext = {}) {
  const company = text(companyContext?.company || companyContext?.domain || '').replace(/"/g, '').trim();
  if (!company) return [];
  return [
    `site:linkedin.com/in "${company}" recruiter`,
    `site:linkedin.com/in "${company}" "talent acquisition"`,
    `site:linkedin.com/in "${company}" "human resources" OR HR`,
    `site:linkedin.com/in "${company}" founder OR owner OR director OR manager`,
  ];
}

function publicIndexRecord(item, location = '') {
  const parsed = linkedinPublic.parseResult({
    title: item?.title || '',
    snippet: item?.snippet || item?.description || '',
    url: item?.url || item?.link || '',
  }, { entityMode: 'person', location });
  if (!parsed?.linkedin) return null;
  return parsed;
}

async function verifyPublicIndexPerson(record, companyContext, stats) {
  const linkedinUrl = apollo.normalizeLinkedIn(record?.linkedin || record?.url || '');
  if (!linkedinUrl) return null;
  stats.publicIndexApolloVerificationAttempts = Number(stats.publicIndexApolloVerificationAttempts || 0) + 1;

  let person = null;
  try {
    person = await apollo.resolvePersonProfile(linkedinUrl, {
      needEmail: false,
      needPhone: false,
      force: true,
    });
  } catch (error) {
    stats.publicIndexFailures = Number(stats.publicIndexFailures || 0) + 1;
    stats.discoveryDiagnostics.push({
      company: companyContext?.company || companyContext?.domain || '',
      code: String(error?.code || 'PUBLIC_INDEX_APOLLO_VERIFY_FAILED'),
      subsystem: 'APOLLO',
      type: String(error?.errorType || 'API'),
      stage: 'public-index-apollo-verification',
      message: String(error?.message || error || '').slice(0, 300),
    });
    return null;
  }

  if (!person || person.noMatch || person.ambiguous || person.identityVerified === false) return null;
  if (!apollo.sameOrganization(
    person,
    companyContext?.company || '',
    companyContext?.domain || '',
  )) return null;

  const apolloPersonId = text(person.apolloPersonId || person.id);
  const title = text(person.title || record?.role);
  if (!apolloPersonId || !title) return null;

  return {
    id: apolloPersonId,
    apolloPersonId,
    name: text(person.name || record?.name),
    title,
    headline: text(person.headline || record?.snippet),
    linkedinUrl,
    organizationName: text(person.organizationName || person.organization?.name || companyContext?.company),
    organizationDomain: websiteDomain(
      person.organizationDomain
      || person.organization?.primary_domain
      || person.organization?.domain
      || companyContext?.domain
      || ''
    ),
    seniority: text(person.seniority),
    departments: Array.isArray(person.departments) ? person.departments : [],
    functions: Array.isArray(person.functions) ? person.functions : [],
    publicIndexCandidate: true,
    publicIndexApolloVerified: true,
  };
}

async function discoverPublicIndexPeople(companyContext, stats, options = {}) {
  if (!publicIndexFallbackEnabled(options)) return [];
  const queries = publicIndexQueries(companyContext);
  if (!queries.length) return [];

  const refs = new Map();
  const addItems = (items, provider) => {
    for (const item of Array.isArray(items) ? items : []) {
      const record = publicIndexRecord(item, options.location || '');
      if (!record?.linkedin) continue;
      if (!refs.has(record.linkedin)) refs.set(record.linkedin, { ...record, publicIndexProvider: provider });
    }
  };

  const serpReady = Boolean(leadSources.status()?.serpApiConfigured);
  if (serpReady) {
    for (const query of queries) {
      if (refs.size >= 12) break;
      try {
        const result = await leadSources.serpSearch(query, { limit: 10, timeoutMs: 15000 });
        stats.publicIndexSearchCalls = Number(stats.publicIndexSearchCalls || 0) + 1;
        addItems(result?.results, 'serpapi-google');
      } catch (error) {
        stats.publicIndexFailures = Number(stats.publicIndexFailures || 0) + 1;
        stats.discoveryDiagnostics.push({
          company: companyContext?.company || companyContext?.domain || '',
          code: String(error?.code || 'SERP_PUBLIC_LINKEDIN_SEARCH_FAILED'),
          subsystem: 'SERPAPI',
          type: String(error?.errorType || 'API'),
          stage: 'public-linkedin-index-search',
          message: String(error?.message || error || '').slice(0, 300),
        });
      }
    }
  }

  if (!refs.size && web.status()?.configured) {
    for (const query of queries.slice(0, 3)) {
      if (refs.size >= 12) break;
      try {
        const result = await web.searchWeb(query, { limit: 10, timeoutMs: 12000 });
        stats.publicIndexSearchCalls = Number(stats.publicIndexSearchCalls || 0) + 1;
        addItems(result?.results, 'tinyfish-search');
      } catch (error) {
        stats.publicIndexFailures = Number(stats.publicIndexFailures || 0) + 1;
        stats.discoveryDiagnostics.push({
          company: companyContext?.company || companyContext?.domain || '',
          code: String(error?.code || 'TINYFISH_PUBLIC_LINKEDIN_SEARCH_FAILED'),
          subsystem: 'TINYFISH',
          type: String(error?.errorType || 'API'),
          stage: 'public-linkedin-index-search',
          message: String(error?.message || error || '').slice(0, 300),
        });
      }
    }
  }

  const records = [...refs.values()].slice(0, integer(
    options.publicIndexVerifyLimit ?? process.env.ULTRON_M3_UNIVERSAL_PUBLIC_INDEX_VERIFY_LIMIT,
    8,
    1,
    12,
  ));
  stats.publicIndexProfilesFound = Number(stats.publicIndexProfilesFound || 0) + records.length;
  if (!records.length) return [];

  const verified = [];
  for (const record of records) {
    const candidate = await verifyPublicIndexPerson(record, companyContext, stats);
    if (!candidate) continue;
    verified.push(candidate);
  }
  stats.publicIndexApolloVerifiedCandidates = Number(stats.publicIndexApolloVerifiedCandidates || 0) + verified.length;
  return verified;
}

async function hydrateDecisionMakerVerified(candidate, companyContext, stats, options = {}) {
  const needEmail = options.needEmail !== false;
  const needPhone = options.needPhone !== false;
  try {
    return await apollo.resolveDecisionMaker(
      candidate,
      companyContext?.company || '',
      companyContext?.domain || '',
      { needEmail, needPhone },
    );
  } catch (error) {
    if (String(error?.code || '') !== 'APOLLO_COMPANY_MISMATCH_AFTER_HYDRATION') throw error;

    stats.linkedinHydrationRecoveryAttempts = Number(stats.linkedinHydrationRecoveryAttempts || 0) + 1;
    const linkedinUrl = apollo.normalizeLinkedIn(
      error?.hydratedLinkedIn
      || candidate?.linkedinUrl
      || candidate?.linkedin_url
      || ''
    );
    if (!linkedinUrl) {
      stats.linkedinHydrationRecoveryFailures = Number(stats.linkedinHydrationRecoveryFailures || 0) + 1;
      throw error;
    }

    const verified = await verifyLinkedInCompanyEmployee(linkedinUrl, companyContext, stats);
    if (!verified?.linkedinEmployerVerified) {
      stats.linkedinHydrationRecoveryFailures = Number(stats.linkedinHydrationRecoveryFailures || 0) + 1;
      throw error;
    }

    const candidateId = text(candidate?.id || candidate?.apolloPersonId);
    const verifiedId = text(verified?.id || verified?.apolloPersonId);
    if (candidateId && verifiedId && candidateId !== verifiedId) {
      stats.linkedinHydrationRecoveryFailures = Number(stats.linkedinHydrationRecoveryFailures || 0) + 1;
      const mismatch = new Error('LINKEDIN_VERIFIED_CANDIDATE_ID_MISMATCH');
      mismatch.code = 'LINKEDIN_VERIFIED_CANDIDATE_ID_MISMATCH';
      throw mismatch;
    }

    const retryCandidate = {
      ...candidate,
      ...verified,
      id: candidateId || verifiedId || candidate?.id,
      apolloPersonId: candidateId || verifiedId || candidate?.apolloPersonId,
      linkedinUrl,
      linkedinEmployerVerified: true,
    };

    const person = await apollo.resolveDecisionMaker(
      retryCandidate,
      companyContext?.company || '',
      companyContext?.domain || '',
      { needEmail, needPhone },
    );

    // LinkedIn current-employer verification is authoritative for employer
    // identity in this recovery branch. Keep Apollo's contact fields, but do not
    // let stale Apollo organization metadata make the caller reject the same
    // verified candidate a second time.
    const verifiedCompany = text(verified.organizationName || companyContext?.company || '');
    const verifiedDomain = websiteDomain(
      verified.organizationDomain
      || companyContext?.domain
      || ''
    );
    const recovered = {
      ...person,
      organizationName: verifiedCompany || person.organizationName,
      organizationDomain: verifiedDomain || person.organizationDomain,
      organization: {
        ...(person.organization || {}),
        ...(verifiedCompany ? { name: verifiedCompany } : {}),
        ...(verifiedDomain ? { primary_domain: verifiedDomain } : {}),
      },
      linkedinEmployerVerified: true,
      linkedinEmployerCompany: verifiedCompany,
      linkedinEmployerSource: verified.linkedinEmployerSource || verified.linkedinEmployerVerified,
    };

    stats.linkedinHydrationRecoverySuccesses = Number(stats.linkedinHydrationRecoverySuccesses || 0) + 1;
    return recovered;
  }
}

async function discoverPriorityPeopleFast(companyContext, cache, stats, options = {}) {
  const company = text(companyContext?.company);
  const domain = websiteDomain(companyContext?.domain || '');
  const discoveryMode = options.primarySweep ? 'sweep' : 'deep';
  const key = `priority-fast-v3|${discoveryMode}|${ranker.companyKey(company)}|${domain}|${ranker.normalize(options.location || '')}`;
  if (cache.has(key)) {
    stats.candidateCacheHits++;
    return cache.get(key);
  }

  const merged = [];
  const add = (people) => {
    const combined = mergeCandidatePools(merged, people);
    merged.length = 0;
    merged.push(...combined);
  };
  const priorityLimit = integer(options.priorityCandidateLimit, 20, 6, 40);
  const broadLimit = integer(options.adaptiveBroadCandidateLimit, 30, 10, 50);

  // 1. Fast canonical title search against the strongest known organization identity.
  try {
    const priority = await apollo.searchCompanyPeopleBroad({
      company,
      domain,
      location: options.location || '',
      limit: priorityLimit,
      titles: companyPriorityTitles(),
    });
    stats.candidateSearches++;
    stats.candidatePrioritySearches++;
    add(Array.isArray(priority?.people) ? priority.people : []);
  } catch (error) {
    stats.candidatePrioritySearchFailures++;
    stats.discoveryDiagnostics.push({
      company: company || domain,
      code: String(error?.code || 'APOLLO_PRIORITY_FAST_SEARCH_FAILED'),
      message: String(error?.message || error || '').slice(0, 300),
    });
  }

  // Results-first primary sweep never cascades down a long waterfall on one row.
  // One targeted search is enough to decide whether this row proceeds now or is
  // queued for the post-sweep deterministic recheck.
  if (options.primarySweep) {
    stats.candidatesDiscovered += merged.length;
    if (merged.length) cache.set(key, merged);
    else cache.delete(key);
    return merged;
  }

  // 2. Deep leftover pass: if title-targeting produced nothing, do one bounded broad search.
  if (!merged.length) {
    try {
      const broad = await apollo.searchCompanyPeopleBroad({
        company,
        domain,
        location: options.location || '',
        limit: broadLimit,
        titles: [],
      });
      stats.candidateSearches++;
      stats.candidateBroadSearches++;
      add(Array.isArray(broad?.people) ? broad.people : []);
    } catch (error) {
      stats.discoveryDiagnostics.push({
        company: company || domain,
        code: String(error?.code || 'APOLLO_ADAPTIVE_BROAD_SEARCH_FAILED'),
        message: String(error?.message || error || '').slice(0, 300),
      });
    }
  }

  // 3. Apollo sometimes has the organization but not under the supplied domain.
  // Retry once by human-readable brand keyword rather than repeating the same
  // empty domain filter. Example: people-click.com -> "people click".
  if (!merged.length && domain) {
    const brand = companyBrandFromDomain(domain);
    if (brand && ranker.companyKey(brand) !== ranker.companyKey(company)) {
      try {
        const keyword = await apollo.searchCompanyPeopleBroad({
          company: brand,
          domain: '',
          location: options.location || '',
          limit: broadLimit,
          titles: [],
        });
        stats.candidateSearches++;
        stats.candidateBroadSearches++;
        add(Array.isArray(keyword?.people) ? keyword.people : []);
      } catch (error) {
        stats.discoveryDiagnostics.push({
          company: brand,
          code: String(error?.code || 'APOLLO_BRAND_KEYWORD_SEARCH_FAILED'),
          message: String(error?.message || error || '').slice(0, 300),
        });
      }
    }
  }

  // 4. If company itself is just a domain string, also retry its readable brand.
  if (!merged.length && company && websiteDomain(company) === company.toLowerCase()) {
    const brand = companyBrandFromDomain(company);
    if (brand) {
      try {
        const keyword = await apollo.searchCompanyPeopleBroad({
          company: brand,
          domain: '',
          location: options.location || '',
          limit: broadLimit,
          titles: companyPriorityTitles(),
        });
        stats.candidateSearches++;
        stats.candidatePrioritySearches++;
        add(Array.isArray(keyword?.people) ? keyword.people : []);
      } catch (error) {
        stats.candidatePrioritySearchFailures++;
        stats.discoveryDiagnostics.push({
          company: brand,
          code: String(error?.code || 'APOLLO_BRAND_PRIORITY_SEARCH_FAILED'),
          message: String(error?.message || error || '').slice(0, 300),
        });
      }
    }
  }

  // 5. Authenticated LinkedIn is useful but no longer a single point of failure.
  // A local/account safety stop is recorded, then public-index discovery may
  // continue without touching the authenticated LinkedIn session.
  if (!merged.length && linkedinZeroResultFallbackEnabled(options)) {
    try {
      const linkedinPeople = await discoverLinkedInFallbackPeople(companyContext, stats, options);
      add(linkedinPeople);
    } catch (error) {
      const typed = typedFailureSummary(error, { stage: error?.stage || 'authenticated-linkedin-discovery' });
      const alreadyRecorded = (stats.discoveryDiagnostics || []).some((item) =>
        text(item?.code).toUpperCase() === text(typed.code).toUpperCase()
        && Number(item?.rowNumber) === Number(options.rowNumber)
      );
      if (!alreadyRecorded) {
        stats.discoveryDiagnostics.push({
          rowNumber: options.rowNumber,
          groupOrdinal: 2,
          company: company || domain,
          code: typed.code,
          subsystem: typed.subsystem,
          type: typed.type,
          stage: typed.stage,
          message: typed.message,
          hint: typed.hint,
        });
      }
    }
  }

  // 6. Public-index emergency fallback. SerpApi is preferred; TinyFish is used
  // when configured and SerpApi yields no profile references. Every candidate
  // must still survive exact Apollo identity + employer verification.
  if (!merged.length && publicIndexFallbackEnabled(options)) {
    const publicPeople = await discoverPublicIndexPeople(companyContext, stats, options);
    add(publicPeople);
  }

  stats.candidatesDiscovered += merged.length;
  if (merged.length) cache.set(key, merged);
  else cache.delete(key);
  return merged;
}

function pragmaticSameEmployerCandidates(candidates = [], companyContext = {}, existing = { names: new Set(), linkedins: new Set() }) {
  const useful = /\b(?:founder|owner|director|head|manager|lead|leader|executive|partner|recruit|talent|human resources|\bhr\b|people|staff|staffing|placement|workforce|sourc|hiring)\b/i;
  const bad = /\b(?:intern|trainee|student|fresher|apprentice)\b/i;

  return (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => {
      if (!candidate || !ranker.sameEmployer(candidate, companyContext)) return false;
      if (candidateAlreadyPresent(candidate, existing)) return false;
      const role = `${candidate.title || ''} ${candidate.headline || ''}`;
      return useful.test(role) && !bad.test(role);
    })
    .map((candidate, index, pool) => {
      const priority = Number(apollo.decisionPriority(candidate.title || candidate.headline || ''));
      const scored = ranker.scoreCandidate(candidate, {
        company: companyContext.company,
        companyDomain: companyContext.domain,
      }, pool);
      return {
        candidate,
        priority: priority < 99 ? priority : 50,
        score: Number(scored?.score || 0),
      };
    })
    .sort((a, b) => a.priority - b.priority || b.score - a.score || String(a.candidate?.name || '').localeCompare(String(b.candidate?.name || '')))
    .map((item) => item.candidate);
}

function manualPriorityCandidates(candidates = [], companyContext = {}, existing = { names: new Set(), linkedins: new Set() }) {
  const rows = [];
  for (const candidate of candidates || []) {
    if (!candidate || !ranker.sameEmployer(candidate, companyContext)) continue;
    if (candidateAlreadyPresent(candidate, existing)) continue;
    const priority = Number(apollo.decisionPriority(candidate.title || candidate.headline || ''));
    if (priority >= 99) continue;
    const scored = ranker.scoreCandidate(candidate, {
      company: companyContext.company,
      companyDomain: companyContext.domain,
    }, candidates || []);
    rows.push({ candidate, priority, score: Number(scored?.score || 0) });
  }
  return rows
    .sort((a, b) => a.priority - b.priority || b.score - a.score || String(a.candidate?.name || '').localeCompare(String(b.candidate?.name || '')))
    .map((item) => item.candidate);
}

async function fillManualPriorityGroup(row, plan, companyContext, candidates, stats, options = {}) {
  const ordinal = Number(options.ordinal || 0);
  if (!ordinal) return { writes: [], filled: false, selected: null };
  const target = candidateFillTargets(plan).find((item) => Number(item.group?.ordinal || 0) === ordinal);
  if (!target) return { writes: [], filled: false, selected: null };

  const existing = existingIdentityKeys(plan);
  const claimed = options.claimed instanceof Set ? options.claimed : new Set();
  const priorityPool = manualPriorityCandidates(candidates, companyContext, existing)
    .filter((candidate) => {
      const key = candidateDiscoveryKey(candidate);
      return key && !claimed.has(key);
    });

  // If the canonical title ladder has no candidate, append the strongest
  // deterministic evidence-ranked candidates. This keeps functional hiring
  // authorities available without making the common path expensive.
  const fallbackRanking = ranker.rankCandidates(
    (candidates || []).filter((candidate) => !candidateAlreadyPresent(candidate, existing)),
    {
      ...plan.context,
      company: companyContext.company,
      companyDomain: companyContext.domain,
      anchorApolloPersonId: companyContext.anchorApolloPersonId,
      anchorLinkedin: companyContext.anchorLinkedin,
    },
    { minimumScore: Number(options.fallbackMinimumScore ?? 28) },
  ).ranked.map((item) => item.candidate);

  // Results-first final fallback: if the formal priority ladder/ranker is too
  // selective, keep useful same-company HR/talent/staffing/leadership contacts in
  // play. They still must survive exact Apollo hydration + employer verification.
  const pragmaticPool = pragmaticSameEmployerCandidates(candidates, companyContext, existing);

  const pool = mergeCandidatePools(priorityPool, fallbackRanking, pragmaticPool)
    .filter((candidate) => {
      const key = candidateDiscoveryKey(candidate);
      return key && !claimed.has(key);
    });

  const maxAttempts = integer(options.maxHydrationAttempts, ordinal === 2 ? 3 : 1, 1, 5);
  for (let attempt = 0; attempt < Math.min(maxAttempts, pool.length); attempt++) {
    const raw = pool[attempt];
    const rawKey = candidateDiscoveryKey(raw);
    stats.hydrationAttempts++;
    let person = null;
    try {
      person = await hydrateDecisionMakerVerified(raw, companyContext, stats, {
        needEmail: Boolean(target.group.fields.email),
        needPhone: Boolean(target.group.fields.phone),
      });
    } catch {
      stats.hydrationFailures++;
      claimed.add(rawKey);
      continue;
    }

    if (!person?.identityVerified || !person?.title || !ranker.sameEmployer(person, companyContext)) {
      stats.hydrationFailures++;
      claimed.add(rawKey);
      continue;
    }

    const hydratedName = ranker.normalize(person.name || '');
    const hydratedLinkedin = ranker.linkedinKey(person.linkedinUrl || person.returnedLinkedIn || '');
    if ((hydratedName && existing.names.has(hydratedName)) || (hydratedLinkedin && existing.linkedins.has(hydratedLinkedin))) {
      stats.postHydrationDuplicates++;
      claimed.add(rawKey);
      continue;
    }

    queuePendingPhone(options, Number(options.rowNumber), target.group, target.snapshot, person);
    const writePlan = planner.safeWritesForGroup(row, target.group, person);
    if (!writePlan.allowed || (!writePlan.writes.length && person.phoneStatus !== 'pending')) {
      stats.identityConflicts++;
      claimed.add(rawKey);
      continue;
    }

    claimed.add(rawKey);
    if (hydratedName) existing.names.add(hydratedName);
    if (hydratedLinkedin) existing.linkedins.add(hydratedLinkedin);
    stats.newPeopleSelected++;
    stats.embeddedDesignationWrites += writePlan.writes.filter((write) => write.embeddedRole).length;
    stats.selectionAudit.push({
      groupId: target.group.id,
      ordinal,
      strategy: 'manual-priority',
      priority: apollo.decisionPriority(person.title || raw.title || ''),
      apolloPersonId: text(person.apolloPersonId || person.id),
      name: person.name || '',
      title: person.title || '',
      fields: writePlan.writes.map((write) => write.field),
    });
    return { writes: writePlan.writes, filled: true, selected: person };
  }

  return { writes: [], filled: false, selected: null };
}

async function fillOpenGroups(row, plan, companyContext, candidates, stats, options = {}) {
  const allowedOrdinals = Array.isArray(options.targetOrdinals)
    ? new Set(options.targetOrdinals.map((value) => Number(value)).filter(Number.isFinite))
    : null;
  const targets = candidateFillTargets(plan).filter((target) =>
    !allowedOrdinals || allowedOrdinals.has(Number(target.group?.ordinal || 0))
  );
  if (!targets.length) return [];
  const existing = existingIdentityKeys(plan);
  const available = candidates.filter((candidate) => !candidateAlreadyPresent(candidate, existing));
  const context = {
    ...plan.context,
    ...rowCompanyMetadata(plan),
    company: companyContext.company,
    companyDomain: companyContext.domain,
    anchorApolloPersonId: companyContext.anchorApolloPersonId,
    anchorLinkedin: companyContext.anchorLinkedin,
  };
  const ranking = ranker.rankCandidates(available, context, { minimumScore: options.minimumScore });
  stats.candidatesRanked += ranking.ranked.length;
  stats.rankingThresholds.push(Number(ranking.threshold || 0));
  const writes = [];
  const claimed = new Set();
  const hydratedCache = new Map();

  for (const target of targets) {
    const orphanTarget = orphanPolicy.isOrphanContactTarget(target);
    if (orphanTarget) stats.orphanContactTargets++;
    let filled = false;

    for (const selection of ranking.ranked) {
      if (filled) break;
      const ordinal = Number(target.group?.ordinal || 0);
      const ordinalConfidence = ordinal === 2
        ? Number(options.poc2MinimumConfidence ?? options.minimumConfidence ?? 0.48)
        : ordinal >= 3
          ? Number(options.poc3MinimumConfidence ?? 0.66)
          : Number(options.minimumConfidence ?? 0.54);
      if (selection.confidence < ordinalConfidence) {
        stats.lowConfidenceCandidates++;
        continue;
      }

      const raw = selection.candidate;
      const rawKey = String(raw.apolloPersonId || raw.id || raw.linkedinUrl || raw.linkedin_url || '');
      if (!rawKey || claimed.has(rawKey)) continue;

      let person;
      if (hydratedCache.has(rawKey)) {
        person = hydratedCache.get(rawKey);
      } else {
        stats.hydrationAttempts++;
        try {
          person = await hydrateDecisionMakerVerified(raw, companyContext, stats, {
            needEmail: Boolean(target.group.fields.email),
            needPhone: Boolean(target.group.fields.phone),
          });
        } catch {
          person = null;
        }
        hydratedCache.set(rawKey, person || null);
        if (!person?.identityVerified || !person?.title || !ranker.sameEmployer(person, companyContext)) {
          stats.hydrationFailures++;
        }
      }

      if (!person?.identityVerified || !person?.title || !ranker.sameEmployer(person, companyContext)) continue;
      const hydratedName = ranker.normalize(person?.name || '');
      const hydratedLinkedin = ranker.linkedinKey(person?.linkedinUrl || person?.returnedLinkedIn || '');
      if ((hydratedName && existing.names.has(hydratedName)) || (hydratedLinkedin && existing.linkedins.has(hydratedLinkedin))) {
        stats.postHydrationDuplicates++;
        continue;
      }

      if (orphanTarget) {
        const contactProof = orphanPolicy.verify(target.snapshot, person);
        if (!contactProof.verified) {
          stats.orphanContactMismatches++;
          continue;
        }
        stats.orphanContactVerified++;
      }

      queuePendingPhone(options, Number(options.rowNumber), target.group, target.snapshot, person);
      const writePlan = planner.safeWritesForGroup(row, target.group, person);
      if (!writePlan.allowed || !writePlan.writes.length) {
        stats.identityConflicts++;
        continue;
      }

      writes.push(...writePlan.writes);
      stats.embeddedDesignationWrites += writePlan.writes.filter((write) => write.embeddedRole).length;
      if (hydratedName) existing.names.add(hydratedName);
      if (hydratedLinkedin) existing.linkedins.add(hydratedLinkedin);
      claimed.add(rawKey);
      stats.newPeopleSelected++;
      stats.selectionAudit.push({
        groupId: target.group.id,
        apolloPersonId: text(person.apolloPersonId || person.id),
        name: person.name || '',
        title: person.title || '',
        score: selection.score,
        confidence: selection.confidence,
        proof: [
          ...(selection.proof || []),
          ...(orphanTarget ? orphanPolicy.verify(target.snapshot, person).proof.map((proof) => `orphan-${proof}`) : []),
        ],
      });
      filled = true;
    }

    if (!filled) {
      stats.unfilledOpenGroups++;
      if (orphanTarget) stats.orphanContactBlocked++;
    }
  }
  return writes;
}

function toSheetChanges(sheetName, rowNumber, writes) {
  return (writes || []).map((write) => ({ range: sheets.cellRange(sheetName, rowNumber, write.columnIndex), value: write.value, field: write.field, groupId: write.groupId }));
}

async function applyRecoveredHeaderRepairs(source, stats) {
  const repairs = Array.isArray(source?.schema?.headerRepairs) ? source.schema.headerRepairs : [];
  stats.headerRepairsPlanned = repairs.length;
  if (!repairs.length) return [];

  const changes = [];
  for (const repair of repairs) {
    if (!Number.isInteger(repair?.columnIndex) || !Number.isInteger(repair?.rowNumber)) continue;
    const range = sheets.cellRange(source.sheetName, repair.rowNumber, repair.columnIndex);
    let current = '';
    try { current = await sheets.readCell(source.spreadsheetId, range); } catch (error) {
      error.stage = error.stage || 'schema-continuity-header-read';
      throw error;
    }
    if (!sheets.isBlank(current)) {
      stats.headerRepairsSkippedPopulated++;
      continue;
    }
    changes.push({ range, value: repair.value, rowNumber: repair.rowNumber, columnIndex: repair.columnIndex });
  }

  if (!changes.length) return [];
  try {
    await sheets.writeCells(source.spreadsheetId, changes);
  } catch (error) {
    error.stage = error.stage || 'schema-continuity-header-write';
    throw error;
  }

  for (const change of changes) {
    const rowIndex = change.rowNumber - 1;
    if (!source.rows[rowIndex]) source.rows[rowIndex] = [];
    source.rows[rowIndex][change.columnIndex] = change.value;
  }
  stats.headerRepairsWritten += changes.length;
  return changes;
}

function typedFailureSummary(error, context = {}) {
  const typed = typedErrors.normalize(error, context);
  return {
    code: typed.code,
    subsystem: typed.subsystem,
    type: typed.type,
    stage: typed.stage,
    message: typed.message,
    hint: typed.hint,
    status: typed.status,
    retryAttempts: typed.retryAttempts,
    attemptedRange: typed.attemptedRange || null,
  };
}

function isRecoverableRowFailure(typed = {}) {
  const subsystem = text(typed.subsystem).toUpperCase();
  const type = text(typed.type).toUpperCase();
  const code = text(typed.code).toUpperCase();

  // Google targeting/auth/write failures are workbook-level. Continuing would
  // either repeat a broken write path or risk misleading partial state.
  if (subsystem === 'GOOGLE_SHEETS' || subsystem === 'TARGETING' || subsystem === 'CONTROL_PLANE' || subsystem === 'SCHEMA') return false;

  // Apollo transport/auth/quota/config failures are provider-wide, not row-local.
  if (subsystem === 'APOLLO') {
    if (['AUTH', 'PERMISSION', 'RATE_LIMIT', 'NETWORK', 'CONFIG'].includes(type)) return false;
    if (/NOT_CONFIGURED|ACCESS_REQUIRED|AUTH_REQUIRED|RATE_LIMIT/.test(code)) return false;
    // Company/person-specific Apollo API misses/bad requests may safely leave the
    // current row unresolved while later rows continue.
    return true;
  }

  if (subsystem === 'LINKEDIN') {
    return !['AUTH', 'PERMISSION', 'RATE_LIMIT', 'NETWORK', 'CONFIG'].includes(type);
  }

  return ['NOT_FOUND', 'AMBIGUITY'].includes(type);
}

function isTransientProviderRowFailure(typed = {}) {
  const subsystem = text(typed.subsystem).toUpperCase();
  const type = text(typed.type).toUpperCase();
  const code = text(typed.code).toUpperCase();
  if (subsystem !== 'APOLLO') return false;
  if (['NETWORK', 'TIMEOUT'].includes(type)) return true;
  return /NETWORK|TIMEOUT|UNAVAILABLE|FETCH_FAILED/.test(code);
}

function formatFailureSummary(typed = {}) {
  return `[${typed.subsystem || 'UNIVERSAL'}/${typed.type || 'INTERNAL'}] ${typed.code || 'UNIVERSAL_INTERNAL_UNCLASSIFIED'} @ ${typed.stage || 'row-enrichment'}: ${typed.message || 'unknown failure'}`;
}

function freshStats() {
  return {
    rowsSeen: 0,
    rowsProcessed: 0,
    rowsWithoutAnchor: 0,
    rowsWithoutEmployer: 0,
    rowEvidenceEmployersResolved: 0,
    rowEvidenceContactEmails: 0,
    rowEvidenceContactPhones: 0,
    rowsChanged: 0,
    cellsChanged: 0,
    anchorsResolved: 0,
    anchorFieldsFilled: 0,
    candidateSearches: 0,
    candidateBroadSearches: 0,
    candidatePrioritySearches: 0,
    candidatePrioritySearchFailures: 0,
    candidateCacheHits: 0,
    candidatesDiscovered: 0,
    linkedinFallbackSearches: 0,
    linkedinFallbackCompanySearches: 0,
    linkedinFallbackCompanyProfiles: 0,
    linkedinFallbackCompanyUrns: 0,
    linkedinFallbackCurrentCompanySearches: 0,
    linkedinFallbackEmployeeSearches: 0,
    linkedinFallbackProfileVerifications: 0,
    linkedinFallbackFailures: 0,
    linkedinFallbackProfilesFound: 0,
    linkedinFallbackVerifiedCandidates: 0,
    publicIndexSearchCalls: 0,
    publicIndexProfilesFound: 0,
    publicIndexApolloVerificationAttempts: 0,
    publicIndexApolloVerifiedCandidates: 0,
    publicIndexFailures: 0,
    linkedinHydrationRecoveryAttempts: 0,
    linkedinHydrationRecoverySuccesses: 0,
    linkedinHydrationRecoveryFailures: 0,
    postHydrationDuplicates: 0,
    discoveryDiagnostics: [],
    pendingPhoneRequests: 0,
    resumedPhoneAssignments: 0,
    resumedPhoneResolved: 0,
    resumedPhoneCellsFilled: 0,
    phoneSyncPolls: 0,
    phoneSyncErrors: 0,
    phoneSyncLastError: null,
    phoneCellsFilled: 0,
    phoneRowsChanged: 0,
    phoneNotFound: 0,
    phoneWriteSkippedPopulated: 0,
    phoneStillPending: 0,
    phoneWaterfallPendingAssignments: 0,
    candidatesRanked: 0,
    existingVerificationAttempts: 0,
    existingVerificationFailures: 0,
    existingDiscoveryIdentityMatches: 0,
    existingPublicIndexSearches: 0,
    existingPublicIndexVerificationAttempts: 0,
    existingPublicIndexVerified: 0,
    existingGroupsRepaired: 0,
    existingRepairAudit: [],
    embeddedDesignationWrites: 0,
    newPeopleSelected: 0,
    hydrationAttempts: 0,
    hydrationFailures: 0,
    lowConfidenceCandidates: 0,
    deferredOpenGroups: 0,
    deferredPoc2Rows: [],
    leftoverQueue: [],
    primarySweepDeferredRows: [],
    deterministicRecheckAttempted: false,
    deterministicRecheckRows: [],
    deterministicRecheckResolvedRows: [],
    deterministicRecheckRemainingRows: [],
    deterministicRecheckRemainingMandatoryRows: [],
    deterministicRecheckRemainingRepairRows: [],
    deterministicRecheckRemainingWarningRows: [],
    deterministicRecheckResolvedMandatoryRows: [],
    manualPoc2Attempts: 0,
    manualPoc2Filled: 0,
    manualPoc3Attempts: 0,
    manualPoc3Filled: 0,
    optionalPoc3Deferred: 0,
    unfilledOpenGroups: 0,
    orphanContactTargets: 0,
    orphanContactVerified: 0,
    orphanContactBlocked: 0,
    orphanContactMismatches: 0,
    identityConflicts: 0,
    rankingThresholds: [],
    selectionAudit: [],
    rowFailures: 0,
    recoverableRowFailures: 0,
    transientProviderFailures: 0,
    transientProviderContinuations: 0,
    consecutiveTransientProviderFailures: 0,
    systemicHalts: 0,
    haltedEarly: false,
    haltAtRow: null,
    haltError: null,
    rowFailureAudit: [],
    headerRepairsPlanned: 0,
    headerRepairsWritten: 0,
    headerRepairsSkippedPopulated: 0,
    modelCalls: 0,
    contactPhaseOrdinal: null,
    contactPhaseLabel: '',
  };
}

function markLeftover(stats, rowNumber, reason, details = {}) {
  const row = Number(rowNumber);
  if (!Number.isInteger(row)) return;
  const groupOrdinal = Number(details.groupOrdinal || 0) || null;
  const issue = diagnostics.issueFromReason(reason, {
    ...details,
    rowNumber: row,
    groupOrdinal,
  });
  const key = `${row}|${groupOrdinal || ''}|${issue.code}`;
  const existing = new Set((stats.leftoverQueue || []).map((item) =>
    `${Number(item.rowNumber)}|${Number(item.groupOrdinal || 0) || ''}|${text(item.code || item.reason)}`
  ));
  if (!existing.has(key)) {
    stats.leftoverQueue.push({
      rowNumber: row,
      groupOrdinal,
      reason: issue.rawReason,
      code: issue.code,
      category: issue.category,
      severity: issue.severity,
      blocking: Boolean(issue.blocking),
      retryable: Boolean(issue.retryable),
      company: text(details.company || ''),
      detail: text(details.detail || '').slice(0, 300),
      nextAction: issue.nextAction,
    });
  }
  if (!stats.primarySweepDeferredRows.includes(row)) stats.primarySweepDeferredRows.push(row);
}

function mergeDeterministicRecheckStats(primary, recheck, targetRows = []) {
  const additive = [
    'rowsChanged','cellsChanged','candidateSearches','candidateBroadSearches','candidatePrioritySearches',
    'candidatePrioritySearchFailures','candidateCacheHits','candidatesDiscovered','linkedinFallbackSearches',
    'linkedinFallbackCompanySearches','linkedinFallbackCompanyProfiles','linkedinFallbackCompanyUrns',
    'linkedinFallbackCurrentCompanySearches','linkedinFallbackEmployeeSearches','linkedinFallbackProfileVerifications',
    'linkedinFallbackFailures','linkedinFallbackProfilesFound','linkedinFallbackVerifiedCandidates',
    'publicIndexSearchCalls','publicIndexProfilesFound','publicIndexApolloVerificationAttempts',
    'publicIndexApolloVerifiedCandidates','publicIndexFailures',
    'linkedinHydrationRecoveryAttempts','linkedinHydrationRecoverySuccesses','linkedinHydrationRecoveryFailures',
    'postHydrationDuplicates','existingVerificationAttempts','existingPublicIndexSearches',
    'existingPublicIndexVerificationAttempts','existingPublicIndexVerified','existingGroupsRepaired','embeddedDesignationWrites',
    'newPeopleSelected','hydrationAttempts','hydrationFailures','manualPoc2Attempts','manualPoc2Filled',
    'manualPoc3Attempts','manualPoc3Filled','optionalPoc3Deferred','orphanContactTargets','orphanContactVerified',
    'orphanContactBlocked','orphanContactMismatches','phoneCellsFilled','phoneRowsChanged','phoneNotFound',
    'phoneWriteSkippedPopulated','phoneSyncPolls','phoneSyncErrors'
  ];
  for (const field of additive) {
    primary[field] = Number(primary[field] || 0) + Number(recheck?.[field] || 0);
  }

  primary.discoveryDiagnostics = [...(primary.discoveryDiagnostics || []), ...(recheck?.discoveryDiagnostics || [])];
  primary.existingRepairAudit = [...(primary.existingRepairAudit || []), ...(recheck?.existingRepairAudit || [])];
  primary.selectionAudit = [...(primary.selectionAudit || []), ...(recheck?.selectionAudit || [])];
  primary.rowFailureAudit = [...(primary.rowFailureAudit || []), ...(recheck?.rowFailureAudit || [])];
  primary.rowFailures = Number(primary.rowFailures || 0) + Number(recheck?.rowFailures || 0);
  primary.recoverableRowFailures = Number(primary.recoverableRowFailures || 0) + Number(recheck?.recoverableRowFailures || 0);
  primary.transientProviderFailures = Number(primary.transientProviderFailures || 0) + Number(recheck?.transientProviderFailures || 0);
  primary.transientProviderContinuations = Number(primary.transientProviderContinuations || 0) + Number(recheck?.transientProviderContinuations || 0);

  // The recheck is authoritative for unresolved state because it re-read the live sheet.
  primary.deferredPoc2Rows = [...new Set((recheck?.deferredPoc2Rows || []).map(Number).filter(Number.isInteger))];
  primary.deferredOpenGroups = Number(recheck?.deferredOpenGroups || 0);
  primary.unfilledOpenGroups = Number(recheck?.unfilledOpenGroups || 0);
  primary.rowsWithoutEmployer = Number(recheck?.rowsWithoutEmployer || 0);
  primary.existingVerificationFailures = Number(recheck?.existingVerificationFailures || 0);
  primary.leftoverQueue = Array.isArray(recheck?.leftoverQueue) ? recheck.leftoverQueue : [];
  primary.phoneStillPending = Math.max(Number(primary.phoneStillPending || 0), Number(recheck?.phoneStillPending || 0));
  primary.backgroundPhonePending = Math.max(Number(primary.backgroundPhonePending || 0), Number(recheck?.backgroundPhonePending || 0));
  primary.backgroundPhoneWatcher = Boolean(primary.backgroundPhoneWatcher || recheck?.backgroundPhoneWatcher);

  const classified = diagnostics.classifyLeftovers(primary.leftoverQueue || []);
  const remaining = new Set(classified.issues.map((item) => Number(item.rowNumber)).filter(Number.isInteger));
  const mandatoryRemaining = new Set(classified.blockingRows);
  primary.deterministicRecheckAttempted = true;
  primary.deterministicRecheckRows = [...new Set(targetRows.map(Number).filter(Number.isInteger))];
  primary.deterministicRecheckRemainingRows = primary.deterministicRecheckRows.filter((row) => remaining.has(row));
  primary.deterministicRecheckResolvedRows = primary.deterministicRecheckRows.filter((row) => !remaining.has(row));
  primary.deterministicRecheckRemainingMandatoryRows = classified.blockingRows;
  primary.deterministicRecheckRemainingRepairRows = classified.repairRows;
  primary.deterministicRecheckRemainingWarningRows = classified.warningRows;
  primary.deterministicRecheckResolvedMandatoryRows = primary.deterministicRecheckRows.filter((row) => !mandatoryRemaining.has(row));

  if (recheck?.haltedEarly) {
    primary.haltedEarly = true;
    primary.systemicHalts = Number(primary.systemicHalts || 0) + Number(recheck.systemicHalts || 1);
    primary.haltAtRow = recheck.haltAtRow;
    primary.haltError = recheck.haltError;
  }
  return primary;
}

async function run(request = {}, options = {}) {
  const sheetUrl = request.sheetUrl || request.url;
  if (!sheetUrl) throw new Error('Universal enrichment requires a Google Sheet URL.');
  const source = await readUniversalSheet(sheetUrl, { ...options, sheetName: request.sheetName || options.sheetName });
  const analysis = engine.analyzeSheet(source.rows, { rowLimit: options.rowLimit, schema: options.schema });
  if (options.dryRun) return { ok: true, dryRun: true, deterministic: true, modelCalls: 0, ...source, analysis, schema: engine.schemaSummary(source.schema), stats: { ...freshStats(), rowsSeen: analysis.stats.dataRows } };
  if (options.apolloApproved !== true) {
    const error = new Error('Apollo approval is required before universal enrichment can query paid person enrichment.');
    error.code = 'APOLLO_APPROVAL_REQUIRED';
    error.schema = engine.schemaSummary(source.schema);
    throw error;
  }

  const stats = freshStats();
  const internalRecheck = Boolean(options.recheckPass);
  const phaseOrdinal = Number(options.contactPhaseOrdinal || 0) || null;
  const phaseOrdinals = phaseOrdinal ? [phaseOrdinal] : null;
  stats.contactPhaseOrdinal = phaseOrdinal;
  stats.contactPhaseLabel = phaseOrdinal ? `POC-${phaseOrdinal}` : 'ALL';

  if (!internalRecheck) {
    // Resume Apollo phone callbacks from earlier runs/restarts before doing new
    // enrichment work. Ownership is persisted by exact sheet/row/column/person id.
    stats.resumedPhoneAssignments = loadBackgroundPhoneAssignments();
    if (backgroundPhoneAssignments.size) {
      try {
        const replay = await syncBackgroundPhoneAssignments();
        stats.resumedPhoneResolved = Number(replay?.resolved || 0);
        stats.resumedPhoneCellsFilled = Number(replay?.written || 0);
        stats.phoneCellsFilled += stats.resumedPhoneCellsFilled;
        stats.cellsChanged += stats.resumedPhoneCellsFilled;
      } catch {}
      if (backgroundPhoneAssignments.size) startBackgroundPhoneWatcher();
    }

    // Persist continuity-recovered headers only once, before the primary sweep.
    await applyRecoveredHeaderRepairs(source, stats);

    try {
      const quality = require('./apollo-three-poc-quality');
      quality.install();
      quality.startRun();
    } catch {}
    try {
      const discovery = require('./three-poc-candidate-discovery-policy');
      discovery.install?.();
      discovery.startRun();
    } catch {}
  }

  const cache = options.discoveryCache instanceof Map ? options.discoveryCache : new Map();
  const pendingPhoneQueue = [];
  const runOptions = { ...options, discoveryCache: cache, pendingPhoneQueue };
  const targetRows = Array.isArray(options.targetRows)
    ? new Set(options.targetRows.map((value) => Number(value)).filter(Number.isInteger))
    : null;

  for (const record of analysis.rowPlans) {
    const { row, rowNumber, plan } = record;
    if (targetRows && !targetRows.has(Number(rowNumber))) continue;
    stats.rowsSeen++;
    if (!plan.anchor) { stats.rowsWithoutAnchor++; continue; }

    try {
      const rowEvidenceContext = inferHiringCompanyFromEvidence(plan, row);
      const anchorContactEvidence = (!phaseOrdinal || phaseOrdinal === 1)
        ? extractAnchorContactEvidence(plan)
        : { email: '', phone: '', source: '' };
      const anchorHadBlankEmail = Boolean(plan.anchor?.group?.fields?.email && !text(plan.anchor?.snapshot?.values?.email));
      const anchorHadBlankPhone = Boolean(plan.anchor?.group?.fields?.phone && !text(plan.anchor?.snapshot?.values?.phone));
      if (anchorHadBlankEmail && text(anchorContactEvidence.email)) stats.rowEvidenceContactEmails++;
      if (anchorHadBlankPhone && text(anchorContactEvidence.phone)) stats.rowEvidenceContactPhones++;
      const anchorContactHydrationNeeded = (!phaseOrdinal || phaseOrdinal === 1)
        && anchorNeedsHydration(plan, anchorContactEvidence);
      let anchorCompanyContext = null;
      if (plan.anchor.type === 'company') {
        anchorCompanyContext = companyFromCompanyAnchor(plan.anchor);
      } else if (
        anchorContactHydrationNeeded
        || ((!phaseOrdinal || phaseOrdinal === 1) && (text(anchorContactEvidence.email) || text(anchorContactEvidence.phone)))
        || !rowEvidenceContext
      ) {
        if (anchorContactHydrationNeeded) stats.hydrationAttempts++;
        anchorCompanyContext = await resolvePersonAnchor(plan, row, {
          ...options,
          allowLinkedInEmployerFallback: false,
          completeContacts: true,
          contactEvidence: anchorContactEvidence,
        });
        if (anchorContactHydrationNeeded && !anchorCompanyContext?.anchorPerson) stats.hydrationFailures++;
      } else {
        anchorCompanyContext = {
          unresolved: true,
          source: 'anchor-hydration-skipped-complete',
          anchorLinkedin: apollo.normalizeLinkedIn(plan.anchor?.snapshot?.values?.linkedin || ''),
          anchorPerson: null,
        };
      }

      let companyContext = rowEvidenceContext
        || (anchorCompanyContext && !anchorCompanyContext.unresolved && anchorCompanyContext.company ? anchorCompanyContext : null);

      // LinkedIn employer scraping is the slow fallback, never the default. Use it
      // only when neither row evidence nor Apollo's exact anchor profile resolved
      // a usable hiring organization.
      if (!companyContext?.company && plan.anchor.type === 'person' && !options.resultsFirstSweep) {
        try {
          const linkedinEmployerContext = await resolvePersonAnchor(plan, row, {
            ...options,
            allowLinkedInEmployerFallback: true,
            completeContacts: false,
          });
          if (linkedinEmployerContext?.company) companyContext = linkedinEmployerContext;
          if (!anchorCompanyContext?.anchorPerson && linkedinEmployerContext?.anchorPerson) {
            anchorCompanyContext = linkedinEmployerContext;
          }
        } catch {}
      }

      if (companyContext?.source && /^row-/.test(companyContext.source)) stats.rowEvidenceEmployersResolved++;
      const writes = [];
      const openPersonTargets = (plan.groups?.open || []).filter((target) =>
        !target.isAnchor
        && (!phaseOrdinal || Number(target.group?.ordinal || 0) === phaseOrdinal)
      );
      const aiFallbackEnabled = Boolean(options.deferOpenGroupSelectionToAi);

      // Strict phase pipeline: POC-1 phase touches only the exact anchor group.
      // POC-2 and POC-3 phases never rewrite POC-1.
      const anchorContext = anchorCompanyContext?.anchorPerson
        ? anchorCompanyContext
        : { ...(anchorCompanyContext || {}), anchorPerson: anchorCompanyContext?.anchorProfile || null };
      const earlyRowOptions = { ...runOptions, rowNumber, candidatePool: [], targetOrdinals: phaseOrdinals };
      if (!phaseOrdinal || phaseOrdinal === 1) {
        writes.push(...await enrichAnchorGroup(row, plan, anchorContext, stats, earlyRowOptions));
      }

      if (!companyContext || companyContext.unresolved || !companyContext.company) {
        stats.rowsWithoutEmployer++;
        const unresolvedPoc2 = (!phaseOrdinal || phaseOrdinal === 2)
          && openPersonTargets.some((target) => Number(target.group?.ordinal || 0) === 2);
        if (unresolvedPoc2 && aiFallbackEnabled) {
          stats.deferredOpenGroups++;
          stats.unfilledOpenGroups++;
          if (!stats.deferredPoc2Rows.includes(rowNumber)) stats.deferredPoc2Rows.push(rowNumber);
          markLeftover(stats, rowNumber, 'employer-unresolved', {
            groupOrdinal: 2,
            detail: options.resultsFirstSweep
              ? 'Fast sweep deferred employer recovery to the deterministic leftover pass.'
              : 'No verified employer remained after deterministic recovery.',
          });
        }
        const byColumn = new Map();
        for (const write of writes) if (!byColumn.has(write.columnIndex)) byColumn.set(write.columnIndex, write);
        const changes = toSheetChanges(source.sheetName, rowNumber, [...byColumn.values()]);
        if (changes.length) {
          await sheets.writeCells(source.spreadsheetId, changes);
          stats.rowsChanged++;
          stats.cellsChanged += changes.length;
        }
        stats.rowsProcessed++;
        continue;
      }

      stats.anchorsResolved++;

      const poc2Targets = openPersonTargets.filter((target) => Number(target.group?.ordinal || 0) === 2);
      const poc3Targets = openPersonTargets.filter((target) => Number(target.group?.ordinal || 0) >= 3);

      // Existing/partial POCs are exact-person repair jobs, not discovery jobs.
      // Verify them directly by LinkedIn or exact name+company before spending any
      // Apollo people-search calls. This is especially important for missing phones.
      const repairOptions = { ...runOptions, rowNumber, candidatePool: [], targetOrdinals: phaseOrdinals };
      const verificationFailuresBefore = Number(stats.existingVerificationFailures || 0);
      writes.push(...await repairExistingGroups(row, plan, companyContext, stats, repairOptions));
      if (Number(stats.existingVerificationFailures || 0) > verificationFailuresBefore) {
        markLeftover(stats, rowNumber, 'existing-contact-repair-unresolved', {
          company: companyContext.company,
          detail: 'At least one existing contact could not be exactly re-verified/repaired in this pass.',
        });
      }

      // Mandatory POC-2 always gets the deterministic/manual discovery path first.
      // AI is rescue only. POC-3 may reuse this same pool but never triggers its own search.
      let people = [];
      const discoveryTargets = phaseOrdinal === 3 ? poc3Targets : poc2Targets;
      if (discoveryTargets.length) {
        try {
          people = await discoverPriorityPeopleFast(companyContext, cache, stats, {
            ...runOptions,
            rowNumber,
            location: plan.context?.location || '',
            priorityCandidateLimit: options.manualPriorityCandidateLimit ?? 20,
            adaptiveBroadCandidateLimit: options.adaptiveBroadCandidateLimit ?? 30,
            primarySweep: Boolean(options.resultsFirstSweep),
          });
        } catch (error) {
          const typed = typedFailureSummary(error, {
            stage: error?.stage || 'candidate-discovery',
          });
          stats.discoveryDiagnostics.push({
            rowNumber,
            groupOrdinal: 2,
            company: companyContext.company,
            code: typed.code,
            subsystem: typed.subsystem,
            type: typed.type,
            stage: typed.stage,
            message: typed.message.slice(0, 300),
            hint: typed.hint,
          });
          if (typed.subsystem === 'APOLLO') {
            stats.candidatePrioritySearchFailures++;
          }
        }
      }

      const rowOptions = { ...runOptions, rowNumber, candidatePool: people };
      const manualClaimed = new Set();

      if ((!phaseOrdinal || phaseOrdinal === 2) && poc2Targets.length) {
        stats.manualPoc2Attempts += poc2Targets.length;
        const result = await fillManualPriorityGroup(row, plan, companyContext, people, stats, {
          ...rowOptions,
          ordinal: 2,
          claimed: manualClaimed,
          maxHydrationAttempts: options.resultsFirstSweep
            ? Number(process.env.ULTRON_M3_UNIVERSAL_PRIMARY_POC2_HYDRATION_ATTEMPTS || 1)
            : (options.poc2HydrationAttempts
              ?? Number(process.env.ULTRON_M3_UNIVERSAL_POC2_HYDRATION_ATTEMPTS || 5)),
          fallbackMinimumScore: options.poc2FallbackMinimumScore ?? 26,
        });
        writes.push(...result.writes);
        if (result.filled) {
          stats.manualPoc2Filled++;
        } else {
          stats.unfilledOpenGroups += poc2Targets.length;
          if (aiFallbackEnabled) {
            stats.deferredOpenGroups += poc2Targets.length;
            if (!stats.deferredPoc2Rows.includes(rowNumber)) stats.deferredPoc2Rows.push(rowNumber);
          }

          // Mandatory POC-2 residue must always enter the deterministic leftover
          // queue. Phased execution intentionally disables AI/Big Pickle, but that
          // must not also disable the deep Apollo/LinkedIn/public-index recheck.
          markLeftover(stats, rowNumber, people.length ? 'poc2-verification-unresolved' : 'poc2-no-candidates', {
            groupOrdinal: 2,
            company: companyContext.company,
            detail: options.resultsFirstSweep
              ? 'Fast sweep deferred deeper deterministic discovery/hydration until all rows are processed.'
              : 'Deep deterministic pass still has no safe verified POC-2.',
          });
        }
      }

      // POC-3 gets exactly one cheap manual hydration opportunity from the same
      // discovery pool. No extra discovery and no AI rescue unless explicitly enabled.
      if ((!phaseOrdinal || phaseOrdinal === 3) && poc3Targets.length) {
        if (people.length) {
          stats.manualPoc3Attempts += poc3Targets.length;
          const result = await fillManualPriorityGroup(row, plan, companyContext, people, stats, {
            ...rowOptions,
            ordinal: 3,
            claimed: manualClaimed,
            maxHydrationAttempts: options.poc3HydrationAttempts
              ?? Number(process.env.ULTRON_M3_UNIVERSAL_POC3_HYDRATION_ATTEMPTS || (phaseOrdinal === 3 ? 5 : 1)),
            fallbackMinimumScore: options.poc3FallbackMinimumScore ?? (phaseOrdinal === 3 ? 30 : 42),
          });
          writes.push(...result.writes);
          if (result.filled) stats.manualPoc3Filled++;
          else stats.optionalPoc3Deferred += poc3Targets.length;
        } else {
          stats.optionalPoc3Deferred += poc3Targets.length;
        }
      }

      const byColumn = new Map();
      for (const write of writes) if (!byColumn.has(write.columnIndex)) byColumn.set(write.columnIndex, write);
      const changes = toSheetChanges(source.sheetName, rowNumber, [...byColumn.values()]);
      if (changes.length) {
        await sheets.writeCells(source.spreadsheetId, changes);
        stats.rowsChanged++;
        stats.cellsChanged += changes.length;
      }
      stats.rowsProcessed++;
      stats.consecutiveTransientProviderFailures = 0;
    } catch (error) {
      const typed = typedFailureSummary(error, {
        stage: error?.stage || 'primary-row-enrichment',
      });
      stats.rowFailures++;
      stats.rowFailureAudit.push({ rowNumber, ...typed });

      if (isRecoverableRowFailure(typed)) {
        stats.recoverableRowFailures++;
        stats.consecutiveTransientProviderFailures = 0;
        markLeftover(stats, rowNumber, 'recoverable-row-failure', {
          detail: typed.code || typed.message || 'row-local failure',
        });
        stats.rowsProcessed++;
        continue;
      }

      // Apollo already retries transport failures at the HTTP boundary. One
      // exhausted row-level network failure should still not invalidate or stop
      // unrelated rows immediately. Continue a bounded number of consecutive
      // transient provider failures, then open the circuit and halt safely.
      if (isTransientProviderRowFailure(typed)) {
        const maxTransient = integer(options.maxTransientRowFailures, 2, 1, 5);
        stats.transientProviderFailures++;
        stats.consecutiveTransientProviderFailures++;
        if (stats.consecutiveTransientProviderFailures <= maxTransient) {
          stats.transientProviderContinuations++;
          stats.rowsProcessed++;
          continue;
        }
      } else {
        stats.consecutiveTransientProviderFailures = 0;
      }

      stats.systemicHalts++;
      stats.haltedEarly = true;
      stats.haltAtRow = rowNumber;
      stats.haltError = typed;
      break;
    }
  }

  try {
    await syncPendingPhoneAssignments(source, pendingPhoneQueue, stats, runOptions);
  } catch (error) {
    stats.phoneSyncErrors++;
    stats.phoneSyncLastError = typedFailureSummary(error, { stage: error?.stage || 'apollo-phone-result-sync' });
  }

  // Results-first contract: finish the fast sweep before spending deep discovery
  // on difficult rows. Re-read the live sheet, then re-run only the queued rows
  // with the full deterministic waterfall. AI/last-resort sees only residue after
  // this pass, never a row that merely failed the cheap first attempt.
  if (options.resultsFirstSweep && !options.recheckPass && !stats.haltedEarly) {
    const leftoverRows = [...new Set((stats.leftoverQueue || [])
      .map((item) => Number(item.rowNumber))
      .filter(Number.isInteger))];

    if (leftoverRows.length) {
      const recheck = await run(request, {
        ...options,
        resultsFirstSweep: false,
        recheckPass: true,
        targetRows: leftoverRows,
        discoveryCache: cache,
        contactPhaseOrdinal: phaseOrdinal,
      });
      mergeDeterministicRecheckStats(stats, recheck.stats || {}, leftoverRows);
    }
  }

  return {
    ok: true,
    deterministic: true,
    modelCalls: 0,
    completedFully: !stats.haltedEarly,
    partialCompletion: Boolean(stats.haltedEarly || stats.rowFailures),
    resumeSafe: true,
    spreadsheetId: source.spreadsheetId,
    spreadsheetTitle: source.spreadsheetTitle,
    sheetName: source.sheetName,
    schema: engine.schemaSummary(source.schema),
    analysis: analysis.stats,
    contactPhaseOrdinal: phaseOrdinal,
    contactPhaseLabel: stats.contactPhaseLabel,
    stats,
  };
}

function formatResult(result) {
  const s = result?.stats || {};
  const schema = result?.schema || {};
  let contactQuality = {};
  try { contactQuality = require('./apollo-three-poc-quality').stats(); } catch {}
  const groups = Array.isArray(schema.personGroups) ? schema.personGroups.length : 0;
  const companies = Array.isArray(schema.companyGroups) ? schema.companyGroups.length : 0;
  const ordinalRecovered = Array.isArray(schema.ordinalContactRecoveries) ? schema.ordinalContactRecoveries.length : 0;
  const phaseText = s.contactPhaseOrdinal ? ` Contact phase: POC-${s.contactPhaseOrdinal} only.` : '';
  const status = s.haltedEarly
    ? `Universal deterministic enrichment PARTIALLY completed on ${result.sheetName}; execution halted safely at row ${s.haltAtRow} after preserving all earlier verified writes.${phaseText}`
    : `Universal deterministic enrichment finished on ${result.sheetName}.${phaseText}`;
  const rowFailureText = s.rowFailures
    ? ` Row fault containment: ${s.rowFailures} row failure${Number(s.rowFailures) === 1 ? '' : 's'} captured, ${s.recoverableRowFailures || 0} ordinary row-local failure${Number(s.recoverableRowFailures || 0) === 1 ? '' : 's'} continued, ${s.transientProviderContinuations || 0} transient Apollo transport failure${Number(s.transientProviderContinuations || 0) === 1 ? '' : 's'} continued under the circuit breaker, ${s.systemicHalts || 0} systemic halt${Number(s.systemicHalts || 0) === 1 ? '' : 's'}.`
    : ' Row fault containment: no row failures.';
  const haltText = s.haltError
    ? ` Halt cause: ${formatFailureSummary(s.haltError)}. ${s.haltError.hint || ''}${s.haltError.attemptedRange ? ` Attempted range: ${s.haltError.attemptedRange}.` : ''}`
    : '';
  return `${status} Schema: header row ${schema.headerRowNumber || '?'}, ${groups} person/contact groups, ${companies} company groups, confidence ${Number(schema.confidence || 0).toFixed(2)}; ${ordinalRecovered} ordinal contact groups recovered structurally; ${(schema.continuityRecoveries || []).length} contact groups recovered by explicit schema continuity. Header continuity repair: ${s.headerRepairsWritten || 0}/${s.headerRepairsPlanned || 0} missing headers restored into blank cells, ${s.headerRepairsSkippedPopulated || 0} skipped because populated. Processed ${s.rowsProcessed}/${s.rowsSeen} rows; changed ${s.cellsChanged} contact cells across ${s.rowsChanged} data rows; resolved ${s.anchorsResolved} anchors; repaired ${s.existingGroupsRepaired} existing groups; selected ${s.newPeopleSelected} new people. Embedded verified designations in ${s.embeddedDesignationWrites || 0} contact-name writes where no dedicated role column existed. Row-contact evidence: ${s.rowEvidenceContactEmails || 0} author-matching emails and ${s.rowEvidenceContactPhones || 0} nearby author-attributed phones recovered before paid enrichment. Discovery: ${s.candidatesDiscovered} unique candidates from ${s.candidateSearches} Apollo discovery calls (${s.candidateBroadSearches || 0} broad, ${s.candidatePrioritySearches || 0} priority-targeted, ${s.candidatePrioritySearchFailures || 0} supplemental failures, ${s.candidateCacheHits} cache hits); LinkedIn fallback ${s.linkedinFallbackCompanySearches || 0} company searches, ${s.linkedinFallbackCompanyProfiles || 0} company profiles, ${s.linkedinFallbackCompanyUrns || 0} company URNs, ${s.linkedinFallbackCurrentCompanySearches || 0} current-company people searches, ${s.linkedinFallbackEmployeeSearches || 0} employee-page searches, ${s.linkedinFallbackSearches || 0} generic people searches, ${s.linkedinFallbackProfilesFound || 0} profile refs, ${s.linkedinFallbackVerifiedCandidates || 0} Apollo-verified candidates, ${s.linkedinFallbackFailures || 0} failures; public-index fallback ${s.publicIndexSearchCalls || 0} searches, ${s.publicIndexProfilesFound || 0} LinkedIn profile refs, ${s.publicIndexApolloVerificationAttempts || 0} Apollo verification attempts, ${s.publicIndexApolloVerifiedCandidates || 0} exact verified candidates, ${s.publicIndexFailures || 0} failures; ${s.candidatesRanked} candidates passed deterministic ranking. Hydration: ${s.hydrationAttempts} attempts, ${s.hydrationFailures} failures; exact LinkedIn employer recovery ${s.linkedinHydrationRecoverySuccesses || 0}/${s.linkedinHydrationRecoveryAttempts || 0} succeeded (${s.linkedinHydrationRecoveryFailures || 0} failed); ${s.postHydrationDuplicates || 0} hydrated identities were already present and were skipped before trying the next candidate. Existing-contact repair: ${s.existingVerificationAttempts || 0} verification attempts (business-email exact match preferred when available), ${s.existingDiscoveryIdentityMatches || 0} exact same-company discovery matches, public-index exact-name repair ${s.existingPublicIndexSearches || 0} searches/${s.existingPublicIndexVerificationAttempts || 0} Apollo verification attempts/${s.existingPublicIndexVerified || 0} exact identities recovered, ${s.existingGroupsRepaired || 0} groups repaired, ${s.existingVerificationFailures || 0} verification failures. Final-POC contact waterfall: phone ${contactQuality.phoneWaterfallStarted || 0} started/${contactQuality.phoneWaterfallSucceeded || 0} found/${contactQuality.phoneWaterfallPending || 0} pending/${contactQuality.phoneWaterfallNotFound || 0} not-found/${contactQuality.phoneWaterfallUnavailable || 0} unavailable/${contactQuality.phoneWaterfallBudgetSkips || 0} budget-skipped; email ${contactQuality.waterfallStarted || 0} started/${contactQuality.waterfallSucceeded || 0} found/${contactQuality.waterfallPending || 0} pending/${contactQuality.waterfallBudgetSkips || 0} budget-skipped. Phone completion: ${s.pendingPhoneRequests || 0} async Apollo phone requests tracked; resumed ${s.resumedPhoneAssignments || 0} persisted callback assignments from earlier runs, resolved ${s.resumedPhoneResolved || 0}, wrote ${s.resumedPhoneCellsFilled || 0} recovered phone cells; ${s.phoneCellsFilled || 0} phone cells filled after webhook sync, ${s.phoneNotFound || 0} confirmed unavailable, ${s.phoneStillPending || 0} still pending, ${s.phoneSyncErrors || 0} sync errors; background callback watcher ${s.backgroundPhoneWatcher ? 'active' : 'idle'} with ${s.backgroundPhonePending || 0} queued. Priority routing: POC-1 exact anchor completion always runs first; existing POC-2 exact repair runs deterministically; empty POC-2 manual hydration attempts ${s.manualPoc2Attempts || 0} (skipped when batch AI owns selection), manual fills ${s.manualPoc2Filled || 0}, unresolved POC-2 deferred to AI ${s.deferredOpenGroups || 0} across ${(s.deferredPoc2Rows || []).length} exact rows; optional POC-3 manual attempts ${s.manualPoc3Attempts || 0}, strong-confidence fills ${s.manualPoc3Filled || 0}, left optional ${s.optionalPoc3Deferred || 0}. Orphan-contact safety: ${s.orphanContactTargets || 0} identity-less partial targets, ${s.orphanContactVerified || 0} verified by matching existing contact data, ${s.orphanContactBlocked || 0} blocked, ${s.orphanContactMismatches || 0} candidate/contact mismatches. Unfilled target groups: ${s.unfilledOpenGroups}; rows without anchor ${s.rowsWithoutAnchor}; row-evidence employers resolved ${s.rowEvidenceEmployersResolved || 0}; rows without verified employer ${s.rowsWithoutEmployer}; identity conflicts ${s.identityConflicts}.${rowFailureText}${haltText} Resume-safe: yes; rerunning re-reads the live sheet and preserves already populated verified values. Results-first routing: fast sweep deferred ${(s.primarySweepDeferredRows || []).length} row${(s.primarySweepDeferredRows || []).length === 1 ? '' : 's'}; deterministic leftover recheck ${s.deterministicRecheckAttempted ? `ran on ${(s.deterministicRecheckRows || []).length} row${(s.deterministicRecheckRows || []).length === 1 ? '' : 's'}; mandatory blockers remaining [${(s.deterministicRecheckRemainingMandatoryRows || []).join(', ') || 'none'}]; contact-repair residue [${(s.deterministicRecheckRemainingRepairRows || []).join(', ') || 'none'}]; other warning/pending residue [${(s.deterministicRecheckRemainingWarningRows || []).join(', ') || 'none'}]` : 'was not needed'}. Diagnostics: ${diagnostics.uniqueIssues([...(diagnostics.classifyLeftovers(s.leftoverQueue || []).issues || []), ...diagnostics.runtimeIssues(s)]).map(diagnostics.formatIssue).join(' | ') || '[INFO] NO_ACTIVE_ENRICHMENT_ISSUES: no unresolved deterministic issues recorded.'} AI/model calls: 0.`;
}

module.exports = {
  schemaLinkedInColumns,
  patchRichLinkedInLinks,
  readUniversalSheet,
  companyFromCompanyAnchor,
  inferHiringCompanyFromEvidence,
  preferredHiringCompanyContext,
  anchorNameTokens,
  emailLocalPartMatchesAnchor,
  extractAnchorContactEvidence,
  anchorNeedsHydration,
  resolvePersonAnchor,
  existingIdentityKeys,
  candidateAlreadyPresent,
  existingPersonVerificationContext,
  existingContactSearchName,
  existingContactRole,
  roleEvidenceMatches,
  existingIdentityVerified,
  repairExistingContactFromPublicIndex,
  needsEmbeddedDesignationRepair,
  candidateFillTargets,

  queuePendingPhone,
  registerBackgroundPhoneAssignments,
  syncBackgroundPhoneAssignments,
  startBackgroundPhoneWatcher,
  loadBackgroundPhoneAssignments,
  persistBackgroundPhoneAssignments,
  backgroundPhoneStatus,
  syncPendingPhoneAssignments,
  repairExistingGroups,
  enrichAnchorGroup,
  candidateDiscoveryKey,
  mergeCandidatePools,
  companyPriorityTitles,
  companyPriorityCandidate,
  discoverCompanyPeople,
  companyBrandFromDomain,
  collectLinkedInPersonUrls,
  collectLinkedInCompanySlugs,
  collectLinkedInCompanyUrns,
  companySlugCandidates,
  flattenStructuredText,
  linkedinCompanyProfileMatches,
  discoverLinkedInFallbackPeople,
  verifyLinkedInCompanyEmployee,
  publicIndexFallbackEnabled,
  publicIndexQueries,
  publicIndexRecord,
  verifyPublicIndexPerson,
  discoverPublicIndexPeople,
  hydrateDecisionMakerVerified,
  discoverPriorityPeopleFast,
  pragmaticSameEmployerCandidates,
  manualPriorityCandidates,
  fillManualPriorityGroup,
  fillOpenGroups,
  applyRecoveredHeaderRepairs,
  typedFailureSummary,
  isRecoverableRowFailure,
  isTransientProviderRowFailure,
  formatFailureSummary,
  diagnostics,
  freshStats,
  markLeftover,
  mergeDeterministicRecheckStats,
  run,
  formatResult,
};
