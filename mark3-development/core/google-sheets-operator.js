const auth = require('./google-sheets-auth');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

function spreadsheetId(input) {
  const text = String(input || '').trim();
  const match = text.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/i);
  if (!match) {
    const error = new Error('I need a valid Google Sheets URL.');
    error.code = 'INVALID_GOOGLE_SHEET_URL';
    throw error;
  }
  return match[1];
}

function extractSheetUrl(text) {
  return String(text || '').match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9_-]+[^\s<>'"`]*/i)?.[0]?.replace(/[),.;!?]+$/, '') || null;
}

function columnName(index) {
  let n = Number(index) + 1;
  if (!Number.isInteger(n) || n < 1) throw new Error('Invalid column index.');
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function quoteSheet(name) {
  return `'${String(name || '').replace(/'/g, "''")}'`;
}

function normalizeHeader(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[._/-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ALIASES = {
  linkedin: new Set([
    'linkedin', 'linkedin url', 'linkedin profile', 'linkedin profile url', 'linkedin link',
    'linkedin profile link', 'profile linkedin', 'linkedin account',
  ]),
  phone: new Set([
    'phone', 'phone number', 'phone no', 'phone no.', 'mobile', 'mobile number', 'mobile no',
    'contact number', 'contact no', 'contact phone', 'work phone', 'business phone',
  ].map(normalizeHeader)),
  email: new Set([
    'email', 'email id', 'email address', 'work email', 'business email', 'official email',
    'contact email', 'professional email', 'work email address',
  ].map(normalizeHeader)),
};

function aliasIndex(row, type) {
  const aliases = ALIASES[type];
  return row.findIndex((value) => aliases.has(normalizeHeader(value)));
}

function looksLinkedInProfile(value) {
  return /^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/in\/[a-z0-9%._~-]+\/?(?:[?#].*)?$/i.test(String(value || '').trim());
}

function inferLinkedInColumn(rows, headerRowIndex) {
  const counts = new Map();
  for (let r = headerRowIndex + 1; r < Math.min(rows.length, headerRowIndex + 21); r++) {
    const row = rows[r] || [];
    row.forEach((value, index) => {
      if (looksLinkedInProfile(value)) counts.set(index, (counts.get(index) || 0) + 1);
    });
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? -1;
}

function detectLayout(rows) {
  let best = null;
  const maxHeaderRows = Math.min(rows.length, 25);
  for (let r = 0; r < maxHeaderRows; r++) {
    const row = rows[r] || [];
    const explicitLinkedin = aliasIndex(row, 'linkedin');
    const phone = aliasIndex(row, 'phone');
    const email = aliasIndex(row, 'email');
    const inferredLinkedin = explicitLinkedin >= 0 ? explicitLinkedin : inferLinkedInColumn(rows, r);
    if (inferredLinkedin < 0 || (phone < 0 && email < 0)) continue;
    const score = (explicitLinkedin >= 0 ? 7 : 3) + (phone >= 0 ? 5 : 0) + (email >= 0 ? 5 : 0) - r * 0.02;
    if (!best || score > best.score) {
      best = {
        headerRowIndex: r,
        headerRowNumber: r + 1,
        linkedinColumnIndex: inferredLinkedin,
        phoneColumnIndex: phone,
        emailColumnIndex: email,
        linkedinColumn: columnName(inferredLinkedin),
        phoneColumn: phone >= 0 ? columnName(phone) : null,
        emailColumn: email >= 0 ? columnName(email) : null,
        score,
      };
    }
  }
  if (!best) {
    const error = new Error('Could not detect a LinkedIn column plus Phone/Email columns in this Sheet.');
    error.code = 'SHEET_COLUMNS_NOT_FOUND';
    throw error;
  }
  return best;
}

async function request(url, options = {}) {
  const token = await auth.accessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!response.ok) {
    const message = data?.error?.message || `Google Sheets API failed (${response.status}).`;
    const error = new Error(message);
    error.status = response.status;
    error.code = response.status === 403 ? 'GOOGLE_SHEETS_FORBIDDEN' : 'GOOGLE_SHEETS_API_ERROR';
    throw error;
  }
  return data;
}

async function metadata(id) {
  // Only request SheetProperties fields we actually use. rowCount/columnCount live
  // under gridProperties; asking for them directly makes the Sheets API reject the
  // field mask with HTTP 400.
  const fields = encodeURIComponent('properties.title,sheets.properties(sheetId,title,index)');
  return request(`${API}/${encodeURIComponent(id)}?includeGridData=false&fields=${fields}`);
}

async function values(id, range) {
  const data = await request(`${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`);
  return data.values || [];
}

async function inspect(input) {
  const id = spreadsheetId(input);
  const meta = await metadata(id);
  let best = null;
  for (const sheet of meta.sheets || []) {
    const title = sheet?.properties?.title;
    if (!title) continue;
    const preview = await values(id, `${quoteSheet(title)}!A1:ZZ60`);
    try {
      const layout = detectLayout(preview);
      const candidate = { ...layout, sheetName: title, sheetId: sheet.properties.sheetId, previewRows: preview.length };
      if (!best || candidate.score > best.score) best = candidate;
    } catch (error) {
      if (error.code !== 'SHEET_COLUMNS_NOT_FOUND') throw error;
    }
  }
  if (!best) {
    const error = new Error('No tab contains a detectable LinkedIn column with Phone or Email columns.');
    error.code = 'SHEET_COLUMNS_NOT_FOUND';
    throw error;
  }
  return { spreadsheetId: id, spreadsheetTitle: meta?.properties?.title || '', ...best };
}

async function readSheet(input, knownLayout = null) {
  const layout = knownLayout || await inspect(input);
  const rows = await values(layout.spreadsheetId, `${quoteSheet(layout.sheetName)}!A:ZZ`);
  return { ...layout, rows };
}

function cellRange(sheetName, rowNumber, columnIndex) {
  return `${quoteSheet(sheetName)}!${columnName(columnIndex)}${rowNumber}`;
}

async function writeCells(id, changes) {
  const data = (changes || []).filter((item) => item?.range).map((item) => ({ range: item.range, values: [[item.value]] }));
  if (!data.length) return { updatedCells: 0 };
  const result = await request(`${API}/${encodeURIComponent(id)}/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data, includeValuesInResponse: false }),
  });
  return { updatedCells: Number(result.totalUpdatedCells || data.length), raw: result };
}

async function readCell(id, range) {
  const rows = await values(id, range);
  return rows?.[0]?.[0] ?? '';
}

function isBlank(value) {
  return value == null || String(value).trim() === '';
}

module.exports = {
  spreadsheetId,
  extractSheetUrl,
  columnName,
  quoteSheet,
  normalizeHeader,
  looksLinkedInProfile,
  detectLayout,
  inspect,
  readSheet,
  writeCells,
  readCell,
  cellRange,
  isBlank,
};
