'use strict';

const valuesRangeHardening = require('./google-sheets-values-range-hardening');
const schemaHardening = require('./universal-schema-hardening');
const ordinalContactRecovery = require('./universal-schema-ordinal-contact-recovery');
const schemaProximity = require('./universal-schema-proximity-recovery');
const schemaEntityDisambiguation = require('./universal-schema-entity-disambiguation');
const adaptiveRanking = require('./universal-adaptive-ranking-policy');

const INSTALL_FLAG = Symbol.for('ultron.mark3.universalDeterministicBootstrap.installed');

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];

  // Install order is intentional:
  // 0) harden Google Values reads so wide schema-neutral A1 ranges are clamped
  //    to the physical tab grid only when Google rejects them as out-of-bounds,
  // 1) recover semantically obvious but unfamiliar columns,
  // 2) recover ordinal entity headers such as "3rd POC" even without "Name",
  // 3) recover unlabeled identity columns by local structure/value shape,
  // 4) resolve whether anonymous contact fields belong to a person or company,
  // 5) replace fixed weighting with population-adaptive deterministic ranking.
  const values = valuesRangeHardening.install();
  const schema = schemaHardening.install();
  const ordinal = ordinalContactRecovery.install();
  const proximity = schemaProximity.install();
  const ownership = schemaEntityDisambiguation.install();
  const ranking = adaptiveRanking.install();

  const api = Object.freeze({
    values,
    schema,
    ordinal,
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
