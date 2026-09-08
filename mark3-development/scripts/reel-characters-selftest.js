const fs = require('fs');
const os = require('os');
const path = require('path');
const universe = require('../core/elevate-character-universe');
const renderer = require('../core/elevate-character-renderer');
const textLayout = require('../core/elevate-text-layout');
const pipeline = require('../core/reel-pipeline');
const factory = require('../core/reel-factory');

function assert(condition, message) { if (!condition) throw new Error(message); }

function syntheticFinalLineup(file) {
  const boxes = [
    ['0x2563EB', universe.FINAL_LINEUP_CROPS.gym_creator],
    ['0xEC4899', universe.FINAL_LINEUP_CROPS.fashion_creator],
    ['0xF59E0B', universe.FINAL_LINEUP_CROPS.ugc_creator],
    ['0x6B7280', universe.FINAL_LINEUP_CROPS.info_creator],
    ['0xDC2626', universe.FINAL_LINEUP_CROPS.retention_devil],
    ['0xDB2777', universe.FINAL_LINEUP_CROPS.content_doctor_female],
    ['0x0284C7', universe.FINAL_LINEUP_CROPS.content_doctor_male],
  ];
  const filters = ['format=rgba'];
  for (const [color, crop] of boxes) {
    filters.push(`drawbox=x=${crop.x + 18}:y=${crop.y + 18}:w=${Math.max(30, crop.w - 36)}:h=${Math.max(30, crop.h - 36)}:color=${color}@1:t=fill`);
  }
  pipeline.run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black@0.0:s=2048x682:r=1:d=0.1',
    '-vf', filters.join(','), '-frames:v', '1', file,
  ], { timeoutMs: 30000 });
  assert(fs.existsSync(file) && fs.statSync(file).size > 1000, 'Synthetic approved lineup failed to render.');
}

function acceptancePlan() {
  return {
    title: 'Views are not loyal followers',
    hook: 'Views are not loyal followers',
    durationSec: 7,
    scenes: [
      { index:1,start:0,end:1,purpose:'Pattern interrupt',onScreenText:'Views are not followers',narration:'Thousands of views can still leave you with weak follower conversion.',characterStory:{type:'creator-hook',stage:'creator-hero',characters:['info_creator'],roles:['protagonist'],expressions:['confident'],prop:'views-vs-follows',motion:'creator-pop'} },
      { index:2,start:1,end:2,purpose:'Conflict',onScreenText:'The leak starts here',narration:'The viewer watches once and the Retention Devil steals the next step.',characterStory:{type:'devil-interruption',stage:'conflict-split',characters:['info_creator','retention_devil'],roles:['protagonist','antagonist'],expressions:['confused','smug'],prop:'views-vs-follows',motion:'devil-ambush'} },
      { index:3,start:2,end:3,purpose:'Consequence',onScreenText:'Views do not convert',narration:'The funnel collapses between the view, profile visit and actual follow.',characterStory:{type:'metric-consequence',stage:'devil-dominant',characters:['info_creator','retention_devil'],roles:['reacting-protagonist','dominant-antagonist'],expressions:['frustrated','scheming'],prop:'conversion-funnel',motion:'metric-attack'} },
      { index:4,start:3,end:4,purpose:'Diagnosis',onScreenText:'Give them a reason back',narration:'Elevate diagnoses the missing reason for viewers to return tomorrow.',characterStory:{type:'doctor-diagnosis',stage:'diagnosis-split',characters:['info_creator','content_doctor_female'],roles:['patient-creator','diagnostician'],expressions:['concerned','analytical'],prop:'conversion-funnel',motion:'scanner-diagnosis'} },
      { index:5,start:4,end:5,purpose:'Explanation',onScreenText:'Build a repeatable promise',narration:'A recognizable series gives viewers a clear reason to follow.',characterStory:{type:'story-explanation',stage:'explanation-stage',characters:['info_creator','content_doctor_female'],roles:['learning-creator','guide'],expressions:['thinking','confident'],prop:'creator-system',motion:'doctor-explain'} },
      { index:6,start:5,end:6,purpose:'Action',onScreenText:'Promise series CTA',narration:'The analyst turns that promise into a repeatable series and CTA.',characterStory:{type:'doctor-prescription',stage:'prescription-stage',characters:['content_doctor_male','info_creator','retention_devil'],roles:['strategist','recovering-creator','defeated-antagonist'],expressions:['confident','motivated','shocked'],prop:'creator-system',motion:'prescription-reveal'} },
      { index:7,start:6,end:7,purpose:'Brand CTA',onScreenText:'Book your strategy session',narration:'Book your free strategy session with Elevate OS now.',isBrandCta:true,characterStory:{type:'elevate-close',stage:'cta-stage',characters:['content_doctor_female','content_doctor_male'],roles:['host-left','host-right'],expressions:['confident','approving'],prop:'cta-button',motion:'doctor-close'} },
    ],
  };
}

function realCharacterAndTextRenderTest() {
  if (!factory.ffmpegStatus().available) {
    if (process.env.CI) throw new Error('CI Reel acceptance requires FFmpeg, but FFmpeg is unavailable.');
    console.log('ULTRON Elevate Character render smoke skipped locally: FFmpeg unavailable in this environment.');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-character-v4-'));
  const background = path.join(root, 'background.mp4');
  const lineup = path.join(root, 'approved-lineup.png');
  syntheticFinalLineup(lineup);
  pipeline.run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=7',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '27', '-pix_fmt', 'yuv420p', background,
  ], { timeoutMs: 180000 });

  const plan = acceptancePlan();
  const rendered = renderer.apply(background, { paths: { dir: root } }, plan, { characterFinalLineupPath: lineup, characters: true });
  assert(rendered.meta?.applied === true, `Character render must succeed: ${rendered.meta?.reason || 'unknown failure'}`);
  assert(rendered.meta?.assetMode === 'approved-final-lineup', 'Production renderer must exercise the approved final transparent lineup path.');
  assert(rendered.meta?.finalLineupReady === true, 'Production render must confirm final lineup readiness.');
  assert(rendered.meta?.activeRoleEngine === true, 'Characters must have active story roles.');
  assert(rendered.meta?.largeCharacterStaging === true, 'Character staging must use hero-scale figures.');
  assert(rendered.meta?.ffmpegTextExpansion === 'none', 'Literal drawtext expansion must remain disabled.');
  assert(rendered.meta?.sceneCoverage === 7, 'Character render must cover all seven scenes.');
  assert(rendered.meta?.storyStages.includes('conflict-split'), 'Render metadata must include the creator-vs-Devil conflict stage.');
  assert(rendered.meta?.storyStages.includes('diagnosis-split'), 'Render metadata must include the Doctor diagnosis stage.');
  assert(rendered.meta?.storyStages.includes('prescription-stage'), 'Render metadata must include the prescription/Devil-defeat stage.');

  const polished = textLayout.apply(rendered.path, plan, root);
  assert(polished.captionsApplied === true, `Character editorial text render must succeed: ${polished.reason || 'unknown failure'}`);
  assert(polished.visualStyle === 'character-editorial-v1', 'Character Reel must use character-editorial-v1 typography.');
  assert(polished.replacementCaptionMode === true, 'Headline and support copy must replace one another instead of stacking.');
  assert(polished.headlineY >= 235 && polished.headlineY <= 360, 'Headline must stay in the clean top editorial zone.');
  assert(polished.subtitleY >= 235 && polished.subtitleY <= 390, 'Replacement support copy must stay in the top editorial zone.');
  const verified = pipeline.verifyOutput(polished.path);
  assert(verified.width === 1080 && verified.height === 1920, 'Character editorial render must remain 1080x1920.');

  const filters = renderer.propFilters(plan).join(',');
  assert(filters.includes("text='SKIP'"), 'Retention Devil conflict must visibly use the SKIP prop.');
  assert(filters.includes('NO REASON TO RETURN'), 'Doctor diagnosis must visibly own the diagnosis text.');
  assert(filters.includes('PROMISE'), 'Prescription scene must visibly use the creator system.');
  assert(!filters.includes('CREATOR SIGNAL'), 'The old generic CREATOR SIGNAL filler must never return.');
  assert(filters.includes('expansion=none'), 'Every story label must disable FFmpeg text expansion.');
  fs.rmSync(root, { recursive: true, force: true });
}

(() => {
  const ids = Object.keys(universe.CHARACTERS);
  assert(ids.length === 7, 'Elevate character universe must contain exactly seven canonical actors.');
  for (const id of ['gym_creator','fashion_creator','ugc_creator','info_creator','retention_devil','content_doctor_female','content_doctor_male']) {
    assert(ids.includes(id), `Missing canonical Elevate actor: ${id}`);
    assert(universe.FINAL_LINEUP_CROPS[id], `Missing approved final-lineup crop for ${id}`);
  }
  assert(Object.keys(universe.FINAL_LINEUP_CROPS).length === 7, 'Approved final lineup must contain exactly seven separated actor crops.');
  assert(universe.FINAL_LINEUP_CROPS.retention_devil.w >= 360, 'Retention Devil crop must preserve the complete wide wings.');
  assert(/not the Instagram algorithm/i.test(universe.CHARACTERS.retention_devil.role), 'Retention Devil must represent creator mistakes/drop-off, not the Instagram algorithm.');
  assert(universe.creatorForBrief('fitness creator retention problem') === 'gym_creator', 'Fitness topics must route to the gym creator.');
  assert(universe.creatorForBrief('fashion creator brand positioning') === 'fashion_creator', 'Fashion topics must route to the fashion creator.');
  assert(universe.creatorForBrief('UGC skincare product review growth') === 'ugc_creator', 'UGC/skincare topics must route to the UGC creator.');
  assert(universe.creatorForBrief('finance creator gets views but no followers') === 'info_creator', 'General information topics must route to the info creator.');

  const basePlan = {
    durationSec: 30,
    scenes: [
      { index:1,start:0,end:5,purpose:'Pattern interrupt',narration:'Thousands of views can still leave you with weak follower conversion.' },
      { index:2,start:5,end:10,purpose:'Context',narration:'The viewer enjoyed one post but never learned why to return.' },
      { index:3,start:10,end:15,purpose:'Consequence',narration:'Weak return signals let the retention problem keep stealing loyalty.' },
      { index:4,start:15,end:20,purpose:'Diagnosis',narration:'The real bottleneck is an unclear repeatable creator promise.' },
      { index:5,start:20,end:25,purpose:'Action',narration:'Build repeatable pillars with a stronger promise, series and next action.' },
      { index:6,start:25,end:30,purpose:'Brand CTA',narration:'Book your free strategy session with Elevate OS now.',isBrandCta:true },
    ],
  };
  const decorated = universe.decoratePlan(basePlan, 'why finance creators get views but fail to convert them into loyal followers');
  assert(decorated.characterUniverse?.version === 4, 'Character universe plan must use version 4 active-role direction.');
  assert(decorated.characterUniverse?.finalLineupRequired === true, 'Approved final transparent lineup must be mandatory.');
  assert(decorated.characterUniverse?.characterActingRequired === true, 'Character acting must be mandatory, not decorative.');
  assert(decorated.characterUniverse?.genericHumanReplacementAllowed === false, 'Random stock humans must not replace the canonical cast.');
  assert(decorated.scenes.every((scene) => scene.characterStory?.action), 'Every Reel scene must give the characters an explicit action.');
  assert(decorated.scenes[1].characterStory.stage === 'conflict-split', 'Second beat must stage the creator against the Retention Devil.');
  assert(decorated.scenes[3].characterStory.stage === 'diagnosis-split', 'Diagnosis beat must visibly stage the Elevate Doctor.');
  assert(decorated.scenes[decorated.scenes.length - 2].characterStory.stage === 'prescription-stage', 'Penultimate beat must stage the strategy fix and Devil defeat.');
  assert(decorated.scenes[decorated.scenes.length - 1].characterStory.stage === 'cta-stage', 'Final beat must become an Elevate-owned CTA stage.');

  const positions = renderer.appearances(decorated).map((item) => ({ item, target: renderer.targetPosition(item) }));
  assert(positions.some(({ item, target }) => item.stage === 'creator-hero' && target.height >= 800), 'Opening creator must be staged at hero scale.');
  assert(positions.some(({ item, target }) => item.role === 'dominant-antagonist' && target.height >= 800), 'Retention Devil must visibly dominate the consequence scene.');
  assert(renderer.status().characterPrimary === true, 'Characters must be the primary visual identity.');
  assert(renderer.status().activeRoleEngine === true, 'Renderer must expose active character roles.');
  assert(renderer.status().largeCharacterStaging === true, 'Renderer must expose hero-scale character staging.');
  assert(renderer.status().genericSaaSPanelsDisabled === true, 'Generic SaaS filler panels must stay disabled.');
  assert(renderer.escapeDrawtextText("72%: creator's signal") === "72%\\: creator\\'s signal", 'FFmpeg text escaping must preserve literal percent while escaping filter syntax.');

  realCharacterAndTextRenderTest();
  console.log('ULTRON Elevate Character Universe v4 self-test passed: approved transparent lineup crops, complete Devil wings, active creator/Devil/Doctor roles, hero-scale staging, character-aware story graphics, literal-safe FFmpeg text and collision-free top editorial typography validated.');
})();
