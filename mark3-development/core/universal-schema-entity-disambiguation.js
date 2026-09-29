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

function descriptorIndex(descriptor) {
  return Number.isInteger(descriptor) ? descriptor : descriptor?.index;
}

function rowSemanticAnchorHints(schema) {
  const hints = [];
  const columns = schema?.columns || [];
  for (const linkColumn of columns) {
    const header = schemaTools.normalizeHeader(linkColumn.header || '');
    if (!/\b(?:company|organisation|organization|employer|business)\b/.test(header)) continue;
    if (!/\b(?:link|linkedin|profile|url)\b/.test(header)) continue;
    if (Number(linkColumn.signature?.linkedinPerson || 0) <= 0) continue;

    const company = [...(schema.companyGroups || [])]
      .filter((group) => Number.isInteger(descriptorIndex(group.fields?.company)))
      .sort((a, b) => Math.abs(descriptorIndex(a.fields.company) - linkColumn.index)
        - Math.abs(descriptorIndex(b.fields.company) - linkColumn.index))[0];
    const nameColumnIndex = descriptorIndex(company?.fields?.company);
    if (!Number.isInteger(nameColumnIndex) || Math.abs(nameColumnIndex - linkColumn.index) > 2) continue;

    hints.push({
      kind: 'person-anchor',
      nameColumnIndex,
      linkedinColumnIndex: linkColumn.index,
      reason: 'company-header-person-linkedin-contradiction',
    });
  }
  return hints;
}

function reconcile(schema) {
  if (!schema?.companyGroups?.length || !schema?.personGroups?.length) return schema;
  const retained = [];
  const changes = [];
  const semanticHints = rowSemanticAnchorHints(schema);
  const semanticLinkedinColumns = new Set(semanticHints.map((hint) => hint.linkedinColumnIndex));

  // A value-shaped personal LinkedIn URL under a misleading company-link
  // header is source/anchor evidence. It must not become the identity field of
  // the nearest explicit POC group (for Aryatry that would incorrectly make B
  // satisfy POC-1 in C/D/E).
  for (const group of schema.personGroups) {
    const linkedinIndex = descriptorIndex(group.fields?.linkedin);
    if (!semanticLinkedinColumns.has(linkedinIndex)) continue;
    if (!group.fields?.name || descriptorIndex(group.fields.name) <= linkedinIndex) continue;
    delete group.fields.linkedin;
    changes.push({
      from: group.id,
      to: 'row-person-anchor',
      fields: ['linkedin'],
      reason: 'company-header-person-linkedin-contradiction',
    });
  }

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
  schema.rowSemanticAnchorHints = semanticHints;
  return schema;
}

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];
  const originalInfer = schemaTools.inferSchema.bind(schemaTools);
  schemaTools.inferSchema = function disambiguatedSchema(rows, options = {}) {
    return reconcile(originalInfer(rows, options));
  };
  const api = Object.freeze({ reconcile, genericContactOnly, personSpecificHeader, rowSemanticAnchorHints });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

module.exports = { install, reconcile, genericContactOnly, personSpecificHeader, rowSemanticAnchorHints };
