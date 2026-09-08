const fs = require('fs');
const path = require('path');
const universe = require('./elevate-character-universe');
const pipeline = require('./reel-pipeline');

function escPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:').replace(/'/g, "\\'");
}

function escapeDrawtextText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function appearances(plan = {}) {
  const list = [];
  for (const scene of plan.scenes || []) {
    const story = scene.characterStory;
    if (!story?.characters?.length) continue;
    const chars = story.characters.slice(0, 3);
    chars.forEach((characterId, slot) => {
      if (!universe.CHARACTERS[characterId]) return;
      list.push({
        sceneIndex: Number(scene.index || 0),
        characterId,
        storyType: story.type,
        slot,
        slotCount: chars.length,
        start: Number(scene.start || 0),
        end: Number(scene.end || plan.durationSec || 30),
        motion: story.motion || 'panel-explain',
        expression: story.expressions?.[slot] || 'confident',
        prop: story.prop || 'metric-card',
      });
    });
  }
  return list;
}

function characterHeight(item) {
  if (item.storyType === 'elevate-close') return 600;
  if (item.slotCount >= 3) return item.characterId === 'retention_devil' ? 460 : 500;
  if (item.slotCount === 2) return item.characterId === 'retention_devil' ? 620 : 590;
  return item.characterId === 'retention_devil' ? 720 : 660;
}

function targetPosition(item) {
  const height = characterHeight(item);
  if (item.storyType === 'elevate-close') return item.slot === 0
    ? { x: 120, y: 1010, anchor: 'left', height }
    : { x: 960, y: 1010, anchor: 'right', height };
  if (item.storyType === 'doctor-prescription' && item.slotCount >= 3) {
    if (item.slot === 0) return { x: 35, y: 1010, anchor: 'left', height };
    if (item.slot === 1) return { x: 540, y: 1010, anchor: 'center', height };
    return { x: 1050, y: 1080, anchor: 'right', height: 390 };
  }
  if (item.slotCount === 1) return { x: 540, y: 930, anchor: 'center', height };
  if (item.slotCount === 2) return item.slot === 0
    ? { x: 65, y: 1010, anchor: 'left', height }
    : { x: 1015, y: 1010, anchor: 'right', height };
  if (item.slot === 0) return { x: 30, y: 1030, anchor: 'left', height };
  if (item.slot === 1) return { x: 540, y: 980, anchor: 'center', height };
  return { x: 1050, y: 1030, anchor: 'right', height };
}

function overlayX(item, target) {
  const s = item.start.toFixed(3);
  if (target.anchor === 'center') {
    const base = '(W-w)/2';
    if (/devil|attack|ambush/.test(item.motion)) return `${base}+8*sin(28*t)`;
    return `${base}+4*sin(3*t)`;
  }
  if (target.anchor === 'left') {
    const tx = target.x;
    return `if(lt(t,${s}+0.32),-w+(t-${s})/0.32*(${tx}+w),${tx}+3*sin(3*t))`;
  }
  const tx = target.x;
  return `if(lt(t,${s}+0.32),W-(t-${s})/0.32*(W-${tx}),${tx}-w+3*sin(3*t))`;
}

function overlayY(item, target) {
  const s = item.start.toFixed(3);
  const base = target.y;
  if (item.characterId === 'retention_devil') return `${base}+7*sin(8*(t-${s}))`;
  if (/celebr|recovery|prescription/.test(`${item.expression} ${item.motion}`)) return `${base}+6*sin(5*(t-${s}))`;
  return `${base}+3*sin(2.5*(t-${s}))`;
}

function box(filters, x, y, w, h, color, enable) {
  filters.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=fill:${enable}`);
}

function label(filters, fontExpr, value, x, y, size, color, enable) {
  const text = escapeDrawtextText(value);
  filters.push(`drawtext=${fontExpr}text='${text}':expansion=none:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}:${enable}`);
}

function drawMetricCard(filters, fontExpr, enable) {
  box(filters, 155, 270, 350, 190, 'black@0.58', enable);
  box(filters, 575, 270, 350, 190, 'black@0.58', enable);
  box(filters, 155, 270, 8, 190, '0x5B8CFF@0.95', enable);
  box(filters, 575, 270, 8, 190, '0xEF4444@0.95', enable);
  label(filters, fontExpr, 'VIEWS', 210, 306, 31, 'white@0.82', enable);
  label(filters, fontExpr, '12.8K', 210, 355, 58, 'white', enable);
  label(filters, fontExpr, 'FOLLOWS', 630, 306, 31, 'white@0.82', enable);
  label(filters, fontExpr, '+19', 630, 355, 58, '0xFF7474', enable);
}

function drawRetention(filters, fontExpr, enable) {
  box(filters, 150, 260, 780, 225, 'black@0.55', enable);
  label(filters, fontExpr, 'RETENTION', 190, 290, 30, 'white@0.82', enable);
  const heights = [145, 130, 108, 86, 58, 35];
  heights.forEach((height, index) => box(filters, 220 + index * 105, 445 - height, 64, height, index < 2 ? '0x5B8CFF@0.88' : '0xEF4444@0.78', enable));
  box(filters, 210, 448, 680, 3, 'white@0.26', enable);
}

function drawFunnel(filters, fontExpr, enable) {
  label(filters, fontExpr, 'VIEW  >  PROFILE  >  FOLLOW', 212, 265, 32, 'white@0.88', enable);
  box(filters, 185, 330, 710, 56, 'white@0.14', enable);
  box(filters, 285, 400, 510, 56, '0x5B8CFF@0.28', enable);
  box(filters, 390, 470, 300, 56, '0x5B8CFF@0.78', enable);
}

function drawHookMeter(filters, fontExpr, enable) {
  label(filters, fontExpr, 'HOOK STRENGTH', 190, 285, 30, 'white@0.82', enable);
  box(filters, 190, 350, 700, 44, 'white@0.12', enable);
  box(filters, 190, 350, 505, 44, '0x5B8CFF@0.9', enable);
  box(filters, 695, 342, 6, 60, 'white@0.9', enable);
  label(filters, fontExpr, '72%', 760, 338, 42, 'white', enable);
}

function drawPillars(filters, fontExpr, enable) {
  ['HOOK', 'VALUE', 'CTA'].forEach((text, index) => {
    const x = 145 + index * 275;
    box(filters, x, 310, 235, 150, index === 1 ? '0x17345F@0.92' : 'black@0.55', enable);
    box(filters, x, 310, 235, 6, '0x5B8CFF@0.9', enable);
    label(filters, fontExpr, text, x + 48, 365, 34, 'white', enable);
  });
}

function drawBrandCard(filters, fontExpr, enable) {
  box(filters, 170, 275, 740, 220, 'black@0.58', enable);
  box(filters, 170, 275, 8, 220, '0x5B8CFF@0.95', enable);
  label(filters, fontExpr, 'BRAND READY?', 225, 310, 32, 'white@0.78', enable);
  label(filters, fontExpr, 'TRUST  +  FIT  +  PROOF', 225, 375, 38, 'white', enable);
}

function drawGenericSignal(filters, fontExpr, enable) {
  box(filters, 175, 285, 730, 180, 'black@0.48', enable);
  box(filters, 175, 285, 7, 180, '0x5B8CFF@0.92', enable);
  label(filters, fontExpr, 'CREATOR SIGNAL', 225, 320, 30, 'white@0.75', enable);
  box(filters, 225, 390, 530, 18, 'white@0.14', enable);
  box(filters, 225, 390, 375, 18, '0x5B8CFF@0.88', enable);
}

function propFilters(plan = {}) {
  const filters = [];
  const font = pipeline.findCaptionFont();
  const fontExpr = font ? `fontfile='${escPath(font)}':` : '';
  for (const scene of plan.scenes || []) {
    const story = scene.characterStory;
    if (!story) continue;
    const s = Number(scene.start || 0).toFixed(2);
    const e = Number(scene.end || plan.durationSec || 30).toFixed(2);
    const enable = `enable='between(t,${s},${e})'`;

    if (story.prop === 'views-vs-follows') drawMetricCard(filters, fontExpr, enable);
    else if (story.prop === 'retention-graph') drawRetention(filters, fontExpr, enable);
    else if (story.prop === 'conversion-funnel') drawFunnel(filters, fontExpr, enable);
    else if (story.prop === 'hook-meter') drawHookMeter(filters, fontExpr, enable);
    else if (story.prop === 'content-pillars') drawPillars(filters, fontExpr, enable);
    else if (story.prop === 'brand-card') drawBrandCard(filters, fontExpr, enable);
    else drawGenericSignal(filters, fontExpr, enable);

    if (story.type === 'devil-interruption' || story.type === 'metric-consequence') {
      box(filters, 430, 535, 220, 88, '0xB91C1C@0.94', enable);
      label(filters, fontExpr, 'SKIP', 485, 551, 46, 'white', enable);
      box(filters, 466, 645, 148, 11, '0xEF4444@0.9', enable);
      box(filters, 530, 645, 18, 90, '0xEF4444@0.9', enable);
    }
    if (story.type === 'doctor-diagnosis') {
      box(filters, 130, 245, 820, 5, '0x5B8CFF@0.95', enable);
      box(filters, 130, 500, 820, 4, '0x5B8CFF@0.52', enable);
      label(filters, fontExpr, 'ELEVATE DIAGNOSIS', 365, 525, 28, '0xAFC9FF', enable);
    }
    if (story.type === 'doctor-prescription') {
      box(filters, 230, 245, 620, 255, 'black@0.58', enable);
      box(filters, 230, 245, 7, 255, '0x5B8CFF@0.95', enable);
      label(filters, fontExpr, 'PRESCRIPTION', 285, 280, 28, '0xAFC9FF', enable);
      label(filters, fontExpr, 'HOOK  >  VALUE  >  CTA', 285, 355, 36, 'white', enable);
      label(filters, fontExpr, 'REPEAT WHAT WORKS', 285, 415, 31, 'white@0.80', enable);
    }
    if (scene.isBrandCta) {
      box(filters, 150, 260, 780, 5, '0x5B8CFF@0.9', enable);
      label(filters, fontExpr, 'ELEVATE OS', 392, 302, 46, 'white', enable);
    }
  }
  return filters;
}

function validSpriteMap(candidate, cast) {
  if (!candidate || typeof candidate !== 'object') return null;
  for (const item of cast) {
    const file = candidate[item.characterId];
    if (!file || !fs.existsSync(file)) return null;
  }
  return candidate;
}

function spriteMapFor(cast, options = {}) {
  const override = validSpriteMap(options.characterSpritePaths, cast);
  if (override) return override;
  if (universe.spritePackReady()) return universe.spritePaths();
  return null;
}

function backgroundFilter() {
  return '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,boxblur=12:2,eq=brightness=-0.14:saturation=0.42:contrast=1.05,drawbox=x=0:y=0:w=iw:h=ih:color=0x050811@0.38:t=fill[base]';
}

function overlayChain(filters, cast, sourceLabels) {
  let previous = '[base]';
  cast.forEach((item, i) => {
    const target = targetPosition(item);
    filters.push(`${sourceLabels[i]}scale=-2:${target.height}[char${i}]`);
    const out = `[cv${i}]`;
    const enable = `enable='between(t,${item.start.toFixed(3)},${item.end.toFixed(3)})'`;
    filters.push(`${previous}[char${i}]overlay=x='${overlayX(item, target)}':y='${overlayY(item, target)}':${enable}:eval=frame${out}`);
    previous = out;
  });
  return previous;
}

function renderWithSprites(videoPath, output, plan, cast, spriteMap) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath];
  const filters = [backgroundFilter()];
  const sourceLabels = [];
  cast.forEach((item, index) => {
    const file = path.resolve(spriteMap[item.characterId]);
    args.push('-loop', '1', '-framerate', '30', '-i', file);
    filters.push(`[${index + 1}:v]format=rgba,setpts=PTS-STARTPTS[sprite${index}]`);
    sourceLabels.push(`[sprite${index}]`);
  });
  const previous = overlayChain(filters, cast, sourceLabels);
  const props = propFilters(plan);
  filters.push(props.length ? `${previous}${props.join(',')}[vout]` : `${previous}null[vout]`);
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-an',
    '-t', Number(plan.durationSec || 30).toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', output
  );
  pipeline.run('ffmpeg', args, { timeoutMs: 360000 });
  return { assetMode: 'transparent-sprites', spriteCount: cast.length };
}

function renderWithReference(videoPath, output, plan, cast, reference) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath, '-loop', '1', '-framerate', '30', '-i', reference];
  const filters = [backgroundFilter()];
  const fallbackCrops = {
    gym_creator: { x: 0, y: 60, w: 315, h: 755 },
    fashion_creator: { x: 315, y: 80, w: 200, h: 735 },
    ugc_creator: { x: 515, y: 90, w: 195, h: 725 },
    info_creator: { x: 710, y: 80, w: 195, h: 735 },
    retention_devil: { x: 905, y: 50, w: 225, h: 765 },
    content_doctor_female: { x: 1130, y: 85, w: 180, h: 730 },
    content_doctor_male: { x: 1310, y: 80, w: 226, h: 740 },
  };
  filters.push(`[1:v]scale=1536:839,split=${cast.length}${cast.map((_, i) => `[sheet${i}]`).join('')}`);
  const sourceLabels = [];
  cast.forEach((item, i) => {
    const crop = fallbackCrops[item.characterId];
    filters.push(`[sheet${i}]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},colorkey=0xF4F4F4:0.045:0.02,format=rgba[ref${i}]`);
    sourceLabels.push(`[ref${i}]`);
  });
  const previous = overlayChain(filters, cast, sourceLabels);
  const props = propFilters(plan);
  filters.push(props.length ? `${previous}${props.join(',')}[vout]` : `${previous}null[vout]`);
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-an',
    '-t', Number(plan.durationSec || 30).toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', output
  );
  pipeline.run('ffmpeg', args, { timeoutMs: 360000 });
  return { assetMode: 'reference-compatibility', spriteCount: 0 };
}

function apply(videoPath, result, plan, options = {}) {
  if (options.characters === false) return { path: videoPath, meta: { applied: false, reason: 'disabled' } };
  const cast = appearances(plan);
  if (!cast.length) return { path: videoPath, meta: { applied: false, reason: 'no-character-story-beats' } };

  const root = result?.paths?.dir || path.dirname(videoPath);
  const tempDir = path.join(root, 'finish-temp');
  fs.mkdirSync(tempDir, { recursive: true });
  const output = path.join(tempDir, 'character-universe.mp4');
  const spriteMap = spriteMapFor(cast, options);
  let renderMeta;
  let reference = null;
  if (spriteMap) {
    renderMeta = renderWithSprites(videoPath, output, plan, cast, spriteMap);
  } else {
    reference = options.characterReferencePath || universe.ensureReference();
    if (!reference || !fs.existsSync(reference)) return { path: videoPath, meta: { applied: false, reason: 'character-assets-missing', required: true } };
    renderMeta = renderWithReference(videoPath, output, plan, cast, reference);
  }

  const verified = pipeline.verifyOutput(output);
  return {
    path: output,
    meta: {
      applied: true,
      engine: 'elevate-character-universe-v3',
      referencePath: reference,
      spritePackReady: Boolean(spriteMap),
      assetMode: renderMeta.assetMode,
      appearances: cast.length,
      sceneCoverage: new Set(cast.map((item) => item.sceneIndex)).size,
      castUsed: [...new Set(cast.map((item) => item.characterId))],
      storyModes: [...new Set((plan.scenes || []).map((scene) => scene.characterStory?.type).filter(Boolean))],
      propModes: [...new Set((plan.scenes || []).map((scene) => scene.characterStory?.prop).filter(Boolean))],
      stockRole: 'blurred-background-texture-only',
      genericHumanReplacementAllowed: false,
      ffmpegTextExpansion: 'none',
      output: verified.path,
    },
  };
}

function status() {
  const universeStatus = universe.status();
  return {
    implemented: true,
    configured: universeStatus.configured,
    castCount: universeStatus.castCount,
    referencePath: universeStatus.referencePath,
    spritePackReady: universeStatus.spritePackReady,
    spriteRoot: universeStatus.spriteRoot,
    renderer: universeStatus.spritePackReady
      ? 'FFmpeg transparent-sprite stage + recurring cast + story props + motion'
      : 'FFmpeg reference compatibility compositor',
    lightweight: true,
    characterPrimary: true,
    stockRole: 'blurred-background-texture-only',
    genericSaaSPanelsDisabled: true,
    safeLiteralDrawtext: true,
  };
}

module.exports = {
  escapeDrawtextText,
  appearances,
  characterHeight,
  targetPosition,
  overlayX,
  overlayY,
  propFilters,
  spriteMapFor,
  backgroundFilter,
  apply,
  status,
};
