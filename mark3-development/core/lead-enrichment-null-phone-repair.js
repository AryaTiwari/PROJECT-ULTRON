const leadEnrichment = require('./lead-enrichment-operator');
const progress = require('./lead-enrichment-progress');

let installed = false;
let originalEnrichSheet = null;
let originalFormatResult = null;
let originalHandle = null;

function isNullSentinel(value) {
  return String(value ?? '').trim().toLowerCase() === 'null';
}

function phoneCellNeedsLocalRepair(value, adapter) {
  return Boolean(adapter?.isBlank?.(value) || isNullSentinel(value));
}

function localPhoneCandidate(row, layout) {
  if (!layout) return null;
  const excluded = [layout.phoneColumnIndex, layout.linkedinColumnIndex]
    .filter((value) => Number.isInteger(value) && value >= 0);
  return leadEnrichment.extractRowPhone(row, excluded)
    || progress.contextualPhoneFromRow(row, excluded)
    || null;
}

async function repairLocalPhones(sheetUrl, options = {}) {
  if (!sheetUrl) return { repaired: 0, nullsReplaced: 0, blanksFilled: 0, skipped: true };
  const adapter = leadEnrichment.adapterFor(sheetUrl, options.provider);
  let layout;
  try { layout = await adapter.inspect(sheetUrl); } catch { return { repaired: 0, nullsReplaced: 0, blanksFilled: 0, skipped: true }; }
  if (!layout || layout.phoneColumnIndex < 0 || layout.linkedinColumnIndex < 0) {
    return { repaired: 0, nullsReplaced: 0, blanksFilled: 0, skipped: true };
  }

  let data;
  try { data = await adapter.readSheet(sheetUrl, layout); } catch { return { repaired: 0, nullsReplaced: 0, blanksFilled: 0, skipped: true }; }

  const changes = [];
  let nullsReplaced = 0;
  let blanksFilled = 0;
  const start = Number(layout.headerRowIndex || 0) + 1;

  for (let index = start; index < (data.rows || []).length; index++) {
    const row = data.rows[index] || [];
    const rawLinkedIn = String(row[layout.linkedinColumnIndex] ?? '').trim();
    if (!rawLinkedIn) continue;

    const currentPhone = row[layout.phoneColumnIndex];
    if (!phoneCellNeedsLocalRepair(currentPhone, adapter)) continue;

    const phone = localPhoneCandidate(row, layout);
    if (!phone) continue;

    changes.push({
      range: adapter.cellRange(layout.sheetName, index + 1, layout.phoneColumnIndex),
      value: phone,
    });
    if (isNullSentinel(currentPhone)) nullsReplaced++;
    else blanksFilled++;
  }

  for (let index = 0; index < changes.length; index += 40) {
    await adapter.writeCells(layout.spreadsheetId, changes.slice(index, index + 40));
  }

  return {
    repaired: changes.length,
    nullsReplaced,
    blanksFilled,
    skipped: false,
  };
}

function isStatusLike(text) {
  return progress.isStatusRequest(text) || progress.isFreePhoneSyncRequest(text);
}

async function repairLatestTarget() {
  const summary = progress.latestJobSummary();
  if (!summary?.sheetUrl) return { repaired: 0, nullsReplaced: 0, blanksFilled: 0, skipped: true };
  return repairLocalPhones(summary.sheetUrl, { provider: summary.provider });
}

function install() {
  if (installed) return { installed: true, alreadyInstalled: true };

  originalEnrichSheet = leadEnrichment.enrichSheet;
  originalFormatResult = leadEnrichment.formatResult;

  leadEnrichment.enrichSheet = async (sheetUrl, options = {}) => {
    let repair = { repaired: 0, nullsReplaced: 0, blanksFilled: 0, skipped: true };
    try { repair = await repairLocalPhones(sheetUrl, options); } catch {}
    const stats = await originalEnrichSheet(sheetUrl, options);
    stats.localPhoneRepair = repair;
    stats.localNullPhonesRepaired = Number(repair.nullsReplaced || 0);
    stats.localBlankPhonesRecoveredByRepair = Number(repair.blanksFilled || 0);
    return stats;
  };

  leadEnrichment.formatResult = (stats) => {
    let text = originalFormatResult(stats);
    const nulls = Number(stats?.localNullPhonesRepaired || 0);
    const blanks = Number(stats?.localBlankPhonesRecoveredByRepair || 0);
    if (nulls || blanks) {
      const parts = [];
      if (nulls) parts.push(`replaced ${nulls} stale null phone cell${nulls === 1 ? '' : 's'} with number${nulls === 1 ? '' : 's'} already present in post details`);
      if (blanks) parts.push(`filled ${blanks} blank phone cell${blanks === 1 ? '' : 's'} from post details`);
      text += ` Local phone repair ${parts.join(' and ')} before any Apollo lookup.`;
    }
    return text;
  };

  const assistant = require('./assistant');
  originalHandle = assistant.handle;
  assistant.handle = async (message, options = {}) => {
    const text = String(message || '').trim();
    if (isStatusLike(text)) {
      try { await repairLatestTarget(); } catch {}
    }
    return originalHandle(message, options);
  };

  installed = true;
  return {
    installed: true,
    repairsNullSentinels: true,
    repairsBlankPhones: true,
    localOnly: true,
    apolloCalls: 0,
  };
}

function uninstall() {
  if (!installed) return;
  if (originalEnrichSheet) leadEnrichment.enrichSheet = originalEnrichSheet;
  if (originalFormatResult) leadEnrichment.formatResult = originalFormatResult;
  const assistant = require('./assistant');
  if (originalHandle) assistant.handle = originalHandle;
  originalEnrichSheet = null;
  originalFormatResult = null;
  originalHandle = null;
  installed = false;
}

module.exports = {
  install,
  uninstall,
  isNullSentinel,
  phoneCellNeedsLocalRepair,
  localPhoneCandidate,
  repairLocalPhones,
  repairLatestTarget,
  isStatusLike,
};
