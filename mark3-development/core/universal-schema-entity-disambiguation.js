'use strict';

// Resolve entity ownership after base schema inference. A bare email/phone pair
// is not automatically a person. When a worksheet has strong company identity
// and no person identity signal, generic contact fields belong to the company
// unless their headers explicitly describe a person/contact/POC.

const schemaTools = require('./universal-sheet-schema');

const INSTALL_FLAG = Symbol.for('ultron.mark3.universalSchemaEntityDisambiguation.installed');

function personSpecificHeader(value) {
  const header = schemaTools.normalizeHeader(value);
  return /\b(person|poc|decision maker|decision|candidate|recruiter|employee|representative|rep|lead|contact person|contact name)\b/.test(header);
}

function genericContactOnly(group) {
  const fields = Object.keys(group?.fields || {});
  if (!fields.length || fields.some((field) => ['name', 'linkedin'].includes(field))) return false;
  return fields.every((field) => ['email', 'phone', 'role', 'location'].includes(field));
}

function nearestCompanyGroup(schema, personGroup) {
  const seed = Number.isInteger(personGroup?.seedIndex) ? personGroup.seedIndex : 0;
  return [...(schema.companyGroups || [])]
    .sort((a, b) => Math.abs((a.seedIndex ?? 0) - seed) - Math.abs((b.seedIndex ?? 0) - seed))[0] || null;
}

function descriptorHeader(descriptor) {
  return descriptor?.header || '';
}

function reconcile(schema) {
  if (!schema?.companyGroups?.length || !schema?.personGroups?.length) return schema;
  const retained = [];
  const changes = [];

  for (const group of schema.personGroups) {
    if (!genericContactOnly(group)) {
      retained.push(group);
      continue;
    }
    const explicitPersonOwnership = Object.values(group.fields || {}).some((field) => personSpecificHeader(descriptorHeader(field)));
    if (explicitPersonOwnership) {
      retained.push(group);
      continue;
    }

    const company = nearestCompanyGroup(schema, group);
    if (!company) {
      retained.push(group);
      continue;
    }
    let moved = 0;
    for (const field of ['email', 'phone', 'location']) {
      const source = group.fields?.[field];
      if (!source || company.fields?.[field]) continue;
      company.fields[field] = { ...source, entityOwnershipRecovery: true };
      moved++;
    }
    if (!moved) {
      retained.push(group);
      continue;
    }
    changes.push({ from: group.id, to: company.id, fields: ['email', 'phone', 'location'].filter((field) => group.fields?.[field] && company.fields?.[field]?.entityOwnershipRecovery) });
  }

  schema.personGroups = retained;
  schema.entityGroups = [...retained, ...(schema.companyGroups || [])];
  schema.entityOwnershipRecoveries = changes;
  return schema;
}

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];
  const originalInfer = schemaTools.inferSchema.bind(schemaTools);
  schemaTools.inferSchema = function disambiguatedSchema(rows, options = {}) {
    return reconcile(originalInfer(rows, options));
  };
  const api = Object.freeze({ reconcile, genericContactOnly, personSpecificHeader });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = { install, reconcile, genericContactOnly, personSpecificHeader };
