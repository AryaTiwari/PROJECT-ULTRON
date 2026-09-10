const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const config = require('./config');

const TENANT = String(process.env.ULTRON_M3_MICROSOFT_TENANT || 'common').trim() || 'common';
const AUTH_ROOT = `https://login.microsoftonline.com/${encodeURIComponent(TENANT)}/oauth2/v2.0`;
const SCOPE = 'offline_access https://graph.microsoft.com/Files.ReadWrite';
const REDIRECT_PORT = Math.max(1024, Math.min(65535, Number(process.env.ULTRON_M3_MICROSOFT_REDIRECT_PORT || 53682)));
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

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
    auth_flow: 'authorization-code-pkce',
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

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function pkcePair() {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function waitForAuthorizationCode(expectedState) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value, server) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch {}
      fn(value);
    };

    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url || '/', REDIRECT_URI);
        const errorCode = url.searchParams.get('error');
        const errorDescription = url.searchParams.get('error_description');
        const state = url.searchParams.get('state');
        const code = url.searchParams.get('code');

        if (errorCode) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2>Microsoft sign-in was not completed.</h2><p>You can close this window and return to PowerShell.</p>');
          const error = new Error(errorDescription || errorCode);
          error.code = 'MICROSOFT_GRAPH_AUTH_REQUIRED';
          finish(reject, error, server);
          return;
        }

        if (state !== expectedState || !code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2>Invalid Microsoft sign-in callback.</h2><p>You can close this window.</p>');
          const error = new Error('Microsoft sign-in callback was missing a valid state or authorization code.');
          error.code = 'MICROSOFT_GRAPH_AUTH_REQUIRED';
          finish(reject, error, server);
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>ULTRON OneDrive connected.</h2><p>You can close this window and return to PowerShell.</p>');
        finish(resolve, code, server);
      } catch (error) {
        try {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('ULTRON could not process the Microsoft sign-in callback.');
        } catch {}
        finish(reject, error, server);
      }
    });

    server.on('error', (error) => {
      const wrapped = new Error(`ULTRON could not open local Microsoft callback port ${REDIRECT_PORT}: ${error.message}`);
      wrapped.code = 'MICROSOFT_LOCAL_CALLBACK_FAILED';
      finish(reject, wrapped, server);
    });

    server.listen(REDIRECT_PORT);
    const timer = setTimeout(() => {
      const error = new Error('Microsoft sign-in timed out after 5 minutes. Run the setup command again.');
      error.code = 'MICROSOFT_GRAPH_AUTH_REQUIRED';
      finish(reject, error, server);
    }, 5 * 60 * 1000);
    timer.unref?.();
  });
}

async function authorizeInteractive() {
  const id = clientId();
  if (!id) {
    const error = new Error('MICROSOFT_GRAPH_CLIENT_ID is missing. Add the Application (client) ID from your Microsoft Entra app registration to .env first.');
    error.code = 'MICROSOFT_GRAPH_CLIENT_ID_MISSING';
    throw error;
  }

  const state = base64url(crypto.randomBytes(24));
  const { verifier, challenge } = pkcePair();
  const params = new URLSearchParams({
    client_id: id,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    response_mode: 'query',
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'select_account',
  });
  const authorizationUrl = `${AUTH_ROOT}/authorize?${params.toString()}`;

  console.log('Open this official Microsoft sign-in URL in your normal browser:');
  console.log(authorizationUrl);
  console.log('');
  console.log(`ULTRON is waiting locally at ${REDIRECT_URI}. Do not open any nativeclient/device-login URL.`);

  const codePromise = waitForAuthorizationCode(state);
  const code = await codePromise;

  const { response, data } = await formRequest(`${AUTH_ROOT}/token`, {
    client_id: id,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    scope: SCOPE,
  });

  if (!response.ok) {
    const error = new Error(data.error_description || data.error || `Microsoft token exchange failed (${response.status}).`);
    error.code = 'MICROSOFT_GRAPH_AUTH_REQUIRED';
    throw error;
  }

  const stored = tokenWithExpiry(data);
  const file = saveToken(stored);
  return { ok: true, tokenPath: file, scope: stored.scope, tenant: TENANT, authFlow: 'authorization-code-pkce', redirectUri: REDIRECT_URI };
}

function status() {
  const token = readToken();
  return {
    clientIdReady: Boolean(clientId()),
    authorized: Boolean(token?.refresh_token || token?.access_token),
    tokenPath: tokenPath(),
    scope: SCOPE,
    tenant: TENANT,
    authFlow: 'authorization-code-pkce',
    redirectUri: REDIRECT_URI,
  };
}

module.exports = {
  SCOPE,
  TENANT,
  REDIRECT_URI,
  REDIRECT_PORT,
  setting,
  clientId,
  tokenPath,
  status,
  accessToken,
  authorizeInteractive,
  pkcePair,
};