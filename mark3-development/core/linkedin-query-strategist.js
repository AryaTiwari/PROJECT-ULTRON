function key(query = {}) {
  return String(query.keyword || '').trim().toLowerCase() + '|' + String(query.location || '').trim().toLowerCase() + '|' + String(query.workType || '').trim().toLowerCase();
}

function uniqueQueries(plan = []) {
  const seen = new Set();
  return plan.filter(query => {
    const id = key(query);
    if (!query.keyword || seen.has(id)) return false;
    seen.add(id); return true;
  });
}

function score(query, context = {}) {
  const history = Array.isArray(context.history) ? context.history : [];
  if (history.some(item => key(item) === key(query))) return Number.NEGATIVE_INFINITY;
  let value = 100;
  const preferred = Array.isArray(context.preferredLocations) ? context.preferredLocations : [];
  const locationIndex = preferred.findIndex(item => String(item).toLowerCase() === String(query.location || '').toLowerCase());
  if (locationIndex >= 0) value += Math.max(0, 40 - locationIndex * 8);
  const topic = String(context.topic || '').toLowerCase();
  const keyword = String(query.keyword || '').toLowerCase();
  if (topic && keyword === topic) value += 20;
  else if (topic && keyword.startsWith(topic)) value += 10;
  for (const item of history.slice(-3)) {
    const yieldValue = Number(item.uniqueJobIdsAdded ?? item.jobIds ?? 0);
    const sameLocation = String(item.location || '').toLowerCase() === String(query.location || '').toLowerCase();
    const sameKeyword = String(item.keyword || '').toLowerCase() === keyword;
    if (sameLocation) value += yieldValue > 0 ? Math.min(18, yieldValue) : -18;
    if (sameKeyword) value += yieldValue > 0 ? 5 : -12;

    // If a preferred work-type query produced little or nothing, explicitly
    // reward the broader equivalent query. Preferences may relax; hard
    // constraints never do.
    if (sameLocation && sameKeyword && item.workType && !query.workType && yieldValue < 5) {
      value += 42;
    }
  }
  return value;
}

function selectNext(plan = [], context = {}) {
  return uniqueQueries(plan)
    .map((query, index) => ({ query, index, score: score(query, context) }))
    .filter(entry => Number.isFinite(entry.score))
    .sort((a,b) => b.score - a.score || a.index - b.index)[0]?.query || null;
}

function searchAllowance(budget = {}, targetRemaining = 1) {
  const maximum = Math.max(0, Number(budget.maximum || 0));
  if (!maximum) return 0;
  const budgetBound = maximum >= 16 ? 3 : maximum >= 8 ? 2 : 1;
  const targetBound = targetRemaining >= 15 ? 3 : targetRemaining >= 5 ? 2 : 1;
  return Math.max(1, Math.min(3, budgetBound, targetBound));
}

function summarize(history = []) {
  return history.map(item => ({
    keyword: item.keyword,
    location: item.location || null,
    jobIds: Number(item.jobIds || 0),
    uniqueJobIds: Number(item.uniqueJobIds || 0),
    uniqueJobIdsAdded: Number(item.uniqueJobIdsAdded || 0),
    workType: item.workType || null,
    warning: item.warning || null,
  }));
}

module.exports = { key, uniqueQueries, score, selectNext, searchAllowance, summarize };
