const fs = require('fs');
const crypto = require('crypto');
const { emit } = require('./events');

function verifyText(text) {
  const value = String(text || '').trim();
  return { ok: Boolean(value), status: value ? 'verified' : 'failed', check: 'response_non_empty', details: value ? 'Response contains displayable text.' : 'Response was empty.' };
}

function verifyFile(file, expectedContentHash = null) {
  if (!fs.existsSync(file)) return { ok: false, status: 'failed', check: 'file_exists', details: 'File does not exist.' };
  const content = fs.readFileSync(file);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const ok = Boolean(content.length) && (!expectedContentHash || hash === expectedContentHash);
  return { ok, status: ok ? 'verified' : 'failed', check: 'file_hash', bytes: content.length, hash, expectedContentHash };
}

function verifyExecution(input = {}) {
  const kind = String(input.kind || 'advice');
  const evidence = Array.isArray(input.evidence) ? input.evidence.filter(Boolean) : [];
  const textOk = Boolean(String(input.response || '').trim());

  if (kind === 'advice') {
    return { ok: textOk, status: textOk ? 'verified' : 'failed', confidence: textOk ? 0.8 : 0, check: 'advice_response', evidence, details: textOk ? 'Advisory response was produced; no external action was claimed.' : 'No advisory response was produced.' };
  }

  if (kind === 'repository_action') {
    const changed = Number(input.changedFiles || 0) > 0 || evidence.some((item) => /commit|changed file|verified readback|validation/i.test(String(item)));
    const validation = /pass|passed|success|verified|clean|ok/i.test(String(input.validation || '')) || evidence.some((item) => /pass|verified|success/i.test(String(item)));
    const ok = changed && validation;
    return { ok, status: ok ? 'verified' : changed ? 'partial' : 'unverified', confidence: ok ? 0.95 : changed ? 0.6 : 0.25, check: 'repository_execution', evidence, details: ok ? 'Repository action has change and validation evidence.' : changed ? 'Change evidence exists but validation is incomplete.' : 'No reliable repository change evidence was recorded.' };
  }

  if (kind === 'research') {
    const sources = Number(input.sourceCount || 0);
    const ok = textOk && sources > 0;
    return { ok, status: ok ? 'verified' : textOk ? 'partial' : 'failed', confidence: ok ? Math.min(0.95, 0.65 + sources * 0.05) : 0.35, check: 'research_evidence', evidence, details: ok ? `Research response used ${sources} retrieved evidence source(s).` : 'Research response lacks recorded retrieval evidence.' };
  }

  if (kind === 'state_change') {
    const stateChanged = Boolean(input.stateChanged);
    return { ok: stateChanged, status: stateChanged ? 'verified' : 'unverified', confidence: stateChanged ? 0.95 : 0.3, check: 'persistent_state_change', evidence, details: stateChanged ? 'Persistent workspace state was updated.' : 'No persistent state change was recorded.' };
  }

  if (kind === 'artifact') {
    const artifactCount = Number(input.artifactCount || 0);
    const ok = artifactCount > 0;
    return { ok, status: ok ? 'verified' : 'unverified', confidence: ok ? 0.95 : 0.2, check: 'artifact_persisted', evidence, details: ok ? `${artifactCount} artifact(s) were persisted.` : 'No persisted artifact evidence was recorded.' };
  }

  return { ok: textOk, status: textOk ? (evidence.length ? 'verified' : 'unverified') : 'failed', confidence: evidence.length ? 0.75 : 0.4, check: 'generic_execution', evidence, details: evidence.length ? 'Execution has recorded evidence.' : 'Execution produced a response but no external verification evidence.' };
}

function report(result, operation) { emit('verification_complete', { operation, result }); return result; }

module.exports = { verifyText, verifyFile, verifyExecution, report };
