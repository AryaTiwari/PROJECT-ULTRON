'use strict';

// Temporary exact-tab fallback for legacy Google 3-POC execution. If the normal
// Sheets metadata call fails, an explicitly configured sheet name/gid is used to
// synthesize only that one tab. Values/writes still go through the real Sheets API.

const threePoc = require('./three-poc-enrichment-operator');
const googleSheets = require('./google-sheets-operator');

const INSTALL_FLAG = Symbol.for('ultron.mark3.threePocDirectTabFallback.installed');
const stats = {
  metadataAttempts: 0,
  metadataFallbacks: 0,
  lastError: null,
  targetSheet: null,
  targetGid: null,
};

function enabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_THREE_POC_BIG_PICKLE || ''));
}

function targetSheet() {
  return String(process.env.ULTRON_M3_THREE_POC_TARGET_SHEET || '').trim();
}

function targetGid(source) {
  const explicit = Number(process.env.ULTRON_M3_THREE_POC_TARGET_GID || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const fromUrl = googleSheets.sheetGid(source);
  return Number.isFinite(fromUrl) && fromUrl >= 0 ? fromUrl : null;
}

async function withMetadataFallback(source, fn) {
  if (!enabled() || !targetSheet()) return fn();

  const original = googleSheets.metadata;
  const name = targetSheet();
  const gid = targetGid(source);
  stats.targetSheet = name;
  stats.targetGid = gid;

  googleSheets.metadata = async function metadataWithExactTabFallback(id) {
    stats.metadataAttempts++;
    try {
      return await original(id);
    } catch (error) {
      stats.metadataFallbacks++;
      stats.lastError = String(error?.message || error || '').slice(0, 500);
      return {
        spreadsheetId: id,
        properties: { title: '' },
        sheets: [{
          properties: {
            title: name,
            sheetId: gid == null ? 0 : Number(gid),
            index: 0,
            gridProperties: { rowCount: 1000, columnCount: 100 },
          },
        }],
        __ultronExactTabMetadataFallback: true,
      };
    }
  };

  try {
    return await fn();
  } finally {
    googleSheets.metadata = original;
  }
}

function snapshot() {
  return { ...stats, enabled: enabled() };
}

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];

  const baseEnrich = threePoc.enrichWorkbook.bind(threePoc);
  threePoc.enrichWorkbook = async function exactTabFallbackEnrich(source, options = {}) {
    return withMetadataFallback(source, () => baseEnrich(source, options));
  };

  const baseInspect = threePoc.inspectSource.bind(threePoc);
  threePoc.inspectSource = async function exactTabFallbackInspect(source, options = {}) {
    return withMetadataFallback(source, () => baseInspect(source, options));
  };

  const api = Object.freeze({ installed: true, enabled, snapshot, targetSheet, targetGid });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = { install, enabled, snapshot, targetSheet, targetGid, withMetadataFallback };
