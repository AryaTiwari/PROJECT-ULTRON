const engine = require('../core/elevate-reel-engine');
const factory = require('../core/reel-factory');
const sources = require('../core/reel-sources');

function assert(condition, message) { if (!condition) throw new Error(message); }

(() => {
  engine.install();
  const state = engine.status();
  assert(state.implemented === true && state.installed === true, 'Elevate Reel Engine must install.');
  assert(state.scope === 'elevate-os-only', 'Reel Engine must stay scoped to Elevate OS.');
  assert(state.zeroCostOnly === true && state.paidGenerationAllowed === false, 'Elevate Reel Engine must remain zero-cost-only.');
  assert(state.resourceProfile.width === 1080 && state.resourceProfile.height === 1920 && state.resourceProfile.fps === 30, 'Reel output profile must remain Instagram-native 1080x1920@30.');
  assert(state.resourceProfile.localAi === false && state.resourceProfile.blender === false, '8GB profile must not introduce local AI or Blender.');

  assert(engine.pillarFor('How creators can get more brand deals and monetize their audience').id === 'monetization', 'Elevate pillar routing must recognize monetization.');
  assert(engine.pillarFor('Why viewers skip my Reel after two seconds').id === 'growth-retention', 'Elevate pillar routing must recognize retention.');
  assert(engine.pillarFor('How to improve creator positioning and authority').id === 'positioning', 'Elevate pillar routing must recognize positioning.');
  assert(engine.hookScore(engine.hookCandidate('brand deals')) >= 60, 'Hook engine must produce a strong concise creator hook.');

  const fallback = factory.fallbackPlan('why creators get views but fail to turn them into followers', { durationSec: 30, brandPromotion: true });
  const plan = engine.enhancePlan(fallback, 'why creators get views but fail to turn them into followers', { durationSec: 30 });
  assert(plan.brandPromotion === true, 'Elevate Reel Engine must force the Elevate brand close.');
  assert(/Elevate OS/i.test(plan.cta) && /elevateos\.in/i.test(plan.cta), 'Elevate CTA must preserve brand and website.');
  assert(plan.elevateEngine?.scope === 'elevate-os-only', 'Plan must contain unified Elevate Engine metadata.');
  assert(plan.scenes.some((scene) => scene.visualDesign?.mode && scene.visualDesign.mode !== 'stock-focus'), 'Semantic graphics router must assign at least one non-stock visual mode.');
  assert(plan.scenes[plan.scenes.length - 1]?.isBrandCta === true, 'Elevate CTA must remain the final scene.');
  const engineRegressions = (plan.qualityAudit?.issues || []).filter((issue) => /missing Elevate|missing Free Strategy|missing elevateos|CTA must|on-screen text is too dense|overlaps/i.test(issue));
  assert(engineRegressions.length === 0, `Elevate engine must not introduce brand/layout regressions: ${engineRegressions.join('; ')}`);

  const allowed = engine.normalizeCommonsPage({
    pageid: 123,
    title: 'File:Creator workspace.jpg',
    imageinfo: [{
      mime: 'image/jpeg',
      mediatype: 'BITMAP',
      url: 'https://upload.wikimedia.org/example.jpg',
      thumburl: 'https://upload.wikimedia.org/example-1080.jpg',
      extmetadata: {
        LicenseShortName: { value: 'CC BY 4.0' },
        Artist: { value: 'Example Creator' },
      },
    }],
  });
  assert(allowed?.commercialUse === true && allowed.mediaType === 'image', 'Public media scout must accept attributable commercial-friendly media.');

  const blocked = engine.normalizeCommonsPage({
    pageid: 124,
    title: 'File:Blocked.jpg',
    imageinfo: [{
      mime: 'image/jpeg',
      mediatype: 'BITMAP',
      url: 'https://upload.wikimedia.org/blocked.jpg',
      extmetadata: { LicenseShortName: { value: 'CC BY-NC 4.0' } },
    }],
  });
  assert(blocked === null, 'Public media scout must reject non-commercial licenses.');

  const shareAlike = engine.normalizeCommonsPage({
    pageid: 125,
    title: 'File:Share-alike.jpg',
    imageinfo: [{
      mime: 'image/jpeg',
      mediatype: 'BITMAP',
      url: 'https://upload.wikimedia.org/share-alike.jpg',
      extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' } },
    }],
  });
  assert(shareAlike === null, 'Default commercial scout policy must avoid ShareAlike obligations unless explicitly enabled later.');

  const imageName = sources.safeAssetName({ provider: 'wikimedia-commons', id: '123', mediaType: 'image', mime: 'image/jpeg', url: 'https://example.com/file.jpg' }, 1);
  assert(/\.jpg$/i.test(imageName), 'Image media must retain an image extension instead of being forced into MP4.');

  const sourceState = sources.status();
  assert(sourceState.publicMediaScout?.implemented === true && sourceState.streamingDownloads === true, 'Stock layer must expose the public-media scout and streaming download policy.');

  console.log('ULTRON Elevate Reel Engine self-test passed: Elevate-only direction, hooks, CTA, semantic 2D graphics, license-aware photo/video scouting, streaming downloads and 8GB-safe zero-cost policy validated.');
})();
