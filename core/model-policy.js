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
  const configured = envMap[taskType];
  if (configured) return configured;
  const learned = bestLearnedModel(taskType);
  if (learned && learned.attempts >= Number(process.env.ULTRON_MIN_LEARNED_SAMPLES || 5)) return learned.model;
  return config.router.model;
}

function explainModelChoice(message, explicitModel = null) {
  const { taskType } = classify(message);
  if (explicitModel) return { taskType, model: explicitModel, source: 'explicit' };
  const envMap = {
    coding: process.env.ULTRON_MODEL_CODING,
    research: process.env.ULTRON_MODEL_RESEARCH,
    automation: process.env.ULTRON_MODEL_AUTOMATION,
    planning: process.env.ULTRON_MODEL_PLANNING,
    creative: process.env.ULTRON_MODEL_CREATIVE,
    simple_qa: process.env.ULTRON_MODEL_SIMPLE_QA,
    general: process.env.ULTRON_MODEL_GENERAL,
  };
  if (envMap[taskType]) return { taskType, model: envMap[taskType], source: 'configured' };
  const learned = bestLearnedModel(taskType);
  if (learned && learned.attempts >= Number(process.env.ULTRON_MIN_LEARNED_SAMPLES || 5)) return { taskType, model: learned.model, source: 'learned', evidence: learned };
  return { taskType, model: config.router.model, source: 'default' };
}

module.exports = { selectModel, explainModelChoice };
