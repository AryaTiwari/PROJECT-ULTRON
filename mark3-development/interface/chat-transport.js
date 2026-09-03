(() => {
  const nativeFetch = window.fetch.bind(window);
  const CHAT_TRANSPORT_TIMEOUT_MS = 10 * 60 * 1000;
  const MIN_REPLY_WINDOW_MS = 7000;
  const FLOW_REPLY_WINDOW_MS = 8000;
  const REPLY_OPEN_GRACE_MS = 16000;
  const PLAYBACK_SETTLE_MS = 700;
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

  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    if (!/(?:^|\/)api\/chat(?:$|[?#])/.test(url)) return nativeFetch(input, init);

    lastChatInputMode = requestInputMode(init);
    voiceSynthesisComplete = false;
    lastSpeakingSeenAt = 0;

    const controller = new AbortController();
    const next = { ...init, signal: controller.signal };
    const timer = setTimeout(() => {
      controller.abort(new Error('ULTRON chat transport exceeded 10 minutes.'));
    }, CHAT_TRANSPORT_TIMEOUT_MS);

    return nativeFetch(input, next).then(async (response) => {
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
    if (shortcut) shortcut.textContent = 'Fuzzy wake · patient speech capture · 8 sec conversational flow';
  });

  window.__ULTRON_CHAT_TRANSPORT_TIMEOUT_MS = CHAT_TRANSPORT_TIMEOUT_MS;
  window.__ULTRON_MIN_REPLY_WINDOW_MS = MIN_REPLY_WINDOW_MS;
  window.__ULTRON_FLOW_REPLY_WINDOW_MS = FLOW_REPLY_WINDOW_MS;
  window.__ULTRON_PLAYBACK_SETTLE_MS = PLAYBACK_SETTLE_MS;
})();
