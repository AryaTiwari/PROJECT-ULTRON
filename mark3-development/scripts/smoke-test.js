const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const files = [];
function walk(dir) { for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name); const stat = fs.statSync(file); if (stat.isDirectory() && name !== 'node_modules') walk(file); else if (/\.(js|cjs|mjs)$/.test(name)) files.push(file); } }
walk(root);
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
const memory = require('../core/memory');
const planner = require('../core/planner');
const voice = require('../core/voice-orchestrator');
if (memory.similarity('hello world', 'hello world') < 0.99) throw new Error('Memory similarity invariant failed.');
if (!planner.createPlan('read a GitHub repository file', 'coding').steps.length) throw new Error('Planner invariant failed.');
if (voice.splitSpeech('Hello. How are you? I am ready!').length !== 3) throw new Error('Voice sentence segmentation invariant failed.');
console.log(`ULTRON Mark 3 smoke test passed: ${files.length} JS files checked.`);
