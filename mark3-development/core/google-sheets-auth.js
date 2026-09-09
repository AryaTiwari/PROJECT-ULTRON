const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('./config');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

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
    throw new Error('Google OAuth JSON does not contain an installed/web OAuth client.');
  }
  return {
    clientId: client.client_id,
    clientSecret: client.client_secret,
    authUri: client.auth_uri || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUri: client.token_uri || 'https://oauth2.googleapis.com/token',
  };
}

function loadToken() {
  const file = tokenPath();
  if (!fs.existsSync(file)) return null;
  try { return readJson(file); } catch { return null; }
}

function saveToken(token) {
  const file = tokenPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(token, null, 2), { mode: 0o600 });
  return file;
}

async function tokenRequest(params) {
  const client = oauthClient();
  const response = await fetch(client.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params),
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!response.ok) {
    const error = new Error(data.error_description || data.error || `Google OAuth token request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function refresh(token) {
  if (!token?.refresh_token) {
    const error = new Error('Google Sheets authorization has expired and no refresh token is available. Re-authorize once.');
    error.code = 'GOOGLE_SHEETS_AUTH_REQUIRED';
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

async function accessToken() {
  let token = loadToken();
  if (!token) {
    const error = new Error('Google Sheets needs its one-time authorization. Run the Google Sheets auth script first.');
    error.code = 'GOOGLE_SHEETS_AUTH_REQUIRED';
    throw error;
  }
  if (token.access_token && Number(token.expires_at || 0) > Date.now() + 60_000) return token.access_token;
  token = await refresh(token);
  return token.access_token;
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function openBrowser(url) {
  // Do not launch the OAuth URL through `cmd /c start` on Windows. OAuth URLs
  // contain `&`; cmd.exe treats that character as a command separator and can
  // silently truncate the query string, which makes Google report parameters
  // such as response_type as missing. rundll32 passes the URL intact.
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
  const stored = {
    ...token,
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000,
    scope: token.scope || SCOPE,
  };
  const file = saveToken(stored);
  return { ok: true, tokenPath: file, scope: stored.scope };
}

function status() {
  return {
    credentialsReady: fs.existsSync(credentialsPath()),
    authorized: Boolean(loadToken()?.refresh_token || loadToken()?.access_token),
    credentialsPath: credentialsPath(),
    tokenPath: tokenPath(),
  };
}

module.exports = { SCOPE, credentialsPath, tokenPath, status, accessToken, authorizeInteractive };
