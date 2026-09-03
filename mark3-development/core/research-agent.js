const web = require('./web');

function stripInvocation(text) {
  return String(text || '')
    .trim()
    .replace(/^(?:hey\s+)?ultron\b[\s,:;.!-]*/i, '')
    .replace(/^(?:please\s+)?(?:can|could|would)\s+you\s+/i, '')
    .replace(/^(?:this\s+is\s+not\s+what\s+i\s+asked\s+you\s+to\s+do[\s,:;.!-]*)/i, '')
    .replace(/^(?:that(?:'s|\s+is)\s+not\s+what\s+i\s+asked(?:\s+for)?[\s,:;.!-]*)/i, '')
    .replace(/^(?:i\s+(?:basically|actually|already)?\s*asked\s+you\s+to\s+)/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isContinuation(text) {
  const value = String(text || '').trim();
  return /^(?:just\s+)?(?:do\s+it|do\s+that(?:\s+now)?|go\s+ahead(?:\s+and\s+do\s+it)?|run\s+it|execute\s+it|continue|finish(?:\s+it)?(?:\s+now)?|resume|proceed|retry|try\s+again)\b/i.test(value)
    || /\bwhat\s+are\s+you\s+waiting\s+for\b[\s,;:!-]*(?:just\s+)?(?:do\s+it|go\s+ahead|start|proceed|execute)/i.test(value);
}

function isContentTrendTask(text) {
  const value = String(text || '');
  const trend = /\b(?:trend|trending|viral|theme|themes|content idea|content ideas|format|formats|what(?:'s| is) working|content opportunity)\b/i.test(value);
  const content = /\b(?:video|videos|reel|reels|short[- ]form|instagram|tiktok|youtube shorts?|creator|creators|influencer|influencers|client|clients|content)\b/i.test(value);
  return trend && content;
}

function isCreatorCollabTask(text) {
  const value = String(text || '');
  return /\b(?:creator|creators|influencer|influencers|ugc|instagram|reel|reels|tiktok|youtube)\b/i.test(value)
    && /\b(?:collab|collabs|collaboration|brand deal|brand deals|campaign|sponsor|sponsorship|ambassador|gifting|paid partnership|brand opportunity|marketplace)\b/i.test(value);
}

function regionHint(text) {
  if (/\b(?:india|indian|kolkata|delhi|mumbai|bangalore|bengaluru|hyderabad|chennai|pune)\b/i.test(String(text || ''))) return 'India';
  if (/\b(?:global|worldwide|international)\b/i.test(String(text || ''))) return 'global';
  return '';
}

function canonicalize(text) {
  const cleaned = stripInvocation(text);
  const region = regionHint(cleaned);
  if (isContentTrendTask(cleaned)) {
    const location = region ? ` ${region}` : '';
    return `current short-form video content themes and social trends${location} for creators: Instagram Reels, TikTok and YouTube Shorts; practical themes clients can publish now. User intent: ${cleaned}`;
  }
  if (isCreatorCollabTask(cleaned)) {
    const location = region ? ` ${region}` : '';
    return `current creator brand collaboration opportunities${location}, paid partnerships, gifting and campaign market signals. User intent: ${cleaned}`;
  }
  return cleaned;
}

function qualifies(text) {
  const canonical = canonicalize(text);
  if (!canonical) return false;
  return isContentTrendTask(canonical) || isCreatorCollabTask(canonical) || web.researchProfile(canonical).shouldResearch;
}

function historyRows(history = []) {
  return (Array.isArray(history) ? history : [])
    .filter((item) => item && ['user', 'assistant'].includes(item.role) && String(item.content || '').trim())
    .map((item) => ({ role: item.role, content: String(item.content || '') }));
}

function resolve(message, history = []) {
  const current = String(message || '').trim();
  if (!current) return null;

  if (qualifies(current) && !isContinuation(current)) {
    const query = canonicalize(current);
    return {
      original: current,
      query,
      resumed: false,
      kind: isContentTrendTask(query) ? 'content-trends' : isCreatorCollabTask(query) ? 'creator-collabs' : 'general-research',
    };
  }

  if (!isContinuation(current)) return null;
  const rows = historyRows(history);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.role !== 'user') continue;
    if (!qualifies(row.content) || isContinuation(row.content)) continue;
    const query = canonicalize(row.content);
    return {
      original: row.content,
      query,
      resumed: true,
      continuation: current,
      kind: isContentTrendTask(query) ? 'content-trends' : isCreatorCollabTask(query) ? 'creator-collabs' : 'general-research',
    };
  }
  return null;
}

async function run(task, options = {}) {
  if (!task?.query) throw new Error('Research task query is required.');
  const evidence = await web.searchAndFetch(task.query, {
    searchLimit: options.searchLimit || 6,
    fetchTop: options.fetchTop ?? 3,
    specializedFetchTop: options.specializedFetchTop ?? 2,
    maxMergedResults: options.maxMergedResults || 14,
    maxMergedPages: options.maxMergedPages || 7,
  });
  return {
    ...evidence,
    researchTask: {
      kind: task.kind,
      original: task.original,
      query: task.query,
      resumed: Boolean(task.resumed),
      continuation: task.continuation || null,
    },
  };
}

function deliveryInstruction(task) {
  if (!task) return '';
  const execution = 'RESEARCH EXECUTION: The web research has ALREADY RUN. Do not say you are going to search, ask the user to rerun anything, or request a more specific prompt when the evidence can answer the task. Synthesize the evidence and give the result now.';
  if (task.kind === 'content-trends') {
    return `${execution} For a trending-content request, give 4–6 concrete video themes the user's clients can actually use. For each: name the theme, one short reason it is timely, and one practical execution angle. Prefer useful themes over generic advice. Keep it concise enough for voice but valuable enough to act on.`;
  }
  if (task.kind === 'creator-collabs') {
    return `${execution} For creator-collab research, surface the strongest current opportunities/signals, separate India/global context when evidence allows, and state clearly when public Afluencer coverage is incomplete.`;
  }
  return `${execution} Lead with the conclusion, cite the strongest current signals in plain language, and give one practical implication for Sir.`;
}

module.exports = {
  stripInvocation,
  isContinuation,
  isContentTrendTask,
  isCreatorCollabTask,
  canonicalize,
  qualifies,
  resolve,
  run,
  deliveryInstruction,
};
