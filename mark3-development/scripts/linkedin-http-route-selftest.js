#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const routeGuard = require('../core/linkedin-route-guard');
const multimodal = require('../core/multimodal');

const operationalPrompt = [
  'Resume LinkedIn mission a2ef9454-42a0-41f0-abe7-f4ed93a9d6aa.',
  'The LinkedIn MCP backend has been independently verified healthy.',
  'Immediately perform all work that requires ZERO fresh LinkedIn account calls.',
  'Make the canonical Final Master reach exactly 30 verified unique companies.',
  'Hard filters: active SAP-related LinkedIn job, Maharashtra or Bengaluru, maximum 1000 employees.',
  'Report:',
  '- MCP health',
  '- cached search responses reused',
  '- Final Master total',
  '- remaining target',
  '- nextEligibleAt.',
].join('\n');

assert.equal(
  routeGuard.isExplicitLinkedInResearch(operationalPrompt),
  true,
  'The resumed LinkedIn mission must be recognized as explicit LinkedIn research.'
);
assert.equal(
  routeGuard.isExplicitLinkedInArtifactRequest(operationalPrompt),
  false,
  'A Report: section inside a LinkedIn mission must not become an artifact request.'
);
assert.equal(
  routeGuard.isReservedLinkedInCommand(operationalPrompt),
  true,
  'Operational LinkedIn mission must be reserved before generic routing.'
);
assert.equal(
  multimodal.generationIntent(operationalPrompt),
  null,
  'Operational LinkedIn mission must never be converted into PDF/DOCX generation.'
);

const explicitPdf = 'Create a PDF report of my LinkedIn mission results.';
assert.equal(
  routeGuard.isExplicitLinkedInArtifactRequest(explicitPdf),
  true,
  'Explicit LinkedIn PDF request must remain an artifact request.'
);
assert.equal(
  routeGuard.isReservedLinkedInCommand(explicitPdf),
  false,
  'Explicit LinkedIn PDF request must not be reserved as account research.'
);
assert.equal(
  multimodal.generationIntent(explicitPdf)?.kind,
  'pdf',
  'Explicit LinkedIn PDF request must still generate a PDF.'
);

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const reserveIndex = server.indexOf('linkedinRouteGuard.isReservedLinkedInCommand(data.message)');
const selfRepositoryIndex = server.indexOf('selfRepository.handle(data.message,data.history)');
const mediaIndex = server.indexOf('const mediaIntent = multimodal.generationIntent(data.message)');
assert(reserveIndex >= 0, 'HTTP LinkedIn reservation is missing.');
assert(selfRepositoryIndex > reserveIndex, 'LinkedIn reservation must run before self-repository routing.');
assert(mediaIndex > reserveIndex, 'LinkedIn reservation must run before artifact generation.');
assert(
  server.includes('linkedin_http_route_escape_blocked'),
  'HTTP boundary must fail closed if a reserved LinkedIn command escapes to a general model.'
);

console.log('LinkedIn HTTP route boundary self-test passed: operational mission prompts cannot escape into Nemotron/document generation, while explicit LinkedIn artifact requests remain supported.');
