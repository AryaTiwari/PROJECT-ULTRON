const { config } = require('./config');
const { classify } = require('./task-classifier');
const { bestLearnedModel } = require('./model-router-stats');

function selectModel(message, explicitModel = null) {
  if (explicitModel) return explicitModel;
  const { taskType } = classify(message);
  const envMap = {
    coding: process.env.ULTRON_MODEL_CODING,
    research: process.env.ULTRON_MODEL_RESEARCH,
    automation: process.env.ULTRON_MODEL_AUTOMATION,
    planning: process.env.ULTRON_MODEL_PLANNING,
    creative: process.env.ULTRON_MODEL_CREATIVE,
    simple_qa: process.env.ULTRON_MODEL_SIMPLE_QA,
    general: process.env.ULTRON_MODEL_GENERAL,
  };
  if (envMap[taskType]) return envMap[taskType];
  const learned = bestLearnedModel(taskType);
  if (learned?.model && Number(learned.attempts) >= Number(process.env.ULTRON_LEARNED_ROUTING_MIN_SAMPLES || 5)) return learned.model;
  return config.router.model;
}

module.exports = { selectModel };
