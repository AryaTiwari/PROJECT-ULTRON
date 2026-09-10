const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');

const TENANT = String(process.env.ULTRON_M3_MICROSOFT_TENANT || 'common').trim() || 'common';
const AUTH_ROOT = `https://login.microsoftonline.com/${encodeURIComponent(TENANT)}/oauth2/v2.0`;
const SCOPE = 'offline_access Files.ReadWrite';

function envFileValue(name) {
  for (const file of [path.join(config.projectRoot, '.env'), path.join(config.mark3Root, '.env')]) {
    try {
      if (!fs.existsSync(file)) continue;
      const match = fs.readFileSync(file, 'utf8').match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`, 'm'));
      if (match) return String(match[1] || '').trim().replace(/^['"]|['"]$/g, '');
    } catch {}
  }
  return '';
}

function setting(name, fallback = '') {
  return String(process.env[name] || envFileValue(name) || fallback).trim();
}

function tokenPath() {
  const raw = setting('MICROSOFT_GRAPH_TOKEN_PATH', '.ultron/credentials/microsoft-graph-token.json');
  return path.isAbsolute(raw) ? raw : path.resolve(config.projectRoot, raw);
}

function clientId() {
  return setting('MICROSOFT_GRAPH_CLIENT_ID');
}

function readToken() {
  try {
    const file = tokenPath();
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function saveToken(token) {
  const file = tokenPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(token, null, 2), { mode: 0o600 });
  return file;
}

function openBrowser(url) {
  try {
    const command = process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
    const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch {}
}

async function formRequest(url, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { response, data };
}

function tokenWithExpiry(data, previous = null) {
  return {
    ...(previous || {}),
    ...data,
    refresh_token: data.refresh_token || previous?.refresh_token || null,
    scope: data.scope || previous?.scope || SCOPE,
    expires_at: Date.now() + Math.max(60, Number(data.expires_in || 3600)) * 1000,
    saved_at: new Date().toISOString(),
  };
}

async function refresh(token) {
  const id = clientId();
  if (!id) {
    const error = new Error('MICROSOFT_GRAPH_CLIENT_ID is missing.');
    error.code = 'MICROSOFT_GRAPH_CLIENT_ID_MISSING';
    throw error;
  }
  if (!token?.refresh_token) {
    const error = new Error('Microsoft OneDrive authorization is required.');
    error.code = 'MICROSOFT_GRAPH_AUTH_REQUIRED';
    throw error;
  }
  const { response, data } = await formRequest(`${AUTH_ROOT}/token`, {
    client_id: id,
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
    scope: SCOPE,
  });
  if (!response.ok) {
    const error = new Error(data.error_description || data.error || `Microsoft token refresh failed (${response.status}).`);
    error.code = 'MICROSOFT_GRAPH_AUTH_REQUIRED';
    throw error;
  }
  const stored = tokenWithExpiry(data, token);
  saveToken(stored);
  return stored;
}

async function accessToken() {
  const id = clientId();
  if (!id) {
    const error = new Error('MICROSOFT_GRAPH_CLIENT_ID is missing.');
    error.code = 'MICROSOFT_GRAPH_CLIENT_ID_MISSING';
    throw error;
  }
  let token = readToken();
  if (!token) {
    const error = new Error('Microsoft OneDrive needs its one-time sign-in.');
    error.code = 'MICROSOFT_GRAPH_AUTH_REQUIRED';
    throw error;
  }
  if (token.access_token && Number(token.expires_at || 0) > Date.now() + 60_000) return token.access_token;
  token = await refresh(token);
  return token.access_token;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function authorizeInteractive() {
  const id = clientId();
  if (!id) {
    const error = new Error('MICROSOFT_GRAPH_CLIENT_ID is missing. Add the Application (client) ID from your Microsoft Entra app registration to .env first.');
    error.code = 'MICROSOFT_GRAPH_CLIENT_ID_MISSING';
    throw error;
  }

  const start = await formRequest(`${AUTH_ROOT}/devicecode`, { client_id: id, scope: SCOPE });
  if (!start.response.ok) {
    throw new Error(start.data.error_description || start.data.error || `Microsoft device login failed (${start.response.status}).`);
  }

  const device = start.data;
  const verificationUri = String(device.verification_uri || device.verification_uri_complete || 'https://microsoft.com/devicelogin');
  console.log(device.message || `Open ${verificationUri} and enter code ${device.user_code}.`);
  openBrowser(verificationUri);

  let intervalMs = Math.max(1000, Number(device.interval || 5) * 1000);
  const deadline = Date.now() + Math.max(60, Number(device.expires_in || 900)) * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const poll = await formRequest(`${AUTH_ROOT}/token`, {
      client_id: id,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
    });
    if (poll.response.ok) {
      const stored = tokenWithExpiry(poll.data);
      const file = saveToken(stored);
      return { ok: true, tokenPath: file, scope: stored.scope, tenant: TENANT };
    }
    const code = String(poll.data.error || '');
    if (code === 'authorization_pending') continue;
    if (code === 'slow_down') {
      intervalMs += 5000;
      continue;
    }
    if (code === 'authorization_declined') throw new Error('Microsoft sign-in was declined.');
    if (code === 'expired_token') throw new Error('Microsoft device code expired. Run the setup command again.');
    throw new Error(poll.data.error_description || code || `Microsoft token request failed (${poll.response.status}).`);
  }
  throw new Error('Microsoft sign-in timed out. Run the setup command again.');
}

function status() {
  const token = readToken();
  return {
    clientIdReady: Boolean(clientId()),
    authorized: Boolean(token?.refresh_token || token?.access_token),
    tokenPath: tokenPath(),
    scope: SCOPE,
    tenant: TENANT,
  };
}

module.exports = {
  SCOPE,
  TENANT,
  setting,
  clientId,
  tokenPath,
  status,
  accessToken,
  authorizeInteractive,
};
