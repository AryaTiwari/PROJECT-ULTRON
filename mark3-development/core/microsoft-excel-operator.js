const auth = require('./microsoft-onedrive-auth');
const googleLayout = require('./google-sheets-operator');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_FILE_BYTES = Math.max(1024 * 1024, Number(process.env.ULTRON_M3_MICROSOFT_XLSX_MAX_BYTES || 20 * 1024 * 1024));

function excelJs() {
  try {
    return require('exceljs');
  } catch {
    const error = new Error('The OneDrive Excel adapter needs the exceljs package. Run npm install in mark3-development.');
    error.code = 'MICROSOFT_EXCEL_DEPENDENCY_MISSING';
    throw error;
  }
}

function cleanUrl(value) {
  return String(value || '').trim().replace(/[),.;!?]+$/, '');
}

function isMicrosoftUrl(value) {
  const text = String(value || '').trim();
  return /https:\/\/1drv\.ms\/x\//i.test(text)
    || /https:\/\/(?:www\.)?onedrive\.live\.com\//i.test(text)
    || /https:\/\/[^/\s]+\.sharepoint\.com\//i.test(text);
}

function extractWorkbookUrl(text) {
  const value = String(text || '');
  const match = value.match(/https:\/\/1drv\.ms\/x\/[^\s<>'"`]+/i)
    || value.match(/https:\/\/(?:www\.)?onedrive\.live\.com\/[^\s<>'"`]+/i)
    || value.match(/https:\/\/[^/\s]+\.sharepoint\.com\/[^\s<>'"`]+/i);
  return match?.[0] ? cleanUrl(match[0]) : null;
}

function shareToken(url) {
  const base64 = Buffer.from(String(url || ''), 'utf8').toString('base64');
  return `u!${base64.replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_')}`;
}

async function graphRequest(path, options = {}) {
  const token = await auth.accessToken();
  const response = await fetch(`${GRAPH}${path}`, {
    ...options,
    redirect: options.redirect || 'follow',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: options.accept || 'application/json',
      ...(options.body ? { 'Content-Type': options.contentType || 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  return response;
}

async function graphJson(path, options = {}) {
  const response = await graphRequest(path, options);
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok) {
    const message = data?.error?.message || data?.error_description || `Microsoft Graph failed (${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    error.code = response.status === 401 ? 'MICROSOFT_GRAPH_AUTH_REQUIRED'
      : response.status === 403 ? 'MICROSOFT_GRAPH_FORBIDDEN'
        : response.status === 404 ? 'MICROSOFT_SHARED_FILE_NOT_FOUND'
          : 'MICROSOFT_GRAPH_ERROR';
    throw error;
  }
  return data;
}

async function resolveItem(sourceUrl) {
  const url = extractWorkbookUrl(sourceUrl) || (isMicrosoftUrl(sourceUrl) ? cleanUrl(sourceUrl) : null);
  if (!url) {
    const error = new Error('A valid OneDrive/SharePoint workbook sharing URL is required.');
    error.code = 'INVALID_MICROSOFT_WORKBOOK_URL';
    throw error;
  }
  const token = shareToken(url);
  const select = encodeURIComponent('id,name,size,eTag,cTag,file,parentReference,webUrl,remoteItem');
  const item = await graphJson(`/shares/${encodeURIComponent(token)}/driveItem?$select=${select}`);
  const name = String(item?.name || '').trim();
  if (!/\.xlsx$/i.test(name)) {
    const error = new Error(`The shared Microsoft file must be .xlsx. Received: ${name || 'unknown file'}.`);
    error.code = 'MICROSOFT_XLSX_REQUIRED';
    throw error;
  }
  const size = Number(item?.size || 0);
  if (size > MAX_FILE_BYTES) {
    const error = new Error(`Workbook is ${Math.ceil(size / 1024 / 1024)} MB; the lightweight ULTRON adapter limit is ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB.`);
    error.code = 'MICROSOFT_XLSX_TOO_LARGE';
    throw error;
  }
  const driveId = item?.parentReference?.driveId || item?.remoteItem?.parentReference?.driveId || null;
  const itemId = item?.id || item?.remoteItem?.id || null;
  if (!driveId || !itemId) {
    const error = new Error('Microsoft Graph resolved the shared workbook but did not expose a writable drive/item identity. Sign in with an account that can edit the shared file.');
    error.code = 'MICROSOFT_WORKBOOK_NOT_WRITABLE';
    throw error;
  }
  return { sourceUrl: url, shareToken: token, driveId, itemId, name, size, eTag: item?.eTag || null, webUrl: item?.webUrl || url };
}

async function downloadItem(item) {
  const response = await graphRequest(`/drives/${encodeURIComponent(item.driveId)}/items/${encodeURIComponent(item.itemId)}/content`, { accept: '*/*' });
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Microsoft workbook download failed (${response.status}): ${text.slice(0, 500)}`);
    error.status = response.status;
    error.code = response.status === 401 ? 'MICROSOFT_GRAPH_AUTH_REQUIRED' : response.status === 403 ? 'MICROSOFT_GRAPH_FORBIDDEN' : 'MICROSOFT_WORKBOOK_DOWNLOAD_FAILED';
    throw error;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_FILE_BYTES) {
    const error = new Error('Workbook exceeds the lightweight OneDrive adapter size limit.');
    error.code = 'MICROSOFT_XLSX_TOO_LARGE';
    throw error;
  }
  return buffer;
}

async function uploadItem(item, buffer) {
  const response = await graphRequest(`/drives/${encodeURIComponent(item.driveId)}/items/${encodeURIComponent(item.itemId)}/content`, {
    method: 'PUT',
    body: buffer,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    headers: item.eTag ? { 'If-Match': item.eTag } : {},
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Microsoft workbook upload failed (${response.status}).`);
    error.status = response.status;
    error.code = response.status === 412 ? 'MICROSOFT_WORKBOOK_CHANGED_DURING_RUN'
      : response.status === 401 ? 'MICROSOFT_GRAPH_AUTH_REQUIRED'
        : response.status === 403 ? 'MICROSOFT_GRAPH_FORBIDDEN'
          : 'MICROSOFT_WORKBOOK_UPLOAD_FAILED';
    throw error;
  }
  return data;
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
    const error = new Error('Could not safely identify a person LinkedIn column in this workbook.');
    error.code = 'SHEET_LINKEDIN_COLUMN_NOT_FOUND';
    throw error;
  }
  return best;
}

async function loadWorkbook(sourceUrl) {
  const ExcelJS = excelJs();
  const item = await resolveItem(sourceUrl);
  const buffer = await downloadItem(item);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return { item, workbook };
}

async function ensureContactColumns(sourceUrl, options = {}) {
  const loaded = await loadWorkbook(sourceUrl);
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
    nextIndex += 1;
  }

  if (created.length) {
    const out = Buffer.from(await loaded.workbook.xlsx.writeBuffer());
    await uploadItem(loaded.item, out);
  }

  return {
    provider: 'microsoft',
    created,
    sheetName: worksheet.name,
    headerRowNumber: layout.headerRowNumber,
    phoneColumn: layout.phoneColumn,
    emailColumn: layout.emailColumn,
  };
}

async function inspect(sourceUrl) {
  const loaded = await loadWorkbook(sourceUrl);
  let best = null;
  for (const worksheet of loaded.workbook.worksheets || []) {
    const rows = rowsFromWorksheet(worksheet);
    try {
      const layout = googleLayout.detectLayout(rows);
      const candidate = {
        ...layout,
        provider: 'microsoft',
        spreadsheetId: loaded.item.sourceUrl,
        spreadsheetTitle: loaded.item.name,
        sheetName: worksheet.name,
        sheetId: worksheet.id,
        previewRows: rows.length,
        sourceUrl: loaded.item.sourceUrl,
        driveId: loaded.item.driveId,
        itemId: loaded.item.itemId,
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

async function readSheet(sourceUrl, knownLayout = null) {
  if (knownLayout?._rows) return { ...knownLayout, rows: knownLayout._rows };
  const layout = knownLayout || await inspect(sourceUrl);
  const loaded = await loadWorkbook(sourceUrl);
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
  if (!/^[A-Z]{1,3}[1-9]\d*$/i.test(address)) throw new Error(`Only single-cell writes are supported by the lightweight OneDrive adapter: ${text}`);
  return { sheetName, address: address.toUpperCase() };
}

async function writeCells(sourceUrl, changes) {
  const writes = (changes || []).filter((item) => item?.range);
  if (!writes.length) return { updatedCells: 0 };
  const loaded = await loadWorkbook(sourceUrl);
  for (const change of writes) {
    const target = parseRange(change.range);
    const worksheet = loaded.workbook.getWorksheet(target.sheetName);
    if (!worksheet) throw new Error(`Worksheet ${target.sheetName} was not found while writing.`);
    worksheet.getCell(target.address).value = change.value;
  }
  const out = Buffer.from(await loaded.workbook.xlsx.writeBuffer());
  await uploadItem(loaded.item, out);
  return { updatedCells: writes.length };
}

async function readCell(sourceUrl, range) {
  const target = parseRange(range);
  const loaded = await loadWorkbook(sourceUrl);
  const worksheet = loaded.workbook.getWorksheet(target.sheetName);
  if (!worksheet) return '';
  return cellValue(worksheet.getCell(target.address));
}

function status() {
  let dependencyReady = true;
  try { require.resolve('exceljs'); } catch { dependencyReady = false; }
  return {
    provider: 'microsoft',
    dependencyReady,
    maxWorkbookBytes: MAX_FILE_BYTES,
    ...auth.status(),
  };
}

module.exports = {
  provider: 'microsoft',
  isMicrosoftUrl,
  extractWorkbookUrl,
  shareToken,
  resolveItem,
  detectLeadLayout,
  ensureContactColumns,
  inspect,
  readSheet,
  writeCells,
  readCell,
  cellRange: googleLayout.cellRange,
  columnName: googleLayout.columnName,
  isBlank: googleLayout.isBlank,
  status,
  auth,
  parseRange,
};
