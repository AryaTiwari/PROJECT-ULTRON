const leadEnrichment = require('./lead-enrichment-operator');
const progress = require('./lead-enrichment-progress');

let installed = false;
let originalHandle = null;

const SETTLE_DELAY_MS = 800;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStatusLike(text) {
  return progress.isStatusRequest(text) || progress.isFreePhoneSyncRequest(text);
}

function coverageFingerprint(coverage) {
  if (!coverage || coverage.error) return 'unavailable';
  return [
    coverage.linkedinRows || 0,
    coverage.phone?.found || 0,
    coverage.phone?.noData || 0,
    coverage.phone?.blank || 0,
    coverage.email?.found || 0,
    coverage.email?.noData || 0,
    coverage.email?.blank || 0,
  ].join('|');
}

function combineSync(first = {}, second = {}) {
  const errors = [first.error, second.error].filter(Boolean);
  return {
    received: Number(first.received || 0) + Number(second.received || 0),
    resolved: Number(first.resolved || 0) + Number(second.resolved || 0),
    pending: Number.isFinite(Number(second.pending)) ? Number(second.pending) : Number(first.pending || 0),
    error: errors.length ? errors.join(' | ') : null,
  };
}

function sameTarget(job, summary) {
  if (!job || !summary) return false;
  if (String(job.provider || 'google') !== String(summary.provider || 'google')) return false;
  if (summary.spreadsheetId && job.spreadsheetId && String(job.spreadsheetId) !== String(summary.spreadsheetId)) return false;
  if (summary.sheetName && job.sheetName && String(job.sheetName) !== String(summary.sheetName)) return false;
  if (!summary.spreadsheetId && summary.sheetUrl && job.sheetUrl && String(job.sheetUrl) !== String(summary.sheetUrl)) return false;
  return Boolean(job.spreadsheetId || job.sheetUrl);
}

function pendingRowNumbers(summary, state = leadEnrichment.loadState()) {
  const result = new Set();
  for (const job of state.jobs || []) {
    if (!sameTarget(job, summary)) continue;
    for (const [key, row] of Object.entries(job.rows || {})) {
      if (!row?.phonePending) continue;
      const rowNumber = Number(row.rowNumber || key);
      if (Number.isFinite(rowNumber) && rowNumber > 0) result.add(rowNumber);
    }
  }
  return result;
}

function leadName(row, rowNumber, linkedinColumnIndex) {
  for (let index = 0; index < (row || []).length; index++) {
    if (index === linkedinColumnIndex) continue;
    const value = String(row[index] ?? '').trim();
    if (!value || /^null$/i.test(value)) continue;
    if (/linkedin\.com\//i.test(value)) continue;
    if (value.length <= 120 && !/\n/.test(value)) return value;
  }
  return `row ${rowNumber}`;
}

async function diagnoseBlankPhones(summary) {
  if (!summary?.sheetUrl) return null;
  try {
    const adapter = leadEnrichment.adapterFor(summary.sheetUrl, summary.provider);
    const layout = await adapter.inspect(summary.sheetUrl);
    if (layout.phoneColumnIndex < 0 || layout.linkedinColumnIndex < 0) return null;
    const data = await adapter.readSheet(summary.sheetUrl, layout);
    const pendingRows = pendingRowNumbers(summary);
    const blanks = [];
    const start = Number(layout.headerRowIndex || 0) + 1;

    for (let index = start; index < (data.rows || []).length; index++) {
      const row = data.rows[index] || [];
      const linkedin = String(row[layout.linkedinColumnIndex] ?? '').trim();
      if (!linkedin) continue;
      if (!adapter.isBlank(row[layout.phoneColumnIndex])) continue;
      const rowNumber = index + 1;
      blanks.push({
        rowNumber,
        name: leadName(row, rowNumber, layout.linkedinColumnIndex),
        pending: pendingRows.has(rowNumber),
      });
    }

    return {
      total: blanks.length,
      pending: blanks.filter((item) => item.pending),
      untracked: blanks.filter((item) => !item.pending),
      rows: blanks,
    };
  } catch (error) {
    return { error: error.message };
  }
}

function names(items, limit = 8) {
  const values = (items || []).slice(0, limit).map((item) => `${item.name} (row ${item.rowNumber})`);
  if ((items || []).length > limit) values.push(`+${items.length - limit} more`);
  return values.join(', ');
}

function appendDiagnosis(text, diagnosis, refreshed) {
  let output = String(text || '');
  if (refreshed) output += ' Background callback writes were still settling during the first read, so ULTRON refreshed the sheet before reporting the final snapshot.';
  if (!diagnosis || diagnosis.error) {
    if (diagnosis?.error) output += ` Blank-phone diagnosis could not be read: ${diagnosis.error}.`;
    return output;
  }
  if (!diagnosis.total) return `${output} No phone cells remain blank in the current target.`;

  output += ` Blank-phone diagnosis: ${diagnosis.total} row${diagnosis.total === 1 ? '' : 's'} remain blank.`;
  if (diagnosis.pending.length) output += ` Active Apollo callback${diagnosis.pending.length === 1 ? '' : 's'}: ${names(diagnosis.pending)}.`;
  if (diagnosis.untracked.length) output += ` Not actively pending and therefore candidates for an approved retry: ${names(diagnosis.untracked)}.`;
  return output;
}

async function stableStatus() {
  const first = await progress.liveStatus();
  let final = first;
  let combinedSync = first.sync || {};
  let refreshed = false;

  const shouldSettle = Boolean(
    first.summary?.pending
    || first.coverage?.phone?.blank
    || Number(first.sync?.received || 0)
    || Number(first.sync?.resolved || 0)
  );

  if (shouldSettle) {
    await sleep(SETTLE_DELAY_MS);
    const second = await progress.liveStatus();
    refreshed = coverageFingerprint(first.coverage) !== coverageFingerprint(second.coverage);
    combinedSync = combineSync(first.sync, second.sync);
    final = second;
  }

  const diagnosis = await diagnoseBlankPhones(final.summary);
  const baseText = progress.buildStatusText(final.runtime, final.summary, combinedSync, final.coverage);
  const text = appendDiagnosis(baseText, diagnosis, refreshed);
  return { ...final, sync: combinedSync, diagnosis, refreshed, text };
}

function responseShape(status) {
  return {
    ok: true,
    response: status.text,
    text: status.text,
    model: 'apollo-stable-progress-monitor',
    provider: 'local-webhook-status',
    taskType: 'lead-enrichment-status',
    mode: 'operator',
    toolRounds: 0,
    apolloCalled: false,
    enrichmentProgress: status.summary,
    sheetCoverage: status.coverage,
    phoneSync: status.sync,
    blankPhoneDiagnosis: status.diagnosis,
    snapshotRefreshed: status.refreshed,
  };
}

function install() {
  if (installed) return { installed: true, alreadyInstalled: true };
  const assistant = require('./assistant');
  const conversation = require('./conversation');
  const voice = require('./voice-orchestrator');
  originalHandle = assistant.handle;

  assistant.handle = async (message, options = {}) => {
    const text = String(message || '').trim();
    if (!isStatusLike(text)) return originalHandle(message, options);
    const inputMode = String(options.inputMode || 'chat').toLowerCase() === 'voice' ? 'voice' : 'chat';
    const status = await stableStatus();
    const result = responseShape(status);
    conversation.append('user', text, { taskType: 'lead-enrichment-status', inputMode });
    conversation.append('assistant', result.text, { model: result.model, provider: result.provider, taskType: result.taskType, inputMode, ok: true });
    void voice.enqueue(result.text);
    return { ...result, inputMode };
  };

  installed = true;
  return { installed: true, stableSnapshot: true, blankPhoneDiagnosis: true, settleDelayMs: SETTLE_DELAY_MS };
}

function uninstall() {
  if (!installed) return;
  const assistant = require('./assistant');
  if (originalHandle) assistant.handle = originalHandle;
  originalHandle = null;
  installed = false;
}

module.exports = {
  SETTLE_DELAY_MS,
  install,
  uninstall,
  isStatusLike,
  coverageFingerprint,
  combineSync,
  sameTarget,
  pendingRowNumbers,
  leadName,
  diagnoseBlankPhones,
  appendDiagnosis,
  stableStatus,
};
