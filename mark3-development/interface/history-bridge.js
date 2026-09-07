(() => {
  const previousFetch = window.fetch.bind(window);
  let selectedHistory = null;
  let selectedSessionId = null;

  function isUrl(input, pattern) {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    return pattern.test(url);
  }

  function normalize(rows) {
    return (Array.isArray(rows) ? rows : [])
      .filter((row) => row && ['user', 'assistant'].includes(row.role) && String(row.content || '').trim())
      .slice(-24)
      .map((row) => ({ role: row.role, content: String(row.content), at: row.at || null, model: row.model || null }));
  }

  function updateIndicator() {
    const caption = document.querySelector('#voiceCaption');
    if (!caption || !selectedSessionId || !selectedHistory?.length) return;
    caption.textContent = 'Earlier thread is active. Your next message will continue from that thread.';
  }

  window.fetch = async (input, init = {}) => {
    if (isUrl(input, /\/api\/conversation\/history(?:$|[?#])/)) {
      const response = await previousFetch(input, init);
      selectedHistory = null;
      selectedSessionId = null;
      return response;
    }

    if (isUrl(input, /\/api\/conversation\/session(?:$|[?#])/)) {
      const response = await previousFetch(input, init);
      try {
        const data = await response.clone().json();
        if (response.ok && data?.ok && Array.isArray(data.messages)) {
          selectedHistory = normalize(data.messages);
          selectedSessionId = String(data.id || 'restored-thread');
          updateIndicator();
        }
      } catch {}
      return response;
    }

    if (isUrl(input, /\/api\/chat(?:$|[?#])/) && selectedHistory?.length && init?.body) {
      try {
        const payload = typeof init.body === 'string' ? JSON.parse(init.body) : { ...(init.body || {}) };
        if (payload && typeof payload === 'object') {
          return previousFetch(input, {
            ...init,
            body: JSON.stringify({ ...payload, history: selectedHistory, continuedSessionId: selectedSessionId }),
          });
        }
      } catch {}
    }

    return previousFetch(input, init);
  };

  window.__ULTRON_CLEAR_RESTORED_THREAD = () => {
    selectedHistory = null;
    selectedSessionId = null;
  };
})();
