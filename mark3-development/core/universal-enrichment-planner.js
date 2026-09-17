'use strict';

const schemaTools = require('./universal-sheet-schema');
const ranker = require('./universal-authority-ranker');

function text(value) {
  return String(value ?? '').trim();
}

function valueAt(row, field) {
  return Number.isInteger(field?.index) && field.index >= 0 ? text(row?.[field.index]) : '';
}

function groupSnapshot(row, group) {
  const values = {};
  for (const [field, descriptor] of Object.entries(group?.fields || {})) values[field] = valueAt(row, descriptor);
  const linkedinKind = schemaTools.linkedInKind(values.linkedin);
  const identitySignals = [values.name, values.linkedin].filter(Boolean).length;
  const contactSignals = [values.phone, values.email].filter(Boolean).length;
  const expectedContacts = ['phone','email'].filter((field) => group?.fields?.[field]).length;
  const expectedIdentity = ['name','linkedin'].filter((field) => group?.fields?.[field]).length;
  const populated = Object.values(values).filter(Boolean).length;
  return {
    groupId: group.id,
    kind: group.kind,
    ordinal: group.ordinal,
    values,
    linkedinKind,
    populated,
    empty: populated === 0,
    hasIdentity: identitySignals > 0,
    strongPersonIdentity: Boolean(values.linkedin && linkedinKind === 'linkedin_person') || Boolean(values.name && values.role),
    strongCompanyIdentity: Boolean(values.linkedin && linkedinKind === 'linkedin_company') || Boolean(values.company && (values.website || values.linkedin)),
    identityComplete: expectedIdentity ? identitySignals >= expectedIdentity : identitySignals > 0,
    contactsComplete: expectedContacts ? contactSignals >= expectedContacts : true,
    missingFields: Object.entries(group?.fields || {}).filter(([field, descriptor]) => descriptor && !values[field]).map(([field]) => field),
  };
}

function companySnapshot(row, group) {
  return groupSnapshot(row, group);
}

function rowContext(row, schema) {
  const context = {};
  for (const [role, columns] of Object.entries(schema?.contextColumns || {})) {
    const values = (columns || []).map((column) => text(row?.[column.index])).filter(Boolean);
    if (!values.length) continue;
    context[role] = values.join(' | ');
  }
  return context;
}

function anchorScore(snapshot, group, row) {
  let score = 0;
  const proof = [];
  if (snapshot.linkedinKind === 'linkedin_person') { score += 100; proof.push('personal-linkedin'); }
  if (snapshot.linkedinKind === 'linkedin_company') { score += 100; proof.push('company-linkedin'); }
  if (snapshot.values.name) { score += 25; proof.push('name'); }
  if (snapshot.values.company) { score += 25; proof.push('company'); }
  if (snapshot.values.role) { score += 10; proof.push('role'); }
  if (snapshot.values.website) { score += 12; proof.push('website'); }
  if (group?.ordinal === 1) { score += 8; proof.push('first-group'); }
  if (group?.confidence >= 0.7) score += 5;
  return { score, proof };
}

function chooseAnchor(row, schema) {
  const candidates = [];
  for (const group of schema?.personGroups || []) {
    const snapshot = groupSnapshot(row, group);
    if (!snapshot.hasIdentity) continue;
    const scored = anchorScore(snapshot, group, row);
    candidates.push({ type: snapshot.linkedinKind === 'linkedin_company' ? 'company' : 'person', group, snapshot, ...scored });
  }
  for (const group of schema?.companyGroups || []) {
    const snapshot = companySnapshot(row, group);
    if (!snapshot.hasIdentity && !snapshot.strongCompanyIdentity) continue;
    const scored = anchorScore(snapshot, group, row);
    candidates.push({ type: 'company', group, snapshot, ...scored });
  }
  candidates.sort((a, b) => b.score - a.score || (a.group.ordinal || 999) - (b.group.ordinal || 999));
  return candidates[0] || null;
}

function classifyPersonGroups(row, schema, anchor = null) {
  const out = { existing: [], partial: [], open: [], complete: [] };
  for (const group of schema?.personGroups || []) {
    const snapshot = groupSnapshot(row, group);
    const record = { group, snapshot, isAnchor: anchor?.group?.id === group.id };
    if (snapshot.empty) out.open.push(record);
    else {
      out.existing.push(record);
      if (snapshot.identityComplete && snapshot.contactsComplete) out.complete.push(record);
      else out.partial.push(record);
    }
  }
  return out;
}

function inferMode(anchor, groups) {
  if (!anchor) return 'unknown';
  const nonAnchorGroups = [...groups.open, ...groups.partial].filter((item) => !item.isAnchor);
  if (anchor.type === 'company') return nonAnchorGroups.length ? 'company-to-contacts' : 'company-enrichment';
  if (groups.existing.length <= 1 && !nonAnchorGroups.length) return 'self-enrich-person';
  if (nonAnchorGroups.length) return 'person-employer-to-contacts';
  return 'person-enrichment';
}

function planRow(row, schema, options = {}) {
  const anchor = chooseAnchor(row, schema);
  const groups = classifyPersonGroups(row, schema, anchor);
  const mode = inferMode(anchor, groups);
  const targets = [...groups.partial, ...groups.open]
    .filter((item) => !(item.isAnchor && mode === 'person-employer-to-contacts'))
    .sort((a, b) => (a.group.ordinal || 999) - (b.group.ordinal || 999));
  const context = rowContext(row, schema);
  const warnings = [];
  if (!anchor) warnings.push('no-reliable-anchor');
  if (anchor?.type === 'person' && anchor.snapshot.linkedinKind !== 'linkedin_person') warnings.push('person-anchor-without-person-linkedin');
  if (schema.confidence < 0.55) warnings.push('low-schema-confidence');
  const confidence = Math.max(0, Math.min(1,
    schema.confidence * 0.55
    + (anchor ? Math.min(1, anchor.score / 120) * 0.35 : 0)
    + (warnings.length ? 0 : 0.1)
  ));
  return {
    mode,
    confidence,
    anchor,
    context,
    groups,
    targets,
    targetCount: targets.filter((item) => item.snapshot.empty).length,
    repairCount: targets.filter((item) => !item.snapshot.empty).length,
    warnings,
    deterministic: true,
  };
}

function expectedPersonFields(group) {
  return ['name','role','linkedin','phone','email','company'].filter((field) => group?.fields?.[field]);
}

function normalizeName(value) {
  const base = String(value || '')
    .replace(/\s+[—–]\s+.*$/, '')
    .replace(/\s*\([^)]{2,120}\)\s*$/, '')
    .trim();
  return ranker.normalize(base).replace(/\b(?:mr|mrs|ms|dr)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function samePerson(existing = {}, person = {}) {
  const existingLinkedin = ranker.linkedinKey(existing.linkedin || '');
  const candidateLinkedin = ranker.linkedinKey(person.linkedinUrl || person.linkedin || person.linkedin_url || '');
  if (existingLinkedin && candidateLinkedin) return existingLinkedin === candidateLinkedin;
  const a = normalizeName(existing.name || '');
  const b = normalizeName(person.name || [person.first_name, person.last_name].filter(Boolean).join(' '));
  return Boolean(a && b && a === b);
}

function personValues(person = {}) {
  return {
    name: text(person.name || [person.first_name, person.last_name].filter(Boolean).join(' ')),
    role: text(person.title || person.role || person.designation),
    linkedin: text(person.linkedinUrl || person.linkedin_url || person.linkedin),
    phone: text(person.phone || person.phoneNumber || person.mobile),
    email: text(person.email || person.workEmail || person.businessEmail),
    company: text(person.organizationName || person.organization_name || person.organization?.name),
  };
}

function safeWritesForGroup(row, group, person, options = {}) {
  const snapshot = groupSnapshot(row, group);
  const values = personValues(person);
  const writes = [];
  const conflicts = [];
  const existingIdentity = snapshot.hasIdentity;
  if (existingIdentity && !samePerson(snapshot.values, person)) {
    conflicts.push('identity-conflict');
    return { writes, conflicts, allowed: false };
  }
  for (const field of expectedPersonFields(group)) {
    const descriptor = group.fields[field];
    const current = snapshot.values[field];
    const next = values[field];
    if (!next) continue;
    if (!current) {
      writes.push({ field, columnIndex: descriptor.index, value: next, groupId: group.id });
      continue;
    }
    // Existing data is immutable by default. A caller may explicitly allow a verified
    // same-person role normalization, but phones/emails are never silently replaced.
    if (field === 'role' && options.allowRoleNormalization && samePerson(snapshot.values, person) && ranker.normalize(current) !== ranker.normalize(next)) {
      writes.push({ field, columnIndex: descriptor.index, value: next, groupId: group.id, replaces: current });
    }
  }
  return { writes, conflicts, allowed: true };
}

function assignmentPlan(row, schema, candidates = [], context = {}, options = {}) {
  const plan = planRow(row, schema, options);
  const openTargets = plan.targets.filter((item) => item.snapshot.empty);
  if (!openTargets.length) return { ...plan, ranking: null, assignments: [] };
  const enrichedContext = {
    ...plan.context,
    ...context,
    anchorLinkedin: plan.anchor?.snapshot?.values?.linkedin || context.anchorLinkedin,
  };
  const ranked = ranker.selectCandidates(candidates, enrichedContext, openTargets.length, options.ranking || {});
  const assignments = ranked.selected.map((selection, index) => ({
    target: openTargets[index],
    selection,
    writePlan: safeWritesForGroup(row, openTargets[index].group, selection.candidate, options),
  }));
  return { ...plan, ranking: ranked, assignments };
}

module.exports = {
  groupSnapshot,
  companySnapshot,
  rowContext,
  chooseAnchor,
  classifyPersonGroups,
  planRow,
  expectedPersonFields,
  normalizeName,
  samePerson,
  personValues,
  safeWritesForGroup,
  assignmentPlan,
};
