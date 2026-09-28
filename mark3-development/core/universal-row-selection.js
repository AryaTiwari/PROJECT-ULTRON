'use strict';

function integer(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeRanges(ranges = []) {
  const normalized = [];
  for (const item of Array.isArray(ranges) ? ranges : []) {
    const start = integer(item?.start ?? item?.startRow);
    const end = integer(item?.end ?? item?.endRow);
    if (!start || !end) continue;
    normalized.push({ start: Math.min(start, end), end: Math.max(start, end) });
  }
  normalized.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const range of normalized) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function countRanges(ranges = []) {
  return normalizeRanges(ranges).reduce((sum, range) => sum + (range.end - range.start + 1), 0);
}

function fromRows(rows = []) {
  const values = [...new Set((Array.isArray(rows) ? rows : [])
    .map(integer)
    .filter(Boolean))]
    .sort((a, b) => a - b);

  const ranges = [];
  for (const row of values) {
    const last = ranges[ranges.length - 1];
    if (last && row === last.end + 1) last.end = row;
    else ranges.push({ start: row, end: row });
  }

  return {
    mode: 'ranges',
    ranges,
    count: values.length,
    firstRow: values[0] || null,
    lastRow: values.at(-1) || null,
  };
}

function fromRange(startRow, endRow, count = null) {
  const start = integer(startRow);
  const end = integer(endRow);
  if (!start || !end) return null;
  const ranges = normalizeRanges([{ start, end }]);
  return {
    mode: 'ranges',
    ranges,
    count: Number.isInteger(Number(count)) && Number(count) >= 0
      ? Number(count)
      : countRanges(ranges),
    firstRow: ranges[0]?.start || null,
    lastRow: ranges.at(-1)?.end || null,
  };
}

function normalize(selection) {
  if (!selection || typeof selection !== 'object') return null;
  if (Array.isArray(selection)) return fromRows(selection);
  if (Array.isArray(selection.rows)) return fromRows(selection.rows);

  const ranges = normalizeRanges(
    Array.isArray(selection.ranges)
      ? selection.ranges
      : ((selection.startRow || selection.endRow || selection.start || selection.end)
        ? [{ start: selection.startRow ?? selection.start, end: selection.endRow ?? selection.end }]
        : []),
  );
  if (!ranges.length) return null;

  const explicitCount = Number(selection.count);
  return {
    mode: 'ranges',
    ranges,
    count: Number.isInteger(explicitCount) && explicitCount >= 0
      ? explicitCount
      : countRanges(ranges),
    firstRow: integer(selection.firstRow) || ranges[0].start,
    lastRow: integer(selection.lastRow) || ranges.at(-1).end,
  };
}

function contains(selection, rowNumber) {
  const row = integer(rowNumber);
  if (!row) return false;
  const normalized = selection?.mode === 'ranges' && Array.isArray(selection.ranges)
    ? selection
    : normalize(selection);
  if (!normalized) return false;

  // ranges are ordered, so stop once the row would be before the next interval.
  for (const range of normalized.ranges) {
    if (row < range.start) return false;
    if (row <= range.end) return true;
  }
  return false;
}

function countEligible(selection, eligibleRows = []) {
  const normalized = normalize(selection);
  if (!normalized) return 0;
  if (!Array.isArray(eligibleRows) || !eligibleRows.length) return normalized.count;
  let count = 0;
  for (const row of eligibleRows) if (contains(normalized, row)) count++;
  return count;
}

function boundedSample(selection, limit = 8) {
  const normalized = normalize(selection);
  if (!normalized) return [];
  const max = Math.max(1, Math.min(20, Number(limit) || 8));
  const out = [];
  for (const range of normalized.ranges) {
    for (let row = range.start; row <= range.end && out.length < max; row++) out.push(row);
    if (out.length >= max) break;
  }
  return out;
}

function describe(selection) {
  const normalized = normalize(selection);
  if (!normalized) return 'all eligible rows';
  if (normalized.ranges.length === 1) {
    const range = normalized.ranges[0];
    return range.start === range.end
      ? `row ${range.start}`
      : `rows ${range.start}-${range.end}`;
  }
  const sample = normalized.ranges.slice(0, 3)
    .map((range) => range.start === range.end ? String(range.start) : `${range.start}-${range.end}`)
    .join(', ');
  const extra = normalized.ranges.length > 3 ? ` +${normalized.ranges.length - 3} more ranges` : '';
  return `${normalized.count} rows across ${normalized.ranges.length} ranges (${sample}${extra})`;
}

module.exports = {
  integer,
  normalizeRanges,
  countRanges,
  fromRows,
  fromRange,
  normalize,
  contains,
  countEligible,
  boundedSample,
  describe,
};
