'use strict';

const PHONE_FIRST_POLICY_VERSION = 'india-phone-first-5-searches-v1';
const INDIA_SEARCH_ATTEMPTS = Object.freeze([
  Object.freeze({ id: 'india-talent-acquisition', titles: ['talent acquisition', 'talent acquisition manager', 'talent acquisition head', 'talent partner'] }),
  Object.freeze({ id: 'india-recruiting', titles: ['recruiter', 'technical recruiter', 'recruitment manager', 'recruitment head'] }),
  Object.freeze({ id: 'india-hr', titles: ['human resources', 'HR manager', 'HR business partner', 'people partner'] }),
  Object.freeze({ id: 'india-hiring-leadership', titles: ['head of talent', 'head of people', 'head of recruitment', 'hiring manager'] }),
  Object.freeze({ id: 'india-executive-fallback', titles: ['founder', 'co-founder', 'owner', 'managing director', 'director'] }),
]);

function text(value) { return String(value == null ? '' : value).trim(); }

function strictIndianMobile(value, countryHint = '') {
  const digits = text(value).replace(/\D/g, '');
  const hint = text(countryHint).toLowerCase();
  const hintedIndia = ['in', 'ind', 'india', '+91', '91'].includes(hint) || /\bindia\b/i.test(hint);
  let national = '';
  if (digits.length === 12 && digits.startsWith('91')) national = digits.slice(2);
  else if (hintedIndia && digits.length === 10) national = digits;
  else if (hintedIndia && digits.length === 11 && digits.startsWith('0')) national = digits.slice(1);
  return /^[6-9]\d{9}$/.test(national) ? `+91${national}` : '';
}

function locationEvidence(person = {}) {
  return [
    person.location, person.country, person.country_name, person.city, person.state,
    person.raw_address, person.present_raw_address, person.organization?.country,
    person.organization?.city, person.organization?.state, person.organization?.raw_address,
  ].map(text).filter(Boolean).join(' ');
}

function isIndiaLocated(person = {}) {
  return /\bindia\b/i.test(locationEvidence(person));
}

function directPhoneAvailable(person = {}) {
  const value = text(person.hasDirectPhone ?? person.has_direct_phone ?? person.directPhoneAvailability).toLowerCase();
  return /^(?:yes|true|available|found|confirmed|1)$/.test(value)
    || /\b(?:yes|available|direct phone available)\b/.test(value);
}

function phonePriority(person = {}) {
  if (strictIndianMobile(person.phone || person.phone_number || person.mobile_phone, locationEvidence(person))) return 4;
  if (isIndiaLocated(person) && directPhoneAvailable(person)) return 3;
  if (strictInternationalPhone(person.phone || person.phone_number || person.mobile_phone)) return 2;
  if (directPhoneAvailable(person)) return 2;
  if (isIndiaLocated(person)) return 1;
  return 0;
}

function strictInternationalPhone(value) {
  const raw = text(value);
  if (!raw || strictIndianMobile(raw)) return false;
  const digits = raw.replace(/\\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

function mergeCandidates(groups) {
  const merged = new Map();
  for (const group of groups || []) {
    for (const candidate of (group || [])) {
      const key = text(candidate?.id || candidate?.linkedinUrl || candidate?.linkedin_url).toLowerCase();
      if (!key) continue;
      const previous = merged.get(key);
      if (!previous || phonePriority(candidate) > phonePriority(previous)) merged.set(key, candidate);
    }
  }
  return [...merged.values()];
}

function canUseInternationalFallback(attemptsCompleted, hasVerifiedIndianPhone) {
  return !hasVerifiedIndianPhone && Number(attemptsCompleted) >= INDIA_SEARCH_ATTEMPTS.length;
}

module.exports = {
  PHONE_FIRST_POLICY_VERSION,
  INDIA_SEARCH_ATTEMPTS,
  strictIndianMobile,
  isIndiaLocated,
  phonePriority,
  mergeCandidates,
  canUseInternationalFallback,
};
