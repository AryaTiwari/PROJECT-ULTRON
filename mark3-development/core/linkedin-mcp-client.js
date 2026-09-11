const { spawn } = require('child_process');
const policy = require('./linkedin-account-policy');

const HOST = '127.0.0.1';
const PORT = Math.max(1024, Math.min(65535, Number(process.env.ULTRON_M3_LINKEDIN_MCP_PORT || 8793)));
const ENDPOINT = `http://${HOST}:${PORT}/mcp`;
const PACKAGE_SPEC = String(process.env.ULTRON_M3_LINKEDIN_MCP_PACKAGE || 'mcp-server-linkedin@4.24.0').trim();
const START_TIMEOUT_MS = Math.max(5000, Number(process.env.ULTRON_M3_LINKEDIN_MCP_START_TIMEOUT_MS || 90000));
const TOOL_TIMEOUT_MS = Math.max(15000, Number(process.env.ULTRON_M3_LINKEDIN_MCP_TOOL_TIMEOUT_MS || 180000));

let child = null;
let startPromise = null;
let sessionId = null;
let requestId = 100;
let lastStderr = '';

function uvxCommand() {
  return process.platform === 'win32' ? 'uvx.exe' : 'uvx';
}

function serverArgs() {
  return [
    PACKAGE_SPEC,
    '--transport', 'streamable-http',
    '--host', HOST,
    '--port', String(PORT),
    '--log-level', 'WARNING',
    '--no-auto-import',
    '--login-inline-wait', '0',
  ];
}

function serverEnv() {
  return {
    ...process.env,
    HEADLESS: 'true',
    AUTO_IMPORT_FROM_BROWSER: 'false',
    LOGIN_INLINE_WAIT: '0',
    HOST,
    PORT: String(PORT),
    TRANSPORT: 'streamable-http',
    BROWSER_IDLE_TIMEOUT: String(process.env.ULTRON_M3_LINKEDIN_BROWSER_IDLE_SECONDS || 180),
  };
}

function parsePayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^data:\s*(.+)$/);
    if (!match) continue;
    try { events.push(JSON.parse(match[1])); } catch {}
  }
  return events.reverse().find((item) => item && typeof item === 'object') || null;
}

async function postMcp(payload, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || TOOL_TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (options.sessionId) headers['Mcp-Session-Id'] = options.sessionId;
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await response.text();
    const body = parsePayload(raw);
    if (!response.ok) {
      const error = new Error(body?.error?.message || raw.slice(0, 1200) || `LinkedIn MCP HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return {
      body,
      raw,
      sessionId: response.headers.get('mcp-session-id') || options.sessionId || null,
    };
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      const timeout = new Error(`LinkedIn MCP request timed out after ${timeoutMs}ms.`);
      timeout.code = 'LINKEDIN_MCP_TIMEOUT';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function initializeSession(timeoutMs = 5000) {
  const id = ++requestId;
  const response = await postMcp({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'ultron-mark3', version: '3.0.0' },
    },
  }, { timeoutMs });
  if (response.body?.error) throw new Error(response.body.error.message || 'LinkedIn MCP initialize failed.');
  const idHeader = response.sessionId;
  if (!idHeader) throw new Error('LinkedIn MCP initialized without returning Mcp-Session-Id.');
  sessionId = idHeader;
  try {
    await postMcp({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }, { sessionId, timeoutMs: 3000 });
  } catch {}
  return sessionId;
}

function childIsRunning() {
  return Boolean(child && child.exitCode == null && !child.killed);
}

function startChild() {
  if (childIsRunning()) return child;
  lastStderr = '';
  child = spawn(uvxCommand(), serverArgs(), {
    cwd: process.cwd(),
    env: serverEnv(),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (chunk) => {
    lastStderr = (lastStderr + String(chunk || '')).slice(-5000);
  });
  child.on('exit', () => {
    sessionId = null;
  });
  child.on('error', (error) => {
    lastStderr = (lastStderr + '\n' + error.message).slice(-5000);
  });
  return child;
}

async function ensureServer() {
  if (sessionId) return sessionId;
  try {
    return await initializeSession(1800);
  } catch {}

  if (startPromise) return startPromise;
  startPromise = (async () => {
    startChild();
    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < START_TIMEOUT_MS) {
      if (child && child.exitCode != null) {
        const detail = lastStderr.trim();
        const error = new Error(detail || `LinkedIn MCP server exited with code ${child.exitCode}.`);
        error.code = /ENOENT|not recognized|not found/i.test(detail) ? 'LINKEDIN_MCP_NOT_INSTALLED' : 'LINKEDIN_MCP_START_FAILED';
        throw error;
      }
      try {
        return await initializeSession(2500);
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }
    const error = new Error(`LinkedIn MCP server did not become ready on ${ENDPOINT}. ${lastError?.message || lastStderr}`.trim());
    error.code = 'LINKEDIN_MCP_START_TIMEOUT';
    throw error;
  })().finally(() => {
    startPromise = null;
  });
  return startPromise;
}

function normalizeToolResult(payload) {
  if (!payload) return {};
  if (payload.structuredContent && typeof payload.structuredContent === 'object') return payload.structuredContent;
  const content = Array.isArray(payload.content) ? payload.content : [];
  const texts = content.map((item) => String(item?.text || '')).filter(Boolean);
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return {
    rawText: texts.join('\n').trim(),
    content,
  };
}

function toolErrorMessage(body) {
  if (body?.error) return body.error.message || JSON.stringify(body.error);
  const result = body?.result;
  if (!result?.isError) return '';
  const content = Array.isArray(result.content) ? result.content : [];
  return content.map((item) => item?.text || '').filter(Boolean).join('\n') || 'LinkedIn MCP tool returned an error.';
}

async function rawCall(tool, args = {}, retrySession = true) {
  await ensureServer();
  const id = ++requestId;
  try {
    const response = await postMcp({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }, { sessionId, timeoutMs: TOOL_TIMEOUT_MS });
    if (response.body?.error && /session|Mcp-Session-Id/i.test(String(response.body.error.message || '')) && retrySession) {
      sessionId = null;
      await initializeSession(5000);
      return rawCall(tool, args, false);
    }
    const toolError = toolErrorMessage(response.body);
    if (toolError) throw new Error(toolError);
    return normalizeToolResult(response.body?.result);
  } catch (error) {
    if (retrySession && /session.*(?:invalid|expired|not found)|Mcp-Session-Id/i.test(String(error.message || ''))) {
      sessionId = null;
      await initializeSession(5000);
      return rawCall(tool, args, false);
    }
    throw error;
  }
}

async function callTool(tool, args = {}) {
  await policy.waitTurn(tool);
  try {
    const result = await rawCall(tool, args);
    policy.recordCall(tool, true);
    return result;
  } catch (error) {
    const classification = policy.recordError(tool, error);
    error.linkedinSafety = classification;
    throw error;
  }
}

function shutdown() {
  if (!childIsRunning()) return;
  try { child.kill(); } catch {}
  child = null;
  sessionId = null;
}

function status() {
  return {
    provider: 'stickerdaniel/linkedin-mcp-server',
    package: PACKAGE_SPEC,
    endpoint: ENDPOINT,
    loopbackOnly: HOST === '127.0.0.1',
    autoImportDisabled: true,
    headlessRuntime: true,
    childRunning: childIsRunning(),
    sessionInitialized: Boolean(sessionId),
    readOnlyTools: [...policy.READ_ONLY_TOOLS],
    safety: policy.status(),
  };
}

process.once('exit', shutdown);

module.exports = {
  HOST,
  PORT,
  ENDPOINT,
  PACKAGE_SPEC,
  uvxCommand,
  serverArgs,
  parsePayload,
  normalizeToolResult,
  initializeSession,
  ensureServer,
  callTool,
  shutdown,
  status,
};
