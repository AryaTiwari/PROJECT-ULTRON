#!/usr/bin/env node
'use strict';
const control=require('../core/universal-enrichment-control-plane');
const diagnostics=require('../core/adaptive-diagnostic-layer');
const googleAuth=require('../core/google-sheets-auth');
const result=control.health();
console.log(result.text);
const summary=diagnostics.summary();
const auth=googleAuth.status();
console.log(JSON.stringify({
  diagnosticStatus:summary.status,
  recent:summary.recent,
  benchmark:{
    healthy:summary.benchmark?.healthy||false,
    verifiedAt:summary.benchmark?.lastKnownGood?.verifiedAt||null,
    improvement:summary.benchmark?.lastKnownGood?.report?.improvement||null,
    safety:summary.benchmark?.lastKnownGood?.report?.safety||null,
  },
  googleSheets:{
    credentialsReady:auth.credentialsReady,
    durableAuthorization:auth.durableAuthorization,
    hasRefreshToken:auth.hasRefreshToken,
    tokenExpired:auth.tokenExpired,
    healthReason:auth.healthReason,
    reconnectUrl:auth.lastAuthEvent?.authUrl||null,
  },
},null,2));
