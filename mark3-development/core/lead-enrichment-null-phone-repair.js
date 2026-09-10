const leadEnrichment = require('./lead-enrichment-operator');
const progress = require('./lead-enrichment-progress');

let installed = false;
let originalEnrichSheet = null;
let originalFormatResult = null;
let originalHandle = null;

const CONTENT_HEADER_ALIASES = new Set([
  'post details', 'post detail', 'post content', 'post text', 'post', 'job post', 'job posting',
  'job details', 'job detail', 'job description', 'job description details', 'jd', 'description',
  'details', 'content', 'source text', 'linkedin post', 'linkedin post details', 'posting details',
  'notes', 'remarks', 'raw text', 'job content', 'recruiter post', 'requirement details',
]);

function normalizeHeader(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[._/\\-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNullSentinel(value) {
  return String(value ?? '').trim().toLowerCase() === 'null';
}

function isTrulyBlank(value) {
  return value == null || String(value).trim() === '';
}

function phoneCellNeedsLocalRepair(value, adapter) {
  return Boolean(isTrulyBlank(value) || isNullSentinel(value) || adapter?.isBlank?.(value));
}

function contentHeaderScore(value) {
  const header = normalizeHeader(value);
  if (!header) return 0;
  if (/\b(?:phone|mobile|email|linkedin|name|company|status|salary|ctc|budget|id|identifier)\b/.test(header)) return 0;
  if (CONTENT_HEADER_ALIASES.has(header)) return 100;
  if (/\b(?:post|posting|job|requirement|recruiter)\b/.test(header) && /\b(?:detail|description|content|text|note|remark)\b/.test(header)) return 92;
  if (/\b(?:description|details|content|notes|remarks|text)\b/.test(header)) return 75;
  return 0;
}

function inferredContentColumns(rows, layout) {
  const headerIndex = Number(layout?.headerRowIndex || 0);
  const header = rows?.[headerIndex] || [];
  const excluded = new Set([
    layout?.phoneColumnIndex,
    layout?.emailColumnIndex,
    layout?.linkedinColumnIndex,
  ].filter((value) => Number.isInteger(value) && value >= 0));

  const explicit = header
    .map((value, index) => ({ index, score: excluded.has(index) ? 0 : contentHeaderScore(value) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (explicit.length) return explicit.slice(0, 4).map((item) => item.index);

  const maxColumns = Math.min(200, Math.max(header.length, ...(rows || []).slice(headerIndex + 1, headerIndex + 31).map((row) => (row || []).length), 0));
  const inferred = [];
  for (let column = 0; column < maxColumns; column++) {
    if (excluded.has(column)) continue;
    let populated = 0;
    let longText = 0;
    let newlineText = 0;
    let totalChars = 0;
    for (let rowIndex = headerIndex + 1; rowIndex < Math.min((rows || []).length, headerIndex + 31); rowIndex++) {
      const value = String(rows?.[rowIndex]?.[column] ?? '').trim();
      if (!value || /^null$/i.test(value)) continue;
      populated++;
      totalChars += value.length;
      if (value.length >= 80) longText++;
      if (/\r?\n/.test(value)) newlineText++;
    }
    if (!populated) continue;
    const averageLength = totalChars / populated;
    if (longText < 2 && newlineText < 2 && averageLength < 120) continue;
    inferred.push({
      index: column,
      score: longText * 6 + newlineText * 3 + averageLength / 40,
    });
  }
  return inferred.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 3).map((item) => item.index);
}

function normalizePhoneToken(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const extensionMatch = raw.match(/(?:ext(?:ension)?\.?|x)\s*(\d{1,6})\s*$/i);
  const extension = extensionMatch?.[1] || '';
  const main = extensionMatch ? raw.slice(0, extensionMatch.index).trim() : raw;
  const hasPlus = /^\s*\+/.test(main);
  const digits = main.replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}${extension ? `ext${extension}` : ''}`;
  if (digits.length === 12 && /^91[6-9]/.test(digits)) return `+${digits}${extension ? `ext${extension}` : ''}`;
  if (digits.length < 10 || digits.length > 15) return null;
  const normalized = hasPlus ? `+${digits}` : digits;
  return `${normalized}${extension ? `ext${extension}` : ''}`;
}

function candidateScore(line, start, end, raw, phone, isContentColumn) {
  const before = line.slice(Math.max(0, start - 70), start);
  const around = line.slice(Math.max(0, start - 100), Math.min(line.length, end + 70));
  const hardCue = /\b(?:phone|mobile|whats?app|contact|call|telephone|tel)\b|📞|📱/i;
  const softCue = /\b(?:dm|reach(?:\s+me)?|send|share|resume|cv|profile|apply|interested|mail|email)\b|📩|📧/i;
  const negativeImmediate = /\b(?:salary|ctc|budget|rate|job\s*id|job\s*no|req(?:uisition)?\s*id|reference\s*id|ref\s*id|pincode|pin\s*code|aadhaar|pan\s*(?:no|number)?|experience|exp|openings?)\s*[:#\-–—]?\s*$/i;

  if (negativeImmediate.test(before) && !hardCue.test(around)) return -100;

  let score = 0;
  if (isContentColumn) score += 3;
  if (hardCue.test(around)) score += 8;
  else if (softCue.test(around)) score += 4;
  if (/^\s*\+/.test(raw)) score += 4;
  const mainDigits = String(phone || '').replace(/ext\d+$/i, '').replace(/\D/g, '');
  if ((mainDigits.length === 12 && /^91[6-9]/.test(mainDigits)) || (mainDigits.length === 10 && /^[6-9]/.test(mainDigits))) score += 3;
  if (/ext\d+$/i.test(phone || '')) score += 2;
  return score;
}

function phoneCandidateFromText(value, options = {}) {
  const text = String(value || '');
  let best = null;
  for (const line of text.split(/\r?\n/)) {
    const regex = /(^|[^\d])(\+?\d(?:[\s().-]*\d){8,14}(?:\s*(?:ext(?:ension)?\.?|x)\s*\d{1,6})?)(?!\d)/ig;
    let match;
    while ((match = regex.exec(line))) {
      const raw = match[2].trim();
      const phone = normalizePhoneToken(raw);
      if (!phone) continue;
      const start = match.index + match[1].length;
      const end = start + raw.length;
      const score = candidateScore(line, start, end, raw, phone, Boolean(options.isContentColumn));
      if (score < 6) continue;
      if (!best || score > best.score) best = { phone, score, raw };
    }
  }
  return best;
}

function localPhoneCandidate(row, layout, evidenceIndexes = []) {
  if (!layout) return null;
  const excluded = new Set([
    layout.phoneColumnIndex,
    layout.emailColumnIndex,
    layout.linkedinColumnIndex,
  ].filter((value) => Number.isInteger(value) && value >= 0));

  const preferred = [...new Set((evidenceIndexes || []).filter((index) => Number.isInteger(index) && index >= 0 && !excluded.has(index)))];
  let best = null;
  for (const index of preferred) {
    const candidate = phoneCandidateFromText(row?.[index], { isContentColumn: true });
    if (candidate && (!best || candidate.score > best.score)) best = candidate;
  }
  if (best) return best.phone;

  for (let index = 0; index < (row || []).length; index++) {
    if (excluded.has(index) || preferred.includes(index)) continue;
    const candidate = phoneCandidateFromText(row[index], { isContentColumn: false });
    if (candidate && (!best || candidate.score > best.score)) best = candidate;
  }
  return best?.phone || null;
}

async function repairLocalPhones(sheetUrl, options = {}) {
  if (!sheetUrl) return { repaired: 0, nullsReplaced: 0, blanksFilled: 0, skipped: true, evidenceColumns: [] };
  const adapter = leadEnrichment.adapterFor(sheetUrl, options.provider);
  let layout;
  try { layout = await adapter.inspect(sheetUrl); } catch { return { repaired: 0, nullsReplaced: 0, blanksFilled: 0, skipped: true, evidenceColumns: [] }; }
  if (!layout || layout.phoneColumnIndex < 0 || layout.linkedinColumnIndex < 0) {
    return { repaired: 0, nullsReplaced: 0, blanksFilled: 0, skipped: true, evidenceColumns: [] };
  }

  let data;
  try { data = await adapter.readSheet(sheetUrl, layout); } catch { return { repaired: 0, nullsReplaced: 0, blanksFilled: 0, skipped: true, evidenceColumns: [] }; }

  const evidenceColumns = inferredContentColumns(data.rows || [], layout);
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

    const phone = localPhoneCandidate(row, layout, evidenceColumns);
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
    evidenceColumns,
  };
}

function isStatusLike(text) {
  return progress.isStatusRequest(text) || progress.isFreePhoneSyncRequest(text);
}

async function repairLatestTarget() {
  const summary = progress.latestJobSummary();
  if (!summary?.sheetUrl) return { repaired: 0, nullsReplaced: 0, blanksFilled: 0, skipped: true, evidenceColumns: [] };
  return repairLocalPhones(summary.sheetUrl, { provider: summary.provider });
}

function install() {
  if (installed) return { installed: true, alreadyInstalled: true };

  originalEnrichSheet = leadEnrichment.enrichSheet;
  originalFormatResult = leadEnrichment.formatResult;

  leadEnrichment.enrichSheet = async (sheetUrl, options = {}) => {
    let repair = { repaired: 0, nullsReplaced: 0, blanksFilled: 0, skipped: true, evidenceColumns: [] };
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
      if (nulls) parts.push(`replaced ${nulls} stale null phone cell${nulls === 1 ? '' : 's'} with number${nulls === 1 ? '' : 's'} already present in the sheet's post/details text`);
      if (blanks) parts.push(`filled ${blanks} blank phone cell${blanks === 1 ? '' : 's'} from the sheet's post/details text`);
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
    adaptiveContentColumns: true,
    crossSpreadsheetLayout: true,
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
  CONTENT_HEADER_ALIASES,
  install,
  uninstall,
  normalizeHeader,
  isNullSentinel,
  isTrulyBlank,
  phoneCellNeedsLocalRepair,
  contentHeaderScore,
  inferredContentColumns,
  normalizePhoneToken,
  candidateScore,
  phoneCandidateFromText,
  localPhoneCandidate,
  repairLocalPhones,
  repairLatestTarget,
  isStatusLike,
};
