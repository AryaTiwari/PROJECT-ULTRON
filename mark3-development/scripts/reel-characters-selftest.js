const fs = require('fs');
const os = require('os');
const path = require('path');
const universe = require('../core/elevate-character-universe');
const renderer = require('../core/elevate-character-renderer');
const pipeline = require('../core/reel-pipeline');
const factory = require('../core/reel-factory');

function assert(condition, message) { if (!condition) throw new Error(message); }

function syntheticSprite(file, color) {
  pipeline.run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=black@0.0:s=220x620:r=1:d=0.1,format=rgba,drawbox=x=38:y=28:w=144:h=552:color=${color}@1:t=fill`,
    '-frames:v', '1', file,
  ], { timeoutMs: 30000 });
  assert(fs.existsSync(file) && fs.statSync(file).size > 1000, `Synthetic character sprite failed: ${file}`);
}

function realFfmpegCharacterRenderTest() {
  if (!factory.ffmpegStatus().available) {
    if (process.env.CI) throw new Error('CI Reel acceptance requires FFmpeg, but FFmpeg is unavailable.');
    console.log('ULTRON Elevate Character render smoke skipped locally: FFmpeg unavailable in this environment.');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-character-render-'));
  const background = path.join(root, 'background.mp4');
  pipeline.run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=2.8',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', background,
  ], { timeoutMs: 120000 });

  const colors = {
    gym_creator: '0x2563EB',
    fashion_creator: '0xEC4899',
    ugc_creator: '0xF59E0B',
    info_creator: '0x6B7280',
    retention_devil: '0xDC2626',
    content_doctor_female: '0xDB2777',
    content_doctor_male: '0x0284C7',
  };
  const spriteMap = {};
  for (const id of Object.keys(universe.CHARACTERS)) {
    const file = path.join(root, `${id}.png`);
    syntheticSprite(file, colors[id]);
    spriteMap[id] = file;
  }

  const plan = {
    durationSec: 2.8,
    scenes: [
      { index:1,start:0,end:0.4,characterStory:{type:'creator-hook',characters:['info_creator'],expressions:['confident'],prop:'hook-meter',motion:'creator-pop'} },
      { index:2,start:0.4,end:0.8,characterStory:{type:'devil-interruption',characters:['info_creator','retention_devil'],expressions:['confused','smug'],prop:'views-vs-follows',motion:'devil-ambush'} },
      { index:3,start:0.8,end:1.2,characterStory:{type:'metric-consequence',characters:['retention_devil','info_creator'],expressions:['scheming','frustrated'],prop:'retention-graph',motion:'metric-attack'} },
      { index:4,start:1.2,end:1.6,characterStory:{type:'doctor-diagnosis',characters:['info_creator','content_doctor_female'],expressions:['concerned','analytical'],prop:'conversion-funnel',motion:'scanner-diagnosis'} },
      { index:5,start:1.6,end:2.0,characterStory:{type:'story-explanation',characters:['info_creator','content_doctor_female'],expressions:['thinking','confident'],prop:'content-pillars',motion:'panel-explain'} },
      { index:6,start:2.0,end:2.4,characterStory:{type:'doctor-prescription',characters:['content_doctor_male','info_creator','retention_devil'],expressions:['confident','motivated','shocked'],prop:'brand-card',motion:'prescription-reveal'} },
      { index:7,start:2.4,end:2.8,isBrandCta:true,characterStory:{type:'elevate-close',characters:['content_doctor_female','content_doctor_male'],expressions:['confident','approving'],prop:'cta-button',motion:'doctor-close'} },
    ],
  };
  const rendered = renderer.apply(background, { paths: { dir: root } }, plan, { characterSpritePaths: spriteMap, characters: true });
  assert(rendered.meta?.applied === true, `Real character render must succeed: ${rendered.meta?.reason || 'unknown failure'}`);
  assert(rendered.meta?.assetMode === 'transparent-sprites', 'Real render smoke must exercise transparent sprite mode.');
  assert(rendered.meta?.ffmpegTextExpansion === 'none', 'Literal drawtext expansion must remain disabled.');
  assert(rendered.meta?.sceneCoverage === 7, 'Real render smoke must cover all seven story scenes.');
  const verified = pipeline.verifyOutput(rendered.path);
  assert(verified.width === 1080 && verified.height === 1920, 'Character render smoke output must remain 1080x1920.');
  const filters = renderer.propFilters(plan).join(',');
  assert(filters.includes("text='72%'"), 'Regression smoke must include the literal 72% graphic that previously crashed FFmpeg.');
  assert(filters.includes('expansion=none'), 'Every character-story label must disable FFmpeg text expansion.');
  fs.rmSync(root, { recursive: true, force: true });
}

(() => {
  const ids = Object.keys(universe.CHARACTERS);
  assert(ids.length === 7, 'Elevate character universe must contain exactly seven canonical actors.');
  for (const id of ['gym_creator','fashion_creator','ugc_creator','info_creator','retention_devil','content_doctor_female','content_doctor_male']) {
    assert(ids.includes(id), `Missing canonical Elevate actor: ${id}`);
  }
  assert(/not the Instagram algorithm/i.test(universe.CHARACTERS.retention_devil.role), 'Retention Devil must represent creator mistakes/drop-off, not the Instagram algorithm.');
  assert(universe.creatorForBrief('fitness creator retention problem') === 'gym_creator', 'Fitness topics must route to the gym creator.');
  assert(universe.creatorForBrief('fashion creator brand positioning') === 'fashion_creator', 'Fashion topics must route to the fashion creator.');
  assert(universe.creatorForBrief('UGC skincare product review growth') === 'ugc_creator', 'UGC/skincare topics must route to the UGC creator.');
  assert(universe.creatorForBrief('finance creator gets views but no followers') === 'info_creator', 'General information topics must route to the info creator.');

  const plan = {
    durationSec: 30,
    scenes: [
      { index:1,start:0,end:4,purpose:'Pattern interrupt',narration:'Thousands of views can still leave you with weak follower conversion.' },
      { index:2,start:4,end:8,purpose:'Context',narration:'The viewer enjoyed one post but never learned why to return.' },
      { index:3,start:8,end:13,purpose:'Consequence',narration:'Weak return signals let the retention problem keep stealing loyalty.' },
      { index:4,start:13,end:18,purpose:'Diagnosis',narration:'The real bottleneck is an unclear repeatable creator promise.' },
      { index:5,start:18,end:25,purpose:'Action',narration:'Build repeatable pillars with a stronger hook and next action.' },
      { index:6,start:25,end:30,purpose:'Brand CTA',narration:'Book your free strategy session with Elevate OS now.',isBrandCta:true },
    ],
  };
  const decorated = universe.decoratePlan(plan, 'why finance creators get views but fail to convert them into loyal followers');
  assert(decorated.characterUniverse?.required === true, 'Elevate character universe must be mandatory on Elevate Reels.');
  assert(decorated.characterUniverse?.genericHumanReplacementAllowed === false, 'Random stock humans must not replace the canonical cast.');
  assert(decorated.scenes.every((scene) => scene.characterStory?.characters?.length), 'Every Reel scene must have a character story beat.');
  const cast = new Set(decorated.scenes.flatMap((scene) => scene.characterStory.characters));
  assert(cast.has('info_creator'), 'Creator archetype must remain present through the storyline.');
  assert(cast.has('retention_devil'), 'Retention Devil must appear in the problem/conflict storyline.');
  assert(cast.has('content_doctor_female'), 'Female Elevate doctor must appear in diagnosis/fix scenes.');
  assert(cast.has('content_doctor_male'), 'Male Elevate doctor must appear in prescription/CTA scenes.');
  assert(decorated.scenes[1].characterStory.type === 'devil-interruption', 'Second beat must introduce the Retention Devil conflict.');
  assert(decorated.scenes[3].characterStory.type === 'doctor-diagnosis', 'Diagnosis beat must introduce an Elevate doctor.');
  assert(decorated.scenes[decorated.scenes.length - 1].characterStory.type === 'elevate-close', 'Final beat must close with Elevate doctors.');

  const appearances = renderer.appearances(decorated);
  assert(appearances.length >= decorated.scenes.length, 'Character renderer must cover every storyline scene.');
  assert(new Set(appearances.map((item) => item.sceneIndex)).size === decorated.scenes.length, 'Character renderer must cover every scene index.');
  const state = renderer.status();
  assert(state.characterPrimary === true, 'Characters must be the primary visual identity.');
  assert(state.stockRole === 'blurred-background-texture-only', 'Stock footage must be reduced to blurred background texture only.');
  assert(state.genericSaaSPanelsDisabled === true, 'Generic SaaS metric panels must be disabled on character-universe Reels.');
  assert(state.safeLiteralDrawtext === true, 'Character renderer must explicitly protect literal FFmpeg drawtext content.');
  assert(renderer.escapeDrawtextText("72%: creator's signal") === "72%\\: creator\\'s signal", 'FFmpeg text escaping must preserve literal percent while escaping filter syntax.');

  realFfmpegCharacterRenderTest();
  console.log('ULTRON Elevate Character Universe self-test passed: seven canonical actors, transparent sprite compositor, mandatory real FFmpeg literal-percent regression render, Retention Devil conflict, doctor diagnosis/prescription, every-scene continuity and blurred-background-only stock policy validated.');
})();
