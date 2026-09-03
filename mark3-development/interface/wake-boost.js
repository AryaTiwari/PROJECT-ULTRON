(() => {
  const NativeRecognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  if (!NativeRecognition) return;

  const TARGET = 'ultron';
  const PHRASE_ALIASES = [
    /\bultra\s+on\b/gi,
    /\bultra\s+one\b/gi,
    /\ball\s+tron\b/gi,
    /\bold\s+tron\b/gi,
    /\bulter\s+on\b/gi,
  ];
  const DIRECT_ALIASES = new Set(['ultron', 'ultran', 'ultrone', 'altron', 'oltron', 'ultrun', 'ultronn']);

  function cleanToken(value) {
    return String(value || '').toLowerCase().replace(/[^a-z]/g, '');
  }

  function distance(a, b) {
    const left = cleanToken(a);
    const right = cleanToken(b);
    if (!left) return right.length;
    if (!right) return left.length;
    const prev = Array.from({ length: right.length + 1 }, (_, i) => i);
    for (let i = 1; i <= left.length; i += 1) {
      let diagonal = prev[0];
      prev[0] = i;
      for (let j = 1; j <= right.length; j += 1) {
        const old = prev[j];
        const cost = left[i - 1] === right[j - 1] ? 0 : 1;
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + cost);
        diagonal = old;
      }
    }
    return prev[right.length];
  }

  function wakeLike(token) {
    const value = cleanToken(token);
    if (!value || value.length < 4 || value.length > 9) return false;
    if (DIRECT_ALIASES.has(value)) return true;
    return distance(value, TARGET) <= (value.length >= 6 ? 2 : 1);
  }

  function normalizeWakeTranscript(transcript) {
    let text = String(transcript || '').trim();
    if (!text) return text;
    for (const pattern of PHRASE_ALIASES) text = text.replace(pattern, TARGET);
    const words = text.split(/\s+/);
    let replaced = false;
    return words.map((word) => {
      if (!replaced && wakeLike(word)) {
        replaced = true;
        const punctuation = String(word).match(/[^a-zA-Z]+$/)?.[0] || '';
        return `${TARGET}${punctuation}`;
      }
      return word;
    }).join(' ');
  }

  function isWakeListening() {
    return Boolean(document.querySelector('.globe-wrap.wake-listening'));
  }

  function enhanceResults(results) {
    const wakeMode = isWakeListening();
    const output = [];
    for (let i = 0; i < results.length; i += 1) {
      const source = results[i];
      const alternatives = [];
      for (let j = 0; j < source.length; j += 1) {
        const alt = source[j];
        const raw = String(alt?.transcript || '').trim();
        alternatives.push({
          // Fuzzy normalization is deliberately wake-only. Once Sir is issuing a
          // command, preserve Chrome's raw transcript instead of rewriting words
          // that merely resemble “Ultron”.
          transcript: wakeMode ? normalizeWakeTranscript(raw) : raw,
          confidence: Number(alt?.confidence || 0),
        });
      }
      alternatives.sort((a, b) => {
        if (wakeMode) {
          const aWake = /\bultron\b/i.test(a.transcript) ? 1 : 0;
          const bWake = /\bultron\b/i.test(b.transcript) ? 1 : 0;
          return bWake - aWake || b.confidence - a.confidence;
        }
        // In command mode use recognition confidence only. Do not bias toward
        // wake-like words; the user is already inside the command session.
        return b.confidence - a.confidence;
      });
      alternatives.isFinal = Boolean(source.isFinal);
      output[i] = alternatives;
    }
    return output;
  }

  function EnhancedRecognition() {
    const native = new NativeRecognition();
    return new Proxy(native, {
      get(target, prop) {
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, prop, value) {
        if (prop === 'maxAlternatives') {
          try { target.maxAlternatives = Math.max(5, Number(value) || 1); } catch {}
          return true;
        }
        if (prop === 'lang') {
          // Arya speaks Indian English. Chrome is noticeably more reliable with
          // the matching locale than a browser-default en-US profile.
          try { target.lang = /^en(?:-|$)/i.test(String(value || '')) ? 'en-IN' : value; } catch {}
          return true;
        }
        if (prop === 'onresult' && typeof value === 'function') {
          target.onresult = (event) => value({
            resultIndex: event.resultIndex,
            results: enhanceResults(event.results),
            type: event.type,
            timeStamp: event.timeStamp,
          });
          return true;
        }
        try { target[prop] = value; } catch {}
        return true;
      },
    });
  }

  try { EnhancedRecognition.prototype = NativeRecognition.prototype; } catch {}
  window.SpeechRecognition = EnhancedRecognition;
  window.webkitSpeechRecognition = EnhancedRecognition;
  window.__ULTRON_WAKE_BOOST = {
    enabled: true,
    alternatives: 5,
    fuzzyDistance: 2,
    commandTranscript: 'raw-confidence-ranked',
    locale: 'en-IN',
    prematureFastFinalize: false,
    normalizeTranscript: normalizeWakeTranscript,
  };
})();
