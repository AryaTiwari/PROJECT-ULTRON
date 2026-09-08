const fs = require('fs');
const path = require('path');
const pipeline = require('./reel-pipeline');

const LAYOUT = Object.freeze({
  left: 120,
  right: 120,
  top: 235,
  bottom: 360,
  headlineY: 270,
  replacementTextY: 300,
  accentY: 430,
  ctaBrandY: 285,
  ctaOfferY: 405,
  ctaUrlY: 700,
});

function clean(value) {
  return String(value || '').normalize('NFKC').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function trimWords(value, maxWords = 5) {
  return clean(value).split(/\s+/).filter(Boolean).slice(0, maxWords).join(' ');
}

function supportText(scene) {
  const explicit = clean(scene?.subText);
  if (explicit) return trimWords(explicit, 5);
  return trimWords(scene?.narration, 5);
}

function writeText(tempDir, name, value) {
  const file = path.join(tempDir, `${name}.txt`);
  fs.writeFileSync(file, String(value || ''), 'utf8');
  return file;
}

function textFilter(font, textFile, options = {}) {
  const start = Number(options.start || 0);
  const end = Number(options.end || start + 1);
  return [
    `drawtext=fontfile='${pipeline.ffmpegPath ? pipeline.ffmpegPath(font) : String(font).replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:').replace(/'/g, "\\'")}'`,
    `textfile='${String(textFile).replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:').replace(/'/g, "\\'")}'`,
    `fontsize=${Number(options.fontSize || 60)}`,
    `fontcolor=${options.fontColor || 'white'}`,
    `borderw=${Number(options.borderWidth ?? 2)}`,
    `bordercolor=${options.borderColor || 'black@0.78'}`,
    `shadowcolor=${options.shadowColor || 'black@0.62'}`,
    `shadowx=${Number(options.shadowX ?? 2)}`,
    `shadowy=${Number(options.shadowY ?? 3)}`,
    'box=0',
    `line_spacing=${Number(options.lineSpacing || 6)}`,
    'fix_bounds=1',
    'x=(w-text_w)/2',
    `y=${Number(options.y || LAYOUT.headlineY)}`,
    `enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'`,
  ].join(':');
}

function sceneHeadline(scene, plan, index) {
  const raw = pipeline.captionText(scene, plan, index);
  return pipeline.wrapText(raw, index === 0 ? 17 : 19, 2);
}

function apply(videoPath, plan, tempDir) {
  const font = pipeline.findCaptionFont();
  if (!font) return { path: videoPath, captionsApplied: false, safeZoneApplied: false, reason: 'caption-font-not-found' };
  const filters = [];
  const overlayFiles = [];

  for (const [index, scene] of (plan.scenes || []).entries()) {
    const start = Math.max(0, Number(scene.start || 0));
    const end = Math.max(start + 0.2, Number(scene.end || plan.durationSec || 30));

    if (scene.isBrandCta) {
      filters.push(`drawbox=x=0:y=0:w=iw:h=ih:color=0x030712@0.40:t=fill:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'`);
      const brandFile = writeText(tempDir, `character-cta-brand-${index}`, 'ELEVATE OS');
      const offerFile = writeText(tempDir, `character-cta-offer-${index}`, 'BOOK YOUR FREE\nSTRATEGY SESSION');
      const urlFile = writeText(tempDir, `character-cta-url-${index}`, 'elevateos.in');
      overlayFiles.push(brandFile, offerFile, urlFile);
      filters.push(textFilter(font, brandFile, { start, end, y: LAYOUT.ctaBrandY, fontSize: 38, borderWidth: 0, fontColor: '0xB8CEFF' }));
      filters.push(textFilter(font, offerFile, { start, end, y: LAYOUT.ctaOfferY, fontSize: 64, borderWidth: 2, lineSpacing: 8 }));
      filters.push(`drawbox=x=350:y=645:w=380:h=5:color=0x5B8CFF@0.95:t=fill:enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'`);
      filters.push(textFilter(font, urlFile, { start, end, y: LAYOUT.ctaUrlY, fontSize: 43, borderWidth: 1, fontColor: 'white@0.94' }));
      continue;
    }

    const headline = sceneHeadline(scene, plan, index);
    if (!headline) continue;
    const duration = end - start;
    const headlineEnd = Math.min(end - 0.25, start + Math.min(1.45, Math.max(1.05, duration * 0.34)));
    const headlineFile = writeText(tempDir, `character-headline-${index}`, headline);
    overlayFiles.push(headlineFile);
    filters.push(textFilter(font, headlineFile, {
      start,
      end: headlineEnd,
      y: LAYOUT.headlineY,
      fontSize: index === 0 ? 70 : 60,
      borderWidth: 2,
      shadowX: 3,
      shadowY: 4,
      lineSpacing: 6,
    }));
    filters.push(`drawbox=x=430:y=${LAYOUT.accentY}:w=220:h=5:color=0x5B8CFF@0.94:t=fill:enable='between(t,${start.toFixed(2)},${headlineEnd.toFixed(2)})'`);

    const support = supportText(scene);
    if (support && headlineEnd + 0.10 < end) {
      const supportFile = writeText(tempDir, `character-support-${index}`, pipeline.wrapText(support, 28, 1));
      overlayFiles.push(supportFile);
      filters.push(textFilter(font, supportFile, {
        start: headlineEnd + 0.10,
        end,
        y: LAYOUT.replacementTextY,
        fontSize: 46,
        borderWidth: 2,
        shadowX: 2,
        shadowY: 3,
        fontColor: 'white@0.94',
      }));
    }
  }

  if (!filters.length) return { path: videoPath, captionsApplied: false, safeZoneApplied: true, reason: 'no-character-text' };
  const output = path.join(tempDir, 'character-editorial-polish.mp4');
  try {
    pipeline.run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath,
      '-vf', filters.join(','), '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
    ], { timeoutMs: 300000 });
    return {
      path: output,
      captionsApplied: true,
      safeZoneApplied: true,
      font,
      overlayFiles: overlayFiles.length,
      visualStyle: 'character-editorial-v1',
      textBoxes: false,
      headlineSubtitleOverlapAvoided: true,
      editorialTopAligned: true,
      eyeLevelAligned: true,
      headlineY: LAYOUT.headlineY,
      subtitleY: LAYOUT.replacementTextY,
      textSafeTop: LAYOUT.top,
      textSafeLeft: LAYOUT.left,
      textSafeRight: LAYOUT.right,
      characterZoneStartsAt: 860,
      brandCtaVersion: 'elevate-character-book-now-v2',
      maxHeadlineWords: 5,
      maxSubtitleWords: 5,
      replacementCaptionMode: true,
    };
  } catch (error) {
    return { path: videoPath, captionsApplied: false, safeZoneApplied: false, reason: error.message };
  }
}

module.exports = {
  LAYOUT,
  clean,
  trimWords,
  supportText,
  textFilter,
  sceneHeadline,
  apply,
};
