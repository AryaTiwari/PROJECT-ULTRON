// Single domain entry point, independent of preload and assistant.handle order.
const account = require('./linkedin-account-bootstrap');
async function handle(message, context = {}) {
  const result = await account.handle(message, context);
  return result || account.responseShape(false, 'LinkedIn owns this command, but could not compile it safely. No general model was invoked.', { error: 'LINKEDIN_COMMAND_UNCOMPILED' });
}
module.exports = { handle, initialize: account.initialize };
