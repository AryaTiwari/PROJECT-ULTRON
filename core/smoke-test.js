const { UltronCore, buildSystemPrompt } = require('./ultron-core');
const { assess } = require('./guardian');
const { analyze } = require('./critic');
const { listTools } = require('./executor');
const { lexicalSimilarity, judge } = require('./memory/judge');
const { loadPersonality } = require('./personality');
const { health, chat } = require('./model-router');
const omniRoute = require('./omniroute');

(async () => {
  const personality = loadPersonality();
  const core = new UltronCore();
  const safeGuardian = assess({ message: 'Explain how ULTRON works.' });
  const safeCritic = analyze({ message: 'Explain how ULTRON works.' }, safeGuardian);
  const riskyGuardian = assess({ message: 'disable windows defender' });
  const duplicate = await judge({ content: 'My father is Pawan' }, [{ content: 'my father is pawan', active: true }]);
  const omniHealth = await omniRoute.health();

  let inference = null;
  if (omniHealth.ok) {
    try {
      inference = await chat({
        messages: [
          { role: 'system', content: 'You are ULTRON. Reply briefly for this connectivity test.' },
          { role: 'user', content: 'Reply with exactly: ULTRON OMNIROUTE ONLINE' },
        ],
        model: 'auto',
        taskType: 'simple_qa',
      });
    } catch (error) {
      inference = {
        ok: false,
        error: error.message,
        status: error.status || null,
        responseShape: error.responseShape || null,
      };
    }
  }

  const inferenceOk = Boolean(inference?.content?.trim());
  const routerHealth = await health();
  const checksPassed = omniHealth.ok && inferenceOk;
  console.log(JSON.stringify({
    ok: checksPassed,
    status: core.status(),
    system_prompt_loaded: buildSystemPrompt(personality).length > 0,
    safe_guardian: safeGuardian,
    safe_critic: safeCritic,
    risky_guardian: riskyGuardian,
    memory_duplicate_test: duplicate,
    lexical_similarity_test: lexicalSimilarity('my father is pawan', 'pawan is my father'),
    registered_tools: listTools(),
    omniroute_health: omniHealth,
    omniroute_inference: inference ? { ok: inferenceOk, model: inference.model || null, provider: inference.provider || null, response: inference.content || inference.error, status: inference.status || null, responseShape: inference.responseShape || null } : { skipped: true, reason: 'OmniRoute catalog is offline or unauthenticated' },
    model_router_health: routerHealth,
  }, null, 2));

  if (!omniHealth.ok) process.exitCode = 2;
  else if (!inferenceOk) process.exitCode = 3;
})().catch(error => {
  console.error(error);
  process.exit(1);
});
