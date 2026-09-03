const fs = require('fs');
const path = require('path');
const config = require('./config');
const fileVault = require('./file-vault');
const documentRenderer = require('./document-renderer');
const omniFallback = require('./omniroute-fallback');
const omniRoute = require('./omniroute-lazy-hooks');
const nativeVoice = require('./native-voice-input');
const { load: loadCredentials } = require('../../core/credentials/local-store');

const MEDIA_TIMEOUT_MS = Math.max(30000, Number(process.env.ULTRON_M3_MEDIA_TIMEOUT_MS || 180000));
const VIDEO_TIMEOUT_MS = Math.max(MEDIA_TIMEOUT_MS, Number(process.env.ULTRON_M3_VIDEO_TIMEOUT_MS || 360000));
const DOCUMENT_TIMEOUT_MS = Math.max(30000, Number(process.env.ULTRON_M3_DOCUMENT_TIMEOUT_MS || 120000));
const ATTACHMENT_LIMIT = Math.max(1, Math.min(6, Number(process.env.ULTRON_M3_ATTACHMENT_LIMIT || 4)));
const ATTACHMENT_CONTEXT_CHARS = Math.max(6000, Number(process.env.ULTRON_M3_ATTACHMENT_CONTEXT_CHARS || 36000));

async function storedCredentials() {
  try { return await loadCredentials(); } catch { return {}; }
}

async function omniKey() {
  const saved = await storedCredentials();
  return String(process.env.OMNIROUTE_ENDPOINT_KEY || process.env.OMNIROUTE_API_KEY || process.env.ULTRON_OMNIROUTE_API_KEY || saved.OMNIROUTE_ENDPOINT_KEY || saved.OMNIROUTE_API_KEY || saved.ULTRON_OMNIROUTE_API_KEY || '').trim();
}

async function authHeaders(extra = {}) {
  const key = await omniKey();
  return { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extra };
}

function timeoutController(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, done: () => clearTimeout(timer) };
}

async function omniJson(endpoint, { method = 'GET', body = null, timeoutMs = MEDIA_TIMEOUT_MS } = {}) {
  await omniFallback.ensure({ reason: `multimodal ${endpoint} request` });
  const { controller, done } = timeoutController(timeoutMs);
  try {
    const headers = await authHeaders(body ? { 'Content-Type': 'application/json' } : {});
    const response = await fetch(`${config.omnirouteBase}${endpoint}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
    if (!response.ok) {
      const error = new Error(`OmniRoute ${endpoint} HTTP ${response.status}: ${raw.slice(0, 1000)}`);
      error.status = response.status;
      throw error;
    }
    return { data, headers: Object.fromEntries(response.headers.entries()) };
  } finally { done(); }
}

function catalogModels(payload) {
  const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return raw.map((item) => typeof item === 'string' ? { id: item } : item)
    .map((item) => ({ id: String(item?.id || item?.model || item?.name || '').trim(), provider: item?.provider || null }))
    .filter((item) => item.id);
}

async function specialtyModels(kind) {
  const endpoint = kind === 'image' ? '/images/generations' : kind === 'video' ? '/videos/generations' : kind === 'transcription' ? '/audio/transcriptions' : null;
  if (!endpoint) return [];
  try { return catalogModels((await omniJson(endpoint, { timeoutMs: 30000 })).data); }
  catch { return []; }
}

async function selectModel(kind, requested = '') {
  const explicit = String(requested || '').trim();
  if (explicit) return explicit;
  const env = kind === 'image' ? process.env.ULTRON_M3_IMAGE_MODEL : kind === 'video' ? process.env.ULTRON_M3_VIDEO_MODEL : process.env.ULTRON_M3_OCR_MODEL;
  if (String(env || '').trim()) return String(env).trim();
  const models = await specialtyModels(kind);
  return models[0]?.id || (kind === 'ocr' ? 'mistral-ocr-latest' : '');
}

function dataRows(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.results)) return payload.results;
  if (payload?.data && typeof payload.data === 'object') return [payload.data];
  return payload && typeof payload === 'object' ? [payload] : [];
}

function mediaCandidate(row = {}) {
  const url = row.url || row.video_url || row.image_url || row.output_url || row.uri || row.file_url || null;
  const base64 = row.b64_json || row.base64 || row.data_base64 || row.image_base64 || row.video_base64 || null;
  return { url: typeof url === 'string' ? url : null, base64: typeof base64 === 'string' ? base64 : null, mime: row.mime_type || row.mime || null };
}

function extensionFromUrl(url, fallback) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return ext && ext.length <= 6 ? ext : fallback;
  } catch { return fallback; }
}

async function downloadBuffer(url, timeoutMs = VIDEO_TIMEOUT_MS) {
  const { controller, done } = timeoutController(timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Generated media download HTTP ${response.status}.`);
    const arrayBuffer = await response.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), mime: response.headers.get('content-type') || '' };
  } finally { done(); }
}

async function persistGenerated(kind, payload, prompt) {
  const rows = dataRows(payload);
  const artifacts = [];
  for (let index = 0; index < rows.length; index += 1) {
    const candidate = mediaCandidate(rows[index]);
    if (!candidate.url && !candidate.base64) continue;
    let buffer;
    let mime = candidate.mime || (kind === 'image' ? 'image/png' : 'video/mp4');
    let ext = kind === 'image' ? '.png' : '.mp4';
    if (candidate.base64) {
      const raw = candidate.base64.replace(/^data:[^;]+;base64,/i, '');
      buffer = Buffer.from(raw, 'base64');
    } else {
      const downloaded = await downloadBuffer(candidate.url, kind === 'video' ? VIDEO_TIMEOUT_MS : MEDIA_TIMEOUT_MS);
      buffer = downloaded.buffer;
      mime = downloaded.mime || mime;
      ext = extensionFromUrl(candidate.url, ext);
    }
    const entry = fileVault.saveBuffer(buffer, {
      name: `${kind}-${Date.now()}-${index + 1}${ext}`,
      mime,
      kind: 'generated',
      source: 'omniroute',
      metadata: { prompt: String(prompt || '').slice(0, 1200), modality: kind },
    });
    artifacts.push({ ...entry, downloadUrl: `/api/files/download?id=${encodeURIComponent(entry.id)}`, inlineUrl: `/api/files/download?id=${encodeURIComponent(entry.id)}&inline=1` });
  }
  if (!artifacts.length) {
    const receipt = fileVault.saveBuffer(Buffer.from(JSON.stringify(payload, null, 2)), {
      name: `${kind}-${Date.now()}-receipt.json`, mime: 'application/json', kind: 'generated', source: 'omniroute', metadata: { prompt, modality: kind, unresolvedMedia: true },
    });
    artifacts.push({ ...receipt, downloadUrl: `/api/files/download?id=${encodeURIComponent(receipt.id)}` });
  }
  return artifacts;
}

async function generateImage(prompt, options = {}) {
  const model = await selectModel('image', options.model);
  if (!model) throw new Error('OmniRoute has no configured image-generation model.');
  const payload = { model, prompt: String(prompt || '').trim(), ...(options.size ? { size: options.size } : {}), n: 1 };
  const response = await omniJson('/images/generations', { method: 'POST', body: payload, timeoutMs: MEDIA_TIMEOUT_MS });
  return { kind: 'image', model, provider: 'omniroute-media', artifacts: await persistGenerated('image', response.data, prompt), raw: response.data };
}

async function generateVideo(prompt, options = {}) {
  const model = await selectModel('video', options.model);
  if (!model) throw new Error('OmniRoute has no configured video-generation model.');
  const payload = { model, prompt: String(prompt || '').trim(), ...(options.duration ? { duration: options.duration } : {}) };
  const response = await omniJson('/videos/generations', { method: 'POST', body: payload, timeoutMs: VIDEO_TIMEOUT_MS });
  return { kind: 'video', model, provider: 'omniroute-media', artifacts: await persistGenerated('video', response.data, prompt), raw: response.data };
}

function modelText(result) {
  const direct = result?.content ?? result?.response ?? result?.text ?? result?.output_text ?? result?.raw?.choices?.[0]?.message?.content ?? '';
  return typeof direct === 'string' ? direct.trim() : String(direct || '').trim();
}

async function documentContent(prompt, attachmentContext = '') {
  const result = await omniRoute.chat({
    model: 'auto/best-reasoning',
    taskType: 'planning',
    timeoutMs: DOCUMENT_TIMEOUT_MS,
    maxAttempts: 2,
    skipModelValidation: true,
    messages: [
      { role: 'system', content: 'You are ULTRON Document Composer. Produce polished document content in clean Markdown. Follow the user request exactly. Do not include meta commentary, hidden reasoning, download instructions or markdown code fences.' },
      ...(attachmentContext ? [{ role: 'system', content: `PRIVATE ATTACHMENT CONTEXT:\n${attachmentContext.slice(0, ATTACHMENT_CONTEXT_CHARS)}` }] : []),
      { role: 'user', content: String(prompt || '').trim() },
    ],
  });
  const text = modelText(result);
  if (!text) throw new Error('OmniRoute document composer returned no content.');
  return { text, model: result.model || 'auto/best-reasoning', provider: result.provider || 'omniroute-auto' };
}

async function generateDocument(prompt, format = 'pdf', options = {}) {
  const composed = await documentContent(prompt, options.attachmentContext || '');
  const title = String(options.title || 'ULTRON Document').trim().slice(0, 120);
  const target = String(format || 'pdf').toLowerCase() === 'docx' ? 'docx' : 'pdf';
  const buffer = target === 'docx' ? documentRenderer.createDocx(composed.text, title) : documentRenderer.createPdf(composed.text, title);
  const mime = target === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf';
  const entry = fileVault.saveBuffer(buffer, {
    name: `${title.replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/\s+/g, '-').toLowerCase() || 'ultron-document'}.${target}`,
    mime,
    kind: 'generated',
    source: 'omniroute-document-composer',
    metadata: { composerModel: composed.model, prompt: String(prompt || '').slice(0, 1200), format: target },
  });
  return {
    kind: target,
    model: composed.model,
    provider: composed.provider,
    artifacts: [{ ...entry, downloadUrl: `/api/files/download?id=${encodeURIComponent(entry.id)}`, inlineUrl: `/api/files/download?id=${encodeURIComponent(entry.id)}&inline=1` }],
  };
}

function ocrText(payload) {
  if (typeof payload?.text === 'string') return payload.text.trim();
  if (typeof payload?.markdown === 'string') return payload.markdown.trim();
  const pages = Array.isArray(payload?.pages) ? payload.pages : Array.isArray(payload?.data?.pages) ? payload.data.pages : [];
  return pages.map((page) => page?.markdown || page?.text || page?.content || '').filter(Boolean).join('\n\n').trim();
}

async function ocrFile(entry) {
  const buffer = fs.readFileSync(entry.path);
  const model = String(process.env.ULTRON_M3_OCR_MODEL || 'mistral-ocr-latest').trim();
  const dataUrl = `data:${entry.mime || 'application/octet-stream'};base64,${buffer.toString('base64')}`;
  const image = String(entry.mime || '').startsWith('image/');
  const body = { model, document: image ? { type: 'image_url', image_url: dataUrl } : { type: 'document_url', document_url: dataUrl } };
  const response = await omniJson('/ocr', { method: 'POST', body, timeoutMs: MEDIA_TIMEOUT_MS });
  const text = ocrText(response.data);
  if (!text) throw new Error('OmniRoute OCR returned no readable text.');
  return { text, mode: 'omniroute-ocr', model };
}

async function readFile(id, options = {}) {
  const local = fileVault.readLocal(id, { maxChars: options.maxChars || 18000 });
  if (local.supported) return { entry: local.entry, text: local.text, mode: local.mode, truncated: local.truncated };
  const entry = local.entry;
  const mime = String(entry.mime || '').toLowerCase();
  if (mime === 'application/pdf' || mime.startsWith('image/')) {
    const result = await ocrFile(entry);
    return { entry, ...result, truncated: result.text.length > (options.maxChars || 18000), text: result.text.slice(0, options.maxChars || 18000) };
  }
  if (mime.startsWith('audio/') || mime.startsWith('video/')) {
    const buffer = fs.readFileSync(entry.path);
    const result = await nativeVoice.transcribeOmniRoute(buffer, { name: entry.name, mime: entry.mime, language: options.language || 'en' });
    return { entry, text: result.text, mode: 'omniroute-transcription', model: result.model, truncated: false };
  }
  throw new Error(`ULTRON cannot read ${entry.mime || path.extname(entry.name) || 'this file type'} yet.`);
}

function deicticFileReference(message) {
  return /\b(?:this|that|the)\s+(?:file|document|pdf|doc|image|video|audio|attachment)\b|\b(?:read|analy[sz]e|summari[sz]e|explain|check)\s+(?:it|this)\b/i.test(String(message || ''));
}

async function attachmentContext(ids = [], message = '') {
  const requested = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))].slice(0, ATTACHMENT_LIMIT);
  let targets = requested;
  if (!targets.length && deicticFileReference(message)) {
    const recent = fileVault.list(1)[0];
    if (recent && Date.now() - Date.parse(recent.lastUsedAt || recent.createdAt || 0) < 20 * 60 * 1000) targets = [recent.id];
  }
  if (!targets.length) return { ids: [], text: '', files: [] };

  const files = [];
  const blocks = [];
  let used = 0;
  for (const id of targets) {
    try {
      const result = await readFile(id, { maxChars: Math.max(4000, Math.floor(ATTACHMENT_CONTEXT_CHARS / targets.length)) });
      const room = Math.max(0, ATTACHMENT_CONTEXT_CHARS - used);
      const text = result.text.slice(0, room);
      used += text.length;
      files.push({ id, name: result.entry.name, mime: result.entry.mime, mode: result.mode, chars: text.length, truncated: result.truncated || result.text.length > text.length });
      blocks.push(`ATTACHED FILE: ${result.entry.name}\nMIME: ${result.entry.mime}\nREAD MODE: ${result.mode}\nCONTENT:\n${text}`);
    } catch (error) {
      const entry = fileVault.get(id);
      files.push({ id, name: entry?.name || id, mime: entry?.mime || null, error: error.message });
      blocks.push(`ATTACHED FILE: ${entry?.name || id}\nREAD ERROR: ${error.message}`);
    }
  }
  return { ids: targets, text: blocks.join('\n\n---\n\n'), files };
}

function stripWake(text) {
  return String(text || '').trim().replace(/^(?:hey\s+)?ultron\b[\s,:;.!-]*/i, '').trim();
}

function generationIntent(message) {
  const text = stripWake(message);
  const action = /\b(?:generate|create|make|render|design|produce|build)\b/i.test(text);
  if (!action) return null;
  if (/\b(?:image|picture|poster|thumbnail|visual|wallpaper|artwork|logo)\b/i.test(text)) return { kind: 'image', prompt: text };
  if (/\b(?:video|clip|animation|b-roll|broll)\b/i.test(text)) return { kind: 'video', prompt: text };
  if (/\bpdf\b/i.test(text)) return { kind: 'pdf', prompt: text };
  if (/\b(?:docx|word document|word file)\b/i.test(text)) return { kind: 'docx', prompt: text };
  if (/\b(?:document|report|brief|proposal)\b/i.test(text) && /\b(?:file|download|document|report|proposal)\b/i.test(text)) return { kind: 'docx', prompt: text };
  return null;
}

async function generate(intent, options = {}) {
  if (!intent?.kind) throw new Error('Generation intent is required.');
  if (intent.kind === 'image') return generateImage(intent.prompt, options);
  if (intent.kind === 'video') return generateVideo(intent.prompt, options);
  if (intent.kind === 'pdf' || intent.kind === 'docx') return generateDocument(intent.prompt, intent.kind, options);
  throw new Error(`Unsupported generation kind: ${intent.kind}`);
}

async function status() {
  const [voiceStatus, images, videos] = await Promise.all([nativeVoice.status(), Promise.resolve([]), Promise.resolve([])]);
  return {
    mediaTransport: 'omniroute-primary',
    documents: 'omniroute-content + local-renderer',
    fileVault: fileVault.status(),
    nativeVoice: voiceStatus,
    endpoints: { image: '/v1/images/generations', video: '/v1/videos/generations', ocr: '/v1/ocr', transcription: '/v1/audio/transcriptions' },
    imageModelsCached: images.length,
    videoModelsCached: videos.length,
  };
}

module.exports = { specialtyModels, selectModel, generateImage, generateVideo, generateDocument, readFile, attachmentContext, generationIntent, generate, status };
