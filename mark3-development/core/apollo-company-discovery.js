'use strict';

const paid = require('./paid-tool-approval');
const apollo = require('./apollo-enrichment');
const ranker = require('./apollo-company-ranker');
const queryProvider = require('./apollo-company-query-provider');

const ENDPOINT = 'https://api.apollo.io/api/v1/mixed_companies/search';

function text(value) { return String(value == null ? '' : value).trim(); }
function unique(values = []) { return [...new Set(values.map(text).filter(Boolean))]; }

function searchEmployeeRange(mission = {}, variant = {}) {
  const range = mission.employeeRange || {};
  if (range.explicit || range.hard) {
    return {
      min: range.min == null ? 1 : Math.max(1, Number(range.min) || 1),
      max: range.max == null ? 1000000 : Math.max(1, Number(range.max) || 1000000),
    };
  }

  // Small/medium is a default preference, not a hidden hard requirement.
  // Start focused, then allow a later relaxed-size variant if the target is not met.
  if (variant.relaxSize === true) return null;
  return {
    min: range.min == null ? 10 : Math.max(1, Number(range.min) || 10),
    max: range.max == null ? 500 : Math.max(1, Number(range.max) || 500),
  };
}

function buildSearchVariants(mission = {}) { return queryProvider.compile(mission); }

async function fetchPage(mission, page = 1, perPage = 100, variant = {}) {
  paid.assertPermitted('apollo');
  const key = apollo.setting('APOLLO_API_KEY');
  if (!key) throw Object.assign(new Error('APOLLO_API_KEY is missing.'), { code: 'APOLLO_NOT_CONFIGURED' });

  const url = new URL(ENDPOINT);
  const range = searchEmployeeRange(mission, variant);
  if (range) url.searchParams.append('organization_num_employees_ranges[]', `${range.min},${range.max}`);
  if (mission.geography) url.searchParams.append('organization_locations[]', mission.geography);

  const keywords = Array.isArray(variant.keywords) ? variant.keywords : (mission.keywords || []);
  for (const keyword of keywords.slice(0, 4)) url.searchParams.append('q_organization_keyword_tags[]', keyword);

  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(Math.max(1, Math.min(100, perPage))));

  const { response, text: rawText } = await apollo.fetchApolloResponse(url, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
    },
  });

  let data = {};
  try { data = rawText ? JSON.parse(rawText) : {}; } catch {}

  if (!response.ok) {
    throw Object.assign(
      new Error(data.error || data.message || `Apollo organization search failed (${response.status}).`),
      {
        code: response.status === 403
          ? 'APOLLO_ORGANIZATION_SEARCH_ACCESS_REQUIRED'
          : 'APOLLO_ORGANIZATION_SEARCH_FAILED',
        status: response.status,
      },
    );
  }

  return {
    items: data.organizations || data.accounts || [],
    pagination: data.pagination || {},
    raw: data,
    request: {
      variantId: variant.id || 'default',
      keywords,
      employeeRange: range,
      page,
      perPage: Math.max(1, Math.min(100, perPage)),
    },
  };
}

async function discover(mission, options = {}) {
  const requestedTarget = Math.min(100, Math.max(1, Number(mission.targetCount || 1)));
  const poolTarget = Math.min(500, Math.max(100, requestedTarget * 4));
  const pageFn = options.fetchPage || fetchPage;
  const maxCalls = Math.max(1, Math.min(10, Number(options.maxSearchCalls || 7)));
  const perPage = 100;
  const variants = options.searchVariants || buildSearchVariants(mission);

  const rawByKey = new Map();
  const diagnostics = [];
  let calls = 0;
  let ranked = [];

  for (const variant of variants) {
    if (calls >= maxCalls || ranked.length >= poolTarget) break;

    for (let page = 1; page <= 2 && calls < maxCalls && ranked.length < poolTarget; page++) {
      const result = await pageFn(mission, page, perPage, variant);
      calls++;

      const items = result.items || result.organizations || [];
      const employeeRange = searchEmployeeRange(mission, variant);
      for (const item of items) {
        const annotated = {
          ...item,
          __apolloQueryEvidence: [...(variant.keywords || [])],
          __apolloEmployeeRangeVerified: Boolean(employeeRange),
          __apolloEmployeeRange: employeeRange,
          __apolloLocationFilter: mission.geography || '',
          __apolloQueryVariant: variant.id || 'default',
        };
        const key = ranker.organizationKey(annotated);
        if (key && !rawByKey.has(key)) rawByKey.set(key, annotated);
      }

      ranked = ranker.rankOrganizations([...rawByKey.values()], mission);
      diagnostics.push({
        variantId: variant.id || 'default',
        keywords: [...(variant.keywords || [])],
        relaxSize: Boolean(variant.relaxSize),
        page,
        rawReturned: items.length,
        uniqueCandidates: rawByKey.size,
        qualifiedAfterMerge: ranked.length,
      });

      if (typeof options.onProgress === 'function') {
        await options.onProgress({
          variantId: variant.id || 'default',
          page,
          candidatesFound: rawByKey.size,
          qualified: ranked.length,
          searchVariantsTried: diagnostics.length,
          apolloCalls: calls,
          target: requestedTarget,
          candidatePoolTarget: poolTarget,
        });
      }

      // Empty or short pages mean this query shape is exhausted. Move to the
      // next deterministic variant rather than declaring the whole mission empty.
      if (!items.length || items.length < perPage) break;
    }
  }

  return {
    organizations: ranked.slice(0, poolTarget),
    candidatesFound: rawByKey.size,
    qualified: ranked.length,
    rejected: Math.max(0, rawByKey.size - ranked.length),
    apolloCalls: calls,
    paidCalls: calls,
    searchVariantsTried: diagnostics.length,
    searchDiagnostics: diagnostics,
    requestedTarget,
    candidatePoolTarget: poolTarget,
  };
}

module.exports = {
  ENDPOINT,
  searchEmployeeRange,
  buildSearchVariants,
  fetchPage,
  discover,
};
