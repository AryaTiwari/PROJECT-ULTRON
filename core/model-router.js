const { config } = require('./config');

function headers() {
  const base = { 'Content-Type': 'application/json' };
  if (config.router.apiKey) base.Authorization = `Bearer ${config.router.apiKey}`;
  return base;
}

async function chat({ messages, model } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Model request requires messages.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.router.timeoutMs);
  try {
    const response = await fetch(config.router.endpoint, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ model: model || config.router.model, messages }),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }

    if (!response.ok) throw new Error(`OmniRoute HTTP ${response.status}: ${raw.slice(0, 800)}`);

    const content = data?.choices?.[0]?.message?.content
      ?? data?.choices?.[0]?.text
      ?? data?.output_text
      ?? data?.response
      ?? '';

    if (!String(content).trim()) throw new Error('OmniRoute returned no response text.');
    return { content: String(content), model: data?.model || model || config.router.model, raw: data };
  } finally {
    clearTimeout(timeout);
  }
}

async function health() {
  try {
    const response = await fetch(config.router.endpoint.replace(/\/chat\/completions$/, '/models'), {
      headers: config.router.apiKey ? { Authorization: `Bearer ${config.router.apiKey}` } : {},
    });
    return { ok: response.ok || response.status === 401, status: response.status };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = { chat, health };
