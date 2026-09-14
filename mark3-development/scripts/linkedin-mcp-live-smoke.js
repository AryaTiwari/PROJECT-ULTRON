#!/usr/bin/env node
const mcp = require('../core/linkedin-mcp-client');
const policy = require('../core/linkedin-account-policy');

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const keywords = arg('--keywords', 'SAP');
  const location = arg('--location', 'Maharashtra');

  console.log('LinkedIn MCP live smoke test');
  console.log('Transport:', mcp.status().transport);
  console.log('Package:', mcp.PACKAGE_SPEC);
  console.log('Safety before:', policy.status());
  console.log(`Calling search_jobs once: keywords="${keywords}", location="${location}", max_pages=1`);

  try {
    const result = await mcp.callTool('search_jobs', {
      keywords,
      location,
      max_pages: 1,
      sort_by: 'relevance',
    });
    const ids = Array.isArray(result?.job_ids) ? result.job_ids.map(String) : [];
    console.log('LIVE LINKEDIN MCP: PASS');
    console.log('job_ids:', ids.length);
    console.log('sample_job_ids:', ids.slice(0, 10));
    console.log('url:', result?.url || null);
    console.log('section_errors:', result?.section_errors || null);
    console.log('Safety after:', policy.status());
  } catch (error) {
    console.error('LIVE LINKEDIN MCP: FAIL');
    console.error('code:', error.code || null);
    console.error('message:', error.message || String(error));
    console.error('linkedinSafety:', error.linkedinSafety || null);
    console.error('sessionRecovered:', Boolean(error.sessionRecovered));
    console.error('recoveryError:', error.recoveryError || null);
    console.error('MCP status:', mcp.status());
    console.error('Safety status:', policy.status());
    process.exitCode = 1;
  } finally {
    await mcp.shutdown();
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
