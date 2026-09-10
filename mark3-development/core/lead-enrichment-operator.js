const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const googleAuth = require('./google-sheets-auth');
const sheets = require('./google-sheets-operator');
const microsoft = require('./microsoft-excel-operator');
const apollo = require('./apollo-enrichment');

const STATE_FILE = path.join(config.projectRoot, '.ultron', 'lead-enrichment', 'jobs.json');
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
  state.jobs = (state.jobs || []).slice(-30);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apolloDelayMs() {
  const value = Number(apollo.setting('ULTRON_M3_APOLLO_DELAY_MS', '800'));
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 10_000) : 800;
}

function adapterFor(input, provider = null) {
  if (provider === 'microsoft' || microsoft.isMicrosoftUrl(input)) return microsoft;
  return sheets;
}

function pendingCount(state = loadState()) {
  let count = 0;
  for (const job of state.jobs || []) {
    for (const row of Object.values(job.rows || {})) if (row?.phonePending) count++;
  }
  return count;
}

function makeJob(layout, sheetUrl, adapter) {
  return {
    id: `apollo-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    provider: adapter.provider || 'google',
    sheetUrl,
    spreadsheetId: layout.spreadsheetId,
    spreadsheetTitle: layout.spreadsheetTitle,
    sheetName: layout.sheetName,
    headerRowNumber: layout.headerRowNumber,
    linkedinColumnIndex: layout.linkedinColumnIndex,
    phoneColumnIndex: layout.phoneColumnIndex,
    emailColumnIndex: layout.emailColumnIndex,
    status: 'running',
    rows: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function rowPendingRecord(job, rowNumber, linkedinUrl, apolloPersonId) {
  return {
    rowNumber,
    linkedinUrl,
    apolloPersonId: apolloPersonId || null,
    phonePending: Boolean(apolloPersonId),
    phoneColumnIndex: job.phoneColumnIndex,
    requestedAt: new Date().toISOString(),
  };
}

async function flushChanges(adapter, spreadsheetId, changes, stats) {
  if (!changes.length) return;
  const result = await adapter.writeCells(spreadsheetId, changes.splice(0, changes.length));
  stats.updatedCells += result.updatedCells;
}

function valueOrNull(value) {
  return value ? String(value) : 'null';
}

function isNullSentinel(value) {
  return String(value ?? '').trim().toLowerCase() === 'null';
}

function isCompanyLinkedIn(value) {
  return /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/company\//i.test(String(value || ''));
}

function extractRowEmail(row, excludedIndexes = []) {
  const excluded = new Set(excludedIndexes.filter((value) => Number.isInteger(value) && value >= 0));
  const emailPattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/ig;
  for (let index = 0; index < (row || []).length; index++) {
    if (excluded.has(index)) continue;
    const text = String(row[index] ?? '');
    const matches = text.match(emailPattern) || [];
    for (const match of matches) {
      const email = String(match).replace(/[),.;:!?]+$/, '').trim();
      if (email && !/^(?:example|test)@/i.test(email)) return email;
    }
  }
  return null;
}

function normalizePublishedPhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const hasPlus = raw.includes('+');
  const digits = raw.replace(/\D/g, '');
  if (hasPlus && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  if (digits.length >= 10 && digits.length <= 15) return digits;
  return null;
}

function extractRowPhone(row, excludedIndexes = []) {
  const excluded = new Set(excludedIndexes.filter((value) => Number.isInteger(value) && value >= 0));
  const labelled = /(?:phone(?:\s*(?:no|number))?|mobile|whats?app|contact|call|📞|📱)\s*(?:no\.?|number)?\s*[:\-–—]?\s*(\+?\d[\d\s().-]{7,}\d)/ig;
  const international = /\+\d[\d\s().-]{8,}\d/g;

  for (let index = 0; index < (row || []).length; index++) {
    if (excluded.has(index)) continue;
    const text = String(row[index] ?? '');
    labelled.lastIndex = 0;
    let match;
    while ((match = labelled.exec(text))) {
      const phone = normalizePublishedPhone(match[1]);
      if (phone) return phone;
    }
  }

  for (let index = 0; index < (row || []).length; index++) {
    if (excluded.has(index)) continue;
    const text = String(row[index] ?? '');
    const matches = text.match(international) || [];
    for (const candidate of matches) {
      const phone = normalizePublishedPhone(candidate);
      if (phone) return phone;
    }
  }
  return null;
}

function clearStaleNulls(adapter, changes, layout, rowNumber, row, needEmail, needPhone) {
  if (needEmail && layout.emailColumnIndex >= 0 && isNullSentinel(row[layout.emailColumnIndex])) {
    changes.push({ range: adapter.cellRange(layout.sheetName, rowNumber, layout.emailColumnIndex), value: '' });
  }
  if (needPhone && layout.phoneColumnIndex >= 0 && isNullSentinel(row[layout.phoneColumnIndex])) {
    changes.push({ range: adapter.cellRange(layout.sheetName, rowNumber, layout.phoneColumnIndex), value: '' });
  }
}

async function enrichSheet(sheetUrl, options = {}) {
  if (!sheetUrl) throw new Error('Spreadsheet URL is required.');
  try { await syncPhoneResults({ quiet: true }); } catch {}

  const adapter = adapterFor(sheetUrl, options.provider);
  const layout = await adapter.inspect(sheetUrl);
  const data = await adapter.readSheet(sheetUrl, layout);
  const state = loadState();
  const job = makeJob(layout, sheetUrl, adapter);
  state.jobs.push(job);
  saveState(state);

  const stats = {
    jobId: job.id,
    provider: job.provider,
    spreadsheetTitle: layout.spreadsheetTitle,
    sheetName: layout.sheetName,
    headerRow: layout.headerRowNumber,
    linkedinColumn: layout.linkedinColumn,
    phoneColumn: layout.phoneColumn,
    emailColumn: layout.emailColumn,
    scannedRows: 0,
    enrichedProfiles: 0,
    cachedProfiles: 0,
    emailsWritten: 0,
    phonesWritten: 0,
    nullsWritten: 0,
    sheetEmailsRecovered: 0,
    sheetPhonesRecovered: 0,
    localApolloSkips: 0,
    pendingPhones: 0,
    skippedComplete: 0,
    invalidLinkedIn: 0,
    companyLinkedIn: 0,
    ambiguousMatches: 0,
    unresolvedRows: 0,
    failedRows: 0,
    updatedCells: 0,
  };
  const changes = [];
  const firstDataIndex = layout.headerRowIndex + 1;

  for (let index = firstDataIndex; index < data.rows.length; index++) {
    const row = data.rows[index] || [];
    const rowNumber = index + 1;
    const rawLinkedIn = row[layout.linkedinColumnIndex];
    if (!rawLinkedIn || !String(rawLinkedIn).trim()) continue;
    stats.scannedRows++;

    let needEmail = layout.emailColumnIndex >= 0 && adapter.isBlank(row[layout.emailColumnIndex]);
    let needPhone = layout.phoneColumnIndex >= 0 && adapter.isBlank(row[layout.phoneColumnIndex]);
    if (!needEmail && !needPhone) {
      stats.skippedComplete++;
      continue;
    }

    const neededBeforeLocal = needEmail || needPhone;

    if (needEmail) {
      const visibleEmail = extractRowEmail(row, [layout.emailColumnIndex, layout.linkedinColumnIndex]);
      if (visibleEmail) {
        changes.push({ range: adapter.cellRange(layout.sheetName, rowNumber, layout.emailColumnIndex), value: visibleEmail });
        stats.emailsWritten++;
        stats.sheetEmailsRecovered++;
        needEmail = false;
      }
    }

    if (needPhone) {
      const visiblePhone = extractRowPhone(row, [layout.phoneColumnIndex, layout.linkedinColumnIndex]);
      if (visiblePhone) {
        changes.push({ range: adapter.cellRange(layout.sheetName, rowNumber, layout.phoneColumnIndex), value: visiblePhone });
        stats.phonesWritten++;
        stats.sheetPhonesRecovered++;
        needPhone = false;
      }
    }

    if (!needEmail && !needPhone) {
      if (neededBeforeLocal) stats.localApolloSkips++;
      if (changes.length >= 40) await flushChanges(adapter, layout.spreadsheetId, changes, stats);
      continue;
    }

    const linkedinUrl = apollo.normalizeLinkedIn(rawLinkedIn);
    if (!linkedinUrl) {
      if (isCompanyLinkedIn(rawLinkedIn)) {
        stats.companyLinkedIn++;
        if (needEmail) {
          changes.push({ range: adapter.cellRange(layout.sheetName, rowNumber, layout.emailColumnIndex), value: 'null' });
          stats.emailsWritten++;
          stats.nullsWritten++;
        }
        if (needPhone) {
          changes.push({ range: adapter.cellRange(layout.sheetName, rowNumber, layout.phoneColumnIndex), value: 'null' });
          stats.phonesWritten++;
          stats.nullsWritten++;
        }
        if (changes.length >= 40) await flushChanges(adapter, layout.spreadsheetId, changes, stats);
        continue;
      }

      clearStaleNulls(adapter, changes, layout, rowNumber, row, needEmail, needPhone);
      stats.invalidLinkedIn++;
      stats.unresolvedRows++;
      if (changes.length >= 40) await flushChanges(adapter, layout.spreadsheetId, changes, stats);
      continue;
    }

    try {
      const result = await apollo.enrich(linkedinUrl, { needEmail, needPhone, force: Boolean(options.force) });
      if (result.cached) stats.cachedProfiles++;
      else {
        stats.enrichedProfiles++;
        const delay = apolloDelayMs();
        if (delay) await sleep(delay);
      }

      if (result.ambiguous) {
        clearStaleNulls(adapter, changes, layout, rowNumber, row, needEmail, needPhone);
        stats.ambiguousMatches++;
        stats.unresolvedRows++;
        if (changes.length >= 40) await flushChanges(adapter, layout.spreadsheetId, changes, stats);
        continue;
      }

      if (needEmail) {
        const emailValue = result.noMatch ? 'null' : valueOrNull(result.email);
        changes.push({ range: adapter.cellRange(layout.sheetName, rowNumber, layout.emailColumnIndex), value: emailValue });
        stats.emailsWritten++;
        if (emailValue === 'null') stats.nullsWritten++;
      }

      if (needPhone) {
        if (result.noMatch || result.phoneStatus === 'not_found') {
          changes.push({ range: adapter.cellRange(layout.sheetName, rowNumber, layout.phoneColumnIndex), value: 'null' });
          stats.phonesWritten++;
          stats.nullsWritten++;
        } else if (result.phoneStatus === 'found' && result.phone) {
          changes.push({ range: adapter.cellRange(layout.sheetName, rowNumber, layout.phoneColumnIndex), value: String(result.phone) });
          stats.phonesWritten++;
        } else if (result.apolloPersonId) {
          if (isNullSentinel(row[layout.phoneColumnIndex])) {
            changes.push({ range: adapter.cellRange(layout.sheetName, rowNumber, layout.phoneColumnIndex), value: '' });
          }
          job.rows[String(rowNumber)] = rowPendingRecord(job, rowNumber, linkedinUrl, result.apolloPersonId);
          stats.pendingPhones++;
          job.updatedAt = new Date().toISOString();
          saveState(state);
        } else {
          if (isNullSentinel(row[layout.phoneColumnIndex])) {
            changes.push({ range: adapter.cellRange(layout.sheetName, rowNumber, layout.phoneColumnIndex), value: '' });
          }
          stats.unresolvedRows++;
        }
      }

      if (changes.length >= 40) await flushChanges(adapter, layout.spreadsheetId, changes, stats);
    } catch (error) {
      clearStaleNulls(adapter, changes, layout, rowNumber, row, needEmail, needPhone);
      stats.failedRows++;
      job.rows[String(rowNumber)] = {
        rowNumber,
        linkedinUrl,
        error: error.message,
        phonePending: false,
        failedAt: new Date().toISOString(),
      };
      job.updatedAt = new Date().toISOString();
      saveState(state);
    }
  }

  await flushChanges(adapter, layout.spreadsheetId, changes, stats);
  job.status = stats.failedRows ? 'completed_with_errors' : (stats.pendingPhones ? 'waiting_for_phone_webhooks' : 'completed');
  job.stats = stats;
  job.updatedAt = new Date().toISOString();
  saveState(state);
  if (stats.pendingPhones) startPhoneWatcher();
  return stats;
}

async function syncPhoneResults(options = {}) {
  const results = await apollo.fetchPhoneResults();
  if (!results.length) return { received: 0, resolved: 0, pending: pendingCount() };
  const state = loadState();
  let resolved = 0;

  for (const result of results) {
    const apolloPersonId = String(result?.apollo_person_id || '').trim();
    if (!apolloPersonId) continue;
    const phone = String(result?.phone || '').trim() || null;
    const matches = [];
    for (const job of state.jobs || []) {
      for (const [key, row] of Object.entries(job.rows || {})) {
        if (!row?.phonePending || String(row.apolloPersonId || '') !== apolloPersonId) continue;
        matches.push({ job, key, row });
      }
    }

    if (!matches.length) {
      const changedCache = apollo.recordPhoneResult(apolloPersonId, phone);
      if (changedCache.length) await apollo.consumePhoneResult(apolloPersonId);
      continue;
    }

    let allHandled = true;
    for (const match of matches) {
      try {
        const adapter = adapterFor(match.job.sheetUrl, match.job.provider);
        const range = adapter.cellRange(match.job.sheetName, match.row.rowNumber, match.row.phoneColumnIndex);
        const current = await adapter.readCell(match.job.spreadsheetId, range);
        if (adapter.isBlank(current)) {
          await adapter.writeCells(match.job.spreadsheetId, [{ range, value: phone || 'null' }]);
        }
        match.row.phonePending = false;
        match.row.phoneResolved = true;
        match.row.phone = phone;
        match.row.resolvedAt = new Date().toISOString();
        match.job.updatedAt = new Date().toISOString();
        resolved++;
      } catch (error) {
        allHandled = false;
        match.row.lastSyncError = error.message;
      }
    }
    apollo.recordPhoneResult(apolloPersonId, phone);
    saveState(state);
    if (allHandled) await apollo.consumePhoneResult(apolloPersonId);
  }

  const pending = pendingCount(state);
  for (const job of state.jobs || []) {
    const jobPending = Object.values(job.rows || {}).some((row) => row?.phonePending);
    if (!jobPending && job.status === 'waiting_for_phone_webhooks') job.status = 'completed';
  }
  saveState(state);
  if (!options.quiet && pending) startPhoneWatcher();
  return { received: results.length, resolved, pending };
}

function startPhoneWatcher() {
  if (watcherTimer || !pendingCount()) return;
  watcherRemaining = 30;
  const tick = async () => {
    watcherTimer = null;
    if (!pendingCount() || watcherRemaining <= 0) return;
    watcherRemaining--;
    try { await syncPhoneResults({ quiet: true }); } catch {}
    if (pendingCount() && watcherRemaining > 0) {
      watcherTimer = setTimeout(tick, 45_000);
      watcherTimer.unref?.();
    }
  };
  watcherTimer = setTimeout(tick, 15_000);
  watcherTimer.unref?.();
}

async function resume() {
  const synced = await syncPhoneResults({ quiet: false });
  const state = loadState();
  const latest = [...(state.jobs || [])].reverse().find((job) => ['running', 'completed_with_errors'].includes(job.status));
  if (!latest) return { ...synced, resumed: false };
  const stats = await enrichSheet(latest.sheetUrl, { provider: latest.provider });
  return { ...synced, resumed: true, stats };
}

function status() {
  const google = googleAuth.status();
  const microsoftStatus = microsoft.status();
  const apolloStatus = apollo.status();
  const pending = pendingCount();
  const googleReady = google.credentialsReady && google.authorized;
  const microsoftReady = microsoftStatus.clientIdReady && microsoftStatus.authorized && microsoftStatus.dependencyReady;
  return {
    ready: (googleReady || microsoftReady) && apolloStatus.apiKeyReady && apolloStatus.webhookReady,
    google,
    microsoft: microsoftStatus,
    providers: { google: googleReady, microsoft: microsoftReady },
    apollo: apolloStatus,
    pendingPhones: pending,
    stateFile: STATE_FILE,
  };
}

function formatResult(stats) {
  const columns = [
    stats.emailColumn ? `email ${stats.emailColumn}` : null,
    stats.phoneColumn ? `phone ${stats.phoneColumn}` : null,
  ].filter(Boolean).join(', ');
  const phoneTail = stats.pendingPhones
    ? ` ${stats.pendingPhones} phone${stats.pendingPhones === 1 ? '' : 's'} are still verifying and will auto-fill when Apollo returns them.`
    : '';
  const localTail = (stats.sheetEmailsRecovered || stats.sheetPhonesRecovered)
    ? ` Local-first recovered ${stats.sheetEmailsRecovered || 0} email${stats.sheetEmailsRecovered === 1 ? '' : 's'} and ${stats.sheetPhonesRecovered || 0} phone${stats.sheetPhonesRecovered === 1 ? '' : 's'} from the sheet; ${stats.localApolloSkips || 0} row${stats.localApolloSkips === 1 ? '' : 's'} needed no Apollo call.`
    : '';
  const apolloTail = ` Apollo live calls: ${stats.enrichedProfiles || 0}; cache hits: ${stats.cachedProfiles || 0}.`;
  const companyTail = stats.companyLinkedIn
    ? ` ${stats.companyLinkedIn} company LinkedIn row${stats.companyLinkedIn === 1 ? '' : 's'} were handled without People Enrichment.`
    : '';
  const unresolvedTail = stats.unresolvedRows
    ? ` ${stats.unresolvedRows} uncertain row${stats.unresolvedRows === 1 ? '' : 's'} were left untouched.`
    : '';
  const errorTail = stats.failedRows ? ` ${stats.failedRows} row${stats.failedRows === 1 ? '' : 's'} failed and were left untouched.` : '';
  const providerLabel = stats.provider === 'microsoft' ? ' Microsoft Excel/OneDrive workbook' : ' Google Sheet';
  return `Done, Sir. ${stats.sheetName}: checked ${stats.scannedRows} LinkedIn row${stats.scannedRows === 1 ? '' : 's'} in the${providerLabel}; wrote ${stats.emailsWritten} email cell${stats.emailsWritten === 1 ? '' : 's'} and ${stats.phonesWritten} phone cell${stats.phonesWritten === 1 ? '' : 's'}${columns ? ` (${columns})` : ''}.${localTail}${apolloTail}${phoneTail}${companyTail}${unresolvedTail}${errorTail}`;
}

function authInstruction(provider = 'google') {
  if (provider === 'microsoft') {
    return 'Microsoft OneDrive needs its one-time login. Add MICROSOFT_GRAPH_CLIENT_ID to the root .env, then in the Mark 3 folder run: node --env-file=../.env scripts/microsoft-onedrive-setup.js';
  }
  return 'Google Sheets needs its one-time login. In the Mark 3 folder run: node --env-file=../.env scripts/google-sheets-auth.js';
}

module.exports = {
  loadState,
  saveState,
  pendingCount,
  status,
  adapterFor,
  enrichSheet,
  syncPhoneResults,
  startPhoneWatcher,
  resume,
  formatResult,
  extractRowEmail,
  extractRowPhone,
  authInstruction,
};
