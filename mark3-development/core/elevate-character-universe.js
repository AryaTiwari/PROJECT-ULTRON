const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const config = require('./config');
const factory = require('./reel-factory');

const ROOT = path.join(factory.REEL_ROOT, 'characters');
const REFERENCE_PATH = path.join(ROOT, 'reference-sheet.jpg');
const FINAL_LINEUP_PATH = path.join(ROOT, 'final-lineup.png');
const SPRITE_ROOT = path.join(ROOT, 'sprites');
const SPRITE_BUILDER = path.join(config.projectRoot, 'mark3-development', 'scripts', 'build-elevate-character-sprites.ps1');

const CANONICAL_REFERENCE_NAMES = [
  '1000248121.jpg',
  '1788800599891.png',
  'elevate-character-reference.jpg',
  'elevate-character-reference.png',
  'elevate-characters.jpg',
  'elevate-characters.png',
];

// This is the finished transparent lineup approved for production. The first name
// is the exact file the user supplied in September 2026. The aliases make the
// installer resilient if Windows/browser download naming changes later.
const FINAL_LINEUP_NAMES = [
  'ChatGPT Image Sep 8, 2026, 02_09_14 PM.png',
  'colourful_seven_character_cartoon_lineup.png',
  'elevate-character-lineup-final.png',
  'elevate-character-lineup.png',
  'elevate-os-character-lineup.png',
];

// Measured against the approved 2048x682 transparent lineup. Padding is already
// included, so the Devil keeps his complete wings/tail and every actor stays
// separated from neighboring characters. Renderer normalizes the sheet to this
// exact canvas before cropping.
const FINAL_LINEUP_CROPS = Object.freeze({
  gym_creator: { x: 12, y: 34, w: 323, h: 639 },
  fashion_creator: { x: 340, y: 75, w: 237, h: 592 },
  ugc_creator: { x: 623, y: 72, w: 220, h: 593 },
  info_creator: { x: 879, y: 56, w: 231, h: 612 },
  retention_devil: { x: 1133, y: 17, w: 380, h: 653 },
  content_doctor_female: { x: 1518, y: 73, w: 208, h: 600 },
  content_doctor_male: { x: 1791, y: 53, w: 242, h: 621 },
});

const CHARACTERS = Object.freeze({
  gym_creator: {
    id: 'gym_creator', label: 'Gym Creator', role: 'fitness creator protagonist',
    equipment: ['barbell', 'fitness metrics', 'workout content'],
    expressions: ['confident', 'confused', 'frustrated', 'motivated', 'celebrating'],
  },
  fashion_creator: {
    id: 'fashion_creator', label: 'Fashion Creator', role: 'fashion / lifestyle / beauty creator protagonist',
    equipment: ['phone', 'camera', 'outfit cards', 'brand collab cards'],
    expressions: ['confident', 'surprised', 'frustrated', 'excited', 'celebrating'],
  },
  ugc_creator: {
    id: 'ugc_creator', label: 'UGC Creator', role: 'skincare / UGC / product-review creator protagonist',
    equipment: ['product bottle', 'makeup brush', 'review card', 'camera'],
    expressions: ['curious', 'concerned', 'confident', 'excited', 'celebrating'],
  },
  info_creator: {
    id: 'info_creator', label: 'Info Creator', role: 'finance / tech / education / information creator protagonist',
    equipment: ['phone', 'analytics', 'topic cards', 'content notes'],
    expressions: ['confident', 'confused', 'thinking', 'concerned', 'celebrating'],
  },
  retention_devil: {
    id: 'retention_devil', label: 'Retention Devil', role: 'antagonist that personifies creator mistakes, skip behavior and audience drop-off, not the Instagram algorithm',
    equipment: ['SKIP button', 'scissors', 'retention graph', 'down arrow', 'stopwatch', 'broken engagement meter', 'view/swipe cards'],
    expressions: ['smug', 'scheming', 'laughing', 'shocked', 'defeated'],
  },
  content_doctor_female: {
    id: 'content_doctor_female', label: 'Elevate Doctor', role: 'diagnostician who identifies the creator bottleneck',
    equipment: ['stethoscope', 'tablet', 'scanner', 'retention graph', 'diagnostic report'],
    expressions: ['analytical', 'concerned', 'confident', 'approving', 'celebrating'],
  },
  content_doctor_male: {
    id: 'content_doctor_male', label: 'Elevate Analyst', role: 'strategist who prescribes the practical fix and closes the Elevate CTA',
    equipment: ['stethoscope', 'clipboard', 'dashboard', 'growth graph', 'strategy report'],
    expressions: ['analytical', 'thinking', 'confident', 'approving', 'celebrating'],
  },
});

function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function exists(file) { try { return Boolean(file && fs.existsSync(file) && fs.statSync(file).isFile()); } catch { return false; } }
function spritePath(id) { return path.join(SPRITE_ROOT, `${id}.png`); }
function spritePaths() { return Object.fromEntries(Object.keys(CHARACTERS).map((id) => [id, spritePath(id)])); }
function spritePackReady() { return Object.keys(CHARACTERS).every((id) => exists(spritePath(id)) && fs.statSync(spritePath(id)).size >= 512); }
function finalLineupReady() { return exists(FINAL_LINEUP_PATH) && fs.statSync(FINAL_LINEUP_PATH).size >= 10 * 1024; }

function searchRoots(configured = null) {
  const home = os.homedir();
  return [
    configured ? path.dirname(configured) : null,
    path.join(home, 'Downloads'),
    path.join(home, 'Pictures'),
    path.join(home, 'Desktop'),
    config.projectRoot,
    path.join(config.projectRoot, 'assets'),
    path.join(config.projectRoot, 'mark3-development', 'assets'),
  ].filter(Boolean);
}

function candidateFinalLineupPaths() {
  const configured = clean(process.env.ULTRON_M3_ELEVATE_CHARACTER_LINEUP);
  const candidates = [];
  if (configured) candidates.push(path.resolve(configured));
  if (exists(FINAL_LINEUP_PATH)) candidates.push(FINAL_LINEUP_PATH);
  for (const root of searchRoots(configured)) {
    for (const name of FINAL_LINEUP_NAMES) candidates.push(path.join(root, name));
  }
  return [...new Set(candidates)];
}

function discoverFinalLineup() {
  if (finalLineupReady()) return FINAL_LINEUP_PATH;
  return candidateFinalLineupPaths().find((file) => exists(file) && fs.statSync(file).size >= 10 * 1024) || null;
}

function installFinalLineup(source) {
  const src = path.resolve(String(source || discoverFinalLineup() || ''));
  if (!exists(src)) {
    throw new Error('Final transparent Elevate character lineup was not found. Put the approved PNG in Downloads or pass its path to npm run reels:characters:add.');
  }
  if (path.extname(src).toLowerCase() !== '.png') {
    throw new Error('The production character lineup must be the approved transparent PNG, not the old JPG reference sheet.');
  }
  if (fs.statSync(src).size < 10 * 1024) throw new Error('The final character lineup PNG is unexpectedly small or corrupt.');
  fs.mkdirSync(ROOT, { recursive: true });
  if (path.resolve(src) !== path.resolve(FINAL_LINEUP_PATH)) fs.copyFileSync(src, FINAL_LINEUP_PATH);
  return FINAL_LINEUP_PATH;
}

function ensureFinalLineup() {
  if (finalLineupReady()) return FINAL_LINEUP_PATH;
  const found = discoverFinalLineup();
  if (!found) return null;
  try { return installFinalLineup(found); } catch { return null; }
}

function candidateReferencePaths() {
  const configured = clean(process.env.ULTRON_M3_ELEVATE_CHARACTER_REFERENCE);
  const candidates = [];
  if (configured) candidates.push(path.resolve(configured));
  if (exists(REFERENCE_PATH)) candidates.push(REFERENCE_PATH);
  for (const root of searchRoots(configured)) {
    for (const name of CANONICAL_REFERENCE_NAMES) candidates.push(path.join(root, name));
  }
  return [...new Set(candidates)];
}

function discoverReference() {
  if (exists(REFERENCE_PATH)) return REFERENCE_PATH;
  return candidateReferencePaths().find(exists) || null;
}

function powershellBinary() {
  if (process.platform !== 'win32') return null;
  for (const binary of ['powershell.exe', 'pwsh.exe']) {
    try {
      const probe = spawnSync(binary, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      if (probe.status === 0) return binary;
    } catch {}
  }
  return null;
}

// Legacy only. Kept so existing installations do not lose their old assets, but
// the Reel Factory no longer treats these generated cutouts as production-ready.
function buildSpritePack(reference = REFERENCE_PATH) {
  if (spritePackReady()) return { ok: true, alreadyBuilt: true, root: SPRITE_ROOT, files: spritePaths() };
  if (!exists(reference)) return { ok: false, error: 'character reference sheet is missing' };
  if (process.platform !== 'win32') return { ok: false, unsupported: true, error: 'transparent sprite builder is Windows-only in this lightweight runtime' };
  const powershell = powershellBinary();
  if (!powershell) return { ok: false, error: 'PowerShell is unavailable for the legacy character sprite build' };
  if (!exists(SPRITE_BUILDER)) return { ok: false, error: `sprite builder script is missing: ${SPRITE_BUILDER}` };
  fs.mkdirSync(SPRITE_ROOT, { recursive: true });
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SPRITE_BUILDER, '-ReferencePath', path.resolve(reference), '-OutputDir', path.resolve(SPRITE_ROOT)];
  const run = spawnSync(powershell, args, { encoding: 'utf8', timeout: 180000, windowsHide: true });
  if (run.status !== 0 || !spritePackReady()) {
    const detail = clean(`${run.stderr || ''} ${run.stdout || ''}`) || `PowerShell exited with code ${run.status}`;
    return { ok: false, error: detail };
  }
  return { ok: true, root: SPRITE_ROOT, files: spritePaths(), output: clean(run.stdout) };
}

function installReference(source) {
  const src = path.resolve(String(source || discoverReference() || ''));
  if (!exists(src)) throw new Error('Legacy Elevate character reference sheet was not found.');
  fs.mkdirSync(ROOT, { recursive: true });
  if (path.resolve(src) !== path.resolve(REFERENCE_PATH)) fs.copyFileSync(src, REFERENCE_PATH);
  return REFERENCE_PATH;
}

function ensureReference() {
  if (exists(REFERENCE_PATH)) return REFERENCE_PATH;
  const found = candidateReferencePaths().find(exists);
  if (!found) return null;
  try { return installReference(found); } catch { return null; }
}

function ensureSpritePack() {
  if (spritePackReady()) return { ok: true, root: SPRITE_ROOT, files: spritePaths() };
  const reference = ensureReference();
  if (!reference) return { ok: false, error: 'legacy character reference sheet is missing' };
  return buildSpritePack(reference);
}

function installCharacterAsset(source) {
  const explicit = clean(source);
  if (explicit && path.extname(explicit).toLowerCase() === '.png') return { mode: 'final-lineup', path: installFinalLineup(explicit) };
  const final = discoverFinalLineup();
  if (final) return { mode: 'final-lineup', path: installFinalLineup(final) };
  if (explicit) return { mode: 'legacy-reference', path: installReference(explicit) };
  const reference = discoverReference();
  if (reference) return { mode: 'legacy-reference', path: installReference(reference) };
  throw new Error('No Elevate character asset was found. Use the approved transparent final lineup PNG.');
}

function creatorForBrief(brief = '') {
  const text = clean(brief).toLowerCase();
  if (/\b(?:gym|fitness|workout|bodybuilding|calisthenics|health coach|protein|muscle)\b/.test(text)) return 'gym_creator';
  if (/\b(?:fashion|outfit|style|lifestyle|beauty|makeup|model)\b/.test(text)) return 'fashion_creator';
  if (/\b(?:ugc|skincare|skin care|product review|reviewer|cosmetic|serum|beauty product)\b/.test(text)) return 'ugc_creator';
  return 'info_creator';
}

function propForScene(scene = {}) {
  const text = clean(`${scene.purpose} ${scene.onScreenText} ${scene.subText} ${scene.narration}`).toLowerCase();
  if (/\b(?:views?|reach|viral)\b/.test(text) && /\b(?:follow|loyal|conversion|profile)\b/.test(text)) return 'views-vs-follows';
  if (/\b(?:conversion|profile visit|funnel|next step|return|loyal)\b/.test(text)) return 'conversion-funnel';
  if (/\b(?:retention|watch time|skip|drop.?off|completion)\b/.test(text)) return 'retention-graph';
  if (/\b(?:hook|opening|first second|pattern interrupt)\b/.test(text)) return 'hook-meter';
  if (/\b(?:brand|moneti|sponsor|collab|revenue|earn)\b/.test(text)) return 'brand-card';
  if (/\b(?:pillar|strategy|system|calendar|consistent|posting|series|promise)\b/.test(text)) return 'creator-system';
  if (/\b(?:cta|call to action|book|comment|dm)\b/.test(text)) return 'cta-button';
  return 'creator-system';
}

function beatForScene(scene, index, total, creator) {
  const sceneProp = propForScene(scene);
  if (scene.isBrandCta || index === total - 1) {
    return {
      type: 'elevate-close', stage: 'cta-stage',
      characters: ['content_doctor_female', 'content_doctor_male'],
      roles: ['host-left', 'host-right'], expressions: ['confident', 'approving'],
      prop: 'cta-button', motion: 'doctor-close',
      action: 'The Elevate doctors own the frame and present the strategy-session CTA. The Devil is gone.',
      story: 'Resolution: Elevate OS becomes the clear next step.',
    };
  }
  if (index === 0) {
    return {
      type: 'creator-hook', stage: 'creator-hero',
      characters: [creator], roles: ['protagonist'], expressions: ['confident'],
      prop: sceneProp === 'creator-system' ? 'views-vs-follows' : sceneProp, motion: 'creator-pop',
      action: 'The creator presents the impressive surface metric while the weak conversion signal appears above them.',
      story: 'Establish the creator and the contradiction immediately.',
    };
  }
  if (index === 1) {
    return {
      type: 'devil-interruption', stage: 'conflict-split',
      characters: [creator, 'retention_devil'], roles: ['protagonist', 'antagonist'], expressions: ['confused', 'smug'],
      prop: sceneProp, motion: 'devil-ambush',
      action: 'The Retention Devil enters aggressively and triggers the SKIP/drop-off problem between the creator and the metric.',
      story: 'Make the Devil visibly cause the leak instead of merely standing in frame.',
    };
  }
  if (index === 2) {
    return {
      type: 'metric-consequence', stage: 'devil-dominant',
      characters: [creator, 'retention_devil'], roles: ['reacting-protagonist', 'dominant-antagonist'], expressions: ['frustrated', 'scheming'],
      prop: sceneProp === 'creator-system' ? 'conversion-funnel' : sceneProp, motion: 'metric-attack',
      action: 'The Devil dominates the right side and visibly damages the funnel/retention graphic while the creator reacts.',
      story: 'Show the consequence as an interaction, not a decorative chart.',
    };
  }
  if (index === 3 || /\b(?:diagnos|cause|problem|why)\b/i.test(clean(scene.purpose))) {
    return {
      type: 'doctor-diagnosis', stage: 'diagnosis-split',
      characters: [creator, 'content_doctor_female'], roles: ['patient-creator', 'diagnostician'], expressions: ['concerned', 'analytical'],
      prop: sceneProp, motion: 'scanner-diagnosis',
      action: 'The female Elevate Doctor scans the creator metric, identifies the real bottleneck, and owns the diagnosis graphic.',
      story: 'Shift authority from the Devil to the Elevate diagnosis.',
    };
  }
  if (index === total - 2 || /\b(?:action|fix|solution|strategy|payoff|measure)\b/i.test(clean(scene.purpose))) {
    return {
      type: 'doctor-prescription', stage: 'prescription-stage',
      characters: ['content_doctor_male', creator, 'retention_devil'], roles: ['strategist', 'recovering-creator', 'defeated-antagonist'], expressions: ['confident', 'motivated', 'shocked'],
      prop: 'creator-system', motion: 'prescription-reveal',
      action: 'The male Elevate Analyst presents the practical system, the creator moves toward him, and the Devil retreats smaller.',
      story: 'Make the fix visually defeat the problem.',
    };
  }
  return {
    type: 'story-explanation', stage: 'explanation-stage',
    characters: [creator, 'content_doctor_female'], roles: ['learning-creator', 'guide'], expressions: ['thinking', 'confident'],
    prop: sceneProp, motion: 'doctor-explain',
    action: 'The Doctor points the creator toward the explanatory graphic while the creator remains visibly part of the lesson.',
    story: 'Continue the mini-story with character interaction.',
  };
}

function decoratePlan(plan, brief = '') {
  const creator = creatorForBrief(brief);
  const total = Array.isArray(plan?.scenes) ? plan.scenes.length : 0;
  const scenes = (plan.scenes || []).map((scene, index) => ({
    ...scene,
    characterStory: beatForScene(scene, index, total, creator),
    visualDesign: {
      ...(scene.visualDesign || {}),
      characterPrimary: true,
      stockRole: 'soft-background-texture-only',
      continuityRequired: true,
      textLayout: 'character-editorial-v1',
    },
  }));
  const state = status();
  return {
    ...plan,
    scenes,
    characterUniverse: {
      version: 4,
      required: true,
      finalLineupRequired: true,
      characterActingRequired: true,
      primaryCreator: creator,
      finalLineupPath: state.finalLineupPath,
      cast: Object.keys(CHARACTERS),
      storytelling: 'creator contradiction -> Devil causes leak -> metric consequence -> Doctor diagnosis -> Analyst prescription -> Devil defeat -> Elevate CTA',
      stockPolicy: 'soft-background-texture-only',
      textLayout: 'character-editorial-v1',
      genericHumanReplacementAllowed: false,
      genericSaaSPanelsAllowed: false,
    },
  };
}

function status() {
  const finalLineup = ensureFinalLineup();
  const reference = ensureReference();
  const legacySprites = spritePackReady();
  const configured = Boolean(finalLineup);
  return {
    implemented: true,
    requiredForElevateReels: true,
    configured,
    finalLineupRequired: true,
    finalLineupReady: Boolean(finalLineup),
    finalLineupPath: finalLineup,
    finalLineupCropBase: { width: 2048, height: 682 },
    referencePath: reference,
    legacySpriteRoot: SPRITE_ROOT,
    legacySpritePackReady: legacySprites,
    castCount: Object.keys(CHARACTERS).length,
    cast: Object.values(CHARACTERS).map(({ id, label, role }) => ({ id, label, role })),
    defaultCreator: 'info_creator',
    characterActingRequired: true,
    genericHumanReplacementAllowed: false,
    genericSaaSPanelsAllowed: false,
    lightweight: true,
    renderer: finalLineup ? 'approved transparent final-lineup compositor' : 'blocked until approved transparent final lineup is installed',
    installHint: finalLineup ? null : 'Run npm run reels:characters:add after saving the approved final transparent lineup PNG in Downloads. The installer recognizes "ChatGPT Image Sep 8, 2026, 02_09_14 PM.png" automatically.',
  };
}

module.exports = {
  ROOT,
  REFERENCE_PATH,
  FINAL_LINEUP_PATH,
  SPRITE_ROOT,
  SPRITE_BUILDER,
  CANONICAL_REFERENCE_NAMES,
  FINAL_LINEUP_NAMES,
  FINAL_LINEUP_CROPS,
  CHARACTERS,
  exists,
  spritePath,
  spritePaths,
  spritePackReady,
  finalLineupReady,
  candidateFinalLineupPaths,
  discoverFinalLineup,
  installFinalLineup,
  ensureFinalLineup,
  candidateReferencePaths,
  discoverReference,
  powershellBinary,
  buildSpritePack,
  installReference,
  ensureReference,
  ensureSpritePack,
  installCharacterAsset,
  creatorForBrief,
  propForScene,
  beatForScene,
  decoratePlan,
  status,
};
