'use strict';

const path = require('node:path');
const config = require('./config');
const { readJson, writeJsonAtomic } = require('./persistence');

const FILE = path.join(config.dataDir, 'sheet-source-aliases.json');

function text(value) { return String(value == null ? '' : value).trim(); }

function normalizeAlias(value) {
  return text(value)
    .replace(/^@+/, '')
    .replace(/.(?:xlsx?|csv)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9._ -]+/g, ' ')
    .replace(/s+/g, ' ')
    .trim();
}

function aliasFromInput(input) {
  const match = text(input).match(/@([A-Za-z0-9][A-Za-z0-9._ -]{0,80}?)(?=s*,|s+worksheet|s+sheet|s+tab|[.;!?]|$)/i);
  return normalizeAlias(match?.[1] || '');
}

function load() {
  const state = readJson(FILE, { version: 1, aliases: {} });
  state.version = 1;
  state.aliases ||= {};
  return state;
}

function bind(alias, url, metadata = {}) {
  const key = normalizeAlias(alias);
  const targetUrl = text(url);
  if (!key || !/^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+/i.test(targetUrl)) return null;

  const state = load();
  const entry = {
    alias: key,
    url: targetUrl,
    sheetName: text(metadata.sheetName || ''),
    spreadsheetId: text(metadata.spreadsheetId || ''),
    source: text(metadata.source || 'verified-google-sheet'),
    verifiedAt: new Date().toISOString(),
  };
  state.aliases[key] = entry;
  writeJsonAtomic(FILE, state);
  return entry;
}

function resolve(alias) {
  const key = normalizeAlias(alias);
  if (!key) return null;
  return load().aliases[key] || null;
}

function list() {
  return Object.values(load().aliases);
}

module.exports = {
  FILE,
  normalizeAlias,
  aliasFromInput,
  bind,
  resolve,
  list,
};
