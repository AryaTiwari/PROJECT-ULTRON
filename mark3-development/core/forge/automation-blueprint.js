const crypto = require('crypto');

function isAutomationObjective(text) {
  return /\b(?:automat(?:e|ed|ion)|workflow|pipeline|scheduled job|webhook|agentic process|background job|integration flow|sync job|bot)\b/i.test(String(text || ''));
}

function systemsFrom(text) {
  const value = String(text || '');
  const known = [
    ['instagram', /\binstagram\b/i],
    ['whatsapp', /\bwhats?app\b/i],
    ['gmail', /\bgmail|email\b/i],
    ['google-calendar', /\bgoogle calendar|calendar\b/i],
    ['supabase', /\bsupabase\b/i],
    ['github', /\bgithub\b/i],
    ['browser', /\bbrowser|website|web\b/i],
    ['google-sheets', /\bgoogle sheets?|sheet\b/i],
    ['slack', /\bslack\b/i],
    ['discord', /\bdiscord\b/i],
  ];
  return known.filter(([, re]) => re.test(value)).map(([name]) => name);
}

function triggerFrom(text) {
  const value = String(text || '');
  if (/\bwhen(?:ever)?\b|\bon\s+(?:new|incoming|received|created|updated)\b/i.test(value)) return 'event';
  if (/\bevery\s+(?:day|hour|week|month)|\bdaily\b|\bweekly\b|\bhourly\b|\bschedule(?:d)?\b/i.test(value)) return 'schedule';
  if (/\bwebhook\b|\bform\s+(?:submit|submission)\b/i.test(value)) return 'webhook';
  return 'manual-or-api';
}

function create(objective) {
  const text = String(objective || '').trim();
  if (!text) throw new Error('Automation objective is required.');
  return {
    id: `automation-${crypto.randomUUID()}`,
    objective: text,
    trigger: triggerFrom(text),
    systems: systemsFrom(text),
    runtime: 'lightweight-node',
    delivery: {
      executableProgram: true,
      localLlm: false,
      paidInference: false,
      dryRunRequired: true,
      restartSafe: true,
    },
    contracts: {
      inputValidation: true,
      idempotencyKey: true,
      persistentCheckpoint: true,
      boundedRetries: true,
      exponentialBackoff: true,
      deadLetterOrFailureState: true,
      structuredLogs: true,
      healthStatus: true,
      secretEnvOnly: true,
      externalSideEffectsApproval: true,
    },
    requiredArtifacts: [
      'automation.manifest.json',
      'README.md',
      '.env.example',
      'executable entrypoint',
      'persistent state/checkpoint implementation',
      'dry-run command',
      'validation/test command',
    ],
    createdAt: new Date().toISOString(),
  };
}

function workerInstruction(objective) {
  if (!isAutomationObjective(objective)) return '';
  const spec = create(objective);
  return [
    'AUTOMATION PROGRAM CONTRACT:',
    JSON.stringify(spec),
    'Build an actual executable automation program, not only documentation or pseudo-code.',
    'Keep connector implementations behind interfaces so Step 5 integrations can be plugged in without rewriting orchestration.',
    'External network writes, mass messaging, production deployment, purchases and destructive actions must stay disabled or dry-run until explicitly approved.',
    'The program must survive restart from persisted checkpoints, prevent duplicate side effects, expose structured failure state, and have a deterministic validation path.',
  ].join('\n');
}

module.exports = { isAutomationObjective, systemsFrom, triggerFrom, create, workerInstruction };
