// First-class command owner for anchored/explicit 3-POC spreadsheet enrichment.
// This controller intentionally never invokes the general assistant/model router.
const enrichment = require('./lead-enrichment-bootstrap');
const apolloQuality = require('./apollo-three-poc-quality').install();

async function handle(message, context = {}) {
  // A user 3-POC command starts a fresh bounded deep-enrichment budget. The
  // approval reply itself does not pass through this controller, so the same
  // budget remains active for the subsequently approved enrichment run.
  apolloQuality.startRun();
  const result = await enrichment.handleThreePocCommand(message, context);
  return result || enrichment.responseShape(false,
    'The 3-POC spreadsheet domain owns this command but could not compile it safely. Apollo was not called and no general model was invoked.',
    { error: 'THREE_POC_COMMAND_UNCOMPILED', apolloCalled: false, taskType: 'three-poc-enrichment' }
  );
}

module.exports = { handle };
