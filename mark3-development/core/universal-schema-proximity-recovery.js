'use strict';

// Secondary structural recovery for person groups whose identity column has an
// unfamiliar header and no ordinal hint. It uses proximity to already-typed
// contact fields plus real cell-value shape, and fails closed when more than one
// plausible identity column is equally close.

const schemaTools = require('./universal-sheet-schema');
const hardening = require('./universal-schema-hardening');

const INSTALL_FLAG = Symbol.for('ultron.mark3.universalSchemaProximityRecovery.installed');

function claimedIndexes(schema) {
  const claimed = new Set();
  for (const group of [...(schema.personGroups || []), ...(schema.companyGroups || [])]) {
    for (const field of Object.values(group.fields || {})) if (Number.isInteger(field?.index)) claimed.add(field.index);
  }
  return claimed;
}

function groupBounds(group) {
  const indexes = Object.values(group.fields || {}).map((field) => field.index).filter(Number.isInteger);
  if (!indexes.length) return null;
  return { min: Math.min(...indexes), max: Math.max(...indexes) };
}

function confidenceFor(distance, column) {
  const header = schemaTools.normalizeHeader(column.header);
  let confidence = 0.7 - Math.max(0, distance - 1) * 0.08;
  if (/\b(person|contact|decision|maker|representative|rep|candidate|lead|owner)\b/.test(header)) confidence += 0.12;
  if (/\b(company|organisation|organization|business|account)\b/.test(header)) confidence -= 0.25;
  return Math.max(0, Math.min(1, confidence));
}

function recover(rows, schema) {
  if (!schema?.personGroups?.length) return schema;
  const claimed = claimedIndexes(schema);
  const recoveries = Array.isArray(schema.structuralRecoveries) ? [...schema.structuralRecoveries] : [];

  for (const group of schema.personGroups) {
    if (group.fields?.name) continue;
    const bounds = groupBounds(group);
    if (!bounds) continue;

    const candidates = (schema.columns || [])
      .filter((column) => !claimed.has(column.index))
      .filter((column) => hardening.textLikeCandidate(rows, schema, column))
      .map((column) => {
        const distance = column.index < bounds.min ? bounds.min - column.index : column.index > bounds.max ? column.index - bounds.max : 0;
        return { column, distance, confidence: confidenceFor(distance, column) };
      })
      .filter((item) => item.distance <= 3 && item.confidence >= 0.62)
      .sort((a, b) => b.confidence - a.confidence || a.distance - b.distance || a.column.index - b.column.index);

    const best = candidates[0];
    const second = candidates[1];
    if (!best) continue;
    if (second && Math.abs(best.confidence - second.confidence) < 0.045 && best.distance === second.distance) continue;

    group.fields.name = {
      index: best.column.index,
      header: best.column.header,
      confidence: best.confidence,
      role: 'name',
      structuralRecovery: true,
    };
    group.seedIndex = Number.isInteger(group.seedIndex) ? Math.min(group.seedIndex, best.column.index) : best.column.index;
    group.confidence = Math.max(Number(group.confidence || 0), Math.min(0.88, 0.5 + best.confidence * 0.35));
    claimed.add(best.column.index);
    recoveries.push({ groupId: group.id, field: 'name', index: best.column.index, confidence: best.confidence, source: 'proximity+value-shape' });
  }

  schema.structuralRecoveries = recoveries;
  schema.entityGroups = [...schema.personGroups, ...(schema.companyGroups || [])];
  return schema;
}

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];
  const originalInfer = schemaTools.inferSchema.bind(schemaTools);
  schemaTools.inferSchema = function proximityRecoveredSchema(rows, options = {}) {
    return recover(rows, originalInfer(rows, options));
  };
  const api = Object.freeze({ recover });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = { install, recover };
