#!/usr/bin/env node
const auth = require('../core/microsoft-onedrive-auth');
const excel = require('../core/microsoft-excel-operator');

(async () => {
  const state = excel.status();
  if (!state.dependencyReady) {
    console.log('Install the lightweight Excel adapter dependency first: npm install');
    process.exitCode = 1;
    return;
  }
  if (!state.clientIdReady) {
    console.log([
      'MICROSOFT_GRAPH_CLIENT_ID is not configured.',
      '',
      'One-time Microsoft setup:',
      '1. Entra -> App registrations -> open ULTRON OneDrive Operator.',
      '2. Authentication -> Add a platform -> Mobile and desktop applications.',
      '3. Add redirect URI: http://localhost',
      '4. Save. Public client flows may remain enabled.',
      '5. API permissions -> Microsoft Graph -> Delegated -> Files.ReadWrite.',
      '6. Copy the Application (client) ID into the root .env as:',
      '   MICROSOFT_GRAPH_CLIENT_ID=your-client-id',
      '7. Run this command again.',
      '',
      'No client secret is required. ULTRON uses authorization-code + PKCE and stores the refresh token under .ultron/credentials.',
    ].join('\n'));
    process.exitCode = 1;
    return;
  }

  if (state.authorized) {
    console.log(`Microsoft OneDrive/Excel is already authorized. Token: ${state.tokenPath}`);
    return;
  }

  console.log('Starting Microsoft browser login with PKCE for Files.ReadWrite...');
  console.log(`Registered redirect URI required in Entra: http://localhost`);
  const result = await auth.authorizeInteractive();
  console.log(`Microsoft OneDrive/Excel connected. Token saved to: ${result.tokenPath}`);
})().catch((error) => {
  console.error(`Microsoft OneDrive setup failed: ${error.message}`);
  process.exitCode = 1;
});
