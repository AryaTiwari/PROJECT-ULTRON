const fs = require('fs');
const path = require('path');
const universe = require('./elevate-character-universe');
const pipeline = require('./reel-pipeline');

function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function esc(value) { return String(value || '').replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:').replace(/'/g, "\\'"); }

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
  if (item.slotCount >= 3) return 500;
  if (item.slotCount === 2) return item.characterId === 'retention_devil' ? 620 : 590;
  return item.characterId === 'retention_devil' ? 720 : 660;
}

function targetPosition(item) {
  const height = characterHeight(item);
  if (item.slotCount === 1) return { x: 540, y: 820, anchor: 'center', height };
  if (item.slotCount === 2) return item.slot === 0
    ? { x: 65, y: 900, anchor: 'left', height }
    : { x: 1015, y: 900, anchor: 'right', height };
  if (item.slot === 0) return { x: 30, y: 990, anchor: 'left', height };
  if (item.slot === 1) return { x: 540, y: 900, anchor: 'center', height };
  return { x: 1050, y: 990, anchor: 'right', height };
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

function propFilters(plan = {}) {
  const filters = [];
  const font = pipeline.findCaptionFont();
  const fontExpr = font ? `fontfile='${esc(font)}':` : '';
  for (const scene of plan.scenes || []) {
    const story = scene.characterStory;
    if (!story) continue;
    const s = Number(scene.start || 0).toFixed(2);
    const e = Number(scene.end || plan.durationSec || 30).toFixed(2);
    const enable = `enable='between(t,${s},${e})'`;
    if (story.type === 'devil-interruption' || story.type === 'metric-consequence') {
      filters.push(`drawbox=x=430:y=1110:w=220:h=94:color=0xB91C1C@0.92:t=fill:${enable}`);
      filters.push(`drawtext=${fontExpr}text='SKIP':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=1128:${enable}`);
      filters.push(`drawbox=x=466:y=1240:w=148:h=12:color=0xEF4444@0.9:t=fill:${enable}`);
      filters.push(`drawbox=x=530:y=1240:w=18:h=132:color=0xEF4444@0.9:t=fill:${enable}`);
    }
    if (story.type === 'doctor-diagnosis') {
      filters.push(`drawbox=x=160:y=1040:w=760:h=5:color=0x5B8CFF@0.95:t=fill:${enable}`);
      filters.push(`drawbox=x=160:y=1035+mod(t*180\,250):w=760:h=4:color=white@0.65:t=fill:${enable}`);
    }
    if (story.type === 'doctor-prescription') {
      filters.push(`drawbox=x=320:y=1080:w=440:h=230:color=black@0.56:t=fill:${enable}`);
      filters.push(`drawbox=x=320:y=1080:w=7:h=230:color=0x5B8CFF@0.95:t=fill:${enable}`);
      filters.push(`drawtext=${fontExpr}text='HOOK  >  VALUE  >  CTA':fontsize=31:fontcolor=white:x=365:y=1165:${enable}`);
    }
    if (scene.isBrandCta) {
      filters.push(`drawbox=x=110:y=1030:w=860:h=5:color=0x5B8CFF@0.9:t=fill:${enable}`);
    }
  }
  return filters;
}

function apply(videoPath, result, plan, options = {}) {
  if (options.characters === false) return { path: videoPath, meta: { applied: false, reason: 'disabled' } };
  const reference = universe.ensureReference();
  if (!reference) return { path: videoPath, meta: { applied: false, reason: 'character-reference-missing', required: true } };
  const cast = appearances(plan);
  if (!cast.length) return { path: videoPath, meta: { applied: false, reason: 'no-character-story-beats' } };

  const root = result?.paths?.dir || path.dirname(videoPath);
  const tempDir = path.join(root, 'finish-temp');
  fs.mkdirSync(tempDir, { recursive: true });
  const output = path.join(tempDir, 'character-universe.mp4');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath, '-loop', '1', '-framerate', '30', '-i', reference];
  const filters = [];

  // Dim and unify whatever background source was selected. The cast and explanatory
  // graphics should be the visual identity; stock footage is only texture behind it.
  filters.push(`[0:v]eq=brightness=-0.10:saturation=0.72:contrast=1.04,drawbox=x=0:y=0:w=iw:h=ih:color=0x050811@0.22:t=fill[base]`);
  filters.push(`[1:v]scale=1536:865,split=${cast.length}${cast.map((_, i) => `[sheet${i}]`).join('')}`);

  cast.forEach((item, i) => {
    const character = universe.CHARACTERS[item.characterId];
    const crop = character.crop;
    const target = targetPosition(item);
    filters.push(`[sheet${i}]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},colorkey=0xF4F4F4:0.035:0.02,format=rgba,scale=-2:${target.height}[char${i}]`);
  });

  let previous = '[base]';
  cast.forEach((item, i) => {
    const target = targetPosition(item);
    const label = `[cv${i}]`;
    const enable = `enable='between(t,${item.start.toFixed(3)},${item.end.toFixed(3)})'`;
    filters.push(`${previous}[char${i}]overlay=x='${overlayX(item, target)}':y='${overlayY(item, target)}':${enable}:eval=frame${label}`);
    previous = label;
  });

  const props = propFilters(plan);
  if (props.length) {
    filters.push(`${previous}${props.join(',')}[vout]`);
  } else {
    filters.push(`${previous}null[vout]`);
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-an',
    '-t', Number(plan.durationSec || 30).toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', output
  );
  pipeline.run('ffmpeg', args, { timeoutMs: 360000 });
  const verified = pipeline.verifyOutput(output);
  return {
    path: output,
    meta: {
      applied: true,
      engine: 'elevate-character-universe-v1',
      referencePath: reference,
      appearances: cast.length,
      sceneCoverage: new Set(cast.map((item) => item.sceneIndex)).size,
      castUsed: [...new Set(cast.map((item) => item.characterId))],
      storyModes: [...new Set((plan.scenes || []).map((scene) => scene.characterStory?.type).filter(Boolean))],
      stockRole: 'background-support-only',
      genericHumanReplacementAllowed: false,
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
    renderer: 'FFmpeg crop + keyed character overlays + motion + storyline props',
    lightweight: true,
    characterPrimary: true,
    stockRole: 'background-support-only',
  };
}

module.exports = {
  appearances,
  characterHeight,
  targetPosition,
  overlayX,
  overlayY,
  propFilters,
  apply,
  status,
};
