const buffer = require('../core/buffer');

(async () => {
  if (!buffer.status().apiKeyConfigured) {
    console.error('ULTRON Buffer live test: BUFFER_API_KEY is not configured in the root .env.');
    process.exitCode = 1;
    return;
  }
  try {
    const result = await buffer.verifyConnection();
    console.log(`ULTRON Buffer connection verified: ${result.organizations.length} organization(s), ${result.channelCount} connected channel(s).`);
    console.log(`Services: ${result.services.join(', ') || 'none discovered'}.`);
    console.log('No API key was printed. No post was created or scheduled.');
  } catch (error) {
    console.error(`ULTRON Buffer live test failed: ${error.message}`);
    process.exitCode = 1;
  }
})();
