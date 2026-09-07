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
  const targetWords = Math.round(duration * 2.7);
  return {
    duration,
    targetWords,
    minWords: Math.max(34, Math.round(duration * 2.15)),
    maxWords: Math.round(duration * 3.35),
    minScenes: duration <= 20 ? 6 : duration <= 35 ? 7 : 8,
    maxOnScreenWords: 5,
    maxOnScreenChars: 34,
    maxSubtitleWords: 5,
    minBodyNarrationWords: duration <= 20 ? 7 : 8,
  };
}

function creatorGrowthBrief(brief) {
  return /\b(?:creator|creators|reel|reels|instagram|content|followers?|views?|viral|growth|audience|brand collab|engagement|retention|reach|profile|posting|hook)\b/i.test(String(brief || ''));
}

function shouldBrand(brief, options = {}) {
  if (options.brandPromotion === false) return false;
  if (options.brandPromotion === true) return true;
  return creatorGrowthBrief(brief);
}

function planEvidence(plan, brief = '') {
  const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
  return [
    brief,
    plan?.title,
    plan?.angle,
    plan?.hook,
    plan?.voiceover,
    plan?.caption,
    plan?.cta,
    ...scenes.flatMap((scene) => [scene?.purpose, scene?.onScreenText, scene?.subText, scene?.narration, scene?.visualQuery]),
  ].filter(Boolean).join(' ');
}

function shouldBrandPlan(plan, brief, options = {}) {
  if (options.brandPromotion === false) return false;
  if (options.brandPromotion === true) return true;
  return creatorGrowthBrief(planEvidence(plan, brief));
}

function retimeScenes(scenes, durationSec, brandPromotion) {
  const source = Array.isArray(scenes) ? scenes.filter(Boolean) : [];
  if (!source.length) return [];
  const duration = Math.max(15, Math.min(60, Number(durationSec) || 30));
  const count = source.length;
  const hookDuration = Math.min(2.4, duration * 0.13);
  const ctaDuration = brandPromotion ? Math.min(4.2, Math.max(3.4, duration * 0.16)) : Math.min(2.5, duration * 0.12);
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

function brandScene() {
  return {
    purpose: 'Brand CTA',
    visualQuery: 'content creator strategy consultation modern premium workspace vertical video',
    onScreenText: 'Book Your Free Strategy Session',
    subText: 'Elevate OS • elevateos.in',
    narration: 'Want a growth plan built around your account? Book your free strategy session with Elevate OS now at elevateos.in.',
    transition: 'clean-cut',
    energy: 'confident',
    isBrandCta: true,
  };
}

const TRAILING_FILLER = new Set(['that', 'and', 'the', 'to', 'of', 'a', 'an', 'with', 'for', 'from', 'your', 'their', 'this', 'these', 'those', 'but', 'or', 'so']);

function trimToWords(value, limit) {
  const source = String(value || '').trim();
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length <= limit) return words.join(' ');

  const sentences = source.match(/[^.!?]+[.!?]+/g) || [];
  let used = 0;
  const complete = [];
  for (const sentence of sentences) {
    const count = wordCount(sentence);
    if (!count || used + count > limit) break;
    complete.push(sentence.trim());
    used += count;
  }
  if (complete.length) return complete.join(' ');

  let selected = words.slice(0, Math.max(1, limit));
  while (selected.length > 4 && TRAILING_FILLER.has(selected[selected.length - 1].replace(/[^A-Za-z]/g, '').toLowerCase())) selected.pop();
  let text = selected.join(' ').replace(/[,:;!?-]+$/, '');
  if (!/[.!?]$/.test(text)) text += '.';
  return text;
}

// Kept for explicit callers, but normal plan normalization no longer uses destructive
// per-scene trimming. Over-budget AI plans should fail the quality gate and be repaired
// or replaced, rather than producing fragments such as "Extract the hook that.".
function fitNarrationBudget(scenes, durationSec) {
  const list = Array.isArray(scenes) ? scenes.map((scene) => ({ ...scene })) : [];
  const req = requirements(durationSec);
  const total = list.reduce((sum, scene) => sum + wordCount(scene.narration), 0);
  if (total <= req.maxWords || !list.length) return list;
  return list;
}

function shortenOnScreenText(value, limit = 5) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).slice(0, limit).join(' ');
}

function ensureBrandScene(plan, brief, options = {}) {
  const enabled = shouldBrandPlan(plan, brief, options);
  let scenes = Array.isArray(plan?.scenes) ? plan.scenes.map((scene) => ({ ...scene })) : [];
  scenes = scenes.map((scene) => ({
    ...scene,
    onScreenText: scene.isBrandCta ? scene.onScreenText : shortenOnScreenText(scene.onScreenText, 5),
  }));
  if (enabled) {
    const existing = scenes.findIndex((scene) => scene.isBrandCta || /free strategy session|elevate os/i.test(`${scene.onScreenText || ''} ${scene.subText || ''} ${scene.narration || ''}`));
    const cta = brandScene();
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
    cta: enabled ? `Book your ${BRAND.offer} now — ${BRAND.name} — ${BRAND.url}` : String(plan?.cta || '').trim(),
    brandPromotion: enabled,
    brand: enabled ? BRAND : null,
    textDesign: 'minimal-clean-v3',
    contentDesign: 'informative-creator-v4',
  };
}

function hasPurpose(scenes, regex) {
  return scenes.some((scene) => regex.test(`${scene?.purpose || ''} ${scene?.onScreenText || ''} ${scene?.narration || ''}`));
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
    const narrationWords = wordCount(scene?.narration);
    if (!scene?.isBrandCta && (wordCount(text) > req.maxOnScreenWords || text.length > req.maxOnScreenChars)) issues.push(`scene ${index + 1} on-screen text is too dense`);
    if (!String(scene?.narration || '').trim()) issues.push(`scene ${index + 1} has no narration`);
    if (!scene?.isBrandCta && index > 0 && narrationWords < req.minBodyNarrationWords) issues.push(`scene ${index + 1} narration is too vague/short: ${narrationWords} words`);
    if (index > 0 && Number(scene?.start || 0) < Number(scenes[index - 1]?.end || 0) - 0.01) issues.push(`scene ${index + 1} overlaps scene ${index}`);
  });

  if (creatorGrowthBrief(planEvidence(plan, brief))) {
    if (!hasPurpose(scenes, /cause|mechanism|why|signal|convert|retention|return|context/i)) issues.push('creator Reel does not clearly explain the cause/mechanism');
    if (!hasPurpose(scenes, /action|fix|build|repeat|measure|track|pillar|system/i)) issues.push('creator Reel does not give a concrete action/fix');
  }

  if (shouldBrandPlan(plan, brief, options)) {
    const haystack = `${plan?.cta || ''} ${voiceover} ${scenes.map((scene) => `${scene.onScreenText || ''} ${scene.subText || ''}`).join(' ')}`;
    if (!/elevate os/i.test(haystack)) issues.push('missing Elevate OS brand close');
    if (!/free strategy session/i.test(haystack)) issues.push('missing Free Strategy Session CTA');
    if (!/elevateos\.in/i.test(haystack)) issues.push('missing elevateos.in CTA URL');
    if (!/book[\s\S]{0,80}free strategy session[\s\S]{0,80}now/i.test(haystack)) issues.push('CTA must explicitly ask viewers to book the free strategy session now');
    const last = scenes[scenes.length - 1] || {};
    if (!last.isBrandCta) issues.push('Elevate OS CTA must be the final scene');
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
  planEvidence,
  shouldBrandPlan,
  retimeScenes,
  brandScene,
  trimToWords,
  fitNarrationBudget,
  shortenOnScreenText,
  ensureBrandScene,
  auditPlan,
};
