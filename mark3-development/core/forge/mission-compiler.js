const crypto = require('crypto');
const governor = require('./model-governor');
const preferences = require('./preferences');

function id(prefix = 'job') { return `${prefix}-${crypto.randomUUID()}`; }
function cleanJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  return first >= 0 && last > first ? raw.slice(first, last + 1) : raw;
}
function normalizeJob(job, index) {
  return {
    id: String(job.id || `job-${index + 1}`).replace(/[^a-zA-Z0-9._-]/g, '-'),
    title: String(job.title || job.objective || `Job ${index + 1}`).trim(),
    objective: String(job.objective || job.title || '').trim(),
    kind: String(job.kind || job.agentKind || 'backend').toLowerCase(),
    worker: ['reasoning', 'coding', 'review'].includes(String(job.worker || '').toLowerCase()) ? String(job.worker).toLowerCase() : undefined,
    modelRole: job.modelRole ? String(job.modelRole) : undefined,
    dependsOn: Array.isArray(job.dependsOn) ? job.dependsOn.map(String) : [],
    acceptance: Array.isArray(job.acceptance) ? job.acceptance.map(String).slice(0, 10) : [],
    status: 'pending',
    attempts: 0,
    output: null,
    evidence: [],
  };
}
function uniqueJobIds(jobs) {
  const used = new Set();
  const aliases = new Map();
  const rows = jobs.map((job, index) => {
    const original = String(job.id || `job-${index + 1}`);
    let next = original;
    let suffix = 2;
    while (used.has(next)) next = `${original}-${suffix++}`;
    used.add(next);
    if (!aliases.has(original)) aliases.set(original, next);
    return { ...job, id: next };
  });
  return rows.map((job) => ({ ...job, dependsOn: (job.dependsOn || []).map((dep) => aliases.get(String(dep)) || String(dep)) }));
}
function repairDependencies(jobs) {
  const rows = uniqueJobIds(jobs);
  const ids = new Set(rows.map((job) => job.id));
  return rows.map((job) => ({ ...job, dependsOn: [...new Set((job.dependsOn || []).filter((dep) => dep !== job.id && ids.has(dep)))] }));
}
function ensureRunnableDag(jobs) {
  const rows = repairDependencies(jobs);
  if (!rows.length) return rows;
  if (!rows.some((job) => !(job.dependsOn || []).length)) rows[0] = { ...rows[0], dependsOn: [] };
  const resolved = new Set();
  const unresolved = new Set(rows.map((job) => job.id));
  while (unresolved.size) {
    let progressed = false;
    for (const job of rows) {
      if (!unresolved.has(job.id)) continue;
      if ((job.dependsOn || []).every((dep) => resolved.has(dep))) {
        unresolved.delete(job.id);
        resolved.add(job.id);
        progressed = true;
      }
    }
    if (progressed) continue;
    const blocked = rows.find((job) => unresolved.has(job.id));
    if (!blocked) break;
    blocked.dependsOn = (blocked.dependsOn || []).filter((dep) => resolved.has(dep));
  }
  return rows;
}

function fallback(objective) {
  const profile = preferences.classify(objective);
  const jobs = preferences.fallbackJobs(objective, profile).map(normalizeJob);
  return {
    summary: `${profile.label}: ${objective}`,
    requirements: [`Forge profile: ${profile.id}`, profile.principle],
    deliverables: ['Working implementation or verified repair', 'Executable validation evidence', 'Honest remaining-blocker report'],
    risks: ['Free provider availability can pause inference', 'External side effects require explicit approval'],
    jobs: ensureRunnableDag(jobs),
    compiler: `deterministic-${profile.id}`,
    forgeProfile: profile.id,
  };
}

function validateGraph(compiled, objective) {
  const profile = preferences.classify(objective);
  const source = Array.isArray(compiled?.jobs) && compiled.jobs.length ? compiled.jobs : fallback(objective).jobs;
  let jobs = ensureRunnableDag(source.slice(0, profile.maxJobs).map(normalizeJob));
  const hasCoding = jobs.some((job) => job.worker === 'coding');
  const hasReview = jobs.some((job) => job.worker === 'review');
  if (!hasCoding) jobs.push(normalizeJob({ id: id('build'), title: 'Implementation', objective: 'Implement the mission deliverable in the existing working system.', kind: 'integration', worker: 'coding', dependsOn: jobs.length ? [jobs[jobs.length - 1].id] : [], acceptance: ['Implement real files/code', 'Preserve existing working behavior', 'Run executable validation'] }, jobs.length));
  if (!hasReview) jobs.push(normalizeJob({ id: id('review'), title: 'Independent QA', objective: 'Independently verify the completed mission against the user-visible behavior and regression boundaries.', kind: 'qa', worker: 'review', dependsOn: jobs.length ? [jobs[jobs.length - 1].id] : [], acceptance: ['Return explicit evidence-based verdict'] }, jobs.length));
  jobs = ensureRunnableDag(jobs.slice(0, Math.max(profile.maxJobs, 3)));
  return {
    summary: String(compiled?.summary || `${profile.label}: ${objective}`),
    requirements: Array.isArray(compiled?.requirements) ? compiled.requirements.map(String).slice(0, 20) : [],
    deliverables: Array.isArray(compiled?.deliverables) ? compiled.deliverables.map(String).slice(0, 20) : [],
    risks: Array.isArray(compiled?.risks) ? compiled.risks.map(String).slice(0, 12) : [],
    jobs,
    compiler: compiled?.compiler || 'nvidia-mission-compiler',
    forgeProfile: profile.id,
  };
}

async function compile(mission) {
  const objective = String(mission?.objective || '').trim();
  if (!objective) throw new Error('Mission objective is required.');
  const profile = preferences.classify(objective);
  const system = [
    'You are ULTRON FORGE Mission Compiler. Convert the objective into a lean dependency-aware execution DAG.',
    'Return ONLY one JSON object. Prefer fewer strong jobs over many tiny model-heavy jobs.',
    preferences.compilerGuidance(objective),
    'Every software mission must include real implementation and evidence-based review. Documentation-only work does not count as implementation.',
    'At least one job must have an empty dependsOn array. Dependencies must form an acyclic graph and may only reference real prerequisite jobs.',
    'Never include production deployment, mass messaging, purchases, destructive database actions or other external side effects without an approval gate.',
    'Worker must be reasoning, coding, or review. kind should be one of product, architect, researcher, automation, backend, frontend, database, integration, qa, security, critic.',
    `Hard maximum ${profile.maxJobs} jobs for this mission profile.`,
    'Schema: {summary:string,requirements:string[],deliverables:string[],risks:string[],jobs:[{id:string,title:string,objective:string,kind:string,worker:string,dependsOn:string[],acceptance:string[]}]}',
  ].join(' ');
  try {
    const result = await governor.nvidiaChat({
      missionId: mission.id,
      role: 'mission_compile',
      json: true,
      temperature: 0.12,
      maxTokens: 5000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `MISSION: ${objective}\nFORGE PROFILE: ${profile.id}\nCONSTRAINTS: zero monetary cost; no local LLM; cloud free inference only; preserve existing working systems; deterministic tools before AI where possible; checkpointed execution; evidence-based completion; approval-gated external actions. Workspace: ${mission.workspace}` },
      ],
    });
    const parsed = JSON.parse(cleanJson(result.text));
    return { ...validateGraph(parsed, objective), model: result.model, provider: result.provider, forgeProfile: profile.id };
  } catch (error) {
    const value = fallback(objective);
    return { ...value, compilerError: error.message };
  }
}

module.exports = { compile, fallback, validateGraph, cleanJson, normalizeJob, repairDependencies, ensureRunnableDag };
