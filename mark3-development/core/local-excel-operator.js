const fs = require('fs');
const path = require('path');
const fileVault = require('./file-vault');
const googleLayout = require('./google-sheets-operator');

function excelJs() {
  try {
    return require('exceljs');
  } catch {
    const error = new Error('Local Excel enrichment needs exceljs. Run npm install in mark3-development.');
    error.code = 'LOCAL_EXCEL_DEPENDENCY_MISSING';
    throw error;
  }
}

function sourceId(input) {
  const match = String(input || '').trim().match(/^vault:(.+)$/i);
  if (!match) {
    const error = new Error('A valid local spreadsheet attachment is required.');
    error.code = 'INVALID_LOCAL_EXCEL_SOURCE';
    throw error;
  }
  return match[1];
}

function isLocalExcelSource(input) {
  return /^vault:.+/i.test(String(input || '').trim());
}

function normalizeName(value) {
  return path.basename(String(value || '').trim()).toLowerCase().replace(/\.(xlsx|xlsm|xls)$/i, '').replace(/\s+/g, ' ').trim();
}

function spreadsheetLike(file = {}) {
  const name = String(file.name || '');
  const mime = String(file.mime || '').toLowerCase();
  return /\.(xlsx|xlsm)$/i.test(name) || mime.includes('spreadsheetml') || mime.includes('excel');
}

function attachmentSource(files = [], text = '') {
  const rows = Array.isArray(files) ? files.filter((file) => file?.id) : [];
  if (!rows.length) return null;
  const mention = String(text || '').match(/@([\w .()\-]+)/)?.[1]?.trim() || '';
  if (mention) {
    const wanted = normalizeName(mention);
    const exact = rows.find((file) => normalizeName(file.name) === wanted || normalizeName(file.name).startsWith(wanted) || wanted.startsWith(normalizeName(file.name)));
    if (exact) return { provider: 'local-excel', url: `vault:${exact.id}`, supported: true, attachment: exact };
  }
  const sheetIntent = /\b(?:sheet|spreadsheet|excel|workbook|enrich|email|phone|mobile|number|contact)\b/i.test(String(text || ''));
  const spreadsheets = rows.filter(spreadsheetLike);
  if (sheetIntent && spreadsheets.length === 1) {
    const file = spreadsheets[0];
    return { provider: 'local-excel', url: `vault:${file.id}`, supported: true, attachment: file };
  }
  return null;
}

function cellValue(cell) {
  const hyperlink = String(cell?.hyperlink || cell?.value?.hyperlink || '').trim();
  if (hyperlink && /linkedin\.com\/(?:in|company)\//i.test(hyperlink)) return hyperlink;
  const value = cell?.value;
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => String(part?.text || '')).join('');
    if (Object.prototype.hasOwnProperty.call(value, 'result')) return value.result ?? '';
    if (Object.prototype.hasOwnProperty.call(value, 'text')) return value.text ?? '';
  }
  return value;
}

function rowsFromWorksheet(worksheet, maxRows = 5000, maxCols = 200) {
  const rowCount = Math.min(maxRows, Math.max(Number(worksheet.actualRowCount || 0), Number(worksheet.rowCount || 0)));
  const columnCount = Math.min(maxCols, Math.max(Number(worksheet.actualColumnCount || 0), Number(worksheet.columnCount || 0)));
  const rows = [];
  for (let r = 1; r <= rowCount; r++) {
    const row = [];
    for (let c = 1; c <= columnCount; c++) row.push(cellValue(worksheet.getCell(r, c)));
    while (row.length && String(row[row.length - 1] ?? '').trim() === '') row.pop();
    rows.push(row);
  }
  return rows;
}

function inferLinkedInColumn(rows, headerRowIndex) {
  const counts = new Map();
  for (let r = headerRowIndex + 1; r < Math.min(rows.length, headerRowIndex + 31); r++) {
    (rows[r] || []).forEach((value, index) => {
      if (/linkedin\.com\/in\//i.test(String(value || ''))) counts.set(index, (counts.get(index) || 0) + 1);
    });
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1;
}

function detectLeadLayout(rows) {
  let best = null;
  const maxHeaderRows = Math.min(rows.length, 30);
  for (let r = 0; r < maxHeaderRows; r++) {
    const row = rows[r] || [];
    const linkedinMatch = googleLayout.bestHeaderIndex(row, 'linkedin');
    const phoneMatch = googleLayout.bestHeaderIndex(row, 'phone');
    const emailMatch = googleLayout.bestHeaderIndex(row, 'email');
    const linkedinColumnIndex = linkedinMatch.index >= 0 ? linkedinMatch.index : inferLinkedInColumn(rows, r);
    if (linkedinColumnIndex < 0) continue;
    const score = (linkedinMatch.index >= 0 ? linkedinMatch.score : 35) + phoneMatch.score + emailMatch.score - r * 0.02;
    const candidate = {
      headerRowIndex: r,
      headerRowNumber: r + 1,
      linkedinColumnIndex,
      phoneColumnIndex: phoneMatch.index,
      emailColumnIndex: emailMatch.index,
      linkedinColumn: googleLayout.columnName(linkedinColumnIndex),
      phoneColumn: phoneMatch.index >= 0 ? googleLayout.columnName(phoneMatch.index) : null,
      emailColumn: emailMatch.index >= 0 ? googleLayout.columnName(emailMatch.index) : null,
      score,
    };
    if (!best || candidate.score > best.score) best = candidate;
  }
  if (!best) {
    const error = new Error('Could not safely identify a person LinkedIn column in this Excel attachment.');
    error.code = 'SHEET_LINKEDIN_COLUMN_NOT_FOUND';
    throw error;
  }
  return best;
}

async function loadWorkbook(source) {
  const id = sourceId(source);
  const entry = fileVault.get(id);
  if (!entry) {
    const error = new Error('The attached Excel file is no longer available in ULTRON file storage. Re-attach it and retry.');
    error.code = 'LOCAL_EXCEL_ATTACHMENT_NOT_FOUND';
    throw error;
  }
  const ExcelJS = excelJs();
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(fs.readFileSync(entry.path));
  } catch (error) {
    const wrapped = new Error(`The attachment is not a readable .xlsx workbook: ${error.message}`);
    wrapped.code = 'LOCAL_XLSX_REQUIRED';
    throw wrapped;
  }
  return { id, entry, workbook };
}

async function saveWorkbook(loaded) {
  const buffer = Buffer.from(await loaded.workbook.xlsx.writeBuffer());
  fs.writeFileSync(loaded.entry.path, buffer);
  return buffer.length;
}

async function ensureContactColumns(source, options = {}) {
  const loaded = await loadWorkbook(source);
  let best = null;
  for (const worksheet of loaded.workbook.worksheets || []) {
    const rows = rowsFromWorksheet(worksheet);
    try {
      const layout = detectLeadLayout(rows);
      const candidate = { worksheet, rows, layout };
      if (!best || layout.score > best.layout.score) best = candidate;
    } catch (error) {
      if (error.code !== 'SHEET_LINKEDIN_COLUMN_NOT_FOUND') throw error;
    }
  }
  if (!best) {
    const error = new Error('No worksheet contains a safely detectable person LinkedIn column, so ULTRON will not invent contact columns in an unrelated table.');
    error.code = 'SHEET_LINKEDIN_COLUMN_NOT_FOUND';
    throw error;
  }

  const wantPhone = options.phone !== false;
  const wantEmail = options.email !== false;
  const created = [];
  const { worksheet, rows, layout } = best;
  const widestUsed = rows.reduce((max, row) => Math.max(max, (row || []).length), 0);
  let nextIndex = Math.max(widestUsed, (rows[layout.headerRowIndex] || []).length);

  if (wantPhone && layout.phoneColumnIndex < 0) {
    worksheet.getCell(layout.headerRowNumber, nextIndex + 1).value = 'Phone No';
    layout.phoneColumnIndex = nextIndex;
    layout.phoneColumn = googleLayout.columnName(nextIndex);
    created.push('Phone');
    nextIndex += 1;
  }
  if (wantEmail && layout.emailColumnIndex < 0) {
    worksheet.getCell(layout.headerRowNumber, nextIndex + 1).value = 'Email';
    layout.emailColumnIndex = nextIndex;
    layout.emailColumn = googleLayout.columnName(nextIndex);
    created.push('Email');
  }

  if (created.length) await saveWorkbook(loaded);
  return {
    provider: 'local-excel',
    created,
    sheetName: worksheet.name,
    headerRowNumber: layout.headerRowNumber,
    phoneColumn: layout.phoneColumn,
    emailColumn: layout.emailColumn,
  };
}

async function inspect(source) {
  const loaded = await loadWorkbook(source);
  let best = null;
  for (const worksheet of loaded.workbook.worksheets || []) {
    const rows = rowsFromWorksheet(worksheet);
    try {
      const layout = googleLayout.detectLayout(rows);
      const candidate = {
        ...layout,
        provider: 'local-excel',
        spreadsheetId: source,
        spreadsheetTitle: loaded.entry.name,
        sheetName: worksheet.name,
        sheetId: worksheet.id,
        previewRows: rows.length,
        _rows: rows,
      };
      if (!best || candidate.score > best.score) best = candidate;
    } catch (error) {
      if (error.code !== 'SHEET_COLUMNS_NOT_FOUND') throw error;
    }
  }
  if (!best) {
    const error = new Error('No worksheet contains a safely detectable LinkedIn column with Phone or Email columns.');
    error.code = 'SHEET_COLUMNS_NOT_FOUND';
    throw error;
  }
  return best;
}

async function readSheet(source, knownLayout = null) {
  if (knownLayout?._rows) return { ...knownLayout, rows: knownLayout._rows };
  const layout = knownLayout || await inspect(source);
  const loaded = await loadWorkbook(source);
  const worksheet = loaded.workbook.getWorksheet(layout.sheetName);
  if (!worksheet) throw new Error(`Worksheet ${layout.sheetName} no longer exists.`);
  return { ...layout, rows: rowsFromWorksheet(worksheet) };
}

function parseRange(range) {
  const text = String(range || '').trim();
  const bang = text.lastIndexOf('!');
  if (bang < 1) throw new Error(`Invalid Excel cell range: ${text}`);
  let sheetName = text.slice(0, bang).trim();
  if (sheetName.startsWith("'") && sheetName.endsWith("'")) sheetName = sheetName.slice(1, -1).replace(/''/g, "'");
  const address = text.slice(bang + 1).trim().replace(/\$/g, '');
  if (!/^[A-Z]{1,3}[1-9]\d*$/i.test(address)) throw new Error(`Only single-cell writes are supported for local Excel attachments: ${text}`);
  return { sheetName, address: address.toUpperCase() };
}

async function writeCells(source, changes) {
  const writes = (changes || []).filter((item) => item?.range);
  if (!writes.length) return { updatedCells: 0 };
  const loaded = await loadWorkbook(source);
  for (const change of writes) {
    const target = parseRange(change.range);
    const worksheet = loaded.workbook.getWorksheet(target.sheetName);
    if (!worksheet) throw new Error(`Worksheet ${target.sheetName} was not found while writing.`);
    worksheet.getCell(target.address).value = change.value;
  }
  await saveWorkbook(loaded);
  return { updatedCells: writes.length };
}

async function readCell(source, range) {
  const target = parseRange(range);
  const loaded = await loadWorkbook(source);
  const worksheet = loaded.workbook.getWorksheet(target.sheetName);
  if (!worksheet) return '';
  return cellValue(worksheet.getCell(target.address));
}

function artifact(source) {
  const id = sourceId(source);
  const entry = fileVault.get(id);
  if (!entry) return null;
  return {
    id: entry.id,
    name: entry.name,
    mime: entry.mime,
    size: entry.size,
    downloadUrl: `/api/files/download?id=${encodeURIComponent(entry.id)}`,
  };
}

function status() {
  let dependencyReady = true;
  try { require.resolve('exceljs'); } catch { dependencyReady = false; }
  return { provider: 'local-excel', dependencyReady };
}

module.exports = {
  provider: 'local-excel',
  isLocalExcelSource,
  attachmentSource,
  spreadsheetLike,
  inspect,
  readSheet,
  writeCells,
  readCell,
  ensureContactColumns,
  cellRange: googleLayout.cellRange,
  columnName: googleLayout.columnName,
  isBlank: googleLayout.isBlank,
  parseRange,
  artifact,
  status,
};