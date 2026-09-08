const fs = require('fs');
const os = require('os');
const path = require('path');
const pipeline = require('../core/reel-pipeline');
const renderer = require('../core/elevate-character-renderer');
const universe = require('../core/elevate-character-universe');
const factory = require('../core/reel-factory');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeSprite(file, color) {
  pipeline.run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black@0.0:s=240x680:r=1:d=0.1,format=rgba,drawbox=x=34:y=24:w=172:h=620:color=${color}@1:t=fill`,
    '-frames:v', '1', file,
  ], { timeoutMs: 30000 });
  assert(fs.existsSync(file) && fs.statSync(file).size > 1000, `Could not create acceptance sprite ${file}`);
}

(() => {
  assert(factory.ffmpegStatus().available, '30-second Reel visual acceptance requires FFmpeg.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-reel-30s-'));
  try {
    const background = path.join(root, 'background.mp4');
    pipeline.run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x101827:s=1080x1920:r=30:d=30',
      '-vf', 'drawbox=x=0:y=0:w=iw:h=ih:color=0x172554@0.22:t=fill',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '29', '-pix_fmt', 'yuv420p', background,
    ], { timeoutMs: 180000 });

    const colors = {
      gym_creator: '0x2563EB',
      fashion_creator: '0xEC4899',
      ugc_creator: '0xF59E0B',
      info_creator: '0x64748B',
      retention_devil: '0xDC2626',
      content_doctor_female: '0xDB2777',
      content_doctor_male: '0x0284C7',
    };
    const spriteMap = {};
    for (const id of Object.keys(universe.CHARACTERS)) {
      const file = path.join(root, `${id}.png`);
      makeSprite(file, colors[id]);
      spriteMap[id] = file;
    }

    const plan = {
      durationSec: 30,
      scenes: [
        { index:1,start:0,end:3.8,characterStory:{type:'creator-hook',characters:['info_creator'],expressions:['confident'],prop:'hook-meter',motion:'creator-pop'} },
        { index:2,start:3.8,end:7.8,characterStory:{type:'devil-interruption',characters:['info_creator','retention_devil'],expressions:['confused','smug'],prop:'views-vs-follows',motion:'devil-ambush'} },
        { index:3,start:7.8,end:12.2,characterStory:{type:'metric-consequence',characters:['retention_devil','info_creator'],expressions:['scheming','frustrated'],prop:'retention-graph',motion:'metric-attack'} },
        { index:4,start:12.2,end:16.7,characterStory:{type:'doctor-diagnosis',characters:['info_creator','content_doctor_female'],expressions:['concerned','analytical'],prop:'conversion-funnel',motion:'scanner-diagnosis'} },
        { index:5,start:16.7,end:21.2,characterStory:{type:'story-explanation',characters:['info_creator','content_doctor_female'],expressions:['thinking','confident'],prop:'content-pillars',motion:'panel-explain'} },
        { index:6,start:21.2,end:25.8,characterStory:{type:'doctor-prescription',characters:['content_doctor_male','info_creator','retention_devil'],expressions:['confident','motivated','shocked'],prop:'brand-card',motion:'prescription-reveal'} },
        { index:7,start:25.8,end:30,isBrandCta:true,characterStory:{type:'elevate-close',characters:['content_doctor_female','content_doctor_male'],expressions:['confident','approving'],prop:'cta-button',motion:'doctor-close'} },
      ],
    };

    const rendered = renderer.apply(background, { paths: { dir: root } }, plan, {
      characters: true,
      characterSpritePaths: spriteMap,
    });
    assert(rendered.meta?.applied === true, `30-second character compositor failed: ${rendered.meta?.reason || 'unknown failure'}`);
    assert(rendered.meta?.assetMode === 'transparent-sprites', '30-second acceptance must use transparent sprite mode.');
    assert(rendered.meta?.sceneCoverage === 7, '30-second acceptance must cover all seven story scenes.');
    assert(rendered.meta?.ffmpegTextExpansion === 'none', '30-second acceptance must keep FFmpeg text expansion disabled.');
    assert(rendered.meta?.castUsed?.includes('retention_devil'), '30-second acceptance must include Retention Devil.');
    assert(rendered.meta?.castUsed?.includes('content_doctor_female'), '30-second acceptance must include the female Elevate doctor.');
    assert(rendered.meta?.castUsed?.includes('content_doctor_male'), '30-second acceptance must include the male Elevate doctor.');
    assert(rendered.meta?.castUsed?.includes('info_creator'), '30-second acceptance must include the creator archetype.');

    const verified = pipeline.verifyOutput(rendered.path);
    assert(verified.width === 1080 && verified.height === 1920, `30-second acceptance output dimensions are wrong: ${verified.width}x${verified.height}`);
    assert(Number(verified.durationSec || 0) >= 29.8 && Number(verified.durationSec || 0) <= 30.2, `30-second acceptance duration is wrong: ${verified.durationSec}`);
    assert(Number(verified.bytes || 0) > 300000, `30-second acceptance output is unexpectedly small: ${verified.bytes} bytes`);

    const literalFilters = renderer.propFilters(plan).join(',');
    assert(literalFilters.includes("text='72%'"), '30-second acceptance did not exercise the literal 72% hook meter.');
    assert(literalFilters.includes('expansion=none'), '30-second acceptance lost FFmpeg literal-text protection.');

    console.log(`ULTRON 30-second Elevate visual acceptance passed: ${verified.width}x${verified.height}, ${Number(verified.durationSec).toFixed(2)}s, transparent sprites, seven-scene character storyline, literal 72% hook meter, Devil conflict, doctor diagnosis/prescription and CTA rendered successfully.`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
