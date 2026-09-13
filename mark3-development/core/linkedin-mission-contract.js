function uniq(values = []) {
  const seen = new Set();
  return values.map(v => String(v || '').trim()).filter(Boolean).filter(v => {
    const k = v.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true;
  });
}

function canonicalLocation(value) {
  const clean = String(value || '').trim();
  if (/^bangalore$/i.test(clean)) return 'Bengaluru';
  return clean;
}

function extractLocations(text, fallback = '', known = []) {
  const value = String(text || '').toLowerCase();
  const found = [];
  for (const item of uniq(known).sort((a,b) => b.length - a.length)) {
    const needle = String(item).toLowerCase();
    const at = value.indexOf(needle);
    if (at >= 0) found.push({ value: canonicalLocation(item), at });
  }
  const bangaloreAt = value.indexOf('bangalore');
  if (bangaloreAt >= 0) found.push({ value: 'Bengaluru', at: bangaloreAt });
  if (!found.length && fallback) found.push({ value: canonicalLocation(fallback), at: Number.MAX_SAFE_INTEGER });
  found.sort((a,b) => a.at - b.at);
  return uniq(found.map(item => item.value));
}

function workType(text, legacy = {}) {
  const value = String(text || '').toLowerCase();

  const removeAnyWorkType = /(?:remove|drop|ignore|clear|relax)\s+(?:the\s+)?(?:remote|hybrid|on[- ]?site|work\s*type|workplace)(?:\s+filter)?|not\s+necessarily\s+(?:remote|hybrid|on[- ]?site)|(?:remote|hybrid|work\s*type|workplace)\s+(?:doesn['’]?t|does\s+not)\s+matter|(?:doesn['’]?t|does\s+not)\s+(?:have|need)\s+to\s+be\s+remote/i.test(value);
  if (removeAnyWorkType) return { value: null, strictness: 'none' };

  const selected = value.includes('remote') ? 'remote'
    : value.includes('hybrid') ? 'hybrid'
      : (value.includes('on-site') || value.includes('onsite') || value.includes('in-office')) ? 'on_site'
        : legacy.workType || null;
  if (!selected) return { value: null, strictness: 'none' };

  const labels = selected === 'on_site' ? ['on-site','onsite','in-office'] : [selected];
  let preferred = false;
  let hard = false;
  for (const label of labels) {
    const at = value.indexOf(label);
    if (at < 0) continue;
    const before = value.slice(Math.max(0, at - 40), at);
    const after = value.slice(at, at + 70);
    if (/prefer|preferred|preferably|ideally|priority/.test(before) || /prefer|preferred|preferably|ideally/.test(after)) preferred = true;
    if (/must|required|mandatory|strictly|only\s*$/.test(before)
        || /\bonly\b|mandatory|must\s+be|strictly/.test(after)) hard = true;
  }

  if (/rather\s+than\s+required|not\s+(?:required|mandatory)|preference\s+only/.test(value)) { hard = false; preferred = true; }
  return { value: selected, strictness: hard ? 'hard' : preferred ? 'preference' : 'hard' };
}

function target(text, legacy = {}) {
  const value = String(text || '');
  const total = value.match(/(?:reach|make|bring|get|take|grow|increase)[^\d]{0,50}(\d{1,3})[^\n]{0,30}(?:total|verified companies?|companies? total)/i)
    || value.match(/(\d{1,3})\s+(?:unique\s+)?(?:verified\s+)?companies?\s+total/i);
  if (total) return { mode: 'master_total', value: Number(total[1]) };
  const additional = value.match(/(?:add|find|get|bring|source|collect)\s+(\d{1,3})\s+(?:more|additional|new)/i)
    || value.match(/(\d{1,3})\s+(?:more|additional|new)\s+companies?/i);
  if (additional) return { mode: 'additional', value: Number(additional[1]) };
  if (legacy.targetMode === 'master_total' && legacy.targetTotal) return { mode: 'master_total', value: Number(legacy.targetTotal) };
  return { mode: 'additional', value: Math.max(1, Number(legacy.count || 25)) };
}

function compile(text, legacy = {}, options = {}) {
  const locations = extractLocations(text, legacy.location, options.knownLocations || []);
  const preferredLocations = locations.slice();
  const value = String(text || '').toLowerCase();
  const priorityAt = value.search(/prioriti[sz]e|prefer|focus on/);
  if (priorityAt >= 0) {
    preferredLocations.sort((a,b) => {
      const aAt = value.indexOf(String(a).toLowerCase(), priorityAt);
      const bAt = value.indexOf(String(b).toLowerCase(), priorityAt);
      const av = aAt >= 0 ? aAt : Number.MAX_SAFE_INTEGER;
      const bv = bAt >= 0 ? bAt : Number.MAX_SAFE_INTEGER;
      return av - bv;
    });
  }
  const wt = workType(text, legacy.filters || {});
  const targetSpec = target(text, legacy);
  return {
    version: 1,
    entityMode: legacy.entityMode || 'company',
    topic: legacy.topic || null,
    target: targetSpec,
    hard: {
      hiringRequired: Boolean(legacy.hiring),
      topic: legacy.topic || null,
      employeeMin: legacy.filters?.employeeMin ?? null,
      employeeMax: legacy.filters?.employeeMax ?? null,
      locations,
      workType: wt.strictness === 'hard' ? wt.value : null,
      jobType: legacy.filters?.jobType || null,
      experienceLevel: legacy.filters?.experienceLevel || null,
      datePosted: legacy.filters?.datePosted || null,
      easyApply: Boolean(legacy.filters?.easyApply),
    },
    preferences: { locations: preferredLocations, workType: wt.strictness === 'preference' ? wt.value : null },
    dedupe: { scope: legacy.entityMode === 'company' ? 'global-company' : 'mission', allowPreviouslySeen: Boolean(legacy.allowPreviouslySeenCompanies) },
    output: { useFinalMaster: Boolean(legacy.useFinalMaster || targetSpec.mode === 'master_total'), destinationSheetUrl: legacy.destinationSheetUrl || null },
    relaxation: { hardConstraintsLocked: true, preferencesMayRelax: true, requiresUserApprovalForHardConstraintChange: true },
  };
}

function apply(contract, request = {}) {
  const next = { ...request, missionContract: contract, allowedLocations: contract.hard.locations || [], preferredLocations: contract.preferences.locations || [], preferredWorkType: contract.preferences.workType || null, filters: { ...(request.filters || {}) } };
  if (next.allowedLocations.length) next.location = next.allowedLocations[0];
  next.filters.employeeMin = contract.hard.employeeMin;
  next.filters.employeeMax = contract.hard.employeeMax;
  next.filters.workType = contract.hard.workType;
  next.filters.jobType = contract.hard.jobType;
  next.filters.experienceLevel = contract.hard.experienceLevel;
  next.filters.datePosted = contract.hard.datePosted;
  next.filters.easyApply = contract.hard.easyApply;
  if (contract.target.mode === 'master_total') { next.targetMode = 'master_total'; next.targetTotal = contract.target.value; next.useFinalMaster = true; }
  else { next.targetMode = 'additional'; next.count = contract.target.value; }
  return next;
}

module.exports = { uniq, canonicalLocation, extractLocations, workType, target, compile, apply };
