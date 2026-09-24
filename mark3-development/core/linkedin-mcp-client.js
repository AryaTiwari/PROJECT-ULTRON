const { execFileSync } = require('child_process');
const policy = require('./linkedin-account-policy');

const HOST = '127.0.0.1';
const PORT = Math.max(1024, Math.min(65535, Number(process.env.ULTRON_M3_LINKEDIN_MCP_PORT || 8793)));
const ENDPOINT = `http://${HOST}:${PORT}/mcp`;
const TRANSPORT_MODE = 'stdio';
const PACKAGE_SPEC = String(process.env.ULTRON_M3_LINKEDIN_MCP_PACKAGE || 'mcp-server-linkedin@4.24.2').trim();
const START_TIMEOUT_MS = Math.max(5000, Number(process.env.ULTRON_M3_LINKEDIN_MCP_START_TIMEOUT_MS || 90000));
const TOOL_TIMEOUT_MS = Math.max(15000, Number(process.env.ULTRON_M3_LINKEDIN_MCP_TOOL_TIMEOUT_MS || 300000));
const SERVER_TOOL_TIMEOUT_SECONDS = Math.max(60, Math.ceil(TOOL_TIMEOUT_MS / 1000));
const BROWSER_IDLE_SECONDS = Math.max(0, Number(process.env.ULTRON_M3_LINKEDIN_BROWSER_IDLE_SECONDS || 600));
const BROWSER_WAIT_SECONDS = Math.max(0, Math.min(45, Number(process.env.ULTRON_M3_LINKEDIN_BROWSER_WAIT_SECONDS || 45)));
const PAGE_TIMEOUT_MS = Math.max(5000, Number(process.env.ULTRON_M3_LINKEDIN_PAGE_TIMEOUT_MS || 10000));
const REQUIRED_TOOLS = Object.freeze([
  'search_jobs',
  'get_job_details',
  'get_company_profile',
  'get_company_employees',
  'search_companies',
  'search_people',
  'get_person_profile',
]);

let client = null;
let transport = null;
let connectPromise = null;
let lastTransportError = '';
let toolNames = [];
let connectionGeneration = 0;
let orphanCleanupDone = false;

function cleanupOrphanedLinkedInServers(force = false) {
  if ((orphanCleanupDone && !force) || process.platform !== 'win32') return 0;
  orphanCleanupDone = true;
  const script = [
    '$all=@(Get-CimInstance Win32_Process)',
    '$live=@{}; foreach($p in $all){$live[[int]$p.ProcessId]=$true}',
    '$roots=@($all | Where-Object { $_.Name -ieq "mcp-server-linkedin.exe" -and -not $live.ContainsKey([int]$_.ParentProcessId) })',
    '$kill=New-Object System.Collections.Generic.HashSet[int]',
    'function Add-Tree([int]$id){ if($kill.Add($id)){ foreach($c in @($all | Where-Object { [int]$_.ParentProcessId -eq $id })){ Add-Tree ([int]$c.ProcessId) } } }',
    'foreach($r in $roots){Add-Tree ([int]$r.ProcessId)}',
    '$ids=@($kill) | Sort-Object -Descending',
    'foreach($id in $ids){Stop-Process -Id $id -Force -ErrorAction SilentlyContinue}',
    'Write-Output $ids.Count',
  ].join('; ');
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    });
    return Math.max(0, Number(String(output || '').trim()) || 0);
  } catch {
    return 0;
  }
}

function uvxCommand() {
  return process.platform === 'win32' ? 'uvx.exe' : 'uvx';
}

function toolTimeoutMs(tool) {
  const defaults = {
    search_jobs: 240000,
    get_job_details: 180000,
    get_company_profile: 240000,
    get_person_profile: 240000,
    search_people: 240000,
    search_companies: 240000,
  };
  const envKey = 'ULTRON_M3_LINKEDIN_MCP_' + String(tool || '').toUpperCase() + '_TIMEOUT_MS';
  const configured = Number(process.env[envKey]);
  if (Number.isFinite(configured)) return Math.max(15000, configured);
  return Math.max(15000, Number(defaults[tool] || TOOL_TIMEOUT_MS));
}

function isTransientTransportError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || error || '');
  return /TIMEOUT|TIMED_OUT|REQUEST_TIMEOUT|CONNECTION_CLOSED|ETIMEDOUT|ECONNRESET|EPIPE/i.test(code)
    || /timed out|timeout|connection (?:closed|reset)|transport closed|broken pipe|econnreset|epipe|temporary browser failure|another linkedin mcp client|browser.*(?:busy|using)|currently using the browser/i.test(message);
}

function shouldRetryTransient(error) {
  if (!isTransientTransportError(error)) return false;
  return String(error?.code || '') !== 'LINKEDIN_MCP_TIMEOUT'
    && !/REQUEST_TIMEOUT/i.test(String(error?.code || ''));
}

function stringEnvironment(source = process.env) {
  return Object.fromEntries(
    Object.entries(source)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, String(value)])
  );
}

function serverArgs(mode = 'stdio') {
  const args = [
    PACKAGE_SPEC,
    '--transport', mode === 'streamable-http' ? 'streamable-http' : 'stdio',
    '--log-level', String(process.env.ULTRON_M3_LINKEDIN_MCP_LOG_LEVEL || 'WARNING').toUpperCase(),
    '--no-auto-import',
    '--login-inline-wait', '0',
    '--browser-wait', String(BROWSER_WAIT_SECONDS),
    '--browser-idle-timeout', String(BROWSER_IDLE_SECONDS),
    '--timeout', String(PAGE_TIMEOUT_MS),
    '--tool-timeout', String(SERVER_TOOL_TIMEOUT_SECONDS),
  ];
  if (mode === 'streamable-http') {
    args.push('--host', HOST, '--port', String(PORT), '--path', '/mcp');
  }
  return args;
}

function serverEnv() {
  return {
    ...process.env,
    UV_HTTP_TIMEOUT: String(process.env.UV_HTTP_TIMEOUT || 300),
    HEADLESS: 'true',
    AUTO_IMPORT_FROM_BROWSER: 'false',
    LOGIN_INLINE_WAIT: '0',
    BROWSER_WAIT: String(BROWSER_WAIT_SECONDS),
    BROWSER_IDLE_TIMEOUT: String(BROWSER_IDLE_SECONDS),
    TIMEOUT: String(PAGE_TIMEOUT_MS),
    TOOL_TIMEOUT: String(SERVER_TOOL_TIMEOUT_SECONDS),
  };
}

// Retained for compatibility with older tests/diagnostics that imported these
// helpers. Stdio is now the live transport; no HTTP payload parsing is required
// during normal operation.
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

function toolErrorMessage(result) {
  if (!result?.isError) return '';
  const content = Array.isArray(result.content) ? result.content : [];
  return content.map((item) => item?.text || '').filter(Boolean).join('\n')
    || 'LinkedIn MCP tool returned an error.';
}

function sdkMissingError(error) {
  const wrapped = new Error(
    'The official MCP client SDK is not installed. Run npm install in mark3-development, then restart ULTRON. '
    + `Underlying error: ${error?.message || error}`
  );
  wrapped.code = 'LINKEDIN_MCP_CLIENT_SDK_MISSING';
  return wrapped;
}

async function sdkModules() {
  try {
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/client'),
      import('@modelcontextprotocol/client/stdio'),
    ]);
    return { Client, StdioClientTransport };
  } catch (error) {
    throw sdkMissingError(error);
  }
}

function classifySdkTimeout(error, timeoutMs) {
  const code = String(error?.code || '');
  const message = String(error?.message || error || '');
  if (/REQUEST_TIMEOUT|TIMEOUT|TIMED_OUT/i.test(code) || /timed out|timeout/i.test(message)) {
    const wrapped = new Error(`LinkedIn MCP request timed out after ${timeoutMs}ms.`);
    wrapped.code = 'LINKEDIN_MCP_TIMEOUT';
    wrapped.cause = error;
    return wrapped;
  }
  return error;
}

async function closeTransport() {
  const currentClient = client;
  const currentTransport = transport;
  client = null;
  transport = null;
  toolNames = [];

  try {
    if (currentClient?.close) await currentClient.close();
    else if (currentTransport?.close) await currentTransport.close();
  } catch {}

  return true;
}

async function connectStdio() {
  if (client && transport) return client;
  cleanupOrphanedLinkedInServers();
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const { Client, StdioClientTransport } = await sdkModules();

    const nextTransport = new StdioClientTransport({
      command: uvxCommand(),
      args: serverArgs('stdio'),
      env: stringEnvironment(serverEnv()),
      cwd: process.cwd(),
      // Do not use stderr:'pipe' without continuously draining it. The SDK's
      // inherited/default stderr cannot deadlock when the LinkedIn server logs.
      stderr: 'inherit',
      maxBufferSize: 20 * 1024 * 1024,
    });

    const nextClient = new Client({
      name: 'ultron-mark3-linkedin',
      version: '3.0.0',
    });

    nextClient.onerror = (error) => {
      lastTransportError = String(error?.message || error || '').slice(-4000);
    };
    nextClient.onclose = () => {
      if (client === nextClient) {
        client = null;
        transport = null;
        toolNames = [];
      }
    };

    try {
      await nextClient.connect(nextTransport, {
        timeout: START_TIMEOUT_MS,
        maxTotalTimeout: START_TIMEOUT_MS,
      });
      const listed = await nextClient.listTools(undefined, {
        timeout: Math.min(START_TIMEOUT_MS, 30000),
        maxTotalTimeout: Math.min(START_TIMEOUT_MS, 30000),
      });
      const names = (listed?.tools || []).map((item) => String(item?.name || '')).filter(Boolean);
      const missing = REQUIRED_TOOLS.filter((name) => !names.includes(name));
      if (missing.length) {
        const error = new Error(`LinkedIn MCP connected but required tools are missing: ${missing.join(', ')}`);
        error.code = 'LINKEDIN_MCP_TOOLSET_MISMATCH';
        throw error;
      }

      client = nextClient;
      transport = nextTransport;
      toolNames = names;
      connectionGeneration += 1;
      lastTransportError = '';
      return client;
    } catch (rawError) {
      try { await nextClient.close(); } catch {}
      try { await nextTransport.close(); } catch {}
      const code = String(rawError?.code || '');
      const message = String(rawError?.message || rawError || '');
      if (/REQUEST_TIMEOUT|TIMEOUT|TIMED_OUT/i.test(code) || /timed out|timeout/i.test(message)) {
        const error = new Error(`LinkedIn MCP stdio startup/tool discovery timed out after ${START_TIMEOUT_MS}ms.`);
        error.code = 'LINKEDIN_MCP_START_TIMEOUT';
        error.cause = rawError;
        throw error;
      }
      throw rawError;
    }
  })().finally(() => {
    connectPromise = null;
  });

  return connectPromise;
}

async function initializeSession() {
  return connectStdio();
}

async function ensureServer() {
  return connectStdio();
}

async function listTools() {
  const connected = await ensureServer();
  const result = await connected.listTools();
  toolNames = (result?.tools || []).map((item) => String(item?.name || '')).filter(Boolean);
  return result?.tools || [];
}

async function rawCall(tool, args = {}, retryConnection = true) {
  const connected = await ensureServer();
  const timeoutMs = toolTimeoutMs(tool);

  try {
    require('./universal-run-context').provider('linkedin');
    const result = await connected.callTool(
      { name: tool, arguments: args },
      {
        timeout: timeoutMs,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: Math.max(timeoutMs, Math.round(timeoutMs * 1.5)),
      },
    );

    const toolError = toolErrorMessage(result);
    if (toolError) {
      const error = new Error(toolError);
      error.code = 'LINKEDIN_MCP_TOOL_ERROR';
      throw error;
    }
    return normalizeToolResult(result);
  } catch (rawError) {
    const error = classifySdkTimeout(rawError, timeoutMs);
    if (retryConnection && isTransientTransportError(error) && shouldRetryTransient(error)) {
      await closeTransport();
      const retryClient = await ensureServer();
      try {
        require('./universal-run-context').provider('linkedin');
        const result = await retryClient.callTool(
          { name: tool, arguments: args },
          {
            timeout: timeoutMs,
            resetTimeoutOnProgress: true,
            maxTotalTimeout: Math.max(timeoutMs, Math.round(timeoutMs * 1.5)),
          },
        );
        const toolError = toolErrorMessage(result);
        if (toolError) {
          const next = new Error(toolError);
          next.code = 'LINKEDIN_MCP_TOOL_ERROR';
          throw next;
        }
        return normalizeToolResult(result);
      } catch (retryRawError) {
        throw classifySdkTimeout(retryRawError, timeoutMs);
      }
    }
    throw error;
  }
}

async function recoverSession(error) {
  // With stdio the MCP client owns the LinkedIn server subprocess. Closing the
  // transport tears down stale JSON-RPC/browser ownership state, then reconnects
  // from the same persisted LinkedIn profile.
  await closeTransport();
  return ensureServer();
}

async function callTool(tool, args = {}) {
  await policy.waitTurn(tool);
  try {
    const result = await rawCall(tool, args);
    policy.recordCall(tool, true);
    return result;
  } catch (error) {
    if (/another linkedin mcp client is currently using the browser/i.test(String(error?.message || ''))) {
      cleanupOrphanedLinkedInServers(true);
    }
    const classification = policy.recordError(tool, error);
    error.linkedinSafety = classification;

    if (classification.kind !== 'transient' && !isTransientTransportError(error)) throw error;

    // An MCP request timeout may leave a browser operation alive. Restart the
    // owned stdio subprocess, but let the mission controller defer this exact
    // candidate instead of immediately repeating an expensive LinkedIn action.
    if (!shouldRetryTransient(error)) {
      try {
        await recoverSession(error);
        error.sessionRecovered = true;
      } catch (recoveryError) {
        error.recoveryError = recoveryError.message;
      }
      throw error;
    }

    try {
      await recoverSession(error);
      await policy.waitTurn(tool);
      const result = await rawCall(tool, args, false);
      policy.recordCall(tool, true, { recoveredAfterTransient: true });
      return result;
    } catch (retryError) {
      const retryClassification = policy.recordError(tool, retryError);
      retryError.linkedinSafety = retryClassification;
      throw retryError;
    }
  }
}

async function shutdown() {
  return closeTransport();
}

function status() {
  return {
    provider: 'stickerdaniel/linkedin-mcp-server',
    package: PACKAGE_SPEC,
    transport: TRANSPORT_MODE,
    sdk: '@modelcontextprotocol/client',
    endpoint: null,
    loopbackOnly: true,
    autoImportDisabled: true,
    headlessRuntime: true,
    childRunning: Boolean(client && transport),
    sessionInitialized: Boolean(client && transport),
    connectionGeneration,
    requiredTools: [...REQUIRED_TOOLS],
    discoveredTools: [...toolNames],
    lastTransportError: lastTransportError || null,
    readOnlyTools: [...policy.READ_ONLY_TOOLS],
    safety: policy.status(),
  };
}

process.once('exit', () => {
  void closeTransport();
});

module.exports = {
  HOST,
  PORT,
  ENDPOINT,
  TRANSPORT_MODE,
  PACKAGE_SPEC,
  REQUIRED_TOOLS,
  START_TIMEOUT_MS,
  TOOL_TIMEOUT_MS,
  uvxCommand,
  serverArgs,
  serverEnv,
  parsePayload,
  normalizeToolResult,
  toolTimeoutMs,
  isTransientTransportError,
  shouldRetryTransient,
  cleanupOrphanedLinkedInServers,
  initializeSession,
  ensureServer,
  listTools,
  recoverSession,
  callTool,
  shutdown,
  status,
};
