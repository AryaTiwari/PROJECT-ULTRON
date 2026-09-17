'use strict';

const schemaTools = require('./universal-sheet-schema');
const planner = require('./universal-enrichment-planner');
const ranker = require('./universal-authority-ranker');

function analyzeSheet(rows, options = {}) {
  const schema = schemaTools.inferSchema(rows, options.schema || {});
  const rowPlans = [];
  const stats = {
    dataRows: 0,
    rowsWithAnchor: 0,
    rowsWithoutAnchor: 0,
    personGroups: schema.personGroups.length,
    companyGroups: schema.companyGroups.length,
    openPersonSlots: 0,
    partialPersonSlots: 0,
    completePersonSlots: 0,
    selfEnrichmentRows: 0,
    personEmployerContactRows: 0,
    companyContactRows: 0,
    unknownRows: 0,
  };
  const start = schema.headerRowIndex + 1;
  const rowLimit = Number.isFinite(Number(options.rowLimit)) && Number(options.rowLimit) > 0
    ? Math.floor(Number(options.rowLimit))
    : Infinity;
  for (let rowIndex = start; rowIndex < rows.length && rowPlans.length < rowLimit; rowIndex++) {
    const row = rows[rowIndex] || [];
    if (!row.some((value) => String(value ?? '').trim())) continue;
    const plan = planner.planRow(row, schema, options);
    rowPlans.push({ rowIndex, rowNumber: rowIndex + 1, row, plan });
    stats.dataRows++;
    if (plan.anchor) stats.rowsWithAnchor++; else stats.rowsWithoutAnchor++;
    stats.openPersonSlots += plan.groups.open.length;
    stats.partialPersonSlots += plan.groups.partial.length;
    stats.completePersonSlots += plan.groups.complete.length;
    if (plan.mode === 'self-enrich-person' || plan.mode === 'person-enrichment') stats.selfEnrichmentRows++;
    else if (plan.mode === 'person-employer-to-contacts') stats.personEmployerContactRows++;
    else if (plan.mode === 'company-to-contacts' || plan.mode === 'company-enrichment') stats.companyContactRows++;
    else stats.unknownRows++;
  }
  return { schema, rowPlans, stats, deterministic: true, modelCalls: 0 };
}

function rowEvidence(planRecord) {
  const plan = planRecord?.plan || planRecord;
  return {
    mode: plan.mode,
    anchorType: plan.anchor?.type || null,
    anchorGroup: plan.anchor?.group?.id || null,
    anchorLinkedin: plan.anchor?.snapshot?.values?.linkedin || '',
    context: plan.context || {},
    openGroups: plan.groups?.open?.map((item) => item.group.id) || [],
    partialGroups: plan.groups?.partial?.map((item) => item.group.id) || [],
    warnings: plan.warnings || [],
  };
}

function planAssignments(row, schema, candidates, context = {}, options = {}) {
  return planner.assignmentPlan(row, schema, candidates, context, options);
}

function buildWriteChanges(rowNumber, assignmentResult, options = {}) {
  const changes = [];
  for (const assignment of assignmentResult?.assignments || []) {
    for (const write of assignment.writePlan?.writes || []) {
      changes.push({
        rowNumber,
        columnIndex: write.columnIndex,
        value: write.value,
        field: write.field,
        groupId: write.groupId,
        evidence: {
          candidateId: String(assignment.selection?.candidate?.apolloPersonId || assignment.selection?.candidate?.id || ''),
          candidateScore: assignment.selection?.score ?? null,
          confidence: assignment.selection?.confidence ?? null,
          proof: assignment.selection?.proof || [],
        },
      });
    }
  }
  return changes;
}

function auditCandidateSet(candidates, context = {}, options = {}) {
  const ranked = ranker.rankCandidates(candidates, context, options);
  return {
    total: ranked.total,
    eligible: ranked.eligible,
    top: ranked.ranked.slice(0, Number(options.auditLimit || 10)).map((item) => ({
      id: String(item.candidate?.apolloPersonId || item.candidate?.id || ''),
      name: item.candidate?.name || '',
      title: item.candidate?.title || '',
      score: item.score,
      confidence: item.confidence,
      components: item.components,
      proof: item.proof,
    })),
    rejected: ranked.rejected.slice(0, Number(options.auditLimit || 10)).map((item) => ({
      id: String(item.candidate?.apolloPersonId || item.candidate?.id || ''),
      name: item.candidate?.name || '',
      title: item.candidate?.title || '',
      score: item.score,
      components: item.components,
      proof: item.proof,
    })),
  };
}

function schemaSummary(schema) {
  return {
    headerRowNumber: schema.headerRowNumber,
    confidence: schema.confidence,
    personGroups: schema.personGroups.map((group) => ({
      id: group.id,
      ordinal: group.ordinal,
      confidence: group.confidence,
      fields: Object.fromEntries(Object.entries(group.fields).map(([field, descriptor]) => [field, descriptor.index])),
    })),
    companyGroups: schema.companyGroups.map((group) => ({
      id: group.id,
      ordinal: group.ordinal,
      confidence: group.confidence,
      fields: Object.fromEntries(Object.entries(group.fields).map(([field, descriptor]) => [field, descriptor.index])),
    })),
    contextColumns: Object.fromEntries(Object.entries(schema.contextColumns || {}).map(([role, columns]) => [role, columns.map((column) => column.index)])),
    structuralRecoveries: Array.isArray(schema.structuralRecoveries) ? schema.structuralRecoveries : [],
    ordinalContactRecoveries: Array.isArray(schema.ordinalContactRecoveries) ? schema.ordinalContactRecoveries : [],
    proximityRecoveries: Array.isArray(schema.proximityRecoveries) ? schema.proximityRecoveries : [],
    entityOwnershipRecoveries: Array.isArray(schema.entityOwnershipRecoveries) ? schema.entityOwnershipRecoveries : [],
    fingerprint: schema.fingerprint,
  };
}

module.exports = {
  analyzeSheet,
  rowEvidence,
  planAssignments,
  buildWriteChanges,
  auditCandidateSet,
  schemaSummary,
};
