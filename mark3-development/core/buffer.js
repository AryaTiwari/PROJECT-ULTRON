const API_URL = 'https://api.buffer.com';
const TIMEOUT_MS = Math.max(5000, Number(process.env.ULTRON_M3_BUFFER_TIMEOUT_MS || 20000));

function apiKey() { return String(process.env.BUFFER_API_KEY || '').trim(); }

async function graph(query, variables = {}, timeoutMs = TIMEOUT_MS) {
  const key = apiKey();
  if (!key) throw new Error('BUFFER_API_KEY is not configured.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
    if (!response.ok) throw new Error(`Buffer API HTTP ${response.status}: ${String(data?.message || raw).slice(0, 500)}`);
    if (Array.isArray(data?.errors) && data.errors.length) throw new Error(`Buffer GraphQL error: ${data.errors.map((item) => item?.message || 'unknown').join(' | ').slice(0, 700)}`);
    return data?.data || {};
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') throw new Error(`Buffer API timed out after ${timeoutMs}ms.`);
    throw error;
  } finally { clearTimeout(timer); }
}

async function organizations() {
  const data = await graph(`query GetOrganizations { account { organizations { id name ownerEmail } } }`);
  return (data?.account?.organizations || []).map((item) => ({ id: item.id, name: item.name, ownerEmail: item.ownerEmail || null }));
}

async function channels(organizationId) {
  if (!organizationId) throw new Error('Buffer organizationId is required.');
  const data = await graph(`query GetChannels($organizationId: ID!) { channels(input: { organizationId: $organizationId }) { id name displayName service avatar isQueuePaused } }`, { organizationId });
  return (data?.channels || []).map((item) => ({
    id: item.id,
    name: item.name,
    displayName: item.displayName || null,
    service: item.service,
    avatar: item.avatar || null,
    isQueuePaused: Boolean(item.isQueuePaused),
  }));
}

async function verifyConnection() {
  const orgs = await organizations();
  const discovered = [];
  for (const org of orgs.slice(0, 4)) {
    let rows = [];
    try { rows = await channels(org.id); } catch {}
    discovered.push({ id: org.id, name: org.name, channels: rows });
  }
  return {
    ok: true,
    connected: true,
    organizations: discovered,
    channelCount: discovered.reduce((sum, org) => sum + org.channels.length, 0),
    services: [...new Set(discovered.flatMap((org) => org.channels.map((channel) => channel.service)).filter(Boolean))],
    apiKeyConfigured: true,
  };
}

function videoPostDryRun({ channelId, text = '', mediaUrl, mode = 'addToQueue', schedulingType = 'automatic', thumbnailOffset = 2000 } = {}) {
  if (!channelId) throw new Error('Buffer channelId is required.');
  if (!mediaUrl || !/^https:\/\//i.test(String(mediaUrl))) throw new Error('Buffer video publishing needs a public HTTPS media URL.');
  const input = {
    text: String(text || ''),
    channelId: String(channelId),
    schedulingType,
    mode,
    assets: [{ video: { url: String(mediaUrl), metadata: { thumbnailOffset: Math.max(0, Number(thumbnailOffset || 0)) } } }],
  };
  return {
    ok: true,
    dryRun: true,
    externalWritePerformed: false,
    input,
    blocker: 'Live Buffer publication is intentionally not executed by this foundation connector; wire through an explicit approval-gated publisher first.',
  };
}

function status() {
  return {
    implemented: true,
    configured: Boolean(apiKey()),
    apiKeyConfigured: Boolean(apiKey()),
    endpoint: API_URL,
    readOnlyVerification: true,
    videoDryRun: true,
    liveWriteEnabled: false,
    approvalRequiredForLiveWrite: true,
  };
}

module.exports = { API_URL, apiKey, graph, organizations, channels, verifyConnection, videoPostDryRun, status };
