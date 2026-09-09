const fs = require('fs');
const path = require('path');
const vault = require('../core/elevate-graphics-vault');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pngInfo(file) {
  const bytes = fs.readFileSync(file);
  const signature = bytes.subarray(0, 8).toString('hex');
  return {
    signature,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    bytes: bytes.length,
  };
}

(() => {
  const first = vault.ensure({ force: true });
  assert(first.ok, 'Graphics vault failed to materialize.');
  assert(vault.ready(), 'Graphics vault did not report ready after materialization.');
  assert(first.counts.backgrounds === 13, `Expected 13 backgrounds, received ${first.counts.backgrounds}.`);
  assert(first.counts.metrics === 15, `Expected 15 metric icons, received ${first.counts.metrics}.`);
  assert(first.counts.ui === 11, `Expected 11 UI assets, received ${first.counts.ui}.`);
  assert(first.counts.charts === 6, `Expected 6 chart/data assets, received ${first.counts.charts}.`);
  assert(first.counts.fx === 9, `Expected 9 reusable FX assets, received ${first.counts.fx}.`);
  assert(first.totalAssets === 54, `Expected 54 built-in graphics assets, received ${first.totalAssets}.`);
  assert(first.zeroSetup === true, 'Graphics vault must be zero-setup.');
  assert(first.networkRequired === false, 'Graphics vault must not require a network connection.');

  const initial = vault.asset('backgrounds', 'initial_gradient_glow');
  const devil = vault.asset('backgrounds', 'devil_red_chaos');
  const creator = vault.asset('backgrounds', 'creator_content_studio');
  const views = vault.asset('metrics', 'views');
  const followers = vault.asset('metrics', 'followers');
  const comments = vault.asset('metrics', 'comments');
  const shares = vault.asset('metrics', 'shares');
  const skip = vault.asset('metrics', 'skip_rate');
  const retention = vault.asset('metrics', 'retention');
  const retentionGraph = vault.asset('charts', 'retention_graph');
  const funnel = vault.asset('charts', 'funnel');
  const lowRetention = vault.asset('ui', 'low_retention');
  const skipButton = vault.asset('ui', 'skip');

  for (const file of [initial, devil, creator, views, followers, comments, shares, skip, retention, retentionGraph, funnel, lowRetention, skipButton]) {
    assert(file && fs.existsSync(file), `Expected built-in graphics asset is missing: ${file}`);
    const info = pngInfo(file);
    assert(info.signature === '89504e470d0a1a0a', `Asset is not a valid PNG: ${file}`);
    assert(info.colorType === 6, `Asset is not RGBA/transparent-capable: ${file}`);
    assert(info.bytes > 100, `Asset is unexpectedly small: ${file}`);
  }

  assert(pngInfo(initial).width === 1080 && pngInfo(initial).height === 1920, 'Built-in Reel backgrounds must be 1080x1920.');
  assert(pngInfo(views).width === 256 && pngInfo(views).height === 256, 'Metric icons must use the standard 256x256 transparent canvas.');

  const conflictScene = { characterStory: { stage: 'conflict-split', type: 'devil-interruption', prop: 'retention-graph' } };
  const diagnosisScene = { characterStory: { stage: 'diagnosis-split', type: 'doctor-diagnosis', prop: 'retention-graph' } };
  const conversionScene = { characterStory: { stage: 'explanation-stage', type: 'story-explanation', prop: 'conversion-funnel' } };
  assert(/devil_/.test(path.basename(vault.backgroundForScene(conflictScene, 1))), 'Devil conflict must resolve to a Devil background.');
  assert(/creator_/.test(path.basename(vault.backgroundForScene(diagnosisScene, 3))), 'Doctor diagnosis must resolve to a Creator Universe background.');

  const retentionKit = vault.visualKitForScene(conflictScene);
  assert(retentionKit.metrics.includes('retention') && retentionKit.metrics.includes('skip_rate'), 'Retention scene must receive retention and skip-rate metric icons.');
  assert(retentionKit.chart === 'retention_graph', 'Retention scene must receive the retention graph.');
  assert(retentionKit.ui.includes('skip'), 'Devil interruption must receive the SKIP UI asset.');

  const conversionKit = vault.visualKitForScene(conversionScene);
  assert(conversionKit.metrics.includes('profile_visits') && conversionKit.metrics.includes('followers') && conversionKit.metrics.includes('conversion'), 'Conversion scene must receive profile, follower and conversion icons.');
  assert(conversionKit.chart === 'funnel', 'Conversion scene must receive the funnel data visual.');

  // Prove cache deletion is not a user setup problem. Remove one generated file,
  // run ensure(), and require the engine to restore it by itself.
  const disposable = vault.asset('metrics', 'likes');
  const oldHash = vault.checksum(disposable);
  fs.unlinkSync(disposable);
  assert(!fs.existsSync(disposable), 'Self-healing test failed to remove the disposable asset.');
  const healed = vault.ensure();
  assert(healed.ok && fs.existsSync(disposable), 'Graphics vault did not self-heal a deleted asset.');
  assert(vault.checksum(disposable) === oldHash, 'Self-healed asset is not deterministic.');

  console.log('ULTRON Elevate Graphics Vault self-test passed: 54 built-in assets, 13 Reel backgrounds, transparent metrics/UI/FX, chart routing, scene-aware selection and deleted-cache self-healing validated.');
})();
