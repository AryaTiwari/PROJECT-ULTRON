'use strict';
const crypto = require('node:crypto');

function value(input) { return String(input == null ? '' : input).trim(); }

function companyIndexes(schema = {}) {
  return [...new Set((schema.companyGroups || [])
    .flatMap((group) => Object.values(group.fields || {}))
    .map((field) => Number(field?.index))
    .filter(Number.isInteger))].sort((a, b) => a - b);
}

function snapshot(source = {}) {
  const indexes = companyIndexes(source.schema);
  const headerRowIndex = Number(source.schema?.headerRowIndex || 0);
  const anchors = [];
  for (let index = headerRowIndex + 1; index < (source.rows || []).length; index++) {
    const values = indexes.map((column) => value(source.rows[index]?.[column]));
    if (values.some(Boolean)) anchors.push({ rowNumber: index + 1, values });
  }
  const serialized = JSON.stringify(anchors);
  return {
    companyRowCount: anchors.length,
    companyAnchorFingerprint: crypto.createHash('sha256').update(serialized).digest('hex'),
    anchors,
  };
}

function verify(before, after) {
  const preserved = before.companyRowCount === after.companyRowCount
    && before.companyAnchorFingerprint === after.companyAnchorFingerprint;
  if (!preserved) {
    const error = new Error(`Company ownership changed during contact enrichment (${before.companyRowCount} rows before, ${after.companyRowCount} after).`);
    error.code = 'ENRICHMENT_COMPANY_OWNERSHIP_VIOLATION';
    error.subsystem = 'SHEETS';
    error.errorType = 'OWNERSHIP';
    error.stage = 'company-preservation-audit';
    error.before = before;
    error.after = after;
    throw error;
  }
  return {
    companyRowCountBefore: before.companyRowCount,
    companyRowCountAfter: after.companyRowCount,
    companyAnchorFingerprintBefore: before.companyAnchorFingerprint,
    companyAnchorFingerprintAfter: after.companyAnchorFingerprint,
    companiesPreserved: before.companyRowCount,
    companyRowsDeleted: 0,
    preserved: true,
  };
}

async function capture(readUniversalSheet, request, options = {}) {
  const source = await readUniversalSheet(request.sheetUrl || request.url, {
    ...options,
    sheetName: request.sheetName || options.sheetName,
  });
  return snapshot(source);
}

module.exports = { companyIndexes, snapshot, verify, capture };
