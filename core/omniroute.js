const { config } = require('./config');
const { load: loadCredentials } = require('./credentials/local-store');

const DEFAULT_TASK_ALIASES = {
  coding: 'auto/best-coding', research: 'auto/best-reasoning', planning: 'auto/best-reasoning',
  automation: 'auto/best-fast', creative: 'auto/best-fast', simple_qa: 'auto/best-fast', general: 'auto/best-fast',
};
let catalogCache = { models: [], fetchedAt: 0 };
function baseUrl() { return String(config.router.baseUrl || 'http://127.0.0.1:20128/v1').replace(/\/$/, ''); }
async function apiKey() { if (config.router.apiKey) return config.router.apiKey; try { const saved = await loadCredentials(); return String(saved.OMNIROUTE_API_KEY || saved.ULTRON_OMNIROUTE_API_KEY || '').trim(); } catch { return ''; } }
function headers(key, includeJson = false) { const out = includeJson ? { 'Content-Type': 'application/json' } : {}; if (key) out.Authorization = `Bearer ${key}`; return out; }
async function request(pathname, options = {}) { const key = await apiKey(); const controller = new AbortController(); const timeoutMs = Number(options.timeoutMs || config.router.timeoutMs || 120000); const timer = setTimeout(() => controller.abort(), timeoutMs); try { return await fetch(`${baseUrl()}${pathname}`, { method: options.method || 'GET', headers: { ...headers(key, options.body != null), ...(options.headers || {}) }, body: options.body, signal: controller.signal }); } catch (error) { if (error?.name === 'AbortError') throw new Error(`OmniRoute request timed out after ${timeoutMs}ms.`); throw new Error(`OmniRoute connection failed: ${error?.message || String(error)}`); } finally { clearTimeout(timer); } }
async function parseResponse(response) { const raw = await response.text(); let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; } if (!response.ok) { const error = new Error(`OmniRoute HTTP ${response.status}: ${raw.slice(0, 1200)}`); error.status = response.status; error.raw = raw; throw error; } return data; }
function normalizeModelId(value) { const model = String(value || '').trim(); return model.toLowerCase().startsWith('omniroute/') ? model.slice('omniroute/'.length) : model; }
function modelIds(payload) { const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []; return raw.map(item => typeof item === 'string' ? item : item?.id || item?.model || item?.name || '').map(String).map(s => s.trim()).filter(Boolean); }
async function listModels({ force = false } = {}) { const ttlMs = Number(process.env.OMNIROUTE_MODEL_CACHE_MS || 300000); if (!force && catalogCache.models.length && Date.now() - catalogCache.fetchedAt < ttlMs) return [...catalogCache.models]; const response = await request('/models', { timeoutMs: 10000 }); const data = await parseResponse(response); const models = [...new Set(modelIds(data))]; catalogCache = { models, fetchedAt: Date.now() }; return [...models]; }
async function isConfigured() { return Boolean(await apiKey()); }
async function hasModel(model) { const target = normalizeModelId(model); if (!target) return false; try { return (await listModels()).includes(target); } catch { return false; } }
function candidateAliases(taskType) { const override = String(process.env[`ULTRON_OMNIROUTE_MODEL_${String(taskType || 'general').toUpperCase()}`] || '').trim(); const mapped = DEFAULT_TASK_ALIASES[String(taskType || 'general')] || DEFAULT_TASK_ALIASES.general; const general = String(process.env.ULTRON_OMNIROUTE_DEFAULT_MODEL || '').trim(); return [override, mapped, general, 'auto', 'auto/best-fast', 'auto/best-reasoning'].filter(Boolean); }
async function resolveModel(requestedModel = 'auto', taskType = 'general') { const requested = normalizeModelId(requestedModel); if (requested && requested !== 'auto') return requested; let models = []; try { models = await listModels(); } catch {} const candidates = candidateAliases(taskType); for (const candidate of candidates) if (!models.length || models.includes(candidate)) return candidate; return 'auto'; }
function transientStatus(status) { return [408, 425, 429, 500, 502, 503, 504].includes(Number(status)); }
function textFromContent(content) { if (typeof content === 'string') return content; if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : part?.text || part?.content || part?.value || '').filter(Boolean).join(''); if (content && typeof content === 'object') return String(content.text || content.content || content.value || ''); return ''; }
function extractInference(data) { const choice = data?.choices?.[0] || {}, message = choice?.message || {}, delta = choice?.delta || {}, output = data?.output; const candidates = [message.content, message.text, message.reasoning_content, delta.content, delta.text, delta.reasoning_content, choice.text, output?.[0]?.content, data?.output_text, data?.response, data?.content, data?.text]; const content = candidates.map(textFromContent).find(value => value.trim()) || ''; const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []; const finishReason = choice?.finish_reason || null; return { content, toolCalls, finishReason }; }
async function chat({ messages, model = 'auto', taskType = 'general', tools = null } = {}) { if (!Array.isArray(messages) || !messages.length) throw new Error('OmniRoute request requires messages.'); const resolvedModel = await resolveModel(model, taskType); const modelCandidates = [resolvedModel]; if (resolvedModel !== 'auto' && taskType) modelCandidates.push('auto'); if (!modelCandidates.includes('auto/best-fast')) modelCandidates.push('auto/best-fast'); let lastError = null; for (const candidate of [...new Set(modelCandidates)]) { const body = { model: candidate, messages, stream: false }; if (Array.isArray(tools) && tools.length) body.tools = tools; for (let attempt = 0; attempt < 2; attempt += 1) { try { const response = await request('/chat/completions', { method: 'POST', body: JSON.stringify(body) }); const data = await parseResponse(response); const extracted = extractInference(data); if (!extracted.content.trim() && !extracted.toolCalls.length) { const error = new Error('OmniRoute returned a successful HTTP response without usable text/tool calls.'); error.status = 502; error.responseShape = { keys: Object.keys(data || {}), choiceKeys: Object.keys(data?.choices?.[0] || {}), messageKeys: Object.keys(data?.choices?.[0]?.message || {}), finishReason: extracted.finishReason, model: data?.model || candidate }; throw error; } return { content: extracted.content, toolCalls: extracted.toolCalls, finishReason: extracted.finishReason, model: data?.model || candidate, provider: 'omniroute', raw: data, requestedModel: model, taskType }; } catch (error) { lastError = error; if (!transientStatus(error?.status)) throw error; if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 350)); } } } throw lastError || new Error('OmniRoute inference failed.'); }
function parseSseBlock(block) { const dataLines = String(block || '').replace(/\r/g, '').split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()); return dataLines.length ? dataLines.join('\n') : null; }
function findSseBoundary(buffer) { const crlf = buffer.indexOf('\r\n\r\n'); const lf = buffer.indexOf('\n\n'); if (crlf < 0) return lf; if (lf < 0) return crlf; return Math.min(crlf, lf); }
function sseBoundaryLength(buffer, index) { return buffer.slice(index, index + 4) === '\r\n\r\n' ? 4 : 2; }

async function streamChat({ messages, model = 'auto', taskType = 'general', tools = null, onDelta, firstTokenTimeoutMs = null } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('OmniRoute streaming request requires messages.');
  if (typeof onDelta !== 'function') throw new Error('OmniRoute streaming request requires an onDelta callback.');
  const resolvedModel = await resolveModel(model, taskType);
  const qualitySensitive = ['coding', 'research', 'planning'].includes(String(taskType || '').toLowerCase());
  const configuredFirstTokenTimeout = Number(firstTokenTimeoutMs || process.env.ULTRON_STREAM_FIRST_TOKEN_TIMEOUT_MS || (qualitySensitive ? 12000 : 5000));
  const candidates = [...new Set([resolvedModel, ...(qualitySensitive ? [] : ['auto/best-fast']), ...(resolvedModel !== 'auto' ? ['auto'] : [])])];
  let lastError = null;

  for (const candidate of candidates) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let controller = null;
      let firstTokenTimer = null;
      let gotDelta = false;
      try {
        const key = await apiKey();
        controller = new AbortController();
        firstTokenTimer = setTimeout(() => {
          if (!gotDelta) controller.abort();
        }, configuredFirstTokenTimeout);
        const response = await fetch(`${baseUrl()}/chat/completions`, {
          method: 'POST', headers: headers(key, true),
          body: JSON.stringify({ model: candidate, messages, stream: true, ...(Array.isArray(tools) && tools.length ? { tools } : {}) }),
          signal: controller.signal,
        });
        clearTimeout(firstTokenTimer); firstTokenTimer = null;
        if (!response.ok) {
          const raw = await response.text();
          const error = new Error(`OmniRoute HTTP ${response.status}: ${raw.slice(0, 1200)}`);
          error.status = response.status; throw error;
        }
        if (!response.body) throw new Error('OmniRoute streaming response has no body.');
        const decoder = new TextDecoder(); let buffer = ''; let fullText = ''; let toolCalls = []; let finishReason = null;
        const consume = (block) => {
          const event = parseSseBlock(block); if (!event || event === '[DONE]') return;
          let data; try { data = JSON.parse(event); } catch { return; }
          const choice = data?.choices?.[0] || {}; const delta = choice?.delta || {};
          const text = textFromContent(delta.content || delta.text || delta.reasoning_content || choice.text || data?.output_text || data?.text || '');
          if (text) { gotDelta = true; fullText += text; onDelta(text, { model: data?.model || candidate, finishReason: choice?.finish_reason || null, firstTokenMs: fullText.length === text.length ? Date.now() : undefined }); }
          if (Array.isArray(delta.tool_calls)) toolCalls.push(...delta.tool_calls);
          if (choice?.finish_reason) finishReason = choice.finish_reason;
        };
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let boundary;
          while ((boundary = findSseBoundary(buffer)) >= 0) {
            const separatorLength = sseBoundaryLength(buffer, boundary);
            const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + separatorLength); consume(block);
          }
        }
        buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
        if (!gotDelta && !toolCalls.length) { const error = new Error('OmniRoute streaming returned no usable content.'); error.status = 502; throw error; }
        return { content: fullText, toolCalls, finishReason, model: candidate, provider: 'omniroute', requestedModel: model, taskType };
      } catch (error) {
        if (firstTokenTimer) clearTimeout(firstTokenTimer);
        lastError = error;
        const abortedForFirstToken = error?.name === 'AbortError' && !gotDelta;
        if (abortedForFirstToken) {
          if (!qualitySensitive && candidate !== 'auto/best-fast') break;
          if (qualitySensitive) throw new Error(`OmniRoute first token exceeded ${configuredFirstTokenTimeout}ms for ${candidate}.`);
        }
        if (!transientStatus(error?.status)) throw error;
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 350));
      }
    }
  }
  throw lastError || new Error('OmniRoute streaming failed.');
}

async function health() { const started = Date.now(); try { const response = await request('/models', { timeoutMs: 10000 }); const data = await parseResponse(response); const models = modelIds(data); return { ok: true, authenticated: Boolean(await apiKey()), endpoint: baseUrl(), modelCount: models.length, catalogSample: models.slice(0, 12), latencyMs: Date.now() - started }; } catch (error) { return { ok: false, authenticated: Boolean(await apiKey()), endpoint: baseUrl(), modelCount: catalogCache.models.length, latencyMs: Date.now() - started, error: error.message }; } }
function clearCache() { catalogCache = { models: [], fetchedAt: 0 }; }
module.exports = { listModels, hasModel, resolveModel, chat, streamChat, health, isConfigured, normalizeModelId, clearCache, extractInference };
