const RECIPES = [
  {
    id: 'reel-publisher',
    detects: /\b(?:instagram|ig)\b[\s\S]{0,90}\b(?:reel|video)\b[\s\S]{0,90}\b(?:publish|post|schedule|upload)\b|\b(?:reel publisher|instagram publisher)\b/i,
    outcome: 'Verified approved Reel publication with media ID/permalink, no duplicate post, and performance-learning link.',
    requiredLayers: ['artifact/media hosting', 'Meta container creation', 'publish-status polling', 'explicit approval gate', 'publication verification', 'job↔media performance link'],
    avoid: ['manual copy/paste publishing', 'claiming publish success before media ID/permalink exists', 're-rendering an already approved Reel unnecessarily'],
  },
  {
    id: 'instagram-dm-sales',
    detects: /\b(?:instagram|ig)\b[\s\S]{0,80}\b(?:dm|inbox|message|reply|follow[- ]?up|lead)\b/i,
    outcome: 'Inbound DM events become deduplicated leads, context-aware suggested replies, approved sends and durable follow-up state.',
    requiredLayers: ['webhook ingestion', 'conversation state', 'lead extraction', 'semantic dedupe', 'reply suggestion', 'approval gate before send', 'follow-up scheduler', 'delivery evidence'],
    avoid: ['cold-message scraping', 'replying outside platform permission rules', 'duplicating follow-ups after restart'],
  },
  {
    id: 'creator-research-pipeline',
    detects: /\b(?:creator|influencer)\b[\s\S]{0,90}\b(?:research|discover|find|lead|prospect|pipeline|outreach)\b/i,
    outcome: 'A ranked creator prospect set with evidence, fit score, dedupe, next action and reusable lead state.',
    requiredLayers: ['multi-source research', 'identity/handle normalization', 'semantic duplicate prevention', 'fit scoring', 'evidence receipt', 'lead persistence', 'outreach recommendation'],
    avoid: ['raw link dumps', 'invented follower/engagement metrics', 'isolated CSVs that do not feed lead state'],
  },
  {
    id: 'cup-operator',
    detects: /\b(?:creator upgrade program|\bcup\b)\b/i,
    outcome: 'Creator onboarding → diagnosis → 30-day plan → milestones → metric sync → intervention → weekly report, with human approval where client-facing actions occur.',
    requiredLayers: ['creator profile/state', 'baseline metrics', 'goal contract', 'roadmap generation', 'weekly checkpoints', 'performance sync', 'intervention rules', 'reporting', 'completion evidence'],
    avoid: ['static one-off PDF plans', 'duplicating Performance OS responsibilities', 'generic coaching not tied to metrics'],
  },
  {
    id: 'founder-content-ops',
    detects: /\b(?:linkedin|founder brand|founder content|social media manager|content calendar|social publisher)\b/i,
    outcome: 'Account-fit ideas become drafts, approval-ready scheduled posts and measurable content state across supported channels.',
    requiredLayers: ['idea backlog', 'current-research context when needed', 'draft generation', 'channel-specific formatting', 'approval gate', 'scheduler/publisher', 'post receipt'],
    avoid: ['generic daily posting spam', 'auto-posting without explicit approval', 'one style copied across every platform'],
  },
  {
    id: 'personal-chief-of-staff',
    detects: /\b(?:email|gmail|calendar|meeting|reminder|daily brief|chief of staff|personal assistant|follow up with me|follow-up with me)\b/i,
    outcome: 'Inbox/calendar/tasks become prioritized actionable state with concise briefs and approval-gated external communication.',
    requiredLayers: ['OAuth/user consent', 'read-only ingestion', 'priority classification', 'task/commitment linking', 'draft or proposed action', 'approval for sends/changes', 'verification'],
    avoid: ['saving every email as memory', 'sending messages without approval', 'alerting on low-value noise'],
  },
  {
    id: 'desktop-operator',
    detects: /\b(?:windows|desktop|pc|computer|file automation|open app|control my pc|local automation)\b/i,
    outcome: 'Safe deterministic local actions with allowlisted capabilities, explicit destructive-action approval and observable receipts.',
    requiredLayers: ['action allowlist', 'path/process validation', 'dry run', 'approval boundary', 'execution receipt', 'rollback or safe failure where possible'],
    avoid: ['arbitrary shell execution from model prose', 'hidden destructive changes', 'long-running background loops without checkpoints'],
  },
  {
    id: 'product-analytics-loop',
    detects: /\b(?:posthog|analytics|funnel|product usage|elevate os metrics|feature usage|conversion funnel)\b/i,
    outcome: 'Real product events become funnel insight, anomaly/opportunity suggestions and prioritized product actions.',
    requiredLayers: ['event schema', 'identity/privacy boundary', 'query layer', 'funnel/retention view', 'decision thresholds', 'adaptive proposal'],
    avoid: ['tracking without a decision use-case', 'collecting sensitive data unnecessarily', 'dashboard-only work with no action loop'],
  },
];

function match(objective = '') {
  const text = String(objective || '').trim();
  return RECIPES.find((recipe) => recipe.detects.test(text)) || null;
}

function guidance(objective = '') {
  const recipe = match(objective);
  if (!recipe) return '';
  return [
    `FOUNDER AUTOMATION RECIPE: ${recipe.id}.`,
    `SUCCESS OUTCOME: ${recipe.outcome}`,
    `REQUIRED LAYERS: ${recipe.requiredLayers.join(' → ')}.`,
    `AVOID: ${recipe.avoid.join('; ')}.`,
    'Build the smallest complete vertical slice of this recipe first. Reuse existing Ultron memory, workspace, Adaptive Intelligence, Operator Mode and verification instead of creating parallel state systems.',
  ].join(' ');
}

function acceptance(objective = '') {
  const recipe = match(objective);
  if (!recipe) return [];
  return [
    `Founder recipe ${recipe.id} has a runnable vertical slice`,
    `Success evidence matches: ${recipe.outcome}`,
    'No duplicate state engine was introduced when an existing Ultron layer could be reused',
  ];
}

module.exports = { RECIPES, match, guidance, acceptance };
