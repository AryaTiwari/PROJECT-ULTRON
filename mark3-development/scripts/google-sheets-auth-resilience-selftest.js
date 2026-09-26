'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-google-auth-selftest-'));
process.env.GOOGLE_SHEETS_TOKEN_PATH = path.join(tempRoot, 'token.json');
process.env.GOOGLE_SHEETS_OAUTH_PATH = path.join(tempRoot, 'oauth.json');

fs.writeFileSync(process.env.GOOGLE_SHEETS_OAUTH_PATH, JSON.stringify({
  installed: {
    client_id: 'test-client',
    client_secret: 'test-secret',
    auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  },
}, null, 2));

const auth = require('../core/google-sheets-auth');

(async () => {
  try {
    const durable = {
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_at: Date.now() + 60 * 60 * 1000,
      scope: auth.SCOPE,
    };
    auth.saveToken(durable);
    let status = auth.status();
    assert.equal(status.authorized, true);
    assert.equal(status.durableAuthorization, true);
    assert.equal(status.hasRefreshToken, true);
    assert.equal(status.healthReason, 'durable_authorization_ready');

    // A valid access token must be usable without a forced refresh merely because
    // the process started. This prevents restart-time refresh from being a new
    // daily failure point.
    const token = await auth.accessToken();
    assert.equal(token, 'access-1');

    // Atomic persistence must leave a recoverable backup after a later write.
    auth.saveToken({
      ...durable,
      access_token: 'access-2',
      expires_at: Date.now() + 50 * 60 * 1000,
    });
    assert.equal(fs.existsSync(auth.tokenBackupPath()), true);

    // Corrupt the primary and prove loadToken restores the last known-good backup.
    fs.writeFileSync(auth.tokenPath(), '{ definitely not json');
    const recovered = auth.loadToken();
    assert.equal(recovered.refresh_token, 'refresh-1');
    assert.equal(auth.status().lastAuthEvent?.type, 'token-recovered-from-backup');

    // A token minted for another OAuth client must never be silently reused.
    auth.saveToken({
      ...durable,
      client_id: 'different-client',
    });
    await assert.rejects(
      () => auth.accessToken(),
      (error) => error?.code === 'GOOGLE_SHEETS_AUTH_REQUIRED'
        && error?.authReason === 'oauth_client_mismatch'
    );
    status = auth.status();
    assert.equal(status.clientCompatible, false);
    assert.equal(status.durableAuthorization, false);
    assert.equal(status.healthReason, 'oauth_client_mismatch');

    // Likewise, an explicitly incompatible granted scope must require new consent.
    auth.saveToken({
      ...durable,
      client_id: 'test-client',
      scope: 'https://www.googleapis.com/auth/drive.readonly',
    });
    await assert.rejects(
      () => auth.accessToken(),
      (error) => error?.code === 'GOOGLE_SHEETS_AUTH_REQUIRED'
        && error?.authReason === 'scope_incompatible'
    );
    status = auth.status();
    assert.equal(status.scopeCompatible, false);
    assert.equal(status.durableAuthorization, false);
    assert.equal(status.healthReason, 'scope_incompatible');

    // Short-lived-only credentials are allowed while still alive but are clearly
    // diagnosed as non-durable.
    auth.saveToken({
      access_token: 'short-lived',
      expires_at: Date.now() + 30 * 60 * 1000,
      scope: auth.SCOPE,
    });
    status = auth.status();
    assert.equal(status.authorized, true);
    assert.equal(status.durableAuthorization, false);
    assert.equal(status.healthReason, 'refresh_token_missing');
    assert.equal(await auth.accessToken(), 'short-lived');

    // Once that access token expires, ULTRON must explain the real problem.
    auth.saveToken({
      access_token: 'expired-short-lived',
      expires_at: Date.now() - 10_000,
      scope: auth.SCOPE,
    });
    await assert.rejects(
      () => auth.accessToken(),
      (error) => error?.code === 'GOOGLE_SHEETS_AUTH_REQUIRED'
        && error?.authReason === 'refresh_token_missing'
    );

    const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'google-sheets-auth.js'), 'utf8');
    assert.match(source, /refresh_token:\s*token\.refresh_token \|\| previous\?\.refresh_token \|\| ''/);
    assert.match(source, /authorization returned only a short-lived access token/i);
    assert.doesNotMatch(source, /if \(!sessionValidated \|\| forceRefresh\)/, 'restart alone must not force OAuth refresh');
    assert.match(source, /token-recovered-from-backup/);

    const apolloControllerSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'apollo-lead-domain-controller.js'), 'utf8');
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(apolloControllerSource, /errorCode:\s*code/);
    assert.match(apolloControllerSource, /reauthorizeCommand/);
    assert.match(apolloControllerSource, /authReason/);
    assert.match(serverSource, /Authorization is not durable/);
    assert.match(serverSource, /google-sheets:doctor/);

    console.log('Google Sheets auth resilience self-test passed: valid tokens survive restarts without unnecessary refresh, refresh tokens are preserved across reauthorization, token writes are recoverable, and short-lived-only authorization is detected before it becomes a surprise.');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});
