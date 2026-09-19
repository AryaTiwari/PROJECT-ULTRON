'use strict';

const LEGAL_SUFFIXES = new Set([
  'pvt','private','ltd','limited','llp','plc','inc','incorporated','corp','corporation',
  'company','co','llc','gmbh','sa','ag','bv','pte','holdings','holding','group',
]);
const TLD_TOKENS = new Set(['com','in','net','org','io','co']);

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hostname(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return raw.toLowerCase().replace(/^www\./, '').split('/')[0];
  }
}

function companyTokens(value) {
  return normalize(value)
    .split(' ')
    .filter((token) => token && !LEGAL_SUFFIXES.has(token) && !TLD_TOKENS.has(token));
}

function companyKey(value) {
  return companyTokens(value).join(' ');
}

function compactCompanyKey(value) {
  return companyTokens(value).join('');
}

function domainBrand(value) {
  const host = hostname(value);
  if (!host) return '';
  const label = host.split('.')[0] || '';
  return companyKey(label.replace(/[-_]+/g, ' '));
}

function tokenOverlapMatch(expectedValue, actualValue) {
  const expected = companyTokens(expectedValue);
  const actual = companyTokens(actualValue);
  if (!expected.length || !actual.length) return false;
  const a = new Set(expected);
  const b = new Set(actual);
  const overlap = [...a].filter((token) => b.has(token)).length;
  return overlap / Math.max(1, Math.min(a.size, b.size)) >= 0.8;
}

function compactBrandMatch(expectedValue, actualValue) {
  const expected = compactCompanyKey(expectedValue);
  const actual = compactCompanyKey(actualValue);
  if (!expected || !actual) return false;
  if (expected === actual) return true;

  const shorter = expected.length <= actual.length ? expected : actual;
  const longer = expected.length <= actual.length ? actual : expected;

  // Containment is useful for brand-vs-legal-name variants such as:
  // people-click.com <-> PeopleClick Techno Solutions.
  // Require a reasonably distinctive brand to avoid matching tiny generic fragments.
  return shorter.length >= 6 && longer.includes(shorter);
}

function nameMatch(expectedValue, actualValue) {
  const expected = companyKey(expectedValue);
  const actual = companyKey(actualValue);
  if (!expected || !actual) return false;
  return expected === actual
    || tokenOverlapMatch(expected, actual)
    || compactBrandMatch(expected, actual);
}

function domainMatch(expectedValue, actualValue) {
  const expected = hostname(expectedValue);
  const actual = hostname(actualValue);
  if (!expected || !actual) return false;
  return expected === actual
    || expected.endsWith(`.${actual}`)
    || actual.endsWith(`.${expected}`);
}

function sameOrganization({
  expectedCompany = '',
  expectedDomain = '',
  actualCompany = '',
  actualDomain = '',
  aliases = [],
} = {}) {
  if (domainMatch(expectedDomain, actualDomain)) return true;

  const expectedNames = [
    expectedCompany,
    ...(Array.isArray(aliases) ? aliases : []),
    domainBrand(expectedDomain),
  ].filter(Boolean);

  for (const expectedName of expectedNames) {
    if (nameMatch(expectedName, actualCompany)) return true;
    if (actualDomain && nameMatch(expectedName, domainBrand(actualDomain))) return true;
  }

  // When both sides have domains but they differ, do not let a weak generic
  // company-name resemblance override that contradictory domain evidence.
  if (hostname(expectedDomain) && hostname(actualDomain)) return false;

  return false;
}

module.exports = {
  LEGAL_SUFFIXES,
  TLD_TOKENS,
  normalize,
  hostname,
  companyTokens,
  companyKey,
  compactCompanyKey,
  domainBrand,
  tokenOverlapMatch,
  compactBrandMatch,
  nameMatch,
  domainMatch,
  sameOrganization,
};
