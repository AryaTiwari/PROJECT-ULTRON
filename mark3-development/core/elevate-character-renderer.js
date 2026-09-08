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
        stage: story.stage || 'explanation-stage',
        role: story.roles?.[slot] || 'support',
        slot,
        slotCount: chars.length,
        start: Number(scene.start || 0),
        end: Number(scene.end || plan.durationSec || 30),
        motion: story.motion || 'doctor-explain',
        expression: story.expressions?.[slot] || 'confident',
        prop: story.prop || 'creator-system',
        action: story.action || '',
      });
    });
  }
  return list;
}

function characterHeight(item) {
  switch (item.stage) {
    case 'creator-hero': return item.characterId === 'retention_devil' ? 820 : 840;
    case 'conflict-split': return item.characterId === 'retention_devil' ? 790 : 720;
    case 'devil-dominant': return item.characterId === 'retention_devil' ? 850 : 640;
    case 'diagnosis-split': return 720;
    case 'explanation-stage': return item.characterId === 'content_doctor_female' ? 735 : 660;
    case 'prescription-stage':
      if (item.role === 'strategist') return 760;
      if (item.role === 'defeated-antagonist') return 430;
      return 650;
    case 'cta-stage': return 720;
    default: return item.characterId === 'retention_devil' ? 760 : 700;
  }
}

function targetPosition(item) {
  const height = characterHeight(item);
  switch (item.stage) {
    case 'creator-hero':
      return { x: 540, y: 885, anchor: 'center', height };
    case 'conflict-split':
      return item.role === 'antagonist'
        ? { x: 1040, y: 895, anchor: 'right', height }
        : { x: 45, y: 1010, anchor: 'left', height };
    case 'devil-dominant':
      return item.role === 'dominant-antagonist'
        ? { x: 1045, y: 830, anchor: 'right', height }
        : { x: 45, y: 1060, anchor: 'left', height };
    case 'diagnosis-split':
      return item.role === 'diagnostician'
        ? { x: 1035, y: 995, anchor: 'right', height }
        : { x: 45, y: 1020, anchor: 'left', height };
    case 'explanation-stage':
      return item.role === 'guide'
        ? { x: 1035, y: 985, anchor: 'right', height }
        : { x: 45, y: 1040, anchor: 'left', height };
    case 'prescription-stage':
      if (item.role === 'strategist') return { x: 25, y: 980, anchor: 'left', height };
      if (item.role === 'recovering-creator') return { x: 540, y: 1045, anchor: 'center', height };
      return { x: 1050, y: 1175, anchor: 'right', height };
    case 'cta-stage':
      return item.role === 'host-left'
        ? { x: 80, y: 1005, anchor: 'left', height }
        : { x: 1000, y: 1005, anchor: 'right', height };
    default:
      if (item.slotCount === 1) return { x: 540, y: 980, anchor: 'center', height };
      return item.slot === 0
        ? { x: 55, y: 1010, anchor: 'left', height }
        : { x: 1025, y: 1010, anchor: 'right', height };
  }
}

function anchoredX(target) {
  if (target.anchor === 'center') return '(W-w)/2';
  if (target.anchor === 'left') return String(target.x);
  return `${target.x}-w`;
}

function overlayX(item, target) {
  const s = item.start.toFixed(3);
  const e = item.end.toFixed(3);
  const base = anchoredX(target);

  if (item.role === 'defeated-antagonist') {
    const retreat = Math.max(item.start, item.end - 1.05).toFixed(3);
    return `if(lt(t,${s}+0.30),W-(t-${s})/0.30*(W-(${base})),if(gt(t,${retreat}),(${base})+(t-${retreat})*260,${base}))`;
  }
  if (target.anchor === 'center') {
    if (item.motion === 'creator-pop') return `${base}+4*sin(3*(t-${s}))`;
    return `${base}+3*sin(2.4*(t-${s}))`;
  }
  if (target.anchor === 'left') {
    return `if(lt(t,${s}+0.32),-w+(t-${s})/0.32*(${target.x}+w),${target.x}+3*sin(2.6*(t-${s})))`;
  }
  return `if(lt(t,${s}+0.30),W-(t-${s})/0.30*(W-(${base})),(${base})+3*sin(2.8*(t-${s})))`;
}

function overlayY(item, target) {
  const s = item.start.toFixed(3);
  const base = target.y;
  if (item.motion === 'creator-pop') return `if(lt(t,${s}+0.28),H-(t-${s})/0.28*(H-${base}),${base}+3*sin(2.4*(t-${s})))`;
  if (item.role === 'dominant-antagonist') return `${base}+7*sin(9*(t-${s}))`;
  if (item.role === 'defeated-antagonist') return `${base}+6*sin(10*(t-${s}))`;
  if (item.role === 'diagnostician' || item.role === 'strategist') return `${base}+3*sin(2.2*(t-${s}))`;
  return `${base}+3*sin(2.5*(t-${s}))`;
}

function box(filters, x, y, w, h, color, enable) {
  filters.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=fill:${enable}`);
}

function label(filters, fontExpr, value, x, y, size, color, enable) {
  const text = escapeDrawtextText(value);
  filters.push(`drawtext=${fontExpr}text='${text}':expansion=none:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}:${enable}`);
}

function drawViewsVsFollows(filters, fontExpr, enable) {
  box(filters, 135, 475, 370, 180, '0x08111F@0.76', enable);
  box(filters, 575, 475, 370, 180, '0x08111F@0.76', enable);
  box(filters, 135, 475, 7, 180, '0x5B8CFF@0.96', enable);
  box(filters, 575, 475, 7, 180, '0xEF4444@0.96', enable);
  label(filters, fontExpr, 'VIEWS', 190, 508, 29, 'white@0.72', enable);
  label(filters, fontExpr, '12.8K', 190, 553, 62, 'white', enable);
  label(filters, fontExpr, 'FOLLOWS', 630, 508, 29, 'white@0.72', enable);
  label(filters, fontExpr, '+19', 630, 553, 62, '0xFF7A7A', enable);
}

function drawRetention(filters, fontExpr, enable) {
  box(filters, 145, 470, 790, 235, '0x08111F@0.70', enable);
  label(filters, fontExpr, 'RETENTION DROP', 190, 500, 30, 'white@0.78', enable);
  const heights = [150, 132, 108, 84, 58, 34];
  heights.forEach((height, index) => box(filters, 215 + index * 110, 670 - height, 66, height, index < 2 ? '0x5B8CFF@0.90' : '0xEF4444@0.82', enable));
  box(filters, 205, 672, 690, 3, 'white@0.22', enable);
}

function drawFunnel(filters, fontExpr, enable) {
  label(filters, fontExpr, 'VIEW  >  PROFILE  >  FOLLOW', 215, 462, 31, 'white@0.84', enable);
  box(filters, 175, 525, 730, 54, 'white@0.14', enable);
  box(filters, 275, 592, 530, 54, '0x5B8CFF@0.24', enable);
  box(filters, 385, 659, 310, 54, '0xEF4444@0.68', enable);
  label(filters, fontExpr, 'DROP-OFF', 452, 671, 27, 'white', enable);
}

function drawHookMeter(filters, fontExpr, enable) {
  label(filters, fontExpr, 'HOOK STRENGTH', 180, 485, 29, 'white@0.76', enable);
  box(filters, 180, 545, 720, 42, 'white@0.12', enable);
  box(filters, 180, 545, 520, 42, '0x5B8CFF@0.92', enable);
  box(filters, 700, 536, 6, 60, 'white@0.92', enable);
  label(filters, fontExpr, '72%', 770, 536, 42, 'white', enable);
}

function drawCreatorSystem(filters, fontExpr, enable) {
  const labels = ['PROMISE', 'SERIES', 'CTA'];
  labels.forEach((value, index) => {
    const x = 135 + index * 275;
    box(filters, x, 500, 235, 145, index === 1 ? '0x17345F@0.90' : '0x08111F@0.72', enable);
    box(filters, x, 500, 235, 6, '0x5B8CFF@0.95', enable);
    label(filters, fontExpr, value, x + (value === 'PROMISE' ? 34 : 57), 555, 31, 'white', enable);
  });
}

function drawBrandCard(filters, fontExpr, enable) {
  box(filters, 160, 485, 760, 190, '0x08111F@0.72', enable);
  box(filters, 160, 485, 7, 190, '0x5B8CFF@0.95', enable);
  label(filters, fontExpr, 'BRAND READY', 215, 520, 30, 'white@0.72', enable);
  label(filters, fontExpr, 'TRUST  +  FIT  +  PROOF', 215, 582, 39, 'white', enable);
}

function drawPrimaryProp(filters, fontExpr, prop, enable) {
  if (prop === 'views-vs-follows') return drawViewsVsFollows(filters, fontExpr, enable);
  if (prop === 'retention-graph') return drawRetention(filters, fontExpr, enable);
  if (prop === 'conversion-funnel') return drawFunnel(filters, fontExpr, enable);
  if (prop === 'hook-meter') return drawHookMeter(filters, fontExpr, enable);
  if (prop === 'brand-card') return drawBrandCard(filters, fontExpr, enable);
  return drawCreatorSystem(filters, fontExpr, enable);
}

function propFilters(plan = {}) {
  const filters = [];
  const font = pipeline.findCaptionFont();
  const fontExpr = font ? `fontfile='${escPath(font)}':` : '';

  for (const scene of plan.scenes || []) {
    const story = scene.characterStory;
    if (!story || scene.isBrandCta) continue;
    const s = Number(scene.start || 0).toFixed(2);
    const e = Number(scene.end || plan.durationSec || 30).toFixed(2);
    const enable = `enable='between(t,${s},${e})'`;

    drawPrimaryProp(filters, fontExpr, story.prop, enable);

    if (story.type === 'devil-interruption') {
      box(filters, 430, 735, 220, 86, '0xB91C1C@0.96', enable);
      label(filters, fontExpr, 'SKIP', 486, 750, 46, 'white', enable);
      label(filters, fontExpr, 'THE LEAK STARTS HERE', 340, 842, 26, '0xFF9A9A', enable);
    }
    if (story.type === 'metric-consequence') {
      box(filters, 455, 732, 170, 6, '0xEF4444@0.94', enable);
      box(filters, 535, 700, 10, 74, '0xEF4444@0.94', enable);
      label(filters, fontExpr, 'LOST FOLLOW', 420, 790, 27, '0xFF8A8A', enable);
    }
    if (story.type === 'doctor-diagnosis') {
      box(filters, 150, 432, 780, 5, '0x5B8CFF@0.95', enable);
      label(filters, fontExpr, 'ELEVATE DIAGNOSIS', 367, 445, 27, '0xB8CEFF', enable);
      label(filters, fontExpr, story.prop === 'retention-graph' ? 'RETENTION LEAK' : 'NO REASON TO RETURN', story.prop === 'retention-graph' ? 395 : 318, 740, 31, 'white@0.88', enable);
    }
    if (story.type === 'story-explanation') {
      label(filters, fontExpr, 'BUILD A REASON TO RETURN', 320, 730, 29, '0xB8CEFF', enable);
    }
    if (story.type === 'doctor-prescription') {
      box(filters, 150, 432, 780, 5, '0x5B8CFF@0.95', enable);
      label(filters, fontExpr, 'ELEVATE PRESCRIPTION', 350, 445, 27, '0xB8CEFF', enable);
      label(filters, fontExpr, 'PROMISE  >  SERIES  >  CTA', 303, 730, 31, 'white@0.90', enable);
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
  return validSpriteMap(options.characterSpritePaths, cast);
}

function backgroundFilter() {
  return '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,boxblur=8:2,eq=brightness=-0.07:saturation=0.56:contrast=1.04,drawbox=x=0:y=0:w=iw:h=ih:color=0x050811@0.27:t=fill[base]';
}

function overlayChain(filters, cast, sourceLabels) {
  let previous = '[base]';
  cast.forEach((item, i) => {
    const target = targetPosition(item);
    filters.push(`${sourceLabels[i]}scale=-2:${target.height}:flags=lanczos,format=rgba[char${i}]`);
    const out = `[cv${i}]`;
    const enable = `enable='between(t,${item.start.toFixed(3)},${item.end.toFixed(3)})'`;
    filters.push(`${previous}[char${i}]overlay=x='${overlayX(item, target)}':y='${overlayY(item, target)}':${enable}:eval=frame${out}`);
    previous = out;
  });
  return previous;
}

function renderWithFinalLineup(videoPath, output, plan, cast, lineupPath) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath, '-loop', '1', '-framerate', '30', '-i', lineupPath];
  const filters = [backgroundFilter()];
  filters.push(`[1:v]scale=2048:682:flags=lanczos,format=rgba,setsar=1,split=${cast.length}${cast.map((_, i) => `[sheet${i}]`).join('')}`);
  const sourceLabels = [];
  cast.forEach((item, index) => {
    const crop = universe.FINAL_LINEUP_CROPS[item.characterId];
    if (!crop) throw new Error(`No approved final-lineup crop exists for ${item.characterId}.`);
    filters.push(`[sheet${index}]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},format=rgba,setpts=PTS-STARTPTS[actor${index}]`);
    sourceLabels.push(`[actor${index}]`);
  });
  const previous = overlayChain(filters, cast, sourceLabels);
  const props = propFilters(plan);
  filters.push(props.length ? `${previous}${props.join(',')}[vout]` : `${previous}null[vout]`);
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-an',
    '-t', Number(plan.durationSec || 30).toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', output
  );
  pipeline.run('ffmpeg', args, { timeoutMs: 360000 });
  return { assetMode: 'approved-final-lineup', finalLineupReady: true };
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
  return { assetMode: 'test-transparent-sprites', finalLineupReady: false };
}

function apply(videoPath, result, plan, options = {}) {
  if (options.characters === false) return { path: videoPath, meta: { applied: false, reason: 'disabled' } };
  const cast = appearances(plan);
  if (!cast.length) return { path: videoPath, meta: { applied: false, reason: 'no-character-story-beats' } };

  const root = result?.paths?.dir || path.dirname(videoPath);
  const tempDir = path.join(root, 'finish-temp');
  fs.mkdirSync(tempDir, { recursive: true });
  const output = path.join(tempDir, 'character-universe.mp4');

  const finalLineup = options.characterFinalLineupPath || universe.ensureFinalLineup();
  let renderMeta;
  let sourcePath = null;
  if (finalLineup && fs.existsSync(finalLineup)) {
    sourcePath = path.resolve(finalLineup);
    renderMeta = renderWithFinalLineup(videoPath, output, plan, cast, sourcePath);
  } else {
    // Explicit synthetic sprites remain available only for render-level tests.
    const testSpriteMap = spriteMapFor(cast, options);
    if (!testSpriteMap) {
      return { path: videoPath, meta: { applied: false, reason: 'approved-final-transparent-lineup-missing', required: true } };
    }
    renderMeta = renderWithSprites(videoPath, output, plan, cast, testSpriteMap);
  }

  const verified = pipeline.verifyOutput(output);
  return {
    path: output,
    meta: {
      applied: true,
      engine: 'elevate-character-universe-v4',
      finalLineupPath: sourcePath,
      finalLineupReady: renderMeta.finalLineupReady,
      assetMode: renderMeta.assetMode,
      appearances: cast.length,
      sceneCoverage: new Set(cast.map((item) => item.sceneIndex)).size,
      castUsed: [...new Set(cast.map((item) => item.characterId))],
      storyModes: [...new Set((plan.scenes || []).map((scene) => scene.characterStory?.type).filter(Boolean))],
      storyStages: [...new Set((plan.scenes || []).map((scene) => scene.characterStory?.stage).filter(Boolean))],
      propModes: [...new Set((plan.scenes || []).map((scene) => scene.characterStory?.prop).filter(Boolean))],
      activeRoleEngine: true,
      largeCharacterStaging: true,
      stockRole: 'soft-background-texture-only',
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
    finalLineupReady: universeStatus.finalLineupReady,
    finalLineupPath: universeStatus.finalLineupPath,
    renderer: universeStatus.finalLineupReady
      ? 'FFmpeg approved transparent-lineup stage + active character roles + story props + motion'
      : 'blocked until approved transparent final lineup is installed',
    lightweight: true,
    characterPrimary: true,
    activeRoleEngine: true,
    largeCharacterStaging: true,
    stockRole: 'soft-background-texture-only',
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
  renderWithFinalLineup,
  apply,
  status,
};
