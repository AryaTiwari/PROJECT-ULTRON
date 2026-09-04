const crypto = require('crypto');

const PRESETS = {
  product: {
    title: 'Product Analyst',
    modelRole: 'architecture',
    worker: 'reasoning',
    instructions: 'Translate the mission into concrete user outcomes, requirements, constraints and acceptance criteria. Remove ambiguity before implementation.',
  },
  architect: {
    title: 'Systems Architect',
    modelRole: 'architecture',
    worker: 'reasoning',
    instructions: 'Design the smallest robust architecture that satisfies the mission. Define components, interfaces, data flows, risks and implementation order.',
  },
  automation: {
    title: 'Automation Engineer',
    modelRole: 'automation',
    worker: 'coding',
    instructions: 'Build reliable automations with idempotency, checkpoints, observable failures and safe retries. Prefer deterministic program logic over unnecessary model calls.',
  },
  backend: {
    title: 'Backend Engineer',
    modelRole: 'code_build',
    worker: 'coding',
    instructions: 'Implement backend logic, APIs, persistence and integrations. Preserve working behavior and prove changes with executable validation.',
  },
  frontend: {
    title: 'Frontend Engineer',
    modelRole: 'code_build',
    worker: 'coding',
    instructions: 'Implement usable frontend/UI work consistent with the project architecture. Avoid breaking existing flows and validate the built interface.',
  },
  database: {
    title: 'Database Architect',
    modelRole: 'code_build',
    worker: 'coding',
    instructions: 'Design and implement schemas, migrations, constraints and data access safely. Prefer reversible migrations and verify invariants.',
  },
  integration: {
    title: 'Integration Engineer',
    modelRole: 'code_build',
    worker: 'coding',
    instructions: 'Integrate independently built components, resolve contract mismatches, run end-to-end validation and preserve unrelated working systems.',
  },
  qa: {
    title: 'QA Engineer',
    modelRole: 'code_review',
    worker: 'review',
    instructions: 'Act adversarially. Test the requested behavior, identify regressions, missing edge cases and unproven claims. Do not approve work without evidence.',
  },
  security: {
    title: 'Security Reviewer',
    modelRole: 'code_review',
    worker: 'review',
    instructions: 'Review authentication, authorization, secrets, data exposure, command execution and unsafe side effects. Require concrete fixes for serious findings.',
  },
  critic: {
    title: 'Independent Critic',
    modelRole: 'code_review',
    worker: 'review',
    instructions: 'Independently challenge whether the deliverable actually satisfies the mission. Look for missing requirements, fake completion and weak verification.',
  },
  researcher: {
    title: 'Research Analyst',
    modelRole: 'architecture',
    worker: 'reasoning',
    instructions: 'Collect only information required to unblock the mission and turn it into concise decisions or implementation inputs.',
  },
};

function normalizeKind(kind) {
  const value = String(kind || '').toLowerCase();
  if (PRESETS[value]) return value;
  if (/front|ui|ux|react|css/.test(value)) return 'frontend';
  if (/back|api|server/.test(value)) return 'backend';
  if (/data|sql|supabase|schema/.test(value)) return 'database';
  if (/automat|workflow|agent/.test(value)) return 'automation';
  if (/integrat|merge/.test(value)) return 'integration';
  if (/security|auth/.test(value)) return 'security';
  if (/test|qa|verify/.test(value)) return 'qa';
  if (/review|critic/.test(value)) return 'critic';
  if (/research/.test(value)) return 'researcher';
  if (/architect|design|plan/.test(value)) return 'architect';
  return 'backend';
}

function create(job, mission) {
  const kind = normalizeKind(job?.agentKind || job?.kind || job?.type);
  const preset = PRESETS[kind];
  return {
    id: `agent-${crypto.randomUUID()}`,
    missionId: mission.id,
    jobId: job.id,
    kind,
    title: preset.title,
    worker: job.worker || preset.worker,
    modelRole: job.modelRole || preset.modelRole,
    objective: job.objective || job.title,
    instructions: `${preset.instructions} Work only on your assigned job. Use the mission context and predecessor outputs, not unrelated assumptions.`,
    permissions: {
      readWorkspace: true,
      writeWorkspace: ['coding'].includes(job.worker || preset.worker),
      runValidation: ['coding', 'review'].includes(job.worker || preset.worker),
      externalSideEffects: false,
    },
    completion: job.acceptance || ['Produce a concrete deliverable', 'Provide verification evidence or explicitly state what remains unverified'],
    createdAt: new Date().toISOString(),
    status: 'ready',
  };
}

function staff(jobs, mission) {
  return (Array.isArray(jobs) ? jobs : []).map((job) => create(job, mission));
}

module.exports = { PRESETS, normalizeKind, create, staff };
