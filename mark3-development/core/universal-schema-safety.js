'use strict';
function assess(schema) {
  const issues = [], owners = new Map();
  for (const group of schema.personGroups || []) {
    for (const [field, descriptor] of Object.entries(group.fields || {})) {
      if (!['name','linkedin','phone','email','role'].includes(field)) continue;
      const previous = owners.get(descriptor.index);
      if (previous && previous !== group.id) issues.push(`Column ${descriptor.header || descriptor.index + 1} belongs to more than one contact block. Which block owns it?`);
      owners.set(descriptor.index, group.id);
      for (const other of group.alternates || []) {
        if (other.field === field && other.index !== descriptor.index && Number(other.confidence) >= Number(descriptor.confidence) - 0.1) {
          issues.push(`Which ${field} column belongs to contact ${group.ordinal}: "${descriptor.header}" or "${other.header}"?`);
        }
      }
    }
  }
  if (Number(schema.confidence || 0) < 0.55) issues.push('Which columns identify the company, person, phone and email?');
  return { safe: issues.length === 0, confidence: Number(schema.confidence || 0), questions: [...new Set(issues)] };
}
function assertSafe(schema) {
  const assessment = assess(schema);
  if (!assessment.safe) throw Object.assign(new Error(assessment.questions[0]), {
    code: 'UNIVERSAL_SCHEMA_AMBIGUOUS', subsystem: 'SCHEMA', errorType: 'SCHEMA',
    completionState: 'NEEDS_SCHEMA_CLARIFICATION', questions: assessment.questions,
    hint: assessment.questions[0],
  });
  return assessment;
}
module.exports = { assess, assertSafe };
