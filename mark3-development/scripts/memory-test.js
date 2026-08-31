const memory = require('../core/memory');
const value = `Mark 3 memory smoke ${Date.now()}`;
const first = memory.remember({ type:'semantic', content:value, importance:0.5, confidence:0.9, source:'test' });
const second = memory.remember({ type:'semantic', content:value, importance:0.5, confidence:0.9, source:'test' });
if (first.action !== 'SAVED') throw new Error(`Expected SAVED, got ${first.action}`);
if (second.action !== 'DUPLICATE') throw new Error(`Expected DUPLICATE, got ${second.action}`);
console.log('Mark 3 memory deduplication test passed.');
