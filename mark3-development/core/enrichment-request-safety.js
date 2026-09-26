'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const events = require('./events');

const JOURNAL_FILE = path.join(config.projectRoot, '.ultron', 'runtime', 'enrichment-request-journal.json');
const RUNTIME_ID = `${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
const MAX_RECORDS = 120;
const active = new Map();
const completed = new Map();

function text(value) { return String(value == null ? '' : value).trim(); }

function atomicSave(state) {
  fs.mkdirSync(path.dirname(JOURNAL_FILE), { recursive: true });
  const temp = `${JOURNAL_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, runtimeId: RUNTIME_ID, requests: (state.requests || []).slice(-MAX_RECORDS) }, null, 2), { mode: 0o600 });
  fs.renameSync(temp, JOURNAL_FILE);
  try { fs.chmodSync(JOURNAL_FILE, 0o600); } catch {}
}

function load() {
  try {
    if (!fs.existsSync(JOURNAL_FILE)) return { version: 1, requests: [] };
    const value = JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8'));
    return { version: 1, requests: Array.isArray(value?.requests) ? value.requests : [] };
  } catch {
    return { version: 1, requests: [] };
  }
}

function normalizeStartupState() {
  const state = load();
  let changed = false;
  for (const record of state.requests) {
    if (record?.status !== 'running') continue;
    record.status = 'interrupted';
    record.interruptedAt = new Date().toISOString();
    record.updatedAt = record.interruptedAt;
    record.reason = 'runtime-restarted-during-protected-enrichment';
    changed = true;
  }
  if (changed) atomicSave(state);
}
normalizeStartupState();

function validateRequestId(value) {
  const id = text(value);
  if (!id) return '';
  if (!/^[A-Za-z0-9._:-]{8,180}$/.test(id)) {
    const error = Object.assign(new Error('Protected enrichment request ID is invalid.'), {
      code: 'ENRICHMENT_REQUEST_ID_INVALID',
      subsystem: 'TRANSPORT',
      errorType: 'CONFIG',
      stage: 'enrichment-request-idempotency',
      status: 400,
    });
    throw error;
  }
  return id;
}

function fingerprint({ message = '', inputMode = '', routeDomain = '', attachments = [] } = {}) {
  const safeAttachments = (Array.isArray(attachments) ? attachments : []).map((item) => ({
    id: text(item?.id),
    name: text(item?.name || item?.filename),
    mime: text(item?.mime || item?.mimeType),
    source: text(item?.source),
  }));
  return crypto.createHash('sha256').update(JSON.stringify({
    message: text(message).replace(/\s+/g, ' '),
    inputMode: text(inputMode).toLowerCase(),
    routeDomain: text(routeDomain),
    attachments: safeAttachments,
  })).digest('hex');
}

function protects(route = {}, options = {}) {
  const domain = text(route?.domain);
  if (['spreadsheet-enrichment', 'three-poc-spreadsheet', 'apollo-lead'].includes(domain)) return true;
  return Boolean(options.pendingApolloApproval);
}

function recordFor(id) {
  return load().requests.find((item) => item?.id === id) || null;
}

function persistRecord(record) {
  const state = load();
  const index = state.requests.findIndex((item) => item?.id === record.id);
  if (index >= 0) state.requests[index] = { ...state.requests[index], ...record };
  else state.requests.push(record);
  atomicSave(state);
  return record;
}

function safetyError(code, message, hint, status = 409) {
  return Object.assign(new Error(message), {
    code,
    subsystem: 'TRANSPORT',
    errorType: 'CONFLICT',
    stage: 'enrichment-request-idempotency',
    status,
    hint,
  });
}

async function execute({ requestId, requestFingerprint, routeDomain = '' } = {}, fn) {
  if (typeof fn !== 'function') throw new TypeError('Protected enrichment execution requires a function.');
  const id = validateRequestId(requestId);
  if (!id) return fn();
  const fp = text(requestFingerprint);
  if (!fp) throw safetyError(
    'ENRICHMENT_REQUEST_FINGERPRINT_MISSING',
    'Protected enrichment could not establish a stable request fingerprint.',
    'Reload the Mark 3 interface and retry once. No enrichment was started.',
    400,
  );

  const inFlight = active.get(id);
  if (inFlight) {
    if (inFlight.fingerprint !== fp) throw safetyError(
      'ENRICHMENT_REQUEST_ID_COLLISION',
      'The same protected request ID was reused for different enrichment input.',
      'Do not retry this mutation with altered input. Start a fresh command instead.',
    );
    events.emit('enrichment_request_reused', { requestId: id, routeDomain, state: 'running' });
    return inFlight.promise;
  }

  if (completed.has(id)) {
    const cached = completed.get(id);
    if (cached.fingerprint !== fp) throw safetyError(
      'ENRICHMENT_REQUEST_ID_COLLISION',
      'The same protected request ID was reused for different enrichment input.',
      'Start a fresh command instead of reusing the old request ID.',
    );
    events.emit('enrichment_request_reused', { requestId: id, routeDomain, state: 'completed' });
    return cached.result;
  }

  const existing = recordFor(id);
  if (existing) {
    if (existing.fingerprint !== fp) throw safetyError(
      'ENRICHMENT_REQUEST_ID_COLLISION',
      'The same protected request ID was reused for different enrichment input.',
      'Start a fresh command instead of reusing the old request ID.',
    );
    if (existing.status === 'interrupted' || existing.status === 'running') {
      throw safetyError(
        'ENRICHMENT_REQUEST_INTERRUPTED_NO_REPLAY',
        'ULTRON restarted or lost execution ownership while this protected enrichment was running, so it refused to replay the mutation automatically.',
        'Inspect the target sheet and saved enrichment mission first. Then start a fresh request only for still-missing cells. This gate prevents duplicate Apollo spend and duplicate writes.',
      );
    }
    if (existing.status === 'completed') {
      throw safetyError(
        'ENRICHMENT_REQUEST_ALREADY_COMPLETED_NO_REPLAY',
        'This protected enrichment request already completed in an earlier runtime. ULTRON will not replay it after restart without reinspection.',
        'Inspect the target sheet first. Start a new enrichment request only for remaining blank cells.',
      );
    }
    if (existing.status === 'failed') {
      throw safetyError(
        'ENRICHMENT_REQUEST_FAILED_NO_REPLAY',
        'This protected enrichment request previously failed after execution started, so ULTRON refused an automatic replay.',
        'Inspect the saved mission and target sheet before retrying to avoid duplicate paid calls or writes.',
      );
    }
  }

  const now = new Date().toISOString();
  persistRecord({
    id,
    fingerprint: fp,
    routeDomain: text(routeDomain),
    runtimeId: RUNTIME_ID,
    status: 'running',
    startedAt: now,
    updatedAt: now,
  });
  events.emit('enrichment_request_started', { requestId: id, routeDomain });

  const promise = Promise.resolve().then(fn).then((result) => {
    completed.set(id, { fingerprint: fp, result });
    const finishedAt = new Date().toISOString();
    persistRecord({
      id,
      fingerprint: fp,
      routeDomain: text(routeDomain),
      runtimeId: RUNTIME_ID,
      status: 'completed',
      updatedAt: finishedAt,
      completedAt: finishedAt,
      resultOk: result?.ok !== false,
      resultCode: text(result?.errorCode || result?.error),
    });
    events.emit('enrichment_request_completed', { requestId: id, routeDomain, ok: result?.ok !== false });
    return result;
  }).catch((error) => {
    const failedAt = new Date().toISOString();
    persistRecord({
      id,
      fingerprint: fp,
      routeDomain: text(routeDomain),
      runtimeId: RUNTIME_ID,
      status: 'failed',
      updatedAt: failedAt,
      failedAt,
      errorCode: text(error?.code || 'ENRICHMENT_EXECUTION_FAILED'),
    });
    events.emit('enrichment_request_failed', { requestId: id, routeDomain, errorCode: text(error?.code || 'ENRICHMENT_EXECUTION_FAILED') });
    throw error;
  }).finally(() => {
    active.delete(id);
  });

  active.set(id, { fingerprint: fp, promise });
  return promise;
}

function status(requestId) {
  const id = validateRequestId(requestId);
  if (!id) return null;
  if (active.has(id)) return { id, status: 'running', runtimeId: RUNTIME_ID };
  if (completed.has(id)) return { id, status: 'completed', runtimeId: RUNTIME_ID };
  return recordFor(id);
}

module.exports = {
  JOURNAL_FILE,
  RUNTIME_ID,
  fingerprint,
  protects,
  execute,
  status,
  validateRequestId,
};
