'use strict';

const apolloFetchHardening = require('./apollo-fetch-hardening');
const valuesRangeHardening = require('./google-sheets-values-range-hardening');
const schemaHardening = require('./universal-schema-hardening');
const ordinalContactRecovery = require('./universal-schema-ordinal-contact-recovery');
const schemaProximity = require('./universal-schema-proximity-recovery');
const schemaEntityDisambiguation = require('./universal-schema-entity-disambiguation');
const schemaContinuity = require('./universal-schema-continuity-recovery');
const adaptiveRanking = require('./universal-adaptive-ranking-policy');
const apolloQuality = require('./apollo-three-poc-quality');
const candidateDiscovery = require('./three-poc-candidate-discovery-policy');

const INSTALL_FLAG = Symbol.for('ultron.mark3.universalDeterministicBootstrap.installed');

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];

  // Install order is intentional:
  // 0) harden Apollo transport so raw fetch/network failures are retried and typed,
  // 1) harden Google Values reads so wide schema-neutral A1 ranges recover safely,
  // 2) recover semantically obvious but unfamiliar columns,
  // 3) recover ordinal entity headers such as "3rd POC" even without "Name",
  // 4) recover unlabeled identity columns by local structure/value shape,
  // 5) resolve whether anonymous contact fields belong to a person or company,
  // 6) recover explicitly requested trailing POC groups when blank header blocks were lost,
  // 7) replace fixed weighting with population-adaptive deterministic ranking,
  // 8) install final-verified-POC business-email quality (no personal-email reveal),
  // 9) install high-recall zero-credit Apollo discovery before paid hydration.
  const apolloNetwork = apolloFetchHardening.install();
  const values = valuesRangeHardening.install();
  const schema = schemaHardening.install();
  const ordinal = ordinalContactRecovery.install();
  const proximity = schemaProximity.install();
  const ownership = schemaEntityDisambiguation.install();
  const continuity = schemaContinuity.install();
  const ranking = adaptiveRanking.install();
  const contactQuality = apolloQuality.install();
  const highRecallDiscovery = candidateDiscovery.install();

  const api = Object.freeze({
    apolloNetwork,
    values,
    schema,
    ordinal,
    proximity,
    ownership,
    continuity,
    ranking,
    contactQuality,
    highRecallDiscovery,
    deterministic: true,
    modelCalls: 0,
  });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = { install };
