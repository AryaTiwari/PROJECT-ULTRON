const fs = require('fs');
const path = require('path');
const { config } = require('../config');

function ensureFile(file, initial) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(initial, null, 2));
}

function readJson(file, fallback) {
  ensureFile(file, fallback);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  ensureFile(file, value);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function getMemoryState() { return readJson(config.memoryFile, { memories: [] }); }

function saveMemory(memory) {
  const state = getMemoryState();
  state.memories.push(memory);
  writeJson(config.memoryFile, state);
  return memory;
}

function getMemories() { return getMemoryState().memories.filter(item => item.active !== false); }

function updateMemory(id, patch) {
  const state = getMemoryState();
  const index = state.memories.findIndex(item => item.id === id);
  if (index < 0) return null;
  state.memories[index] = { ...state.memories[index], ...patch, updated_at: new Date().toISOString() };
  writeJson(config.memoryFile, state);
  return state.memories[index];
}

function supersedeMemory(id, supersededBy) {
  return updateMemory(id, { active: false, superseded_by: supersededBy });
}

function appendConversation(message) {
  const state = readJson(config.conversationFile, { messages: [] });
  state.messages.push(message);
  if (state.messages.length > 5000) state.messages.splice(0, state.messages.length - 5000);
  writeJson(config.conversationFile, state);
  return message;
}

function getRecentMessages(limit = config.recentMessageLimit) {
  return readJson(config.conversationFile, { messages: [] }).messages.slice(-limit);
}

function appendModelPerformance(event) {
  const file = path.join(path.dirname(config.memoryFile), 'model-performance.json');
  const state = readJson(file, { events: [] });
  state.events.push(event);
  if (state.events.length > 10000) state.events.splice(0, state.events.length - 10000);
  writeJson(file, state);
  return event;
}

function getModelPerformance(limit = 200) {
  const file = path.join(path.dirname(config.memoryFile), 'model-performance.json');
  return readJson(file, { events: [] }).events.slice(-limit).reverse();
}

module.exports = {
  getMemories,
  saveMemory,
  updateMemory,
  supersedeMemory,
  appendConversation,
  getRecentMessages,
  appendModelPerformance,
  getModelPerformance,
};
