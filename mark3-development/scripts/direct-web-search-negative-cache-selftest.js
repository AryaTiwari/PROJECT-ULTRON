const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-direct-search-test-'));
const configPath = require.resolve('../core/config');
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: { projectRoot: root, mark3Root: root },
};

let calls = 0;
global.fetch = async () => {
  calls++;
  return { ok: true, text: async () => '<html><body>No matching indexed profiles</body></html>' };
};

const search = require('../core/direct-web-search');

(async () => {
  await assert.rejects(
    search.search('site:linkedin.com/in "Missing Person" "Missing Company"'),
    (error) => error?.code === 'DIRECT_WEB_SEARCH_EMPTY',
  );
  await assert.rejects(
    search.search('site:linkedin.com/in "Missing Person" "Missing Company"'),
    (error) => error?.code === 'DIRECT_WEB_SEARCH_EMPTY_CACHED' && error?.cached === true,
  );
  assert.equal(calls, 1, 'the same empty public query must not hit the upstream search provider twice');
  console.log('Direct web negative-cache self-test passed: empty indexed searches are short-lived cached and repeated upstream calls are skipped.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
