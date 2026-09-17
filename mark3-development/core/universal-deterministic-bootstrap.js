'use strict';

const schemaHardening = require('./universal-schema-hardening');
const adaptiveRanking = require('./universal-adaptive-ranking-policy');

const INSTALL_FLAG = Symbol.for('ultron.mark3.universalDeterministicBootstrap.installed');

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];
  const schema = schemaHardening.install();
  const ranking = adaptiveRanking.install();
  const api = Object.freeze({ schema, ranking, deterministic: true, modelCalls: 0 });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = { install };
