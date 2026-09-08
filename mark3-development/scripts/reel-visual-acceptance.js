const fs = require('fs');
const os = require('os');
const path = require('path');
const pipeline = require('../core/reel-pipeline');
const renderer = require('../core/elevate-character-renderer');
const textLayout = require('../core/elevate-text-layout');
const universe = require('../core/elevate-character-universe');
const factory = require('../core/reel-factory');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeFinalLineup(file) {
  const colors = {
    gym_creator: '0x2563EB',
    fashion_creator: '0xEC4899',
    ugc_creator: '0xF59E0B',
    info_creator: '0x64748B',
    retention_devil: '0xDC2626',
    content_doctor_female: '0xDB2777',
    content_doctor_male: '0x0284C7',
  };
  const filters = ['format=rgba'];
  for (const [id, crop] of Object.entries(universe.FINAL_LINEUP_CROPS)) {
    filters.push(`drawbox=x=${crop.x + 18}:y=${crop.y + 18}:w=${Math.max(30, crop.w - 36)}:h=${Math.max(30, crop.h - 36)}:color=${colors[id]}@1:t=fill`);
  }
  pipeline.run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black@0.0:s=2048x682:r=1:d=0.1',
    '-vf', filters.join(','), '-frames:v', '1', file,
  ], { timeoutMs: 30000 });
  assert(fs.existsSync(file) && fs.statSync(file).size > 1000, 'Could not create synthetic approved final lineup.');
}

(() => {
  assert(factory.ffmpegStatus().available, '30-second Reel visual acceptance requires FFmpeg.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-reel-30s-v4-'));
  try {
    const background = path.join(root, 'background.mp4');
    const lineup = path.join(root, 'approved-final-lineup.png');
    makeFinalLineup(lineup);
    pipeline.run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=30',
      '-vf', 'eq=brightness=-0.08:saturation=0.65,drawbox=x=0:y=0:w=iw:h=ih:color=0x172554@0.15:t=fill',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '29', '-pix_fmt', 'yuv420p', background,
    ], { timeoutMs: 180000 });

    const plan = {
      title: 'Views are not loyal followers',
      hook: 'Views are not loyal followers',
      durationSec: 30,
      scenes: [
        { index:1,start:0,end:3.8,purpose:'Pattern interrupt',onScreenText:'Views are not followers',narration:'Thousands of views can still leave you with weak follower conversion.',characterStory:{type:'creator-hook',stage:'creator-hero',characters:['info_creator'],roles:['protagonist'],expressions:['confident'],prop:'views-vs-follows',motion:'creator-pop'} },
        { index:2,start:3.8,end:7.8,purpose:'Conflict',onScreenText:'The leak starts here',narration:'The viewer watches once and the Retention Devil steals the next step.',characterStory:{type:'devil-interruption',stage:'conflict-split',characters:['info_creator','retention_devil'],roles:['protagonist','antagonist'],expressions:['confused','smug'],prop:'views-vs-follows',motion:'devil-ambush'} },
        { index:3,start:7.8,end:12.2,purpose:'Consequence',onScreenText:'Views do not convert',narration:'The funnel collapses between the view, profile visit and actual follow.',characterStory:{type:'metric-consequence',stage:'devil-dominant',characters:['info_creator','retention_devil'],roles:['reacting-protagonist','dominant-antagonist'],expressions:['frustrated','scheming'],prop:'conversion-funnel',motion:'metric-attack'} },
        { index:4,start:12.2,end:16.7,purpose:'Diagnosis',onScreenText:'Give them a reason back',narration:'Elevate diagnoses the missing reason for viewers to return tomorrow.',characterStory:{type:'doctor-diagnosis',stage:'diagnosis-split',characters:['info_creator','content_doctor_female'],roles:['patient-creator','diagnostician'],expressions:['concerned','analytical'],prop:'conversion-funnel',motion:'scanner-diagnosis'} },
        { index:5,start:16.7,end:21.2,purpose:'Explanation',onScreenText:'Build a repeatable promise',narration:'A recognizable series gives viewers a clear reason to follow.',characterStory:{type:'story-explanation',stage:'explanation-stage',characters:['info_creator','content_doctor_female'],roles:['learning-creator','guide'],expressions:['thinking','confident'],prop:'creator-system',motion:'doctor-explain'} },
        { index:6,start:21.2,end:25.8,purpose:'Action',onScreenText:'Promise series CTA',narration:'The analyst turns that promise into a repeatable series and CTA.',characterStory:{type:'doctor-prescription',stage:'prescription-stage',characters:['content_doctor_male','info_creator','retention_devil'],roles:['strategist','recovering-creator','defeated-antagonist'],expressions:['confident','motivated','shocked'],prop:'creator-system',motion:'prescription-reveal'} },
        { index:7,start:25.8,end:30,purpose:'Brand CTA',onScreenText:'Book your strategy session',narration:'Book your free strategy session with Elevate OS now.',isBrandCta:true,characterStory:{type:'elevate-close',stage:'cta-stage',characters:['content_doctor_female','content_doctor_male'],roles:['host-left','host-right'],expressions:['confident','approving'],prop:'cta-button',motion:'doctor-close'} },
      ],
    };

    const rendered = renderer.apply(background, { paths: { dir: root } }, plan, {
      characters: true,
      characterFinalLineupPath: lineup,
    });
    assert(rendered.meta?.applied === true, `30-second character compositor failed: ${rendered.meta?.reason || 'unknown failure'}`);
    assert(rendered.meta?.assetMode === 'approved-final-lineup', '30-second acceptance must use the approved final transparent lineup.');
    assert(rendered.meta?.finalLineupReady === true, '30-second acceptance must confirm final lineup readiness.');
    assert(rendered.meta?.activeRoleEngine === true, '30-second acceptance must use active character roles.');
    assert(rendered.meta?.largeCharacterStaging === true, '30-second acceptance must use hero-scale character staging.');
    assert(rendered.meta?.sceneCoverage === 7, '30-second acceptance must cover all seven story scenes.');
    assert(rendered.meta?.ffmpegTextExpansion === 'none', '30-second acceptance must keep FFmpeg text expansion disabled.');
    assert(rendered.meta?.storyStages.includes('conflict-split'), '30-second acceptance must include the creator-vs-Devil conflict.');
    assert(rendered.meta?.storyStages.includes('diagnosis-split'), '30-second acceptance must include the Doctor diagnosis.');
    assert(rendered.meta?.storyStages.includes('prescription-stage'), '30-second acceptance must include the prescription/Devil-defeat beat.');

    const polished = textLayout.apply(rendered.path, plan, root);
    assert(polished.captionsApplied === true, `30-second character text layout failed: ${polished.reason || 'unknown failure'}`);
    assert(polished.visualStyle === 'character-editorial-v1', '30-second acceptance must use character-editorial-v1 typography.');
    assert(polished.replacementCaptionMode === true, '30-second acceptance must not stack headline and support captions.');

    const verified = pipeline.verifyOutput(polished.path);
    assert(verified.width === 1080 && verified.height === 1920, `30-second acceptance output dimensions are wrong: ${verified.width}x${verified.height}`);
    assert(Number(verified.durationSec || 0) >= 29.8 && Number(verified.durationSec || 0) <= 30.2, `30-second acceptance duration is wrong: ${verified.durationSec}`);
    assert(Number(verified.bytes || 0) > 300000, `30-second acceptance output is unexpectedly small: ${verified.bytes} bytes`);

    const literalFilters = renderer.propFilters(plan).join(',');
    assert(literalFilters.includes("text='SKIP'"), '30-second acceptance did not exercise the Retention Devil SKIP conflict.');
    assert(literalFilters.includes('NO REASON TO RETURN'), '30-second acceptance did not exercise the Doctor diagnosis copy.');
    assert(literalFilters.includes('PROMISE'), '30-second acceptance did not exercise the creator-system prescription.');
    assert(!literalFilters.includes('CREATOR SIGNAL'), '30-second acceptance must not contain old generic CREATOR SIGNAL filler.');
    assert(literalFilters.includes('expansion=none'), '30-second acceptance lost FFmpeg literal-text protection.');

    console.log(`ULTRON 30-second Elevate visual acceptance v4 passed: ${verified.width}x${verified.height}, ${Number(verified.durationSec).toFixed(2)}s, approved final lineup, hero-scale creator/Devil/Doctor acting, story props, collision-free editorial text and CTA rendered successfully.`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
