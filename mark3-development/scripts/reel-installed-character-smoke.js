const fs = require('fs');
const os = require('os');
const path = require('path');
const universe = require('../core/elevate-character-universe');
const renderer = require('../core/elevate-character-renderer');
const pipeline = require('../core/reel-pipeline');
const factory = require('../core/reel-factory');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(() => {
  const status = universe.status();
  assert(factory.ffmpegStatus().available, 'FFmpeg is required for the installed character smoke test.');
  assert(status.referencePath, 'Elevate character reference sheet is not installed.');
  assert(status.spritePackReady, 'Transparent seven-character sprite pack is not ready. Run npm run reels:characters:add first.');
  assert(status.configured, `Elevate character universe is not production-ready. ${status.installHint || ''}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-installed-characters-'));
  try {
    const background = path.join(root, 'background.mp4');
    pipeline.run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x0B1020:s=1080x1920:r=30:d=4.2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '29', '-pix_fmt', 'yuv420p', background,
    ], { timeoutMs: 90000 });

    const plan = {
      durationSec: 4.2,
      scenes: [
        { index:1,start:0,end:0.6,characterStory:{type:'creator-hook',characters:['info_creator'],expressions:['confident'],prop:'hook-meter',motion:'creator-pop'} },
        { index:2,start:0.6,end:1.2,characterStory:{type:'devil-interruption',characters:['info_creator','retention_devil'],expressions:['confused','smug'],prop:'views-vs-follows',motion:'devil-ambush'} },
        { index:3,start:1.2,end:1.8,characterStory:{type:'metric-consequence',characters:['retention_devil','info_creator'],expressions:['scheming','frustrated'],prop:'retention-graph',motion:'metric-attack'} },
        { index:4,start:1.8,end:2.4,characterStory:{type:'doctor-diagnosis',characters:['info_creator','content_doctor_female'],expressions:['concerned','analytical'],prop:'conversion-funnel',motion:'scanner-diagnosis'} },
        { index:5,start:2.4,end:3.0,characterStory:{type:'story-explanation',characters:['info_creator','content_doctor_female'],expressions:['thinking','confident'],prop:'content-pillars',motion:'panel-explain'} },
        { index:6,start:3.0,end:3.6,characterStory:{type:'doctor-prescription',characters:['content_doctor_male','info_creator','retention_devil'],expressions:['confident','motivated','shocked'],prop:'brand-card',motion:'prescription-reveal'} },
        { index:7,start:3.6,end:4.2,isBrandCta:true,characterStory:{type:'elevate-close',characters:['content_doctor_female','content_doctor_male'],expressions:['confident','approving'],prop:'cta-button',motion:'doctor-close'} },
      ],
    };

    const rendered = renderer.apply(background, { paths: { dir: root } }, plan, { characters: true });
    assert(rendered.meta?.applied === true, `Installed character compositor failed: ${rendered.meta?.reason || 'unknown error'}`);
    assert(rendered.meta?.assetMode === 'transparent-sprites', `Installed character compositor used the wrong asset mode: ${rendered.meta?.assetMode}`);
    assert(rendered.meta?.spritePackReady === true, 'Renderer did not confirm the installed transparent sprite pack.');
    assert(rendered.meta?.sceneCoverage === 7, `Installed character smoke covered only ${rendered.meta?.sceneCoverage || 0}/7 scenes.`);
    assert(rendered.meta?.ffmpegTextExpansion === 'none', 'FFmpeg literal-text protection is not active.');

    const verified = pipeline.verifyOutput(rendered.path);
    assert(verified.width === 1080 && verified.height === 1920, `Installed character smoke rendered ${verified.width}x${verified.height}, expected 1080x1920.`);
    assert(Number(verified.durationSec || 0) >= 4.0, `Installed character smoke is too short: ${verified.durationSec}s.`);

    const cast = new Set(rendered.meta.castUsed || []);
    for (const id of ['info_creator', 'retention_devil', 'content_doctor_female', 'content_doctor_male']) {
      assert(cast.has(id), `Installed character smoke is missing ${id}.`);
    }

    console.log(`ULTRON installed-character smoke passed: real local sprite pack, ${verified.width}x${verified.height}, ${Number(verified.durationSec).toFixed(2)}s, all seven story beats, literal 72% graphic and recurring Elevate cast rendered successfully.`);
    console.log(`Sprite root: ${status.spriteRoot}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
