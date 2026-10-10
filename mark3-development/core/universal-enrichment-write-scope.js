'use strict';

const text = (value) => String(value ?? '').trim();

const FIELD_ALIASES = {
  phone: /\b(?:phone|mobile|contact number|phone number)s?\b/i,
  email: /\b(?:e-?mail|email address)(?:es|s)?\b/i,
  name: /\b(?:poc|contact|person)\s+names?\b/i,
  linkedin: /\b(?:linkedin|profile url|profile link)s?\b/i,
  role: /\b(?:designation|job title|role)s?\b/i,
};

const CONTACT_FIELDS = new Set(['phone', 'email']);
const IDENTITY_SUPPORT_FIELDS = ['name', 'linkedin', 'role', 'company'];

function ordinals(input) {
  const value = text(input);
  const set = new Set();
  for (const match of value.matchAll(/\b(?:poc|contact|person)\s*[-#:]?\s*(\d{1,2})\b/gi)) set.add(Number(match[1]));
  for (const match of value.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\s+(?:poc|contact|person)/gi)) set.add(Number(match[1]));
  if (/\b(?:first|1st)\s*(?:,|and|&)\s*(?:second|2nd)\s+(?:pocs?|contacts?|persons?)\b/i.test(value)) set.add(1).add(2);
  return [...set].filter((n) => n > 0 && n < 21).sort((a, b) => a - b);
}

function requestedFields(input) {
  const value = text(input);
  const fields = Object.entries(FIELD_ALIASES)
    .filter(([, regex]) => regex.test(value))
    .map(([field]) => field);
  const pocNumberRequested = /\bnumber(?:s)?\b/i.test(value)
    && /\b(?:poc|contact|person)s?\b/i.test(value)
    && !/\b(?:employee|applicant|headcount)\s+number/i.test(value);
  if (pocNumberRequested) fields.push('phone');
  return fields.length ? [...new Set(fields)] : ['name', 'linkedin', 'role', 'email', 'phone'];
}

function ignoredFields(input) {
  const clauses = text(input)
    .split(/[.;\n]+/)
    .filter((clause) => /\b(?:ignore|do not|don't|without|leave)\b/i.test(clause));
  const out = [];
  for (const [field, regex] of Object.entries(FIELD_ALIASES)) {
    if (clauses.some((clause) => regex.test(clause))) out.push(field);
  }
  return out;
}

function descriptorIndex(descriptor) {
  return Number.isInteger(descriptor) ? descriptor : descriptor?.index;
}

function pushAllowed(allowed, group, field, extra = {}) {
  const columnIndex = descriptorIndex(group.fields?.[field]);
  if (!Number.isInteger(columnIndex)) return;
  if (allowed.some((item) => item.groupId === group.id && item.field === field && Number(item.columnIndex) === columnIndex)) return;
  allowed.push({
    groupId: group.id,
    ordinal: Number(group.ordinal || 1),
    field,
    columnIndex,
    ...extra,
  });
}

function compileContract(contract = {}, schema = {}) {
  const ignored = [...new Set((contract.ignoredFields || []).map(String))];
  const fields = [...new Set((contract.requestedFields || []).map(String))].filter((field) => !ignored.includes(field));
  const requestedOrdinals = [...new Set((contract.requestedOrdinals || []).map(Number).filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
  const groups = (schema.personGroups || []).filter(
    (group) => !requestedOrdinals.length || requestedOrdinals.includes(Number(group.ordinal || 1)),
  );
  const allowed = [];

  for (const group of groups) {
    for (const field of fields) pushAllowed(allowed, group, field);

    // Contact values must never be written into an anonymous POC slot. When a
    // user asks for phone/email and the slot is empty, the deterministic planner
    // first writes the verified owner identity into the same POC group. Treat
    // those identity coordinates as supporting ownership writes, not as an
    // unrelated scope expansion. Explicit "do not/without <field>" still wins.
    const contactRequested = fields.some((field) => CONTACT_FIELDS.has(field));
    if (contactRequested) {
      for (const field of IDENTITY_SUPPORT_FIELDS) {
        if (ignored.includes(field)) continue;
        pushAllowed(allowed, group, field, {
          supporting: true,
          supportReason: 'contact-owner-identity',
        });
      }
    }
  }

  const allowedKeys = allowed.map((item) => `${item.groupId}|${item.field}`);
  const protectedColumns = (schema.columns || [])
    .filter((column) => !allowed.some((item) => item.columnIndex === column.index))
    .map((column) => ({
      columnIndex: column.index,
      header: column.header || '',
      role: column.role || 'unknown',
    }));

  return {
    version: 2,
    requestedOrdinals,
    requestedFields: fields,
    ignoredFields: ignored,
    allowed,
    allowedKeys,
    supportingFields: [...new Set(allowed.filter((item) => item.supporting).map((item) => item.field))],
    protectedColumns,
    readScope: (schema.columns || []).map((column) => column.index),
  };
}

function compile(input, schema = {}) {
  return compileContract({
    requestedFields: requestedFields(input),
    requestedOrdinals: ordinals(input),
    ignoredFields: ignoredFields(input),
  }, schema);
}

function unmappedRequestedTargets(scope, schema = {}) {
  const groups = Array.isArray(schema.personGroups) ? schema.personGroups : [];
  const issues = [];
  for (const ordinal of scope?.requestedOrdinals || []) {
    const group = groups.find((item) => Number(item.ordinal || 1) === Number(ordinal));
    for (const field of scope?.requestedFields || []) {
      // Designations can be safely carried alongside a verified person's name
      // when the worksheet has no separate title column.
      const embeddedInName = field === 'role' && Number.isInteger(descriptorIndex(group?.fields?.name));
      if (embeddedInName) continue;
      if (!Number.isInteger(descriptorIndex(group?.fields?.[field]))) {
        issues.push({ ordinal: Number(ordinal), field, columnIndex: null, header: null });
      }
    }
  }
  return issues;
}

function allowed(scope, groupId, field, columnIndex) {
  if (!scope) return true;
  return (scope.allowed || []).some(
    (item) => item.groupId === groupId
      && item.field === field
      && Number(item.columnIndex) === Number(columnIndex),
  );
}

function assertChanges(scope, source, changes = []) {
  if (!scope) return true;
  for (const change of changes) {
    const match = String(change.range || '').match(/!([A-Z]+)(\d+)$/i);
    let columnIndex = change.columnIndex;
    if (!Number.isInteger(columnIndex) && match) {
      columnIndex = 0;
      for (const ch of match[1].toUpperCase()) columnIndex = columnIndex * 26 + ch.charCodeAt(0) - 64;
      columnIndex--;
    }
    const group = (source.schema?.personGroups || []).find((candidate) =>
      Object.values(candidate.fields || {}).some((fieldDescriptor) => descriptorIndex(fieldDescriptor) === columnIndex)
    );
    const field = change.field || Object.keys(group?.fields || {}).find(
      (key) => descriptorIndex(group.fields[key]) === columnIndex,
    );
    if (!group || !field || !allowed(scope, group.id, field, columnIndex)) {
      throw Object.assign(
        new Error(`Write blocked outside requested scope at ${change.range || columnIndex}.`),
        {
          code: 'UNIVERSAL_WRITE_SCOPE_VIOLATION',
          subsystem: 'WRITE_FIREWALL',
          errorType: 'WRITE_CONFLICT',
          stage: 'write-scope-validation',
          range: change.range,
          field,
          groupId: group?.id || null,
        },
      );
    }
  }
  return true;
}

module.exports = {
  FIELD_ALIASES,
  CONTACT_FIELDS,
  IDENTITY_SUPPORT_FIELDS,
  ordinals,
  requestedFields,
  ignoredFields,
  compileContract,
  compile,
  unmappedRequestedTargets,
  allowed,
  assertChanges,
};
