const DEFAULT_OMNIROUTE_URL = 'http://127.0.0.1:20128/v1/chat/completions';

function getConfig() {
  return {
    endpoint: process.env.OMNIROUTE_CHAT_URL || DEFAULT_OMNIROUTE_URL,
    model: process.env.ULTRON_MODEL || 'auto',
    timeoutMs: Number(process.env.ULTRON_MODEL_TIMEOUT_MS || 120000),
  };
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Model request timed out.')), timeoutMs)),
  ]);
}

async function chat({ messages, model } = {}) {
  const config = getConfig();
  const selectedModel = model || config.model;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await withTimeout(fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: selectedModel, messages }),
      signal: controller.signal,
    }), config.timeoutMs + 1000);

    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }

    if (!response.ok) {
      throw new Error(`Model gateway returned HTTP ${response.status}: ${raw.slice(0, 500)}`);
    }

    const content = data?.choices?.[0]?.message?.content
      ?? data?.choices?.[0]?.text
      ?? data?.output_text
      ?? data?.response
      ?? '';

    if (!String(content).trim()) throw new Error('Model gateway returned no response text.');

    return {
      content: String(content),
      model: data?.model || selectedModel,
      raw: data,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chat, getConfig };
