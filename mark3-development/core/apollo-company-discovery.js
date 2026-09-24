'use strict';

const paid = require('./paid-tool-approval');
const apollo = require('./apollo-enrichment');
const ranker = require('./apollo-company-ranker');

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

function buildSearchVariants(mission = {}) {
  const base = unique(mission.keywords || []).slice(0, 5);
  const expanded = unique(mission.expandedKeywords || []).filter((k) => !base.includes(k));
  const variants = [];
  const seen = new Set();

  const add = (id, keywords, relaxSize = false) => {
    const clean = unique(keywords).slice(0, 4);
    const key = `${relaxSize ? 'relaxed' : 'focused'}:${clean.join('|')}`;
    if (seen.has(key)) return;
    seen.add(key);
    variants.push({ id, keywords: clean, relaxSize });
  };

  // Keep the original precise shape first. Some Apollo datasets respond well to
  // compound tags, so do not throw away a working fast path.
  if (base.length > 1) add('combined-keywords', base, false);

  // Apollo keyword tags can be much narrower in practice than natural language.
  // Search strong terms independently and merge/dedupe locally instead of
  // interpreting one empty compound query as "no companies exist".
  for (const keyword of base) add(`keyword:${keyword}`, [keyword], false);

  // Semantic expansion is bounded. These are still Apollo-side discovery calls,
  // not an unbounded keyword spray.
  for (const keyword of expanded.slice(0, 2)) add(`expanded:${keyword}`, [keyword], false);

  if (!variants.length) add('unfiltered-focused-size', [], false);

  // If small/medium-focused searches cannot meet the requested target, relax only
  // the implicit size preference while keeping the strongest query term.
  if (!(mission.employeeRange?.explicit || mission.employeeRange?.hard)) {
    add('relaxed-size-primary', base.length ? [base[0]] : [], true);
    if (base.length > 1) add('relaxed-size-secondary', [base[1]], true);
  }

  return variants.slice(0, 7);
}

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
  const target = Math.min(100, mission.targetCount + (mission.reserveCount || 0));
  const pageFn = options.fetchPage || fetchPage;
  const maxCalls = Math.max(1, Math.min(10, Number(options.maxSearchCalls || 7)));
  const perPage = Math.min(100, Math.max(25, Math.min(100, target * 2)));
  const variants = options.searchVariants || buildSearchVariants(mission);

  const rawByKey = new Map();
  const diagnostics = [];
  let calls = 0;
  let ranked = [];

  for (const variant of variants) {
    if (calls >= maxCalls || ranked.length >= target) break;

    for (let page = 1; page <= 2 && calls < maxCalls && ranked.length < target; page++) {
      const result = await pageFn(mission, page, perPage, variant);
      calls++;

      const items = result.items || result.organizations || [];
      for (const item of items) {
        const key = ranker.organizationKey(item);
        if (key && !rawByKey.has(key)) rawByKey.set(key, item);
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

      // Empty or short pages mean this query shape is exhausted. Move to the
      // next deterministic variant rather than declaring the whole mission empty.
      if (!items.length || items.length < perPage) break;
    }
  }

  return {
    organizations: ranked.slice(0, target),
    candidatesFound: rawByKey.size,
    qualified: ranked.length,
    rejected: Math.max(0, rawByKey.size - ranked.length),
    apolloCalls: calls,
    paidCalls: calls,
    searchVariantsTried: diagnostics.length,
    searchDiagnostics: diagnostics,
  };
}

module.exports = {
  ENDPOINT,
  searchEmployeeRange,
  buildSearchVariants,
  fetchPage,
  discover,
};
