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
    .replace(/&/g, ' and ')
    .replace(/[._/\\-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ALIASES = {
  linkedin: new Set([
    'linkedin', 'linkedin url', 'linkedin profile', 'linkedin profile url', 'linkedin link',
    'linkedin profile link', 'profile linkedin', 'linkedin account', 'person linkedin url',
    'person linkedin', 'contact linkedin', 'linkedin profile address', 'linkedin address',
  ].map(normalizeHeader)),
  phone: new Set([
    'phone', 'phone number', 'phone no', 'mobile', 'mobile number', 'mobile no',
    'contact number', 'contact no', 'contact phone', 'work phone', 'business phone',
    'mobile phone', 'phone mobile', 'direct dial', 'direct phone', 'cell', 'cell phone',
    'telephone', 'telephone number', 'contact mobile', 'primary phone', 'phone 1',
  ].map(normalizeHeader)),
  email: new Set([
    'email', 'email id', 'email address', 'work email', 'business email', 'official email',
    'contact email', 'professional email', 'work email address', 'business email address',
    'primary email', 'corporate email', 'office email', 'email 1', 'e mail', 'e mail address',
  ].map(normalizeHeader)),
};

function headerScore(value, type) {
  const h = normalizeHeader(value);
  if (!h) return 0;
  if (ALIASES[type].has(h)) return 100;
  const words = new Set(h.split(' '));
  if (type === 'linkedin') {
    if (!words.has('linkedin')) return 0;
    if (words.has('company') || words.has('organization') || words.has('school')) return 0;
    return 80 + (words.has('profile') || words.has('person') || words.has('contact') || words.has('url') || words.has('link') ? 10 : 0);
  }
  if (type === 'phone') {
    if (/\b(?:phone|mobile|telephone|cell)\b/.test(h) || /\bdirect\s+dial\b/.test(h)) {
      if (/\b(?:status|verified|verification|type|label)\b/.test(h) && !/\bnumber\b/.test(h)) return 0;
      return 80 + (/\b(?:number|no|direct|work|business|contact|primary)\b/.test(h) ? 10 : 0);
    }
    if (/\bcontact\s+(?:number|no)\b/.test(h)) return 85;
    return 0;
  }
  if (type === 'email') {
    if (/\bemail\b/.test(h) || /\be\s+mail\b/.test(h)) {
      if (/\b(?:status|verified|verification|validity|confidence)\b/.test(h) && !/\baddress\b/.test(h)) return 0;
      return 80 + (/\b(?:address|work|business|official|contact|primary|corporate|office)\b/.test(h) ? 10 : 0);
    }
  }
  return 0;
}

function bestHeaderIndex(row, type) {
  let best = { index: -1, score: 0 };
  row.forEach((value, index) => {
    const score = headerScore(value, type);
    if (score > best.score) best = { index, score };
  });
  return best;
}

function looksLinkedInProfile(value) {
  return /^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/in\/[a-z0-9%._~-]+\/?(?:[?#].*)?$/i.test(String(value || '').trim());
}

function inferLinkedInColumn(rows, headerRowIndex) {
  const counts = new Map();
  for (let r = headerRowIndex + 1; r < Math.min(rows.length, headerRowIndex + 31); r++) {
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
  const maxHeaderRows = Math.min(rows.length, 30);
  for (let r = 0; r < maxHeaderRows; r++) {
    const row = rows[r] || [];
    const linkedinMatch = bestHeaderIndex(row, 'linkedin');
    const phoneMatch = bestHeaderIndex(row, 'phone');
    const emailMatch = bestHeaderIndex(row, 'email');
    const inferredLinkedin = linkedinMatch.index >= 0 ? linkedinMatch.index : inferLinkedInColumn(rows, r);
    if (inferredLinkedin < 0 || (phoneMatch.index < 0 && emailMatch.index < 0)) continue;
    const score = (linkedinMatch.index >= 0 ? linkedinMatch.score : 35) + phoneMatch.score + emailMatch.score - r * 0.02;
    if (!best || score > best.score) {
      best = {
        headerRowIndex: r,
        headerRowNumber: r + 1,
        linkedinColumnIndex: inferredLinkedin,
        phoneColumnIndex: phoneMatch.index,
        emailColumnIndex: emailMatch.index,
        linkedinColumn: columnName(inferredLinkedin),
        phoneColumn: phoneMatch.index >= 0 ? columnName(phoneMatch.index) : null,
        emailColumn: emailMatch.index >= 0 ? columnName(emailMatch.index) : null,
        score,
      };
    }
  }
  if (!best) {
    const sample = rows.slice(0, 12)
      .map((row, index) => ({ row: index + 1, headers: (row || []).filter((v) => String(v ?? '').trim()).slice(0, 18).map(String) }))
      .filter((item) => item.headers.length)
      .slice(0, 5);
    const error = new Error(`Could not safely identify LinkedIn plus Phone/Email columns. Header preview: ${JSON.stringify(sample)}`);
    error.code = 'SHEET_COLUMNS_NOT_FOUND';
    error.headerPreview = sample;
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
  const fields = encodeURIComponent('properties.title,sheets.properties(sheetId,title,index)');
  return request(`${API}/${encodeURIComponent(id)}?includeGridData=false&fields=${fields}`);
}

async function values(id, range) {
  const data = await request(`${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`);
  return data.values || [];
}

function hyperlinkFromCell(cell) {
  const direct = String(cell?.hyperlink || '').trim();
  if (looksLinkedInProfile(direct)) return direct;
  const formula = String(cell?.userEnteredValue?.formulaValue || '').trim();
  const match = formula.match(/^=HYPERLINK\(\s*["']([^"']+)["']/i);
  if (match && looksLinkedInProfile(match[1])) return match[1];
  for (const run of cell?.textFormatRuns || []) {
    const uri = String(run?.format?.link?.uri || '').trim();
    if (looksLinkedInProfile(uri)) return uri;
  }
  return null;
}

async function linkedInHyperlinks(id, sheetName, columnIndex, lastRow) {
  if (columnIndex < 0 || lastRow < 1) return new Map();
  const col = columnName(columnIndex);
  const range = `${quoteSheet(sheetName)}!${col}1:${col}${lastRow}`;
  const fields = encodeURIComponent('sheets(data(rowData(values(hyperlink,userEnteredValue,textFormatRuns(format(link(uri)))))))');
  const url = `${API}/${encodeURIComponent(id)}?includeGridData=true&ranges=${encodeURIComponent(range)}&fields=${fields}`;
  const data = await request(url);
  const map = new Map();
  const grids = data?.sheets?.[0]?.data || [];
  let rowNumber = 1;
  for (const grid of grids) {
    const rows = grid?.rowData || [];
    for (let i = 0; i < rows.length; i++) {
      const link = hyperlinkFromCell(rows[i]?.values?.[0]);
      if (link) map.set(rowNumber + i, link);
    }
    rowNumber += rows.length;
  }
  return map;
}

async function inspect(input) {
  const id = spreadsheetId(input);
  const meta = await metadata(id);
  let best = null;
  let bestFailure = null;
  for (const sheet of meta.sheets || []) {
    const title = sheet?.properties?.title;
    if (!title) continue;
    const preview = await values(id, `${quoteSheet(title)}!A1:ZZ80`);
    try {
      const layout = detectLayout(preview);
      const candidate = { ...layout, sheetName: title, sheetId: sheet.properties.sheetId, previewRows: preview.length };
      if (!best || candidate.score > best.score) best = candidate;
    } catch (error) {
      if (error.code !== 'SHEET_COLUMNS_NOT_FOUND') throw error;
      if (!bestFailure || (error.headerPreview?.length || 0) > (bestFailure.headerPreview?.length || 0)) {
        bestFailure = { sheetName: title, headerPreview: error.headerPreview || [] };
      }
    }
  }
  if (!best) {
    const previewText = bestFailure ? ` Closest tab: ${bestFailure.sheetName}. Header preview: ${JSON.stringify(bestFailure.headerPreview)}` : '';
    const error = new Error(`No tab contains a safely detectable LinkedIn column with Phone or Email columns.${previewText}`);
    error.code = 'SHEET_COLUMNS_NOT_FOUND';
    error.headerPreview = bestFailure?.headerPreview || [];
    throw error;
  }
  return { spreadsheetId: id, spreadsheetTitle: meta?.properties?.title || '', ...best };
}

async function readSheet(input, knownLayout = null) {
  const layout = knownLayout || await inspect(input);
  const rows = await values(layout.spreadsheetId, `${quoteSheet(layout.sheetName)}!A:ZZ`);
  // Sheets Values API returns the visible label for cells whose LinkedIn URL is stored
  // as a hyperlink. Read rich cell metadata for the LinkedIn column and replace only
  // those visible labels with their actual target URL before Apollo sees the row.
  const links = await linkedInHyperlinks(layout.spreadsheetId, layout.sheetName, layout.linkedinColumnIndex, Math.max(rows.length, layout.headerRowNumber));
  for (const [rowNumber, link] of links.entries()) {
    const index = rowNumber - 1;
    if (!rows[index]) rows[index] = [];
    rows[index][layout.linkedinColumnIndex] = link;
  }
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
  const text = String(value ?? '').trim();
  return value == null || text === '' || text.toLowerCase() === 'null';
}

module.exports = {
  spreadsheetId,
  extractSheetUrl,
  columnName,
  quoteSheet,
  normalizeHeader,
  headerScore,
  bestHeaderIndex,
  looksLinkedInProfile,
  hyperlinkFromCell,
  detectLayout,
  inspect,
  readSheet,
  writeCells,
  readCell,
  cellRange,
  isBlank,
};
