#!/usr/bin/env node
const auth = require('../core/google-sheets-auth');
const apollo = require('../core/apollo-enrichment');
const lead = require('../core/lead-enrichment-operator');

(async () => {
  try {
    const google = auth.status();
    if (!google.credentialsReady) throw new Error(`Google OAuth JSON missing: ${google.credentialsPath}`);
    const apolloStatus = apollo.status();
    if (!apolloStatus.apiKeyReady) throw new Error('APOLLO_API_KEY is missing from your ULTRON .env.');
    if (!apolloStatus.webhookReady) throw new Error('APOLLO_WEBHOOK_URL or APOLLO_WEBHOOK_SECRET is missing from your ULTRON .env.');

    const webhook = new URL(apollo.setting('APOLLO_WEBHOOK_URL'));
    const health = await fetch(webhook.origin).then((r) => r.json()).catch(() => null);
    if (!health?.ok || health.database !== true) throw new Error('Cloudflare Apollo webhook health check failed.');

    if (!google.authorized) await auth.authorizeInteractive();

    const final = lead.status();
    if (!final.ready) throw new Error('Setup finished but one connector still reports not ready.');
    console.log('READY: Apollo + Google Sheets lead enrichment is connected to ULTRON.');
  } catch (error) {
    console.error(`SETUP STOPPED: ${error.message}`);
    process.exitCode = 1;
  }
})();
