const reelIntel = require('../core/reel-intelligence');
const aesthetic = require('../core/instagram-aesthetic');

function assert(condition, message) { if (!condition) throw new Error(message); }

assert(Array.isArray(reelIntel.REFERENCES) && reelIntel.REFERENCES.length >= 3, 'Reel Intelligence must keep current reference sources.');
assert(reelIntel.REFERENCES.some((item) => /hootsuite/i.test(item.title)), 'Hootsuite must remain a Reel Intelligence reference.');
assert(Array.isArray(reelIntel.FALLBACK_PATTERNS) && reelIntel.FALLBACK_PATTERNS.length >= 4, 'Offline trend fallback must contain format patterns, not topic slogans.');

const selected = reelIntel.selectFormats({ formats: reelIntel.FALLBACK_PATTERNS }, 'why creator retention drops after a viral reel', 'premium educational strategy', 3);
assert(selected.length === 3, 'Format selector must return a ranked shortlist.');
assert(selected.some((item) => /pattern|search|authority|drama/i.test(item.name)), 'Educational creator brief should select a useful structured format.');

const style = reelIntel.enrichedStyle('dark cinematic', 'FORMAT OPTIONS: pattern-analysis explainer. ACCOUNT AESTHETIC: dark, muted.');
assert(/CREATIVE INTELLIGENCE/i.test(style), 'Reel style must carry intelligence context into the director.');
assert(/pattern-analysis/i.test(style), 'Selected format intelligence must survive director enrichment.');

const palette = aesthetic.paletteFromPixels([
  { r: 20, g: 25, b: 30 }, { r: 25, g: 28, b: 32 }, { r: 220, g: 210, b: 200 }, { r: 18, g: 22, b: 28 },
]);
assert(Array.isArray(palette) && palette.length >= 1, 'Instagram aesthetic analyzer must produce a local palette from sampled pixels.');
const tags = aesthetic.classifyVisual({ r: 25, g: 28, b: 32 }, 0.1);
assert(tags.includes('dark') && tags.includes('muted'), 'Dark muted account aesthetics must be classified correctly.');

const status = reelIntel.status();
assert(status.implemented === true, 'Reel Intelligence must report implemented.');
assert(status.adaptive?.policy?.externalActionsRequireApproval === true, 'Reel Intelligence must inherit Adaptive Intelligence approval policy.');

console.log('ULTRON Reel Intelligence self-test passed: Hootsuite references, format selection, account-aesthetic signals and adaptive context validated.');
