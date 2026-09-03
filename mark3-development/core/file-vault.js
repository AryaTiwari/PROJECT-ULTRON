const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { readJson, writeJsonAtomic } = require('./persistence');
const { readZipEntry } = require('./archive');

const ROOT = path.join(config.dataDir, 'files');
const INDEX = path.join(ROOT, 'index.json');
const MAX_FILE_BYTES = Math.max(1024 * 1024, Number(process.env.ULTRON_M3_FILE_MAX_BYTES || 24 * 1024 * 1024));
const MAX_GENERATED_BYTES = Math.max(MAX_FILE_BYTES, Number(process.env.ULTRON_M3_GENERATED_FILE_MAX_BYTES || 128 * 1024 * 1024));
const MAX_CONTEXT_CHARS = Math.max(4000, Number(process.env.ULTRON_M3_FILE_CONTEXT_CHARS || 32000));

fs.mkdirSync(ROOT, { recursive: true });

function state() {
  const value = readJson(INDEX, { version: 1, files: [] });
  value.files ||= [];
  return value;
}

function saveState(value) {
  value.version = 1;
  writeJsonAtomic(INDEX, value);
}

function safeName(name) {
  const base = path.basename(String(name || 'attachment')).replace(/[^A-Za-z0-9._ -]+/g, '_').trim();
  return (base || 'attachment').slice(0, 120);
}

function mimeFromName(name, fallback = 'application/octet-stream') {
  const ext = path.extname(String(name || '')).toLowerCase();
  return ({
    '.txt':'text/plain','.md':'text/markdown','.json':'application/json','.csv':'text/csv','.html':'text/html','.htm':'text/html',
    '.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif',
    '.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.ogg':'audio/ogg','.webm':'audio/webm',
    '.mp4':'video/mp4','.mov':'video/quicktime','.mkv':'video/x-matroska',
  })[ext] || fallback;
}

function extensionForMime(mime, originalName = '') {
  const existing = path.extname(String(originalName || '')).toLowerCase();
  if (existing) return existing;
  return ({
    'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','video/mp4':'.mp4','audio/mpeg':'.mp3','audio/wav':'.wav',
    'application/pdf':'.pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'.docx','text/plain':'.txt',
  })[String(mime || '').toLowerCase()] || '.bin';
}

function makeId(prefix = 'file') {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function saveBuffer(buffer, options = {}) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (!data.length) throw new Error('File is empty.');
  const kind = options.kind || 'upload';
  const limit = kind === 'generated' ? MAX_GENERATED_BYTES : MAX_FILE_BYTES;
  if (data.length > limit) throw new Error(`File exceeds the ${Math.round(limit / 1024 / 1024)} MB ${kind === 'generated' ? 'generated artifact' : 'local attachment'} limit.`);
  const name = safeName(options.name || 'attachment');
  const mime = String(options.mime || mimeFromName(name)).trim() || 'application/octet-stream';
  const id = makeId(kind === 'generated' ? 'artifact' : 'file');
  const ext = extensionForMime(mime, name);
  const diskName = `${id}${ext}`;
  const filePath = path.join(ROOT, diskName);
  fs.writeFileSync(filePath, data);
  const entry = {
    id,
    name,
    mime,
    size: data.length,
    diskName,
    kind,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    source: options.source || 'local',
    metadata: options.metadata || null,
  };
  const index = state();
  index.files = [entry, ...index.files.filter((item) => item.id !== id)].slice(0, 200);
  saveState(index);
  return entry;
}

function saveBase64({ name, mime, dataBase64, kind = 'upload', metadata = null } = {}) {
  const raw = String(dataBase64 || '').replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
  if (!raw) throw new Error('File data is required.');
  let buffer;
  try { buffer = Buffer.from(raw, 'base64'); } catch { throw new Error('Invalid base64 file data.'); }
  return saveBuffer(buffer, { name, mime, kind, metadata });
}

function get(id) {
  const entry = state().files.find((item) => item.id === String(id || ''));
  if (!entry) return null;
  const filePath = path.join(ROOT, entry.diskName);
  if (!filePath.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(filePath)) return null;
  return { ...entry, path: filePath };
}

function touch(id) {
  const index = state();
  const entry = index.files.find((item) => item.id === String(id || ''));
  if (!entry) return;
  entry.lastUsedAt = new Date().toISOString();
  saveState(index);
}

function list(limit = 30) {
  return state().files.slice(0, Math.max(1, Math.min(100, Number(limit) || 30))).map(({ diskName, ...entry }) => entry);
}

function stripHtml(value) {
  return String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function docxText(buffer) {
  const xml = readZipEntry(buffer, 'word/document.xml');
  if (!xml) throw new Error('DOCX does not contain word/document.xml.');
  return xml.toString('utf8')
    .replace(/<w:tab\s*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function readLocal(id, options = {}) {
  const entry = get(id);
  if (!entry) throw new Error(`Attachment not found: ${id}`);
  touch(id);
  const buffer = fs.readFileSync(entry.path);
  const ext = path.extname(entry.name).toLowerCase();
  let text = '';
  let mode = 'unsupported';
  if (entry.mime.startsWith('text/') || ['.txt','.md','.csv','.json'].includes(ext)) {
    text = buffer.toString('utf8');
    mode = 'local-text';
  } else if (entry.mime.includes('json') || ext === '.json') {
    text = buffer.toString('utf8');
    mode = 'local-json';
  } else if (entry.mime.includes('html') || ['.html','.htm'].includes(ext)) {
    text = stripHtml(buffer.toString('utf8'));
    mode = 'local-html';
  } else if (entry.mime.includes('wordprocessingml') || ext === '.docx') {
    text = docxText(buffer);
    mode = 'local-docx';
  }
  const max = Math.max(1000, Number(options.maxChars || MAX_CONTEXT_CHARS));
  return {
    entry,
    supported: Boolean(text),
    mode,
    text: text.slice(0, max),
    truncated: text.length > max,
    buffer: options.includeBuffer ? buffer : undefined,
  };
}

function status() {
  return { root: ROOT, maxFileBytes: MAX_FILE_BYTES, maxGeneratedBytes: MAX_GENERATED_BYTES, maxContextChars: MAX_CONTEXT_CHARS, count: state().files.length };
}

module.exports = { ROOT, MAX_FILE_BYTES, MAX_GENERATED_BYTES, MAX_CONTEXT_CHARS, safeName, mimeFromName, saveBuffer, saveBase64, get, touch, list, readLocal, status };
