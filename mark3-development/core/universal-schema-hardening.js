'use strict';

// Structural hardening for universal spreadsheet schema inference.
// This layer does not replace semantic header analysis. It repairs cases where
// headers are unfamiliar but repeated contact structure and actual cell values
// make the intended ownership relationship clear enough to recover safely.

const schemaTools = require('./universal-sheet-schema');

const INSTALL_FLAG = Symbol.for('ultron.mark3.universalSchemaHardening.installed');

function text(value) { return String(value ?? '').trim(); }
function clamp(value, min = 0, max = 1) { return Math.max(min, Math.min(max, Number(value) || 0)); }

function profileColumn(rows, headerRowIndex, columnIndex, limit = 80) {
  const values = [];
  for (let r = headerRowIndex + 1; r < Math.min(rows.length, headerRowIndex + 1 + limit); r++) {
    const value = text(rows[r]?.[columnIndex]);
    if (value) values.push(value);
  }
  if (!values.length) {
    return { samples: 0, uniqueRatio: 0, alphaRatio: 0, avgWords: 0, avgLength: 0, compactTextRatio: 0 };
  }
  const uniqueRatio = new Set(values.map((value) => value.toLowerCase())).size / values.length;
  const alphaRatio = values.filter((value) => /[a-z]/i.test(value) && !/^[-+]?\d+(?:[.,]\d+)?$/.test(value)).length / values.length;
  const wordCounts = values.map((value) => value.replace(/https?:\/\/\S+/ig, '').split(/\s+/).filter(Boolean).length);
  const avgWords = wordCounts.reduce((sum, value) => sum + value, 0) / wordCounts.length;
  const avgLength = values.reduce((sum, value) => sum + value.length, 0) / values.length;
  const compactTextRatio = wordCounts.filter((count) => count >= 1 && count <= 9).length / wordCounts.length;
  return { samples: values.length, uniqueRatio, alphaRatio, avgWords, avgLength, compactTextRatio };
}

function claimedIndexes(schema) {
  const claimed = new Set();
  for (const group of [...(schema.personGroups || []), ...(schema.companyGroups || [])]) {
    for (const descriptor of Object.values(group.fields || {})) {
      if (Number.isInteger(descriptor?.index)) claimed.add(descriptor.index);
    }
  }
  return claimed;
}

function nextOrdinal(schema) {
  const ordinals = (schema.personGroups || []).map((group) => Number(group.ordinal || 0)).filter((value) => value > 0);
  return ordinals.length ? Math.max(...ordinals) + 1 : 1;
}

function textLikeCandidate(rows, schema, column) {
  if (!column || column.role !== 'unknown') return false;
  const signature = column.signature || {};
  if ((signature.email || 0) > 0.1 || (signature.phone || 0) > 0.1 || (signature.linkedin || 0) > 0.1 || (signature.url || 0) > 0.15 || (signature.numeric || 0) > 0.3) return false;
  const profile = profileColumn(rows, schema.headerRowIndex, column.index);
  return profile.samples >= 2
    && profile.uniqueRatio >= 0.5
    && profile.alphaRatio >= 0.75
    && profile.compactTextRatio >= 0.7
    && profile.avgWords >= 1
    && profile.avgWords <= 9;
}

function descriptor(column, confidence, role = column.role) {
  return {
    index: column.index,
    header: column.header,
    confidence: clamp(confidence),
    role,
    structuralRecovery: true,
  };
}

function groupIndexes(group) {
  return Object.values(group.fields || {}).map((field) => field.index).filter(Number.isInteger);
}

function nearestDistance(columnIndex, group) {
  const indexes = groupIndexes(group);
  if (!indexes.length) return Infinity;
  return Math.min(...indexes.map((index) => Math.abs(index - columnIndex)));
}

function repairHintedFields(rows, schema) {
  const claimed = claimedIndexes(schema);
  const recoveries = [];
  for (const group of schema.personGroups || []) {
    const ordinal = Number(group.ordinal || 0);
    if (!ordinal) continue;
    const exactHint = (schema.columns || []).filter((column) => !claimed.has(column.index) && Number(column.slotHint || 0) === ordinal);

    if (!group.fields.name) {
      const candidates = exactHint
        .filter((column) => column.role === 'name' || textLikeCandidate(rows, schema, column))
        .map((column) => {
          const header = schemaTools.normalizeHeader(column.header);
          let score = 0.62;
          if (column.role === 'name') score += 0.24;
          if (/\b(person|contact|poc|decision|maker|representative|rep|candidate|lead)\b/.test(header)) score += 0.12;
          score += Math.max(0, 0.12 - nearestDistance(column.index, group) * 0.02);
          return { column, score };
        })
        .sort((a, b) => b.score - a.score || a.column.index - b.column.index);
      const winner = candidates[0];
      if (winner?.score >= 0.72) {
        group.fields.name = descriptor(winner.column, winner.score, 'name');
        claimed.add(winner.column.index);
        recoveries.push({ groupId: group.id, field: 'name', index: winner.column.index, confidence: clamp(winner.score), source: 'slot-hint+structure' });
      }
    }

    if (!group.fields.role) {
      const candidates = exactHint
        .filter((column) => !claimed.has(column.index) && (column.role === 'role' || textLikeCandidate(rows, schema, column)))
        .map((column) => {
          const header = schemaTools.normalizeHeader(column.header);
          let score = 0.54;
          if (column.role === 'role') score += 0.3;
          if (/\b(role|title|designation|position|function|department|responsibility)\b/.test(header)) score += 0.18;
          score += Math.max(0, 0.1 - nearestDistance(column.index, group) * 0.018);
          return { column, score };
        })
        .sort((a, b) => b.score - a.score || a.column.index - b.column.index);
      const winner = candidates[0];
      if (winner?.score >= 0.74) {
        group.fields.role = descriptor(winner.column, winner.score, 'role');
        claimed.add(winner.column.index);
        recoveries.push({ groupId: group.id, field: 'role', index: winner.column.index, confidence: clamp(winner.score), source: 'slot-hint+structure' });
      }
    }
  }
  return { claimed, recoveries };
}

function contactSignal(column) {
  return ['email', 'phone', 'linkedin_person'].includes(column?.role);
}

function segmentOrphanContacts(schema, claimed) {
  const orphan = (schema.columns || [])
    .filter((column) => !claimed.has(column.index) && contactSignal(column))
    .sort((a, b) => a.index - b.index);
  const blocks = [];
  let current = [];
  let roles = new Set();
  for (const column of orphan) {
    const gap = current.length ? column.index - current[current.length - 1].index : 0;
    const repeats = roles.has(column.role);
    if (current.length && (gap > 4 || repeats)) {
      blocks.push(current);
      current = [];
      roles = new Set();
    }
    current.push(column);
    roles.add(column.role);
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function nearbyUnknownText(rows, schema, claimed, block) {
  const start = Math.max(0, block[0].index - 3);
  const end = block[block.length - 1].index + 2;
  return (schema.columns || [])
    .filter((column) => !claimed.has(column.index) && column.index >= start && column.index <= end && textLikeCandidate(rows, schema, column))
    .map((column) => ({
      column,
      distance: Math.min(...block.map((item) => Math.abs(item.index - column.index))),
      beforeBias: column.index <= block[0].index ? 0 : 0.08,
    }))
    .sort((a, b) => (a.distance + a.beforeBias) - (b.distance + b.beforeBias) || a.column.index - b.column.index);
}

function recoverRepeatedBlocks(rows, schema, claimed, recoveries) {
  const blocks = segmentOrphanContacts(schema, claimed);
  let ordinal = nextOrdinal(schema);
  for (const block of blocks) {
    const roles = new Set(block.map((column) => column.role));
    const enoughContactEvidence = roles.has('linkedin_person') || (roles.has('email') && roles.has('phone'));
    if (!enoughContactEvidence) continue;

    const nearby = nearbyUnknownText(rows, schema, claimed, block);
    const nameColumn = nearby[0]?.column || null;
    if (!nameColumn && !roles.has('linkedin_person')) continue;

    const group = {
      id: `person-${ordinal}-structural-${nameColumn?.index ?? block[0].index}`,
      kind: 'person',
      ordinal,
      seedIndex: nameColumn?.index ?? block[0].index,
      fields: {},
      alternates: [],
      confidence: 0,
      structuralRecovery: true,
    };
    if (nameColumn) {
      group.fields.name = descriptor(nameColumn, 0.72, 'name');
      claimed.add(nameColumn.index);
    }
    for (const column of block) {
      const field = column.role === 'linkedin_person' ? 'linkedin' : column.role;
      if (!group.fields[field]) {
        group.fields[field] = descriptor(column, Math.max(0.68, Number(column.confidence || 0)), column.role);
        claimed.add(column.index);
      }
    }
    const roleCandidate = nearby.slice(nameColumn ? 1 : 0).find((item) => {
      const header = schemaTools.normalizeHeader(item.column.header);
      return /\b(role|title|designation|position|function|department)\b/.test(header);
    });
    if (roleCandidate) {
      group.fields.role = descriptor(roleCandidate.column, 0.74, 'role');
      claimed.add(roleCandidate.column.index);
    }

    const identity = Number(Boolean(group.fields.name)) + Number(Boolean(group.fields.linkedin));
    const contacts = Number(Boolean(group.fields.email)) + Number(Boolean(group.fields.phone));
    group.confidence = clamp(0.36 + identity * 0.2 + contacts * 0.14);
    if (group.confidence < 0.64) continue;
    schema.personGroups.push(group);
    schema.entityGroups.push(group);
    recoveries.push({ groupId: group.id, field: 'group', indexes: groupIndexes(group), confidence: group.confidence, source: 'repeated-contact-structure' });
    ordinal++;
  }
}

function recalculateSchemaConfidence(schema, recoveries) {
  const groups = [...(schema.personGroups || []), ...(schema.companyGroups || [])];
  const avgGroup = groups.length ? groups.reduce((sum, group) => sum + Number(group.confidence || 0), 0) / groups.length : 0;
  const structuralBonus = Math.min(0.08, (recoveries || []).length * 0.01);
  schema.confidence = clamp(Math.max(Number(schema.confidence || 0), 0.3 + avgGroup * 0.55 + structuralBonus));
  schema.personGroups.sort((a, b) => (a.ordinal || 999) - (b.ordinal || 999) || (a.seedIndex ?? 999) - (b.seedIndex ?? 999));
  schema.entityGroups = [...schema.personGroups, ...(schema.companyGroups || [])];
  schema.structuralRecoveries = recoveries;
  schema.schemaVersion = Math.max(2, Number(schema.schemaVersion || 1));
  return schema;
}

function harden(rows, schema) {
  if (!schema || !Array.isArray(schema.columns)) return schema;
  const { claimed, recoveries } = repairHintedFields(rows, schema);
  recoverRepeatedBlocks(rows, schema, claimed, recoveries);
  return recalculateSchemaConfidence(schema, recoveries);
}

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];
  const originalInfer = schemaTools.inferSchema.bind(schemaTools);
  schemaTools.inferSchema = function hardenedInferSchema(rows, options = {}) {
    return harden(rows, originalInfer(rows, options));
  };
  const api = Object.freeze({ harden, profileColumn, textLikeCandidate, segmentOrphanContacts });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = { install, harden, profileColumn, textLikeCandidate, segmentOrphanContacts };
