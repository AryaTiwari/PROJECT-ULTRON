const instagram = require('../core/instagram');

(async () => {
  try {
    const result = await instagram.verifyConnection();
    console.log(`ULTRON Instagram connection verified: @${result.username || 'unknown'} (${result.accountId}).`);
    console.log(`Credential aliases: token=${result.tokenVariable}, account=${result.accountVariable}.`);
    console.log(`App credentials configured: id=${result.appIdConfigured ? 'yes' : 'no'}, secret=${result.appSecretConfigured ? 'yes' : 'no'}.`);
    process.exitCode = 0;
  } catch (error) {
    console.error(`ULTRON Instagram connection failed: ${error.message}`);
    process.exitCode = 1;
  }
})();
