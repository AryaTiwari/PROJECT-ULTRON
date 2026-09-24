'use strict';
const paid = require('./paid-tool-approval');
const apollo = require('./apollo-enrichment');
const ranker = require('./apollo-company-ranker');
const queryProvider = require('./apollo-company-query-provider');
const ENDPOINT = 'https://api.apollo.io/api/v1/mixed_companies/search';

function unique(values = []) { return [...new Set(values.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))]; }
function queryPlans(mission = {}) { return queryProvider.compile(mission); }
function annotate(items, mission, plan) {
  return (items || []).map((item) => ({
    ...item,
    __apolloQueryEvidence: unique(plan.keywords || []),
    __apolloEmployeeRangeVerified: Boolean(mission.employeeRange),
    __apolloEmployeeRange: mission.employeeRange || null,
    __apolloLocationFilter: mission.geography || '',
    __apolloQueryVariant: plan.label,
  }));
}

async function fetchPage(mission, page = 1, perPage = 100) {
  paid.assertPermitted('apollo');
  const key = apollo.setting('APOLLO_API_KEY');
  if (!key) throw Object.assign(new Error('APOLLO_API_KEY is missing.'), { code: 'APOLLO_NOT_CONFIGURED' });
  const url = new URL(ENDPOINT);
  const r = mission.employeeRange || {};
  if (r.min != null || r.max != null) url.searchParams.append('organization_num_employees_ranges[]', `${Math.max(1, r.min ?? 1)},${r.max ?? 1000000}`);
  if (mission.geography) url.searchParams.append('organization_locations[]', mission.geography);
  for (const keyword of unique(mission.keywords || []).slice(0, 1)) url.searchParams.append('q_organization_keyword_tags[]', keyword);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(Math.max(1, Math.min(100, perPage))));
  const { response, text } = await apollo.fetchApolloResponse(url, { method: 'POST', headers: { 'x-api-key': key, Accept: 'application/json', 'Cache-Control': 'no-cache' } });
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) throw Object.assign(new Error(data.error || data.message || `Apollo organization search failed (${response.status}).`), { code: response.status === 403 ? 'APOLLO_ORGANIZATION_SEARCH_ACCESS_REQUIRED' : 'APOLLO_ORGANIZATION_SEARCH_FAILED', status: response.status });
  return { items: data.organizations || data.accounts || [], pagination: data.pagination || {}, raw: data };
}

async function discover(mission, options = {}) {
  const target = Math.min(100, mission.targetCount + (mission.reserveCount || 0));
  const pageFn = options.fetchPage || fetchPage;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const plans = options.plans || queryPlans(mission);
  const concurrency = Math.max(1, Math.min(3, Number(options.concurrency || 3)));
  const all = [];
  let calls = 0;
  let ranked = [];
  let providerFailures = 0;
  let firstFailure = null;
  let completed = 0;
  let offset = 0;
  while (offset < plans.length && ranked.length < target) {
    // Keep the common path at one credit. Broaden in parallel only when the
    // focused query cannot satisfy the mission.
    const batchSize = offset === 0 ? 1 : concurrency;
    const batch = plans.slice(offset, offset + batchSize); offset += batch.length;
    const settled = await Promise.allSettled(batch.map(async (plan) => {
      const searchMission = { ...mission, keywords: plan.keywords };
      return { plan, result: await pageFn(searchMission, 1, 100) };
    }));
    for (let i = 0; i < settled.length; i++) {
      calls++; completed++;
      const outcome = settled[i];
      const plan = batch[i];
      if (outcome.status === 'fulfilled') {
        const items = outcome.value.result.items || outcome.value.result.organizations || [];
        all.push(...annotate(items, mission, plan));
      } else {
        providerFailures++;
        firstFailure ||= outcome.reason;
      }
      ranked = ranker.rankOrganizations(all, mission);
      await onProgress({ phase: 'searching', query: plan.label, queriesPlanned: plans.length, queriesCompleted: completed, candidatesFound: all.length, companiesQualified: ranked.length, remainingTarget: Math.max(0, target - ranked.length), apolloCalls: calls, paidCalls: calls, providerFailures });
    }
  }
  if (!all.length && firstFailure) throw firstFailure;
  return { organizations: ranked.slice(0, target), candidatesFound: all.length, qualified: ranked.length, rejected: Math.max(0, all.length - ranked.length), apolloCalls: calls, paidCalls: calls, queriesPlanned: plans.length, queriesCompleted: completed, providerFailures };
}

module.exports = { ENDPOINT, unique, queryPlans, annotate, fetchPage, discover };