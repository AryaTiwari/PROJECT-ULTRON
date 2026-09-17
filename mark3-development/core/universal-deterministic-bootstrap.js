'use strict';

const schemaHardening = require('./universal-schema-hardening');
const schemaProximity = require('./universal-schema-proximity-recovery');
const schemaEntityDisambiguation = require('./universal-schema-entity-disambiguation');
const adaptiveRanking = require('./universal-adaptive-ranking-policy');

const INSTALL_FLAG = Symbol.for('ultron.mark3.universalDeterministicBootstrap.installed');

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];

  // Install order is intentional:
  // 1) recover semantically obvious but unfamiliar columns,
  // 2) recover unlabeled identity columns by local structure/value shape,
  // 3) resolve whether anonymous contact fields belong to a person or company,
  // 4) replace fixed weighting with population-adaptive deterministic ranking.
  const schema = schemaHardening.install();
  const proximity = schemaProximity.install();
  const ownership = schemaEntityDisambiguation.install();
  const ranking = adaptiveRanking.install();

  const api = Object.freeze({
    schema,
    proximity,
    ownership,
    ranking,
    deterministic: true,
    modelCalls: 0,
  });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = { install };
