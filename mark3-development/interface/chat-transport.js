(() => {
  const nativeFetch = window.fetch.bind(window);
  const CHAT_TRANSPORT_TIMEOUT_MS = 10 * 60 * 1000;
  const MIN_REPLY_WINDOW_MS = 7000;
  const REPLY_OPEN_GRACE_MS = 12000;
  let pendingReplyWindowMs = 0;
  let replyOpenDeadline = 0;
  let replyTimer = null;

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
      setTimeout(openReplyWindow, 250);
      return;
    }

    pendingReplyWindowMs = 0;
    replyOpenDeadline = 0;
    clearReplyTimer();
    if (!commandListening()) orb.click();

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

  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    if (!/(?:^|\/)api\/chat(?:$|[?#])/.test(url)) return nativeFetch(input, init);

    // app.js has a legacy 120-second AbortController. Ignore that signal for
    // /api/chat and let Mark 3 / OmniRoute / Cortex enforce their own task-level
    // timeouts. Keep one larger transport ceiling so a broken connection cannot
    // wait forever.
    const controller = new AbortController();
    const next = { ...init, signal: controller.signal };
    const timer = setTimeout(() => {
      controller.abort(new Error('ULTRON chat transport exceeded 10 minutes.'));
    }, CHAT_TRANSPORT_TIMEOUT_MS);

    return nativeFetch(input, next).then(async (response) => {
      try {
        const data = await response.clone().json();
        pendingReplyWindowMs = Math.max(0, Number(data?.listenAfterResponseMs || 0));
        replyOpenDeadline = pendingReplyWindowMs ? Date.now() + Math.max(REPLY_OPEN_GRACE_MS, pendingReplyWindowMs + 5000) : 0;
        // Event-driven voice_completed is the normal path. This delayed attempt
        // covers extremely fast TTS, muted audio, or an event arriving just
        // before the HTTP response exposes listenAfterResponseMs.
        if (pendingReplyWindowMs) scheduleReplyWindow(audioEnabled() ? 1200 : 350);
      } catch {}
      return response;
    }).finally(() => clearTimeout(timer));
  };

  // The main interface owns speech recognition. This lightweight observer only
  // asks it to enter command mode after ULTRON has finished speaking a response
  // that explicitly invites a reply. No extra wake word is needed for 7 seconds.
  window.addEventListener('DOMContentLoaded', () => {
    const events = new EventSource('/api/events');
    events.addEventListener('voice_completed', () => scheduleReplyWindow(300));
    events.addEventListener('voice_error', () => scheduleReplyWindow(350));
    events.addEventListener('task_completed', () => {
      if (!audioEnabled()) scheduleReplyWindow(250);
    });

    const shortcut = document.querySelector('.voice-shortcut');
    if (shortcut && !/7 sec direct reply/i.test(String(shortcut.textContent || ''))) {
      shortcut.textContent = `${String(shortcut.textContent || '').trim()} · 7 sec direct reply after questions`;
    }
  });

  window.__ULTRON_CHAT_TRANSPORT_TIMEOUT_MS = CHAT_TRANSPORT_TIMEOUT_MS;
  window.__ULTRON_MIN_REPLY_WINDOW_MS = MIN_REPLY_WINDOW_MS;
})();
