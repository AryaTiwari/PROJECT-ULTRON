'use strict';
// Run isolated fixtures without live credentials, network calls, or runtime state.
const fs = require('fs');
const path = require('path');
const os = require('os');
global.fetch = async () => { throw Object.assign(new Error('Live network disabled in enrichment regressions'), {code:'OFFLINE_TEST_NETWORK_BLOCKED'}); };
const config = require('../core/config');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-enrichment-test-'));
config.projectRoot = root;
config.dataDir = path.join(root, 'data');
