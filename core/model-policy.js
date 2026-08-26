const { config } = require('./config');
const { classify } = require('./task-classifier');

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
  return envMap[taskType] || config.router.model;
}

module.exports = { selectModel };
