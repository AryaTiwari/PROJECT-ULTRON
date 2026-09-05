const quality = require('./reel-quality');

function text(value) { return String(value || '').trim(); }

function audit(result, brief, options = {}) {
  const issues = [];
  const plan = result?.plan || {};
  const output = result?.output || {};
  const narration = result?.narration || {};
  const polish = result?.polish || {};
  const finisher = result?.finisher || {};
  const content = quality.auditPlan(plan, brief, options);

  if (!content.ok) issues.push(...content.issues.map((issue) => `content: ${issue}`));
  if (Number(output.width || 0) !== 1080 || Number(output.height || 0) !== 1920) issues.push('output is not 1080x1920');
  if (!output.audioPresent) issues.push('final MP4 has no audio track');
  if (!text(narration.narratorProfile)) issues.push('dedicated Reel narrator profile was not recorded');
  if (narration.metallicApplied) issues.push('Ultron metallic voice processing leaked into Reel narration');
  if (!polish.captionsApplied) issues.push('captions were not applied');
  if (!polish.safeZoneApplied) issues.push('Instagram-safe text layout was not confirmed');
  if (polish.visualStyle !== 'minimal-clean-v3') issues.push('minimal clean Reel typography was not confirmed');
  if (polish.textBoxes !== false) issues.push('translucent caption boxes are not allowed in the premium text system');
  if (!polish.headlineSubtitleOverlapAvoided) issues.push('headline and subtitle timing separation was not confirmed');
  if (Number(polish.maxHeadlineWords || 99) > 5) issues.push('headline text density exceeds five words');
  if (Number(polish.maxSubtitleWords || 99) > 4) issues.push('subtitle cue density exceeds four words');
  if (quality.shouldBrand(brief, options) && !plan.brandPromotion) issues.push('creator-growth Reel is missing Elevate OS promotion');
  if (quality.shouldBrand(brief, options) && !/free strategy session/i.test(`${plan.cta || ''} ${plan.voiceover || ''}`)) issues.push('Free Strategy Session CTA is missing');
  if (quality.shouldBrand(brief, options) && !/elevateos\.in/i.test(`${plan.cta || ''} ${plan.voiceover || ''}`)) issues.push('elevateos.in is missing from the CTA');
  if (!finisher.applied) issues.push('premium finishing pass was not applied');
  if (!finisher.transitionsApplied) issues.push('scene transition finishing was not applied');

  const score = Math.max(0, 100 - issues.length * 10);
  return {
    ok: issues.length === 0 && score >= 90,
    score,
    issues,
    contentScore: content.score,
    narratorProfile: narration.narratorProfile || null,
    transitionsApplied: Boolean(finisher.transitionsApplied),
    sfxApplied: Boolean(finisher.sfxApplied),
    safeZoneApplied: Boolean(polish.safeZoneApplied),
    visualStyle: polish.visualStyle || null,
    textBoxes: polish.textBoxes,
    headlineSubtitleOverlapAvoided: Boolean(polish.headlineSubtitleOverlapAvoided),
    brandPromotion: Boolean(plan.brandPromotion),
  };
}

module.exports = { audit };
