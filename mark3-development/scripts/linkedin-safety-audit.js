#!/usr/bin/env node
const policy = require('../core/linkedin-account-policy');

function fmt(ts) {
  const n = Number(ts || 0);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

function ageMinutes(ts, now) {
  const n = Number(ts || 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(0, Math.round((now - n) / 60000));
}

const now = Date.now();
const state = policy.loadState();
const status = policy.status();
const events = (state.events || [])
  .filter((event) => Number(event.at || 0) >= now - 24 * 60 * 60 * 1000)
  .sort((a, b) => Number(a.at || 0) - Number(b.at || 0));

const counted = events.filter(policy.eventCountsTowardSafety);
const ignored = events.filter((event) => !policy.eventCountsTowardSafety(event));

const byTool = {};
for (const event of counted) {
  const tool = String(event.tool || 'unknown');
  byTool[tool] ||= { total: 0, success: 0, failed: 0, firstAt: null, lastAt: null, bypassTagged: 0 };
  const row = byTool[tool];
  row.total += 1;
  if (event.ok) row.success += 1;
  else row.failed += 1;
  if (event.runtimeTestBypass === true) row.bypassTagged += 1;
  const at = Number(event.at || 0);
  if (!row.firstAt || at < row.firstAt) row.firstAt = at;
  if (!row.lastAt || at > row.lastAt) row.lastAt = at;
}

const hourlyBuckets = {};
for (const event of counted) {
  const d = new Date(Number(event.at || 0));
  const key = d.toISOString().slice(0, 13) + ':00Z';
  hourlyBuckets[key] = Number(hourlyBuckets[key] || 0) + 1;
}

const threshold = status.dailyMax;
const needToExpire = Math.max(0, counted.length - threshold + 1);
const expiryEvent = needToExpire > 0 ? counted[needToExpire - 1] : null;

console.log('LinkedIn Safety Audit');
console.log('=====================');
console.log('Now:', new Date(now).toISOString());
console.log('State file:', status.stateFile);
console.log('Configured caps:', {
  burstMax: status.burstMax,
  hourlyMax: status.hourlyMax,
  dailyMax: status.dailyMax,
  minGapMs: status.minGapMs,
});
console.log('Current counted usage:', {
  burst: status.burstUsed,
  hourly: status.hourlyUsed,
  daily: status.dailyUsed,
});
console.log('Ignored events in rolling 24h:', ignored.length);
console.log('Event breakdown:', status.eventBreakdown);
console.log('Over-cap expiry count needed:', status.overCapBy);
console.log('Next eligible LinkedIn account call:', status.nextEligibleAt);
if (expiryEvent) {
  console.log('Daily-cap threshold event:', {
    tool: expiryEvent.tool || null,
    at: fmt(expiryEvent.at),
    ageMinutes: ageMinutes(expiryEvent.at, now),
    runtimeTestBypass: expiryEvent.runtimeTestBypass ?? 'legacy-unknown',
    sourceScript: expiryEvent.sourceScript || 'legacy-unknown',
  });
}
console.log('');
console.log('Counted calls by tool:');
for (const [tool, row] of Object.entries(byTool).sort((a, b) => b[1].total - a[1].total)) {
  console.log(' -', tool, {
    total: row.total,
    success: row.success,
    failed: row.failed,
    bypassTagged: row.bypassTagged,
    firstAt: fmt(row.firstAt),
    lastAt: fmt(row.lastAt),
  });
}
console.log('');
console.log('Counted calls by UTC hour:');
for (const [hour, count] of Object.entries(hourlyBuckets)) {
  console.log(' -', hour, count);
}
console.log('');
console.log('Interpretation:');
if (status.dailyUsed >= status.dailyMax) {
  console.log(
    `Local daily safety cap is active. ULTRON must wait until enough counted calls expire from the rolling 24-hour window. Correct next-safe time: ${status.nextEligibleAt}.`
  );
} else {
  console.log('Daily safety cap is currently clear.');
}
if (process.env.ULTRON_M3_LINKEDIN_TEST_BYPASS_LOCAL_BUDGET === '1') {
  console.log('WARNING: ULTRON_M3_LINKEDIN_TEST_BYPASS_LOCAL_BUDGET=1 is still present in .env. Current live server/runtime ignores it unless running an allowed test/doctor script, but remove or set it to 0 after diagnostics to avoid confusion.');
}
