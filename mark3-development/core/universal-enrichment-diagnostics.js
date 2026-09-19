'use strict';

// Canonical problem vocabulary for universal spreadsheet enrichment.
// Human-readable reports may change; these codes are the stable debugging contract.

function text(value) { return String(value == null ? '' : value).trim(); }

const ISSUE_CATALOG = Object.freeze({
  'employer-unresolved': {
    code: 'EMPLOYER_NOT_VERIFIED',
    category: 'mandatory',
    severity: 'BLOCKER',
    blocking: true,
    retryable: true,
    message: 'No safe hiring-employer identity was verified for the row.',
    nextAction: 'Retry employer recovery from row evidence, exact anchor identity, and company-constrained sources.',
  },
  'poc2-no-candidates': {
    code: 'POC2_NO_DISCOVERY_CANDIDATES',
    category: 'mandatory',
    severity: 'BLOCKER',
    blocking: true,
    retryable: true,
    message: 'Mandatory POC-2 is empty and deterministic discovery returned no candidate pool.',
    nextAction: 'Run the deep leftover discovery waterfall before declaring exhaustion.',
  },
  'poc2-verification-unresolved': {
    code: 'POC2_CANDIDATES_FAILED_VERIFICATION',
    category: 'mandatory',
    severity: 'BLOCKER',
    blocking: true,
    retryable: true,
    message: 'POC-2 candidates existed, but none survived identity/employer/write verification.',
    nextAction: 'Try the remaining verified candidates and bounded fallback strategies.',
  },
  'existing-contact-repair-unresolved': {
    code: 'EXISTING_CONTACT_REPAIR_UNRESOLVED',
    category: 'repair',
    severity: 'WARNING',
    blocking: false,
    retryable: true,
    message: 'An existing named contact could not be exactly re-verified or completed.',
    nextAction: 'Keep the existing identity untouched and retry only its missing contact fields later.',
  },
  'recoverable-row-failure': {
    code: 'ROW_LOCAL_RECOVERABLE_FAILURE',
    category: 'row',
    severity: 'WARNING',
    blocking: false,
    retryable: true,
    message: 'A row-local failure was contained and the run continued.',
    nextAction: 'Inspect the typed subsystem error for this row and retry the row without blocking the sheet.',
  },
  'employer-unresolved-after-last-resort': {
    code: 'EMPLOYER_UNRESOLVED_AFTER_ALL_STRATEGIES',
    category: 'mandatory',
    severity: 'BLOCKER',
    blocking: true,
    retryable: false,
    message: 'No verified employer remained after every configured employer-recovery strategy.',
    nextAction: 'Provide stronger company evidence or a verified company identifier before retrying.',
  },
  'no-verified-candidates-after-last-resort': {
    code: 'POC2_NO_VERIFIED_CANDIDATE_AFTER_ALL_STRATEGIES',
    category: 'mandatory',
    severity: 'BLOCKER',
    blocking: true,
    retryable: false,
    message: 'No distinct same-company POC-2 survived all configured deterministic and fallback strategies.',
    nextAction: 'Treat this as data exhaustion unless new company/person evidence becomes available.',
  },
  'no-safe-verified-poc2-after-all-strategies': {
    code: 'POC2_NO_VERIFIED_CANDIDATE_AFTER_ALL_STRATEGIES',
    category: 'mandatory',
    severity: 'BLOCKER',
    blocking: true,
    retryable: false,
    message: 'Mandatory POC-2 is still empty after all safe strategies.',
    nextAction: 'Treat this as data exhaustion unless new company/person evidence becomes available.',
  },
  'missing-poc1-anchor': {
    code: 'POC1_ANCHOR_MISSING',
    category: 'mandatory',
    severity: 'BLOCKER',
    blocking: true,
    retryable: false,
    message: 'The row has no reliable primary contact anchor.',
    nextAction: 'Repair the row identity/schema before contact enrichment.',
  },
  'missing-poc1-name': {
    code: 'POC1_NAME_MISSING',
    category: 'mandatory',
    severity: 'BLOCKER',
    blocking: true,
    retryable: false,
    message: 'Primary contact name is missing.',
    nextAction: 'Restore a verified POC-1 name before continuing.',
  },
  'missing-poc1-linkedin': {
    code: 'POC1_LINKEDIN_MISSING',
    category: 'mandatory',
    severity: 'BLOCKER',
    blocking: true,
    retryable: false,
    message: 'Primary contact LinkedIn identity is missing.',
    nextAction: 'Restore a verified POC-1 LinkedIn identity before continuing.',
  },
  'ai-skipped-no-verified-candidate-pool': {
    code: 'AI_SKIPPED_NO_VERIFIED_CANDIDATE_POOL',
    category: 'ai',
    severity: 'INFO',
    blocking: false,
    retryable: false,
    message: 'AI selection was skipped because no verified candidate pool existed.',
    nextAction: 'Fix discovery/verification evidence rather than model routing.',
  },
  'phone-callback-pending': {
    code: 'PHONE_CALLBACK_PENDING',
    category: 'contact',
    severity: 'PENDING',
    blocking: false,
    retryable: true,
    message: 'Verified phone enrichment is still awaiting an asynchronous provider callback.',
    nextAction: 'Allow the persisted callback watcher or a later run to resume the exact cell.',
  },
  'phone-sync-error': {
    code: 'PHONE_SYNC_ERROR',
    category: 'contact',
    severity: 'WARNING',
    blocking: false,
    retryable: true,
    message: 'At least one phone callback sync attempt failed.',
    nextAction: 'Inspect the typed phone-sync error and retry callback synchronization.',
  },
  'optional-poc3-unresolved': {
    code: 'OPTIONAL_POC3_UNRESOLVED',
    category: 'optional',
    severity: 'INFO',
    blocking: false,
    retryable: false,
    message: 'Optional POC-3 was not filled.',
    nextAction: 'No action is required unless a third contact is explicitly desired.',
  },
  'identity-conflict': {
    code: 'IDENTITY_CONFLICT_WRITE_BLOCKED',
    category: 'safety',
    severity: 'WARNING',
    blocking: false,
    retryable: false,
    message: 'A proposed contact write was blocked by identity safety checks.',
    nextAction: 'Inspect the conflicting identity evidence before allowing any write.',
  },
});

function fallbackIssue(reason) {
  const normalized = text(reason);
  const upper = normalized.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return {
    code: upper ? `UNCLASSIFIED_${upper}` : 'UNCLASSIFIED_ENRICHMENT_ISSUE',
    category: 'unknown',
    severity: 'WARNING',
    blocking: false,
    retryable: true,
    message: normalized || 'Unclassified enrichment issue.',
    nextAction: 'Inspect the raw reason and add it to the canonical diagnostics catalog.',
  };
}

function issueFromReason(reason, context = {}) {
  const rawReason = text(reason || context.reason || 'unclassified');
  const spec = ISSUE_CATALOG[rawReason] || fallbackIssue(rawReason);
  const rowNumber = Number(context.rowNumber);
  const groupOrdinal = Number(context.groupOrdinal || 0) || null;
  return {
    ...spec,
    rawReason,
    rowNumber: Number.isInteger(rowNumber) ? rowNumber : null,
    groupOrdinal,
    target: text(context.target) || (groupOrdinal ? `POC-${groupOrdinal}` : ''),
    company: text(context.company),
    detail: text(context.detail).slice(0, 300),
  };
}

function classifyLeftovers(queue = []) {
  const issues = (Array.isArray(queue) ? queue : []).map((item) => issueFromReason(
    item?.rawReason || item?.reason,
    item || {}
  ));
  const rowsFor = (predicate) => [...new Set(
    issues.filter(predicate).map((item) => Number(item.rowNumber)).filter(Number.isInteger)
  )].sort((a, b) => a - b);
  return {
    issues,
    blockingRows: rowsFor((item) => item.blocking),
    repairRows: rowsFor((item) => item.category === 'repair'),
    warningRows: rowsFor((item) => !item.blocking && ['WARNING', 'PENDING'].includes(item.severity)),
    retryableRows: rowsFor((item) => item.retryable),
  };
}

function runtimeIssues(stats = {}) {
  const issues = [];
  if (Number(stats.phoneStillPending || 0) > 0 || Number(stats.backgroundPhonePending || 0) > 0) {
    issues.push(issueFromReason('phone-callback-pending', {
      detail: `${Number(stats.phoneStillPending || 0)} same-run pending; ${Number(stats.backgroundPhonePending || 0)} persisted background assignments.`,
    }));
  }
  if (Number(stats.phoneSyncErrors || 0) > 0) {
    issues.push(issueFromReason('phone-sync-error', {
      detail: text(stats.phoneSyncLastError?.code || stats.phoneSyncLastError?.message || ''),
    }));
  }
  if (Number(stats.optionalPoc3Deferred || 0) > 0) {
    issues.push(issueFromReason('optional-poc3-unresolved', {
      detail: `${Number(stats.optionalPoc3Deferred || 0)} optional target(s) left unfilled.`,
    }));
  }
  if (Number(stats.identityConflicts || 0) > 0) {
    issues.push(issueFromReason('identity-conflict', {
      detail: `${Number(stats.identityConflicts || 0)} unsafe write(s) blocked.`,
    }));
  }
  return issues;
}

function uniqueIssues(issues = []) {
  const out = [];
  const seen = new Set();
  for (const issue of issues) {
    if (!issue) continue;
    const key = [issue.code, issue.rowNumber ?? '', issue.groupOrdinal ?? '', issue.detail || ''].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

function formatIssue(issue = {}) {
  const scope = Number.isInteger(Number(issue.rowNumber))
    ? `[ROW ${Number(issue.rowNumber)}]`
    : '';
  const target = text(issue.target) ? `[${text(issue.target)}]` : '';
  const detail = text(issue.detail) ? ` Evidence: ${text(issue.detail)}` : '';
  const next = text(issue.nextAction) ? ` Next: ${text(issue.nextAction)}` : '';
  return `[${text(issue.severity) || 'INFO'}]${scope}${target} ${text(issue.code) || 'UNCLASSIFIED_ENRICHMENT_ISSUE'}: ${text(issue.message) || 'Unclassified enrichment issue.'}${detail}${next}`.trim();
}

module.exports = {
  ISSUE_CATALOG,
  issueFromReason,
  classifyLeftovers,
  runtimeIssues,
  uniqueIssues,
  formatIssue,
};
