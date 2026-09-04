(() => {
  const baseFetch = window.fetch.bind(window);
  const supported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  const state = {
    enabled: supported && localStorage.getItem('ultron-m3-native-voice') !== '0',
    stream: null,
    recorder: null,
    commandChunks: [],
    commandActive: false,
    suppressCapture: false,
    ready: false,
    starting: null,
    mime: 'audio/webm',
  };

  function streamLive() {
    return Boolean(state.stream?.getAudioTracks?.().some((track) => track.readyState === 'live'));
  }

  function preferredMime() {
    const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
    return preferred.find((value) => MediaRecorder.isTypeSupported?.(value)) || '';
  }

  function audioExtension(mime) {
    return /^audio\/ogg/i.test(String(mime || '')) ? 'ogg' : 'webm';
  }

  async function ensureRecorder() {
    if (!state.enabled || !supported) return false;
    if (state.ready && streamLive()) return true;
    if (state.starting) return state.starting;
    state.starting = (async () => {
      try {
        state.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
        state.mime = preferredMime() || 'audio/webm';
        state.ready = streamLive();
        updateButton();
        return state.ready;
      } catch {
        state.ready = false;
        updateButton();
        return false;
      } finally { state.starting = null; }
    })();
    return state.starting;
  }

  function beginCommand() {
    if (!state.enabled || !state.ready || !streamLive() || state.commandActive || state.suppressCapture) return;
    const mimeType = preferredMime();
    state.mime = mimeType || 'audio/webm';
    state.commandChunks = [];
    try {
      const recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
      state.recorder = recorder;
      state.commandActive = true;
      recorder.ondataavailable = (event) => {
        if (state.commandActive && event.data?.size) state.commandChunks.push(event.data);
      };
      recorder.onerror = () => {
        state.commandActive = false;
        state.commandChunks = [];
      };
      // A fresh recorder per command guarantees the Blob starts with a valid
      // WebM/Ogg container header. Rolling timeslice fragments are not standalone
      // media files and can be rejected by Whisper/Groq when the first chunks are dropped.
      recorder.start();
    } catch {
      state.recorder = null;
      state.commandActive = false;
      state.commandChunks = [];
    }
  }

  async function captureCommand() {
    if (!state.enabled || !state.ready || !state.recorder || !state.commandActive) return null;
    const recorder = state.recorder;
    if (recorder.state === 'inactive') {
      state.commandActive = false;
      state.recorder = null;
      state.commandChunks = [];
      return null;
    }

    await new Promise((resolve) => {
      const finish = () => resolve();
      recorder.addEventListener('stop', finish, { once: true });
      recorder.addEventListener('error', finish, { once: true });
      try { recorder.stop(); } catch { resolve(); }
    });

    const chunks = [...state.commandChunks];
    const mime = recorder.mimeType || state.mime || chunks[0]?.type || 'audio/webm';
    state.commandActive = false;
    state.recorder = null;
    state.commandChunks = [];
    if (!chunks.length) return null;
    const blob = new Blob(chunks, { type: mime });
    return blob.size >= 900 ? blob : null;
  }

  function discardCommand() {
    const recorder = state.recorder;
    state.commandActive = false;
    state.commandChunks = [];
    state.recorder = null;
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch {}
    }
  }

  function base64(blob) {
    return blob.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const step = 0x8000;
      for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
      return btoa(binary);
    });
  }

  function transcriptTokens(text) {
    let value = String(text || '').normalize('NFKC').toLowerCase().trim();
    value = value
      .replace(/^(?:hello|hey|hi|good\s+(?:morning|afternoon|evening))\b[\s,:;.!-]*/i, '')
      .replace(/^(?:ultron|ultran|altron|oltron|ultra\s+on)\b[\s,:;.!-]*/i, '');
    return value.match(/[a-z0-9]+(?:'[a-z0-9]+)?/g) || [];
  }

  function commonPrefixCount(a, b) {
    const limit = Math.min(a.length, b.length);
    let count = 0;
    while (count < limit && a[count] === b[count]) count += 1;
    return count;
  }

  function reconcileTranscripts(nativeText, browserText) {
    const native = String(nativeText || '').trim();
    const browser = String(browserText || '').trim();
    if (!native) return { text: browser, source: 'browser-only', trimmed: false };
    if (!browser) return { text: native, source: 'native-only', trimmed: false };

    const nativeTokens = transcriptTokens(native);
    const browserTokens = transcriptTokens(browser);
    const shorterLength = Math.min(nativeTokens.length, browserTokens.length);
    const prefix = commonPrefixCount(nativeTokens, browserTokens);
    const coverage = shorterLength ? prefix / shorterLength : 0;
    const extraWords = Math.abs(nativeTokens.length - browserTokens.length);

    // Two independent recognizers strongly agree on the utterance, but one keeps
    // listening and appends unrelated trailing speech/noise. Prefer the shorter
    // agreed transcript instead of feeding unsupported words into ULTRON.
    if (shorterLength >= 4 && coverage >= 0.8 && extraWords >= 3) {
      const nativeIsShorter = nativeTokens.length <= browserTokens.length;
      return {
        text: nativeIsShorter ? native : browser,
        source: 'dual-transcript-trim',
        trimmed: true,
        nativeWords: nativeTokens.length,
        browserWords: browserTokens.length,
        agreement: Number(coverage.toFixed(2)),
      };
    }

    return {
      text: native,
      source: 'native-authoritative',
      trimmed: false,
      nativeWords: nativeTokens.length,
      browserWords: browserTokens.length,
      agreement: Number(coverage.toFixed(2)),
    };
  }

  function updateVisibleTranscript(text, provider) {
    const messages = document.querySelectorAll('#messages .msg.user');
    const last = messages[messages.length - 1];
    if (last) last.textContent = text;
    const interim = document.querySelector('#voiceInterim');
    if (interim) interim.textContent = text;
    const caption = document.querySelector('#voiceCaption');
    if (caption) caption.textContent = `YOU · ${text}`;
    const activity = document.querySelector('#activityList');
    if (activity && provider) {
      const row = document.createElement('div');
      row.className = 'event';
      row.innerHTML = `<div class="event-state">native voice</div><div class="event-label">Audio transcript confirmed</div><div class="event-tool">${provider}</div>`;
      activity.prepend(row);
      while (activity.children.length > 10) activity.lastElementChild?.remove();
    }
  }

  function logTranscriptTrim(result) {
    if (!result?.trimmed) return;
    const activity = document.querySelector('#activityList');
    if (!activity) return;
    const row = document.createElement('div');
    row.className = 'event';
    row.innerHTML = `<div class="event-state">voice guard</div><div class="event-label">Unsupported trailing transcript removed</div><div class="event-tool">dual transcript agreement ${Math.round((result.agreement || 0) * 100)}%</div>`;
    activity.prepend(row);
    while (activity.children.length > 10) activity.lastElementChild?.remove();
  }

  async function transcribe(blob, browserTranscript) {
    const audioBase64 = await base64(blob);
    const mime = blob.type || state.mime || 'audio/webm';
    const response = await baseFetch('/api/voice/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `ultron-command-${Date.now()}.${audioExtension(mime)}`,
        mime,
        audioBase64,
        browserTranscript: String(browserTranscript || ''),
      }),
    });
    const data = await response.json();
    if (!response.ok || !data?.ok || !String(data.text || '').trim()) throw new Error(data?.error || 'Native transcription failed.');
    return data;
  }

  function requestIsVoice(init = {}) {
    try {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
      return String(body?.inputMode || '').toLowerCase() === 'voice';
    } catch { return false; }
  }

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    if (!/(?:^|\/)api\/chat(?:$|[?#])/.test(url) || !state.enabled || !requestIsVoice(init)) return baseFetch(input, init);

    let parsed = null;
    try { parsed = typeof init.body === 'string' ? JSON.parse(init.body) : { ...(init.body || {}) }; } catch {}
    if (!parsed) return baseFetch(input, init);

    const blob = await captureCommand();
    if (!blob) return baseFetch(input, init);
    try {
      const recognized = await transcribe(blob, parsed.message);
      const reconciled = reconcileTranscripts(recognized.text, parsed.message);
      parsed.browserTranscript = parsed.message;
      parsed.message = reconciled.text;
      parsed.voiceRecognition = {
        provider: recognized.provider,
        model: recognized.model,
        nativeAudio: true,
        transcriptSource: reconciled.source,
        transcriptTrimmed: Boolean(reconciled.trimmed),
        agreement: reconciled.agreement ?? null,
      };
      logTranscriptTrim(reconciled);
      updateVisibleTranscript(reconciled.text, recognized.provider);
      return baseFetch(input, { ...init, body: JSON.stringify(parsed) });
    } catch (error) {
      const activity = document.querySelector('#activityList');
      if (activity) {
        const row = document.createElement('div');
        row.className = 'event';
        row.innerHTML = `<div class="event-state">voice fallback</div><div class="event-label">${String(error.message || 'Native recognition unavailable')}</div><div class="event-tool">browser transcript</div>`;
        activity.prepend(row);
      }
      return baseFetch(input, init);
    }
  };

  function updateButton() {
    const button = document.querySelector('#nativeVoiceToggle');
    if (!button) return;
    button.classList.toggle('active', state.enabled);
    button.textContent = state.enabled ? (state.ready ? 'VOICE AI ON' : 'VOICE AI') : 'VOICE AI OFF';
    button.title = state.enabled ? 'Recorded audio is authoritative; browser speech recognition cross-checks unsupported trailing words.' : 'Use browser speech recognition only.';
  }

  async function warmIfAlreadyGranted() {
    if (!state.enabled || !navigator.permissions?.query) return;
    try {
      const permission = await navigator.permissions.query({ name: 'microphone' });
      if (permission.state === 'granted') await ensureRecorder();
      permission.addEventListener?.('change', () => {
        if (state.enabled && permission.state === 'granted') void ensureRecorder();
      });
    } catch {}
  }

  window.addEventListener('DOMContentLoaded', () => {
    const top = document.querySelector('.top-actions');
    if (top) {
      const button = document.createElement('button');
      button.id = 'nativeVoiceToggle';
      button.type = 'button';
      button.className = 'native-voice-button';
      button.textContent = 'VOICE AI';
      const wake = document.querySelector('#wakeToggle');
      top.insertBefore(button, wake || top.firstChild);
      button.addEventListener('click', async () => {
        state.enabled = !state.enabled;
        localStorage.setItem('ultron-m3-native-voice', state.enabled ? '1' : '0');
        if (state.enabled) await ensureRecorder();
        else discardCommand();
        updateButton();
      });
      updateButton();
    }

    const wrap = document.querySelector('.globe-wrap');
    if (wrap) {
      const observer = new MutationObserver(() => {
        const speaking = wrap.classList.contains('speaking');
        if (speaking) {
          // Never feed ULTRON's own synthesized speech into a user command.
          state.suppressCapture = true;
          discardCommand();
          return;
        }
        if (state.suppressCapture) state.suppressCapture = false;
        if (wrap.classList.contains('command-listening')) {
          void ensureRecorder().then((ok) => { if (ok) beginCommand(); });
        }
      });
      observer.observe(wrap, { attributes: true, attributeFilter: ['class'] });
    }

    // Keep only the microphone stream warm. A fresh MediaRecorder is created for
    // each command so every uploaded file is a complete valid media container.
    void warmIfAlreadyGranted();
    const warm = () => { if (state.enabled) void ensureRecorder(); };
    document.addEventListener('pointerdown', warm, { once: true, passive: true });
    document.addEventListener('keydown', warm, { once: true });
  });

  window.__ULTRON_NATIVE_VOICE = { state, ensureRecorder, beginCommand, captureCommand, reconcileTranscripts };
})();
