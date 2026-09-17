#!/usr/bin/env node
'use strict';

const auth = require('../core/google-sheets-auth');
require('../core/universal-deterministic-bootstrap').install();
const sheets = require('../core/google-sheets-operator');

function fail(error, stage = 'unknown') {
  const code = error?.code || 'GOOGLE_SHEETS_HEALTH_FAILED';
  console.error(`[Google Sheets Health] stage: ${stage}`);
  console.error(`[Google Sheets Health] ${code}: ${error?.message || error}`);
  if (error?.status) console.error(`[Google Sheets Health] HTTP status: ${error.status}`);
  if (error?.googleCode) console.error(`[Google Sheets Health] Google code: ${error.googleCode}`);
  if (error?.googleOAuthError) console.error(`[Google Sheets Health] OAuth error: ${error.googleOAuthError}`);
  if (error?.googleStatus) console.error(`[Google Sheets Health] Google status: ${error.googleStatus}`);
  if (error?.endpoint) console.error(`[Google Sheets Health] endpoint: ${error.endpoint}`);
  if (Array.isArray(error?.googleDetails) && error.googleDetails.length) {
    console.error('[Google Sheets Health] Google details:', JSON.stringify(error.googleDetails));
  }
  if (error?.originalRange) console.error(`[Google Sheets Health] Original range: ${error.originalRange}`);
  if (error?.clampedRange) console.error(`[Google Sheets Health] Recovered range: ${error.clampedRange}`);
  if (error?.rangeRecoveryStrategy) console.error(`[Google Sheets Health] Range recovery: ${error.rangeRecoveryStrategy}`);
  if (code === 'GOOGLE_SHEETS_AUTH_REQUIRED' || code === 'GOOGLE_SHEETS_AUTH_DENIED') {
    console.error('[Google Sheets Health] Reauthorize with: node --env-file=../.env scripts\\google-sheets-auth.js');
  }
  process.exitCode = 1;
}

(async () => {
  const source = String(process.argv[2] || process.env.ULTRON_M3_GOOGLE_SHEETS_HEALTH_URL || '').trim();
  const sheetName = String(process.argv[3] || process.env.ULTRON_M3_GOOGLE_SHEETS_HEALTH_TAB || '').trim();
  const range = String(process.argv[4] || 'A:ZZ').trim();

  const status = auth.status();
  console.log('[Google Sheets Health] credentialsReady:', status.credentialsReady);
  console.log('[Google Sheets Health] authorized:', status.authorized);
  console.log('[Google Sheets Health] hasRefreshToken:', status.hasRefreshToken);
  console.log('[Google Sheets Health] tokenExpired:', status.tokenExpired);
  console.log('[Google Sheets Health] tokenScope:', status.tokenScope || '(unknown)');

  try {
    await auth.accessToken();
    console.log('[Google Sheets Health] OAuth access token: OK');
  } catch (error) {
    fail(error, 'oauth');
    return;
  }

  if (!source || !sheetName) {
    console.log('[Google Sheets Health] OAuth is healthy. Pass a spreadsheet URL/id and tab name to test metadata + values.');
    return;
  }

  const id = /docs\.google\.com\/spreadsheets\/d\//i.test(source) ? sheets.spreadsheetId(source) : source;

  try {
    const meta = await sheets.metadata(id);
    const tabs = (meta?.sheets || []).map((item) => String(item?.properties?.title || '')).filter(Boolean);
    console.log('[Google Sheets Health] metadata read: OK');
    console.log('[Google Sheets Health] spreadsheet title:', meta?.properties?.title || '(unknown)');
    console.log('[Google Sheets Health] tabs:', JSON.stringify(tabs));
  } catch (error) {
    fail(error, 'metadata');
    return;
  }

  try {
    const a1 = `${sheets.quoteSheet(sheetName)}!${range}`;
    const rows = await sheets.values(id, a1);
    const header = Array.isArray(rows?.[0]) ? rows[0].map((value) => String(value ?? '')).slice(0, 20) : [];
    console.log('[Google Sheets Health] values read: OK');
    console.log('[Google Sheets Health] requested range:', a1);
    console.log('[Google Sheets Health] rows returned:', rows.length);
    console.log('[Google Sheets Health] header:', JSON.stringify(header));
  } catch (error) {
    fail(error, 'values');
  }
})();
