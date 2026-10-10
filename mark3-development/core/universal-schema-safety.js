'use strict';

// Deterministic schema safety for universal worksheets.
//
// UNIVERSAL_SCHEMA_AMBIGUOUS is a LAST-RESORT condition (Phase 10): it may
// only fire when two or more candidate mappings remain GENUINELY equivalent
// after every deterministic strategy has been applied. The following are NOT
// ambiguity and never raise it:
//   - requested contact columns that do not exist in the worksheet (partial
//     schemas are valid; missing columns simply cannot be written to),
//   - successful structural/continuity/ordinal/proximity recoveries,
//   - populated or empty cell values in identity columns,
//   - low overall confidence (that is a separate, diagnostics-rich condition:
//     UNIVERSAL_SCHEMA_CONFIDENCE_TOO_LOW).
//
// Every thrown error carries a structured diagnostics object (Phase 18):
// worksheet, header row, candidate columns, normalized headers, competing
// mappings, scores, resolution attempts, reason and recoverable flag.

const schemaTools = require('./universal-sheet-schema');

const PERSON_FIELDS = Object.freeze(['name', 'linkedin', 'phone', 'email', 'role']);
const TIE_MARGIN = 0.1;
const SCORE_MARGIN = 10;

function num(value) { return Number(value || 0); }

function columnLetters(index) {
  let n = Number(index) + 1;
  let out = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    out = String.fromCharCode(65 + m) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || '?';
}

function columnLabel(descriptor) {
  const index = Number(descriptor?.index);
  if (!Number.isInteger(index)) return String(descriptor?.header || '?');
  return `${columnLetters(index)} ("${descriptor.header || ''}")`;
}

function resolutionAttempts(schema) {
  return [
    { strategy: 'header-normalization', applied: true },
    { strategy: 'semantic-alias-resolution', applied: true },
    { strategy: 'explicit-poc-index-grouping', applied: true, groups: (schema.personGroups || []).map((g) => ({ ordinal: g.ordinal ?? null, seedIndex: g.seedIndex ?? null })) },
    { strategy: 'structural-hardening-recovery', applied: (schema.structuralRecoveries || []).length > 0, recoveries: (schema.structuralRecoveries || []).length },
    { strategy: 'ordinal-contact-recovery', applied: (schema.ordinalContactRecoveries || []).length > 0, recoveries: (schema.ordinalContactRecoveries || []).length },
    { strategy: 'proximity-recovery', applied: (schema.proximityRecoveries || []).length > 0, recoveries: (schema.proximityRecoveries || []).length },
    { strategy: 'entity-ownership-reconciliation', applied: (schema.entityOwnershipRecoveries || []).length > 0, changes: (schema.entityOwnershipRecoveries || []).length },
    { strategy: 'explicit-expected-group-continuity', applied: (schema.continuityRecoveries || []).length > 0, recoveries: (schema.continuityRecoveries || []).length },
  ];
}

function groupOwners(schema) {
  const owners = new Map();
  const conflicts = [];
  for (const group of schema.personGroups || []) {
    for (const [field, descriptor] of Object.entries(group.fields || {})) {
      if (!PERSON_FIELDS.includes(field)) continue;
      if (!Number.isInteger(Number(descriptor?.index))) continue;
      const key = Number(descriptor.index);
      const previous = owners.get(key);
      if (previous && previous.groupId !== group.id) {
        conflicts.push({
          columnIndex: key,
          header: descriptor.header || '',
          claims: [previous, { groupId: group.id, ordinal: group.ordinal ?? null, field }],
        });
      } else {
        owners.set(key, { groupId: group.id, ordinal: group.ordinal ?? null, field, header: descriptor.header || '' });
      }
    }
  }
  return { owners, conflicts };
}

// Deterministic ownership pre-resolution: when one claiming group's ordinal
// matches the column's explicit POC index and the other does not, the explicit
// index wins and there is no ambiguity.
function resolveConflicts(conflicts) {
  const resolved = [];
  const unresolved = [];
  for (const conflict of conflicts) {
    const slot = schemaTools.slotHint(conflict.header);
    const matching = conflict.claims.filter((claim) => Number(claim.ordinal || 0) === Number(slot || 0));
    if (Number(slot || 0) > 0 && matching.length === 1) {
      resolved.push({ conflict, winner: matching[0], strategy: 'explicit-poc-index' });
    } else {
      unresolved.push(conflict);
    }
  }
  return { resolved, unresolved };
}

// Genuine competing mappings: same field, different unowned column, confidence
// within the tie margin AND no decisive structural difference (different
// explicit POC index, or a materially different raw score).
function competingMappings(schema, owners) {
  const ties = [];
  for (const group of schema.personGroups || []) {
    const ordinal = Number(group.ordinal || 0);
    for (const [field, descriptor] of Object.entries(group.fields || {})) {
      for (const other of group.alternates || []) {
        if (other.field !== field) continue;
        const otherIndex = Number(other.index);
        if (!Number.isInteger(otherIndex) || otherIndex === Number(descriptor.index)) continue;
        const owner = owners.get(otherIndex);
        if (owner && owner.groupId !== group.id) continue; // owned by another group — not competing
        // Raw header scores are the honest comparison between an assigned column
        // and a rejected candidate: an assigned descriptor carries a derived
        // (group-level) confidence that is not comparable to a raw candidate's.
        // Compare like with like; fall back to confidence only when scores are
        // unavailable on either side.
        const rawScoreA = Number(descriptor.score);
        const rawScoreB = Number(other.score);
        const comparableScores = Number.isFinite(rawScoreA) && Number.isFinite(rawScoreB);
        if (comparableScores) {
          if (Math.abs(rawScoreA - rawScoreB) >= SCORE_MARGIN) continue; // decisively better header evidence
        } else {
          const delta = num(descriptor.confidence) - num(other.confidence);
          if (delta > TIE_MARGIN) continue; // decisive confidence difference — already resolved
        }
        // Explicit POC index evidence distinguishes the candidates
        // deterministically: a column numbered for a different POC cannot
        // compete for this group's field.
        const otherSlot = schemaTools.slotHint(other.header);
        const descriptorSlot = schemaTools.slotHint(descriptor.header);
        if (Number(otherSlot || 0) > 0 && Number(descriptorSlot || 0) > 0 && Number(otherSlot) !== Number(descriptorSlot)) continue;
        if (Number(otherSlot || 0) > 0 && ordinal > 0 && Number(otherSlot) !== ordinal) continue;
        const scoreA = rawScoreA;
        const scoreB = rawScoreB;
        ties.push({
          groupId: group.id,
          ordinal: ordinal || null,
          field,
          candidates: [
            { index: Number(descriptor.index), header: descriptor.header || '', confidence: num(descriptor.confidence), score: Number.isFinite(scoreA) ? scoreA : null },
            { index: otherIndex, header: other.header || '', confidence: num(other.confidence), score: Number.isFinite(scoreB) ? scoreB : null },
          ],
          reason: 'equally ranked candidate columns for the same field with no distinguishing header, index or score evidence',
        });
      }
    }
  }
  return ties;
}

function buildDiagnostics(schema, context, facts) {
  const columns = (schema.columns || []).map((column) => ({
    index: Number(column.index),
    column: columnLetters(column.index),
    header: String(column.header || '').slice(0, 120),
    normalizedHeader: schemaTools.normalizeHeader(column.header),
    role: column.role || 'unknown',
    confidence: Number(Number(column.confidence || 0).toFixed(3)),
    score: Number.isFinite(Number(column.score)) ? Number(column.score) : null,
    slotHint: Number(column.slotHint || 0) || null,
  }));
  return {
    code: facts.code,
    worksheet: context.worksheet ?? schema.worksheet ?? null,
    spreadsheetId: context.spreadsheetId ?? null,
    headerRow: schema.headerRowNumber ?? null,
    candidateColumns: columns,
    normalizedHeaders: columns.map((column) => `${column.column}=${column.normalizedHeader || '(blank)'}`),
    competingMappings: [...facts.unresolvedConflicts, ...facts.ties],
    scores: (schema.personGroups || []).map((group) => ({
      groupId: group.id,
      ordinal: group.ordinal ?? null,
      confidence: Number(num(group.confidence).toFixed(3)),
      fields: Object.fromEntries(Object.entries(group.fields || {}).map(([field, descriptor]) => [field, {
        index: Number(descriptor.index),
        header: descriptor.header || '',
        confidence: Number(num(descriptor.confidence).toFixed(3)),
        score: Number.isFinite(Number(descriptor.score)) ? Number(descriptor.score) : null,
      }])),
      alternates: (group.alternates || []).map((alternate) => ({
        field: alternate.field,
        index: Number(alternate.index),
        header: alternate.header || '',
        confidence: Number(num(alternate.confidence).toFixed(3)),
        score: Number.isFinite(Number(alternate.score)) ? Number(alternate.score) : null,
      })),
    })),
    companyGroups: (schema.companyGroups || []).map((group) => ({
      groupId: group.id,
      ordinal: group.ordinal ?? null,
      fields: Object.fromEntries(Object.entries(group.fields || {}).map(([field, descriptor]) => [field, Number(descriptor.index)])),
    })),
    resolutionAttempts: facts.resolutionAttempts,
    recovery: {
      structural: (schema.structuralRecoveries || []).length,
      ordinalContact: (schema.ordinalContactRecoveries || []).length,
      proximity: (schema.proximityRecoveries || []).length,
      entityOwnership: (schema.entityOwnershipRecoveries || []).length,
      continuity: (schema.continuityRecoveries || []).length,
    },
    partial: facts.partial,
    confidence: Number(num(schema.confidence).toFixed(3)),
    reason: facts.reason,
    recoverable: false,
  };
}

function assess(schema = {}, context = {}) {
  const { owners, conflicts } = groupOwners(schema);
  const { resolved: resolvedConflicts, unresolved: unresolvedConflicts } = resolveConflicts(conflicts);
  const ties = competingMappings(schema, owners);

  const notes = [];
  for (const item of resolvedConflicts) {
    notes.push(`Column ${columnLabel(item.conflict)} was assigned to contact ${item.winner.ordinal} by its explicit POC index.`);
  }
  const recovered = ['structuralRecoveries', 'ordinalContactRecoveries', 'proximityRecoveries', 'entityOwnershipRecoveries', 'continuityRecoveries']
    .reduce((sum, key) => sum + (Array.isArray(schema[key]) ? schema[key].length : 0), 0);
  if (recovered) notes.push(`${recovered} structural recovery step(s) resolved unfamiliar or missing columns deterministically.`);

  const expectedGroups = Number(schema.expectedPersonGroups || 0);
  const actualGroups = (schema.personGroups || []).length;
  const partial = expectedGroups > actualGroups;
  if (partial) notes.push(`The request expects ${expectedGroups} contact group(s) while the worksheet provides ${actualGroups}. Partial schemas are valid: missing groups stay unwritable and are never invented.`);

  const confidence = num(schema.confidence);
  const lowConfidence = confidence < 0.55;

  const ambiguityQuestions = [];
  for (const conflict of unresolvedConflicts) {
    const claimText = conflict.claims.map((claim) => `contact ${claim.ordinal ?? '?'} (${claim.field})`).join(' and ');
    ambiguityQuestions.push(`Column ${columnLabel({ index: conflict.columnIndex, header: conflict.header })} is claimed by more than one contact group: ${claimText}. Which group owns it?`);
  }
  for (const tie of ties) {
    const [a, b] = tie.candidates;
    ambiguityQuestions.push(`Which ${tie.field} column belongs to contact ${tie.ordinal ?? '?'}: "${a.header || columnLetters(a.index)}" or "${b.header || columnLetters(b.index)}"?`);
  }

  const questions = [...ambiguityQuestions];
  if (lowConfidence) questions.push('Which columns identify the company, person, phone and email?');

  const facts = {
    code: ambiguityQuestions.length ? 'UNIVERSAL_SCHEMA_AMBIGUOUS' : (lowConfidence ? 'UNIVERSAL_SCHEMA_CONFIDENCE_TOO_LOW' : null),
    unresolvedConflicts,
    ties,
    resolutionAttempts: resolutionAttempts(schema),
    partial,
    reason: ambiguityQuestions.length
      ? `${ties.length + unresolvedConflicts.length} candidate mapping(s) remain genuinely equivalent after every deterministic resolution strategy.`
      : (lowConfidence ? `Schema confidence ${confidence.toFixed(2)} is below the safe threshold of 0.55.` : null),
  };

  return {
    safe: ambiguityQuestions.length === 0,
    confidence,
    questions,
    ambiguityQuestions,
    lowConfidence,
    partial,
    recovered: recovered > 0,
    notes,
    diagnostics: buildDiagnostics(schema, context, facts),
  };
}

function structuredError(code, assessment, context) {
  const diagnostics = assessment.diagnostics;
  return Object.assign(new Error(assessment.questions[0] || diagnostics.reason || 'Sheet structure could not be understood safely'), {
    code,
    subsystem: 'SCHEMA',
    errorType: 'SCHEMA',
    completionState: 'NEEDS_SCHEMA_CLARIFICATION',
    questions: assessment.questions,
    hint: assessment.questions[0] || diagnostics.reason || null,
    diagnostics,
  });
}

function assertSafe(schema, context = {}) {
  const assessment = assess(schema, context);
  if (!assessment.safe) throw structuredError('UNIVERSAL_SCHEMA_AMBIGUOUS', assessment, context);
  if (assessment.lowConfidence) throw structuredError('UNIVERSAL_SCHEMA_CONFIDENCE_TOO_LOW', assessment, context);
  return assessment;
}

module.exports = { assess, assertSafe, columnLetters };
