const path = require('path');
const config = require('./config');
const { readJson, writeJsonAtomic } = require('./persistence');
const { emit } = require('./events');

const statePath = path.join(config.dataDir, 'operating-mode.json');

const MODES = {
  executive: {
    id: 'executive',
    label: 'EXECUTIVE',
    aliases: ['executive', 'normal', 'default', 'founder', 'general', 'assistant'],
    prompt: `ACTIVE OPERATING MODE: EXECUTIVE AIDE.
Remain the founder's concise executive aide and chief of staff. Optimize for leverage, continuity, decisions, execution and protecting Sir's attention. Use memory and workspace state for internal continuity; when a recommendation materially depends on the current outside world, prefer fresh research evidence over assumptions. Return the decision and useful implication, not a dump of sources.`,
  },
  sales: {
    id: 'sales',
    label: 'SALES STRATEGIST',
    aliases: ['sales', 'sales strategist', 'sales strategy', 'closer', 'sales advisor'],
    prompt: `ACTIVE OPERATING MODE: SALES STRATEGIST.
Operate as Sir's revenue and sales strategist. Think in ICP, pain, offer, proof, objection handling, pipeline, follow-up, conversion, deal velocity and closing. Prefer concrete scripts, next actions and measurable sales experiments over generic motivation. Challenge weak offers or low-quality lead strategy directly. Use current market/competitor research when it changes the recommendation, and use business/project memory before asking Sir to repeat context.`,
  },
  trader: {
    id: 'trader',
    label: 'TRADER',
    aliases: ['trader', 'trading', 'market trader', 'market analyst'],
    prompt: `ACTIVE OPERATING MODE: TRADER.
Operate as a disciplined market-analysis copilot, not a hype machine. Separate live evidence from assumptions; never invent current price, news or market conditions. For time-sensitive market questions, use live web evidence when available. Think in scenario, trend, catalyst, invalidation, probability, downside and risk/reward. Be concise and risk-first; never imply certainty or guaranteed returns.`,
  },
  influencer: {
    id: 'influencer',
    label: 'INFLUENCER STRATEGIST',
    aliases: ['influencer', 'influencer strategist', 'creator', 'creator strategist', 'content strategist'],
    prompt: `ACTIVE OPERATING MODE: INFLUENCER STRATEGIST.
Operate as Sir's creator-growth strategist. Think in audience psychology, positioning, content pillars, hooks, retention, distribution, creator metrics, monetization and brand fit. Use Elevate OS knowledge and creator memories aggressively when relevant. For current creator/social trends, use Hootsuite/TinyFish trend evidence as a signal and cross-check important conclusions with broader web evidence. For brand-collab, sponsorship, gifting, ambassador or marketplace research, use Afluencer public/indexed evidence for both Indian and global opportunity context when available; never imply that public search equals the complete logged-in Afluencer directory. Keep Performance OS metrics-only; content/video architecture belongs to Reel Analyzer. Give practical creator moves, not generic social-media advice.`,
  },
  developer: {
    id: 'developer',
    label: 'DEVELOPER',
    aliases: ['developer', 'dev', 'coding', 'engineer', 'software engineer', 'developer strategist'],
    prompt: `ACTIVE OPERATING MODE: DEVELOPER.
Operate as Sir's repository-native engineering agent. Inspect before guessing. Use current technical documentation/web evidence when library, API or platform behavior may have changed. For implementation requests, prefer Coding Brain: investigate when needed, make the smallest correct edit, validate, review and report. Use GitHub/repository tools when the request concerns remote code. If Sir explicitly asks to push, commit, publish or update GitHub, publish only the verified files from that coding task and report the resulting commit. Never claim code was changed, tested or pushed without evidence.`,
  },
};

let state = readJson(statePath, {
  mode: 'executive',
  changedAt: new Date().toISOString(),
  source: 'default',
});
if (!MODES[state.mode]) state = { mode: 'executive', changedAt: new Date().toISOString(), source: 'recovered-default' };

function normalize(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!raw) return null;
  for (const mode of Object.values(MODES)) {
    if (mode.id === raw || mode.aliases.includes(raw)) return mode.id;
  }
  return null;
}

function current() {
  return MODES[state.mode] || MODES.executive;
}

function status() {
  const mode = current();
  return {
    mode: mode.id,
    label: mode.label,
    changedAt: state.changedAt || null,
    source: state.source || null,
    available: Object.values(MODES).map((item) => ({ id: item.id, label: item.label })),
  };
}

function setMode(value, source = 'command') {
  const id = normalize(value);
  if (!id) throw new Error(`Unknown ULTRON operating mode: ${value}`);
  const previous = state.mode;
  state = { mode: id, changedAt: new Date().toISOString(), source };
  writeJsonAtomic(statePath, state);
  const payload = { previous, ...status() };
  emit('mode_changed', payload);
  return payload;
}

function detectCommand(message) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();
  if (!text) return null;
  if (/\b(?:what|which)\s+(?:operating\s+)?mode\s+(?:are you|you are|is active|is on)\b/i.test(text) || /\bcurrent\s+mode\b/i.test(text)) {
    return { type: 'status' };
  }
  if (/\b(?:exit|leave|disable|turn off)\s+(?:the\s+)?(?:current\s+)?mode\b/i.test(text) || /\b(?:normal|default|executive|founder)\s+mode\b/i.test(text)) {
    return { type: 'set', mode: 'executive' };
  }
  const match = lower.match(/\b(?:go|switch|enter|activate|set|turn)\s+(?:me\s+)?(?:into\s+|to\s+)?(.+?)\s+mode\b/);
  if (match?.[1]) {
    const id = normalize(match[1]);
    if (id) return { type: 'set', mode: id };
  }
  const short = lower.match(/^\s*(sales strategist|sales|trader|trading|influencer strategist|creator strategist|developer|dev|coding)\s+mode\s*$/);
  if (short?.[1]) {
    const id = normalize(short[1]);
    if (id) return { type: 'set', mode: id };
  }
  return null;
}

function handleCommand(message) {
  const command = detectCommand(message);
  if (!command) return null;
  if (command.type === 'status') {
    const mode = current();
    return { handled: true, response: `${mode.label} mode is active, Sir.`, ...status() };
  }
  const changed = setMode(command.mode, 'voice-or-chat-command');
  const mode = current();
  const line = mode.id === 'executive'
    ? 'Executive mode restored, Sir.'
    : `${mode.label} mode active, Sir.`;
  return { handled: true, response: line, ...changed };
}

function systemPrompt() {
  return current().prompt;
}

function routeTask(message, requested = 'general') {
  const explicit = String(requested || 'general').toLowerCase();
  if (explicit && explicit !== 'general') return explicit;
  const text = String(message || '').toLowerCase();
  const mode = current().id;
  if (mode === 'developer') {
    if (/\b(?:fix|implement|add|change|update|modify|edit|refactor|remove|delete|create|build|debug|inspect|investigate|review|test|repo|repository|github|code|feature|bug)\b/.test(text)) return 'coding';
  }
  if (mode === 'trader') {
    if (/\b(?:today|now|current|latest|price|market|gold|xau|forex|crypto|btc|eth|stock|index|news|setup|entry|trend|trade)\b/.test(text)) return 'research';
  }
  if (mode === 'sales') {
    if (/\b(?:current|latest|market|competitor|research|industry|trend)\b/.test(text)) return 'research';
    if (/\b(?:strategy|offer|pipeline|objection|close|closing|follow[- ]?up|outreach|lead|client|pricing|sales)\b/.test(text)) return 'planning';
  }
  if (mode === 'influencer') {
    if (/\b(?:current|latest|today|trend|trending|market|collab|brand deal|sponsor|opportunity|research|find)\b/.test(text)) return 'research';
    if (/\b(?:strategy|content|creator|reel|growth|moneti[sz]|brand|audience|instagram|youtube|hook|retention)\b/.test(text)) return 'planning';
  }
  return explicit || 'general';
}

module.exports = { MODES, normalize, current, status, setMode, detectCommand, handleCommand, systemPrompt, routeTask };
