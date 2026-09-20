'use strict';
const sheets = require('./google-sheets-operator');
const text = value => String(value ?? '').trim();

function conflict(reason) {
  return Object.assign(new Error('The worksheet changed during enrichment. Reinspect the affected row before retrying.'), {
    code: 'UNIVERSAL_LIVE_WRITE_CONFLICT', subsystem: 'IDENTITY', errorType: 'CONFLICT',
    stage: 'live-write-validation', reason,
  });
}

async function writeVerifiedRow(source, rowNumber, expectedRow, changes) {
  if (!changes.length) return { updatedCells: 0 };
  const quoted = sheets.quoteSheet(source.sheetName);
  const headerNumber = source.schema.headerRowNumber;
  const expectedHeader = source.rows[headerNumber - 1] || [];
  // Recheck headers as well as row ownership; a concurrent column insertion
  // must not redirect otherwise valid contacts to the wrong destinations.
  const [headers, rows] = await sheets.batchValues(source.spreadsheetId, [
    `${quoted}!${headerNumber}:${headerNumber}`, `${quoted}!${rowNumber}:${rowNumber}`,
  ]);
  const liveHeader = headers[0] || [];
  if (Array.from({ length: Math.max(expectedHeader.length, liveHeader.length) }, (_, i) => i)
    .some(i => text(expectedHeader[i]) !== text(liveHeader[i]))) throw conflict('schema-changed');
  const liveRow = rows[0] || [];
  // Only compare inferred columns. Unrelated annotations may be edited freely.
  for (const column of source.schema.columns || []) {
    if (text(expectedRow[column.index]) !== text(liveRow[column.index])) {
      if (/^linkedin/.test(column.role || '') && /linkedin\.com\//i.test(text(expectedRow[column.index]))) {
        const links = await sheets.linkedInHyperlinks(source.spreadsheetId, source.sheetName, column.index, rowNumber);
        if (text(links.get(rowNumber)) === text(expectedRow[column.index])) continue;
      }
      throw conflict('row-owner-or-value-changed');
    }
  }
  for (const change of changes) {
    const column = (source.schema.columns || []).find(column => sheets.cellRange(source.sheetName, rowNumber, column.index) === change.range);
    if (!column) throw conflict('destination-outside-verified-row');
    const current = text(liveRow[column.index]);
    if (!current || current === text(change.value)) continue;
    const planner = require('./universal-enrichment-planner');
    const normalization = require('./universal-contact-normalization');
    const group = (source.schema.personGroups || []).find(group => group.fields.name?.index === column.index);
    const upgrade = group && !group.fields.role && !planner.hasEmbeddedDesignation(current)
      && normalization.splitIdentity(change.value).designation
      && planner.normalizeName(current) === planner.normalizeName(change.value);
    if (!upgrade) throw conflict('populated-destination');
  }
  const result = await sheets.writeCells(source.spreadsheetId, changes);
  require('./universal-run-context').commit(source.spreadsheetId, changes);
  return result;
}
module.exports = { writeVerifiedRow };
