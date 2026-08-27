const { load: loadCredentials } = require('./credentials/local-store');

const PROVIDERS = {
  gemini: { key: 'GEMINI_API_KEY', family: 'gemini', defaultModel: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  openai: { key: 'OPENAI_API_KEY', family: 'openai', defaultModel: 'gpt-5.4-mini', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { key: 'ANTHROPIC_API_KEY', family: 'anthropic', defaultModel: 'claude-sonnet-4-5', baseUrl: 'https://api.anthropic.com/v1' },
  deepseek: { key: 'DEEPSEEK_API_KEY', family: 'openai-compatible', defaultModel: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' },
  groq: { key: 'GROQ_API_KEY', family: 'openai-compatible', defaultModel: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' },
  mistral: { key: 'MISTRAL_API_KEY', family: 'openai-compatible', defaultModel: 'mistral-small-latest', baseUrl: 'https://api.mistral.ai/v1' },
  xai: { key: 'XAI_API_KEY', family: 'openai-compatible', defaultModel: 'grok-4', baseUrl: 'https://api.x.ai/v1' },
  openrouter: { key: 'OPENROUTER_API_KEY', family: 'openai-compatible', defaultModel: 'openrouter/free', baseUrl: 'https://openrouter.ai/api/v1' },
  opencode: { key: 'OPENCODE_API_KEY', family: 'openai-compatible', defaultModel: 'glm-5', baseUrl: 'https://opencode.ai/zen/v1' },
  'opencode-go': { key: 'OPENCODE_GO_API_KEY', family: 'openai-compatible', defaultModel: 'kimi-k3', baseUrl: 'https://opencode.ai/zen/go/v1' },
};

function parseModel(model) {
  const value = String(model || 'auto').trim();
  if (!value || value === 'auto') return { provider: null, model: 'auto' };
  const slash = value.indexOf('/');
  if (slash < 0) return { provider: null, model: value };
  const provider = value.slice(0, slash).toLowerCase();
  return { provider, model: value.slice(slash + 1) };
}

function providerForModel(model) {
  const { provider } = parseModel(model);
  if (provider && PROVIDERS[provider]) return provider;
  const lower = String(model || '').toLowerCase();
  if (/^(gemini|models\/gemini|gg\/)/.test(lower)) return 'gemini';
  if (/^(gpt|o[134]|openai|oa\/)/.test(lower)) return 'openai';
  if (/^(claude|anthropic|cc\/)/.test(lower)) return 'anthropic';
  if (/^deepseek|^ds\//.test(lower)) return 'deepseek';
  if (/^llama|^qwen|^groq\//.test(lower)) return 'groq';
  if (/^mistral/.test(lower)) return 'mistral';
  if (/^grok|^xai\//.test(lower)) return 'xai';
  if (/^opencode-go\//.test(lower)) return 'opencode-go';
  if (/^opencode\//.test(lower)) return 'opencode';
  if (/^openrouter\//.test(lower)) return 'openrouter';
  return null;
}

async function credentials() {
  const out = {};
  for (const key of Object.keys(PROVIDERS)) out[key] = '';
  try {
    const stored = await loadCredentials();
    for (const [provider, cfg] of Object.entries(PROVIDERS)) {
      out[provider] = String(stored[cfg.key] || '').trim();
    }
    // Useful aliases.
    if (!out.gemini) out.gemini = String(stored.GOOGLE_API_KEY || '').trim();
    if (!out.anthropic) out.anthropic = String(stored.ANTHROPIC_API_KEY || '').trim();
    if (!out.openai) out.openai = String(stored.OPENAI_API_KEY || '').trim();
  } catch {}
  return out;
}

async function chooseAutoModel(requested = 'auto') {
  const creds = await credentials();
  const envAuto = String(process.env.ULTRON_DIRECT_DEFAULT_MODEL || '').trim();
  if (envAuto) {
    const p = providerForModel(envAuto);
    if (p && (creds[p] || p === 'opencode')) return envAuto;
  }
  // Prefer a configured quality provider, then broader multi-model aggregators.
  if (creds.gemini) return `gemini/${process.env.ULTRON_DIRECT_GEMINI_MODEL || PROVIDERS.gemini.defaultModel}`;
  if (creds.openai) return `openai/${PROVIDERS.openai.defaultModel}`;
  if (creds.anthropic) return `anthropic/${PROVIDERS.anthropic.defaultModel}`;
  if (creds.openrouter) return `openrouter/${PROVIDERS.openrouter.defaultModel}`;
  if (creds.opencode) return `opencode/${PROVIDERS.opencode.defaultModel}`;
  if (creds['opencode-go']) return `opencode-go/${PROVIDERS['opencode-go'].defaultModel}`;
  if (creds.deepseek) return `deepseek/${PROVIDERS.deepseek.defaultModel}`;
  if (creds.groq) return `groq/${PROVIDERS.groq.defaultModel}`;
  if (creds.mistral) return `mistral/${PROVIDERS.mistral.defaultModel}`;
  if (creds.xai) return `xai/${PROVIDERS.xai.defaultModel}`;
  throw new Error('No direct AI provider credential is configured. Add a provider key in ULTRON ACCESS.');
}

function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((m) => ({
    role: m.role === 'model' ? 'assistant' : m.role,
    content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
  }));
}

async function directChat({ messages, model = 'auto', tools = null } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Model request requires messages.');
  const resolved = model === 'auto' ? await chooseAutoModel(model) : model;
  const { provider: parsedProvider, model: parsedModel } = parseModel(resolved);
  const provider = parsedProvider && PROVIDERS[parsedProvider] ? parsedProvider : providerForModel(resolved);
  if (!provider || !PROVIDERS[provider]) throw new Error(`Unsupported direct model: ${resolved}`);

  const cfg = PROVIDERS[provider];
  const creds = await credentials();
  const apiKey = creds[provider];
  if (!apiKey && provider !== 'opencode') throw new Error(`Provider ${provider} is not configured locally.`);

  const cleanMessages = normalizeMessages(messages);
  let response;

  if (cfg.family === 'gemini') {
    const system = cleanMessages.find((m) => m.role === 'system')?.content || '';
    const contents = cleanMessages.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const body = { contents };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    response = await fetch(`${cfg.baseUrl}/models/${encodeURIComponent(parsedModel || cfg.defaultModel)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const raw = await response.text();
    let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch {}
    if (!response.ok) throw new Error(`Gemini HTTP ${response.status}: ${raw.slice(0, 800)}`);
    const content = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    if (!content.trim()) throw new Error('Gemini returned no response text.');
    return { content, toolCalls: [], model: parsedModel || cfg.defaultModel, provider, raw: data };
  }

  if (cfg.family === 'anthropic') {
    const system = cleanMessages.find((m) => m.role === 'system')?.content || '';
    const anthropicMessages = cleanMessages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    const body = { model: parsedModel || cfg.defaultModel, max_tokens: Number(process.env.ULTRON_ANTHROPIC_MAX_TOKENS || 2048), messages: anthropicMessages };
    if (system) body.system = system;
    response = await fetch(`${cfg.baseUrl}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch {}
    if (!response.ok) throw new Error(`Anthropic HTTP ${response.status}: ${raw.slice(0, 800)}`);
    const content = Array.isArray(data?.content) ? data.content.filter((x) => x.type === 'text').map((x) => x.text).join('') : '';
    if (!content.trim()) throw new Error('Anthropic returned no response text.');
    return { content, toolCalls: [], model: data?.model || parsedModel || cfg.defaultModel, provider, raw: data };
  }

  response = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model: parsedModel || cfg.defaultModel, messages: cleanMessages, ...(Array.isArray(tools) && tools.length ? { tools } : {}) }),
  });
  const raw = await response.text();
  let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) throw new Error(`${provider} HTTP ${response.status}: ${raw.slice(0, 800)}`);
  const message = data?.choices?.[0]?.message || {};
  const content = message.content ?? data?.choices?.[0]?.text ?? data?.output_text ?? '';
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (!String(content).trim() && !toolCalls.length) throw new Error(`${provider} returned no response text or tool calls.`);
  return { content: String(content || ''), toolCalls, model: data?.model || parsedModel || cfg.defaultModel, provider, raw: data };
}

async function health() {
  const creds = await credentials();
  const configured = Object.fromEntries(Object.entries(PROVIDERS).map(([id, cfg]) => [id, Boolean(creds[id])]));
  return { direct: true, providers: configured, anyConfigured: Object.values(configured).some(Boolean) };
}

module.exports = { PROVIDERS, directChat, health, chooseAutoModel, providerForModel, parseModel };
