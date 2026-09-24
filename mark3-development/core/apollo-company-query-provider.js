'use strict';
function text(value) { return String(value == null ? '' : value).trim().toLowerCase(); }
function unique(values = []) { return [...new Set(values.map(text).filter(Boolean))]; }

class ApolloCompanyQueryProvider {
  constructor(options = {}) { this.strategy = options.strategy || 'deterministic-filter-compiler'; }
  officialApolloAiAvailable() { return false; }
  compile(mission = {}) {
    const requested = unique([...(mission.keywords || []), ...(mission.expandedKeywords || [])]);
    const technologyIntent = requested.some((word) => /(?:saas|software|tech|technology|product|platform|cloud)/.test(word));
    const variants = technologyIntent
      ? ['software product', 'software platform', 'saas', 'b2b software', 'cloud software', 'enterprise software', 'product software', 'technology']
      : requested;
    const focused = unique([...variants, ...requested]).slice(0, 10).map((keyword) => ({ label: keyword, keywords: [keyword], strategy: this.strategy }));
    focused.push({ label: 'broad size/location search', keywords: [], strategy: this.strategy });
    return focused;
  }
}

const baseline = new ApolloCompanyQueryProvider();
module.exports = { ApolloCompanyQueryProvider, baseline, compile: (mission) => baseline.compile(mission) };