const fs = require('fs');
const os = require('os');
const path = require('path');
const assetPack = require('../core/reel-asset-pack');
const rescue = require('../core/reel-asset-rescue');

function assert(condition, message) { if (!condition) throw new Error(message); }

const status = assetPack.status();
assert(status.implemented === true, 'Built-in Reel asset pack must be implemented.');
assert(status.assetCount >= 30, 'Built-in Reel asset pack must contain a broad production-ready asset set.');
assert(status.networkRequired === false && status.apiKeyRequired === false, 'Built-in Reel asset pack must never depend on network or API keys.');
assert(status.zeroCost === true && status.commercialUse === true, 'Built-in Reel asset pack must remain zero-cost and commercially usable.');
assert(status.alwaysAvailable === true && status.emergencyCarrier === true, 'Asset pack must expose an always-available emergency carrier.');
assert(rescue.status().terminalMissingAssetFailure === false, 'Missing stock assets must not be a terminal Reel failure anymore.');

const cases = [
  [{ visualDesign: { mode: 'retention-chart' }, narration: 'Viewers leave after the hook.' }, 'retention-curve'],
  [{ visualDesign: { mode: 'conversion-funnel' }, narration: 'Views need to convert into profile visits and follows.' }, 'conversion-funnel'],
  [{ visualDesign: { mode: 'comparison-card' }, narration: 'Views versus loyal followers.' }, 'comparison-split'],
  [{ narration: 'Brands do not buy follower count alone. Build brand readiness.' }, 'brand-readiness'],
  [{ narration: 'Plan your posting schedule and content calendar.' }, 'content-calendar'],
  [{ narration: 'Creators need a loyal community, not empty reach.' }, 'audience-community'],
];
for (const [scene, expected] of cases) {
  assert(assetPack.resolve(scene).id === expected, `Asset resolver must map scene to ${expected}.`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-reel-assets-'));
try {
  const destination = path.join(dir, 'test.png');
  const saved = assetPack.materialize({ visualDesign: { mode: 'metric-stack' }, narration: 'Track views, saves and followers.' }, destination, { index: 0 });
  assert(fs.existsSync(destination), 'Built-in asset materialization must create a local file.');
  assert(fs.statSync(destination).size > 4096, 'Built-in asset must be a real non-trivial image.');
  const signature = fs.readFileSync(destination).subarray(0, 8);
  assert(signature.equals(Buffer.from([137,80,78,71,13,10,26,10])), 'Built-in asset must be a valid PNG file.');
  assert(saved.provider === 'ultron-elevate-asset-pack' && saved.internalAsset === true, 'Materialized asset must preserve internal asset provenance.');
  assert(saved.commercialUse === true && saved.noNetwork === true, 'Materialized asset must be commercially usable and offline.');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`ULTRON Reel Asset Pack self-test passed: ${status.assetCount} built-in Elevate assets, semantic resolver, local PNG generation, zero-network commercial fallback and non-terminal missing-asset policy validated.`);
