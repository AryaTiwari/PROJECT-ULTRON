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
    && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(u.hostname);
} catch {}
// Worker implementations can use different person-ID keys. Inspect only
// aggregate key presence; never print callback records, phone numbers or IDs.
function callbackPersonIds(item = {}) {
  const fields = [
    item.apollo_person_id, item.apolloPersonId, item.person_id, item.personId,
    item.person?.id, item.payload?.person?.id,
    ...(Array.isArray(item.people) ? item.people.map((person) => person?.id) : []),
    ...(Array.isArray(item.payload?.people) ? item.payload.people.map((person) => person?.id) : []),
  ];
  return [...new Set(fields.map((value) => String(value ?? '').trim()).filter(Boolean))];
}
function countBy(items, key) {
  const out = {};
  for (const item of items) {
    const k = String(key(item) || 'unavailable').slice(0, 60);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}
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
  cacheCrossCheck: { checked: false },
  directResult: { checked: false },
};
try {
  const cache = apollo.readCache();
  const cachedByPerson = new Map();
  for (const person of Object.values(cache?.people || {})) {
    const id = String(person?.apolloPersonId || '');
    if (id && !cachedByPerson.has(id)) cachedByPerson.set(id, person);
  }
  const matched = matches.map((item) => ({ item, person: cachedByPerson.get(String(item.apolloPersonId || '')) }))
    .filter((entry) => entry.person);
  report.cacheCrossCheck = {
    checked: true,
    pendingOwnersInCache: matched.length,
    matchingRequestReceipts: matched.filter(({item,person}) =>
      String(item.phoneRequestId || '') === String(person.phoneRequestId || '')).length,
    differingRequestReceipts: matched.filter(({item,person}) =>
      Boolean(item.phoneRequestId && person.phoneRequestId)
      && String(item.phoneRequestId) !== String(person.phoneRequestId)).length,
    cachedVerifiedPhoneAvailable: matched.filter(({person}) => Boolean(apollo.validPhone(person.phone))).length,
    cachedPhantomPending: matched.filter(({person}) =>
      person.phoneStatus === 'pending' && !person.phoneRequestId).length,
  };
} catch {
  report.cacheCrossCheck = {checked:false,error:'CACHE_CROSS_CHECK_UNAVAILABLE'};
}
try {
  const results = await apollo.fetchPhoneResults(); // Worker GET /results only.
  const ids = new Set(matches.map((item) => String(item.apolloPersonId || '')));
  const linked = results.filter((item) => callbackPersonIds(item).some((id) => ids.has(id)));
  report.callbackStore = {
    checked: true, success: true, totalResults: results.length,
    // Exactly 100 entries may reflect the worker's result window. Do not
    // infer it has no older callbacks merely because the displayed page misses them.
    possibleLimitedResultWindow: results.length === 100,
    withRecognizablePersonId: results.filter((item) => callbackPersonIds(item).length > 0).length,
    idKeyCounts: {
      apollo_person_id: results.filter((item) => Boolean(item?.apollo_person_id)).length,
      apolloPersonId: results.filter((item) => Boolean(item?.apolloPersonId)).length,
      person_id: results.filter((item) => Boolean(item?.person_id)).length,
      personId: results.filter((item) => Boolean(item?.personId)).length,
      nestedPeople: results.filter((item) => Boolean(item?.people?.length || item?.payload?.people?.length)).length,
    },
    resultsWithUsablePhone: results.filter((item) => Boolean(apollo.preferredPhoneFromPayload(item))).length,
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
// Up to three distinct zero-credit GETs, evenly distributed through saved
// request owners. A single old/invalid request is NOT representative of all 34.
const eligible = matches.filter((item) => item.phoneMode !== 'waterfall' && item.phoneRequestId);
const positions = [0, Math.floor((eligible.length - 1) / 2), eligible.length - 1];
const samples = [...new Map(positions.map((index) => eligible[index]).filter(Boolean)
  .map((item) => [String(item.phoneRequestId), item])).values()].slice(0, 3);
const directOutcomes = [];
if (ready.apiKeyReady) for (const item of samples) {
  try {
    const result = await apollo.pollWebhookResult(item.phoneRequestId, { polls: 0 });
    const returnedPeople = result.payload?.webhook_result?.people || [];
    const returnedIds = Array.isArray(returnedPeople)
      ? returnedPeople.map((person) => String(person?.id || '')).filter(Boolean)
      : [];
    const ownId = String(item.apolloPersonId || '');
    directOutcomes.push({
      state: String(result.state || 'unknown'),
      terminalReason: String(result.terminalReason || '') || null,
      usablePhonePresent: Boolean(apollo.validPhone(result.phone)),
      webhookStatus: String(result.payload?.webhook_status || '').slice(0, 40) || null,
      providerRequestType: String(result.payload?.request_type || '').slice(0, 40) || null,
      returnedPersonIdConsistent: returnedIds.length ? returnedIds.includes(ownId) : null,
      dispatchFailurePresent: Boolean(result.payload?.failure_reason),
    });
  } catch (error) {
    directOutcomes.push({
      state: 'error',
      errorCode: String(error?.code || 'DIRECT_RESULT_READ_FAILED'),
      httpStatus: Number(error?.status || 0) || null,
    });
    // Never keep polling into provider rate limits.
    if (Number(error?.status || 0) === 429) break;
  }
}
report.directResult = {
  checked: directOutcomes.length > 0,
  sampledCount: directOutcomes.length,
  states: countBy(directOutcomes, (item) => item.state),
  terminalReasons: countBy(directOutcomes.filter((item) => item.terminalReason), (item) => item.terminalReason),
  usablePhoneResponses: directOutcomes.filter((item) => item.usablePhonePresent).length,
  matchedResponseOwners: directOutcomes.filter((item) => item.returnedPersonIdConsistent === true).length,
  mismatchedResponseOwners: directOutcomes.filter((item) => item.returnedPersonIdConsistent === false).length,
  webhookStatuses: countBy(directOutcomes.filter((item) => item.webhookStatus), (item) => item.webhookStatus),
  requestTypes: countBy(directOutcomes.filter((item) => item.providerRequestType), (item) => item.providerRequestType),
  deliveryFailures: directOutcomes.filter((item) => item.dispatchFailurePresent).length,
  errors: countBy(directOutcomes.filter((item) => item.errorCode), (item) => item.errorCode),
};
report.recommendation = report.savedAssignments.nativeWithoutRequestId
  ? 'Some previously staged native POCs have no Apollo request ID. Do not purchase again automatically; inspect the original reveal receipt or reconcile the callback store.'
  : !report.configured.webhookAddress.publicHttps || !report.callbackStore.success
    ? 'Inspect webhook configuration and worker availability. Apollo may be delivering phones without ULTRON receiving them.'
    : report.directResult.usablePhoneResponses
      ? 'Apollo has returned a phone. Reconcile the exact pending row/POC owner before writing; no new paid discovery is needed.'
      : 'No usable number has been confirmed by these limited read-only checks. Do not infer that all pending numbers are unavailable.';
console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({mode:'READ_ONLY_NO_NEW_APOLLO_REVEALS',code:String(error?.code || 'PHONE_DOCTOR_FAILED')}));
  process.exitCode=1;
});
