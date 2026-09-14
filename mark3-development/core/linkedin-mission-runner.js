const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config');
const events = require('./events');
const policy = require('./linkedin-account-policy');
const finalMaster = require('./linkedin-final-master');
const context = new AsyncLocalStorage();
const root = path.join(config.projectRoot, '.ultron', 'linkedin-missions');
let running = false;
let executor;
const queue = [];
let wakeTimer = null;

function queueOnce(id) {
  if (!queue.includes(id)) queue.push(id);
}

function schedulePumpAt(iso) {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at)) return setImmediate(pump);
  const delay = Math.max(0, at - Date.now());
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    pump();
  }, Math.min(delay, 0x7fffffff));
}

function isSafetyWaitCode(code) {
  return /LINKEDIN_(?:COOLDOWN|BURST_CAP|HOURLY_CAP|DAILY_CAP|RATE_LIMIT)/i.test(String(code || ''));
}

function parkForSafety(mission, error = null) {
  const code = String(error?.code || mission.stopCode || 'LINKEDIN_SAFETY_WAIT');
  if (!isSafetyWaitCode(code)) return false;

  const configured = Date.parse(String(error?.cooldownUntil || ''));
  const policyNext = Date.parse(String(policy.nextEligibleAt?.() || ''));
  const testRuntime = Boolean(policy.runtimeAllowsTestBypass?.());
  const minGap = testRuntime
    ? 25
    : Math.max(1000, Number(policy.settings?.().minGapMs || 9000));
  const fallback = Date.now() + minGap;
  const nextMs = Math.max(
    Number.isFinite(configured) ? configured : 0,
    Number.isFinite(policyNext) ? policyNext : 0,
    fallback
  );
  const nextAt = new Date(nextMs).toISOString();

  mission.status = 'waiting_safety';
  mission.notBefore = nextAt;
  mission.stopCode = code;
  mission.error = error ? { code, message: String(error.message || code) } : mission.error || null;
  mission.progress = {
    ...(mission.progress || {}),
    phase: 'waiting_safety',
    autoContinue: true,
    nextEligibleAt: nextAt,
    safetyReason: error?.message || mission.progress?.safetyReason || code,
  };
  save(mission);
  queueOnce(mission.id);
  schedulePumpAt(nextAt);
  return true;
}

function file(id) {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('Invalid mission ID');
  return path.join(root, `${id}.json`);
}
function get(id) { return JSON.parse(fs.readFileSync(file(id), 'utf8')); }
function save(mission, preserveControl = true) {
  fs.mkdirSync(root, { recursive: true });
  mission.updatedAt = new Date().toISOString();
  const target = file(mission.id);
  if (preserveControl && fs.existsSync(target)) mission.control = get(mission.id).control || null;
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(mission));
  fs.renameSync(`${target}.tmp`, target);
  events.emit('linkedin:progress', summary(mission));
}
function summary(m) {
  return { id: m.id, status: m.status, updatedAt: m.updatedAt, calls: m.calls || 0,
    cacheHits: m.cacheHits || 0, progress: m.progress || null,
    contract: m.prepared?.request?.missionContract || null,
    error: m.error || null, result: m.result || null };
}
function list() {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(n => n.endsWith('.json')).map(n => get(n.slice(0, -5)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function missionSignature(prepared = {}) {
  const request = prepared?.request || {};
  const contract = request.missionContract || {};
  const hard = contract.hard || {};
  const preferences = contract.preferences || {};
  const target = contract.target || {};
  return JSON.stringify({
    entityMode: request.entityMode || contract.entityMode || '',
    topic: String(request.topic || contract.topic || '').trim().toLowerCase(),
    targetMode: request.targetMode || target.mode || 'additional',
    targetValue: Number(request.targetTotal || target.value || request.count || 0),
    locations: (request.allowedLocations || hard.locations || []).map((x) => String(x).trim().toLowerCase()),
    preferredLocations: (request.preferredLocations || preferences.locations || []).map((x) => String(x).trim().toLowerCase()),
    employeeMin: request.filters?.employeeMin ?? hard.employeeMin ?? null,
    employeeMax: request.filters?.employeeMax ?? hard.employeeMax ?? null,
    workType: request.filters?.workType ?? hard.workType ?? null,
    preferredWorkType: request.preferredWorkType ?? preferences.workType ?? null,
    hiring: Boolean(request.hiring ?? hard.hiringRequired),
    destination: request.destinationSheetUrl || contract.output?.destinationSheetUrl || null,
    allowSeen: Boolean(request.allowPreviouslySeenCompanies || contract.dedupe?.allowPreviouslySeen),
  });
}

function equivalentActiveMission(prepared = {}) {
  const signature = missionSignature(prepared);
  return list().find((mission) =>
    ['created', 'searching', 'writing_sheet', 'waiting_safety'].includes(mission.status)
    && (mission.signature || missionSignature(mission.prepared)) === signature
  ) || null;
}
function start(fn) {
  executor = fn;
  const missions = list();
  const newestLegacySafetyPause = missions.find((mission) => mission.status === 'paused_rate_limit') || null;

  for (const m of missions) {
    if (m.status === 'waiting_safety') {
      queueOnce(m.id);
      schedulePumpAt(m.notBefore);
      continue;
    }

    // Migrate only the newest mission parked by older builds. Reviving every
    // historical safety pause would create a surprise backlog and waste the
    // next safe LinkedIn window.
    if (m.status === 'paused_rate_limit') {
      if (!newestLegacySafetyPause || m.id !== newestLegacySafetyPause.id) {
        m.status = 'paused';
        m.progress = {
          ...(m.progress || {}),
          phase: 'paused',
          migrationNote: 'Older rate-limited mission left paused to avoid automatic duplicate backlog.',
        };
        save(m);
        continue;
      }

      const nextAt = policy.nextEligibleAt?.()
        || new Date(Date.now() + Math.max(1000, Number(policy.settings?.().minGapMs || 9000))).toISOString();
      m.status = 'waiting_safety';
      m.notBefore = nextAt;
      m.progress = {
        ...(m.progress || {}),
        phase: 'waiting_safety',
        autoContinue: true,
        nextEligibleAt: nextAt,
        safetyReason: m.error?.message || 'Migrated from a previous safety pause.',
      };
      save(m);
      queueOnce(m.id);
      schedulePumpAt(nextAt);
      continue;
    }

    if (['created', 'searching', 'writing_sheet'].includes(m.status)) {
      // Never replay possibly committed Sheet writes automatically.
      m.status = 'paused_restart';
      save(m);
    }
  }
}
function enqueue(prepared) {
  const existing = equivalentActiveMission(prepared);
  if (existing) return { ...summary(existing), alreadyActive: true };

  if (queue.length >= 20) throw new Error('LINKEDIN_QUEUE_FULL');
  const m = { id: randomUUID(), createdAt: new Date().toISOString(), status: 'created',
    signature: missionSignature(prepared),
    prepared, calls: 0, cacheHits: 0, responses: {}, research: null, followups: [], progress: { phase: 'queued' } };
  save(m);
  queueOnce(m.id);
  setImmediate(pump);
  return summary(m);
}
async function pump() {
  if (running || !executor || !queue.length) return;
  const m = get(queue.shift());

  if (m.status === 'waiting_safety') {
    if (m.control) {
      m.status = m.control === 'cancel' ? 'cancelled' : 'paused';
      save(m);
      return setImmediate(pump);
    }
    const notBefore = Date.parse(String(m.notBefore || ''));
    if (Number.isFinite(notBefore) && notBefore > Date.now()) {
      queueOnce(m.id);
      schedulePumpAt(m.notBefore);
      return;
    }
    m.status = 'created';
    m.notBefore = null;
    m.stopCode = null;
    m.error = null;
    m.progress = {
      ...(m.progress || {}),
      phase: 'resuming',
      nextEligibleAt: null,
      safetyReason: null,
    };
    save(m);
  }

  if (m.status !== 'created') return setImmediate(pump);
  running = true;
  try {
    m.status = 'searching'; save(m);
    m.discoveryReplayed = false;
    const result = await context.run(m, () => executor(m.prepared));
    m.result = result;
    const mission = result?.linkedinMission;
    const request = m.prepared?.request || {};
    const targetTotal = request.targetMode === 'master_total' ? Number(request.targetTotal || 0) : 0;
    const currentMaster = targetTotal > 0 ? finalMaster.masterCount() : 0;
    const remainingTarget = targetTotal > 0 ? Math.max(0, targetTotal - currentMaster) : 0;
    const priorMaster = Number(m.lastMasterCount ?? request.masterTarget?.current ?? currentMaster);
    const madeProgress = currentMaster > priorMaster;
    const budgetLimited = Boolean(mission?.budgetStopped);
    m.stagnantBatches = remainingTarget > 0
      ? (madeProgress ? 0 : budgetLimited ? Number(m.stagnantBatches || 0) : Number(m.stagnantBatches || 0) + 1)
      : 0;
    m.lastMasterCount = currentMaster;

    const safetyLocked = /CHECKPOINT|MANUAL_LOCK/.test(String(m.stopCode || '')) || Boolean(mission?.safety?.manualLock);
    const canAutoContinue = targetTotal > 0
      && remainingTarget > 0
      && request.autoContinue !== false
      && !safetyLocked
      && Number(m.continuationCount || 0) < 30
      && Number(m.stagnantBatches || 0) < 3;

    if (canAutoContinue) {
      const nextAt = policy.nextEligibleAt();
      if (nextAt) {
        m.researchHistory = [...(m.researchHistory || []), {
          at: new Date().toISOString(),
          found: Number(mission?.found || 0),
          added: Number(mission?.added || 0),
          masterCount: currentMaster,
          remainingTarget,
          budgetStopped: mission?.budgetStopped || null,
        }].slice(-20);
        m.research = null;
        m.continuationCount = Number(m.continuationCount || 0) + 1;
        m.prepared.request.continueFromPrevious = true;
        m.prepared.request.resumeExistingPool = true;
        m.status = 'waiting_safety';
        m.notBefore = nextAt;
        m.stopCode = null;
        m.error = null;
        m.progress = {
          ...(m.progress || {}),
          phase: 'waiting_safety',
          autoContinue: true,
          continuationCount: m.continuationCount,
          masterCurrent: currentMaster,
          targetTotal,
          remaining: remainingTarget,
          nextEligibleAt: nextAt,
        };
        save(m);
        queueOnce(m.id);
        schedulePumpAt(nextAt);
        return;
      }
    }

    const noApollo = /\b(?:no\s+apollo|without\s+apollo|do\s+not\s+use\s+apollo)\b/i.test(m.prepared?.request?.originalMessage || '');
    const apolloFollowup = !noApollo && (m.followups || []).find((item) => item?.type === 'apollo-enrichment' && item.status === 'queued');
    if (apolloFollowup && mission?.contactCandidates > 0) {
      const paidTools = require('./paid-tool-approval');
      const approval = paidTools.request(
        'apollo',
        'linkedin-account-enrichment',
        { url: mission.sheetUrl, provider: 'google', ensureContactColumns: false, missionId: mission.id, entityMode: mission.request?.entityMode },
        `LinkedIn research is now stable. Apollo would enrich ${mission.contactCandidates} verified company lead${mission.contactCandidates === 1 ? '' : 's'} from this mission with one highest-priority verified decision-maker each.`
      );
      result.text = `${result.text} ${paidTools.prompt(approval)}`;
      result.response = result.text;
      result.paidToolApproval = { id: approval.id, tool: approval.tool, operation: approval.operation, expiresAt: approval.expiresAt };
      apolloFollowup.status = 'approval_requested';
      apolloFollowup.approvalId = approval.id;
    }
    m.status = /COOLDOWN|CAP|RATE_LIMIT/.test(m.stopCode || '') ? 'paused_rate_limit'
      : mission && (mission.budgetStopped || mission.found < mission.requested) ? 'partial' : 'completed';
    save(m);
    events.emit('linkedin:complete', summary(m));
  } catch (error) {
    const code = String(error.code || error.message || 'LINKEDIN_MISSION_FAILED');
    m.error = { code, message: String(error.message || code) };

    if (isSafetyWaitCode(code) && !/CHECKPOINT|MANUAL_LOCK/.test(code)) {
      parkForSafety(m, error);
      return;
    }

    m.status = /CHECKPOINT|MANUAL_LOCK/.test(code) ? 'paused_checkpoint'
      : code === 'LINKEDIN_MISSION_PAUSED' ? 'paused'
        : code === 'LINKEDIN_MISSION_CANCELLED' ? 'cancelled'
          : 'failed';
    save(m);
  } finally { running = false; setImmediate(pump); }
}
function check() {
  const m = context.getStore();
  if (!m) return;
  const persisted = get(m.id);
  if (persisted.control) {
    const error = new Error(`LINKEDIN_MISSION_${persisted.control === 'cancel' ? 'CANCELLED' : 'PAUSED'}`);
    error.code = error.message; throw error;
  }
}

function compatibleDiscoveryMissions(current, tool) {
  const request = current?.prepared?.request || {};
  const topic = String(request.topic || '').trim().toLowerCase();
  const entityMode = String(request.entityMode || '').trim().toLowerCase();
  return list().filter((candidate) => {
    if (!candidate || candidate.id === current.id) return false;
    const source = candidate.prepared?.request || {};
    if (String(source.entityMode || '').trim().toLowerCase() !== entityMode) return false;
    if (String(source.topic || '').trim().toLowerCase() !== topic) return false;
    return Object.keys(candidate.responses || {}).some((key) => {
      try { return JSON.parse(key)[0] === tool; } catch { return false; }
    });
  });
}

function cachedToolValues(mission, tool) {
  return Object.entries(mission?.responses || {}).filter(([key]) => {
    try { return JSON.parse(key)[0] === tool; } catch { return false; }
  }).map(([, cached]) => cached.value);
}

function cachedExact(tool, args, options = {}) {
  const m = context.getStore();
  if (!m) return { hit: false, value: null, sourceMissionId: null };
  check();

  const key = JSON.stringify([tool, args]);
  const cacheTtl = m.prepared?.request?.resumeExistingPool ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  const current = m.responses?.[key];
  if (current && Date.now() - Number(current.at || 0) < cacheTtl) {
    if (options.recordHit !== false) {
      m.cacheHits++;
      m.progress = {
        ...(m.progress || {}),
        reusedEvidenceTool: tool,
        reusedEvidenceMissionId: m.id,
        reuseMode: m.progress?.reuseMode || 'saved-first',
      };
      save(m);
    }
    return { hit: true, value: current.value, sourceMissionId: m.id };
  }

  if (m.prepared?.request?.resumeExistingPool && /^(?:get_job_details|get_company_profile|get_person_profile)$/.test(tool)) {
    for (const compatible of compatibleDiscoveryMissions(m, tool)) {
      const cached = compatible.responses?.[key];
      if (!cached) continue;
      if (options.recordHit !== false) {
        m.cacheHits++;
        m.progress = {
          ...(m.progress || {}),
          reusedEvidenceTool: tool,
          reusedEvidenceMissionId: compatible.id,
          reuseMode: m.progress?.reuseMode || 'saved-first',
        };
        save(m);
      }
      return { hit: true, value: cached.value, sourceMissionId: compatible.id };
    }
  }

  return { hit: false, value: null, sourceMissionId: null };
}
async function call(tool, args, invoke) {
  const m = context.getStore();
  if (!m) return invoke();
  check();
  if (m.prepared?.request?.resumeExistingPool && /^search_/.test(tool) && !m.discoveryReplayed) {
    let sourceMission = m;
    let values = cachedToolValues(m, tool);

    const sourceMissionIds = [];
    if (values.length) sourceMissionIds.push(m.id);

    if (!values.length) {
      const compatibles = compatibleDiscoveryMissions(m, tool);
      const seen = new Set();
      values = [];
      for (const compatible of compatibles) {
        const cachedValues = cachedToolValues(compatible, tool);
        if (!cachedValues.length) continue;
        sourceMissionIds.push(compatible.id);
        for (const value of cachedValues) {
          const signature = JSON.stringify(value);
          if (seen.has(signature)) continue;
          seen.add(signature);
          values.push(value);
        }
      }
      if (sourceMissionIds.length) sourceMission = { id: sourceMissionIds[0] };
    }

    if (values.length) {
      const jobIds = tool === 'search_jobs'
        ? require('./linkedin-account-operator').jobIdsFromResult({ results: values })
        : [];

      if (tool !== 'search_jobs' || jobIds.length) {
        m.discoveryReplayed = true;
        m.discoverySourceMissionId = sourceMission.id;
        m.discoverySourceMissionIds = sourceMissionIds;
        m.cacheHits += values.length;
        m.progress = {
          ...(m.progress || {}),
          reusedDiscoveryResponses: values.length,
          reusedDiscoveryMissionId: sourceMission.id,
          reusedDiscoveryMissionIds: sourceMissionIds,
          reuseMode: 'saved-first',
        };
        save(m);
        return tool === 'search_jobs' ? { job_ids: jobIds, results: values } : { results: values };
      }
    }

    // Saved discovery is an optimization, never a prerequisite.
    // If it is absent or unreadable, fall through to a fresh authenticated
    // LinkedIn search instead of failing a brand-new continuation mission.
    m.discoveryReplayed = true;
    m.prepared.request.resumeExistingPool = false;
    m.progress = {
      ...(m.progress || {}),
      reuseMode: 'fresh-fallback',
      reuseWarning: values.length
        ? 'Saved discovery could not be decoded; fresh LinkedIn discovery started.'
        : 'No compatible saved discovery existed; fresh LinkedIn discovery started.',
    };
    save(m);
  }
  const cached = cachedExact(tool, args);
  if (cached.hit) return cached.value;

  const key = JSON.stringify([tool, args]);
  let value;
  try { value = await invoke(); }
  catch (error) { m.stopCode = String(error.code || ''); save(m); throw error; }
  m.responses[key] = { at: Date.now(), value };
  m.calls++; save(m); return value;
}
function persistResearch(research) {
  const m = context.getStore();
  if (!m) return;
  check(); m.research = research; m.status = 'writing_sheet'; save(m);
}

function updateProgress(patch = {}) {
  const m = context.getStore();
  if (!m) return null;
  check();
  m.progress = { ...(m.progress || {}), ...patch, updatedAt: new Date().toISOString() };
  save(m);
  return m.progress;
}

function currentUsage() {
  const m = context.getStore();
  return m ? { calls: Number(m.calls || 0), cacheHits: Number(m.cacheHits || 0) } : null;
}
function control(id, action) {
  const m = get(id);
  if (action === 'resume') {
    const cacheOnlySafetyResume = m.status === 'waiting_safety' && Boolean(m.prepared?.request?.resumeExistingPool);
    if (!cacheOnlySafetyResume && !['paused', 'paused_restart', 'paused_checkpoint', 'paused_rate_limit', 'failed', 'partial'].includes(m.status)) {
      throw new Error('Mission is not resumable');
    }
    if (m.research) throw new Error('Research is preserved; inspect the existing Sheet before retrying output to avoid duplicate writes.');
    m.control = null;
    m.stopCode = null;
    m.error = null;
    m.notBefore = null;
    m.status = 'created';
    m.progress = {
      ...(m.progress || {}),
      phase: cacheOnlySafetyResume ? 'cache_recheck' : 'resuming',
      cacheOnlySafetyResume,
      nextEligibleAt: null,
    };
    save(m, false);
    queueOnce(id);
    setImmediate(pump);
  } else {
    m.control = action === 'cancel' ? 'cancel' : 'pause'; save(m, false);
  }
  return summary(m);
}
function defer(id, followup) {
  const m = get(id);
  m.followups = Array.isArray(m.followups) ? m.followups : [];
  const type = String(followup?.type || '').trim();
  if (!type) throw new Error('Invalid LinkedIn mission follow-up');
  const existing = m.followups.find((item) => item.type === type && !['resolved', 'cancelled'].includes(item.status));
  if (existing) return summary(m);
  m.followups.push({ ...followup, type, status: 'queued', requestedAt: new Date().toISOString() });
  save(m);
  return summary(m);
}

function active() {
  return list().find((m) => ['created', 'searching', 'writing_sheet', 'waiting_safety'].includes(m.status)) || null;
}

function resumeSaved(text) {
  const explicit = String(text).match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)?.[0];
  const candidates = list().filter(m => !explicit || m.id === explicit).filter(m => Object.keys(m.responses || {}).some(k => k.includes('search_jobs')));
  const m = candidates.sort((a,b) => Object.keys(b.responses || {}).length - Object.keys(a.responses || {}).length)[0];
  if (!m) throw new Error('No saved LinkedIn job discovery mission was found. No new mission was created.');
  if (['created','searching','writing_sheet'].includes(m.status)) return { ...summary(m), alreadyActive: true };
  if (m.research?.records?.length) {
    const output = m.result?.linkedinMission;
    if (!output?.sheetUrl || !['completed','partial'].includes(output.status) || output.destinationWriteError) {
      throw new Error('Verified research exists without a confirmed successful output. Recover its Sheet output before continuing.');
    }
    m.researchHistory = [...(m.researchHistory || []), { research: m.research, result: m.result, at: new Date().toISOString() }];
    m.research = null;
  }
  if (m.research && Array.isArray(m.research.records) && m.research.records.length === 0) m.research = null;
  const compiler = require('./linkedin-mission-contract');
  const previous = m.prepared.request;
  const limit = String(text).match(/(?:maximum|max|under|up to)\s*([\d,]+)\s+employees/i)?.[1];
  const base = { ...previous, originalMessage: text, resumeExistingPool: true, wantsContacts: false,
    filters: { ...previous.filters, ...(limit ? { employeeMax: Number(limit.replace(/,/g,'')) } : {}) } };
  m.prepared.request = compiler.apply(compiler.compile(text, base, { knownLocations: ['India','Maharashtra','Bengaluru','Bangalore'] }), base);
  save(m);
  return control(m.id, 'resume');
}
module.exports = { start, enqueue, get, list, summary, missionSignature, equivalentActiveMission, compatibleDiscoveryMissions, cachedExact, control, call, persistResearch, updateProgress, currentUsage, isSafetyWaitCode, parkForSafety, defer, active, resumeSaved };
