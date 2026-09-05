const adaptive = require('../core/adaptive-intelligence');
const adaptiveBootstrap = require('../core/adaptive-bootstrap');

function assert(condition, message) { if (!condition) throw new Error(message); }

assert(adaptive.domainFor('the reel has too much text') === 'creator-content', 'Reel feedback must route to creator-content learning.');
assert(adaptive.domainFor('this dashboard typography is ugly') === 'design', 'Visual UI feedback must route to design learning.');
assert(adaptive.domainFor('fix the GitHub repository bug') === 'development', 'Repository feedback must route to development learning.');

const negative = adaptive.extractPreference('I do not like translucent boxes behind Reel text; use less text.');
assert(negative && negative.domain === 'creator-content', 'Explicit Reel correction must be captured.');
assert(negative.polarity === -1, 'Negative preference feedback must carry negative polarity.');
assert(negative.explicit === true && negative.confidence >= 0.8, 'Explicit feedback must be high-confidence evidence.');

const positive = adaptive.extractPreference('I prefer clean minimal typography and want more like this.');
assert(positive && positive.polarity === 1, 'Positive explicit preference must be captured.');
const ordinaryTask = adaptive.extractPreference('I want you to send an email to the client tomorrow.');
assert(ordinaryTask === null, 'Ordinary executable task requests must not become permanent preferences.');
const reelTask = adaptive.extractPreference('I want you to create a 20 second Reel about creator growth.');
assert(reelTask === null, 'Ordinary Reel-generation requests must not become style preferences.');
const styleWant = adaptive.extractPreference('I want the response style to be shorter and cleaner.');
assert(styleWant && styleWant.domain === 'communication', 'I want should count only when it clearly describes style or behavior.');
const reelStyleWant = adaptive.extractPreference('I want the Reel style to be cleaner with less text and more natural editing.');
assert(reelStyleWant && reelStyleWant.domain === 'creator-content', 'Qualitative Reel-style directions must be learned.');

assert(adaptive.approvalIntent('approve') === 'approve', 'Approval intent must be recognized.');
assert(adaptive.approvalIntent('do it') === 'approve', 'Natural approval must be recognized.');
assert(adaptive.approvalIntent('reject') === 'reject', 'Rejection intent must be recognized.');
assert(adaptive.approvalIntent('tell me more') === null, 'Normal conversation must not be mistaken for approval.');
assert(adaptiveBootstrap.proposalDecisionIntent('approve the adaptive suggestion') === 'approve', 'Explicit adaptive proposal approval must be recognized.');
assert(adaptiveBootstrap.proposalDecisionIntent('reject that adaptive proposal') === 'reject', 'Explicit adaptive proposal rejection must be recognized.');
assert(adaptiveBootstrap.isInstagramAestheticRequest('Ultron, analyze my Instagram aesthetic and feed style'), 'Natural Instagram aesthetic analysis request must be recognized.');

const status = adaptive.status();
assert(status.policy.externalActionsRequireApproval === true, 'Adaptive external actions must remain approval-gated.');
assert(status.policy.inferSensitiveTraits === false, 'Adaptive Intelligence must not infer sensitive traits.');

console.log('ULTRON Adaptive Intelligence self-test passed: explicit preference learning, task-vs-preference separation, domain routing, Instagram aesthetic intent and approval-gated execution validated.');
