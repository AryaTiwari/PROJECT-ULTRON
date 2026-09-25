const text = value => String(value || "").trim();

export const directCredentialEnvNames = Object.freeze([
  "GEMINI_APY_KEY",
  "GEMINI_API_KEY",
  "GEMINI_API_KEY2",
  "GOOGLE_API_KEY",
  "GROK_API_KEY",
  "GROK_API_KEY2",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "GROQ_API_KEY2",
  "NVIDIA_API_KEY"
]);

const uniqueSecrets = values => {
  const seen = new Set();
  return values.map(text).filter(value => value && !seen.has(value) && seen.add(value));
};

function route(id, provider, model, source, extra = {}) {
  return { id, provider, model, source, ...extra };
}

function promotePool(env, canonicalName, secondaryName, values) {
  const pool = uniqueSecrets(values);
  if (!pool.length) return [];
  env[canonicalName] = pool[0];
  if (secondaryName) {
    if (pool[1]) env[secondaryName] = pool[1];
    else if (env[secondaryName] && text(env[secondaryName]) === pool[0]) delete env[secondaryName];
  }
  return pool;
}

export function buildConversationModelPolicy(env = process.env) {
  const originalGemini = text(env.GEMINI_API_KEY);
  const originalGoogle = text(env.GOOGLE_API_KEY);
  const geminiPool = promotePool(env, "GEMINI_API_KEY", "GOOGLE_API_KEY", [
    text(env.GEMINI_APY_KEY) || originalGemini,
    env.GEMINI_API_KEY2,
    originalGoogle
  ]);

  const originalXai = text(env.XAI_API_KEY);
  const grokPool = promotePool(env, "XAI_API_KEY", null, [
    text(env.GROK_API_KEY) || originalXai,
    env.GROK_API_KEY2
  ]);

  const groqPool = promotePool(env, "GROQ_API_KEY", null, [
    env.GROQ_API_KEY,
    env.GROQ_API_KEY2
  ]);

  const candidates = [];
  if (geminiPool.length) {
    candidates.push(route(
      "gemini-pool",
      "gemini",
      text(env.ULTRON_M4_GEMINI_MODEL) || "gemini-3.7-flash",
      `Gemini credential pool (${geminiPool.length})`
    ));
  }
  if (grokPool.length) {
    const model = text(env.ULTRON_M4_GROK_MODEL) || "grok-4.6";
    candidates.push(route("grok-primary", "xai", model, "Grok xAI"));
    if (grokPool[1]) {
      env.ULTRON_M4_GROK_SECONDARY_KEY = grokPool[1];
      candidates.push(route("grok-secondary", "custom", model, "Grok xAI secondary", {
        baseUrl: text(env.XAI_BASE_URL) || "https://api.x.ai/v1",
        keyEnv: "ULTRON_M4_GROK_SECONDARY_KEY",
        transport: "codex_responses"
      }));
    }
  }

  if (text(env.NVIDIA_API_KEY)) {
    candidates.push(route(
      "nvidia-primary",
      "nvidia",
      text(env.ULTRON_M4_NVIDIA_MODEL) || "nvidia/nemotron-3-super-120b-a12b",
      "NVIDIA NIM"
    ));
  }

  if (groqPool.length) {
    const model = text(env.ULTRON_M4_GROQ_MODEL) || "qwen/qwen3.8-27b";
    candidates.push(route("groq-primary", "custom", model, "Groq compatibility route", {
      baseUrl: text(env.GROQ_BASE_URL) || "https://api.groq.com/openai/v1",
      keyEnv: "GROQ_API_KEY",
      transport: "chat_completions"
    }));
    if (groqPool[1]) {
      env.ULTRON_M4_GROQ_SECONDARY_KEY = groqPool[1];
      candidates.push(route("groq-secondary", "custom", model, "Groq secondary compatibility route", {
        baseUrl: text(env.GROQ_BASE_URL) || "https://api.groq.com/openai/v1",
        keyEnv: "ULTRON_M4_GROQ_SECONDARY_KEY",
        transport: "chat_completions"
      }));
    }
  }

  const bigPickle = route("big-pickle", "opencode-free", "big-pickle", "Big Pickle keyless fallback");
  const explicitProvider = text(env.ULTRON_M4_COGNITION_PROVIDER);
  const explicitModel = text(env.ULTRON_M4_COGNITION_MODEL);
  const explicit = explicitProvider && explicitModel
    ? route("explicit", explicitProvider, explicitModel, "explicit")
    : null;
  const primary = explicit || candidates[0] || bigPickle;
  const fallbacks = candidates
    .filter(candidate => candidate.id !== primary.id)
    .filter(candidate => candidate.provider !== primary.provider || candidate.model !== primary.model || candidate.baseUrl)
    .concat(primary.id === bigPickle.id ? [] : [bigPickle]);

  return {
    primary,
    fallbacks,
    directRoutes: candidates,
    directCredentialCount: geminiPool.length + grokPool.length + groqPool.length + (text(env.NVIDIA_API_KEY) ? 1 : 0),
    bigPickle
  };
}
