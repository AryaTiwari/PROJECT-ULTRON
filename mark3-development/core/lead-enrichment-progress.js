const leadEnrichment = require('./lead-enrichment-operator');

let installed = false;
let originalHandle = null;
let originalEnrichSheet = null;
let originalFormatResult = null;

const STALE_PENDING_MINUTES = 20;
const CAMPAIGN_WINDOW_HOURS = 24;

function isStatusRequest(text) {
  return /\b(?:apollo|lead)?\s*enrichment\s+status\b|\bphone\s+(?:verification|enrichment)\s+status\b/i.test(String(text || ''));
}

function isFreePhoneSyncRequest(text) {
  const value = String(text || '');
  if (/\b(?:resume|continue|retry|rerun|re-run)\b/i.test(value)) return false;
  return /\b(?:sync|check|refresh|poll)\b[\s\S]{0,45}\b(?:phone|webhook|callback|enrichment)\b/i.test(value)
    || /\b(?:phone|webhook|callback)\b[\s\S]{0,45}\b(?:results?|status)\b/i.test(value);
}

function normalizeContextPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  return null;
}

function contextualPhoneFromText(value) {
  const text = String(value || '');
  const positiveCue = /\b(?:dm|reach(?:\s+me)?|contact|call|whats?app|phone|mobile|send|share|resume|cv|profile|apply|interested|mail|email)\b|📞|📱|📩|📧/i;
  const immediateNonPhoneCue = /\b(?:salary|ctc|budget|job\s*id|job\s*no|req(?:uisition)?\s*id|reference\s*id|ref\s*id|pincode|pin\s*code|aadhaar|pan\s*(?:no|number)?|experience|exp)\s*[:#\-–—]?\s*$/i;

  for (const line of text.split(/\r?\n/)) {
    const regex = /(^|\D)([6-9]\d{9})(?!\d)/g;
    let match;
    while ((match = regex.exec(line))) {
      const start = match.index + match[1].length;
      const end = start + match[2].length;
      const immediatePrefix = line.slice(Math.max(0, start - 38), start);
      if (immediateNonPhoneCue.test(immediatePrefix)) continue;
      const context = line.slice(Math.max(0, start - 90), Math.min(line.length, end + 45));
      if (!positiveCue.test(context)) continue;
      const phone = normalizeContextPhone(match[2]);
      if (phone) return phone;
    }
  }
  return null;
}

function contextualPhoneFromRow(row, excludedIndexes = []) {
  const excluded = new Set(excludedIndexes.filter((value) => Number.isInteger(value) && value >= 0));
  for (let index = 0; index < (row || []).length; index++) {
    if (excluded.has(index)) continue;
    const phone = contextualPhoneFromText(row[index]);
    if (phone) return phone;
  }
  return null;
}

async function recoverContextualPhones(sheetUrl, options = {}) {
  const adapter = leadEnrichment.adapterFor(sheetUrl, options.provider);
  let layout;
  try { layout = await adapter.inspect(sheetUrl); } catch { return { recovered: 0, skipped: true }; }
  if (!layout || layout.phoneColumnIndex < 0 || layout.linkedinColumnIndex < 0) return { recovered: 0, skipped: true };

  let data;
  try { data = await adapter.readSheet(sheetUrl, layout); } catch { return { recovered: 0, skipped: true }; }

  const changes = [];
  let recovered = 0;
  const firstDataIndex = Number(layout.headerRowIndex || 0) + 1;
  for (let index = firstDataIndex; index < (data.rows || []).length; index++) {
    const row = data.rows[index] || [];
    const rawLinkedIn = row[layout.linkedinColumnIndex];
    if (!rawLinkedIn || !String(rawLinkedIn).trim()) continue;
    if (!adapter.isBlank(row[layout.phoneColumnIndex])) continue;
    const phone = contextualPhoneFromRow(row, [layout.phoneColumnIndex, layout.linkedinColumnIndex]);
    if (!phone) continue;
    changes.push({ range: adapter.cellRange(layout.sheetName, index + 1, layout.phoneColumnIndex), value: phone });
    recovered++;
  }

  for (let index = 0; index < changes.length; index += 40) {
    await adapter.writeCells(layout.spreadsheetId, changes.slice(index, index + 40));
  }
  return { recovered, skipped: false };
}

function jobTargetKey(job) {
  if (!job) return '';
  const source = String(job.spreadsheetId || job.sheetUrl || '').trim();
  return `${job.provider || 'google'}|${source}|${job.sheetName || ''}`;
}

function jobTime(job) {
  const value = Date.parse(job?.createdAt || job?.updatedAt || '');
  return Number.isFinite(value) ? value : 0;
}

function hasMeaningfulStats(job) {
  if (!job?.stats) return false;
  const keys = ['scannedRows', 'enrichedProfiles', 'cachedProfiles', 'sheetEmailsRecovered', 'sheetPhonesRecovered', 'contextualPhonesRecovered', 'emailsWritten', 'phonesWritten', 'pendingPhones', 'skippedComplete'];
  return keys.some((key) => Number(job.stats?.[key] || 0) > 0);
}

function rowIdentity(key, row) {
  const rowNumber = row?.rowNumber ?? key;
  const linkedin = String(row?.linkedinUrl || '').trim().toLowerCase();
  return `${rowNumber}|${linkedin}`;
}

function campaignJobs(anchor, state = leadEnrichment.loadState()) {
  if (!anchor) return [];
  const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
  const key = jobTargetKey(anchor);
  const anchorTime = jobTime(anchor);
  const windowMs = CAMPAIGN_WINDOW_HOURS * 60 * 60 * 1000;
  return jobs.filter((job) => {
    if (jobTargetKey(job) !== key) return false;
    const time = jobTime(job);
    if (!anchorTime || !time) return true;
    return Math.abs(anchorTime - time) <= windowMs;
  });
}

function aggregateRows(jobs) {
  const latest = new Map();
  for (const job of jobs || []) {
    for (const [key, row] of Object.entries(job?.rows || {})) {
      if (!row) continue;
      latest.set(rowIdentity(key, row), row);
    }
  }
  return [...latest.values()];
}

function summarizeJob(job, now = Date.now(), options = {}) {
  if (!job) return null;
  const rows = Array.isArray(options.rows) ? options.rows : Object.values(job.rows || {});
  const metricJob = options.metricJob || job;
  const metricsAvailable = hasMeaningfulStats(metricJob);
  const pendingRows = rows.filter((row) => row?.phonePending);
  const resolvedRows = rows.filter((row) => row?.phoneResolved);
  const failedRows = rows.filter((row) => row?.error && !row?.phonePending && !row?.phoneResolved);
  const requestedRows = rows.filter((row) => row?.requestedAt || row?.phonePending || row?.phoneResolved);
  const stalePending = pendingRows.filter((row) => {
    const at = Date.parse(row?.requestedAt || '');
    return Number.isFinite(at) && now - at >= STALE_PENDING_MINUTES * 60_000;
  }).length;
  const metricPending = Number(metricJob?.stats?.pendingPhones || 0);
  const initialPending = Math.max(metricPending, requestedRows.length);

  return {
    jobId: job.id || null,
    metricJobId: metricJob?.id || null,
    provider: job.provider || metricJob?.provider || 'google',
    spreadsheetTitle: job.spreadsheetTitle || metricJob?.spreadsheetTitle || null,
    spreadsheetId: job.spreadsheetId || metricJob?.spreadsheetId || null,
    sheetUrl: job.sheetUrl || metricJob?.sheetUrl || null,
    sheetName: job.sheetName || metricJob?.sheetName || null,
    status: pendingRows.length ? 'waiting_for_phone_webhooks' : (job.status || metricJob?.status || null),
    metricsAvailable,
    reconstructedMetrics: Boolean(metricsAvailable && metricJob?.id && metricJob.id !== job.id),
    scannedRows: metricsAvailable ? Number(metricJob.stats?.scannedRows || 0) : null,
    liveCalls: metricsAvailable ? Number(metricJob.stats?.enrichedProfiles || 0) : null,
    cacheHits: metricsAvailable ? Number(metricJob.stats?.cachedProfiles || 0) : null,
    localEmails: metricsAvailable ? Number(metricJob.stats?.sheetEmailsRecovered || 0) : null,
    localPhones: metricsAvailable
      ? Number(metricJob.stats?.sheetPhonesRecovered || 0) + Number(metricJob.stats?.contextualPhonesRecovered || 0)
      : null,
    initialPending,
    pending: pendingRows.length,
    resolved: resolvedRows.length,
    resolvedWithPhone: resolvedRows.filter((row) => Boolean(String(row?.phone || '').trim())).length,
    resolvedNoPhone: resolvedRows.filter((row) => !String(row?.phone || '').trim()).length,
    failed: failedRows.length,
    stalePending,
    createdAt: metricJob?.createdAt || job.createdAt || null,
    updatedAt: job.updatedAt || metricJob?.updatedAt || null,
  };
}

function latestJobSummary(state = leadEnrichment.loadState(), now = Date.now()) {
  const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
  const anchor = [...jobs].reverse().find((job) => job && (job.stats || Object.keys(job.rows || {}).length));
  if (!anchor) return null;
  const related = campaignJobs(anchor, state);
  const metricJob = [...related].reverse().find(hasMeaningfulStats) || anchor;
  return summarizeJob(anchor, now, { metricJob, rows: aggregateRows(related) });
}

function jobSummaryById(jobId, state = leadEnrichment.loadState()) {
  if (!jobId) return null;
  const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
  const anchor = jobs.find((job) => job?.id === jobId);
  if (!anchor) return null;
  const related = campaignJobs(anchor, state);
  return summarizeJob(anchor, Date.now(), { metricJob: anchor, rows: aggregateRows(related) });
}

function cellState(value) {
  const text = String(value ?? '').trim();
  if (!text) return 'blank';
  if (text.toLowerCase() === 'null') return 'no_data';
  return 'found';
}

async function currentSheetCoverage(summary) {
  if (!summary?.sheetUrl) return null;
  try {
    const adapter = leadEnrichment.adapterFor(summary.sheetUrl, summary.provider);
    const layout = await adapter.inspect(summary.sheetUrl);
    const data = await adapter.readSheet(summary.sheetUrl, layout);
    const result = {
      linkedinRows: 0,
      phone: { found: 0, noData: 0, blank: 0 },
      email: { found: 0, noData: 0, blank: 0 },
    };
    const start = Number(layout.headerRowIndex || 0) + 1;
    for (let index = start; index < (data.rows || []).length; index++) {
      const row = data.rows[index] || [];
      const linkedin = String(row[layout.linkedinColumnIndex] ?? '').trim();
      if (!linkedin) continue;
      result.linkedinRows++;
      if (layout.phoneColumnIndex >= 0) {
        const state = cellState(row[layout.phoneColumnIndex]);
        if (state === 'found') result.phone.found++;
        else if (state === 'no_data') result.phone.noData++;
        else result.phone.blank++;
      }
      if (layout.emailColumnIndex >= 0) {
        const state = cellState(row[layout.emailColumnIndex]);
        if (state === 'found') result.email.found++;
        else if (state === 'no_data') result.email.noData++;
        else result.email.blank++;
      }
    }
    return result;
  } catch (error) {
    return { error: error.message };
  }
}

function providerLabel(provider) {
  if (provider === 'microsoft') return 'OneDrive/Excel';
  if (provider === 'local-excel') return 'attached Excel';
  return 'Google Sheets';
}

function buildStatusText(runtime, summary, sync = {}, coverage = null) {
  const googleReady = Boolean(runtime?.providers?.google);
  const microsoftReady = Boolean(runtime?.providers?.microsoft);
  const localReady = Boolean(runtime?.providers?.localExcel);
  const apolloReady = Boolean(runtime?.apollo?.apiKeyReady && runtime?.apollo?.webhookReady);
  let text = `Lead enrichment: Google Sheets ${googleReady ? 'ready' : 'not ready'}; OneDrive/Excel ${microsoftReady ? 'ready' : 'not ready'}; attached Excel ${localReady ? 'ready' : 'not ready'}; Apollo ${apolloReady ? 'configured' : 'not fully configured'}.`;

  if (summary) {
    const location = [summary.spreadsheetTitle, summary.sheetName].filter(Boolean).join(' / ') || providerLabel(summary.provider);
    text += ` Current target ${location}.`;
    if (summary.metricsAvailable) {
      text += ` Enrichment run: ${summary.scannedRows} LinkedIn rows checked; local-first recovered ${summary.localEmails} emails and ${summary.localPhones} phones; Apollo live calls ${summary.liveCalls}, cache hits ${summary.cacheHits}.`;
      if (summary.reconstructedMetrics) text += ' Run metrics were recovered from the matching completed job instead of showing false zeroes from a callback-only/legacy job.';
    } else {
      text += ' Detailed run counters were not recorded for this legacy job, so ULTRON will not invent zeroes.';
    }

    text += ` Phone verification: ${summary.initialPending} unique phone checks tracked; ${summary.resolved} resolved, ${summary.pending} pending.`;
    if (summary.resolved) text += ` Of the resolved checks, ${summary.resolvedWithPhone} returned a phone and ${summary.resolvedNoPhone} confirmed no phone.`;
    if (summary.failed) text += ` ${summary.failed} failed row${summary.failed === 1 ? '' : 's'} remain untouched.`;
    if (summary.stalePending) text += ` ${summary.stalePending} phone check${summary.stalePending === 1 ? '' : 's'} have been pending over ${STALE_PENDING_MINUTES} minutes and may need an approved retry.`;
  } else {
    text += ` Pending phone checks: ${runtime?.pendingPhones || 0}.`;
  }

  if (coverage && !coverage.error) {
    text += ` Current sheet coverage: phone ${coverage.phone.found} found, ${coverage.phone.noData} confirmed no-data, ${coverage.phone.blank} blank; email ${coverage.email.found} found, ${coverage.email.noData} confirmed no-data, ${coverage.email.blank} blank across ${coverage.linkedinRows} LinkedIn rows.`;
  } else if (coverage?.error) {
    text += ` Current sheet coverage could not be read just now: ${coverage.error}.`;
  }

  if (sync?.error) {
    text += ` Webhook sync failed: ${sync.error}. No spreadsheet cells were overwritten because of that sync failure.`;
  } else if (Number(sync?.received || 0) > 0 || Number(sync?.resolved || 0) > 0) {
    text += ` This check processed ${Number(sync.resolved || 0)} newly available callback result${Number(sync.resolved || 0) === 1 ? '' : 's'}.`;
  } else {
    text += ' No new phone callback arrived in this sync.';
  }

  text += ' This status/sync made 0 new Apollo enrichment calls. Explicit approval remains mandatory before any fresh Apollo lookup or retry.';
  return text;
}

function responseShape(text, summary, sync, coverage) {
  return {
    ok: true,
    response: text,
    text,
    model: 'apollo-progress-monitor',
    provider: 'local-webhook-status',
    taskType: 'lead-enrichment-status',
    mode: 'operator',
    toolRounds: 0,
    apolloCalled: false,
    enrichmentProgress: summary,
    sheetCoverage: coverage,
    phoneSync: sync,
  };
}

async function liveStatus() {
  let sync;
  try {
    sync = await leadEnrichment.syncPhoneResults({ quiet: true });
  } catch (error) {
    sync = { received: 0, resolved: 0, pending: leadEnrichment.pendingCount(), error: error.message };
  }
  if (leadEnrichment.pendingCount()) leadEnrichment.startPhoneWatcher();
  const runtime = leadEnrichment.status();
  const summary = latestJobSummary();
  const coverage = await currentSheetCoverage(summary);
  return { runtime, summary, coverage, sync, text: buildStatusText(runtime, summary, sync, coverage) };
}

async function syncCurrentJob(stats) {
  if (!stats?.jobId || !stats.pendingPhones) return stats;
  const initialPending = Number(stats.pendingPhones || 0);
  let sync = null;
  try { sync = await leadEnrichment.syncPhoneResults({ quiet: true }); } catch {}
  const summary = jobSummaryById(stats.jobId);
  stats.pendingPhonesInitial = initialPending;
  stats.pendingPhonesCurrent = summary ? summary.pending : initialPending;
  stats.phoneCallbacksProcessed = summary ? summary.resolved : 0;
  stats.phoneCallbacksFound = summary ? summary.resolvedWithPhone : 0;
  stats.phoneCallbacksNoPhone = summary ? summary.resolvedNoPhone : 0;
  stats.postRunPhoneSync = sync;
  return stats;
}

function install() {
  if (installed) return { installed: true, alreadyInstalled: true };

  originalEnrichSheet = leadEnrichment.enrichSheet;
  originalFormatResult = leadEnrichment.formatResult;
  leadEnrichment.enrichSheet = async (sheetUrl, options = {}) => {
    let contextual = { recovered: 0, skipped: true };
    try { contextual = await recoverContextualPhones(sheetUrl, options); } catch {}
    const stats = await originalEnrichSheet(sheetUrl, options);
    stats.contextualPhonesRecovered = contextual.recovered || 0;
    await syncCurrentJob(stats);
    return stats;
  };

  leadEnrichment.formatResult = (stats) => {
    const currentPending = Number.isFinite(Number(stats.pendingPhonesCurrent)) ? Number(stats.pendingPhonesCurrent) : Number(stats.pendingPhones || 0);
    const displayStats = { ...stats, pendingPhones: currentPending };
    let text = originalFormatResult(displayStats);
    if (stats.contextualPhonesRecovered) text += ` Preflight recovered ${stats.contextualPhonesRecovered} extra phone${stats.contextualPhonesRecovered === 1 ? '' : 's'} from contact-context text before Apollo.`;
    const initialPending = Number(stats.pendingPhonesInitial || stats.pendingPhones || 0);
    const processed = Math.max(0, initialPending - currentPending);
    if (processed) {
      text += ` Live callback refresh already processed ${processed} of the ${initialPending} originally queued phone checks before this response`;
      if (stats.phoneCallbacksFound || stats.phoneCallbacksNoPhone) text += ` (${stats.phoneCallbacksFound || 0} phones found, ${stats.phoneCallbacksNoPhone || 0} confirmed no phone)`;
      text += '.';
    } else if (currentPending) {
      text += ' “Enrichment status” refreshes webhook results and reads current sheet coverage before reporting progress.';
    }
    return text;
  };

  const assistant = require('./assistant');
  const conversation = require('./conversation');
  const voice = require('./voice-orchestrator');
  originalHandle = assistant.handle;

  assistant.handle = async (message, options = {}) => {
    const text = String(message || '').trim();
    if (!isStatusRequest(text) && !isFreePhoneSyncRequest(text)) return originalHandle(message, options);
    const inputMode = String(options.inputMode || 'chat').toLowerCase() === 'voice' ? 'voice' : 'chat';
    const status = await liveStatus();
    const result = responseShape(status.text, status.summary, status.sync, status.coverage);
    conversation.append('user', text, { taskType: 'lead-enrichment-status', inputMode });
    conversation.append('assistant', result.text, { model: result.model, provider: result.provider, taskType: result.taskType, inputMode, ok: true });
    void voice.enqueue(result.text);
    return { ...result, inputMode };
  };

  installed = true;
  return { installed: true, liveStatus: true, contextualPhoneRecovery: true, approvalFreeWebhookSync: true, postRunCallbackSync: true, campaignAwareStatus: true, liveSheetCoverage: true };
}

function uninstall() {
  if (!installed) return;
  const assistant = require('./assistant');
  if (originalHandle) assistant.handle = originalHandle;
  if (originalEnrichSheet) leadEnrichment.enrichSheet = originalEnrichSheet;
  if (originalFormatResult) leadEnrichment.formatResult = originalFormatResult;
  originalHandle = null;
  originalEnrichSheet = null;
  originalFormatResult = null;
  installed = false;
}

module.exports = {
  STALE_PENDING_MINUTES,
  CAMPAIGN_WINDOW_HOURS,
  install,
  uninstall,
  isStatusRequest,
  isFreePhoneSyncRequest,
  normalizeContextPhone,
  contextualPhoneFromText,
  contextualPhoneFromRow,
  recoverContextualPhones,
  jobTargetKey,
  hasMeaningfulStats,
  aggregateRows,
  summarizeJob,
  latestJobSummary,
  jobSummaryById,
  cellState,
  currentSheetCoverage,
  buildStatusText,
  liveStatus,
  syncCurrentJob,
};
