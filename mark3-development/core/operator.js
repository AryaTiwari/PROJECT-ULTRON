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
    detects: /\b(?:find|research|discover|source|list|identify)\b[\s\S]{0,90}\b(?:creator|influencer|instagram account|prospect|lead)\b/i,
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
    detects: /\b(?:extract|collect|capture|save|qualify)\b[\s\S]{0,90}\b(?:lead|prospect|dm|inbox|creator)\b/i,
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
    credentials: () => configured('LINKEDIN_ACCESS_TOKEN'),
    missing: ['LinkedIn publishing connector', 'LinkedIn publishing access/token'],
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
    purpose: 'Build and repair software through Forge/Coding Brain.',
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

function match(message) {
  const text = String(message || '').trim();
  if (!text) return null;
  return CAPABILITIES.find((capability) => capability.detects.test(text)) || null;
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

module.exports = { CAPABILITIES, match, status, summary, instruction, capabilityState };
