const googleAuth = require('./google-sheets-auth');
const sheets = require('./google-sheets-operator');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function requestedContactEnrichment(text) {
  return /\b(?:email|e-?mail|phone|mobile|contact\s+(?:info|information|details?|number)|decision[- ]?maker|head(?:s)?|recruiter(?:s)?|talent\s+acquisition|hr\s+contact)\b/i.test(String(text || ''));
}

function genericLocationFromText(text, existing = '') {
  if (String(existing || '').trim()) return String(existing).trim();
  const value = String(text || '')
    .replace(/https?:\/\/docs\.google\.com\/spreadsheets\/d\/[^\s]+/gi, ' ')
    .replace(/\bon\s+linkedin\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const stop = '(?=\\s*(?:,?\\s+(?:remote|hybrid|on[- ]?site|under|below|less\\s+than|fewer\\s+than|over|above|more\\s+than|at\\s+least|with|having|past\\s+(?:24\\s+hours?|week|month)|full[- ]?time|part[- ]?time|contract|internship|easy\\s+apply|and\\s+(?:under|remote|hybrid|with|past)|in\\s+(?:the\\s+)?(?:current|same|existing|master|consolidated)\\s+(?:google\\s+)?(?:sheet|spreadsheet)))|$)';
  const patterns = [
    new RegExp('\\b(?:located|based|headquartered)\\s+in\\s+([A-Za-z][A-Za-z .-]*(?:,\\s*[A-Za-z][A-Za-z .-]*)?)' + stop, 'i'),
    new RegExp('\\b(?:jobs?|roles?|openings?|vacancies)\\s+in\\s+([A-Za-z][A-Za-z .-]*(?:,\\s*[A-Za-z][A-Za-z .-]*)?)' + stop, 'i'),
    new RegExp('\\bfrom\\s+([A-Za-z][A-Za-z .-]*(?:,\\s*[A-Za-z][A-Za-z .-]*)?)' + stop, 'i'),
    new RegExp('\\bin\\s+([A-Za-z][A-Za-z .-]*(?:,\\s*[A-Za-z][A-Za-z .-]*)?)' + stop, 'i'),
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match?.[1]) continue;
    const location = match[1]
      .replace(/\b(?:companies?|people|professionals?|recruiters?|jobs?|roles?|openings?)\b.*$/i, '')
      .replace(/[.,;:]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (location && !/^(?:linkedin|the|a|an)$/i.test(location)) return location;
  }
  return '';
}

function genericTopicFromText(text, request = {}, location = '') {
  let value = String(request.criteriaText || text || '');
  value = value
    .replace(/https?:\/\/docs\.google\.com\/spreadsheets\/d\/[^\s]+/gi, ' ')
    .replace(/\b(?:hey\s+)?ultron\b/gi, ' ')
    .replace(/\b(?:find|get|bring|research|source|collect|search|list|show|extract|discover)\s+(?:me\s+)?\d{0,3}\b/gi, ' ')
    .replace(/\b(?:on|using|via)\s+linkedin\b/gi, ' ')
    .replace(/\b(?:companies?|company|people|persons?|professionals?|profiles?|recruiters?|founders?|leads?)\b/gi, ' ')
    .replace(/\b(?:hiring|recruiting|jobs?|vacanc(?:y|ies)|openings?|roles?|positions?)\b/gi, ' ')
    .replace(/\b(?:under|below|fewer\s+than|less\s+than|up\s+to|maximum|max|over|above|more\s+than|at\s+least|minimum|min)\s*\d[\d,]*\s*(?:employees?)?/gi, ' ')
    .replace(/\b(?:remote|hybrid|on[- ]?site|in[- ]?office|easy\s+apply|full[- ]?time|part[- ]?time|contract|internship)\b/gi, ' ')
    .replace(/\b(?:located|based|headquartered)\s+in\b/gi, ' ')
    .replace(/\b(?:from|near|around|with|and)\b/gi, ' ');
  if (location) {
    const escaped = String(location).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    value = value.replace(new RegExp(escaped, 'gi'), ' ');
  }
  value = value.replace(/[.,;:!?()[\]{}]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\bsap\b/i.test(value)) {
    const module = value.match(/\bsap\s+(fico|mm|sd|abap|basis|s\/?4hana|successfactors|hana|bw|bpc|ariba|ewm|tm|btp|cpi|security)\b/i);
    return module ? (/^s\/?4hana$/i.test(module[1]) ? 'SAP S/4HANA' : `SAP ${module[1].toUpperCase()}`) : 'SAP';
  }
  return value || request.topic || (request.entityMode === 'company' ? 'companies' : 'professionals');
}

function wantsMasterSheet(text) {
  return /\b(?:current|same|existing|last|latest|master|consolidated)\s+(?:google\s+)?(?:sheet|spreadsheet)\b/i.test(String(text || ''));
}

function enhanceRequest(request, text, workspaceSheetUrl = null) {
  if (!request) return request;
  const location = genericLocationFromText(text, request.location);
  const inferredLocation = !request.location && Boolean(location);
  const topic = inferredLocation ? genericTopicFromText(text, request, location) : request.topic;
  return {
    ...request,
    location: location || request.location || '',
    locationScope: request.locationScope || (request.hiring ? 'job' : 'company'),
    topic,
    wantsContacts: requestedContactEnrichment(text),
    destinationSheetUrl: request.destinationSheetUrl || (wantsMasterSheet(text) ? workspaceSheetUrl : null),
  };
}

function sheetUrlFromText(text, workspaceSheetUrl = null) {
  return sheets.extractSheetUrl(text) || workspaceSheetUrl || null;
}

function isSetWorkspaceRequest(text) {
  const value = String(text || '');
  return /\b(?:use|set|make|remember)\b[\s\S]{0,45}\b(?:sheet|spreadsheet)\b[\s\S]{0,40}\b(?:current|master|default|linkedin)\b/i.test(value)
    && Boolean(sheets.extractSheetUrl(value));
}

function parseColumnList(value) {
  return String(value || '')
    .replace(/\b(?:to|in|into|on)\s+(?:the\s+)?(?:current|same|existing|master|linkedin)?\s*(?:google\s+)?(?:sheet|spreadsheet)\b[\s\S]*$/i, '')
    .split(/\s*,\s*|\s+and\s+/i)
    .map((item) => item.replace(/^["'`]+|["'`.]+$/g, '').trim())
    .filter(Boolean)
    .slice(0, 20);
}

function parseSheetEdit(text) {
  const value = String(text || '').trim();
  let match = value.match(/\brename\s+(?:the\s+)?(?:column|header)\s+["'`]?([^"'`]+?)["'`]?\s+to\s+["'`]?([^"'`]+?)["'`]?(?=\s+(?:in|on)\s+(?:the\s+)?(?:current|same|existing|master|linkedin)?\s*(?:google\s+)?(?:sheet|spreadsheet)\b|$)/i);
  if (match) return { operation: 'rename', from: match[1].trim(), to: match[2].trim() };

  match = value.match(/\b(?:add|insert|create)\s+(?:a\s+|new\s+|the\s+)*(?:columns?|headers?)\s+(.+)$/i);
  if (match) {
    const columns = parseColumnList(match[1]);
    if (columns.length) return { operation: 'add', columns };
  }

  match = value.match(/\b(?:delete|remove)\s+(?:the\s+)*(?:columns?|headers?)\s+(.+)$/i);
  if (match) {
    const columns = parseColumnList(match[1]);
    if (columns.length) return { operation: 'delete', columns };
  }
  return null;
}

function isSheetEditRequest(text, workspaceSheetUrl = null) {
  if (!sheetUrlFromText(text, workspaceSheetUrl)) return false;
  if (!/\b(?:sheet|spreadsheet|column|header)\b/i.test(String(text || ''))) return false;
  return Boolean(parseSheetEdit(text));
}

function headerScore(row) {
  const known = /^(?:name|company|company name|company link|linkedin|role|job title|job role|job link|location|work type|employees|company size|email|phone|phone number|remarks|website|lead score|source|hiring signal|no of applicants)$/i;
  const nonEmpty = (row || []).map((item) => String(item || '').trim()).filter(Boolean);
  const recognized = nonEmpty.filter((item) => known.test(normalize(item))).length;
  return recognized * 20 + Math.min(nonEmpty.length, 12);
}

async function inspectSheet(sheetUrl) {
  const spreadsheetId = sheets.spreadsheetId(sheetUrl);
  const meta = await sheets.metadata(spreadsheetId);
  const gid = sheets.sheetGid(sheetUrl);
  const tabs = [...(meta.sheets || [])].sort((a, b) => {
    if (gid != null) {
      if (a?.properties?.sheetId === gid) return -1;
      if (b?.properties?.sheetId === gid) return 1;
    }
    return Number(a?.properties?.index || 0) - Number(b?.properties?.index || 0);
  });
  let best = null;
  for (const tab of tabs) {
    const title = tab?.properties?.title;
    if (!title) continue;
    const rows = await sheets.values(spreadsheetId, `${sheets.quoteSheet(title)}!A1:ZZ40`);
    if (!rows.length) {
      if (!best) best = { sheetId: tab.properties.sheetId, sheetName: title, rowIndex: 0, headers: [] };
      continue;
    }
    for (let index = 0; index < Math.min(rows.length, 30); index++) {
      const row = rows[index] || [];
      const score = headerScore(row) - index * 0.1;
      if (!best || score > best.score) best = { sheetId: tab.properties.sheetId, sheetName: title, rowIndex: index, headers: row.map(String), score };
    }
    if (gid != null && tab.properties.sheetId === gid && best) break;
  }
  if (!best) throw new Error('The target Google Sheet has no accessible tab.');
  return {
    spreadsheetId,
    spreadsheetTitle: meta?.properties?.title || 'Google Sheet',
    sheetId: best.sheetId,
    sheetName: best.sheetName,
    headerRowNumber: best.rowIndex + 1,
    headers: best.headers || [],
    url: sheetUrl,
  };
}

async function sheetsApi(url, options = {}) {
  const token = await googleAuth.accessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) throw new Error(data?.error?.message || `Google Sheets API failed (${response.status}).`);
  return data;
}

async function executeSheetEdit(text, workspaceSheetUrl = null) {
  const edit = parseSheetEdit(text);
  if (!edit) throw new Error('I could not safely parse the requested Sheet column edit.');
  const sheetUrl = sheetUrlFromText(text, workspaceSheetUrl);
  if (!sheetUrl) throw new Error('There is no current LinkedIn Sheet. Provide a Google Sheets URL first.');
  const target = await inspectSheet(sheetUrl);
  const headers = target.headers.slice();

  if (edit.operation === 'add') {
    const existing = new Set(headers.map(normalize));
    const added = [];
    for (const column of edit.columns) {
      if (existing.has(normalize(column))) continue;
      const index = headers.length + added.length;
      await sheets.writeCells(target.spreadsheetId, [{
        range: sheets.cellRange(target.sheetName, target.headerRowNumber, index),
        value: column,
      }]);
      existing.add(normalize(column));
      added.push(column);
    }
    return { ok: true, operation: 'add', changed: added, sheetUrl, ...target };
  }

  if (edit.operation === 'rename') {
    const index = headers.findIndex((header) => normalize(header) === normalize(edit.from));
    if (index < 0) throw new Error(`Column “${edit.from}” was not found in the current LinkedIn Sheet.`);
    await sheets.writeCells(target.spreadsheetId, [{
      range: sheets.cellRange(target.sheetName, target.headerRowNumber, index),
      value: edit.to,
    }]);
    return { ok: true, operation: 'rename', changed: [`${edit.from} → ${edit.to}`], sheetUrl, ...target };
  }

  const indices = edit.columns
    .map((column) => ({ column, index: headers.findIndex((header) => normalize(header) === normalize(column)) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => b.index - a.index);
  if (!indices.length) throw new Error('None of the requested columns were found in the current LinkedIn Sheet.');
  await sheetsApi(`${API}/${encodeURIComponent(target.spreadsheetId)}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: indices.map((item) => ({
        deleteDimension: {
          range: { sheetId: target.sheetId, dimension: 'COLUMNS', startIndex: item.index, endIndex: item.index + 1 },
        },
      })),
    }),
  });
  return { ok: true, operation: 'delete', changed: indices.map((item) => item.column), sheetUrl, ...target };
}

module.exports = {
  normalize,
  requestedContactEnrichment,
  genericLocationFromText,
  genericTopicFromText,
  wantsMasterSheet,
  enhanceRequest,
  sheetUrlFromText,
  isSetWorkspaceRequest,
  parseColumnList,
  parseSheetEdit,
  isSheetEditRequest,
  inspectSheet,
  executeSheetEdit,
};
