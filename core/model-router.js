const DEFAULT_OMNIROUTE_URL = 'http://127.0.0.1:20128/v1/chat/completions';

function getConfig() {
  return {
    endpoint: process.env.OMNIROUTE_CHAT_URL || DEFAULT_OMNIROUTE_URL,
    model: process.env.ULTRON_MODEL || 'auto',
    timeoutMs: Number(process.env.ULTRON_MODEL_TIMEOUT_MS || 120000),
  };
}

function extractContent(data) {
  return data?.choices?.[0]?.message?.content
    ?? data?.choices?.[0]?.text
    ?? data?.output_text
    ?? data?.response
    ?? '';
}

async function chat({ messages, model } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError('Model router requires a non-empty messages array.');
  }

  const config = getConfig();
  const selectedModel = model || config.model;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    let response;
    try {
      response = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: selectedModel, messages }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`Model gateway timed out after ${config.timeoutMs}ms.`);
      }
      throw new Error(`Could not reach model gateway at ${config.endpoint}: ${error?.message || error}`);
    }

    const raw = await response.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { raw };
    }

    if (!response.ok) {
      throw new Error(`Model gateway returned HTTP ${response.status}: ${raw.slice(0, 800)}`);
    }

    const content = extractContent(data);
    if (!String(content).trim()) {
      throw new Error('Model gateway returned no response text.');
    }

    return {
      content: String(content),
      model: data?.model || selectedModel,
      provider: data?.provider || 'omniroute',
      raw: data,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chat, getConfig, extractContent };
