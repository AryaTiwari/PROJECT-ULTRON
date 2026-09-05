const BRAND = {
  name: 'Elevate OS',
  offer: 'Free Strategy Session',
  url: 'elevateos.in',
};

function wordCount(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function requirements(durationSec = 30) {
  const duration = Math.max(15, Math.min(60, Number(durationSec) || 30));
  const targetWords = Math.round(duration * 2.55);
  return {
    duration,
    targetWords,
    minWords: Math.max(34, Math.round(duration * 2.15)),
    maxWords: Math.round(duration * 3.05),
    minScenes: duration <= 20 ? 6 : duration <= 35 ? 7 : 8,
    maxOnScreenWords: 8,
    maxOnScreenChars: 54,
  };
}

function creatorGrowthBrief(brief) {
  return /\b(?:creator|creators|reel|reels|instagram|content|followers?|views?|viral|growth|audience|brand collab|engagement)\b/i.test(String(brief || ''));
}

function shouldBrand(brief, options = {}) {
  if (options.brandPromotion === false) return false;
  if (options.brandPromotion === true) return true;
  return creatorGrowthBrief(brief);
}

function retimeScenes(scenes, durationSec, brandPromotion) {
  const source = Array.isArray(scenes) ? scenes.filter(Boolean) : [];
  if (!source.length) return [];
  const duration = Math.max(15, Math.min(60, Number(durationSec) || 30));
  const count = source.length;
  const hookDuration = Math.min(2.4, duration * 0.13);
  const ctaDuration = brandPromotion ? Math.min(3.2, Math.max(2.6, duration * 0.15)) : Math.min(2.5, duration * 0.12);
  const bodyCount = Math.max(1, count - 2);
  const bodyDuration = Math.max(1.8, (duration - hookDuration - ctaDuration) / bodyCount);
  let cursor = 0;
  return source.map((scene, index) => {
    let length = bodyDuration;
    if (index === 0) length = hookDuration;
    if (index === count - 1) length = Math.max(0.8, duration - cursor);
    const start = Number(cursor.toFixed(2));
    const end = index === count - 1 ? duration : Number(Math.min(duration, cursor + length).toFixed(2));
    cursor = end;
    return { ...scene, index: index + 1, start, end };
  });
}

function brandScene(durationSec) {
  return {
    purpose: 'Brand CTA',
    visualQuery: 'creator strategy consultation modern workspace vertical video',
    onScreenText: 'Free Strategy Session',
    subText: 'Elevate OS • elevateos.in',
    narration: 'Want a growth system built around your content? Book a free strategy session with Elevate OS at elevateos.in.',
    transition: 'clean-cut',
    energy: 'confident',
    isBrandCta: true,
  };
}

function ensureBrandScene(plan, brief, options = {}) {
  const enabled = shouldBrand(brief, options);
  const scenes = Array.isArray(plan?.scenes) ? plan.scenes.map((scene) => ({ ...scene })) : [];
  if (enabled) {
    const existing = scenes.findIndex((scene) => scene.isBrandCta || /free strategy session|elevate os/i.test(`${scene.onScreenText || ''} ${scene.subText || ''} ${scene.narration || ''}`));
    const cta = brandScene(plan?.durationSec || options.durationSec);
    if (existing >= 0) scenes[existing] = { ...scenes[existing], ...cta };
    else if (scenes.length) scenes[scenes.length - 1] = { ...scenes[scenes.length - 1], ...cta };
    else scenes.push(cta);
  }
  const retimed = retimeScenes(scenes, plan?.durationSec || options.durationSec, enabled);
  const voiceover = retimed.map((scene) => String(scene.narration || '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return {
    ...plan,
    scenes: retimed,
    voiceover: voiceover || String(plan?.voiceover || '').trim(),
    cta: enabled ? `${BRAND.offer} — ${BRAND.name} — ${BRAND.url}` : String(plan?.cta || '').trim(),
    brandPromotion: enabled,
    brand: enabled ? BRAND : null,
  };
}

function auditPlan(plan, brief, options = {}) {
  const req = requirements(plan?.durationSec || options.durationSec);
  const issues = [];
  const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
  const voiceover = String(plan?.voiceover || '').trim();
  const words = wordCount(voiceover);
  if (words < req.minWords) issues.push(`voiceover too short: ${words} words; need at least ${req.minWords}`);
  if (words > req.maxWords) issues.push(`voiceover too long: ${words} words; keep under ${req.maxWords}`);
  if (scenes.length < req.minScenes) issues.push(`not enough scenes: ${scenes.length}; need at least ${req.minScenes}`);
  scenes.forEach((scene, index) => {
    const text = String(scene?.onScreenText || '').trim();
    if (wordCount(text) > req.maxOnScreenWords || text.length > req.maxOnScreenChars) issues.push(`scene ${index + 1} on-screen text is too long`);
    if (!String(scene?.narration || '').trim()) issues.push(`scene ${index + 1} has no narration`);
    if (index > 0 && Number(scene?.start || 0) < Number(scenes[index - 1]?.end || 0) - 0.01) issues.push(`scene ${index + 1} overlaps scene ${index}`);
  });
  if (shouldBrand(brief, options)) {
    const haystack = `${plan?.cta || ''} ${voiceover} ${scenes.map((scene) => `${scene.onScreenText || ''} ${scene.subText || ''}`).join(' ')}`;
    if (!/elevate os/i.test(haystack)) issues.push('missing Elevate OS brand close');
    if (!/free strategy session/i.test(haystack)) issues.push('missing Free Strategy Session CTA');
    if (!/elevateos\.in/i.test(haystack)) issues.push('missing elevateos.in CTA URL');
  }
  return {
    ok: issues.length === 0,
    issues,
    wordCount: words,
    requirements: req,
    score: Math.max(0, 100 - issues.length * 12),
  };
}

module.exports = {
  BRAND,
  wordCount,
  requirements,
  creatorGrowthBrief,
  shouldBrand,
  retimeScenes,
  brandScene,
  ensureBrandScene,
  auditPlan,
};
