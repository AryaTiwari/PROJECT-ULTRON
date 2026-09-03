(() => {
  const nativeFetch = window.fetch.bind(window);
  const CHAT_TRANSPORT_TIMEOUT_MS = 10 * 60 * 1000;

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

    return nativeFetch(input, next).finally(() => clearTimeout(timer));
  };

  window.__ULTRON_CHAT_TRANSPORT_TIMEOUT_MS = CHAT_TRANSPORT_TIMEOUT_MS;
})();
