const { z } = require('zod');
const direct = require('./direct-provider-router');

const COMPILER_MODEL = String(process.env.ULTRON_M3_LINKEDIN_COMPILER_MODEL || 'gemini/gemini-3.6-flash').trim();
const COMPILER_TIMEOUT_MS = Math.max(5000, Number(process.env.ULTRON_M3_LINKEDIN_COMPILER_TIMEOUT_MS || 15000));

const MissionIR = z.object({
  entityMode: z.enum(['company', 'person']).default('company'),
  targetMode: z.enum(['additional', 'master_total']).default('additional'),
  targetValue: z.number().int().min(1).max(100),
  topic: z.string().trim().min(1).max(120).nullable().default(null),
  hiringRequired: z.boolean().default(false),
  locationScope: z.enum(['job', 'company']).default('job'),
  allowedLocations: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  preferredLocations: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  employeeMin: z.number().int().min(0).max(10000000).nullable().default(null),
  employeeMax: z.number().int().min(0).max(10000000).nullable().default(null),
  workType: z.enum(['remote', 'hybrid', 'on_site']).nullable().default(null),
  workTypeStrictness: z.enum(['none', 'preference', 'hard']).default('none'),
  jobType: z.enum(['full_time', 'part_time', 'contract', 'temporary', 'volunteer', 'internship', 'other']).nullable().default(null),
  experienceLevel: z.enum(['internship', 'entry', 'associate', 'mid_senior', 'director', 'executive']).nullable().default(null),
  datePosted: z.enum(['past_hour', 'past_24_hours', 'past_week', 'past_month']).nullable().default(null),
  easyApply: z.boolean().default(false),
  useFinalMaster: z.boolean().default(false),
  resumeExistingPool: z.boolean().default(false),
  reuseCachedEvidence: z.boolean().default(false),
  wantsContacts: z.boolean().default(false),
  linkedinOnly: z.literal(true).default(true),
}).superRefine((value, ctx) => {
  if (value.employeeMin != null && value.employeeMax != null && value.employeeMin > value.employeeMax) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['employeeMax'], message: 'employeeMax must be >= employeeMin' });
  }
  if (value.targetMode === 'master_total' && !value.useFinalMaster) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['useFinalMaster'], message: 'master_total requires useFinalMaster=true' });
  }
  if (!value.workType) value.workTypeStrictness = 'none';
});

function hasGeminiCredential() {
  return ['GEMINI_API_KEY', 'GEMINI_API_KEY2', 'GOOGLE_API_KEY', 'GOOGLE_API_KEY2']
    .some((key) => Boolean(String(process.env[key] || '').trim()));
}

function uniq(values = []) {
  const seen = new Set();
  return values.map((value) => String(value || '').trim()).filter(Boolean).filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeLocation(value) {
  const raw = String(value || '').trim();
  if (/^bangalore$/i.test(raw)) return 'Bengaluru';
  return raw;
}

function normalizedIR(raw) {
  const parsed = MissionIR.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
      issues: parsed.error.issues,
    };
  }
  const value = parsed.data;
  value.allowedLocations = uniq(value.allowedLocations.map(normalizeLocation));
  value.preferredLocations = uniq(value.preferredLocations.map(normalizeLocation));
  if (!value.preferredLocations.length && value.allowedLocations.length) value.preferredLocations = [...value.allowedLocations];
  if (!value.allowedLocations.length && value.preferredLocations.length) value.allowedLocations = [...value.preferredLocations];
  return { ok: true, value };
}

function shouldCompile(text) {
  const value = String(text || '').trim();
  if (!/\blinkedin\b|linkedin\.com\//i.test(value)) return false;
  if (!/\b(?:find|get|search|research|source|collect|bring|list|show|extract|discover|companies?|company|people|profiles?|jobs?|roles?|hiring|recruiters?|founders?|leads?)\b/i.test(value)) return false;
  return true;
}

function canonicalPrompt(ir) {
  const lines = ['LinkedIn only.'];
  if (ir.targetMode === 'master_total') {
    lines.push(`Find enough new unique ${ir.entityMode === 'company' ? 'companies' : 'people'} to make my Final Master reach exactly ${ir.targetValue} verified ${ir.entityMode === 'company' ? 'companies' : 'people'} total.`);
  } else {
    lines.push(`Find ${ir.targetValue} ${ir.entityMode === 'company' ? 'companies' : 'people'} on LinkedIn.`);
  }

  if (ir.topic) {
    if (ir.hiringRequired && ir.entityMode === 'company') lines.push(`Every company must have an active ${ir.topic} job opening.`);
    else lines.push(`Topic or role: ${ir.topic}.`);
  } else if (ir.hiringRequired) {
    lines.push('Every company must have an active job opening matching the requested role.');
  }

  if (ir.allowedLocations.length) {
    lines.push(`Allowed ${ir.locationScope === 'company' ? 'company' : 'job'} locations only: ${ir.allowedLocations.join(', ')}.`);
  }
  if (ir.preferredLocations.length) lines.push(`Location priority: ${ir.preferredLocations.join(' then ')}.`);
  if (ir.employeeMin != null) lines.push(`Minimum ${ir.employeeMin} employees.`);
  if (ir.employeeMax != null) lines.push(`Maximum ${ir.employeeMax} employees.`);

  if (ir.workType) {
    const label = ir.workType === 'on_site' ? 'on-site' : ir.workType;
    if (ir.workTypeStrictness === 'preference') lines.push(`Prefer ${label}; it is a preference only, not mandatory.`);
    else if (ir.workTypeStrictness === 'hard') lines.push(`${label} only.`);
  }

  if (ir.jobType) lines.push(`Job type: ${ir.jobType.replace(/_/g, ' ')}.`);
  if (ir.experienceLevel) lines.push(`Experience level: ${ir.experienceLevel.replace(/_/g, ' ')}.`);
  if (ir.datePosted) lines.push(`Date posted: ${ir.datePosted.replace(/_/g, ' ')}.`);
  if (ir.easyApply) lines.push('Easy Apply only.');

  if (ir.resumeExistingPool || ir.reuseCachedEvidence) {
    lines.push('Reuse saved discovery, cached evidence and previously rejected compatible candidates before fresh LinkedIn calls.');
  }
  if (ir.useFinalMaster) lines.push('Use my canonical Final Master and deduplicate against it.');
  if (!ir.wantsContacts) lines.push('Do not use Apollo or contact enrichment unless I request it separately.');

  return lines.join(' ');
}

function toolSpec() {
  return [{
    type: 'function',
    function: {
      name: 'compile_linkedin_request',
      description: 'Compile the user\'s LinkedIn research request into a strict mission contract. Do not execute research.',
      parameters: z.toJSONSchema(MissionIR, { io: 'input', target: 'draft-2020-12' }),
    },
  }];
}

function parseCandidate(result) {
  const calls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
  const call = calls.find((item) => item?.function?.name === 'compile_linkedin_request');
  if (call) {
    try {
      return typeof call.function.arguments === 'string'
        ? JSON.parse(call.function.arguments)
        : call.function.arguments;
    } catch {}
  }

  const text = String(result?.content || '').trim();
  if (!text) return null;
  const fenced = text.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i);
  const candidate = fenced ? fenced[1].trim() : text;
  try { return JSON.parse(candidate); } catch {}
  const object = candidate.match(/\{[\s\S]*\}/);
  if (!object) return null;
  try { return JSON.parse(object[0]); } catch { return null; }
}

async function compile(text) {
  if (!shouldCompile(text)) return { ok: false, skipped: true, reason: 'not_linkedin_research' };
  if (!hasGeminiCredential()) return { ok: false, skipped: true, reason: 'direct_gemini_not_configured' };

  const messages = [
    {
      role: 'system',
      content: [
        'You are a deterministic compiler for LinkedIn research commands.',
        'Do not research LinkedIn. Do not answer the request.',
        'Call compile_linkedin_request exactly once with the normalized mission.',
        'Separate hard constraints from preferences precisely.',
        'Words such as prefer, preferred, ideally, priority, not mandatory, preference only mean a preference.',
        'Words such as only, must, required, mandatory, maximum, minimum mean hard constraints.',
        'If the user asks to reach a total in a Final Master, use targetMode=master_total and useFinalMaster=true.',
        'If the user asks to reuse saved discovery/cache, set resumeExistingPool and reuseCachedEvidence true.',
        'If the user explicitly says no Apollo or leaves contact enrichment for later, wantsContacts=false.',
        'linkedinOnly must always be true.',
      ].join(' '),
    },
    { role: 'user', content: String(text || '') },
  ];

  try {
    const result = await require('./command-control-plane').compileWithGemini(() => direct.chat({
      messages,
      model: COMPILER_MODEL,
      tools: toolSpec(),
      taskType: 'automation',
      timeoutMs: COMPILER_TIMEOUT_MS,
    }));
    const raw = parseCandidate(result);
    if (!raw) return { ok: false, reason: 'compiler_returned_no_structured_contract', model: result?.model || COMPILER_MODEL };
    const validated = normalizedIR(raw);
    if (!validated.ok) return { ...validated, reason: 'compiler_contract_invalid', model: result?.model || COMPILER_MODEL };
    return {
      ok: true,
      ir: validated.value,
      canonicalPrompt: canonicalPrompt(validated.value),
      model: result?.model || COMPILER_MODEL,
      provider: result?.provider || 'gemini',
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'compiler_provider_failed',
      error: String(error?.message || error),
      code: error?.code || null,
      model: COMPILER_MODEL,
    };
  }
}

module.exports = {
  MissionIR,
  COMPILER_MODEL,
  COMPILER_TIMEOUT_MS,
  hasGeminiCredential,
  shouldCompile,
  normalizedIR,
  canonicalPrompt,
  toolSpec,
  parseCandidate,
  compile,
};
