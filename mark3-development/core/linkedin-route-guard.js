// Compatibility predicates only. Ownership lives at the HTTP command boundary;
// no response blocker and no assistant.handle wrapper is installed here.
const control = require('./command-control-plane');
const isReservedLinkedInCommand = text => control.claim(text).exclusive;
const isExplicitLinkedInArtifactRequest = text => control.claim(text).domain === 'artifact';
const isExplicitLinkedInResearch = text => isReservedLinkedInCommand(text) || isExplicitLinkedInArtifactRequest(text);
module.exports = { isReservedLinkedInCommand, isExplicitLinkedInArtifactRequest, isExplicitLinkedInResearch,
  install: () => ({ installed: true, centralized: true, failClosed: true }), uninstall: () => true };
