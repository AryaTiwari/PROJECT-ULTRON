#!/usr/bin/env node
'use strict';
// Read-only phone delivery audit. No new reveal, no callback consume, no sheet write.
const fs = require('fs');
const path = require('path');
const config = require('../core/config');
const apollo = require('../core/apollo-enrichment');

async function main() {
const targetSpreadsheetId = String(process.argv[2] || '').trim();
const targetSheetName = String(process.argv[3] || '').trim();
const stateFile = path.join(config.projectRoot, '.ultron', 'lead-enrichment', 'pending-phone-assignments.json');
const stored = fs.existsSync(stateFile)
  ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  : { assignments: [] };
const all = Array.isArray(stored.assignments) ? stored.assignments : [];
const matches = all.filter((item) =>
  (!targetSpreadsheetId || item.spreadsheetId === targetSpreadsheetId)
  && (!targetSheetName || item.sheetName === targetSheetName)
);
const ready = apollo.status();
let webhookAddress = { configured: Boolean(apollo.setting('APOLLO_WEBHOOK_URL')), publicHttps: false };
try {
  const u = new URL(apollo.setting('APOLLO_WEBHOOK_URL'));
  webhookAddress.publicHttps = u.protocol === 'https:'
    && !/^(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0)$/i.test(u.hostname);
} catch {}
const report = {
  mode: 'READ_ONLY_NO_NEW_APOLLO_REVEALS',
  target: { spreadsheetMatched: Boolean(targetSpreadsheetId), worksheetMatched: Boolean(targetSheetName) },
  configured: { apiKey: ready.apiKeyReady, webhookSecret: ready.webhookReady, webhookAddress },
  savedAssignments: {
    total: matches.length,
    native: matches.filter((item) => item.phoneMode !== 'waterfall').length,
    waterfall: matches.filter((item) => item.phoneMode === 'waterfall').length,
    nativeWithRequestId: matches.filter((item) => item.phoneMode !== 'waterfall' && item.phoneRequestId).length,
    nativeWithoutRequestId: matches.filter((item) => item.phoneMode !== 'waterfall' && !item.phoneRequestId).length,
    previousOwnershipErrors: matches.filter((item) => /owner|identity|conflict|column|company/i.test(item.lastError || '')).length,
  },
  callbackStore: { checked: false, success: false },
  directResult: { checked: false },
};
try {
  const results = await apollo.fetchPhoneResults(); // Worker GET /results only.
  const ids = new Set(matches.map((item) => String(item.apolloPersonId || '')));
  const linked = results.filter((item) => ids.has(String(item.apollo_person_id || item.apolloPersonId || '')));
  report.callbackStore = {
    checked: true, success: true, totalResults: results.length,
    matchingPendingOwners: linked.length,
    matchingResultsWithUsablePhone: linked.filter((item) => Boolean(apollo.preferredPhoneFromPayload(item))).length,
  };
} catch (error) {
  report.callbackStore = {
    checked: true, success: false,
    errorCode: String(error?.code || 'CALLBACK_READ_FAILED'),
    httpStatus: Number(error?.status || 0) || null,
  };
}
// One zero-credit GET to Apollo's documented /webhook_result endpoint.
// Never reveal a new person, repeat enrichment, expose a phone, or consume a result.
const sample = matches.find((item) => item.phoneMode !== 'waterfall' && item.phoneRequestId);
if (sample && ready.apiKeyReady) {
  try {
    const result = await apollo.pollWebhookResult(sample.phoneRequestId, { polls: 0 });
    report.directResult = {
      checked: true, state: result.state,
      usablePhonePresent: Boolean(apollo.validPhone(result.phone)),
      webhookStatus: String(result.payload?.webhook_status || '').slice(0, 40) || null,
      dispatchFailurePresent: Boolean(result.payload?.failure_reason),
    };
  } catch (error) {
    report.directResult = {
      checked: true, state: 'error',
      errorCode: String(error?.code || 'DIRECT_RESULT_READ_FAILED'),
      httpStatus: Number(error?.status || 0) || null,
    };
  }
}
report.recommendation = report.savedAssignments.nativeWithoutRequestId
  ? 'Some previously staged native POCs have no Apollo request ID. Do not purchase again automatically; inspect the original reveal receipt or reconcile the callback store.'
  : !report.configured.webhookAddress.publicHttps || !report.callbackStore.success
    ? 'Inspect webhook configuration and worker availability. Apollo may be delivering phones without ULTRON receiving them.'
    : report.directResult.usablePhonePresent
      ? 'Apollo has returned a phone. Reconcile the exact pending row/POC owner before writing; no new paid discovery is needed.'
      : 'No usable number has been confirmed by these limited read-only checks. Do not infer that all pending numbers are unavailable.';
console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({mode:'READ_ONLY_NO_NEW_APOLLO_REVEALS',code:String(error?.code || 'PHONE_DOCTOR_FAILED')}));
  process.exitCode=1;
});
