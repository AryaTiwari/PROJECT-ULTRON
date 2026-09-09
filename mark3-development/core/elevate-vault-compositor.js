const fs = require('fs');
const path = require('path');
const pipeline = require('./reel-pipeline');
const graphicsVault = require('./elevate-graphics-vault');

function exists(file) {
  try { return Boolean(file && fs.existsSync(file) && fs.statSync(file).isFile()); } catch { return false; }
}

function duration(plan) {
  return Math.max(1, Number(plan?.durationSec || 30));
}

function sceneWindow(scene, fallbackEnd) {
  const start = Math.max(0, Number(scene?.start || 0));
  const end = Math.max(start + 0.05, Number(scene?.end || fallbackEnd));
  return { start, end };
}

function addLoopImage(args, file) {
  args.push('-loop', '1', '-framerate', '30', '-i', path.resolve(file));
  return (args.filter((value) => value === '-i').length - 1);
}

function overlayEnable(start, end) {
  return `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`;
}

function preparedSceneAssets(plan = {}) {
  graphicsVault.ensure();
  return (plan.scenes || []).map((scene, index) => {
    const kit = scene.graphicsVault?.kit || graphicsVault.visualKitForScene(scene);
    const background = scene.graphicsVault?.background || graphicsVault.backgroundForScene(scene, index);
    return {
      scene,
      index,
      background,
      metrics: (kit.metrics || []).map((id) => ({ id, path: graphicsVault.asset('metrics', id) })).filter((item) => exists(item.path)),
      ui: (kit.ui || []).map((id) => ({ id, path: graphicsVault.asset('ui', id) })).filter((item) => exists(item.path)),
      fx: (kit.fx || []).map((id) => ({ id, path: graphicsVault.asset('fx', id) })).filter((item) => exists(item.path)),
      chart: kit.chart ? { id: kit.chart, path: graphicsVault.asset('charts', kit.chart) } : null,
    };
  });
}

function applyBackgrounds(videoPath, result, plan, options = {}) {
  if (options.graphicsVault === false) return { path: videoPath, meta: { applied: false, reason: 'disabled' } };
  const vault = graphicsVault.ensure();
  if (!vault.ok) throw new Error('Elevate graphics vault backgrounds could not be materialized.');
  const scenes = preparedSceneAssets(plan).filter((entry) => exists(entry.background));
  if (!scenes.length) return { path: videoPath, meta: { applied: false, reason: 'no-background-scenes' } };

  const root = result?.paths?.dir || path.dirname(videoPath);
  const tempDir = path.join(root, 'finish-temp');
  fs.mkdirSync(tempDir, { recursive: true });
  const output = path.join(tempDir, 'vault-backgrounds.mp4');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath];
  const filters = ['[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,boxblur=4:1,eq=brightness=-0.09:saturation=0.48:contrast=1.03[base]'];
  let previous = '[base]';
  const used = [];

  scenes.forEach((entry, i) => {
    const input = addLoopImage(args, entry.background);
    const assetLabel = `[bgasset${i}]`;
    const out = `[bgstage${i}]`;
    const { start, end } = sceneWindow(entry.scene, duration(plan));
    filters.push(`[${input}:v]scale=1080:1920:flags=lanczos,format=rgba,colorchannelmixer=aa=0.94,setpts=PTS-STARTPTS${assetLabel}`);
    filters.push(`${previous}${assetLabel}overlay=x=0:y=0:${overlayEnable(start, end)}:eval=frame${out}`);
    previous = out;
    used.push({ sceneIndex: entry.index, file: entry.background, start, end });
  });
  filters.push(`${previous}trim=duration=${duration(plan).toFixed(3)},setpts=PTS-STARTPTS[vout]`);
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-an',
    '-t', duration(plan).toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', output
  );
  pipeline.run('ffmpeg', args, { timeoutMs: 360000 });
  pipeline.verifyOutput(output);
  return {
    path: output,
    meta: {
      applied: true,
      engine: 'elevate-graphics-vault-backgrounds-v1',
      sceneCoverage: new Set(used.map((item) => item.sceneIndex)).size,
      assetsUsed: used,
      stockRole: 'subtle-motion-texture-under-built-in-backgrounds',
    },
  };
}

function metricPositions(count) {
  if (count <= 1) return [{ x: 155, y: 595 }];
  if (count === 2) return [{ x: 130, y: 585 }, { x: 850, y: 585 }];
  return [{ x: 100, y: 585 }, { x: 495, y: 585 }, { x: 890, y: 585 }];
}

function uiPositions(count) {
  if (count <= 1) return [{ x: 400, y: 758 }];
  return [{ x: 225, y: 758 }, { x: 575, y: 758 }];
}

function applyForegroundKit(videoPath, result, plan, options = {}) {
  if (options.graphicsVault === false) return { path: videoPath, meta: { applied: false, reason: 'disabled' } };
  const vault = graphicsVault.ensure();
  if (!vault.ok) throw new Error('Elevate graphics vault foreground kit could not be materialized.');
  const scenes = preparedSceneAssets(plan);
  const root = result?.paths?.dir || path.dirname(videoPath);
  const tempDir = path.join(root, 'finish-temp');
  fs.mkdirSync(tempDir, { recursive: true });
  const output = path.join(tempDir, 'vault-foreground.mp4');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath];
  const filters = ['[0:v]format=yuv420p,setpts=PTS-STARTPTS[base]'];
  let previous = '[base]';
  let serial = 0;
  const used = { metrics: [], ui: [], fx: [], chartsAvailable: [] };

  for (const entry of scenes) {
    const { start, end } = sceneWindow(entry.scene, duration(plan));
    const enable = overlayEnable(start, end);
    if (entry.chart && exists(entry.chart.path)) used.chartsAvailable.push({ sceneIndex: entry.index, id: entry.chart.id, file: entry.chart.path });

    const metricItems = entry.metrics.slice(0, 3);
    const metricPos = metricPositions(metricItems.length);
    metricItems.forEach((item, i) => {
      const input = addLoopImage(args, item.path);
      const src = `[vaultm${serial}]`;
      const out = `[vaultmo${serial}]`;
      filters.push(`[${input}:v]scale=92:92:flags=lanczos,format=rgba,setpts=PTS-STARTPTS${src}`);
      filters.push(`${previous}${src}overlay=x=${metricPos[i].x}:y=${metricPos[i].y}:${enable}:eval=frame${out}`);
      previous = out;
      used.metrics.push({ sceneIndex: entry.index, id: item.id, file: item.path });
      serial += 1;
    });

    const uiItems = entry.ui.slice(0, 2);
    const uiPos = uiPositions(uiItems.length);
    uiItems.forEach((item, i) => {
      const input = addLoopImage(args, item.path);
      const src = `[vaultu${serial}]`;
      const out = `[vaultuo${serial}]`;
      filters.push(`[${input}:v]scale=280:-2:flags=lanczos,format=rgba,setpts=PTS-STARTPTS${src}`);
      filters.push(`${previous}${src}overlay=x=${uiPos[i].x}:y=${uiPos[i].y}:${enable}:eval=frame${out}`);
      previous = out;
      used.ui.push({ sceneIndex: entry.index, id: item.id, file: item.path });
      serial += 1;
    });

    entry.fx.slice(0, 1).forEach((item) => {
      const input = addLoopImage(args, item.path);
      const src = `[vaultfx${serial}]`;
      const out = `[vaultfxo${serial}]`;
      filters.push(`[${input}:v]scale=92:92:flags=lanczos,format=rgba,setpts=PTS-STARTPTS${src}`);
      filters.push(`${previous}${src}overlay=x=865:y=760:${enable}:eval=frame${out}`);
      previous = out;
      used.fx.push({ sceneIndex: entry.index, id: item.id, file: item.path });
      serial += 1;
    });
  }

  filters.push(`${previous}trim=duration=${duration(plan).toFixed(3)},setpts=PTS-STARTPTS[vout]`);
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-an',
    '-t', duration(plan).toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', output
  );
  pipeline.run('ffmpeg', args, { timeoutMs: 360000 });
  pipeline.verifyOutput(output);
  return {
    path: output,
    meta: {
      applied: true,
      engine: 'elevate-graphics-vault-foreground-v1',
      metricAssetsUsed: used.metrics,
      uiAssetsUsed: used.ui,
      fxAssetsUsed: used.fx,
      chartAssetsAvailable: used.chartsAvailable,
      chartPolicy: 'available-in-vault; primitive story chart remains active until collision-safe chart migration',
      collisionSafeBands: true,
    },
  };
}

function status() {
  return {
    implemented: true,
    vault: graphicsVault.status(),
    backgrounds: 'scene-aware built-in backgrounds',
    foregrounds: 'transparent metrics + UI badges + reaction FX',
    chartPolicy: 'bundled and selectable; foreground chart migration guarded against visual collisions',
  };
}

module.exports = {
  preparedSceneAssets,
  applyBackgrounds,
  applyForegroundKit,
  status,
};
