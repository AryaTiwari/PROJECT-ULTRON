(() => {
  const baseFetch = window.fetch.bind(window);
  const supported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  const state = {
    enabled: supported && localStorage.getItem('ultron-m3-native-voice') !== '0',
    stream: null,
    recorder: null,
    preRoll: [],
    commandChunks: [],
    commandActive: false,
    suppressPreRoll: false,
    ready: false,
    starting: null,
    mime: 'audio/webm',
  };

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  async function ensureRecorder() {
    if (!state.enabled || !supported) return false;
    if (state.ready && state.recorder?.state !== 'inactive') return true;
    if (state.starting) return state.starting;
    state.starting = (async () => {
      try {
        state.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
        const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
        const mimeType = preferred.find((value) => MediaRecorder.isTypeSupported?.(value)) || '';
        state.mime = mimeType || 'audio/webm';
        state.recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
        state.recorder.ondataavailable = (event) => {
          if (!event.data || !event.data.size) return;
          if (state.commandActive) state.commandChunks.push(event.data);
          else if (!state.suppressPreRoll) {
            state.preRoll.push(event.data);
            while (state.preRoll.length > 3) state.preRoll.shift();
          }
        };
        state.recorder.start(800);
        state.ready = true;
        updateButton();
        return true;
      } catch {
        state.ready = false;
        updateButton();
        return false;
      } finally { state.starting = null; }
    })();
    return state.starting;
  }

  function beginCommand() {
    if (!state.enabled || !state.ready || state.commandActive || state.suppressPreRoll) return;
    state.commandActive = true;
    state.commandChunks = [...state.preRoll];
    state.preRoll = [];
  }

  async function captureCommand() {
    if (!state.enabled || !state.ready || !state.recorder || !state.commandActive) return null;
    try { state.recorder.requestData(); } catch {}
    await sleep(180);
    const chunks = [...state.commandChunks];
    state.commandActive = false;
    state.commandChunks = [];
    if (!chunks.length) return null;
    const blob = new Blob(chunks, { type: state.mime || chunks[0]?.type || 'audio/webm' });
    return blob.size >= 900 ? blob : null;
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

  async function transcribe(blob, browserTranscript) {
    const audioBase64 = await base64(blob);
    const response = await baseFetch('/api/voice/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `ultron-command-${Date.now()}.webm`,
        mime: blob.type || state.mime || 'audio/webm',
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
      parsed.browserTranscript = parsed.message;
      parsed.message = recognized.text;
      parsed.voiceRecognition = { provider: recognized.provider, model: recognized.model, nativeAudio: true };
      updateVisibleTranscript(recognized.text, recognized.provider);
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
    button.title = state.enabled ? 'Recorded audio is authoritative; browser speech recognition is fallback only.' : 'Use browser speech recognition only.';
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
        updateButton();
      });
      updateButton();
    }

    const wrap = document.querySelector('.globe-wrap');
    if (wrap) {
      const observer = new MutationObserver(() => {
        const speaking = wrap.classList.contains('speaking');
        if (speaking) {
          // Do not feed ULTRON's own synthesized speech into the next command's
          // rolling pre-roll. Echo cancellation is helpful, but provenance is better.
          state.suppressPreRoll = true;
          state.preRoll = [];
          return;
        }
        if (state.suppressPreRoll) {
          state.suppressPreRoll = false;
          state.preRoll = [];
        }
        if (wrap.classList.contains('command-listening')) {
          void ensureRecorder().then((ok) => { if (ok) beginCommand(); });
        }
      });
      observer.observe(wrap, { attributes: true, attributeFilter: ['class'] });
    }

    // If the browser has already granted microphone permission, start the rolling
    // audio buffer immediately without showing another prompt. Otherwise the first
    // normal user gesture/wake interaction starts it and the browser transcript is
    // still available as a fallback for that turn.
    void warmIfAlreadyGranted();
    const warm = () => { if (state.enabled) void ensureRecorder(); };
    document.addEventListener('pointerdown', warm, { once: true, passive: true });
    document.addEventListener('keydown', warm, { once: true });
  });

  window.__ULTRON_NATIVE_VOICE = { state, ensureRecorder, beginCommand };
})();
