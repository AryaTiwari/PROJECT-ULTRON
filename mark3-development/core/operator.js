const fs = require('fs');
const path = require('path');
const config = require('./config');

function hasEnv(...names) {
  return names.some((name) => Boolean(String(process.env[name] || '').trim()));
}

function projectEnvHas(...names) {
  try {
    const file = path.resolve(config.projectRoot, '.env');
    if (!fs.existsSync(file)) return false;
    const text = fs.readFileSync(file, 'utf8');
    return names.some((name) => new RegExp(`^\\s*${name}\\s*=\\s*.+$`, 'm').test(text));
  } catch {
    return false;
  }
}

function configured(...names) {
  return hasEnv(...names) || projectEnvHas(...names);
}

const CAPABILITIES = [
  {
    id: 'reel_generation',
    title: 'Adaptive Reel Intelligence + Factory',
    role: 'social-media-strategist-editor',
    detects: /\b(?:make|create|generate|produce|render|edit)\b[\s\S]{0,90}\b(?:reel|short-form video|short form video|instagram video)\b/i,
    implemented: true,
    credentials: () => configured('PEXELS_API_KEY') && configured('FISH_API_KEY'),
    missing: ['Pexels source API key', 'Fish narrator API key'],
    mode: 'execute',
    purpose: 'Research account-fit formats, apply learned creative preferences, direct/script/render a verified vertical Reel, and return the MP4 artifact without publishing it.',
  },
  {
    id: 'reel_strategy',
    title: 'Reel Strategy Analyst',
    role: 'social-media-analyst',
    detects: /\b(?:suggest|recommend|research|analy[sz]e|find)\b[\s\S]{0,100}\b(?:reel ideas?|content ideas?|reel trends?|instagram aesthetic|short-form formats?|short form formats?)\b/i,
    implemented: true,
    credentials: () => configured('INSTAGRAM_TOKEN', 'INSTAGRAM_ACCESS_TOKEN', 'META_ACCESS_TOKEN') || configured('TINYFISH_API_KEY') || configured('TAVILY_API_KEY'),
    missing: ['Instagram or research provider credentials'],
    mode: 'execute',
    purpose: 'Combine trend evidence, Instagram account aesthetics, recent content patterns and Adaptive Intelligence into account-fit Reel ideas and creative direction.',
  },
  {
    id: 'adaptive_operator',
    title: 'Adaptive Founder Intelligence',
    role: 'chief-of-staff',
    detects: /\b(?:what have you learned|learned preferences|adaptive intelligence|adapt to me|my patterns|my style|suggest based on my preferences)\b/i,
    implemented: true,
    credentials: () => true,
    missing: [],
    mode: 'execute',
    purpose: 'Learn from explicit corrections, repeated approvals/rejections and outcomes, then apply only domain-relevant preferences to future work.',
  },
  {
    id: 'system_audit',
    title: 'Turbo System Integrity Auditor',
    role: 'systems-architect',
    detects: /\b(?:audit ultron|audit yourself|system health|turbo status|what is broken|what'?s broken|integration map|runtime topology)\b/i,
    implemented: true,
    credentials: () => true,
    missing: [],
    mode: 'execute',
    purpose: 'Cross-check Operator, Forge, Adaptive Intelligence, Reel Intelligence, research fallbacks, memory, file delivery and zero-cost guardrails for contradictory readiness or broken links.',
  },
  {
    id: 'instagram_publish',
    title: 'Instagram Reel Publisher',
    role: 'social-media-manager',
    detects: /\b(?:post|publish|schedule|upload)\b[\s\S]{0,80}\b(?:reel|instagram|ig)\b|\b(?:reel|instagram|ig)\b[\s\S]{0,80}\b(?:post|publish|schedule|upload)\b/i,
    implemented: false,
    credentials: () => configured('INSTAGRAM_TOKEN', 'INSTAGRAM_ACCESS_TOKEN', 'META_ACCESS_TOKEN') && configured('INSTAGRAM_BUSINESS_ACCOUNT_ID', 'INSTAGRAM_ACCOUNT_ID'),
    missing: ['Instagram publishing connector', 'Meta/Instagram access token', 'Instagram professional account ID'],
    mode: 'execute-with-approval',
    purpose: 'Publish or schedule creator reels and captions from an approved media file.',
  },
  {
    id: 'instagram_dm',
    title: 'Instagram DM Operator',
    role: 'sales-operator',
    detects: /\b(?:instagram|ig|dm|dms|inbox)\b[\s\S]{0,90}\b(?:reply|respond|message|lead|extract|qualify|follow up|follow-up)\b|\b(?:reply|respond|extract|qualify)\b[\s\S]{0,90}\b(?:dm|dms|inbox)\b/i,
    implemented: false,
    credentials: () => configured('INSTAGRAM_TOKEN', 'INSTAGRAM_ACCESS_TOKEN', 'META_ACCESS_TOKEN') && configured('META_APP_SECRET', 'INSTAGRAM_APP_SECRET'),
    missing: ['Instagram messaging/webhook connector', 'Meta messaging permissions/token', 'Meta app secret/webhook setup'],
    mode: 'execute-with-approval',
    purpose: 'Read permitted Instagram conversations, extract leads, classify replies and send context-aware follow-ups.',
  },
  {
    id: 'creator_research',
    title: 'Creator Research Operator',
    role: 'researcher',
    detects: /\b(?:find|research|discover|source|list|identify)\b[\s\S]{0,90}\b(?:creators?|influencers?|instagram accounts?|prospects?|leads?)\b/i,
    implemented: true,
    credentials: () => true,
    missing: [],
    mode: 'execute',
    purpose: 'Research public creator prospects, compare fit and return structured lead candidates.',
  },
  {
    id: 'lead_extraction',
    title: 'Lead Extraction Operator',
    role: 'business-development',
    detects: /\b(?:extract|collect|capture|save|qualify)\b[\s\S]{0,90}\b(?:leads?|prospects?|dm|dms|inbox|creators?)\b/i,
    implemented: false,
    credentials: () => configured('INSTAGRAM_TOKEN', 'INSTAGRAM_ACCESS_TOKEN', 'META_ACCESS_TOKEN'),
    missing: ['Inbox/lead extraction connector', 'Source inbox/account access'],
    mode: 'execute',
    purpose: 'Turn inbound conversations and research results into structured leads with follow-up state.',
  },
  {
    id: 'linkedin_publish',
    title: 'LinkedIn Founder Publisher',
    role: 'founder-brand-manager',
    detects: /\b(?:post|publish|schedule|write and post)\b[\s\S]{0,90}\blinkedin\b|\blinkedin\b[\s\S]{0,90}\b(?:post|publish|schedule)\b/i,
    implemented: false,
    credentials: () => configured('LINKEDIN_ACCESS_TOKEN') || configured('BUFFER_API_KEY'),
    missing: ['LinkedIn publishing connector', 'LinkedIn publishing access/token or Buffer API key'],
    mode: 'execute-with-approval',
    purpose: 'Draft and publish founder/company LinkedIn posts using business context and current priorities.',
  },
  {
    id: 'cup_automation',
    title: 'Creator Upgrade Program Operator',
    role: 'program-manager',
    detects: /\b(?:creator upgrade program|\bcup\b)\b[\s\S]{0,120}\b(?:automate|onboard|run|manage|upgrade|plan|client|creator)\b|\b(?:automate|run|manage)\b[\s\S]{0,100}\bcreator upgrade program\b/i,
    implemented: false,
    credentials: () => configured('SUPABASE_URL') && configured('SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'),
    missing: ['CUP workflow engine', 'Supabase connection for creator/client state'],
    mode: 'execute-with-approval',
    purpose: 'Onboard creators, generate personalized plans, schedule milestones, track metrics and produce interventions automatically.',
  },
  {
    id: 'software_build',
    title: 'Forge Software Builder',
    role: 'developer',
    detects: /\b(?:build|create|develop|implement|fix|refactor)\b[\s\S]{0,100}\b(?:app|website|automation|program|system|feature|code|repo|repository)\b/i,
    implemented: true,
    credentials: () => true,
    missing: [],
    mode: 'execute',
    purpose: 'Build and repair software through Forge/Coding Brain using founder-specific profiles, checkpoints and verification.',
  },
  {
    id: 'trading_research',
    title: 'Trading Research & Paper Execution',
    role: 'trading-analyst',
    detects: /\b(?:trade|trading|market|gold|xauusd|crypto|forex|position|entry|stop loss|take profit|strategy)\b/i,
    implemented: true,
    credentials: () => true,
    missing: [],
    mode: 'research-paper-only',
    purpose: 'Research markets, generate rules, backtest and paper-trade strategies. Real-money autonomous execution is disabled.',
  },
];

const SPECIFIC_MATCH_ORDER = [
  'lead_extraction',
  'instagram_publish',
  'instagram_dm',
  'reel_generation',
  'reel_strategy',
  'system_audit',
  'adaptive_operator',
];

function match(message) {
  const text = String(message || '').trim();
  if (!text) return null;
  for (const id of SPECIFIC_MATCH_ORDER) {
    const capability = CAPABILITIES.find((row) => row.id === id);
    if (capability?.detects.test(text)) return capability;
  }
  return CAPABILITIES.find((capability) => !SPECIFIC_MATCH_ORDER.includes(capability.id) && capability.detects.test(text)) || null;
}

function capabilityState(capability) {
  const credentialsReady = Boolean(capability.credentials());
  const implemented = Boolean(capability.implemented);
  const ready = implemented && credentialsReady;
  const missing = [];
  if (!implemented) missing.push(...capability.missing.filter((item) => /connector|engine/i.test(item)));
  if (!credentialsReady) missing.push(...capability.missing.filter((item) => !/connector|engine/i.test(item)));
  return {
    id: capability.id,
    title: capability.title,
    role: capability.role,
    implemented,
    credentialsReady,
    ready,
    mode: capability.mode,
    purpose: capability.purpose,
    missing: [...new Set(missing)],
  };
}

function status() {
  return CAPABILITIES.map(capabilityState);
}

function summary() {
  const rows = status();
  return {
    ready: rows.filter((row) => row.ready),
    buildNext: rows.filter((row) => !row.implemented),
    waitingCredentials: rows.filter((row) => row.implemented && !row.credentialsReady),
    total: rows.length,
  };
}

function instruction(message) {
  const capability = match(message);
  if (!capability) return '';
  const state = capabilityState(capability);
  const constraint = capability.mode === 'research-paper-only'
    ? 'Never place or manage real-money trades autonomously. Limit execution to research, backtesting, alerts and paper/simulated positions.'
    : capability.mode === 'execute-with-approval'
      ? 'Prepare and verify the action. Obtain approval before irreversible external publication, messaging or account changes unless the user explicitly asked for that exact action in the current turn and the connector supports it safely.'
      : 'Execute through available deterministic tools when possible; verify the result instead of merely explaining how to do it.';
  return `OPERATOR MODE: ${capability.title}. ROLE: ${capability.role}. PURPOSE: ${capability.purpose} READINESS: ${state.ready ? 'ready' : `blocked; missing ${state.missing.join(', ') || 'implementation'}`}. ${constraint}`;
}

module.exports = { CAPABILITIES, SPECIFIC_MATCH_ORDER, match, status, summary, instruction, capabilityState };
