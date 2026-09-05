const GRAPH_BASE = String(process.env.ULTRON_M3_INSTAGRAM_GRAPH_BASE || 'https://graph.instagram.com').replace(/\/$/, '');
const TIMEOUT_MS = Math.max(5000, Number(process.env.ULTRON_M3_INSTAGRAM_TIMEOUT_MS || 20000));
const DEFAULT_MEDIA_INSIGHT_METRICS = ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'ig_reels_avg_watch_time'];

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

function insightValue(row = {}) {
  if (row?.total_value && Object.prototype.hasOwnProperty.call(row.total_value, 'value')) return row.total_value.value;
  const values = Array.isArray(row?.values) ? row.values : [];
  if (values.length && Object.prototype.hasOwnProperty.call(values[values.length - 1] || {}, 'value')) return values[values.length - 1].value;
  if (Object.prototype.hasOwnProperty.call(row, 'value')) return row.value;
  return null;
}

function normalizeInsightMetrics(values = {}) {
  return {
    views: Number(values.views ?? values.plays ?? 0) || 0,
    reach: Number(values.reach ?? 0) || 0,
    likes: Number(values.likes ?? 0) || 0,
    comments: Number(values.comments ?? 0) || 0,
    shares: Number(values.shares ?? 0) || 0,
    saves: Number(values.saved ?? values.saves ?? 0) || 0,
    totalInteractions: Number(values.total_interactions ?? 0) || 0,
    averageWatchTimeMs: Number(values.ig_reels_avg_watch_time ?? 0) || 0,
    follows: Number(values.follows ?? 0) || 0,
    profileVisits: Number(values.profile_visits ?? 0) || 0,
    skipRate: Number(values.reels_skip_rate ?? 0) || 0,
  };
}

async function mediaInsights(mediaId, options = {}) {
  const creds = credentials();
  if (!creds.token.value) throw new Error('INSTAGRAM_TOKEN is not configured.');
  const id = String(mediaId || '').trim();
  if (!id) throw new Error('Instagram media id is required for insights.');
  const requested = Array.isArray(options.metrics) && options.metrics.length
    ? options.metrics.map((item) => String(item).trim()).filter(Boolean)
    : DEFAULT_MEDIA_INSIGHT_METRICS;
  const values = {};
  const raw = {};
  const errors = [];

  for (const metric of requested) {
    try {
      const data = await requestJson(`${GRAPH_BASE}/${encodeURIComponent(id)}/insights?metric=${encodeURIComponent(metric)}`, creds.token.value, options.timeoutMs || TIMEOUT_MS);
      const row = Array.isArray(data?.data) ? data.data[0] : null;
      if (!row) {
        errors.push({ metric, error: 'empty insight dataset' });
        continue;
      }
      values[metric] = insightValue(row);
      raw[metric] = { name: row.name || metric, period: row.period || null, title: row.title || null, value: values[metric] };
    } catch (error) {
      errors.push({ metric, error: error.message, status: error.status || null, code: error.code || null });
    }
  }

  if (!Object.keys(values).length) {
    const error = new Error('Instagram media insights are unavailable for this token/media. The current Instagram Login flow requires the insights permission for professional-account insights.');
    error.code = 'INSTAGRAM_INSIGHTS_UNAVAILABLE';
    error.details = errors;
    throw error;
  }

  return {
    ok: true,
    mediaId: id,
    metrics: normalizeInsightMetrics(values),
    values,
    raw,
    errors,
    partial: errors.length > 0,
    permissionHint: 'instagram_business_manage_insights',
    capturedAt: new Date().toISOString(),
  };
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
    mediaInsightsImplemented: true,
    insightsPermissionRequired: 'instagram_business_manage_insights',
  };
}

module.exports = { GRAPH_BASE, DEFAULT_MEDIA_INSIGHT_METRICS, credentials, requestJson, verifyConnection, profileSnapshot, recentMedia, insightValue, normalizeInsightMetrics, mediaInsights, accountSnapshot, status };
