'use strict';
const assert = require('node:assert/strict');
const single = require('./replace-stale-mark3');
assert.equal(single.classify(null, 'new'), 'foreign');
assert.equal(single.classify({ service: 'Other', buildId: 'old' }, 'new'), 'foreign');
assert.equal(single.classify({ service: 'ULTRON Mark 3', buildId: 'new' }, 'new'), 'current');
assert.equal(single.classify({ service: 'ULTRON Mark 3', buildId: 'old' }, 'new'), 'stale');
assert.equal(single.classify({ service: 'ULTRON Mark 3' }, 'new'), 'stale');
console.log('Mark 3 single-instance self-test passed: current builds are retained, stale/legacy ULTRON builds are replaceable, and foreign port owners remain protected.');