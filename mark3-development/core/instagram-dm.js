const instagram = require('./instagram');

const API_VERSION = String(process.env.ULTRON_M3_INSTAGRAM_API_VERSION || 'v26.0').trim() || 'v26.0';
const TIMEOUT_MS = Math.max(5000, Number(process.env.ULTRON_M3_INSTAGRAM_DM_TIMEOUT_MS || 20000));
const REQUIRED_PERMISSION = 'instagram_business_manage_messages';

function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function endpoint(pathname) {
  const base = String(instagram.GRAPH_BASE || 'https://graph.instagram.com').replace(/\/$/, '');
  const path = String(pathname || '').replace(/^\/+/, '');
  return `${base}/${API_VERSION}/${path}`;
}

async function request(method, pathname, options = {}) {
  const creds = instagram.credentials();
  if (!creds.token.value) throw new Error('INSTAGRAM_TOKEN is not configured.');
  const controller = new AbortController();
  const timeoutMs = Math.max(5000, Number(options.timeoutMs || TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(endpoint(pathname));
    for (const [key, value] of Object.entries(options.query || {})) {
      if (value != null && String(value).length) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${creds.token.value}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
    if (!response.ok || data?.error) {
      const detail = data?.error?.message || data?.message || raw.slice(0, 700) || `HTTP ${response.status}`;
      const error = new Error(`Instagram Messaging API HTTP ${response.status}: ${detail}`);
      error.status = response.status;
      error.code = data?.error?.code || null;
      error.type = data?.error?.type || null;
      throw error;
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') throw new Error(`Instagram Messaging API timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function accountId() {
  const value = instagram.credentials().accountId.value;
  if (!value) throw new Error('INSTAGRAM_ACCOUNT_ID is not configured.');
  return value;
}

function normalizeConversation(item = {}) {
  return {
    id: clean(item.id) || null,
    updatedTime: clean(item.updated_time) || null,
    participants: Array.isArray(item.participants?.data)
      ? item.participants.data.map((participant) => ({ id: clean(participant?.id) || null, username: clean(participant?.username) || null, name: clean(participant?.name) || null }))
      : [],
  };
}

async function listConversations(options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit || 20)));
  const data = await request('GET', `${accountId()}/conversations`, {
    query: { platform: 'instagram', fields: 'id,updated_time,participants', limit },
    timeoutMs: options.timeoutMs,
  });
  const rows = (Array.isArray(data?.data) ? data.data : []).map(normalizeConversation);
  return { ok: true, conversations: rows, count: rows.length, paging: data?.paging || null };
}

async function findConversationByRecipient(recipientId, options = {}) {
  const id = clean(recipientId);
  if (!id) throw new Error('Instagram-scoped recipient ID is required.');
  const data = await request('GET', `${accountId()}/conversations`, {
    query: { user_id: id },
    timeoutMs: options.timeoutMs,
  });
  const row = Array.isArray(data?.data) ? data.data[0] : null;
  return row ? normalizeConversation(row) : null;
}

async function getConversationMessages(conversationId, options = {}) {
  const id = clean(conversationId);
  if (!id) throw new Error('Instagram conversation ID is required.');
  const limit = Math.max(1, Math.min(20, Number(options.limit || 20)));
  let data;
  try {
    data = await request('GET', id, {
      query: { fields: `messages.limit(${limit}){id,created_time,from,to,message,is_unsupported}` },
      timeoutMs: options.timeoutMs,
    });
  } catch {
    data = await request('GET', id, { query: { fields: 'messages' }, timeoutMs: options.timeoutMs });
  }
  const messages = Array.isArray(data?.messages?.data) ? data.messages.data : [];
  return {
    ok: true,
    conversationId: id,
    messages: messages.map((message) => ({
      id: clean(message?.id) || null,
      createdTime: clean(message?.created_time) || null,
      from: message?.from || null,
      to: message?.to || null,
      message: clean(message?.message) || null,
      unsupported: Boolean(message?.is_unsupported),
    })),
    count: messages.length,
  };
}

function assertSendApproval(options = {}) {
  if (options.approved === true || options.explicitUserAction === true) return;
  const error = new Error('Instagram DM send is approval-gated. Prepare the reply first, then send only after explicit user approval for that exact message/recipient.');
  error.code = 'DM_APPROVAL_REQUIRED';
  throw error;
}

async function sendText(recipientId, text, options = {}) {
  const recipient = clean(recipientId);
  const message = clean(text);
  if (!recipient) throw new Error('Instagram-scoped recipient ID is required.');
  if (!message) throw new Error('Instagram DM text is required.');
  if (message.length > 1000) throw new Error('Instagram DM text is too long; keep it within 1000 characters.');
  assertSendApproval(options);

  // Meta's official Send API cannot initiate a cold conversation. Verify that an
  // existing conversation already exists with this Instagram-scoped user ID.
  const existing = await findConversationByRecipient(recipient, options);
  if (!existing?.id) {
    const error = new Error('Official Instagram Messaging cannot initiate this cold DM. The recipient must message the Elevate professional account first. Keep this creator in the manual-first-contact outreach queue.');
    error.code = 'INSTAGRAM_COLD_DM_NOT_SUPPORTED';
    throw error;
  }

  if (options.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      recipientId: recipient,
      conversationId: existing.id,
      message,
      policy: 'existing-conversation-only',
    };
  }

  const data = await request('POST', `${accountId()}/messages`, {
    body: { recipient: { id: recipient }, message: { text: message } },
    timeoutMs: options.timeoutMs,
  });
  const messageId = clean(data?.message_id) || null;
  if (!messageId) throw new Error('Instagram Messaging API returned no message_id; send success cannot be verified.');
  return {
    ok: true,
    sent: true,
    recipientId: clean(data?.recipient_id) || recipient,
    conversationId: existing.id,
    messageId,
    message,
    sentAt: new Date().toISOString(),
    policy: 'existing-conversation-only',
  };
}

function draftColdOutreach(lead = {}, options = {}) {
  const handle = clean(lead.handle).replace(/^@+/, '');
  const name = clean(lead.displayName || handle || 'there').replace(/\s*\(@.*$/, '');
  const niche = clean(lead.niche || options.niche || 'content');
  const website = clean(options.website || 'elevateos.in');
  const text = clean(`Hey ${name || 'there'} 👋 Came across your ${niche} content and liked what you're building. I'm reaching out from Elevate OS — we help creators improve content performance, positioning and brand opportunities. Would love to share a few ideas tailored to your page. You can also check us out at ${website}.`);
  return {
    ok: true,
    handle: handle || null,
    text,
    delivery: 'manual-first-contact',
    canSendViaOfficialApi: false,
    reason: 'Meta requires the Instagram user to message the professional account before the Send API can reply.',
  };
}

function status() {
  const creds = instagram.credentials();
  return {
    implemented: true,
    apiVersion: API_VERSION,
    configured: Boolean(creds.token.value && creds.accountId.value),
    tokenConfigured: Boolean(creds.token.value),
    accountIdConfigured: Boolean(creds.accountId.value),
    requiredPermission: REQUIRED_PERMISSION,
    conversationsImplemented: true,
    repliesImplemented: true,
    dryRunImplemented: true,
    approvalRequired: true,
    coldOutreachViaOfficialApi: false,
    coldOutreachPolicy: 'manual-first-contact; official API replies/follow-ups only after inbound conversation exists',
    webhookIngestionImplemented: false,
  };
}

module.exports = {
  API_VERSION,
  REQUIRED_PERMISSION,
  endpoint,
  request,
  normalizeConversation,
  listConversations,
  findConversationByRecipient,
  getConversationMessages,
  sendText,
  draftColdOutreach,
  status,
};
