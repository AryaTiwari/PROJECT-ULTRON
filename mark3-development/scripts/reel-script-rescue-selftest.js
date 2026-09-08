const quality = require('../core/reel-quality');
const rescue = require('../core/reel-script-rescue');

function assert(condition, message) { if (!condition) throw new Error(message); }

(() => {
  const brief = 'why creators can get thousands of views but still fail to convert those views into loyal followers';
  const plan = {
    durationSec: 30,
    title: brief,
    hook: 'Virality does not equal loyalty.',
    cta: 'Book your Free Strategy Session now — Elevate OS — elevateos.in',
    brandPromotion: true,
    scenes: [
      { index:1,start:0,end:2.4,purpose:'Pattern interrupt',onScreenText:'Virality ≠ Loyalty',narration:'Virality does not equal loyalty.',visualQuery:'creator analytics',isBrandCta:false },
      { index:2,start:2.4,end:7,purpose:'Context',onScreenText:'One Topic Won',narration:'Viewers may follow one topic, not you.',visualQuery:'creator profile',isBrandCta:false },
      { index:3,start:7,end:11.6,purpose:'Mechanism',onScreenText:'Return Signals Matter',narration:'Without returns, Instagram sees weaker repeat-viewer signals. Track follows, saves, and profile visits.',visualQuery:'creator analytics',isBrandCta:false },
      { index:4,start:11.6,end:16.2,purpose:'Consequence',onScreenText:'Expectations Reset',narration:'Unrelated follow-ups reset what viewers expect next. Consistency teaches the right audience to return.',visualQuery:'creator posts',isBrandCta:false },
      { index:5,start:16.2,end:20.8,purpose:'Action',onScreenText:'Build Repeatable Pillars',narration:'Build three pillars around the winning promise.',visualQuery:'content planning',isBrandCta:false },
      { index:6,start:20.8,end:25.4,purpose:'Proof',onScreenText:'Make Signal Clear',narration:'Make the next action obvious and measurable.',visualQuery:'workflow',isBrandCta:false },
      { index:7,start:25.4,end:30,purpose:'Brand CTA',onScreenText:'Book Your Free Strategy Session',subText:'Elevate OS • elevateos.in',narration:'Want a growth plan for your account? Book your free Elevate OS strategy session now at elevateos.in.',visualQuery:'creator strategy consultation',isBrandCta:true },
    ],
  };
  plan.voiceover = rescue.rebuildVoiceover(plan);
  const before = quality.auditPlan(plan, brief, { durationSec: 30 });
  assert(!before.ok, 'Regression fixture must fail before script rescue.');
  assert(before.issues.some((issue) => /scene 2 narration is too vague\/short: 7 words/i.test(issue)), 'Fixture must reproduce scene 2 seven-word failure.');
  assert(before.issues.some((issue) => /scene 5 narration is too vague\/short: 7 words/i.test(issue)), 'Fixture must reproduce scene 5 seven-word failure.');
  assert(before.issues.some((issue) => /scene 6 narration is too vague\/short: 7 words/i.test(issue)), 'Fixture must reproduce scene 6 seven-word failure.');

  const repaired = rescue.repairPlan(plan, brief, { durationSec: 30 });
  assert(repaired.repaired === true, 'Script rescue must report that it repaired the plan.');
  assert(repaired.repairs.length === 3, 'Exactly the three short body scenes should be repaired.');
  assert(repaired.plan.scenes.slice(1, -1).every((scene) => quality.wordCount(scene.narration) >= repaired.audit.requirements.minBodyNarrationWords), 'Every body narration must meet the unchanged minimum word floor after rescue.');
  assert(repaired.audit.ok, `Repaired script must pass the unchanged quality gate: ${repaired.audit.issues.join('; ')}`);
  assert(repaired.plan.scriptRescue.strictGatePreserved === true, 'Script rescue must explicitly preserve the strict quality gate.');
  assert(rescue.status().lowersQualityThreshold === false, 'Script rescue must never lower quality thresholds.');

  console.log('ULTRON Reel Script Rescue self-test passed: exact 7-word scene regression repaired locally while the strict Reel quality gate remained unchanged.');
})();
