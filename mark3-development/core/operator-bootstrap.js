const operator = require('./operator');
const instagram = require('./instagram');
const instagramDm = require('./instagram-dm');
const creatorResearch = require('./creator-research');

let installed = false;
let originalHandle = null;

function statusResponse() {
  const rows = operator.status();
  const ready = rows.filter((row) => row.ready);
  const building = rows.filter((row) => !row.implemented);
  const waiting = rows.filter((row) => row.implemented && !row.credentialsReady);
  const lines = [
    'Sir, Operator Mode is active.',
    ready.length ? `Ready now: ${ready.map((row) => row.title).join(', ')}.` : 'No operator capabilities are fully ready yet.',
    building.length ? `Build next: ${building.map((row) => row.title).join(', ')}.` : '',
    waiting.length ? `Waiting on credentials: ${waiting.map((row) => row.title).join(', ')}.` : '',
  ].filter(Boolean);
  return lines.join(' ');
}

function blockedResponse(state) {
  const missing = state.missing.length ? state.missing.join(', ') : 'connector implementation';
  return `Sir, I recognized this as ${state.title}, but I cannot execute it yet. Missing: ${missing}. I will not pretend the action happened or substitute unrelated web research.`;
}

function tradingBoundary(text, state) {
  if (state.id !== 'trading_research') return null;
  if (!/\b(?:execute|place|open|close|buy|sell|manage)\b[\s\S]{0,60}\b(?:trade|position|order)|\b(?:trade|position|order)\b[\s\S]{0,60}\b(?:automatically|autonomous|without me|execute|place)\b/i.test(String(text || ''))) return null;
  return 'Sir, I can research, backtest, generate alerts and run the strategy in paper/simulated mode, but I will not autonomously place or manage real-money trades.';
}

function isStatusRequest(text) {
  return /^(?:ultron\s+)?(?:operator|capabilities?|what can you do)(?:\s+status)?[?.!\s]*$/i.test(String(text || '').trim())
    || /\boperator\s+(?:status|capabilities)\b/i.test(String(text || ''));
}

function isInstagramCheckRequest(text) {
  return /\b(?:check|verify|test|confirm)\b[\s\S]{0,50}\binstagram\b[\s\S]{0,30}\b(?:connection|api|account|token)?\b/i.test(String(text || ''))
    || /\binstagram\b[\s\S]{0,40}\b(?:connection|api)\s+(?:status|check|test)\b/i.test(String(text || ''));
}

function isDmInboxRequest(text) {
  return /\b(?:check|read|show|list|open|review)\b[\s\S]{0,50}\b(?:instagram|ig)?\s*(?:dm|dms|inbox|conversations?)\b/i.test(String(text || ''));
}

function parseDmDraftRequest(text) {
  const value = String(text || '').trim();
  if (!/\b(?:draft|write|prepare|create)\b[\s\S]{0,50}\b(?:instagram|ig)?\s*(?:dm|message)\b/i.test(value)) return null;
  const handle = value.match(/@([a-z0-9._]{2,30})\b/i)?.[1];
  return handle ? { handle: creatorResearch.normalizeHandle(handle) } : null;
}

function parseExplicitDmSend(text) {
  const value = String(text || '').trim();
  if (!/\b(?:send|reply|message)\b/i.test(value) || !/\b(?:dm|message|reply)\b/i.test(value)) return null;
  const handle = value.match(/@([a-z0-9._]{2,30})\b/i)?.[1];
  if (!handle) return null;
  let body = value.match(/\b(?:saying|say|with\s+(?:the\s+)?message)\b\s*[:,-]?\s*["“]?([\s\S]+?)["”]?\s*$/i)?.[1];
  if (!body) body = value.match(/@(?:[a-z0-9._]{2,30})\b\s*[:,-]\s*([\s\S]+)$/i)?.[1];
  body = String(body || '').replace(/^["“]|["”]$/g, '').trim();
  if (!body) return null;
  return { handle: creatorResearch.normalizeHandle(handle), text: body };
}

async function instagramCheckResponse() {
  try {
    const result = await instagram.verifyConnection();
    return {
      ok: true,
      text: `Connected, Sir. Instagram API verified @${result.username || 'unknown'} with account ID ${result.accountId}. The token and configured account ID match.`,
      result,
    };
  } catch (error) {
    return {
      ok: false,
      text: `Sir, the Instagram connection check failed: ${error.message}`,
      error: error.message,
    };
  }
}

function findSavedLead(handle) {
  const target = creatorResearch.normalizeHandle(handle);
  return creatorResearch.list({ limit: 100 }).find((lead) => creatorResearch.normalizeHandle(lead.handle) === target) || null;
}

function syncConversationLead(conversation) {
  const self = String(instagram.credentials().accountId.value || '');
  for (const participant of conversation.participants || []) {
    if (!participant?.username || String(participant.id || '') === self) continue;
    try {
      creatorResearch.updateLead(participant.username, {
        dmConversationId: conversation.id,
        dmRecipientId: participant.id,
        outreachState: 'conversation_open',
      });
    } catch {}
  }
}

async function dmInboxResponse() {
  try {
    const result = await instagramDm.listConversations({ limit: 20 });
    result.conversations.forEach(syncConversationLead);
    const handles = result.conversations.flatMap((conversation) => (conversation.participants || []).map((participant) => participant.username ? `@${participant.username}` : null).filter(Boolean));
    return {
      ok: true,
      text: result.count
        ? `Sir, I found ${result.count} Instagram conversation${result.count === 1 ? '' : 's'}. Recent participants: ${[...new Set(handles)].slice(0, 8).join(', ') || 'participant usernames were not returned by Meta'}. I synced matching researched creators into the lead pipeline.`
        : 'Sir, the Instagram Messaging API returned no active conversations.',
      result,
    };
  } catch (error) {
    return { ok: false, text: `Sir, I could not read the Instagram inbox: ${error.message}`, error: error.message };
  }
}

function dmDraftResponse(handle) {
  const lead = findSavedLead(handle) || { handle, displayName: handle, niche: 'creator' };
  const draft = instagramDm.draftColdOutreach(lead);
  return {
    ok: true,
    text: `${draft.text}\n\nDelivery: manual first contact. Meta's official Send API cannot initiate a cold DM; once @${draft.handle} messages Elevate, Ultron can handle approved replies/follow-ups through the API.`,
    draft,
  };
}

async function dmSendResponse(parsed) {
  const lead = findSavedLead(parsed.handle);
  if (!lead?.dmRecipientId) {
    return {
      ok: false,
      text: `Sir, @${parsed.handle} is not linked to an existing inbound Instagram conversation, so Meta will not let the official API send this as a cold first DM. Keep this exact message in the manual outreach queue; after they reply, Ultron can take over follow-ups.`,
      error: 'INSTAGRAM_COLD_DM_NOT_SUPPORTED',
    };
  }
  try {
    const sent = await instagramDm.sendText(lead.dmRecipientId, parsed.text, { approved: true, explicitUserAction: true });
    creatorResearch.updateLead(parsed.handle, { outreachState: 'replied', lastContactAt: sent.sentAt, dmConversationId: sent.conversationId, dmRecipientId: sent.recipientId });
    return { ok: true, text: `Sent, Sir. The Instagram reply to @${parsed.handle} was verified with message ID ${sent.messageId}.`, result: sent };
  } catch (error) {
    return { ok: false, text: `Sir, the Instagram DM send failed: ${error.message}`, error: error.message };
  }
}

async function creatorResearchResponse(text) {
  const request = creatorResearch.requestFromText(text);
  try {
    const result = await creatorResearch.discover(request);
    if (!result.candidates.length) {
      return { ok: false, text: `Sir, the India-first creator search completed but did not produce verified Instagram handles for ${request.niche}. I did not invent leads from weak evidence.`, result };
    }
    const shown = result.candidates.slice(0, Math.min(12, result.candidates.length));
    const lines = shown.map((lead, index) => {
      const location = lead.city || (lead.market ? lead.market : 'India evidence weak');
      const followers = lead.followerCount == null ? '' : ` · ${lead.followerCount.toLocaleString('en-IN')} followers`;
      return `${index + 1}. @${lead.handle} · ${location} · fit ${lead.fitScore}/100${followers}`;
    });
    const remainder = result.candidates.length > shown.length ? ` ${result.candidates.length - shown.length} more were saved in the creator lead store.` : '';
    return {
      ok: true,
      text: `Sir, I found ${result.candidates.length} India-prioritized ${request.niche} creator prospect${result.candidates.length === 1 ? '' : 's'} and deduplicated them by Instagram handle.${remainder}\n${lines.join('\n')}\nFollower counts are shown only where public search evidence actually exposed them.`,
      result,
    };
  } catch (error) {
    return { ok: false, text: `Sir, creator research failed: ${error.message}`, error: error.message };
  }
}

function install() {
  if (installed) return { installed: true, alreadyInstalled: true };
  const assistant = require('./assistant');
  const conversation = require('./conversation');
  const voice = require('./voice-orchestrator');
  const { emit } = require('./events');
  if (!assistant?.handle) throw new Error('Assistant handle is unavailable for Operator Mode.');
  originalHandle = assistant.handle;

  assistant.handle = async (message, options = {}) => {
    const text = String(message || '').trim();
    const inputMode = String(options.inputMode || 'chat').toLowerCase() === 'voice' ? 'voice' : 'chat';

    if (isInstagramCheckRequest(text)) {
      conversation.append('user', text, { taskType: 'instagram-check', inputMode });
      emit('instagram_check_started', { inputMode });
      const checked = await instagramCheckResponse();
      conversation.append('assistant', checked.text, { model: 'instagram-connector', provider: 'meta', taskType: 'instagram-check', inputMode, ok: checked.ok });
      emit(checked.ok ? 'instagram_check_completed' : 'instagram_check_failed', checked.ok ? { accountId: checked.result.accountId, username: checked.result.username, inputMode } : { error: checked.error, inputMode });
      void voice.enqueue(checked.text);
      return { ok: checked.ok, response: checked.text, text: checked.text, model: 'instagram-connector', provider: 'meta', taskType: 'instagram-check', mode: 'operator', inputMode, instagram: checked.result || null, error: checked.error || null, toolRounds: 0 };
    }

    if (isStatusRequest(text)) {
      const response = statusResponse();
      conversation.append('user', text, { taskType: 'operator-status', inputMode });
      conversation.append('assistant', response, { model: 'operator-router', provider: 'local', taskType: 'operator-status', inputMode });
      emit('operator_status_requested', { inputMode, status: operator.summary() });
      void voice.enqueue(response);
      return { ok: true, response, text: response, model: 'operator-router', provider: 'local', taskType: 'operator-status', mode: 'operator', inputMode, toolRounds: 0 };
    }

    const draft = parseDmDraftRequest(text);
    if (draft) {
      const prepared = dmDraftResponse(draft.handle);
      conversation.append('user', text, { taskType: 'instagram-dm-draft', inputMode });
      conversation.append('assistant', prepared.text, { model: 'instagram-dm', provider: 'local', taskType: 'instagram-dm-draft', inputMode });
      void voice.enqueue(prepared.text);
      return { ok: true, response: prepared.text, text: prepared.text, model: 'instagram-dm', provider: 'local', taskType: 'instagram-dm-draft', mode: 'operator', capability: 'instagram_dm', inputMode, draft: prepared.draft, toolRounds: 0 };
    }

    const capability = operator.match(text);
    if (!capability) return originalHandle(message, options);
    const state = operator.capabilityState(capability);
    emit('operator_intent', { capability: state.id, title: state.title, ready: state.ready, implemented: state.implemented, credentialsReady: state.credentialsReady, inputMode });

    const boundary = tradingBoundary(text, state);
    if (boundary) {
      conversation.append('user', text, { taskType: 'trading-research', inputMode });
      conversation.append('assistant', boundary, { model: 'operator-router', provider: 'local', taskType: 'trading-research', inputMode });
      void voice.enqueue(boundary);
      return { ok: true, response: boundary, text: boundary, model: 'operator-router', provider: 'local', taskType: 'trading-research', mode: 'operator', capability: state.id, inputMode, toolRounds: 0 };
    }

    if (!state.ready && state.id !== 'software_build') {
      const response = blockedResponse(state);
      conversation.append('user', text, { taskType: `operator-${state.id}`, inputMode });
      conversation.append('assistant', response, { model: 'operator-router', provider: 'local', taskType: `operator-${state.id}`, inputMode });
      emit('operator_blocked', { capability: state.id, missing: state.missing, inputMode });
      void voice.enqueue(response);
      return { ok: true, response, text: response, model: 'operator-router', provider: 'local', taskType: `operator-${state.id}`, mode: 'operator-blocked', capability: state.id, missing: state.missing, inputMode, toolRounds: 0 };
    }

    if (state.id === 'creator_research') {
      conversation.append('user', text, { taskType: 'creator-research', inputMode });
      emit('creator_research_started', { inputMode, request: creatorResearch.requestFromText(text) });
      const researched = await creatorResearchResponse(text);
      conversation.append('assistant', researched.text, { model: 'creator-research', provider: 'web-research', taskType: 'creator-research', inputMode, ok: researched.ok });
      emit(researched.ok ? 'creator_research_completed' : 'creator_research_failed', researched.ok ? { count: researched.result?.count || 0, inputMode } : { error: researched.error || 'no-results', inputMode });
      void voice.enqueue(researched.text);
      return { ok: researched.ok, response: researched.text, text: researched.text, model: 'creator-research', provider: 'web-research', taskType: 'creator-research', mode: 'operator', capability: state.id, inputMode, creatorResearch: researched.result || null, error: researched.error || null, toolRounds: 0 };
    }

    if (state.id === 'instagram_dm') {
      let handled;
      const explicitSend = parseExplicitDmSend(text);
      if (explicitSend) handled = await dmSendResponse(explicitSend);
      else if (isDmInboxRequest(text)) handled = await dmInboxResponse();
      if (handled) {
        conversation.append('user', text, { taskType: 'instagram-dm', inputMode });
        conversation.append('assistant', handled.text, { model: 'instagram-dm', provider: 'meta', taskType: 'instagram-dm', inputMode, ok: handled.ok });
        void voice.enqueue(handled.text);
        return { ok: handled.ok, response: handled.text, text: handled.text, model: 'instagram-dm', provider: 'meta', taskType: 'instagram-dm', mode: 'operator', capability: state.id, inputMode, instagramDm: handled.result || null, error: handled.error || null, toolRounds: 0 };
      }
    }

    const taskType = state.id === 'creator_research' || state.id === 'trading_research' ? 'research' : options.taskType;
    return originalHandle(message, { ...options, taskType: taskType || options.taskType, operatorCapability: state.id });
  };

  installed = true;
  emit('operator_ready', { status: operator.summary(), instagram: instagram.status(), instagramDm: instagramDm.status(), creatorResearch: creatorResearch.status() });
  return { installed: true, status: operator.summary(), instagram: instagram.status(), instagramDm: instagramDm.status(), creatorResearch: creatorResearch.status() };
}

function uninstall() {
  if (!installed) return;
  const assistant = require('./assistant');
  if (originalHandle) assistant.handle = originalHandle;
  originalHandle = null;
  installed = false;
}

function status() { return { installed, capabilities: operator.status(), instagram: instagram.status(), instagramDm: instagramDm.status(), creatorResearch: creatorResearch.status() }; }

module.exports = {
  install,
  uninstall,
  status,
  statusResponse,
  blockedResponse,
  tradingBoundary,
  isStatusRequest,
  isInstagramCheckRequest,
  isDmInboxRequest,
  parseDmDraftRequest,
  parseExplicitDmSend,
  instagramCheckResponse,
  dmInboxResponse,
  dmDraftResponse,
  dmSendResponse,
  creatorResearchResponse,
};
