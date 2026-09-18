'use strict';

// Recover trailing repeated person/contact blocks when the user explicitly requests
// more POC groups than are currently visible and the missing region is blank.
//
// This is intentionally NOT a universal "assume 3 POCs" rule. Recovery activates
// only when expectedPersonGroups is supplied by the command/configuration and the
// missing columns are safe blank trailing space. It therefore repairs schema
// continuity without inventing ownership inside populated columns.

const schemaTools = require('./universal-sheet-schema');

const INSTALL_FLAG = Symbol.for('ultron.mark3.universalSchemaContinuityRecovery.installed');

function text(value) { return String(value ?? '').trim(); }
function clamp(value, min = 0, max = 1) { return Math.max(min, Math.min(max, Number(value) || 0)); }

function expectedGroups(options = {}) {
  const direct = Number(options.expectedPersonGroups || 0);
  const env = Number(process.env.ULTRON_M3_UNIVERSAL_EXPECTED_PERSON_GROUPS || 0);
  const value = Number.isFinite(direct) && direct > 0 ? direct : env;
  return Number.isFinite(value) ? Math.max(0, Math.min(20, Math.floor(value))) : 0;
}

function sheetWidth(rows = []) {
  return Math.max(0, ...rows.map((row) => Array.isArray(row) ? row.length : 0));
}

function trailingRegionBlank(rows, headerRowIndex, startIndex, endIndex) {
  for (let r = headerRowIndex; r < rows.length; r++) {
    for (let c = startIndex; c <= endIndex; c++) {
      if (text(rows?.[r]?.[c])) return false;
    }
  }
  return true;
}

function ordinalLabel(ordinal) {
  const mod100 = ordinal % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${ordinal}th`;
  if (ordinal % 10 === 1) return `${ordinal}st`;
  if (ordinal % 10 === 2) return `${ordinal}nd`;
  if (ordinal % 10 === 3) return `${ordinal}rd`;
  return `${ordinal}th`;
}

function syntheticColumn(index, header, role, ordinal) {
  return {
    index,
    header,
    normalizedHeader: schemaTools.normalizeHeader(header),
    role,
    confidence: 0.92,
    score: 92,
    scores: { [role]: 92 },
    slotHint: ordinal,
    signature: {
      samples: 0,
      nonEmptyRatio: 0,
      uniqueRatio: 0,
      email: 0,
      phone: 0,
      linkedin: 0,
      linkedinPerson: 0,
      linkedinCompany: 0,
      url: 0,
      numeric: 0,
    },
    continuityRecovery: true,
  };
}

function descriptor(column, field) {
  return {
    index: column.index,
    header: column.header,
    confidence: 0.9,
    role: field,
    continuityRecovery: true,
  };
}

function inferContinuationTemplate(schema) {
  const people = [...(schema.personGroups || [])].sort((a, b) => (a.ordinal || 999) - (b.ordinal || 999));
  const nonAnchor = people.filter((group) => Number(group.ordinal || 0) > 1);
  const last = nonAnchor[nonAnchor.length - 1] || null;
  if (last) {
    const fields = ['name', 'role', 'linkedin', 'phone', 'email'].filter((field) => last.fields?.[field]);
    if (fields.includes('name') && (fields.includes('phone') || fields.includes('email'))) return fields;
  }

  // Canonical continuation for sheets whose anchor identity is separated from its
  // E:G contact fields: added POCs are name + phone + email, not cloned LinkedIn.
  const first = people.find((group) => Number(group.ordinal || 0) === 1) || people[0];
  if (first?.fields?.name && (first?.fields?.phone || first?.fields?.email)) {
    return ['name', 'phone', 'email'];
  }
  return null;
}

function nextStartIndex(rows, schema) {
  const maxColumn = Math.max(-1, ...(schema.columns || []).map((column) => Number(column.index)).filter(Number.isInteger));
  return Math.max(sheetWidth(rows), maxColumn + 1);
}

function headerFor(field, ordinal) {
  if (field === 'name') return ordinal === 3 ? '3rd POC' : `${ordinalLabel(ordinal)} POC Name`;
  if (field === 'phone') return 'Phone no';
  if (field === 'email') return 'Email ID';
  if (field === 'linkedin') return 'LinkedIn Id';
  if (field === 'role') return 'Designation';
  return field;
}

function recover(rows, schema, options = {}) {
  if (!schema || !Array.isArray(schema.columns)) return schema;
  const expected = expectedGroups(options);
  const current = Array.isArray(schema.personGroups) ? schema.personGroups.length : 0;
  if (!expected || expected <= current) return schema;

  const template = inferContinuationTemplate(schema);
  if (!template?.length || !template.includes('name')) return schema;

  const usedOrdinals = new Set((schema.personGroups || []).map((group) => Number(group.ordinal || 0)).filter(Boolean));
  // Continuity recovery is for missing TRAILING groups only. If ordinals already
  // contain holes or a non-contiguous shape, abstain rather than guessing ownership.
  for (let ordinal = 1; ordinal <= current; ordinal++) {
    if (!usedOrdinals.has(ordinal)) return schema;
  }

  const missing = expected - current;
  const start = nextStartIndex(rows, schema);
  const end = start + missing * template.length - 1;
  if (!trailingRegionBlank(rows, schema.headerRowIndex, start, end)) return schema;

  const recoveries = [];
  const headerRepairs = [];
  let cursor = start;

  for (let ordinal = 1; ordinal <= expected; ordinal++) {
    if (usedOrdinals.has(ordinal)) continue;

    const group = {
      id: `person-${ordinal}-continuity-${cursor}`,
      kind: 'person',
      ordinal,
      seedIndex: cursor,
      fields: {},
      alternates: [],
      confidence: 0.86,
      continuityRecovery: true,
    };

    for (const field of template) {
      const header = headerFor(field, ordinal);
      const column = syntheticColumn(cursor, header, field, ordinal);
      schema.columns.push(column);
      group.fields[field] = descriptor(column, field);
      headerRepairs.push({
        rowNumber: schema.headerRowNumber,
        columnIndex: cursor,
        value: header,
        field,
        ordinal,
        groupId: group.id,
        source: 'explicit-expected-person-group-continuity',
      });
      cursor++;
    }

    schema.personGroups.push(group);
    recoveries.push({
      groupId: group.id,
      ordinal,
      indexes: Object.values(group.fields).map((field) => field.index),
      fields: Object.keys(group.fields),
      confidence: group.confidence,
      source: 'explicit-expected-person-group-continuity',
    });
  }

  schema.personGroups.sort((a, b) => (a.ordinal || 999) - (b.ordinal || 999) || (a.seedIndex ?? 999) - (b.seedIndex ?? 999));
  schema.columns.sort((a, b) => a.index - b.index);
  schema.entityGroups = [...schema.personGroups, ...(schema.companyGroups || [])];
  schema.continuityRecoveries = [...(schema.continuityRecoveries || []), ...recoveries];
  schema.structuralRecoveries = [...(schema.structuralRecoveries || []), ...recoveries];
  schema.headerRepairs = [...(schema.headerRepairs || []), ...headerRepairs];
  schema.expectedPersonGroups = expected;
  schema.schemaVersion = Math.max(5, Number(schema.schemaVersion || 1));
  schema.fingerprint = schema.columns.map((column) => schemaTools.normalizeHeader(column.header)).join('|');

  const groupEvidence = schema.personGroups.reduce((sum, group) => sum + Number(group.confidence || 0), 0);
  schema.confidence = clamp(Math.max(Number(schema.confidence || 0), 0.28 + Math.min(0.6, groupEvidence * 0.16)));
  return schema;
}

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];
  const originalInfer = schemaTools.inferSchema.bind(schemaTools);
  schemaTools.inferSchema = function continuityRecoveredSchema(rows, options = {}) {
    return recover(rows, originalInfer(rows, options), options);
  };
  const api = Object.freeze({ recover, expectedGroups, inferContinuationTemplate, trailingRegionBlank });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = {
  install,
  recover,
  expectedGroups,
  inferContinuationTemplate,
  trailingRegionBlank,
};
