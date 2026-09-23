const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config');
const events = require('./events');
const policy = require('./linkedin-account-policy');
const finalMaster = require('./linkedin-final-master');
const profileEvidenceCache = require('./linkedin-profile-evidence-cache');
const sheetProgress = require('./linkedin-sheet-progress');
const context = new AsyncLocalStorage();
const root = path.join(config.projectRoot, '.ultron', 'linkedin-missions');
let running = false;
let executor;
const queue = [];
let wakeTimer = null;
let wakeTimerAt = null;

function queueOnce(id) {
  if (!queue.includes(id)) queue.push(id);
}

function schedulePumpAt(iso) {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at)) return setImmediate(pump);

  // Keep the earliest wake-up. A later parked mission must never postpone an
  // earlier mission that is already eligible to resume.
  if (wakeTimer && Number.isFinite(wakeTimerAt) && wakeTimerAt <= at) return;
  if (wakeTimer) clearTimeout(wakeTimer);

  const delay = Math.max(0, at - Date.now());
  wakeTimerAt = at;
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    wakeTimerAt = null;
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
function persistentTarget(m) {
  const request = m?.prepared?.request || {};
  if (request.targetMode === 'master_total' && Number(request.targetTotal || 0) > 0) return true;
  return request.targetMode === 'additional'
    && request.persistentUntilTarget === true
    && Number(request.targetRequested || request.count || 0) > 0
    && Boolean(request.destinationSheetUrl);
}

function targetTotalForMission(m) {
  const request = m?.prepared?.request || {};
  if (request.targetMode === 'master_total') return Math.max(0, Number(request.targetTotal || 0));
  if (!persistentTarget(m)) return 0;
  if (Number.isFinite(Number(m.targetSheetTotal))) return Math.max(0, Number(m.targetSheetTotal));
  const initial = Number(m.initialSheetCount);
  const requested = Number(request.targetRequested || request.count || 0);
  return Number.isFinite(initial) && Number.isFinite(requested) ? Math.max(0, initial + requested) : 0;
}

function elapsedMetrics(m, current = null, targetTotal = null) {
  const startedAt = Date.parse(String(m.startedAt || m.createdAt || ''));
  const completedAt = m.status === 'completed' ? Date.parse(String(m.completedAt || '')) : NaN;
  const endMs = Number.isFinite(completedAt) ? completedAt : Date.now();
  const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, endMs - startedAt) : 0;
  const activeWorkMs = Math.max(0, Number(m.activeWorkMs || 0));
  const initial = Number.isFinite(Number(m.initialSheetCount)) ? Number(m.initialSheetCount) : null;
  const added = initial != null && Number.isFinite(Number(current))
    ? Math.max(0, Number(current) - initial)
    : 0;
  const avgActiveMsPerCompany = added > 0 ? Math.round(activeWorkMs / added) : null;
  const remaining = targetTotal && Number.isFinite(Number(current))
    ? Math.max(0, Number(targetTotal) - Number(current))
    : null;
  const estimatedActiveMsRemaining = avgActiveMsPerCompany != null && remaining != null
    ? avgActiveMsPerCompany * remaining
    : null;
  return { elapsedMs, activeWorkMs, addedSinceStart: added, avgActiveMsPerCompany, estimatedActiveMsRemaining };
}

function summary(m) {
  const request = m.prepared?.request || {};
  const computedTarget = targetTotalForMission(m);
  const targetTotal = computedTarget > 0 ? computedTarget : null;
  const sheetCurrent = Number(m.authoritativeSheet?.uniqueCompanies);
  const masterCurrent = targetTotal
    ? (Number.isFinite(sheetCurrent) ? sheetCurrent : Number(m.progress?.masterCurrent ?? finalMaster.masterCount()))
    : null;
  const timing = elapsedMetrics(m, masterCurrent, targetTotal);
  if (!targetTotal && Number.isFinite(Number(m.result?.linkedinMission?.added))) {
    timing.addedSinceStart = Math.max(0, Number(m.result.linkedinMission.added));
  }
  return { id: m.id, status: m.status, updatedAt: m.updatedAt, calls: m.calls || 0,
    cacheHits: m.cacheHits || 0, progress: m.progress || null,
    contract: request.missionContract || null,
    targetTotal,
    masterCurrent,
    masterRemaining: targetTotal ? Math.max(0, targetTotal - Number(masterCurrent || 0)) : null,
    startedAt: m.startedAt || m.createdAt || null,
    lastProgressAt: m.lastProgressAt || null,
    batchCount: Number(m.batchCount || 0),
    ...timing,
    error: m.error || null, result: m.result || null };
}

async function syncAuthoritativeSheet(m, options = {}) {
  if (!persistentTarget(m)) return null;
  const request = m.prepared?.request || {};
  const url = request.targetMode === 'master_total'
    ? (finalMaster.masterSheetUrl() || request.destinationSheetUrl || null)
    : (request.destinationSheetUrl || null);
  if (!url) return null;
  const snap = await sheetProgress.snapshot(url, { requireJob: Boolean(request.hiring) });
  const previous = Number(m.authoritativeSheet?.uniqueCompanies);
  m.authoritativeSheet = {
    uniqueCompanies: snap.uniqueCompanies,
    validRows: snap.validRows,
    totalDataRows: snap.totalDataRows,
    readAt: snap.readAt,
  };
  if (!Number.isFinite(Number(m.initialSheetCount))) {
    m.initialSheetCount = Number(snap.uniqueCompanies || 0);
  }
  if (request.targetMode === 'additional') {
    request.targetRequested = Math.max(0, Number(request.targetRequested || request.count || 0));
    m.targetSheetTotal = Number(m.initialSheetCount || 0) + request.targetRequested;
  }
  if (!Number.isFinite(previous) || snap.uniqueCompanies > previous) {
    m.lastProgressAt = snap.readAt || new Date().toISOString();
  }
  const targetTotal = targetTotalForMission(m);
  const remaining = Math.max(0, targetTotal - Number(snap.uniqueCompanies || 0));
  m.progress = {
    ...(m.progress || {}),
    authoritativeSheet: true,
    masterCurrent: Number(snap.uniqueCompanies || 0),
    targetTotal,
    remaining,
    sheetReadAt: snap.readAt || new Date().toISOString(),
  };
  request.existingDestinationJobIds = snap.jobIds || [];
  request.existingDestinationCompanyKeys = snap.companyKeys || [];
  request.count = remaining;
  if (remaining === 0 && options.complete !== false) {
    m.status = 'completed';
    m.notBefore = null;
    m.stopCode = null;
    m.error = null;
    m.completedAt = m.completedAt || new Date().toISOString();
    m.progress = { ...(m.progress || {}), phase: 'completed', persistentUntilTarget: true, remaining: 0 };
  }
  return snap;
}

async function refreshSheetProgress(id) {
  const m = typeof id === 'string' ? get(id) : id;
  await syncAuthoritativeSheet(m, { complete: true });
  save(m);
  return summary(m);
}

function isRetryableMissionError(error) {
  const code = String(error?.code || '');
  const text = String(error?.message || error || '');
  if (/CHECKPOINT|MANUAL_LOCK|AUTH|LOGIN|FORBIDDEN|NOT_FOUND|INVALID|NOT_CONFIGURED|TOOL_NOT_ALLOWED|WRITE_ACTION_DISABLED/i.test(code + ' ' + text)) return false;
  return /TIMEOUT|TIMED_OUT|TRANSIENT|ECONNRESET|ECONNREFUSED|EPIPE|NETWORK|FETCH|MCP_START_FAILED|MCP_CONNECTION|GOOGLE_SHEETS_API_ERROR|HTTP_5\d\d|TEMPORAR/i.test(code + ' ' + text);
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
    ['created', 'searching', 'writing_sheet', 'waiting_safety', 'waiting_retry'].includes(mission.status)
    && !mission.control
    && (mission.signature || missionSignature(mission.prepared)) === signature
  ) || null;
}
function start(fn) {
  executor = fn;
  const missions = list();
  const newestLegacySafetyPause = missions.find((mission) => mission.status === 'paused_rate_limit') || null;
  const newestRecoverablePersistent = missions.find((mission) =>
    persistentTarget(mission)
    && (
      ['partial', 'paused_restart'].includes(mission.status)
      || (mission.status === 'failed' && isRetryableMissionError(mission.error || {}))
    )
  ) || null;

  for (const m of missions) {
    if (newestRecoverablePersistent && m.id === newestRecoverablePersistent.id) {
      m.research = null;
      m.status = 'created';
      m.control = null;
      m.notBefore = null;
      m.error = null;
      m.progress = {
        ...(m.progress || {}),
        phase: 'persistent_recovery',
        persistentUntilTarget: true,
        recoveredAt: new Date().toISOString(),
      };
      save(m, false);
      queueOnce(m.id);
      setImmediate(pump);
      continue;
    }

    if (m.status === 'waiting_retry') {
      queueOnce(m.id);
      schedulePumpAt(m.notBefore || new Date(Date.now() + 10000).toISOString());
      continue;
    }

    if (m.status === 'waiting_safety') {
      const recalculated = policy.nextEligibleAt?.();
      if (recalculated) {
        m.notBefore = recalculated;
        m.progress = {
          ...(m.progress || {}),
          nextEligibleAt: recalculated,
          schedulerRecalculatedAt: new Date().toISOString(),
        };
        save(m);
      }
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
      if (persistentTarget(m)) {
        // Persistent target missions recover from the authoritative Sheet.
        // Append dedupe + readback makes replay safe even if a previous process
        // died after partially committing rows.
        m.research = null;
        m.status = 'created';
        m.progress = {
          ...(m.progress || {}),
          phase: 'restart_recovery',
          persistentUntilTarget: true,
          restartRecoveredAt: new Date().toISOString(),
        };
        save(m);
        queueOnce(m.id);
        setImmediate(pump);
      } else {
        m.status = 'paused_restart';
        save(m);
      }
    }
  }
}
function enqueue(prepared) {
  const existing = equivalentActiveMission(prepared);
  if (existing) return { ...summary(existing), alreadyActive: true };

  if (queue.length >= 20) throw new Error('LINKEDIN_QUEUE_FULL');
  const createdAt = new Date().toISOString();
  const m = { id: randomUUID(), createdAt, startedAt: null, status: 'created',
    signature: missionSignature(prepared),
    prepared, calls: 0, cacheHits: 0, responses: {}, research: null, followups: [],
    activeWorkMs: 0, batchCount: 0, lastProgressAt: null,
    progress: { phase: 'queued', persistentUntilTarget: prepared?.request?.targetMode === 'master_total' } };
  save(m);
  queueOnce(m.id);
  setImmediate(pump);
  return summary(m);
}

function queuedMissionRunnable(id, now = Date.now()) {
  let mission;
  try { mission = get(id); } catch { return false; }
  if (mission.control) return true;
  if (mission.status === 'created') return true;
  if (!['waiting_safety', 'waiting_retry'].includes(mission.status)) return false;
  const notBefore = Date.parse(String(mission.notBefore || ''));
  return !Number.isFinite(notBefore) || notBefore <= now;
}

function nextRunnableQueueIndex(now = Date.now()) {
  return queue.findIndex((id) => queuedMissionRunnable(id, now));
}

async function pump() {
  if (running || !executor || !queue.length) return;

  const runnableIndex = nextRunnableQueueIndex();
  if (runnableIndex < 0) {
    let earliest = null;
    for (const id of queue) {
      let queued;
      try { queued = get(id); } catch { continue; }
      if (!['waiting_safety', 'waiting_retry'].includes(queued.status)) continue;
      const at = Date.parse(String(queued.notBefore || ''));
      if (!Number.isFinite(at)) continue;
      if (earliest == null || at < earliest) earliest = at;
    }
    if (earliest != null) schedulePumpAt(new Date(earliest).toISOString());
    return;
  }

  const [id] = queue.splice(runnableIndex, 1);
  const m = get(id);

  if (['waiting_safety', 'waiting_retry'].includes(m.status)) {
    if (m.control) {
      m.status = m.control === 'cancel' ? 'cancelled' : 'paused';
      save(m);
      return setImmediate(pump);
    }
    const notBefore = Date.parse(String(m.notBefore || ''));
    if (Number.isFinite(notBefore) && notBefore > Date.now()) {
      queueOnce(m.id);
      schedulePumpAt(m.notBefore);
      return setImmediate(pump);
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
  const batchStartedMs = Date.now();
  try {
    if (!m.startedAt) m.startedAt = new Date(batchStartedMs).toISOString();
    m.batchCount = Number(m.batchCount || 0) + 1;
    let batchStartTargetCount = null;
    if (persistentTarget(m)) {
      await syncAuthoritativeSheet(m, { complete: true });
      batchStartTargetCount = Number(m.authoritativeSheet?.uniqueCompanies || 0);
      if (m.status === 'completed') {
        save(m);
        events.emit('linkedin:complete', summary(m));
        return;
      }
    }
    m.status = 'searching'; save(m);
    m.discoveryReplayed = false;
    const result = await context.run(m, () => executor(m.prepared));
    m.result = result;
    const mission = result?.linkedinMission;
    const request = m.prepared?.request || {};
    const targetTotal = targetTotalForMission(m);
    let currentMaster = targetTotal > 0 ? finalMaster.masterCount() : 0;
    if (targetTotal > 0) {
      const snap = await syncAuthoritativeSheet(m, { complete: false });
      if (snap) currentMaster = Number(snap.uniqueCompanies || 0);
    }
    const remainingTarget = targetTotal > 0 ? Math.max(0, targetTotal - currentMaster) : 0;
    const priorMaster = Number(m.lastMasterCount ?? request.masterTarget?.current ?? batchStartTargetCount ?? currentMaster);
    const madeProgress = currentMaster > priorMaster;
    const budgetLimited = Boolean(mission?.budgetStopped);
    m.stagnantBatches = remainingTarget > 0
      ? (madeProgress ? 0 : budgetLimited ? Number(m.stagnantBatches || 0) : Number(m.stagnantBatches || 0) + 1)
      : 0;
    m.lastMasterCount = currentMaster;
    if (madeProgress) m.lastProgressAt = new Date().toISOString();

    const safetyLocked = /CHECKPOINT|MANUAL_LOCK/.test(String(m.stopCode || '')) || Boolean(mission?.safety?.manualLock);
    const canAutoContinue = targetTotal > 0
      && remainingTarget > 0
      && request.autoContinue !== false
      && !safetyLocked
      && !mission?.searchStrategiesExhausted;

    if (canAutoContinue) {
      let nextAt = policy.nextEligibleAt();
      const now = Date.now();

      // Target missions are persistent: do not stop after an arbitrary number
      // of continuation or stagnant batches. If a non-safety batch makes no
      // progress, avoid a hot loop and broaden to fresh discovery when allowed.
      if (!madeProgress && !budgetLimited) {
        const stagnant = Math.max(1, Number(m.stagnantBatches || 1));
        if (stagnant >= 2 && request.savedDiscoveryOnly !== true) {
          m.prepared.request.resumeExistingPool = false;
        }
        const policyAt = Date.parse(String(nextAt || ''));
        if (!Number.isFinite(policyAt) || policyAt <= now + 1000) {
          const retryMs = Math.min(60000, 8000 * (2 ** Math.min(3, stagnant - 1)));
          nextAt = new Date(now + retryMs).toISOString();
        }
      }

      if (nextAt) {
        m.researchHistory = [...(m.researchHistory || []), {
          at: new Date().toISOString(),
          found: Number(mission?.found || 0),
          added: Number(mission?.added || 0),
          masterCount: currentMaster,
          remainingTarget,
          budgetStopped: mission?.budgetStopped || null,
        }].slice(-50);
        m.research = null;
        m.continuationCount = Number(m.continuationCount || 0) + 1;
        m.prepared.request.continueFromPrevious = true;
        if (m.prepared.request.resumeExistingPool !== false) {
          m.prepared.request.resumeExistingPool = true;
        }
        m.status = 'waiting_safety';
        m.notBefore = nextAt;
        m.stopCode = null;
        m.error = null;
        m.progress = {
          ...(m.progress || {}),
          phase: budgetLimited ? 'waiting_safety' : 'waiting_resume',
          autoContinue: true,
          persistentUntilTarget: true,
          continuationCount: m.continuationCount,
          stagnantBatches: Number(m.stagnantBatches || 0),
          discoveryMode: m.prepared.request.resumeExistingPool === false ? 'fresh-after-cache' : 'saved-first',
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
    if (targetTotal > 0) {
      m.status = remainingTarget === 0 ? 'completed' : 'partial';
    } else {
      const requested = Math.max(0, Number(mission?.requested ?? request.count ?? 0));
      const delivered = Math.max(0, Number(mission?.added ?? mission?.found ?? 0));
      m.status = /COOLDOWN|CAP|RATE_LIMIT/.test(m.stopCode || '') ? 'paused_rate_limit'
        : mission && (mission.budgetStopped || delivered < requested) ? 'partial' : 'completed';
      if (mission) {
        m.progress = {
          ...(m.progress || {}),
          phase: m.status,
          requested,
          added: delivered,
          remaining: Math.max(0, requested - delivered),
        };
      }
    }
    if (m.status === 'completed') m.completedAt = m.completedAt || new Date().toISOString();
    save(m);
    events.emit('linkedin:complete', summary(m));
  } catch (error) {
    const code = String(error.code || error.message || 'LINKEDIN_MISSION_FAILED');
    m.error = { code, message: String(error.message || code) };

    if (isSafetyWaitCode(code) && !/CHECKPOINT|MANUAL_LOCK/.test(code)) {
      parkForSafety(m, error);
      return;
    }

    if (persistentTarget(m) && isRetryableMissionError(error)) {
      m.retryCount = Number(m.retryCount || 0) + 1;
      const retryMs = Math.min(120000, 10000 * (2 ** Math.min(3, m.retryCount - 1)));
      const nextAt = new Date(Date.now() + retryMs).toISOString();
      m.status = 'waiting_retry';
      m.notBefore = nextAt;
      m.progress = {
        ...(m.progress || {}),
        phase: 'waiting_retry',
        autoContinue: true,
        persistentUntilTarget: true,
        retryCount: m.retryCount,
        nextEligibleAt: nextAt,
        retryReason: String(error.message || code),
      };
      save(m);
      queueOnce(m.id);
      schedulePumpAt(nextAt);
      return;
    }

    m.status = /CHECKPOINT|MANUAL_LOCK/.test(code) ? 'paused_checkpoint'
      : code === 'LINKEDIN_MISSION_PAUSED' ? 'paused'
        : code === 'LINKEDIN_MISSION_CANCELLED' ? 'cancelled'
          : 'failed';
    save(m);
  } finally {
    if (batchStartedMs) {
      const duration = Math.max(0, Date.now() - batchStartedMs);
      m.activeWorkMs = Number(m.activeWorkMs || 0) + duration;
      m.lastBatchDurationMs = duration;
      try { save(m); } catch {}
    }
    running = false;
    setImmediate(pump);
  }
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
  const cacheTtl = tool === 'get_job_details'
    ? 5 * 60 * 1000
    : (m.prepared?.request?.resumeExistingPool ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000);
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

  if (/^(?:get_job_details|get_company_profile|get_person_profile)$/.test(tool)) {
    const crossMissionTtl = tool === 'get_job_details'
      ? 5 * 60 * 1000
      : tool === 'get_company_profile'
        ? 7 * 24 * 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;
    for (const compatible of compatibleDiscoveryMissions(m, tool)) {
      const cached = compatible.responses?.[key];
      if (!cached) continue;
      if (Date.now() - Number(cached.at || 0) >= crossMissionTtl) continue;
      if (options.recordHit !== false) {
        m.cacheHits++;
        m.progress = {
          ...(m.progress || {}),
          reusedEvidenceTool: tool,
          reusedEvidenceMissionId: compatible.id,
          reuseMode: m.progress?.reuseMode || (m.prepared?.request?.resumeExistingPool ? 'saved-first' : 'cross-mission'),
        };
        save(m);
      }
      return { hit: true, value: cached.value, sourceMissionId: compatible.id };
    }
  }

  if (tool === 'get_company_profile' && args?.company_name) {
    const slug = String(args.company_name || '').trim().replace(/^https?:\/\/(?:www\.)?linkedin\.com\/company\//i, '').replace(/[/?#].*$/, '').toLowerCase();

    const fromJobDetail = profileEvidenceCache.profileFromJobDetails(
      [m, ...compatibleDiscoveryMissions(m, 'get_job_details')],
      slug,
    );
    if (fromJobDetail) {
      if (options.recordHit !== false) {
        m.cacheHits++;
        m.progress = {
          ...(m.progress || {}),
          reusedEvidenceTool: tool,
          reusedEvidenceMissionId: fromJobDetail.sourceMissionId,
          reuseMode: 'job-detail-company-profile',
          jobDetailCompanyProfileHits: Number(m.progress?.jobDetailCompanyProfileHits || 0) + 1,
        };
        save(m);
      }
      return { hit: true, value: fromJobDetail.value, sourceMissionId: fromJobDetail.sourceMissionId };
    }

    const stored = slug
      ? finalMaster.recordFor?.({ linkedin: `https://www.linkedin.com/company/${slug}` })
      : null;
    if (stored?.status === 'verified' && stored.employeeCount) {
      const employeeLabel = stored.employeeCount?.label
        || (Number.isFinite(Number(stored.employeeCount?.min)) && Number.isFinite(Number(stored.employeeCount?.max))
          ? `${stored.employeeCount.min}-${stored.employeeCount.max} employees`
          : String(stored.employeeCount || ''));
      const evidence = stored.companyEvidenceText
        || [
          stored.company || slug,
          employeeLabel ? `Company size: ${employeeLabel}` : '',
          (stored.companyLocation || stored.location) ? `Headquarters: ${stored.companyLocation || stored.location}` : '',
        ].filter(Boolean).join('\n');
      const value = {
        url: stored.linkedin || `https://www.linkedin.com/company/${slug}`,
        sections: { main: evidence },
        references: [],
        ultronDurableCache: true,
      };
      if (options.recordHit !== false) {
        m.cacheHits++;
        m.progress = {
          ...(m.progress || {}),
          reusedEvidenceTool: tool,
          reusedEvidenceMissionId: 'final-master-registry',
          reuseMode: 'durable-company-profile',
          durableCompanyProfileHits: Number(m.progress?.durableCompanyProfileHits || 0) + 1,
        };
        save(m);
      }
      return { hit: true, value, sourceMissionId: 'final-master-registry' };
    }
  }

  return { hit: false, value: null, sourceMissionId: null };
}
async function call(tool, args, invoke) {
  const m = context.getStore();
  if (!m) return invoke();
  check();
  if (m.prepared?.request?.savedDiscoveryOnly && /^search_/.test(tool) && m.discoveryReplayed) return null;
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

    if (m.prepared?.request?.savedDiscoveryOnly) {
      throw Object.assign(new Error('Saved discovery is missing or unreadable; no fresh search was made.'), { code: 'LINKEDIN_SAVED_POOL_UNAVAILABLE' });
    }
    // Saved discovery is an optimization for new missions, never a prerequisite.
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
    const cacheOnlySafetyResume = ['waiting_safety', 'waiting_retry'].includes(m.status) && Boolean(m.prepared?.request?.resumeExistingPool);
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
    const nextControl = action === 'cancel' ? 'cancel' : 'pause';

    // A parked safety mission is not executing any tool call, so pausing or
    // cancelling it can be applied immediately. Leaving it as waiting_safety
    // until its old timer fires made duplicate detection resurrect a mission
    // the user had already cancelled.
    if (['waiting_safety', 'waiting_retry'].includes(m.status)) {
      m.control = null;
      m.notBefore = null;
      m.stopCode = nextControl === 'cancel' ? 'LINKEDIN_MISSION_CANCELLED' : null;
      m.status = nextControl === 'cancel' ? 'cancelled' : 'paused';
      m.progress = {
        ...(m.progress || {}),
        phase: m.status,
        nextEligibleAt: null,
        safetyReason: null,
      };
      save(m, false);
    } else {
      m.control = nextControl;
      save(m, false);
    }
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
  return list().find((m) => ['created', 'searching', 'writing_sheet', 'waiting_safety', 'waiting_retry'].includes(m.status)) || null;
}

function hasCachedTool(mission, tool) {
  return Object.keys(mission?.responses || {}).some((key) => {
    try { return JSON.parse(key)[0] === tool; } catch { return false; }
  });
}

function recoveryProfile(text) {
  const value = String(text || '');
  return {
    entityMode: /\b(?:company|companies|employers?|business(?:es)?|organizations?|organisations?)\b/i.test(value) ? 'company'
      : /\b(?:people|persons?|professionals?|recruiters?|profiles?)\b/i.test(value) ? 'person' : '',
    topic: /\bsap\b/i.test(value) ? 'sap' : '',
    locations: [
      /\bmaharashtra\b/i.test(value) ? 'maharashtra' : '',
      /\b(?:bengaluru|bangalore)\b/i.test(value) ? 'bengaluru' : '',
    ].filter(Boolean),
  };
}

function recoverySourceMissions(text) {
  const profile = recoveryProfile(text);
  return list()
    .filter((mission) => hasCachedTool(mission, 'search_jobs'))
    .map((mission) => {
      const request = mission.prepared?.request || {};
      const entityMode = String(request.entityMode || '').trim().toLowerCase();
      const topic = String(request.topic || '').trim().toLowerCase();
      if (profile.entityMode && entityMode && profile.entityMode !== entityMode) return null;
      if (profile.topic && topic && !topic.includes(profile.topic)) return null;

      const sourceLocations = [
        ...(Array.isArray(request.allowedLocations) ? request.allowedLocations : []),
        ...(Array.isArray(request.preferredLocations) ? request.preferredLocations : []),
        request.location,
      ].filter(Boolean).map((value) => /bangalore/i.test(String(value)) ? 'bengaluru' : String(value).trim().toLowerCase());

      const locationOverlap = profile.locations.filter((location) => sourceLocations.includes(location)).length;
      const responseCount = Object.keys(mission.responses || {}).length;
      const searchCount = Object.keys(mission.responses || {}).filter((key) => {
        try { return JSON.parse(key)[0] === 'search_jobs'; } catch { return false; }
      }).length;
      const score = (profile.topic && topic.includes(profile.topic) ? 1000 : 0)
        + (profile.entityMode && entityMode === profile.entityMode ? 500 : 0)
        + locationOverlap * 100
        + searchCount * 10
        + Math.min(responseCount, 999);

      return { mission, score, responseCount, searchCount, locationOverlap };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || right.responseCount - left.responseCount);
}

function compileResumeRequest(text, previous) {
  const compiler = require('./linkedin-mission-contract');
  const value = String(text || '');
  const limit = value.match(/(?:maximum|max|under|up to)\s*([\d,]+)\s+employees/i)?.[1];
  const freshAfterExhaustion =
    /\b(?:unless|once|after|when)\b[\s\S]{0,180}\b(?:exhausted|exhaustion|processed|used\s+up)\b/i.test(value);
  const forbidsFresh =
    /\b(?:do\s+not|don't|no|without)\b[\s\S]{0,80}\b(?:fresh|new)\s+(?:linkedin\s+)?(?:search_jobs|discovery|search(?:es)?)\b/i.test(value);
  const savedDiscoveryOnly = freshAfterExhaustion
    ? false
    : true;
  const base = {
    ...previous,
    originalMessage: text,
    resumeExistingPool: true,
    savedDiscoveryOnly,
    reuseCachedEvidence: true,
    continueFromPrevious: true,
    wantsContacts: false,
    filters: { ...previous.filters, ...(limit ? { employeeMax: Number(limit.replace(/,/g,'')) } : {}) },
  };
  const next = compiler.apply(
    compiler.compile(text, base, { knownLocations: ['India','Maharashtra','Bengaluru','Bangalore'] }),
    base
  );
  const explicitIndiaScope =
    /\bindia\s+only\b/i.test(value)
    || (/\bhard requirements?\b/i.test(value) && /\bindia\b/i.test(value));
  if (explicitIndiaScope) {
    next.allowedLocations = ['India'];
    next.preferredLocations = ['India'];
    next.location = 'India';
    next.missionContract = {
      ...(next.missionContract || {}),
      hard: { ...(next.missionContract?.hard || {}), locations: ['India'] },
      preferences: { ...(next.missionContract?.preferences || {}), locations: ['India'] },
    };
  }
  return next;
}

function resumeSaved(text) {
  const explicit = String(text).match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)?.[0];
  const all = list();
  const exact = explicit ? all.find((mission) => mission.id === explicit) : null;
  const exactUsesCompatiblePool = Boolean(
    exact?.prepared?.request?.resumeExistingPool
    || exact?.prepared?.request?.recoveredFromMissingMissionId
    || exact?.prepared?.request?.recoverySourceMissionIds?.length
  );
  let m = exact && (hasCachedTool(exact, 'search_jobs') || exactUsesCompatiblePool)
    ? exact
    : (explicit ? [] : all)
      .filter((mission) => hasCachedTool(mission, 'search_jobs'))
      .sort((a,b) => Object.keys(b.responses || {}).length - Object.keys(a.responses || {}).length)[0];

  // The original mission file may be missing after a local cleanup/rebuild even
  // though compatible discovery evidence from sibling missions still exists.
  // Recover into a new continuation rather than silently falling back to fresh
  // LinkedIn discovery or dead-ending with "mission not found".
  if (!m && explicit) {
    const sources = recoverySourceMissions(text);
    if (!sources.length) {
      const error = new Error(`Saved LinkedIn mission ${explicit} is not present in the current mission store, and no compatible cached search_jobs evidence was found. No fresh LinkedIn search was started.`);
      error.code = 'LINKEDIN_SAVED_MISSION_MISSING';
      error.missingMissionId = explicit;
      throw error;
    }

    const primary = sources[0].mission;
    const prepared = {
      ...primary.prepared,
      request: {
        ...compileResumeRequest(text, primary.prepared?.request || {}),
        recoveredFromMissingMissionId: explicit,
        recoverySourceMissionIds: sources.map((source) => source.mission.id),
      },
    };
    const queued = enqueue(prepared);
    const recovered = get(queued.id);
    recovered.progress = {
      ...(recovered.progress || {}),
      phase: 'recovery_queued',
      recoveryMode: 'compatible-saved-evidence',
      missingMissionId: explicit,
      recoverySourceMissionIds: sources.map((source) => source.mission.id),
      compatibleSearchResponses: sources.reduce((sum, source) => sum + source.searchCount, 0),
      compatibleCachedResponses: sources.reduce((sum, source) => sum + source.responseCount, 0),
      freshDiscoveryAllowed: false,
    };
    save(recovered);
    return {
      ...summary(recovered),
      recovered: true,
      missingMissionId: explicit,
      recoverySourceMissionIds: recovered.progress.recoverySourceMissionIds,
      compatibleSearchResponses: recovered.progress.compatibleSearchResponses,
      compatibleCachedResponses: recovered.progress.compatibleCachedResponses,
      freshDiscoveryAllowed: false,
    };
  }

  if (!m) {
    const error = new Error('No saved LinkedIn job discovery mission was found. No fresh LinkedIn search was started.');
    error.code = 'LINKEDIN_SAVED_MISSION_MISSING';
    throw error;
  }
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
  m.prepared.request = compileResumeRequest(text, m.prepared.request || {});
  save(m);
  return control(m.id, 'resume');
}
module.exports = { start, enqueue, get, list, summary, refreshSheetProgress, syncAuthoritativeSheet, persistentTarget, targetTotalForMission, isRetryableMissionError, missionSignature, equivalentActiveMission, compatibleDiscoveryMissions, cachedExact, control, call, persistResearch, updateProgress, currentUsage, isSafetyWaitCode, parkForSafety, defer, active, queuedMissionRunnable, nextRunnableQueueIndex, hasCachedTool, recoveryProfile, recoverySourceMissions, compileResumeRequest, resumeSaved };
