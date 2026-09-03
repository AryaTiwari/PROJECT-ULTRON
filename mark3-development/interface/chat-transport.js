(() => {
  const nativeFetch = window.fetch.bind(window);
  const CHAT_TRANSPORT_TIMEOUT_MS = 10 * 60 * 1000;
  const MIN_REPLY_WINDOW_MS = 7000;
  const FLOW_REPLY_WINDOW_MS = 8000;
  const REPLY_OPEN_GRACE_MS = 12000;
  let pendingReplyWindowMs = 0;
  let replyOpenDeadline = 0;
  let replyTimer = null;
  let lastChatInputMode = 'chat';

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

  function expirePendingReply() {
    pendingReplyWindowMs = 0;
    replyOpenDeadline = 0;
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

    const orb = document.querySelector('#voiceOrb');
    const status = String(document.querySelector('#statusText')?.textContent || '');
    if (!orb || orb.disabled || /SPEAKING|THINKING|ROUTING|GENERATING/i.test(status)) {
      setTimeout(openReplyWindow, 220);
      return;
    }

    pendingReplyWindowMs = 0;
    replyOpenDeadline = 0;
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
    if (!replyOpenDeadline) replyOpenDeadline = Date.now() + Math.max(REPLY_OPEN_GRACE_MS, pendingReplyWindowMs + 5000);
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

    // app.js still owns a legacy 120-second controller. Ignore that signal for
    // /api/chat and let Mark 3 / direct providers / Cortex enforce task-level
    // timeouts. Keep one larger transport ceiling so a dead connection cannot
    // wait forever.
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
        replyOpenDeadline = pendingReplyWindowMs ? Date.now() + Math.max(REPLY_OPEN_GRACE_MS, pendingReplyWindowMs + 5000) : 0;
        if (data?.operatingMode) setModeChip(data.operatingMode);
        // Event-driven voice_completed is preferred; delayed opening covers very
        // fast TTS, muted audio, or an event arriving before HTTP completion.
        if (pendingReplyWindowMs) scheduleReplyWindow(audioEnabled() ? 1100 : 300);
      } catch {}
      return response;
    }).finally(() => clearTimeout(timer));
  };

  window.addEventListener('DOMContentLoaded', () => {
    void refreshMode();
    const events = new EventSource('/api/events');
    events.addEventListener('voice_completed', () => scheduleReplyWindow(220));
    events.addEventListener('voice_error', () => scheduleReplyWindow(280));
    events.addEventListener('task_completed', () => {
      if (!audioEnabled()) scheduleReplyWindow(200);
    });
    events.addEventListener('mode_changed', (event) => {
      try { setModeChip(JSON.parse(event.data)); } catch {}
    });

    const shortcut = document.querySelector('.voice-shortcut');
    if (shortcut) shortcut.textContent = 'Fuzzy wake · 8 sec conversational flow · Ctrl + Space';
  });

  window.__ULTRON_CHAT_TRANSPORT_TIMEOUT_MS = CHAT_TRANSPORT_TIMEOUT_MS;
  window.__ULTRON_MIN_REPLY_WINDOW_MS = MIN_REPLY_WINDOW_MS;
  window.__ULTRON_FLOW_REPLY_WINDOW_MS = FLOW_REPLY_WINDOW_MS;
})();
