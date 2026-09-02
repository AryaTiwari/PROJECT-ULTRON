const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const { config } = require('./config');
const { load: loadCredentials } = require('./credentials/local-store');

const DEFAULT_TASK_ALIASES = {
  coding: 'auto/best-coding',
  research: 'auto/best-reasoning',
  planning: 'auto/best-reasoning',
  automation: 'auto/best-fast',
  creative: 'auto/best-fast',
  simple_qa: 'auto/best-fast',
  general: 'auto/best-fast',
};

const BLOCKED_OPENCODE_MODELS = new Set([
  'big-pickle',
  'mimo-v2.5-free',
  'hy3-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'x-preview-f-free',
  'muse-spark-1.2-contributor-free',
]);

let catalogCache = { models: [], fetchedAt: 0 };

function baseUrl() {
  return String(config.router.baseUrl || 'http://127.0.0.1:20128/v1').replace(/\/$/, '');
}

async function apiKey() {
  if (config.router.apiKey) return config.router.apiKey;
  try {
    const saved = await loadCredentials();
    return String(saved.OMNIROUTE_ENDPOINT_KEY || saved.OMNIROUTE_API_KEY || saved.ULTRON_OMNIROUTE_API_KEY || '').trim();
  } catch {
    return '';
  }
}

function headers(key, includeJson = false) {
  const out = includeJson ? { 'Content-Type': 'application/json' } : {};
  if (key) out.Authorization = `Bearer ${key}`;
  return out;
}

function isLoopbackUrl(target) {
  try {
    const host = new URL(target).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function abortError(message = 'The operation was aborted.') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.status = 408;
  return error;
}

function directHttpFetch(target, options = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(target); }
    catch (error) { reject(error); return; }

    const transport = url.protocol === 'https:' ? https : http;
    const method = options.method || 'GET';
    const reqHeaders = { ...(options.headers || {}) };
    const body = options.body == null ? null : Buffer.from(String(options.body));
    if (body && !reqHeaders['Content-Length'] && !reqHeaders['content-length']) reqHeaders['Content-Length'] = String(body.length);

    let responseStream = null;
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers: reqHeaders,
    }, (res) => {
      responseStream = res;
      resolve(new Response(res, {
        status: res.statusCode || 0,
        statusText: res.statusMessage || '',
        headers: res.headers,
      }));
    });

    req.once('error', reject);

    if (options.signal) {
      const abort = () => {
        const error = abortError();
        try { responseStream?.destroy(error); } catch {}
        try { req.destroy(error); } catch {}
      };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }

    if (body) req.write(body);
    req.end();
  });
}

async function ultronFetch(target, options = {}) {
  return isLoopbackUrl(target) ? directHttpFetch(target, options) : fetch(target, options);
}

function attachRequestContext(response, context) {
  try {
    Object.defineProperty(response, '__ultronRequestContext', {
      value: context,
      enumerable: false,
      configurable: true,
    });
  } catch {}
  return response;
}

function cleanupResponse(response) {
  const context = response?.__ultronRequestContext;
  if (context?.timer) clearTimeout(context.timer);
}

async function request(pathname, options = {}) {
  const key = await apiKey();
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || config.router.timeoutMs || 120000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const target = `${baseUrl()}${pathname}`;
    const response = await ultronFetch(target, {
      method: options.method || 'GET',
      headers: { ...headers(key, options.body != null), ...(options.headers || {}) },
      body: options.body,
      signal: controller.signal,
    });
    return attachRequestContext(response, { controller, timer, timeoutMs });
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted || error?.name === 'AbortError') {
      const timeoutError = new Error(`OmniRoute request timed out after ${timeoutMs}ms.`);
      timeoutError.status = 408;
      throw timeoutError;
    }
    const wrapped = new Error(`OmniRoute connection failed: ${error?.cause?.message || error?.message || String(error)}`);
    wrapped.status = Number(error?.status || 0) || 503;
    throw wrapped;
  }
}

async function parseResponse(response) {
  const context = response?.__ultronRequestContext;
  let raw = '';
  try {
    raw = await response.text();
  } catch (error) {
    if (context?.controller?.signal?.aborted || error?.name === 'AbortError') {
      const timeoutError = new Error(`OmniRoute response body timed out after ${context?.timeoutMs || 'configured'}ms.`);
      timeoutError.status = 408;
      throw timeoutError;
    }
    const wrapped = new Error(`OmniRoute response body failed: ${error?.message || String(error)}`);
    wrapped.status = 502;
    throw wrapped;
  } finally {
    cleanupResponse(response);
  }

  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { data = { raw }; }

  if (!response.ok) {
    const error = new Error(`OmniRoute HTTP ${response.status}: ${raw.slice(0, 1200)}`);
    error.status = response.status;
    error.raw = raw;
    throw error;
  }
  return data;
}

function normalizeModelId(value) {
  const model = String(value || '').trim();
  return model.toLowerCase().startsWith('omniroute/') ? model.slice('omniroute/'.length) : model;
}

function modelIds(payload) {
  const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return raw
    .map((item) => typeof item === 'string' ? item : item?.id || item?.model || item?.name || '')
    .map(String)
    .map((value) => value.trim())
    .filter(Boolean);
}

function isOpenCodeModel(model) {
  const value = normalizeModelId(model).toLowerCase();
  return value === 'opencode'
    || value.startsWith('opencode/')
    || value.startsWith('opencode-go/')
    || value.startsWith('oc/')
    || value.includes('big-pickle')
    || value.includes('big_pickle')
    || value.includes('big pickle')
    || BLOCKED_OPENCODE_MODELS.has(value);
}

function isNvidiaModel(model) {
  return normalizeModelId(model).toLowerCase().startsWith('nvidia/');
}

function mark3OpenCodeDisabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.ULTRON_M3_DISABLE_OPENCODE || ''));
}

async function listModels({ force = false } = {}) {
  const ttlMs = Number(process.env.OMNIROUTE_MODEL_CACHE_MS || 300000);
  if (!force && catalogCache.models.length && Date.now() - catalogCache.fetchedAt < ttlMs) return [...catalogCache.models];
  const response = await request('/models', { timeoutMs: 10000 });
  const data = await parseResponse(response);
  const models = [...new Set(modelIds(data))];
  catalogCache = { models, fetchedAt: Date.now() };
  return [...models];
}

async function isConfigured() {
  return Boolean(await apiKey());
}

async function hasModel(model) {
  const target = normalizeModelId(model);
  if (!target || (mark3OpenCodeDisabled() && (isOpenCodeModel(target) || isNvidiaModel(target)))) return false;
  try { return (await listModels()).includes(target); }
  catch { return false; }
}

function candidateAliases(taskType) {
  const override = String(process.env[`ULTRON_OMNIROUTE_MODEL_${String(taskType || 'general').toUpperCase()}`] || '').trim();
  const mapped = DEFAULT_TASK_ALIASES[String(taskType || 'general')] || DEFAULT_TASK_ALIASES.general;
  const general = String(process.env.ULTRON_OMNIROUTE_DEFAULT_MODEL || '').trim();
  return [override, mapped, general, 'auto', 'auto/best-fast', 'auto/best-reasoning'].filter(Boolean);
}

async function resolveModel(requestedModel = 'auto', taskType = 'general') {
  const requested = normalizeModelId(requestedModel);
  if (requested && requested !== 'auto') {
    if (mark3OpenCodeDisabled() && (isOpenCodeModel(requested) || isNvidiaModel(requested))) {
      throw new Error(`Disabled Mark 3 model: ${requested}`);
    }
    try {
      const liveModels = await listModels();
      if (liveModels.length && !liveModels.includes(requested)) return resolveModel('auto', taskType);
    } catch {}
    return requested;
  }

  let models = [];
  try { models = await listModels({ force: true }); } catch {}
  const candidates = candidateAliases(taskType);

  if (!mark3OpenCodeDisabled()) {
    for (const candidate of candidates) if (!models.length || models.includes(candidate)) return candidate;
    return 'auto';
  }

  const concrete = models.filter((id) => !/^auto(?:\/|$)/i.test(id) && !isOpenCodeModel(id) && !isNvidiaModel(id));
  const preferredPrefixes = ['gemini/', 'openai/', 'anthropic/', 'deepseek/', 'groq/', 'mistral/', 'xai/', 'qwen/', 'vertex/', 'pollinations/'];
  for (const prefix of preferredPrefixes) {
    const hit = concrete.find((id) => id.toLowerCase().startsWith(prefix));
    if (hit) return hit;
  }
  if (concrete.length) return concrete[0];
  throw new Error('Mark 3 has OpenCode/NVIDIA disabled and OmniRoute published no usable concrete model.');
}

function transientStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part === 'string' ? part : part?.text || part?.content || part?.value || '').filter(Boolean).join('');
  if (content && typeof content === 'object') return String(content.text || content.content || content.value || '');
  return '';
}

function extractInference(data) {
  const choice = data?.choices?.[0] || {};
  const message = choice?.message || {};
  const delta = choice?.delta || {};
  const output = data?.output;
  const candidates = [
    message.content,
    message.text,
    delta.content,
    delta.text,
    choice.text,
    output?.[0]?.content,
    data?.output_text,
    data?.response,
    data?.content,
    data?.text,
  ];
  const content = candidates.map(textFromContent).find((value) => value.trim()) || '';
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return { content, toolCalls, finishReason: choice?.finish_reason || null };
}

async function chat({ messages, model = 'auto', taskType = 'general', tools = null, timeoutMs = null, maxAttempts = null, skipModelValidation = false } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('OmniRoute request requires messages.');

  const requested = normalizeModelId(model);
  const resolvedModel = skipModelValidation && requested ? requested : await resolveModel(model, taskType);
  if (mark3OpenCodeDisabled() && (isOpenCodeModel(resolvedModel) || isNvidiaModel(resolvedModel))) throw new Error(`Disabled Mark 3 model: ${resolvedModel}`);

  const modelCandidates = mark3OpenCodeDisabled()
    ? [resolvedModel]
    : [resolvedModel, ...(resolvedModel !== 'auto' && taskType ? ['auto'] : []), ...(!['auto', 'auto/best-fast'].includes(resolvedModel) ? ['auto/best-fast'] : [])];
  const attemptsPerCandidate = Math.max(1, Math.min(3, Number(maxAttempts || 2)));
  let lastError = null;

  for (const candidate of [...new Set(modelCandidates)]) {
    if (mark3OpenCodeDisabled() && (isOpenCodeModel(candidate) || isNvidiaModel(candidate))) continue;
    const body = { model: candidate, messages, stream: false };
    if (Array.isArray(tools) && tools.length) body.tools = tools;

    for (let attempt = 0; attempt < attemptsPerCandidate; attempt += 1) {
      try {
        const response = await request('/chat/completions', { method: 'POST', body: JSON.stringify(body), timeoutMs: timeoutMs || undefined });
        const data = await parseResponse(response);
        if (mark3OpenCodeDisabled() && (isOpenCodeModel(data?.model) || isNvidiaModel(data?.model))) {
          const error = new Error(`OmniRoute returned a disabled Mark 3 model: ${data?.model}`);
          error.status = 502;
          throw error;
        }
        const extracted = extractInference(data);
        if (!extracted.content.trim() && !extracted.toolCalls.length) {
          const error = new Error('OmniRoute returned a successful HTTP response without usable final text/tool calls.');
          error.status = 502;
          throw error;
        }
        return { content: extracted.content, toolCalls: extracted.toolCalls, finishReason: extracted.finishReason, model: data?.model || candidate, provider: 'omniroute', raw: data, requestedModel: model, taskType };
      } catch (error) {
        lastError = error;
        if (!transientStatus(error?.status)) throw error;
        if (attempt + 1 < attemptsPerCandidate) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  throw lastError || new Error('OmniRoute inference failed.');
}

function parseSseBlock(block) {
  const dataLines = String(block || '').replace(/\r/g, '').split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart());
  return dataLines.length ? dataLines.join('\n') : null;
}

function findSseBoundary(buffer) {
  const crlf = buffer.indexOf('\r\n\r\n');
  const lf = buffer.indexOf('\n\n');
  if (crlf < 0) return lf;
  if (lf < 0) return crlf;
  return Math.min(crlf, lf);
}

function sseBoundaryLength(buffer, index) {
  return buffer.slice(index, index + 4) === '\r\n\r\n' ? 4 : 2;
}

async function streamChat({ messages, model = 'auto', taskType = 'general', tools = null, onDelta, firstTokenTimeoutMs = null, skipModelValidation = false } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('OmniRoute streaming request requires messages.');
  if (typeof onDelta !== 'function') throw new Error('OmniRoute streaming request requires an onDelta callback.');

  const requested = normalizeModelId(model);
  const resolvedModel = skipModelValidation && requested ? requested : await resolveModel(model, taskType);
  const configuredFirstTokenTimeout = Math.max(3000, Number(firstTokenTimeoutMs || process.env.ULTRON_STREAM_FIRST_TOKEN_TIMEOUT_MS || 15000));
  const qualitySensitive = ['coding', 'research', 'planning'].includes(String(taskType || '').toLowerCase());
  const candidates = mark3OpenCodeDisabled() ? [resolvedModel] : [...new Set([resolvedModel, ...(qualitySensitive ? [] : ['auto/best-fast']), ...(resolvedModel !== 'auto' ? ['auto'] : [])])];
  let lastError = null;

  for (const candidate of candidates) {
    if (mark3OpenCodeDisabled() && (isOpenCodeModel(candidate) || isNvidiaModel(candidate))) continue;
    let controller = null;
    let firstTokenTimer = null;
    let gotMeaningfulEvent = false;

    try {
      const key = await apiKey();
      controller = new AbortController();
      const markFirstEvent = () => {
        if (!gotMeaningfulEvent) {
          gotMeaningfulEvent = true;
          if (firstTokenTimer) clearTimeout(firstTokenTimer);
          firstTokenTimer = null;
        }
      };
      firstTokenTimer = setTimeout(() => controller.abort(), configuredFirstTokenTimeout);

      const url = `${baseUrl()}/chat/completions`;
      const response = await ultronFetch(url, {
        method: 'POST',
        headers: headers(key, true),
        body: JSON.stringify({ model: candidate, messages, stream: true, ...(Array.isArray(tools) && tools.length ? { tools } : {}) }),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (firstTokenTimer) clearTimeout(firstTokenTimer);
        firstTokenTimer = null;
        const raw = await response.text();
        const error = new Error(`OmniRoute HTTP ${response.status}: ${raw.slice(0, 1200)}`);
        error.status = response.status;
        throw error;
      }
      if (!response.body) throw new Error('OmniRoute streaming response has no body.');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let toolCalls = [];
      let finishReason = null;
      let observedModel = candidate;

      const consume = (block) => {
        const event = parseSseBlock(block);
        if (!event || event === '[DONE]') return;
        let data;
        try { data = JSON.parse(event); }
        catch { return; }

        const choice = data?.choices?.[0] || {};
        const delta = choice?.delta || {};
        if (data?.model) observedModel = data.model;
        const text = textFromContent(delta.content || delta.text || choice.text || data?.output_text || data?.text || '');

        if (text) {
          if (mark3OpenCodeDisabled() && (isOpenCodeModel(observedModel) || isNvidiaModel(observedModel))) throw new Error(`OmniRoute streaming selected disabled Mark 3 model: ${observedModel}`);
          markFirstEvent();
          fullText += text;
          onDelta(text, { model: observedModel, finishReason: choice?.finish_reason || null });
        }
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
          markFirstEvent();
          toolCalls.push(...delta.tool_calls);
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      };

      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = findSseBoundary(buffer)) >= 0) {
          const separatorLength = sseBoundaryLength(buffer, boundary);
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + separatorLength);
          consume(block);
        }
      }

      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      firstTokenTimer = null;
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);

      if (!gotMeaningfulEvent && !toolCalls.length) {
        const error = new Error('OmniRoute streaming returned no usable final content.');
        error.status = 502;
        throw error;
      }

      return { content: fullText, toolCalls, finishReason, model: observedModel, provider: 'omniroute', requestedModel: model, taskType };
    } catch (error) {
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      firstTokenTimer = null;
      lastError = error;
      if (controller?.signal?.aborted || error?.name === 'AbortError') {
        const timeoutError = new Error(`OmniRoute first token exceeded ${configuredFirstTokenTimeout}ms for ${candidate}.`);
        timeoutError.status = 408;
        lastError = timeoutError;
        if (qualitySensitive) throw timeoutError;
        continue;
      }
      if (!transientStatus(error?.status)) throw error;
    }
  }
  throw lastError || new Error('OmniRoute streaming failed.');
}

async function health() {
  const started = Date.now();
  try {
    const response = await request('/models', { timeoutMs: 10000 });
    const data = await parseResponse(response);
    const models = modelIds(data);
    return { ok: true, authenticated: Boolean(await apiKey()), endpoint: baseUrl(), modelCount: models.length, catalogSample: models.slice(0, 12), latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, authenticated: Boolean(await apiKey()), endpoint: baseUrl(), modelCount: catalogCache.models.length, latencyMs: Date.now() - started, error: error.message };
  }
}

function clearCache() {
  catalogCache = { models: [], fetchedAt: 0 };
}

module.exports = { listModels, hasModel, resolveModel, chat, streamChat, health, isConfigured, normalizeModelId, clearCache, extractInference };
