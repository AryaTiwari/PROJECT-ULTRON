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
      '1. Microsoft Entra admin center -> App registrations -> New registration.',
      '2. Supported account types: organizational directories + personal Microsoft accounts.',
      '3. Authentication -> enable Allow public client flows.',
      '4. API permissions -> Microsoft Graph -> Delegated -> Files.ReadWrite.',
      '5. Copy the Application (client) ID into the root .env as:',
      '   MICROSOFT_GRAPH_CLIENT_ID=your-client-id',
      '6. Run this command again.',
      '',
      'No client secret is required. ULTRON uses device-code login and stores the refresh token under .ultron/credentials.',
    ].join('\n'));
    process.exitCode = 1;
    return;
  }

  if (state.authorized) {
    console.log(`Microsoft OneDrive/Excel is already authorized. Token: ${state.tokenPath}`);
    return;
  }

  console.log('Starting Microsoft device-code login for Files.ReadWrite...');
  const result = await auth.authorizeInteractive();
  console.log(`Microsoft OneDrive/Excel connected. Token saved to: ${result.tokenPath}`);
})().catch((error) => {
  console.error(`Microsoft OneDrive setup failed: ${error.message}`);
  process.exitCode = 1;
});
