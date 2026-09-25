'use strict';

const auth = require('../core/google-sheets-auth');

(async () => {
  const before = auth.status();
  const report = {
    ok: false,
    credentialsReady: before.credentialsReady,
    authorized: before.authorized,
    durableAuthorization: before.durableAuthorization,
    hasRefreshToken: before.hasRefreshToken,
    tokenExpired: before.tokenExpired,
    tokenExpiresAt: before.tokenExpiresAt,
    tokenExpiresInMs: before.tokenExpiresInMs,
    tokenScope: before.tokenScope,
    tokenAuthorizedAt: before.tokenAuthorizedAt,
    healthReason: before.healthReason,
    credentialsPath: before.credentialsPath,
    tokenPath: before.tokenPath,
    tokenBackupPath: before.tokenBackupPath,
    refreshValidation: null,
  };

  try {
    // A forced refresh validates the durable offline credential rather than only
    // proving that a still-live short-lived access token exists.
    const token = await auth.accessToken({ forceRefresh: true });
    report.ok = Boolean(token);
    report.refreshValidation = 'ok';
    Object.assign(report, {
      after: auth.status(),
    });
  } catch (error) {
    report.refreshValidation = 'failed';
    report.error = {
      code: error?.code || 'GOOGLE_SHEETS_AUTH_CHECK_FAILED',
      message: error?.message || String(error),
      authReason: error?.authReason || null,
      googleOAuthError: error?.googleOAuthError || null,
      status: error?.status || null,
      reauthorizeCommand: error?.reauthorizeCommand || 'node --env-file=../.env scripts\\google-sheets-auth.js',
    };
  }

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
