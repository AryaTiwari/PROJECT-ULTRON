#!/usr/bin/env node
const auth = require('../core/google-sheets-auth');

(async () => {
  try {
    const result = await auth.authorizeInteractive();
    console.log('Google Sheets connected. Token saved privately.');
    console.log(result.tokenPath);
  } catch (error) {
    console.error(`Google Sheets authorization failed: ${error.message}`);
    process.exitCode = 1;
  }
})();
