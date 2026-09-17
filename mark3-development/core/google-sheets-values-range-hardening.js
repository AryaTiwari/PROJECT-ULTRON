'use strict';

// Google Sheets Values API rejects A1 ranges that extend beyond the physical grid
// on some sheets (for example `'Arya 2'!A:ZZ` when the tab only has columns A:O).
// Universal enrichment intentionally asks for a wide schema-neutral range, so this
// wrapper retries only grid-bound failures with the exact real tab dimensions.

const sheets = require('./google-sheets-operator');

const INSTALL_FLAG = Symbol.for('ultron.mark3.googleSheetsValuesRangeHardening.installed');
const state = {
  retries: 0,
  successes: 0,
  failures: 0,
  lastOriginalRange: null,
  lastClampedRange: null,
  lastGrid: null,
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

function shouldRetry(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (/range exceeds grid limits|exceeds grid limits|outside the sheet limits|range.*exceed/.test(message)) return true;
  // Some Google 400 responses are generic while details contain the range error.
  let details = '';
  try { details = JSON.stringify(error?.googleDetails || []).toLowerCase(); } catch {}
  return Number(error?.status) === 400 && /grid|range|limit/.test(`${message} ${details}`);
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

function reset() {
  state.retries = 0;
  state.successes = 0;
  state.failures = 0;
  state.lastOriginalRange = null;
  state.lastClampedRange = null;
  state.lastGrid = null;
  state.lastError = null;
}

function snapshot() {
  return { ...state, lastGrid: state.lastGrid ? { ...state.lastGrid } : null };
}

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];
  const originalValues = sheets.values.bind(sheets);
  const originalMetadata = sheets.metadata.bind(sheets);

  sheets.values = async function gridSafeValues(id, range) {
    try {
      return await originalValues(id, range);
    } catch (error) {
      if (!shouldRetry(error)) throw error;
      const parsed = parseSheetRange(range);
      if (!parsed) throw error;

      state.retries++;
      state.lastOriginalRange = String(range || '');
      state.lastError = String(error?.message || error || '').slice(0, 500);

      let meta;
      try {
        meta = await originalMetadata(id);
      } catch {
        state.failures++;
        throw error;
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
      state.lastClampedRange = clamped;
      if (!clamped || clamped === range) {
        state.failures++;
        throw error;
      }

      try {
        const rows = await originalValues(id, clamped);
        state.successes++;
        return rows;
      } catch (retryError) {
        state.failures++;
        state.lastError = String(retryError?.message || retryError || '').slice(0, 500);
        retryError.originalRange = range;
        retryError.clampedRange = clamped;
        retryError.grid = state.lastGrid;
        throw retryError;
      }
    }
  };

  const api = Object.freeze({ installed: true, reset, snapshot, clampRange, parseSheetRange, shouldRetry });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = { install, reset, snapshot, clampRange, parseSheetRange, shouldRetry };
