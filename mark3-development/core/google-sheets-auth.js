const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('./config');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
let sessionValidated = false;
let lastAuthEvent = null;

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

function resolvePrivatePath(name, fallback) {
  const value = setting(name, fallback);
  return path.isAbsolute(value) ? value : path.resolve(config.projectRoot, value);
}

function credentialsPath() {
  return resolvePrivatePath('GOOGLE_SHEETS_OAUTH_PATH', '.ultron/credentials/google-sheets-oauth.json');
}

function tokenPath() {
  return resolvePrivatePath('GOOGLE_SHEETS_TOKEN_PATH', '.ultron/credentials/google-sheets-token.json');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function oauthClient() {
  const file = credentialsPath();
  if (!fs.existsSync(file)) {
    const error = new Error(`Google OAuth credentials were not found at ${file}`);
    error.code = 'GOOGLE_SHEETS_CREDENTIALS_MISSING';
    throw error;
  }
  const raw = readJson(file);
  const client = raw.installed || raw.web;
  if (!client?.client_id || !client?.client_secret) {
    const error = new Error('Google OAuth JSON does not contain an installed/web OAuth client.');
    error.code = 'GOOGLE_SHEETS_CREDENTIALS_INVALID';
    throw error;
  }
  return {
    clientId: client.client_id,
    clientSecret: client.client_secret,
    authUri: client.auth_uri || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUri: client.token_uri || 'https://oauth2.googleapis.com/token',
  };
}

function tokenBackupPath() {
  return tokenPath() + '.bak';
}

function validTokenObject(value) {
  return Boolean(value && typeof value === 'object' && (value.access_token || value.refresh_token));
}

function loadToken() {
  const file = tokenPath();
  const backup = tokenBackupPath();

  if (fs.existsSync(file)) {
    try {
      const token = readJson(file);
      if (validTokenObject(token)) return token;
    } catch {}
  }

  if (fs.existsSync(backup)) {
    try {
      const token = readJson(backup);
      if (validTokenObject(token)) {
        // Recover the primary file atomically from the last known-good backup.
        saveToken(token, { skipBackup: true });
        lastAuthEvent = { type: 'token-recovered-from-backup', at: new Date().toISOString() };
        return token;
      }
    } catch {}
  }

  return null;
}

function saveToken(token, options = {}) {
  if (!validTokenObject(token)) {
    const error = new Error('Refusing to persist an invalid Google Sheets token object.');
    error.code = 'GOOGLE_SHEETS_TOKEN_INVALID';
    throw error;
  }

  const file = tokenPath();
  const backup = tokenBackupPath();
  const dir = path.dirname(file);
  const temp = path.join(dir, `.google-sheets-token.${process.pid}.${Date.now()}.tmp`);
  fs.mkdirSync(dir, { recursive: true });

  if (!options.skipBackup && fs.existsSync(file)) {
    try {
      const current = readJson(file);
      if (validTokenObject(current)) fs.copyFileSync(file, backup);
    } catch {}
  }

  fs.writeFileSync(temp, JSON.stringify(token, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}

function oauthErrorCode(data = {}, status = 0) {
  const oauth = String(data?.error || '').trim().toLowerCase();
  const description = String(data?.error_description || '').toLowerCase();
  if (oauth === 'invalid_grant' || /expired or revoked|token.*revoked|invalid grant/.test(description)) return 'GOOGLE_SHEETS_AUTH_REQUIRED';
  if (oauth === 'invalid_client' || oauth === 'unauthorized_client') return 'GOOGLE_SHEETS_CREDENTIALS_INVALID';
  if (oauth === 'access_denied') return 'GOOGLE_SHEETS_AUTH_DENIED';
  if (Number(status) === 401) return 'GOOGLE_SHEETS_AUTH_REQUIRED';
  return 'GOOGLE_SHEETS_OAUTH_ERROR';
}

async function tokenRequest(params) {
  const client = oauthClient();
  let response;
  try {
    response = await fetch(client.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params),
    });
  } catch (cause) {
    const error = new Error(`Google OAuth token endpoint could not be reached: ${cause?.message || cause}`);
    error.code = 'GOOGLE_SHEETS_OAUTH_NETWORK_ERROR';
    error.cause = cause;
    throw error;
  }
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!response.ok) {
    const error = new Error(data.error_description || data.error || `Google OAuth token request failed (${response.status}).`);
    error.status = response.status;
    error.googleOAuthError = data.error || null;
    error.code = oauthErrorCode(data, response.status);
    error.reauthorizeCommand = 'node --env-file=../.env scripts\\google-sheets-auth.js';
    throw error;
  }
  return data;
}

async function refresh(token) {
  if (!token?.refresh_token) {
    const error = new Error('Google Sheets authorization has expired and no refresh token is available. Re-authorize once.');
    error.code = 'GOOGLE_SHEETS_AUTH_REQUIRED';
    error.reauthorizeCommand = 'node --env-file=../.env scripts\\google-sheets-auth.js';
    throw error;
  }
  const client = oauthClient();
  const fresh = await tokenRequest({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  });
  const merged = {
    ...token,
    ...fresh,
    refresh_token: fresh.refresh_token || token.refresh_token,
    expires_at: Date.now() + Math.max(60, Number(fresh.expires_in || 3600)) * 1000,
  };
  saveToken(merged);
  return merged;
}

async function accessToken(options = {}) {
  let token = loadToken();
  if (!token) {
    const error = new Error(`Google Sheets token file is missing or unreadable at ${tokenPath()}. Run the one-time Google Sheets authorization.`);
    error.code = 'GOOGLE_SHEETS_AUTH_REQUIRED';
    error.authReason = 'token_missing_or_unreadable';
    error.reauthorizeCommand = 'node --env-file=../.env scripts\\google-sheets-auth.js';
    throw error;
  }

  const forceRefresh = Boolean(options.forceRefresh);
  const accessStillValid = Boolean(
    token.access_token
    && Number(token.expires_at || 0) > Date.now() + 60_000
  );

  // Do not refresh merely because ULTRON restarted. A valid access token is safe
  // to use until Google rejects it or it approaches expiry. The Sheets HTTP layer
  // already force-refreshes once on an actual 401, which is the authoritative
  // validation signal and avoids creating a new failure point on every process start.
  if (!forceRefresh && accessStillValid) {
    sessionValidated = true;
    lastAuthEvent = { type: 'cached-access-token-used', at: new Date().toISOString() };
    return token.access_token;
  }

  if (!token.refresh_token) {
    const error = new Error('Google Sheets access token expired, but no durable refresh token is stored. Re-authorize once to create a durable offline authorization.');
    error.code = 'GOOGLE_SHEETS_AUTH_REQUIRED';
    error.authReason = 'refresh_token_missing';
    error.reauthorizeCommand = 'node --env-file=../.env scripts\\google-sheets-auth.js';
    throw error;
  }

  try {
    token = await refresh(token);
    sessionValidated = true;
    lastAuthEvent = { type: forceRefresh ? 'forced-refresh-success' : 'expiry-refresh-success', at: new Date().toISOString() };
  } catch (error) {
    error.authReason ||= error.googleOAuthError === 'invalid_grant'
      ? 'refresh_token_rejected_by_google'
      : 'refresh_failed';
    lastAuthEvent = {
      type: 'refresh-failed',
      at: new Date().toISOString(),
      code: error.code || null,
      oauthError: error.googleOAuthError || null,
      reason: error.authReason,
    };
    throw error;
  }

  if (!token?.access_token) {
    const error = new Error('Google OAuth refresh completed without an access token. Re-authorize Google Sheets.');
    error.code = 'GOOGLE_SHEETS_AUTH_REQUIRED';
    error.authReason = 'refresh_returned_no_access_token';
    error.reauthorizeCommand = 'node --env-file=../.env scripts\\google-sheets-auth.js';
    throw error;
  }
  return token.access_token;
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function openBrowser(url) {
  const command = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

async function authorizeInteractive() {
  const client = oauthClient();
  const state = base64url(crypto.randomBytes(24));
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());

  let resolveCallback;
  let rejectCallback;
  const callback = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/') {
        res.writeHead(404); res.end('Not found'); return;
      }
      const returnedState = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const oauthError = url.searchParams.get('error');
      if (oauthError) throw new Error(`Google authorization failed: ${oauthError}`);
      if (returnedState !== state || !code) throw new Error('Google OAuth callback validation failed.');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>ULTRON Google Sheets connected.</h2><p>You can close this tab.</p>');
      resolveCallback(code);
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error.message);
      rejectCallback(error);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const authUrl = new URL(client.authUri);
  authUrl.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  console.log('Opening Google authorization in your browser...');
  openBrowser(authUrl.toString());

  let code;
  const timeout = setTimeout(() => rejectCallback(new Error('Google authorization timed out.')), 180_000);
  try { code = await callback; }
  finally { clearTimeout(timeout); server.close(); }

  const token = await tokenRequest({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const previous = loadToken();
  const stored = {
    ...(previous || {}),
    ...token,
    // Google may omit refresh_token on a subsequent consent exchange. Never
    // destroy a working offline credential merely because this response omitted it.
    refresh_token: token.refresh_token || previous?.refresh_token || '',
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000,
    scope: token.scope || previous?.scope || SCOPE,
    authorized_at: new Date().toISOString(),
  };

  if (!stored.refresh_token) {
    const error = new Error('Google authorization returned only a short-lived access token and no refresh token. ULTRON will not save a connection that is guaranteed to expire. Revoke the old ULTRON Google grant if needed, then authorize again.');
    error.code = 'GOOGLE_SHEETS_REFRESH_TOKEN_REQUIRED';
    error.authReason = 'authorization_returned_no_refresh_token';
    error.reauthorizeCommand = 'node --env-file=../.env scripts\\google-sheets-auth.js';
    throw error;
  }

  const file = saveToken(stored);
  sessionValidated = true;
  lastAuthEvent = { type: 'interactive-authorization-success', at: new Date().toISOString() };
  return {
    ok: true,
    tokenPath: file,
    scope: stored.scope,
    durable: true,
    hasRefreshToken: true,
  };
}

function status() {
  const token = loadToken();
  const expiresAt = Number(token?.expires_at || 0);
  const expiresInMs = token ? expiresAt - Date.now() : null;
  const hasRefreshToken = Boolean(token?.refresh_token);
  const tokenExpired = token ? expiresAt <= Date.now() + 60_000 : null;
  return {
    credentialsReady: fs.existsSync(credentialsPath()),
    authorized: Boolean(token?.refresh_token || token?.access_token),
    durableAuthorization: Boolean(token?.access_token && hasRefreshToken),
    hasRefreshToken,
    tokenExpired,
    tokenExpiresAt: expiresAt || null,
    tokenExpiresInMs: Number.isFinite(expiresInMs) ? expiresInMs : null,
    tokenScope: String(token?.scope || ''),
    tokenAuthorizedAt: token?.authorized_at || null,
    sessionValidated,
    lastAuthEvent,
    credentialsPath: credentialsPath(),
    tokenPath: tokenPath(),
    tokenBackupPath: tokenBackupPath(),
    healthReason: !token
      ? 'token_missing_or_unreadable'
      : !hasRefreshToken
        ? 'refresh_token_missing'
        : tokenExpired
          ? 'access_expired_refresh_available'
          : 'durable_authorization_ready',
  };
}

module.exports = {
  SCOPE,
  credentialsPath,
  tokenPath,
  tokenBackupPath,
  loadToken,
  saveToken,
  status,
  accessToken,
  authorizeInteractive,
  oauthErrorCode,
  tokenRequest,
};
