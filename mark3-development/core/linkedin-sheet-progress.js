'use strict';

const sheets = require('./google-sheets-operator');
const finalMaster = require('./linkedin-final-master');

function normalizeHeader(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findIndex(headers, patterns) {
  for (let index = 0; index < headers.length; index++) {
    const value = normalizeHeader(headers[index]);
    if (patterns.some((pattern) => pattern.test(value))) return index;
  }
  return -1;
}

function companyLinkedIn(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/https?:\/\/(?:www\.)?linkedin\.com\/company\/([^/?#]+)/i);
  return match ? `https://www.linkedin.com/company/${match[1].toLowerCase()}` : '';
}

function jobId(value) {
  const raw = String(value || '').trim();
  return raw.match(/linkedin\.com\/jobs\/view\/(?:[^\d/]*-)?(\d{6,})/i)?.[1] || '';
}

function snapshotRows(rows = [], options = {}) {
  if (!rows.length) {
    return {
      uniqueCompanies: 0,
      validRows: 0,
      totalDataRows: 0,
      companyKeys: [],
      jobIds: [],
      rowNumbers: [],
    };
  }

  const headers = rows[0] || [];
  const companyIndex = findIndex(headers, [
    /^company name$/,
    /^company$/,
    /^business name$/,
    /^organization name$/,
    /^organisation name$/,
  ]);
  const linkedinIndex = findIndex(headers, [
    /^company link$/,
    /^company url$/,
    /^company profile$/,
    /^linkedin company$/,
    /^linkedin$/,
  ]);
  const jobIndex = findIndex(headers, [
    /^job link$/,
    /^job url$/,
    /^linkedin job$/,
    /^linkedin job link$/,
    /^job posting link$/,
    /^job opening link$/,
  ]);

  const requireJob = options.requireJob !== false;
  const keys = new Set();
  const jobs = new Set();
  const rowNumbers = [];
  let validRows = 0;
  let totalDataRows = 0;

  for (let index = 1; index < rows.length; index++) {
    const row = rows[index] || [];
    if (row.some((value) => String(value || '').trim())) totalDataRows++;

    const company = companyIndex >= 0 ? String(row[companyIndex] || '').trim() : '';
    const linkedin = linkedinIndex >= 0 ? companyLinkedIn(row[linkedinIndex]) : '';
    const jid = jobIndex >= 0 ? jobId(row[jobIndex]) : '';

    if (!company || !linkedin) continue;
    if (requireJob && !jid) continue;

    const key = finalMaster.companyKey({ company, linkedin });
    if (!key) continue;

    validRows++;
    keys.add(key);
    if (jid) jobs.add(jid);
    rowNumbers.push(index + 1);
  }

  return {
    uniqueCompanies: keys.size,
    validRows,
    totalDataRows,
    companyKeys: [...keys],
    jobIds: [...jobs],
    rowNumbers,
  };
}

async function snapshot(url = finalMaster.masterSheetUrl(), options = {}) {
  if (!url) return { ...snapshotRows([], options), sheetUrl: null, sheetName: null };
  const spreadsheetId = sheets.spreadsheetId(url);
  const state = finalMaster.loadState();
  const sheetName = options.sheetName || state.sheetName || 'Leads';
  const rows = await sheets.values(spreadsheetId, `${sheets.quoteSheet(sheetName)}!A:ZZ`);
  return {
    ...snapshotRows(rows, options),
    sheetUrl: url,
    sheetName,
    spreadsheetId,
    readAt: new Date().toISOString(),
  };
}

module.exports = {
  normalizeHeader,
  companyLinkedIn,
  jobId,
  snapshotRows,
  snapshot,
};
