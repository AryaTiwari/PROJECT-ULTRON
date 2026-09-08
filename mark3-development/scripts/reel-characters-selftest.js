const universe = require('../core/elevate-character-universe');
const renderer = require('../core/elevate-character-renderer');

function assert(condition, message) { if (!condition) throw new Error(message); }

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

  console.log('ULTRON Elevate Character Universe self-test passed: seven canonical actors, creator routing, Retention Devil conflict, doctor diagnosis/prescription, every-scene continuity, character-aware props and blurred-background-only stock policy validated.');
})();
