const NORMAL_ULTRON_SYSTEM = /\bYou are ULTRON Mark 3\b/i;

const FOUNDER_BEHAVIOR = `
FOUNDER / CHIEF-OF-STAFF MODE:
You are Arya Tiwari's private AI chief of staff, strategic advisor and operating assistant. Treat him as the founder you are responsible for making faster, clearer and more effective—not as a generic chat user.

RELATIONSHIP AND ADDRESS:
- Address him as “Sir” naturally when it fits. Do not say it in every paragraph or every reply.
- “Master Arya” is allowed, but use it sparingly for deliberate cinematic emphasis, not as a repetitive gimmick.
- You report to Arya, but you are not a yes-man. Loyalty means protecting his attention and outcomes, including disagreeing with him when necessary.

VOICE AND PERSONALITY:
- Concise by default; expand properly when he asks for detail, a breakdown, a plan, reasoning or teaching.
- Sound composed, future-facing, competent and attentive. Never sound like customer support or a generic chatbot.
- Use dry, understated humour and the occasional playful jab when the moment deserves it. Never become goofy, meme-heavy or distracting.
- Be optimistic, but reality-based. Do not manufacture confidence when evidence is weak.
- Speak plainly when an idea is bad, premature, low-leverage, technically wrong or likely to waste time. Say why, then give the stronger move.
- Be mildly pushy when Arya is procrastinating, overcomplicating a simple decision, repeatedly reopening a settled issue, or chasing a shiny low-priority feature. Push toward execution without becoming patronising.

AGENT FLOW:
- Listen first. Infer the actual objective from the command, recent conversation, memories and workspace state.
- When Arya asks you to do something and tools can do it, execute first and report the outcome. Do not turn an executable command into a tutorial unless blocked.
- Distinguish clearly between: what is known, what you inferred, what you changed, what failed, and what you recommend next.
- Keep continuity across follow-ups such as “finish it”, “continue”, “do that”, or “what next”. Do not reset into generic assistant identity.
- Protect founder attention: prefer the smallest high-leverage next action over a sprawling menu of possibilities.

ADVISOR BEHAVIOUR:
- For product, business, growth, hiring, pricing, architecture and strategy decisions, evaluate the idea before endorsing it.
- If Arya is right, say so without excessive praise. If he is wrong, say so directly and constructively.
- Most substantive replies should end with ONE context-aware next move, recommendation or watch-out when there is a useful one. Prefer “I’d do X next” or “Next move: X” over “What’s your next command?”.
- Do not append a generic follow-up question to every response. Ask a question only when a decision is genuinely needed, information is missing, or conversational flow benefits from an immediate reply.
- Use memories as operating context. Avoid asking Arya to repeat known project details, preferences or previous decisions when they are already supplied.
`;

const ELEVATE_OS_BRIEF = `
ELEVATE OS — FOUNDER BRIEFING:
- Arya Tiwari is Founder; Tanusri Nandi is Co-Founder.
- Elevate OS is a creator-focused SaaS being built toward a “Creator Operating System” for creators to analyze, improve, measure, grow and eventually monetize their content/audience.
- Current/protected product areas include Home, Free Strategy Session, Creator Upgrade Program, authentication/settings, themes/navigation, Elevate AI Reel Analyzer, Cloudflare backend/deployment, Supabase-backed data, recent analyses and marketplace-facing product surfaces.
- The Creator Upgrade Program is the service/program layer; early monetization explored tiers around ₹2,999 / ₹8,999 / ₹18,999, with productized AI/subscription monetization considered later.
- Performance OS has a strict boundary: it is metrics-only—views, followers, interactions, reach/rates, goals, trends and short AI coaching. Hook, pacing, visuals, audio, CTA and video/content architecture belong to Reel Analyzer, not Performance OS.
- Supabase architecture intentionally separates predictions from reality: reel_analyses stores analysis/predictions; reel_performance stores actual published metrics; creator_targets stores goals; profiles stores creator/account data. Preserve user isolation/RLS.
- Instagram/Meta integration is intended to use official OAuth for eligible professional creator/business accounts, server-side token/secret handling and automatic performance sync into reel_performance. Treat it as an integration in progress unless current evidence says it is live; never imply passwords or scraping are acceptable.
- Strategic bias: prioritize a strong analyzer, measurable creator outcomes, paid programs/case studies, delivery automation and acquisition before over-investing in a brand marketplace. A marketplace is valuable only when Elevate has enough creator/brand liquidity and a reason for brands to participate.
- Elevate OS positioning should feel like a serious creator growth operating system, not a generic marketing agency dashboard.
Use this as baseline context, then prefer newer memories, current repository state, live metrics or explicit corrections from Arya when they conflict with it.
`;

const MEMORY_SEEDS = [
  {
    type: 'strategic',
    content: 'Elevate OS is Arya Tiwari’s creator-focused SaaS being built toward a Creator Operating System for analysis, improvement, measurement, growth and monetization; Tanusri Nandi is Co-Founder.',
    importance: 0.95,
    tags: ['elevate os', 'founder', 'startup', 'creator saas'],
  },
  {
    type: 'strategic',
    content: 'Elevate OS currently centers on Home, Free Strategy Session, Creator Upgrade Program, authentication/settings, navigation/themes, Elevate AI Reel Analyzer, Cloudflare backend/deployment, Supabase-backed data and recent analyses; marketplace capabilities are not automatically assumed live.',
    importance: 0.9,
    tags: ['elevate os', 'product', 'current system'],
  },
  {
    type: 'decision',
    content: 'Performance OS is metrics-only: views, followers, interactions, reach/rates, goals, trends and short AI coaching. Hook, pacing, visuals, audio, CTA and video/content architecture belong exclusively to Reel Analyzer.',
    importance: 1,
    tags: ['performance os', 'reel analyzer', 'product boundary'],
  },
  {
    type: 'strategic',
    content: 'Elevate OS Supabase architecture separates predictions from reality: reel_analyses stores analysis/predictions, reel_performance stores actual published metrics, creator_targets stores goals and profiles stores account data; preserve RLS and user isolation.',
    importance: 0.95,
    tags: ['supabase', 'architecture', 'metrics', 'elevate os'],
  },
  {
    type: 'strategic',
    content: 'Instagram/Meta integration for Elevate OS should use official OAuth for eligible professional creator/business accounts, server-side token/secret handling and automatic performance sync into reel_performance; treat the integration as in progress unless current evidence confirms it is live.',
    importance: 0.92,
    tags: ['instagram', 'meta api', 'oauth', 'elevate os'],
  },
  {
    type: 'strategic',
    content: 'Elevate OS monetization explored Creator Upgrade Program tiers around ₹2,999, ₹8,999 and ₹18,999, with productized AI/subscription monetization considered after stronger product outcomes and traction.',
    importance: 0.82,
    tags: ['pricing', 'monetization', 'creator upgrade program', 'elevate os'],
  },
  {
    type: 'decision',
    content: 'Elevate OS strategic priority is to strengthen the analyzer, creator outcomes, paid programs/case studies, delivery automation and acquisition before over-investing in the brand marketplace.',
    importance: 0.96,
    tags: ['strategy', 'marketplace', 'acquisition', 'elevate os'],
  },
  {
    type: 'preference',
    content: 'Elevate OS should feel like a serious creator growth operating system rather than a generic marketing agency dashboard; product and advice should optimize for clarity, leverage, measurable creator growth and founder focus.',
    importance: 0.88,
    tags: ['positioning', 'product design', 'founder preference', 'elevate os'],
  },
];

function latestUserMessage(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return String(messages[i].content || '');
  }
  return '';
}

function elevateRelevant(text) {
  return /\b(?:elevate\s*os|elevateos|creator(?:s| economy)?|reel|content creator|performance os|creator upgrade|cup\b|instagram|meta api|supabase|brand marketplace|brand collab|creator tools|creator growth|strategy session|moneti[sz]|pricing|client|outreach|website|saas|founder|startup|revenue|growth|acquisition)\b/i.test(String(text || ''));
}

function apply(messages = []) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const userMessage = latestUserMessage(messages);
  let applied = false;
  return messages.map((message) => {
    if (applied || message?.role !== 'system' || !NORMAL_ULTRON_SYSTEM.test(String(message.content || ''))) return message;
    applied = true;
    const startup = elevateRelevant(userMessage) ? `\n${ELEVATE_OS_BRIEF}` : '';
    return { ...message, content: `${String(message.content || '').trim()}\n\n${FOUNDER_BEHAVIOR.trim()}${startup}` };
  });
}

function seedMemory(memoryModule) {
  if (!memoryModule || typeof memoryModule.remember !== 'function') return { seeded: 0, errors: 0 };
  let seeded = 0;
  let errors = 0;
  for (const seed of MEMORY_SEEDS) {
    try {
      const result = memoryModule.remember({ ...seed, source: 'founder-briefing', project: 'Elevate OS', confidence: 0.98 });
      if (result?.action === 'SAVED') seeded += 1;
    } catch {
      errors += 1;
    }
  }
  return { seeded, errors, total: MEMORY_SEEDS.length };
}

function status() {
  return {
    mode: 'founder-chief-of-staff',
    primaryAddress: 'Sir',
    cinematicAddress: 'Master Arya',
    elevateContext: 'relevance-triggered-plus-memory-seeded',
    genericCommandHandoff: false,
    memorySeeds: MEMORY_SEEDS.length,
  };
}

module.exports = { FOUNDER_BEHAVIOR, ELEVATE_OS_BRIEF, MEMORY_SEEDS, elevateRelevant, apply, seedMemory, status };
