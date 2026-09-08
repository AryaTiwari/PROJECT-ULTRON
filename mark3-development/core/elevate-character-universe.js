const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const config = require('./config');
const factory = require('./reel-factory');

const ROOT = path.join(factory.REEL_ROOT, 'characters');
const REFERENCE_PATH = path.join(ROOT, 'reference-sheet.jpg');
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

const CHARACTERS = Object.freeze({
  gym_creator: {
    id: 'gym_creator', label: 'Gym Creator', role: 'fitness creator',
    equipment: ['barbell', 'fitness metrics', 'workout content'],
    expressions: ['confident', 'confused', 'frustrated', 'motivated', 'celebrating'],
  },
  fashion_creator: {
    id: 'fashion_creator', label: 'Fashion Creator', role: 'fashion / lifestyle / beauty creator',
    equipment: ['phone', 'camera', 'outfit cards', 'brand collab cards'],
    expressions: ['confident', 'surprised', 'frustrated', 'excited', 'celebrating'],
  },
  ugc_creator: {
    id: 'ugc_creator', label: 'UGC Creator', role: 'skincare / UGC / product-review creator',
    equipment: ['product bottle', 'makeup brush', 'review card', 'camera'],
    expressions: ['curious', 'concerned', 'confident', 'excited', 'celebrating'],
  },
  info_creator: {
    id: 'info_creator', label: 'Info Creator', role: 'finance / tech / education / information creator',
    equipment: ['phone', 'analytics', 'topic cards', 'content notes'],
    expressions: ['confident', 'confused', 'thinking', 'concerned', 'celebrating'],
  },
  retention_devil: {
    id: 'retention_devil', label: 'Retention Devil', role: 'personification of creator mistakes and audience drop-off, not the Instagram algorithm',
    equipment: ['SKIP button', 'scissors', 'retention graph', 'down arrow', 'stopwatch', 'broken engagement meter', 'view/swipe cards'],
    expressions: ['smug', 'scheming', 'laughing', 'shocked', 'defeated'],
  },
  content_doctor_female: {
    id: 'content_doctor_female', label: 'Elevate Doctor', role: 'friendly Elevate strategist who diagnoses creator underperformance',
    equipment: ['stethoscope', 'tablet', 'scanner', 'retention graph', 'diagnostic report'],
    expressions: ['analytical', 'concerned', 'confident', 'approving', 'celebrating'],
  },
  content_doctor_male: {
    id: 'content_doctor_male', label: 'Elevate Analyst', role: 'strategic metrics-oriented Elevate expert who prescribes the fix',
    equipment: ['stethoscope', 'clipboard', 'dashboard', 'growth graph', 'strategy report'],
    expressions: ['analytical', 'thinking', 'confident', 'approving', 'celebrating'],
  },
});

function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function exists(file) { try { return Boolean(file && fs.existsSync(file) && fs.statSync(file).isFile()); } catch { return false; } }
function spritePath(id) { return path.join(SPRITE_ROOT, `${id}.png`); }
function spritePaths() { return Object.fromEntries(Object.keys(CHARACTERS).map((id) => [id, spritePath(id)])); }
function spritePackReady() { return Object.keys(CHARACTERS).every((id) => exists(spritePath(id)) && fs.statSync(spritePath(id)).size >= 4096); }

function candidateReferencePaths() {
  const home = os.homedir();
  const configured = clean(process.env.ULTRON_M3_ELEVATE_CHARACTER_REFERENCE);
  const roots = [
    configured ? path.dirname(configured) : null,
    path.join(home, 'Downloads'),
    path.join(home, 'Pictures'),
    path.join(home, 'Desktop'),
    config.projectRoot,
    path.join(config.projectRoot, 'assets'),
    path.join(config.projectRoot, 'mark3-development', 'assets'),
  ].filter(Boolean);
  const candidates = [];
  if (configured) candidates.push(path.resolve(configured));
  if (exists(REFERENCE_PATH)) candidates.push(REFERENCE_PATH);
  for (const root of roots) for (const name of CANONICAL_REFERENCE_NAMES) candidates.push(path.join(root, name));
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

function buildSpritePack(reference = REFERENCE_PATH) {
  if (spritePackReady()) return { ok: true, alreadyBuilt: true, root: SPRITE_ROOT, files: spritePaths() };
  if (!exists(reference)) return { ok: false, error: 'character reference sheet is missing' };
  if (process.platform !== 'win32') return { ok: false, unsupported: true, error: 'transparent sprite builder is Windows-only in this lightweight runtime' };
  const powershell = powershellBinary();
  if (!powershell) return { ok: false, error: 'PowerShell is unavailable for the transparent character sprite build' };
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
  if (!exists(src)) throw new Error('Elevate character reference sheet was not found. Set ULTRON_M3_ELEVATE_CHARACTER_REFERENCE or run the character installer with the reference image path.');
  fs.mkdirSync(ROOT, { recursive: true });
  if (path.resolve(src) !== path.resolve(REFERENCE_PATH)) fs.copyFileSync(src, REFERENCE_PATH);
  const spriteBuild = buildSpritePack(REFERENCE_PATH);
  if (process.platform === 'win32' && !spriteBuild.ok) {
    throw new Error(`Character reference installed, but transparent sprite pack generation failed: ${spriteBuild.error}`);
  }
  return REFERENCE_PATH;
}

function ensureReference() {
  if (exists(REFERENCE_PATH)) return REFERENCE_PATH;
  const found = candidateReferencePaths().find(exists);
  if (!found) return null;
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    if (path.resolve(found) !== path.resolve(REFERENCE_PATH)) fs.copyFileSync(found, REFERENCE_PATH);
    return REFERENCE_PATH;
  } catch { return null; }
}

function ensureSpritePack() {
  if (spritePackReady()) return { ok: true, root: SPRITE_ROOT, files: spritePaths() };
  const reference = ensureReference();
  if (!reference) return { ok: false, error: 'character reference sheet is missing' };
  return buildSpritePack(reference);
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
  if (/\b(?:retention|watch time|skip|drop.?off|completion)\b/.test(text)) return 'retention-graph';
  if (/\b(?:views?|reach|viral)\b/.test(text) && /\b(?:follow|loyal|conversion|profile)\b/.test(text)) return 'views-vs-follows';
  if (/\b(?:conversion|profile visit|funnel|next step)\b/.test(text)) return 'conversion-funnel';
  if (/\b(?:hook|opening|first second|pattern interrupt)\b/.test(text)) return 'hook-meter';
  if (/\b(?:cta|call to action|book|comment|dm)\b/.test(text)) return 'cta-button';
  if (/\b(?:brand|moneti|sponsor|collab|revenue|earn)\b/.test(text)) return 'brand-card';
  if (/\b(?:pillar|strategy|system|calendar|consistent|posting)\b/.test(text)) return 'content-pillars';
  return 'metric-card';
}

function beatForScene(scene, index, total, creator) {
  if (scene.isBrandCta || index === total - 1) {
    return {
      type: 'elevate-close',
      characters: ['content_doctor_female', 'content_doctor_male'],
      expressions: ['confident', 'approving'],
      prop: 'cta-button', motion: 'doctor-close',
      story: 'Elevate doctors own the final recommendation and invite the creator to the strategy session.',
    };
  }
  if (index === 0) {
    return {
      type: 'creator-hook', characters: [creator], expressions: ['confident'],
      prop: propForScene(scene), motion: 'creator-pop',
      story: 'Open on the creator archetype and the problem signal immediately.',
    };
  }
  if (index === 1) {
    return {
      type: 'devil-interruption', characters: [creator, 'retention_devil'], expressions: ['confused', 'smug'],
      prop: propForScene(scene), motion: 'devil-ambush',
      story: 'The Retention Devil appears as the personified mistake creating the performance leak.',
    };
  }
  if (index === 2) {
    return {
      type: 'metric-consequence', characters: ['retention_devil', creator], expressions: ['scheming', 'frustrated'],
      prop: propForScene(scene), motion: 'metric-attack',
      story: 'The Devil interacts with the graph, skip button, funnel or metric so the cause becomes visual rather than abstract.',
    };
  }
  if (index === 3 || /\b(?:diagnos|cause|problem|why)\b/i.test(clean(scene.purpose))) {
    return {
      type: 'doctor-diagnosis', characters: [creator, 'content_doctor_female'], expressions: ['concerned', 'analytical'],
      prop: propForScene(scene), motion: 'scanner-diagnosis',
      story: 'The female Elevate doctor scans creator performance and diagnoses the bottleneck.',
    };
  }
  if (index === total - 2 || /\b(?:action|fix|solution|strategy|payoff|measure)\b/i.test(clean(scene.purpose))) {
    return {
      type: 'doctor-prescription', characters: ['content_doctor_male', creator, 'retention_devil'], expressions: ['confident', 'motivated', 'shocked'],
      prop: propForScene(scene), motion: 'prescription-reveal',
      story: 'The male Elevate doctor presents the fix while the Devil loses control of the metric.',
    };
  }
  return {
    type: 'story-explanation', characters: [creator, 'content_doctor_female'], expressions: ['thinking', 'confident'],
    prop: propForScene(scene), motion: 'panel-explain',
    story: 'Keep the creator and Elevate strategist visible while the explanatory graphic carries the lesson.',
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
      stockRole: 'blurred-background-texture-only',
      continuityRequired: true,
    },
  }));
  const state = status();
  return {
    ...plan,
    scenes,
    characterUniverse: {
      version: 3,
      required: true,
      primaryCreator: creator,
      referencePath: state.referencePath,
      spriteRoot: state.spriteRoot,
      spritePackReady: state.spritePackReady,
      cast: Object.keys(CHARACTERS),
      storytelling: 'creator -> retention devil -> metric consequence -> Elevate diagnosis -> prescription -> recovery -> Elevate CTA',
      stockPolicy: 'blurred-background-texture-only',
      genericHumanReplacementAllowed: false,
      genericSaaSPanelsAllowed: false,
    },
  };
}

function status() {
  const reference = ensureReference();
  const sprites = spritePackReady();
  const needsSprites = process.platform === 'win32';
  const configured = Boolean(reference) && (!needsSprites || sprites);
  let installHint = null;
  if (!reference) installHint = 'Set ULTRON_M3_ELEVATE_CHARACTER_REFERENCE to the seven-character reference image, or run npm run reels:characters:add -- "C:\\path\\to\\elevate-character-reference.jpg".';
  else if (needsSprites && !sprites) installHint = 'Run npm run reels:characters:add once more to build the transparent seven-character sprite pack from the installed reference sheet.';
  return {
    implemented: true,
    requiredForElevateReels: true,
    configured,
    referencePath: reference,
    spriteRoot: SPRITE_ROOT,
    spritePackReady: sprites,
    spritePackRequiredOnWindows: needsSprites,
    spritePaths: sprites ? spritePaths() : {},
    castCount: Object.keys(CHARACTERS).length,
    cast: Object.values(CHARACTERS).map(({ id, label, role }) => ({ id, label, role })),
    defaultCreator: 'info_creator',
    genericHumanReplacementAllowed: false,
    genericSaaSPanelsAllowed: false,
    lightweight: true,
    renderer: sprites ? 'transparent PNG sprite compositor' : 'reference-sheet compatibility compositor',
    installHint,
  };
}

module.exports = {
  ROOT,
  REFERENCE_PATH,
  SPRITE_ROOT,
  SPRITE_BUILDER,
  CANONICAL_REFERENCE_NAMES,
  CHARACTERS,
  exists,
  spritePath,
  spritePaths,
  spritePackReady,
  candidateReferencePaths,
  discoverReference,
  powershellBinary,
  buildSpritePack,
  installReference,
  ensureReference,
  ensureSpritePack,
  creatorForBrief,
  propForScene,
  beatForScene,
  decoratePlan,
  status,
};
