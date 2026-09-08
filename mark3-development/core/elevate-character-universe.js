const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const config = require('./config');
const factory = require('./reel-factory');

const ROOT = path.join(factory.REEL_ROOT, 'characters');
const REFERENCE_PATH = path.join(ROOT, 'reference-sheet.jpg');
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
    crop: { x: 45, y: 75, w: 250, h: 715 },
    equipment: ['barbell', 'fitness metrics', 'workout content'],
    expressions: ['confident', 'confused', 'frustrated', 'motivated', 'celebrating'],
  },
  fashion_creator: {
    id: 'fashion_creator', label: 'Fashion Creator', role: 'fashion / lifestyle / beauty creator',
    crop: { x: 300, y: 78, w: 215, h: 705 },
    equipment: ['phone', 'camera', 'outfit cards', 'brand collab cards'],
    expressions: ['confident', 'surprised', 'frustrated', 'excited', 'celebrating'],
  },
  ugc_creator: {
    id: 'ugc_creator', label: 'UGC Creator', role: 'skincare / UGC / product-review creator',
    crop: { x: 505, y: 88, w: 205, h: 700 },
    equipment: ['product bottle', 'makeup brush', 'review card', 'camera'],
    expressions: ['curious', 'concerned', 'confident', 'excited', 'celebrating'],
  },
  info_creator: {
    id: 'info_creator', label: 'Info Creator', role: 'finance / tech / education / information creator',
    crop: { x: 690, y: 72, w: 215, h: 710 },
    equipment: ['phone', 'analytics', 'topic cards', 'content notes'],
    expressions: ['confident', 'confused', 'thinking', 'concerned', 'celebrating'],
  },
  retention_devil: {
    id: 'retention_devil', label: 'Retention Devil', role: 'personification of creator mistakes and audience drop-off, not the Instagram algorithm',
    crop: { x: 850, y: 20, w: 285, h: 770 },
    equipment: ['SKIP button', 'scissors', 'retention graph', 'down arrow', 'stopwatch', 'broken engagement meter', 'view/swipe cards'],
    expressions: ['smug', 'scheming', 'laughing', 'shocked', 'defeated'],
  },
  content_doctor_female: {
    id: 'content_doctor_female', label: 'Elevate Doctor', role: 'friendly Elevate strategist who diagnoses creator underperformance',
    crop: { x: 1120, y: 82, w: 190, h: 705 },
    equipment: ['stethoscope', 'tablet', 'scanner', 'retention graph', 'diagnostic report'],
    expressions: ['analytical', 'concerned', 'confident', 'approving', 'celebrating'],
  },
  content_doctor_male: {
    id: 'content_doctor_male', label: 'Elevate Analyst', role: 'strategic metrics-oriented Elevate expert who prescribes the fix',
    crop: { x: 1315, y: 80, w: 195, h: 705 },
    equipment: ['stethoscope', 'clipboard', 'dashboard', 'growth graph', 'strategy report'],
    expressions: ['analytical', 'thinking', 'confident', 'approving', 'celebrating'],
  },
});

function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function exists(file) { try { return Boolean(file && fs.existsSync(file) && fs.statSync(file).isFile()); } catch { return false; } }

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
  for (const root of roots) for (const name of CANONICAL_REFERENCE_NAMES) candidates.push(path.join(root, name));
  return [...new Set(candidates)];
}

function discoverReference() {
  if (exists(REFERENCE_PATH)) return REFERENCE_PATH;
  return candidateReferencePaths().find(exists) || null;
}

function installReference(source) {
  const src = path.resolve(String(source || discoverReference() || ''));
  if (!exists(src)) throw new Error('Elevate character reference sheet was not found. Set ULTRON_M3_ELEVATE_CHARACTER_REFERENCE or run the character installer with the reference image path.');
  fs.mkdirSync(ROOT, { recursive: true });
  if (path.resolve(src) !== path.resolve(REFERENCE_PATH)) fs.copyFileSync(src, REFERENCE_PATH);
  return REFERENCE_PATH;
}

function ensureReference() {
  if (exists(REFERENCE_PATH)) return REFERENCE_PATH;
  const found = discoverReference();
  if (!found) return null;
  try { return installReference(found); } catch { return null; }
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
      story: 'The female Elevate doctor scans the creator performance and diagnoses the bottleneck.',
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
    story: 'Keep the creator and Elevate strategist on screen while the explanatory graphic carries the lesson.',
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
      stockRole: 'background-support-only',
      continuityRequired: true,
    },
  }));
  return {
    ...plan,
    scenes,
    characterUniverse: {
      version: 1,
      required: true,
      primaryCreator: creator,
      referencePath: ensureReference(),
      cast: Object.keys(CHARACTERS),
      storytelling: 'creator -> retention devil -> metric consequence -> Elevate diagnosis -> prescription -> recovery -> Elevate CTA',
      stockPolicy: 'supporting-background-only',
      genericHumanReplacementAllowed: false,
    },
  };
}

function status() {
  const reference = ensureReference();
  return {
    implemented: true,
    requiredForElevateReels: true,
    configured: Boolean(reference),
    referencePath: reference,
    castCount: Object.keys(CHARACTERS).length,
    cast: Object.values(CHARACTERS).map(({ id, label, role }) => ({ id, label, role })),
    defaultCreator: 'info_creator',
    genericHumanReplacementAllowed: false,
    lightweight: true,
    renderer: 'single-reference-sheet FFmpeg crop/overlay',
    installHint: reference ? null : 'Set ULTRON_M3_ELEVATE_CHARACTER_REFERENCE to the seven-character reference image, or run npm run reels:characters:add -- "C:\\path\\to\\1000248121.jpg".',
  };
}

module.exports = {
  ROOT,
  REFERENCE_PATH,
  CANONICAL_REFERENCE_NAMES,
  CHARACTERS,
  candidateReferencePaths,
  discoverReference,
  installReference,
  ensureReference,
  creatorForBrief,
  propForScene,
  beatForScene,
  decoratePlan,
  status,
};
