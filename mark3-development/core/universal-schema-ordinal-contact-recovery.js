'use strict';

// Recover person/contact groups whose identity header names an entity + ordinal
// but omits an explicit "name" token, e.g. "3rd POC", "Contact 4",
// "Decision Maker 5". This is deterministic and structural: field headers such
// as "Phone 3" or "Email 3" never become identity seeds by themselves.

const schemaTools = require('./universal-sheet-schema');

const INSTALL_FLAG = Symbol.for('ultron.mark3.universalSchemaOrdinalContactRecovery.installed');
const ENTITY_TOKEN = /\b(?:poc|person|contact|decision maker|candidate|representative|rep|recruiter|employee|lead)\b/;
const FIELD_TOKEN = /\b(?:phone|mobile|telephone|tel|cell|email|mail|linkedin|linked|profile|role|title|designation|position|function|department|company|organisation|organization|employer|business|website|web site|domain|location|city|state|country|status|source|notes?|remarks?|comments?)\b/;

function canonicalPersonField(role) {
  if (role === 'linkedin_person' || role === 'linkedin') return 'linkedin';
  return ['name', 'role', 'phone', 'email', 'company', 'location'].includes(role) ? role : null;
}

function ordinalIdentityColumn(column) {
  if (!column || !column.slotHint) return false;
  const header = schemaTools.normalizeHeader(column.header || '');
  if (!header || !ENTITY_TOKEN.test(header)) return false;
  if (FIELD_TOKEN.test(header)) return false;
  return column.role === 'unknown' || column.role === 'name' || Number(column.score || 0) < 40;
}

function descriptor(column, field) {
  return {
    index: column.index,
    header: column.header,
    confidence: Math.max(Number(column.confidence || 0), field === 'name' ? 0.9 : 0.72),
    role: field === 'name' ? 'name' : column.role,
    ordinalContactRecovery: true,
  };
}

function groupConfidence(group) {
  const fields = group?.fields || {};
  const identity = Number(Boolean(fields.name)) + Number(Boolean(fields.linkedin));
  const contacts = Number(Boolean(fields.phone)) + Number(Boolean(fields.email));
  const role = Number(Boolean(fields.role));
  return Math.min(1, 0.24 + identity * 0.29 + contacts * 0.12 + role * 0.08);
}

function recover(schema) {
  if (!schema?.columns?.length) return schema;
  const columns = schema.columns;
  const groups = Array.isArray(schema.personGroups) ? [...schema.personGroups] : [];
  const recoveries = [];

  const seeds = columns.filter(ordinalIdentityColumn).sort((a, b) => a.index - b.index);
  for (const seed of seeds) {
    const ordinal = Number(seed.slotHint);
    let group = groups.find((candidate) => Number(candidate.ordinal) === ordinal) || null;
    if (!group) {
      group = {
        id: `person-${ordinal}-${seed.index}`,
        kind: 'person',
        ordinal,
        seedIndex: seed.index,
        fields: {},
        alternates: [],
        confidence: 0,
      };
      groups.push(group);
    }

    const existingName = group.fields?.name;
    if (!existingName || Number(existingName.confidence || 0) < 0.9) {
      group.fields.name = descriptor(seed, 'name');
      group.seedIndex = seed.index;
    }

    const nextSeedIndex = seeds.find((candidate) => candidate.index > seed.index)?.index ?? Infinity;
    const maxIndex = Math.min(nextSeedIndex - 1, seed.index + 6);
    const attached = ['name'];

    for (const column of columns) {
      if (column.index <= seed.index || column.index > maxIndex) continue;
      if (ordinalIdentityColumn(column)) break;
      const field = canonicalPersonField(column.role);
      if (!field || field === 'name') continue;
      if (column.slotHint && Number(column.slotHint) !== ordinal) continue;

      const current = group.fields[field];
      if (!current || Number(column.confidence || 0) > Number(current.confidence || 0)) {
        if (current) group.alternates = [...(group.alternates || []), { field, ...current }];
        group.fields[field] = descriptor(column, field);
        attached.push(field);
      }
    }

    group.confidence = Math.max(Number(group.confidence || 0), groupConfidence(group));
    recoveries.push({
      groupId: group.id,
      ordinal,
      identityColumn: seed.index,
      header: seed.header,
      fields: [...new Set(attached)],
      reason: 'ordinal-entity-header',
    });
  }

  schema.personGroups = groups
    .filter((group) => Object.keys(group.fields || {}).length)
    .sort((a, b) => (a.ordinal || 999) - (b.ordinal || 999) || (a.seedIndex ?? 999) - (b.seedIndex ?? 999));
  schema.entityGroups = [...schema.personGroups, ...(schema.companyGroups || [])];
  schema.ordinalContactRecoveries = recoveries;
  if (recoveries.length) schema.structuralRecoveries = [...(schema.structuralRecoveries || []), ...recoveries];
  return schema;
}

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];
  const originalInfer = schemaTools.inferSchema.bind(schemaTools);
  schemaTools.inferSchema = function ordinalRecoveredSchema(rows, options = {}) {
    return recover(originalInfer(rows, options));
  };
  const api = Object.freeze({ recover, ordinalIdentityColumn, canonicalPersonField });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = { install, recover, ordinalIdentityColumn, canonicalPersonField };
