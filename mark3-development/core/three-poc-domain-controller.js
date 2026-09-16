// First-class command owner for anchored/explicit 3-POC spreadsheet enrichment.
// This controller intentionally never invokes the general assistant/model router.
const enrichment = require('./lead-enrichment-bootstrap');

async function handle(message, context = {}) {
  const result = await enrichment.handleThreePocCommand(message, context);
  return result || enrichment.responseShape(false,
    'The 3-POC spreadsheet domain owns this command but could not compile it safely. Apollo was not called and no general model was invoked.',
    { error: 'THREE_POC_COMMAND_UNCOMPILED', apolloCalled: false, taskType: 'three-poc-enrichment' }
  );
}

module.exports = { handle };
