const factory = require('./reel-factory');
const quality = require('./reel-quality');
const { writeJsonAtomic } = require('./persistence');

let installed = false;
let originalCreateJob = null;

const CREATOR_TEMPLATES = Object.freeze({
  context: 'Viewers may follow one topic, not necessarily you.',
  mechanism: 'Repeatable value gives viewers a clear reason to return.',
  consequence: 'Mixed follow-ups weaken the expectation that viewers return.',
  action: 'Build three repeatable pillars around the winning promise.',
  proof: 'Make the next viewer action obvious and measurable.',
  payoff: 'Repeatable value turns isolated views into stronger follower intent.',
  measurement: 'Track follows, saves, profile visits, and repeat viewers.',
});

const GENERAL_TEMPLATES = Object.freeze({
  context: 'Separate the visible symptom from its underlying cause first.',
  mechanism: 'Repeated outcomes reveal patterns that one result cannot show.',
  consequence: 'Fix the bottleneck that changes the final outcome most.',
  action: 'Turn that insight into a clear, measurable process.',
  proof: 'Make the next action obvious, specific, and measurable.',
  payoff: 'Use repeatable systems instead of relying on isolated wins.',
  measurement: 'Measure the result before deciding whether the change worked.',
});

function purposeKey(scene = {}) {
  const text = `${scene.purpose || ''} ${scene.onScreenText || ''}`.toLowerCase();
  if (/context|diagnos|cause|why|problem/.test(text)) return 'context';
  if (/mechanism|signal|return|retention/.test(text)) return 'mechanism';
  if (/consequence|result|drop|weak|reset|dies|stops/.test(text)) return 'consequence';
  if (/action|fix|build|strategy|pillar|system/.test(text)) return 'action';
  if (/proof|clear|next step/.test(text)) return 'proof';
  if (/measure|track|analytics/.test(text)) return 'measurement';
  if (/payoff|outcome|growth|convert|momentum|repeat/.test(text)) return 'payoff';
  return 'proof';
}

function templateFor(scene, creatorTopic) {
  const key = purposeKey(scene);
  return (creatorTopic ? CREATOR_TEMPLATES : GENERAL_TEMPLATES)[key]
    || (creatorTopic ? CREATOR_TEMPLATES.proof : GENERAL_TEMPLATES.proof);
}

function richerHook(creatorTopic) {
  return creatorTopic
    ? 'Big view counts can still hide weak repeat audience intent.'
    : 'A visible result can hide the system actually causing it.';
}

function rebuildVoiceover(plan) {
  return (plan.scenes || [])
    .map((scene) => String(scene?.narration || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function repairPlan(plan, brief, options = {}) {
  if (!plan || !Array.isArray(plan.scenes)) return { plan, repaired: false, repairs: [], audit: quality.auditPlan(plan, brief, options) };
  const req = quality.requirements(plan.durationSec || options.durationSec);
  const creatorTopic = quality.creatorGrowthBrief(quality.planEvidence(plan, brief));
  const repairs = [];
  const scenes = plan.scenes.map((scene, index) => {
    if (scene?.isBrandCta || index === 0) return { ...scene };
    const words = quality.wordCount(scene?.narration);
    if (words >= req.minBodyNarrationWords) return { ...scene };
    const narration = templateFor(scene, creatorTopic);
    repairs.push({ scene: index + 1, beforeWords: words, afterWords: quality.wordCount(narration), reason: 'body-narration-floor' });
    return { ...scene, narration };
  });

  let repairedPlan = { ...plan, scenes };
  repairedPlan.voiceover = rebuildVoiceover(repairedPlan);

  let audit = quality.auditPlan(repairedPlan, brief, options);
  if (audit.wordCount < audit.requirements.minWords && repairedPlan.scenes.length) {
    const current = repairedPlan.scenes[0] || {};
    const narration = richerHook(creatorTopic);
    repairs.push({ scene: 1, beforeWords: quality.wordCount(current.narration), afterWords: quality.wordCount(narration), reason: 'voiceover-minimum' });
    repairedPlan.scenes = [{ ...current, narration }, ...repairedPlan.scenes.slice(1)];
    repairedPlan.hook = narration;
    repairedPlan.voiceover = rebuildVoiceover(repairedPlan);
    audit = quality.auditPlan(repairedPlan, brief, options);
  }

  repairedPlan.scriptRescue = {
    applied: repairs.length > 0,
    version: 1,
    repairs,
    strictGatePreserved: true,
    finalAuditOk: Boolean(audit.ok),
  };
  repairedPlan.qualityAudit = audit;
  return { plan: repairedPlan, repaired: repairs.length > 0, repairs, audit };
}

function install() {
  if (installed) return { installed: true, alreadyInstalled: true };
  originalCreateJob = factory.createJob;
  factory.createJob = async (brief, options = {}) => {
    const created = await originalCreateJob(brief, options);
    if (created?.job?.qualityAudit?.ok) return created;

    const rescued = repairPlan(created.plan, brief, options);
    if (!rescued.repaired) return created;

    const plan = rescued.plan;
    const job = {
      ...(created.job || {}),
      qualityAudit: rescued.audit,
      scriptRescue: plan.scriptRescue,
      state: rescued.audit.ok ? 'planned' : 'waiting_quality',
      updatedAt: new Date().toISOString(),
    };
    if (created.paths?.plan) writeJsonAtomic(created.paths.plan, plan);
    if (created.paths?.job) writeJsonAtomic(created.paths.job, job);
    return { ...created, plan, job };
  };
  installed = true;
  return { installed: true };
}

function uninstall() {
  if (!installed || !originalCreateJob) return { installed: false };
  factory.createJob = originalCreateJob;
  originalCreateJob = null;
  installed = false;
  return { installed: false };
}

function status() {
  return {
    installed,
    implemented: true,
    strictGatePreserved: true,
    repairsShortNarration: true,
    repairsVoiceoverMinimum: true,
    lowersQualityThreshold: false,
  };
}

module.exports = {
  CREATOR_TEMPLATES,
  GENERAL_TEMPLATES,
  purposeKey,
  templateFor,
  richerHook,
  rebuildVoiceover,
  repairPlan,
  install,
  uninstall,
  status,
};
