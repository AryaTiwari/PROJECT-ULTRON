// High-recall candidate discovery policy for the first-class 3-POC domain.
// Apollo People API Search is a 0-credit discovery endpoint, so quality should
// not be sacrificed by treating one sparse employer-domain query as final.
//
// This wrapper only affects searchCompanyPeopleBroad inside the 3-POC domain.
// Exact-person hydration/enrichment remains approval-gated and credit-aware.

const apollo = require('./apollo-enrichment');

const INSTALL_FLAG = Symbol.for('ultron.mark3.threePocCandidateDiscovery.installed');

let runState = freshRunState();

function freshRunState() {
  return {
    domainPrimaryCalls: 0,
    domainBroadCalls: 0,
    companyNameTargetedCalls: 0,
    companyNameBroadCalls: 0,
    companyNameRescues: 0,
    emptySearches: 0,
    returnedCandidates: 0,
  };
}

function personKey(person = {}) {
  return String(person.id || person.linkedinUrl || '').trim().toLowerCase();
}

function mergePeople(...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const person of Array.isArray(group) ? group : []) {
      const key = personKey(person);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(person);
    }
  }
  return out;
}

function enough(result, minimum = 2) {
  return Array.isArray(result?.people) && result.people.length >= minimum;
}

function limitValue(input) {
  return Math.max(8, Math.min(60, Number(input || 40)));
}

function install() {
  if (globalThis[INSTALL_FLAG]) return globalThis[INSTALL_FLAG];

  const original = apollo.searchCompanyPeopleBroad.bind(apollo);

  apollo.searchCompanyPeopleBroad = async function highRecallCompanyPeopleSearch(options = {}) {
    const company = String(options.company || '').trim();
    const domain = String(options.domain || '').trim();
    const titles = Array.isArray(options.titles) ? options.titles.filter(Boolean) : [];
    const limit = limitValue(options.limit);
    const minimum = Math.max(2, Math.min(6, Number(options.minimumUsefulCandidates || 2)));

    // 1) Primary exact-domain search. Keep the user's requested title focus.
    runState.domainPrimaryCalls++;
    let primary = await original({ ...options, limit });
    let merged = mergePeople(primary?.people);
    if (merged.length >= minimum) {
      runState.returnedCandidates += merged.length;
      return { ...primary, people: merged, candidatesChecked: merged.length, discoveryStrategy: 'domain-primary' };
    }

    // 2) Same verified employer domain, but remove title constraints. This catches
    // smaller companies whose useful hiring POCs use unconventional titles.
    if (domain && titles.length) {
      runState.domainBroadCalls++;
      const broadDomain = await original({ ...options, titles: [], limit });
      merged = mergePeople(merged, broadDomain?.people);
      if (merged.length >= minimum) {
        runState.returnedCandidates += merged.length;
        return { ...broadDomain, people: merged, candidatesChecked: merged.length, discoveryStrategy: 'domain-broad' };
      }
    }

    // 3) Domain metadata can be sparse or stale in Apollo. Retry by the exact
    // employer NAME already resolved from POC-1. The base Apollo helper still
    // applies sameOrganization(), so unrelated employers are rejected.
    if (company && domain) {
      runState.companyNameTargetedCalls++;
      const byNameTargeted = await original({ ...options, domain: '', company, titles, limit });
      const before = merged.length;
      merged = mergePeople(merged, byNameTargeted?.people);
      if (merged.length > before) runState.companyNameRescues++;
      if (merged.length >= minimum) {
        runState.returnedCandidates += merged.length;
        return { ...byNameTargeted, people: merged, candidatesChecked: merged.length, discoveryStrategy: 'company-name-targeted' };
      }

      // 4) Last free discovery pass: employer name with no title restriction.
      runState.companyNameBroadCalls++;
      const byNameBroad = await original({ ...options, domain: '', company, titles: [], limit });
      const beforeBroad = merged.length;
      merged = mergePeople(merged, byNameBroad?.people);
      if (merged.length > beforeBroad) runState.companyNameRescues++;
      if (merged.length) {
        runState.returnedCandidates += merged.length;
        return { ...byNameBroad, people: merged, candidatesChecked: merged.length, discoveryStrategy: 'company-name-broad' };
      }
    }

    if (!merged.length) runState.emptySearches++;
    runState.returnedCandidates += merged.length;
    return {
      ...(primary || { ok: true, company, domain }),
      people: merged,
      candidatesChecked: merged.length,
      discoveryStrategy: merged.length ? 'partial' : 'exhausted',
    };
  };

  const api = Object.freeze({ startRun, stats, mergePeople });
  globalThis[INSTALL_FLAG] = api;
  return api;
}

function startRun() {
  runState = freshRunState();
  return stats();
}

function stats() {
  return { ...runState, mode: 'zero-credit-high-recall', employerSafetyFilter: 'sameOrganization' };
}

module.exports = { install, startRun, stats, mergePeople };
