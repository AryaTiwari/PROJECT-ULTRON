const { UltronCore, buildSystemPrompt } = require('./ultron-core');
const { assess } = require('./guardian');
const { analyze } = require('./critic');
const { listTools } = require('./executor');
const { getConfig: getRouterConfig } = require('./model-router');

const core = new UltronCore();
const guardian = assess({ message: 'Explain how ULTRON routing works.' });
const critic = analyze({ message: 'Explain how ULTRON routing works.' }, guardian);

console.log(JSON.stringify({
  ok: true,
  status: core.status(),
  system_prompt_loaded: buildSystemPrompt(core.personality).length > 0,
  guardian,
  critic,
  registered_tools: listTools(),
  model_router: getRouterConfig(),
}, null, 2));
