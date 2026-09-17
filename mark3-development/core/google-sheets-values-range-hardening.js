'use strict';

// Universal enrichment deliberately asks Google Sheets for a wide schema-neutral
// range (for example `'Arya 2'!A:ZZ`). Some tabs have a much smaller physical
// grid and Google rejects the request instead of simply returning the populated
// cells. Recovery must not depend on workbook metadata because metadata itself can
// fail independently. We therefore use metadata when available, but fall back to
// a Values-API-only binary probe that discovers the last readable column.
//
// Google can also invalidate an access token before our local expires_at value.
// Values reads therefore get one forced OAuth refresh + retry on HTTP 401.

const sheets = require('./google-sheets-operator');
const auth = require('./google-sheets-auth');

const INSTALL_FLAG = Symbol.for('ultron.mark3.googleSheetsValuesRangeHardening.installed');
const state = {
  retries: 0,
  successes: 0,
  failures: 0,
  authRetries: 0,
  authRetrySuccesses: 0,
  authRetryFailures: 0,
  metadataAttempts: 0,
  metadataFailures: 0,
  probeCalls: 0,
  probeSuccesses: 0,
  lastOriginalRange: null,
  lastClampedRange: null,
  lastGrid: null,
  lastProbeColumn: null,
  lastStrategy: null,
  lastError: null,
};

function columnIndex(name) {
  const raw = String(name || '').trim().toUpperCase();
  if (!/^[A-Z]+$/.test(raw)) return -1;
  let value = 0;
  for (const char of raw) value = value * 26 + (char.charCodeAt(0) - 64);
  return value - 1;
}

function parseSheetRange(range) {
  const raw = String(range || '').trim();
  const bang = raw.lastIndexOf('!');
  if (bang <= 0) return null;
  let sheetPart = raw.slice(0, bang).trim();
  const gridPart = raw.slice(bang + 1).trim();
  if (sheetPart.startsWith("'") && sheetPart.endsWith("'")) {
    sheetPart = sheetPart.slice(1, -1).replace(/''/g, "'");
  }
  const match = gridPart.match(/^([A-Za-z]+)(\d*)\s*:\s*([A-Za-z]+)(\d*)$/);
  if (!match) return null;
  return {
    sheetName: sheetPart,
    startColumn: match[1].toUpperCase(),
    startRow: match[2] ? Number(match[2]) : null,
    endColumn: match[3].toUpperCase(),
    endRow: match[4] ? Number(match[4]) : null,
  };
}

function errorText(error) {
  let details = '';
  try { details = JSON.stringify(error?.googleDetails || []); } catch {}
  return `${String(error?.message || error || '')} ${details}`.toLowerCase();
}

function isUnauthorized(error) {
  return Number(error?.status) === 401 || String(error?.googleStatus || '').toUpperCase() === 'UNAUTHENTICATED';
}

function shouldRetry(error) {
  const combined = errorText(error);
  if (/range exceeds grid limits|exceeds grid limits|outside the sheet limits|range.*exceed|grid.*limit/.test(combined)) return true;
  return Number(error?.status) === 400 && /\brange\b/.test(combined) && /\b(?:grid|limit|column|row)\b/.test(combined);
}

function authRequiredError(cause) {
  const error = new Error('Google Sheets authorization is no longer valid. Re-authorize Google Sheets once.');
  error.code = 'GOOGLE_SHEETS_AUTH_REQUIRED';
  error.status = 401;
  error.cause = cause;
  error.reauthorizeCommand = 'node --env-file=../.env scripts\\google-sheets-auth.js';
  return error;
}

async function retryAfterUnauthorized(originalValues, id, range, firstError) {
  if (!isUnauthorized(firstError)) throw firstError;
  state.authRetries++;
  state.lastStrategy = 'oauth-force-refresh';
  state.lastError = String(firstError?.message || firstError || '').slice(0, 500);
  try {
    await auth.accessToken({ forceRefresh: true });
  } catch (refreshError) {
    state.authRetryFailures++;
    throw refreshError?.code ? refreshError : authRequiredError(refreshError);
  }
  try {
    const rows = await originalValues(id, range);
    state.authRetrySuccesses++;
    return rows;
  } catch (retryError) {
    state.authRetryFailures++;
    if (isUnauthorized(retryError)) throw authRequiredError(retryError);
    throw retryError;
  }
}

function clampRange(range, grid = {}) {
  const parsed = parseSheetRange(range);
  if (!parsed) return null;
  const maxColumns = Math.max(0, Number(grid.columnCount || 0));
  const maxRows = Math.max(0, Number(grid.rowCount || 0));
  if (!maxColumns) return null;

  const startColIndex = columnIndex(parsed.startColumn);
  const endColIndex = columnIndex(parsed.endColumn);
  if (startColIndex < 0 || startColIndex >= maxColumns || endColIndex < 0) return null;

  const clampedEndColIndex = Math.min(endColIndex, maxColumns - 1);
  let startRow = parsed.startRow;
  let endRow = parsed.endRow;
  if (maxRows) {
    if (startRow != null && startRow > maxRows) return null;
    if (endRow != null) endRow = Math.min(endRow, maxRows);
  }

  const startRef = `${parsed.startColumn}${startRow == null ? '' : startRow}`;
  const endRef = `${sheets.columnName(clampedEndColIndex)}${endRow == null ? '' : endRow}`;
  return `${sheets.quoteSheet(parsed.sheetName)}!${startRef}:${endRef}`;
}

function rangeWithEndColumn(parsed, endColumnIndex) {
  const startRef = `${parsed.startColumn}${parsed.startRow == null ? '' : parsed.startRow}`;
  const endRef = `${sheets.columnName(endColumnIndex)}${parsed.endRow == null ? '' : parsed.endRow}`;
  return `${sheets.quoteSheet(parsed.sheetName)}!${startRef}:${endRef}`;
}

function columnProbeRange(parsed, columnIndexValue) {
  const col = sheets.columnName(columnIndexValue);
  return `${sheets.quoteSheet(parsed.sheetName)}!${col}1:${col}1`;
}

async function lastReadableColumn(originalValues, id, parsed) {
  const lowBound = columnIndex(parsed.startColumn);
  const highBound = columnIndex(parsed.endColumn);
  if (lowBound < 0 || highBound < lowBound) return null;

  async function readable(index) {
    state.probeCalls++;
    state.lastProbeColumn = sheets.columnName(index);
    try {
      await originalValues(id, columnProbeRange(parsed, index));
      state.probeSuccesses++;
      return true;
    } catch (error) {
      if (!shouldRetry(error)) throw error;
      return false;
    }
  }

  if (!(await readable(lowBound))) return null;
  if (await readable(highBound)) return highBound;

  let lo = lowBound;
  let hi = highBound;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await readable(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

function reset() {
  for (const key of Object.keys(state)) {
    if (typeof state[key] === 'number') state[key] = 0;
    else state[key] = null;
  }
}

function snapshot() {
  return { ...state, lastGrid: state.lastGrid ? { ...state.lastGrid } : null };
}

async function retryWithMetadata(originalValues, originalMetadata, id, range, parsed) {
  state.metadataAttempts++;
  let meta;
  try {
    meta = await originalMetadata(id);
  } catch (error) {
    state.metadataFailures++;
    return { rows: null, error, retryable: true };
  }

  const target = (meta?.sheets || []).find((item) => String(item?.properties?.title || '').trim().toLowerCase() === parsed.sheetName.trim().toLowerCase());
  const grid = target?.properties?.gridProperties || null;
  const clamped = grid ? clampRange(range, grid) : null;
  state.lastGrid = grid ? {
    sheetName: target.properties.title,
    sheetId: target.properties.sheetId,
    rowCount: Number(grid.rowCount || 0),
    columnCount: Number(grid.columnCount || 0),
  } : null;

  if (!clamped || clamped === range) return { rows: null, error: null, retryable: true };
  state.lastClampedRange = clamped;
  try {
    const rows = await originalValues(id, clamped);
    state.lastStrategy = 'metadata-clamp';
    return { rows, error: null, retryable: false };
  } catch (error) {
    if (!shouldRetry(error)) throw error;
    return { rows: null, error, retryable: true };
  }
}

async function retryWithValueProbes(originalValues, id, range, parsed) {
  const last = await lastReadableColumn(originalValues, id, parsed);
  if (!Number.isInteger(last)) return null;
  const clamped = rangeWithEndColumn(parsed, last);
  if (!clamped || clamped === range) return null;
  state.lastClampedRange = clamped;
  const rows = await originalValues(id, clamped);
  state.lastStrategy = 'values-binary-probe';
  return rows;
}

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];
  const originalValues = sheets.values.bind(sheets);
  const originalMetadata = sheets.metadata.bind(sheets);

  sheets.values = async function gridSafeValues(id, range) {
    let firstError;
    try {
      return await originalValues(id, range);
    } catch (error) {
      firstError = error;
    }

    // A stale/revoked cached access token used to surface as the generic
    // GOOGLE_SHEETS_API_ERROR. Recover exactly once before any range logic.
    if (isUnauthorized(firstError)) {
      try {
        return await retryAfterUnauthorized(originalValues, id, range, firstError);
      } catch (authRetryError) {
        firstError = authRetryError;
      }
    }

    if (!shouldRetry(firstError)) throw firstError;
    const parsed = parseSheetRange(range);
    if (!parsed) throw firstError;

    state.retries++;
    state.lastOriginalRange = String(range || '');
    state.lastError = String(firstError?.message || firstError || '').slice(0, 500);

    const metadataRetry = await retryWithMetadata(originalValues, originalMetadata, id, range, parsed);
    if (metadataRetry.rows) {
      state.successes++;
      return metadataRetry.rows;
    }

    try {
      const rows = await retryWithValueProbes(originalValues, id, range, parsed);
      if (rows) {
        state.successes++;
        return rows;
      }
    } catch (probeError) {
      state.failures++;
      state.lastError = String(probeError?.message || probeError || '').slice(0, 500);
      probeError.originalRange = range;
      probeError.rangeRecoveryStrategy = state.lastStrategy || 'values-binary-probe';
      probeError.rangeRecoveryProbeCalls = state.probeCalls;
      throw probeError;
    }

    state.failures++;
    firstError.originalRange = range;
    firstError.rangeRecoveryStrategy = 'metadata+values-probe-exhausted';
    firstError.rangeRecoveryProbeCalls = state.probeCalls;
    throw firstError;
  };

  const api = Object.freeze({
    installed: true,
    reset,
    snapshot,
    clampRange,
    parseSheetRange,
    shouldRetry,
    isUnauthorized,
    authRequiredError,
    retryAfterUnauthorized,
    lastReadableColumn,
    rangeWithEndColumn,
    columnProbeRange,
  });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = {
  install,
  reset,
  snapshot,
  clampRange,
  parseSheetRange,
  shouldRetry,
  isUnauthorized,
  authRequiredError,
  retryAfterUnauthorized,
  lastReadableColumn,
  rangeWithEndColumn,
  columnProbeRange,
};
