'use strict';
function text(value) { return String(value == null ? '' : value).trim().toLowerCase(); }
function unique(values = []) { return [...new Set(values.map(text).filter(Boolean))]; }

class ApolloCompanyQueryProvider {
  constructor(options = {}) { this.strategy = options.strategy || 'deterministic-filter-compiler'; }
  officialApolloAiAvailable() { return false; }
  integrationDecision() { return { available:false, strategy:this.strategy, reason:'Apollo official developer documentation exposes structured Organization Search and People Search endpoints, but no supported natural-language company-search API endpoint.', checkedAt:'2026-09-25', organizationSearch:'https://docs.apollo.io/reference/organization-search', peopleSearch:'https://docs.apollo.io/reference/people-api-search' }; }
  compile(mission = {}) {
    const base = unique(mission.keywords || []).slice(0, 5);
    const expanded = unique(mission.expandedKeywords || []).filter((keyword) => !base.includes(keyword));
    const variants = []; const seen = new Set();
    const add = (id, keywords, relaxSize = false) => {
      const clean = unique(keywords).slice(0, 4); const key = `${relaxSize ? 'relaxed' : 'focused'}:${clean.join('|')}`;
      if (seen.has(key)) return; seen.add(key); variants.push({ id, label:id, keywords:clean, relaxSize, strategy:this.strategy });
    };
    if (base.length > 1) add('combined-keywords', base);
    for (const keyword of base) add(`keyword:${keyword}`, [keyword]);
    for (const keyword of expanded.slice(0, 2)) add(`expanded:${keyword}`, [keyword]);
    if (!variants.length) add('unfiltered-focused-size', []);
    if (!(mission.employeeRange?.explicit || mission.employeeRange?.hard)) {
      add('relaxed-size-primary', base.length ? [base[0]] : [], true);
      if (base.length > 1) add('relaxed-size-secondary', [base[1]], true);
    }
    return variants.slice(0, 7);
  }
}
const baseline = new ApolloCompanyQueryProvider();
module.exports = { ApolloCompanyQueryProvider, baseline, compile:(mission)=>baseline.compile(mission) };
