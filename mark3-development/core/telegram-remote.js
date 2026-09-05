const voice = require('./voice-orchestrator');
const { emit } = require('./events');

let running = false;
let stopped = false;
let loopPromise = null;
let offset = 0;
let lastError = null;
let botIdentity = null;

const LONG_POLL_SECONDS = Math.max(5, Math.min(45, Number(process.env.ULTRON_M3_TELEGRAM_LONG_POLL_SECONDS || 25)));
const RETRY_MS = Math.max(1500, Number(process.env.ULTRON_M3_TELEGRAM_RETRY_MS || 5000));

function token() { return String(process.env.TELEGRAM_BOT_TOKEN || '').trim(); }
function allowedChatId() { return String(process.env.TELEGRAM_ALLOWED_CHAT_ID || '').trim(); }
function enabled() { return !/^(0|false|no|off)$/i.test(String(process.env.ULTRON_M3_TELEGRAM_ENABLED || '1')); }
function baseUrl() {
  const value = token();
  if (!value) throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
  return `https://api.telegram.org/bot${value}`;
}

async function api(method, payload = {}, timeoutMs = (LONG_POLL_SECONDS + 10) * 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
    if (!response.ok || data?.ok === false) {
      const description = String(data?.description || raw || `HTTP ${response.status}`).slice(0, 700);
      const error = new Error(`Telegram Bot API ${method} failed: ${description}`);
      error.status = response.status;
      throw error;
    }
    return data?.result;
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') throw new Error(`Telegram Bot API ${method} timed out.`);
    throw error;
  } finally { clearTimeout(timer); }
}

async function verify() {
  if (!enabled()) return { ok: false, enabled: false, reason: 'telegram-remote-disabled' };
  if (!token()) return { ok: false, enabled: true, tokenConfigured: false, reason: 'TELEGRAM_BOT_TOKEN is not configured.' };
  const [me, webhook] = await Promise.all([api('getMe'), api('getWebhookInfo')]);
  botIdentity = me ? { id: me.id, username: me.username || null, firstName: me.first_name || null } : null;
  const webhookUrl = String(webhook?.url || '').trim();
  return {
    ok: !webhookUrl,
    enabled: true,
    tokenConfigured: true,
    allowedChatConfigured: Boolean(allowedChatId()),
    bot: botIdentity,
    webhookConfigured: Boolean(webhookUrl),
    blocker: webhookUrl ? 'A Telegram webhook is configured. Long polling and webhooks are mutually exclusive; remove the webhook deliberately before enabling local polling.' : null,
  };
}

function chunkText(text, max = 3900) {
  const value = String(text || '').trim();
  if (!value) return [];
  const chunks = [];
  let rest = value;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < Math.floor(max * 0.55)) cut = rest.lastIndexOf(' ', max);
    if (cut < Math.floor(max * 0.55)) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendText(chatId, text) {
  const chunks = chunkText(text);
  for (const chunk of chunks) {
    await api('sendMessage', { chat_id: String(chatId), text: chunk, disable_web_page_preview: true }, 15000);
  }
  return { sent: chunks.length };
}

function messageFromUpdate(update = {}) {
  const message = update.message || update.edited_message || null;
  if (!message) return null;
  const chatId = String(message?.chat?.id || '').trim();
  const text = String(message?.text || '').trim();
  if (!chatId || !text) return null;
  return {
    updateId: Number(update.update_id),
    chatId,
    chatType: String(message?.chat?.type || ''),
    text,
    userId: String(message?.from?.id || '').trim() || null,
    username: String(message?.from?.username || '').trim() || null,
    isBot: Boolean(message?.from?.is_bot),
  };
}

async function handleMessage(message) {
  if (!message || message.isBot) return { ignored: true, reason: 'bot-message' };
  const allowed = allowedChatId();
  if (!allowed || message.chatId !== allowed) {
    emit('telegram_remote_rejected', { chatId: message.chatId, userId: message.userId, reason: allowed ? 'chat-not-allowlisted' : 'allowlist-not-configured' });
    return { ignored: true, reason: 'chat-not-allowlisted' };
  }

  const assistant = require('./assistant');
  const incoming = message.text === '/health' ? 'Ultron, turbo status' : message.text === '/start'
    ? 'Ultron, give me a concise status of what you can do right now.'
    : message.text;
  emit('telegram_remote_command', { chatId: message.chatId, userId: message.userId, commandChars: incoming.length });
  try {
    const result = await voice.runWithDeliveryContext({ suppressLocalVoice: true, source: 'telegram' }, () => assistant.handle(incoming, { inputMode: 'chat', remoteSurface: 'telegram' }));
    const response = String(result?.response || result?.text || 'Command completed without a text response.').trim();
    await sendText(message.chatId, response);
    emit('telegram_remote_completed', { chatId: message.chatId, ok: Boolean(result?.ok), responseChars: response.length });
    return { ok: Boolean(result?.ok), responseChars: response.length };
  } catch (error) {
    const safe = `Sir, the Telegram remote command failed: ${String(error.message || error).slice(0, 900)}`;
    try { await sendText(message.chatId, safe); } catch {}
    emit('telegram_remote_failed', { chatId: message.chatId, error: String(error.message || error).slice(0, 700) });
    return { ok: false, error: error.message };
  }
}

async function pollOnce() {
  const updates = await api('getUpdates', {
    offset: offset || undefined,
    limit: 50,
    timeout: LONG_POLL_SECONDS,
    allowed_updates: ['message', 'edited_message'],
  });
  const rows = Array.isArray(updates) ? updates : [];
  for (const update of rows) {
    const updateId = Number(update?.update_id);
    if (Number.isFinite(updateId)) offset = Math.max(offset, updateId + 1);
    const message = messageFromUpdate(update);
    if (message) await handleMessage(message);
  }
  return rows.length;
}

async function loop() {
  running = true;
  stopped = false;
  while (!stopped) {
    try {
      await pollOnce();
      lastError = null;
    } catch (error) {
      lastError = error.message;
      emit('telegram_remote_poll_error', { error: String(error.message || error).slice(0, 700) });
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
  running = false;
}

async function start() {
  if (running) return status();
  if (!enabled()) return status();
  if (!token() || !allowedChatId()) return status();
  const checked = await verify();
  if (!checked.ok) { lastError = checked.blocker || checked.reason || 'Telegram verification failed.'; return status(); }
  loopPromise = loop().catch((error) => { lastError = error.message; running = false; });
  loopPromise?.catch?.(() => {});
  return status();
}

function stop() { stopped = true; return status(); }

async function discoverChats() {
  if (!token()) throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
  const webhook = await api('getWebhookInfo');
  if (String(webhook?.url || '').trim()) throw new Error('A webhook is configured; Telegram does not allow getUpdates while a webhook is active.');
  const updates = await api('getUpdates', { limit: 50, timeout: 0, allowed_updates: ['message'] }, 15000);
  const chats = new Map();
  for (const update of Array.isArray(updates) ? updates : []) {
    const message = messageFromUpdate(update);
    if (!message) continue;
    chats.set(message.chatId, { chatId: message.chatId, chatType: message.chatType, userId: message.userId, username: message.username });
  }
  return [...chats.values()];
}

function status() {
  return {
    implemented: true,
    enabled: enabled(),
    tokenConfigured: Boolean(token()),
    allowedChatConfigured: Boolean(allowedChatId()),
    ready: enabled() && Boolean(token()) && Boolean(allowedChatId()) && !lastError,
    running,
    longPolling: true,
    requestScopedLocalVoiceSuppression: true,
    bot: botIdentity,
    lastError,
    security: 'explicit single-chat allowlist; non-allowlisted updates ignored',
  };
}

module.exports = { api, verify, chunkText, sendText, messageFromUpdate, handleMessage, pollOnce, start, stop, discoverChats, status };
