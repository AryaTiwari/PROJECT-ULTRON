const fs = require('fs');
const path = require('path');
const { config } = require('../config');

function ensureFile(file, initial) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(initial, null, 2));
}

function readJson(file, fallback) {
  ensureFile(file, fallback);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureFile(file, value);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function getMemoryState() {
  return readJson(config.memoryFile, { memories: [] });
}

function saveMemory(memory) {
  const state = getMemoryState();
  state.memories.push(memory);
  writeJson(config.memoryFile, state);
  return memory;
}

function getMemories() {
  return getMemoryState().memories.filter(item => item.active !== false);
}

function updateMemory(id, patch) {
  const state = getMemoryState();
  const index = state.memories.findIndex(item => item.id === id);
  if (index < 0) return null;
  state.memories[index] = { ...state.memories[index], ...patch, updated_at: new Date().toISOString() };
  writeJson(config.memoryFile, state);
  return state.memories[index];
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

module.exports = { getMemories, saveMemory, updateMemory, appendConversation, getRecentMessages };
