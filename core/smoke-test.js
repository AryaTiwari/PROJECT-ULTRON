const { UltronCore, buildSystemPrompt } = require('./ultron-core');
const { assess } = require('./guardian');
const { analyze } = require('./critic');
const { listTools } = require('./executor');
const { lexicalSimilarity, judge } = require('./memory/judge');
const { loadPersonality } = require('./personality');
const { health } = require('./model-router');

(async () => {
  const personality = loadPersonality();
  const core = new UltronCore();
  const safeGuardian = assess({ message: 'Explain how ULTRON works.' });
  const safeCritic = analyze({ message: 'Explain how ULTRON works.' }, safeGuardian);
  const riskyGuardian = assess({ message: 'disable windows defender' });
  const duplicate = await judge({ content: 'My father is Pawan' }, [{ content: 'my father is pawan', active: true }]);

  console.log(JSON.stringify({
    ok: true,
    status: core.status(),
    system_prompt_loaded: buildSystemPrompt(personality).length > 0,
    safe_guardian: safeGuardian,
    safe_critic: safeCritic,
    risky_guardian: riskyGuardian,
    memory_duplicate_test: duplicate,
    lexical_similarity_test: lexicalSimilarity('my father is pawan', 'pawan is my father'),
    registered_tools: listTools(),
    model_router_health: await health(),
  }, null, 2));
})().catch(error => {
  console.error(error);
  process.exit(1);
});
