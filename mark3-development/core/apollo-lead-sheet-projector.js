'use strict';
const sheets = require('./google-sheets-operator');
const targetResolver = require('./universal-sheet-target-resolver');
const schemaEngine = require('./universal-sheet-schema');
const contact = require('./apollo-contactability-policy');

function text(v) { return String(v == null ? '' : v).trim(); }
function header(v) { return text(v).toLowerCase().replace(/[_./\\-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function cell(sheetName, row, column) { return `${sheets.quoteSheet(sheetName)}!${sheets.columnName(column)}${row}`; }
function companyKey(v) { return text(v).toLowerCase().replace(/^https?:\/\/(?:www\.)?/, '').replace(/[/?#].*$/, '').replace(/\W+/g, ''); }

async function inspect(compiled) {
  const id = sheets.spreadsheetId(compiled.sheet.url);
  const meta = await sheets.metadata(id);
  const resolved = targetResolver.resolveTabs(meta, compiled.sheet.url, { sheetName: compiled.sheet.sheetName, explicitNameAuthoritative: Boolean(compiled.sheet.sheetName) });
  const target = resolved.target || resolved.targets[0];
  if (!target?.name) throw Object.assign(new Error('Apollo lead projection requires an exact worksheet target.'), { code: 'APOLLO_SHEET_TARGET_REQUIRED' });
  const rows = await sheets.values(id, `${sheets.quoteSheet(target.name)}!A1:ZZ`);
  const detected = schemaEngine.detectHeaderRow(rows) || { rowIndex: 0, rowNumber: 1, columns: [] };
  const schema = schemaEngine.inferSchema(rows, { maxHeaderRows: 20 });
  return { id, meta, target, rows, schema, headerRowIndex: detected.rowIndex, headerRowNumber: detected.rowNumber, headers: rows[detected.rowIndex] || [] };
}

function directColumns(headers = []) {
  const out = {};
  headers.forEach((value, index) => {
    const h = header(value);
    if (!h) return;
    if (out.companyName == null && /^(?:company(?: name)?|organization|organisation|business(?: name)?|account(?: name)?)$/.test(h)) out.companyName = index;
    if (out.companyLink == null && /^(?:company|organization|organisation|business) (?:link|url|linkedin(?: url)?)$/.test(h)) out.companyLink = index;
    if (out.website == null && /^(?:website|company website|domain|homepage)$/.test(h)) out.website = index;
    if (out.industry == null && /^industry$/.test(h)) out.industry = index;
    if (out.employees == null && /^(?:employees?|employee count|company size|headcount)$/.test(h)) out.employees = index;
    if (out.location == null && /^(?:location|company location|headquarters|hq)$/.test(h)) out.location = index;
    if (out.source == null && /^(?:source|lead source)$/.test(h)) out.source = index;
  });
  return out;
}

function schemaColumns(info) {
  const cols = directColumns(info.headers);
  const company = info.schema.companyGroups?.[0];
  if (cols.companyName == null) cols.companyName = company?.fields?.company?.index;
  if (cols.companyLink == null) cols.companyLink = company?.fields?.linkedin?.index;
  if (cols.website == null) cols.website = company?.fields?.website?.index;
  const groups = (info.schema.personGroups || []).sort((a, b) => (a.ordinal || 99) - (b.ordinal || 99)).slice(0, 2);
  return { ...cols, personGroups: groups };
}

function rowValues(record, columns, includePeople) {
  const values = new Map(); const set = (index, value) => { if (Number.isInteger(index) && text(value)) values.set(index, value); };
  set(columns.companyName, record.name); set(columns.companyLink, record.linkedinUrl || record.companyLink || record.website); set(columns.website, record.website); set(columns.industry, record.industry); set(columns.employees, record.employees); set(columns.location, record.location); set(columns.source, 'Apollo');
  if (includePeople) [record.poc1, record.poc2].forEach((person, i) => { if (!person) return; const fields = columns.personGroups[i]?.fields || {}; set(fields.name?.index, person.name); set(fields.role?.index, person.title); set(fields.linkedin?.index, person.linkedinUrl); set(fields.phone?.index, contact.literalPhone(person.phone)); set(fields.email?.index, contact.workEmail(person.email) ? person.email : ''); });
  return values;
}

async function project(compiled, records = [], options = {}) {
  if (!compiled.sheet?.url) {
    if (compiled.sheet?.requested) {
      const error = new Error('A Sheet destination was requested, but no live Google Sheets URL was resolved.');
      error.code = 'APOLLO_LEAD_SHEET_SOURCE_UNRESOLVED';
      error.stage = 'apollo-lead-sheet-projection';
      throw error;
    }
    return { rowsWritten: 0, cellsWritten: 0, skippedDuplicates: 0, sheetUrl: '', sheetName: '', liveVerified: true };
  }
  const info = await inspect(compiled); const columns = schemaColumns(info);
  if (!Number.isInteger(columns.companyName) && !Number.isInteger(columns.personGroups?.[0]?.fields?.name?.index)) throw Object.assign(new Error('No recognized company or person-name heading exists in the target worksheet.'), { code: 'APOLLO_LEAD_COLUMN_NOT_FOUND' });
  const existing = new Set(info.rows.slice(info.headerRowIndex + 1).map((row) => companyKey(row[columns.companyName])).filter(Boolean));
  const changes = []; let row = Math.max(info.rows.length + 1, info.headerRowNumber + 1); let skippedDuplicates = 0; const written = [];
  for (const record of records) { const key = companyKey(record.id || record.domain || record.linkedinUrl || record.name); const nameKey = companyKey(record.name); if (!key || existing.has(key) || existing.has(nameKey)) { skippedDuplicates++; continue; } const values = rowValues(record, columns, options.includePeople); if (!values.size) continue; for (const [column, value] of values) changes.push({ range: cell(info.target.name, row, column), value }); existing.add(key); existing.add(nameKey); written.push({ row, record, values }); row++; }
  if (written.length && info.target.sheetId != null) await sheets.ensureGridSize(info.id, info.target.sheetId, { minRows: row + 5, minColumns: Math.max(info.headers.length, 2) });
  const result = await sheets.writeCells(info.id, changes);
  const rereadRanges = written.map((entry) => `${sheets.quoteSheet(info.target.name)}!A${entry.row}:${sheets.columnName(Math.max(0, info.headers.length - 1))}${entry.row}`);
  const verified = rereadRanges.length ? await sheets.batchValues(info.id, rereadRanges, { formulas: false }) : [];
  const liveVerified = verified.length === written.length;
  if (written.length && !liveVerified) {
    const error = new Error(`Apollo wrote ${written.length} row(s), but the mandatory live Sheet reread verified only ${verified.length}.`);
    error.code = 'APOLLO_LEAD_SHEET_REREAD_FAILED';
    error.stage = 'apollo-lead-sheet-verification';
    throw error;
  }
  return {
    rowsWritten: written.length,
    cellsWritten: result.updatedCells || changes.length,
    skippedDuplicates,
    sheetUrl: compiled.sheet.url,
    sheetName: info.target.name,
    writtenRows: written.map((w) => w.row),
    rereadRows: verified.length,
    liveVerified,
  };
}

module.exports = { header, companyKey, inspect, directColumns, schemaColumns, rowValues, project };
