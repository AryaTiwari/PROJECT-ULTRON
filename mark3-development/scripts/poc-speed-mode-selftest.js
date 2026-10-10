'use strict';

const assert = require('assert/strict');
const operator = require('../core/universal-sheet-enrichment-operator');

const original = process.env.ULTRON_M3_UNIVERSAL_FAST_MODE;

try {
  delete process.env.ULTRON_M3_UNIVERSAL_FAST_MODE;
  assert.equal(operator.fastUniversalEnrichmentEnabled({}), true);
  assert.equal(operator.fastUniversalEnrichmentEnabled({ fastMode: false }), false);
  assert.equal(operator.deepProviderFallbacksEnabled({}), false);
  assert.equal(operator.deepProviderFallbacksEnabled({ allowDeepProviderFallbacks: true }), true);
  assert.equal(operator.deepProviderFallbacksEnabled({ allowDeepProviderFallbacks: false }), false);

  process.env.ULTRON_M3_UNIVERSAL_FAST_MODE = '0';
  assert.equal(operator.fastUniversalEnrichmentEnabled({}), false);
  assert.equal(operator.deepProviderFallbacksEnabled({}), true);

  console.log('POC speed mode selftest: PASS');
} finally {
  if (original == null) delete process.env.ULTRON_M3_UNIVERSAL_FAST_MODE;
  else process.env.ULTRON_M3_UNIVERSAL_FAST_MODE = original;
}
