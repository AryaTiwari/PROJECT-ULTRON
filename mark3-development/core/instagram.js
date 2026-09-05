const GRAPH_BASE = String(process.env.ULTRON_M3_INSTAGRAM_GRAPH_BASE || 'https://graph.instagram.com').replace(/\/$/, '');
const TIMEOUT_MS = Math.max(5000, Number(process.env.ULTRON_M3_INSTAGRAM_TIMEOUT_MS || 20000));

function firstEnv(...names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return { name, value };
  }
  return { name: null, value: '' };
}

function credentials() {
  const token = firstEnv('INSTAGRAM_TOKEN', 'INSTAGRAM_ACCESS_TOKEN', 'META_ACCESS_TOKEN');
  const accountId = firstEnv('INSTAGRAM_ACCOUNT_ID', 'INSTAGRAM_BUSINESS_ACCOUNT_ID');
  const appId = firstEnv('INSTAGRAM_APP_ID', 'META_APP_ID');
  const appSecret = firstEnv('INSTAGRAM_APP_SECRET', 'META_APP_SECRET');
  return {
    token,
    accountId,
    appId,
    appSecret,
    readyForIdentityCheck: Boolean(token.value && accountId.value),
  };
}

async function requestJson(url, token, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
    if (!response.ok) {
      const metaMessage = data?.error?.message || data?.message || raw.slice(0, 500) || `HTTP ${response.status}`;
      const error = new Error(`Instagram API HTTP ${response.status}: ${metaMessage}`);
      error.status = response.status;
      error.code = data?.error?.code || null;
      error.type = data?.error?.type || null;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Instagram API timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function verifyConnection() {
  const creds = credentials();
  if (!creds.token.value) throw new Error('INSTAGRAM_TOKEN is not configured.');
  if (!creds.accountId.value) throw new Error('INSTAGRAM_ACCOUNT_ID is not configured.');

  const url = `${GRAPH_BASE}/me?fields=id,username`;
  const profile = await requestJson(url, creds.token.value);
  const returnedId = String(profile?.id || '').trim();
  const username = String(profile?.username || '').trim();
  if (!returnedId) throw new Error('Instagram API returned no account id for this token.');

  const expectedId = String(creds.accountId.value).trim();
  if (returnedId !== expectedId) {
    const error = new Error(`Instagram account mismatch: token belongs to account ${returnedId}, but INSTAGRAM_ACCOUNT_ID is ${expectedId}.`);
    error.code = 'INSTAGRAM_ACCOUNT_MISMATCH';
    throw error;
  }

  return {
    ok: true,
    connected: true,
    accountId: returnedId,
    username: username || null,
    tokenVariable: creds.token.name,
    accountVariable: creds.accountId.name,
    appIdConfigured: Boolean(creds.appId.value),
    appSecretConfigured: Boolean(creds.appSecret.value),
    graphHost: new URL(GRAPH_BASE).host,
  };
}

async function profileSnapshot() {
  const creds = credentials();
  if (!creds.token.value) throw new Error('INSTAGRAM_TOKEN is not configured.');
  const richFields = 'id,username,name,biography,profile_picture_url,followers_count,follows_count,media_count,account_type';
  try {
    const profile = await requestJson(`${GRAPH_BASE}/me?fields=${encodeURIComponent(richFields)}`, creds.token.value);
    return {
      ok: true,
      id: String(profile?.id || '').trim() || null,
      username: String(profile?.username || '').trim() || null,
      name: String(profile?.name || '').trim() || null,
      biography: String(profile?.biography || '').trim() || null,
      profilePictureUrl: String(profile?.profile_picture_url || '').trim() || null,
      followersCount: Number.isFinite(Number(profile?.followers_count)) ? Number(profile.followers_count) : null,
      followsCount: Number.isFinite(Number(profile?.follows_count)) ? Number(profile.follows_count) : null,
      mediaCount: Number.isFinite(Number(profile?.media_count)) ? Number(profile.media_count) : null,
      accountType: String(profile?.account_type || '').trim() || null,
      richFields: true,
    };
  } catch (error) {
    const basic = await requestJson(`${GRAPH_BASE}/me?fields=id,username`, creds.token.value);
    return {
      ok: true,
      id: String(basic?.id || '').trim() || null,
      username: String(basic?.username || '').trim() || null,
      name: null,
      biography: null,
      profilePictureUrl: null,
      followersCount: null,
      followsCount: null,
      mediaCount: null,
      accountType: null,
      richFields: false,
      richFieldsError: error.message,
    };
  }
}

async function recentMedia(limit = 12) {
  const creds = credentials();
  if (!creds.token.value) throw new Error('INSTAGRAM_TOKEN is not configured.');
  const safeLimit = Math.max(1, Math.min(25, Number(limit || 12)));
  const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';
  const data = await requestJson(`${GRAPH_BASE}/me/media?fields=${encodeURIComponent(fields)}&limit=${safeLimit}`, creds.token.value);
  const rows = Array.isArray(data?.data) ? data.data : [];
  return rows.map((item) => ({
    id: String(item?.id || '').trim() || null,
    caption: String(item?.caption || '').trim(),
    mediaType: String(item?.media_type || '').trim() || null,
    mediaUrl: String(item?.media_url || '').trim() || null,
    thumbnailUrl: String(item?.thumbnail_url || '').trim() || null,
    permalink: String(item?.permalink || '').trim() || null,
    timestamp: String(item?.timestamp || '').trim() || null,
  }));
}

async function accountSnapshot(options = {}) {
  const profile = await profileSnapshot();
  let media = [];
  let mediaError = null;
  try { media = await recentMedia(options.limit || 12); }
  catch (error) { mediaError = error.message; }
  return { ok: true, profile, media, mediaError, capturedAt: new Date().toISOString() };
}

function status() {
  const creds = credentials();
  return {
    configured: creds.readyForIdentityCheck,
    tokenConfigured: Boolean(creds.token.value),
    accountIdConfigured: Boolean(creds.accountId.value),
    appIdConfigured: Boolean(creds.appId.value),
    appSecretConfigured: Boolean(creds.appSecret.value),
    tokenVariable: creds.token.name,
    accountVariable: creds.accountId.name,
    graphHost: new URL(GRAPH_BASE).host,
    profileSnapshotImplemented: true,
    recentMediaSnapshotImplemented: true,
  };
}

module.exports = { GRAPH_BASE, credentials, requestJson, verifyConnection, profileSnapshot, recentMedia, accountSnapshot, status };
