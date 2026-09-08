const forge = require('../core/forge/bootstrap');
const reels = require('../core/reel-operator-bootstrap');

function assert(condition, message) { if (!condition) throw new Error(message); }

assert(forge.explicitSubsystemStatusIntent('Ultron, Reel Factory status'), 'Reel Factory status must be recognized as an explicit subsystem status intent.');
assert(forge.explicitSubsystemStatusIntent('Check Instagram connection status'), 'Instagram connection status must be protected from Forge project-status routing.');
assert(forge.explicitSubsystemStatusIntent('Reel narrator readiness'), 'Reel narrator readiness must be protected from Forge project-status routing.');
assert(!forge.explicitSubsystemStatusIntent('Forge status'), 'Forge status must remain a Forge command.');
assert(!forge.explicitSubsystemStatusIntent('What is the status of the creator CRM project?'), 'Generic project status must remain eligible for Forge mission matching.');
assert(reels.isReelStatusRequest('Ultron, Reel Factory status'), 'Reel Factory operator must recognize the protected command after Forge falls through.');

console.log('ULTRON Forge routing self-test passed: explicit subsystem status commands bypass Forge mission-status hijacking while Forge status remains intact.');
