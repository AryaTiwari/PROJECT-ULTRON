(() => {
  const nativeFetch = window.fetch.bind(window);
  // Match the Mark 3 client budget so long full-sheet work is not reported as
  // failed while the server is still committing verified rows.
  const CHAT_TRANSPORT_TIMEOUT_MS = 45 * 60 * 1000;
  const LINKEDIN_RESEARCH_TIMEOUT_MS = 45 * 60 * 1000;
  const MIN_REPLY_WINDOW_MS = 7000;
  const FLOW_REPLY_WINDOW_MS = 10000;
  const REPLY_OPEN_GRACE_MS = 18000;
  const PLAYBACK_SETTLE_MS = 700;
  const ENRICHMENT_RECONNECT_DELAYS_MS = [700, 1400, 2400];
  let pendingReplyWindowMs = 0;
  let replyOpenDeadline = 0;
  let replyTimer = null;
  let lastChatInputMode = 'chat';
  let voiceSynthesisComplete = false;
  let lastSpeakingSeenAt = 0;

  function audioEnabled() {
    const button = document.querySelector('#voiceToggle');
    return !button || !/AUDIO OFF/i.test(String(button.textContent || ''));
  }

  function clearReplyTimer() {
    if (replyTimer) {
      clearTimeout(replyTimer);
      replyTimer = null;
    }
  }

  function commandListening() {
    return Boolean(document.querySelector('.globe-wrap.command-listening'));
  }

  function playbackActive() {
    const wrap = document.querySelector('.globe-wrap');
    const status = String(document.querySelector('#statusText')?.textContent || '');
    const active = Boolean(wrap?.classList.contains('speaking')) || /SPEAKING/i.test(status);
    if (active) lastSpeakingSeenAt = Date.now();
    return active;
  }

  function playbackSettled() {
    if (playbackActive()) return false;
    return !lastSpeakingSeenAt || Date.now() - lastSpeakingSeenAt >= PLAYBACK_SETTLE_MS;
  }

  function expirePendingReply() {
    pendingReplyWindowMs = 0;
    replyOpenDeadline = 0;
    voiceSynthesisComplete = false;
    clearReplyTimer();
  }

  function setModeChip(mode) {
    const chip = document.querySelector('.mode-chip span:last-child');
    const label = String(mode?.label || mode?.mode || 'EXECUTIVE').trim().toUpperCase();
    if (chip) chip.textContent = `${label} MODE`;
  }

  async function refreshMode() {
    try {
      const response = await nativeFetch('/api/mode', { cache: 'no-store' });
      const data = await response.json();
      if (response.ok && data?.ok !== false) setModeChip(data);
    } catch {}
  }

  function openReplyWindow() {
    const duration = Math.max(MIN_REPLY_WINDOW_MS, Number(pendingReplyWindowMs || 0));
    if (!duration) return;
    if (replyOpenDeadline && Date.now() > replyOpenDeadline) {
      expirePendingReply();
      return;
    }

    // With audio enabled, never reopen the mic merely because the HTTP response
    // arrived. Wait until Mark 3 has generated every TTS chunk AND the browser
    // has been visibly quiet for a short settle window. This prevents the mic
    // from interrupting ULTRON between speech chunks.
    if (audioEnabled() && (!voiceSynthesisComplete || !playbackSettled())) {
      setTimeout(openReplyWindow, 180);
      return;
    }

    const orb = document.querySelector('#voiceOrb');
    const status = String(document.querySelector('#statusText')?.textContent || '');
    if (!orb || orb.disabled || /SPEAKING|THINKING|ROUTING|GENERATING/i.test(status)) {
      setTimeout(openReplyWindow, 180);
      return;
    }

    pendingReplyWindowMs = 0;
    replyOpenDeadline = 0;
    voiceSynthesisComplete = false;
    clearReplyTimer();
    if (!commandListening()) orb.click();

    const eyebrow = document.querySelector('#voiceEyebrow');
    const prompt = document.querySelector('#voicePrompt');
    if (eyebrow) eyebrow.textContent = 'CONVERSATION FLOW';
    if (prompt) prompt.textContent = 'Continue naturally. No wake word needed.';

    replyTimer = setTimeout(() => {
      const interim = String(document.querySelector('#voiceInterim')?.textContent || '').trim();
      if (commandListening() && !interim) {
        const currentOrb = document.querySelector('#voiceOrb');
        if (currentOrb && !currentOrb.disabled) currentOrb.click();
      }
      replyTimer = null;
    }, duration);
  }

  function scheduleReplyWindow(delay = 250) {
    if (!pendingReplyWindowMs) return;
    if (!replyOpenDeadline) replyOpenDeadline = Date.now() + Math.max(REPLY_OPEN_GRACE_MS, pendingReplyWindowMs + 8000);
    setTimeout(openReplyWindow, delay);
  }

  function requestInputMode(init = {}) {
    try {
      const parsed = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
      return String(parsed?.inputMode || 'chat').toLowerCase() === 'voice' ? 'voice' : 'chat';
    } catch {
      return 'chat';
    }
  }

  function requestMessage(init = {}) {
    try {
      const parsed = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
      return String(parsed?.message || '').trim();
    } catch {
      return '';
    }
  }

  function protectedEnrichmentMessage(message = '') {
    const value = String(message || '');
    const source = /@[\w .()\-]{2,}|docs\.google\.com\/spreadsheets\/d\//i.test(value);
    const operation = /\b(?:enrich|enrichment|fill|populate|complete|repair|update|poc|apollo)\b/i.test(value);
    return source && operation;
  }

  function requestId() {
    try { if (globalThis.crypto?.randomUUID) return `enrich:${globalThis.crypto.randomUUID()}`; } catch {}
    return `enrich:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 12)}`;
  }

  function protectEnrichmentRequest(init = {}) {
    if (!init.body) return { init, protectedRequest: false, requestId: '' };
    try {
      const parsed = typeof init.body === 'string' ? JSON.parse(init.body) : { ...(init.body || {}) };
      if (!parsed || typeof parsed !== 'object' || !protectedEnrichmentMessage(parsed.message)) {
        return { init, protectedRequest: false, requestId: '' };
      }
      const id = String(parsed.requestId || '').trim() || requestId();
      const headers = new Headers(init.headers || {});
      headers.set('X-Ultron-Request-Id', id);
      return {
        protectedRequest: true,
        requestId: id,
        init: { ...init, headers, body: JSON.stringify({ ...parsed, requestId: id }) },
      };
    } catch {
      return { init, protectedRequest: false, requestId: '' };
    }
  }

  async function backendHealthy() {
    try {
      const response = await nativeFetch('/api/health', { cache: 'no-store' });
      if (!response.ok) return false;
      const data = await response.json();
      return data?.service === 'ULTRON Mark 3';
    } catch {
      return false;
    }
  }

  function networkFailure(error) {
    const message = String(error?.message || error || '');
    return error?.name === 'TypeError' || /failed to fetch|networkerror|load failed|connection/i.test(message);
  }

  function chatTimeoutFor(init = {}) {
    const message = requestMessage(init);
    const linkedinResearch = /\blinkedin\b/i.test(message)
      && /\b(?:find|get|search|research|source|collect|list|companies|company|jobs?|roles?|hiring|recruiters?|profiles?)\b/i.test(message);
    return linkedinResearch ? LINKEDIN_RESEARCH_TIMEOUT_MS : CHAT_TRANSPORT_TIMEOUT_MS;
  }

  // Transport preserves semantics. The backend owns command/artifact inference.
  function normalizeArtifactMessage(message) {
    return String(message || '').trim();
  }

  function normalizeArtifactRequest(init = {}) {
    if (!init.body) return init;
    try {
      const parsed = typeof init.body === 'string' ? JSON.parse(init.body) : { ...(init.body || {}) };
      if (!parsed || typeof parsed !== 'object' || !parsed.message) return init;
      const normalized = normalizeArtifactMessage(parsed.message);
      return { ...init, body: JSON.stringify({ ...parsed, message: normalized, resolvedMessage: normalized, originalMessage: parsed.originalMessage || parsed.message }) };
    } catch {
      return init;
    }
  }

  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    if (!/(?:^|\/)api\/chat(?:$|[?#])/.test(url)) return nativeFetch(input, init);

    const normalizedInit = normalizeArtifactRequest(init);
    const protectedRequest = protectEnrichmentRequest(normalizedInit);
    const transportInit = protectedRequest.init;
    lastChatInputMode = requestInputMode(transportInit);
    voiceSynthesisComplete = false;
    lastSpeakingSeenAt = 0;

    const controller = new AbortController();
    const next = { ...transportInit, signal: controller.signal };
    const timeoutMs = chatTimeoutFor(transportInit);
    const timeoutMinutes = Math.round(timeoutMs / 60000);
    const timer = setTimeout(() => {
      controller.abort(new Error(`ULTRON chat transport exceeded ${timeoutMinutes} minutes.`));
    }, timeoutMs);

    const runAttempt = () => nativeFetch(input, next);
    const runProtected = async () => {
      try {
        return await runAttempt();
      } catch (error) {
        if (!protectedRequest.protectedRequest || !networkFailure(error) || controller.signal.aborted) throw error;
        for (const delay of ENRICHMENT_RECONNECT_DELAYS_MS) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (controller.signal.aborted) throw error;
          if (!(await backendHealthy())) continue;
          try {
            return await runAttempt();
          } catch (retryError) {
            if (!networkFailure(retryError)) throw retryError;
          }
        }
        const safe = new Error('ULTRON backend disconnected during protected enrichment. The request was not restarted with a new identity, so duplicate Apollo calls and spreadsheet writes were blocked. Restart Mark 3, inspect the saved enrichment request/mission state, then continue only the still-missing cells.');
        safe.code = 'ENRICHMENT_TRANSPORT_DISCONNECTED';
        safe.requestId = protectedRequest.requestId;
        throw safe;
      }
    };

    return runProtected().then(async (response) => {
      try {
        const data = await response.clone().json();
        const explicitWindow = Math.max(0, Number(data?.listenAfterResponseMs || 0));
        const flowWindow = lastChatInputMode === 'voice' ? FLOW_REPLY_WINDOW_MS : 0;
        pendingReplyWindowMs = Math.max(explicitWindow, flowWindow);
        replyOpenDeadline = pendingReplyWindowMs ? Date.now() + Math.max(REPLY_OPEN_GRACE_MS, pendingReplyWindowMs + 8000) : 0;
        if (data?.operatingMode) setModeChip(data.operatingMode);

        // If audio is muted there is no TTS lifecycle to wait for. Otherwise the
        // SSE voice_completed/voice_error events below decide when flow can open.
        if (pendingReplyWindowMs && !audioEnabled()) scheduleReplyWindow(250);
      } catch {}
      return response;
    }).finally(() => clearTimeout(timer));
  };

  window.addEventListener('DOMContentLoaded', () => {
    void refreshMode();
    const events = new EventSource('/api/events');
    events.addEventListener('voice_started', () => {
      voiceSynthesisComplete = false;
      lastSpeakingSeenAt = Date.now();
    });
    events.addEventListener('voice_ready', () => {
      lastSpeakingSeenAt = Date.now();
    });
    events.addEventListener('voice_completed', () => {
      voiceSynthesisComplete = true;
      scheduleReplyWindow(180);
    });
    events.addEventListener('voice_error', () => {
      voiceSynthesisComplete = true;
      scheduleReplyWindow(300);
    });
    events.addEventListener('task_completed', () => {
      if (!audioEnabled()) scheduleReplyWindow(180);
    });
    events.addEventListener('mode_changed', (event) => {
      try { setModeChip(JSON.parse(event.data)); } catch {}
    });

    // Track browser playback state independently from server-side synthesis.
    const wrap = document.querySelector('.globe-wrap');
    if (wrap) {
      const observer = new MutationObserver(() => {
        if (wrap.classList.contains('speaking')) lastSpeakingSeenAt = Date.now();
        else if (voiceSynthesisComplete && pendingReplyWindowMs) scheduleReplyWindow(PLAYBACK_SETTLE_MS);
      });
      observer.observe(wrap, { attributes: true, attributeFilter: ['class'] });
    }

    const shortcut = document.querySelector('.voice-shortcut');
    if (shortcut) shortcut.textContent = 'Fuzzy wake · native audio command · 10 sec conversational flow';
  });

  window.__ULTRON_CHAT_TRANSPORT_TIMEOUT_MS = CHAT_TRANSPORT_TIMEOUT_MS;
  window.__ULTRON_LINKEDIN_RESEARCH_TIMEOUT_MS = LINKEDIN_RESEARCH_TIMEOUT_MS;
  window.__ULTRON_CHAT_TIMEOUT_FOR = chatTimeoutFor;
  window.__ULTRON_MIN_REPLY_WINDOW_MS = MIN_REPLY_WINDOW_MS;
  window.__ULTRON_FLOW_REPLY_WINDOW_MS = FLOW_REPLY_WINDOW_MS;
  window.__ULTRON_PLAYBACK_SETTLE_MS = PLAYBACK_SETTLE_MS;
  window.__ULTRON_NORMALIZE_ARTIFACT_MESSAGE = normalizeArtifactMessage;
  window.__ULTRON_PROTECTED_ENRICHMENT_MESSAGE = protectedEnrichmentMessage;
  window.__ULTRON_ENRICHMENT_RECONNECT_DELAYS_MS = ENRICHMENT_RECONNECT_DELAYS_MS;
})();
