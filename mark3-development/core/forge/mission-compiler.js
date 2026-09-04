const crypto = require('crypto');
const governor = require('./model-governor');

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
    acceptance: Array.isArray(job.acceptance) ? job.acceptance.map(String).slice(0, 8) : [],
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
  return rows.map((job) => ({
    ...job,
    dependsOn: (job.dependsOn || []).map((dep) => aliases.get(String(dep)) || String(dep)),
  }));
}
function repairDependencies(jobs) {
  const rows = uniqueJobIds(jobs);
  const ids = new Set(rows.map((job) => job.id));
  return rows.map((job) => ({
    ...job,
    dependsOn: [...new Set((job.dependsOn || []).filter((dep) => dep !== job.id && ids.has(dep)))],
  }));
}
function ensureRunnableDag(jobs) {
  const rows = repairDependencies(jobs);
  if (!rows.length) return rows;

  // A Forge mission must always have at least one runnable root. If a model
  // accidentally makes every job depend on another job, make the first job a root.
  if (!rows.some((job) => !(job.dependsOn || []).length)) rows[0] = { ...rows[0], dependsOn: [] };

  // Kahn-style validation with deterministic cycle repair. Whenever no unresolved
  // job can run, remove only dependencies that point to still-unresolved jobs from
  // the earliest blocked job. This preserves already-valid ordering while breaking
  // the minimum cycle needed to make forward progress.
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
  const jobs = [
    { id: 'requirements', title: 'Mission requirements', objective: `Turn this objective into testable requirements and acceptance criteria: ${objective}`, kind: 'product', worker: 'reasoning', dependsOn: [] },
    { id: 'architecture', title: 'System architecture', objective: 'Design the implementation architecture, module boundaries, data flow and delivery sequence.', kind: 'architect', worker: 'reasoning', dependsOn: ['requirements'] },
    { id: 'core-build', title: 'Core implementation', objective: 'Implement the core working system described by the requirements and architecture.', kind: /automat|workflow|agent/i.test(objective) ? 'automation' : 'backend', worker: 'coding', dependsOn: ['architecture'] },
    { id: 'integration', title: 'Integration pass', objective: 'Integrate the implementation into one coherent runnable system and resolve contract mismatches.', kind: 'integration', worker: 'coding', dependsOn: ['core-build'] },
    { id: 'qa', title: 'QA and validation', objective: 'Run executable validation, test the critical user flows and identify regressions or incomplete requirements.', kind: 'qa', worker: 'review', dependsOn: ['integration'] },
    { id: 'repair', title: 'Repair failures', objective: 'Fix all actionable failures discovered by QA and rerun the relevant validation.', kind: 'integration', worker: 'coding', dependsOn: ['qa'] },
    { id: 'final-review', title: 'Independent final review', objective: 'Independently verify that the mission acceptance criteria are satisfied and report remaining risk.', kind: 'critic', worker: 'review', dependsOn: ['repair'] },
  ].map(normalizeJob);
  return {
    summary: `Build and verify: ${objective}`,
    requirements: [],
    deliverables: ['Runnable implementation', 'Validation evidence', 'Final review'],
    risks: ['Free provider availability can pause inference', 'External side effects require explicit approval'],
    jobs: ensureRunnableDag(jobs),
    compiler: 'deterministic-fallback',
  };
}
function validateGraph(compiled, objective) {
  const source = Array.isArray(compiled?.jobs) && compiled.jobs.length ? compiled.jobs : fallback(objective).jobs;
  let jobs = ensureRunnableDag(source.slice(0, 40).map(normalizeJob));
  const hasCoding = jobs.some((job) => job.worker === 'coding');
  const hasReview = jobs.some((job) => job.worker === 'review');
  if (!hasCoding) jobs.push(normalizeJob({ id: id('build'), title: 'Implementation', objective: 'Implement the mission deliverable.', kind: 'backend', worker: 'coding', dependsOn: jobs.length ? [jobs[jobs.length - 1].id] : [] }, jobs.length));
  if (!hasReview) jobs.push(normalizeJob({ id: id('review'), title: 'Final QA', objective: 'Independently verify the completed mission and identify remaining failures.', kind: 'qa', worker: 'review', dependsOn: jobs.length ? [jobs[jobs.length - 1].id] : [] }, jobs.length));
  jobs = ensureRunnableDag(jobs);
  return {
    summary: String(compiled?.summary || `Build and verify: ${objective}`),
    requirements: Array.isArray(compiled?.requirements) ? compiled.requirements.map(String).slice(0, 20) : [],
    deliverables: Array.isArray(compiled?.deliverables) ? compiled.deliverables.map(String).slice(0, 20) : [],
    risks: Array.isArray(compiled?.risks) ? compiled.risks.map(String).slice(0, 12) : [],
    jobs,
    compiler: compiled?.compiler || 'nvidia-mission-compiler',
  };
}

async function compile(mission) {
  const objective = String(mission?.objective || '').trim();
  if (!objective) throw new Error('Mission objective is required.');
  const system = `You are ULTRON FORGE Mission Compiler. Convert a large project objective into a dependency-aware execution DAG for a multi-agent software/automation team. Return ONLY one JSON object. Keep jobs independently executable and avoid unnecessary model calls. Every mission that builds software must end with QA and an independent review. At least one job must have an empty dependsOn array so execution can start. Dependencies must form an acyclic graph and may only reference earlier prerequisite jobs. Never include production deployment, mass messaging, purchases, destructive database actions or other external side effects without an approval gate. Worker must be reasoning, coding, or review. kind should be one of product, architect, researcher, automation, backend, frontend, database, integration, qa, security, critic. Maximum 24 jobs. Schema: {summary:string,requirements:string[],deliverables:string[],risks:string[],jobs:[{id:string,title:string,objective:string,kind:string,worker:string,dependsOn:string[],acceptance:string[]}]}`;
  try {
    const result = await governor.nvidiaChat({
      missionId: mission.id,
      role: 'mission_compile',
      json: true,
      temperature: 0.15,
      maxTokens: 7000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `MISSION: ${objective}\nCONSTRAINTS: zero monetary cost, no local LLM, cloud free inference only, checkpointed execution, evidence-based completion. Workspace: ${mission.workspace}` },
      ],
    });
    const parsed = JSON.parse(cleanJson(result.text));
    return { ...validateGraph(parsed, objective), model: result.model, provider: result.provider };
  } catch (error) {
    const value = fallback(objective);
    return { ...value, compilerError: error.message };
  }
}

module.exports = { compile, fallback, validateGraph, cleanJson, normalizeJob, repairDependencies, ensureRunnableDag };
