const quality = require('./reel-quality');

function text(value) { return String(value || '').trim(); }

function audit(result, brief, options = {}) {
  const issues = [];
  const plan = result?.plan || {};
  const output = result?.output || {};
  const narration = result?.narration || {};
  const polish = result?.polish || {};
  const finisher = result?.finisher || {};
  const completion = result?.completion || {};
  const characterMeta = polish.characterUniverse || {};
  const content = quality.auditPlan(plan, brief, options);
  const branded = quality.shouldBrandPlan(plan, brief, options);
  const req = quality.requirements(plan?.durationSec || options.durationSec);
  const semanticGraphicsExpected = plan?.elevateEngine?.scope === 'elevate-os-only'
    && (plan.scenes || []).some((scene) => !scene?.isBrandCta && !['stock-focus', 'brand-cta'].includes(scene?.visualDesign?.mode));
  const characterUniverseExpected = plan?.characterUniverse?.required === true;
  const expectedCharacterScenes = characterUniverseExpected ? (plan.scenes || []).length : 0;
  const castUsed = Array.isArray(finisher.characterCastUsed) ? finisher.characterCastUsed : [];
  const storyStages = Array.isArray(characterMeta.storyStages) ? characterMeta.storyStages : [];

  if (!content.ok) issues.push(...content.issues.map((issue) => `content: ${issue}`));
  if (Number(output.width || 0) !== 1080 || Number(output.height || 0) !== 1920) issues.push('output is not 1080x1920');
  if (!output.audioPresent) issues.push('final MP4 has no audio track');
  if (!text(narration.narratorProfile)) issues.push('dedicated Reel narrator profile was not recorded');
  if (narration.metallicApplied) issues.push('Ultron metallic voice processing leaked into Reel narration');
  if (!narration.completionVerified || !completion.verified) issues.push('narration was not verified to finish before the final frame');
  if (Number(narration.durationSec || 0) > Number(narration.spokenBudgetSec || 0) + 0.08) issues.push('narration runs beyond the safe spoken-time budget');
  if (Number(narration.timeFitRate || 1) > Number(req.maxNarrationTimeFitRate || 1.14) + 0.001) issues.push('narration had to be rushed beyond the allowed natural time-fit rate');
  if (Number(narration.tailRoomSec || 0) < Number(req.narrationTailRoomSec || 0.8) - 0.05) issues.push('final Reel does not preserve enough silent/visual tail room after narration');
  if (!polish.captionsApplied) issues.push('captions were not applied');
  if (!polish.safeZoneApplied) issues.push('Instagram-safe text layout was not confirmed');
  if (polish.textBoxes !== false) issues.push('large translucent caption boxes are not allowed in the premium text system');
  if (!polish.headlineSubtitleOverlapAvoided) issues.push('headline and supporting text timing separation was not confirmed');
  if (Number(polish.maxHeadlineWords || 99) > 5) issues.push('headline text density exceeds five words');
  if (Number(polish.maxSubtitleWords || 99) > 5) issues.push('supporting text density exceeds five words');

  if (characterUniverseExpected) {
    if (polish.visualStyle !== 'character-editorial-v1') issues.push('character Reel did not use the character-aware editorial text layout');
    if (!polish.editorialTopAligned) issues.push('character Reel text was not confirmed in the clean top editorial zone');
    if (!polish.replacementCaptionMode) issues.push('character Reel still risks simultaneous headline/subtitle clutter instead of replacement captions');
    if (Number(polish.headlineY || 0) < 235 || Number(polish.headlineY || 0) > 360) issues.push('character Reel headline anchor is outside the top editorial zone');
    if (Number(polish.subtitleY || 0) < 235 || Number(polish.subtitleY || 0) > 390) issues.push('character Reel replacement caption anchor is outside the top editorial zone');
    if (Number(polish.characterZoneStartsAt || 0) < 820) issues.push('character staging does not reserve a large enough lower-frame acting zone');
  } else {
    if (polish.visualStyle !== 'minimal-clean-v3') issues.push('minimal clean Reel typography was not confirmed');
    if (!polish.eyeLevelAligned) issues.push('text was not confirmed inside the eye-level editorial zone');
    if (Number(polish.headlineY || 0) < 520 || Number(polish.headlineY || 0) > 760) issues.push('headline anchor is outside the eye-level zone');
    if (Number(polish.subtitleY || 0) < 700 || Number(polish.subtitleY || 0) > 980) issues.push('supporting text anchor is outside the eye-level zone');
  }

  if (characterUniverseExpected && !characterMeta.applied) issues.push('required Elevate character universe was not applied to the final Reel');
  if (characterUniverseExpected && !finisher.characterUniverseApplied) issues.push('premium finisher did not confirm character-universe survival into final output');
  if (characterUniverseExpected && Number(finisher.characterSceneCoverage || 0) < expectedCharacterScenes) issues.push('not every Reel scene is covered by the recurring Elevate character storyline');
  if (characterUniverseExpected && !castUsed.includes('retention_devil')) issues.push('Retention Devil is missing from the character storyline');
  if (characterUniverseExpected && !castUsed.some((id) => /^content_doctor_/.test(id))) issues.push('Elevate content doctor is missing from the diagnosis/fix storyline');
  if (characterUniverseExpected && !castUsed.some((id) => /_creator$/.test(id))) issues.push('creator archetype is missing from the character storyline');
  if (characterUniverseExpected && characterMeta.assetMode !== 'approved-final-lineup') issues.push('Elevate Reel did not use the approved final transparent character lineup');
  if (characterUniverseExpected && characterMeta.finalLineupReady !== true) issues.push('Elevate Reel did not confirm the approved final transparent lineup');
  if (characterUniverseExpected && characterMeta.activeRoleEngine !== true) issues.push('characters were rendered as decoration instead of active story roles');
  if (characterUniverseExpected && finisher.activeCharacterRoles !== true) issues.push('premium finisher did not confirm active character-role staging');
  if (characterUniverseExpected && characterMeta.largeCharacterStaging !== true) issues.push('characters were not staged large enough to function as the Reel protagonists');
  if (characterUniverseExpected && finisher.largeCharacterStaging !== true) issues.push('premium finisher did not confirm large character staging');
  if (characterUniverseExpected && characterMeta.ffmpegTextExpansion !== 'none') issues.push('character-story text was not rendered in FFmpeg literal-safe mode');
  if (characterUniverseExpected && !storyStages.includes('conflict-split')) issues.push('character storyline is missing a visible creator-vs-Devil conflict stage');
  if (characterUniverseExpected && !storyStages.includes('diagnosis-split')) issues.push('character storyline is missing the Elevate Doctor diagnosis stage');
  if (characterUniverseExpected && !storyStages.includes('prescription-stage') && expectedCharacterScenes >= 5) issues.push('character storyline is missing the Elevate prescription/Devil-defeat stage');

  if (semanticGraphicsExpected && !polish.graphicsEngine?.applied) issues.push('planned Elevate semantic graphics were not applied to the final visual pass');
  if (semanticGraphicsExpected && !finisher.semanticGraphicsApplied) issues.push('premium finisher did not confirm the Elevate graphics pass survived into final output');
  if (branded && !plan.brandPromotion) issues.push('creator-growth Reel is missing Elevate OS promotion');
  if (branded && !/free strategy session/i.test(`${plan.cta || ''} ${plan.voiceover || ''}`)) issues.push('Free Strategy Session CTA is missing');
  if (branded && !/elevateos\.in/i.test(`${plan.cta || ''} ${plan.voiceover || ''}`)) issues.push('elevateos.in is missing from the CTA');
  if (branded && !/book[\s\S]{0,100}free strategy session[\s\S]{0,100}now/i.test(`${plan.cta || ''} ${plan.voiceover || ''}`)) issues.push('CTA does not explicitly ask viewers to book the free strategy session now');
  if (branded && characterUniverseExpected && polish.brandCtaVersion !== 'elevate-character-book-now-v2') issues.push('character Reel is missing the dedicated Elevate booking end-card layout');
  if (branded && !characterUniverseExpected && polish.brandCtaVersion !== 'elevate-book-now-v1') issues.push('mandatory Elevate OS booking end-card was not confirmed');
  if (!finisher.applied) issues.push('premium finishing pass was not applied');
  if (!finisher.transitionsApplied) issues.push('scene transition finishing was not applied');

  const score = Math.max(0, 100 - issues.length * 10);
  return {
    ok: issues.length === 0 && score >= 90,
    score,
    issues,
    contentScore: content.score,
    narratorProfile: narration.narratorProfile || null,
    narrationCompletionVerified: Boolean(narration.completionVerified && completion.verified),
    narrationDurationSec: Number(narration.durationSec || 0) || null,
    spokenBudgetSec: Number(narration.spokenBudgetSec || 0) || null,
    narrationTailRoomSec: Number(narration.tailRoomSec || 0) || null,
    narrationTimeFitRate: Number(narration.timeFitRate || 1),
    transitionsApplied: Boolean(finisher.transitionsApplied),
    characterUniverseExpected: Boolean(characterUniverseExpected),
    characterUniverseApplied: Boolean(characterMeta.applied && finisher.characterUniverseApplied),
    characterSceneCoverage: Number(finisher.characterSceneCoverage || 0),
    characterCastUsed: castUsed,
    characterAssetMode: characterMeta.assetMode || null,
    finalLineupConfirmed: characterMeta.finalLineupReady === true,
    activeCharacterRoles: Boolean(characterMeta.activeRoleEngine && finisher.activeCharacterRoles),
    largeCharacterStaging: Boolean(characterMeta.largeCharacterStaging && finisher.largeCharacterStaging),
    storyStages,
    ffmpegTextExpansion: characterMeta.ffmpegTextExpansion || null,
    semanticGraphicsExpected: Boolean(semanticGraphicsExpected),
    semanticGraphicsApplied: Boolean(polish.graphicsEngine?.applied && finisher.semanticGraphicsApplied),
    sfxApplied: Boolean(finisher.sfxApplied),
    safeZoneApplied: Boolean(polish.safeZoneApplied),
    eyeLevelAligned: Boolean(polish.eyeLevelAligned),
    editorialTopAligned: Boolean(polish.editorialTopAligned),
    visualStyle: polish.visualStyle || null,
    textBoxes: polish.textBoxes,
    headlineSubtitleOverlapAvoided: Boolean(polish.headlineSubtitleOverlapAvoided),
    brandPromotion: Boolean(plan.brandPromotion),
    brandCtaVersion: polish.brandCtaVersion || null,
  };
}

module.exports = { audit };
