#!/usr/bin/env node
const auth = require('../core/google-sheets-auth');

(async () => {
  try {
    const result = await auth.authorizeInteractive();
    console.log('Google Sheets connected with durable offline authorization.');
    console.log('Refresh token present:', result.hasRefreshToken === true);
    console.log('Token path:', result.tokenPath);
  } catch (error) {
    console.error(`Google Sheets authorization failed: ${error.message}`);
    process.exitCode = 1;
  }
})();
