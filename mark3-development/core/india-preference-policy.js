'use strict';

const INDIA_LOCATIONS = Object.freeze([
  'india','maharashtra','mumbai','navi mumbai','thane','pune','bengaluru','bangalore',
  'karnataka','delhi','new delhi','gurugram','gurgaon','noida','uttar pradesh',
  'hyderabad','telangana','chennai','tamil nadu','kolkata','west bengal','ahmedabad',
  'gujarat','jaipur','rajasthan','kochi','kerala','chandigarh',
]);

function text(value) { return String(value == null ? '' : value).trim(); }
function normalized(value) { return text(value).toLowerCase().replace(/[^a-z0-9+ ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

function isIndiaLocation(value) {
  const v = normalized(value);
  if (!v) return false;
  // Match whole normalized location tokens, not substrings. "Indiana" and
  // "Indianapolis" are not India, and cannot satisfy a hard India gate.
  const padded = ` ${v} `;
  return INDIA_LOCATIONS.some((item) => padded.includes(` ${item} `));
}

function explicitGlobalScope(query) {
  return /\b(?:global|worldwide|anywhere|any country|international|across the world)\b/i.test(text(query));
}

function explicitForeignScope(query) {
  const value = text(query);
  return /\b(?:united states|usa|u\.s\.|united kingdom|uk|singapore|dubai|uae|germany|france|canada|australia|europe|japan)\b/i.test(value)
    && !/\bindia\b/i.test(value);
}

function explicitNoGeography(query) {
  const value = text(query);
  return /\b(?:remove|drop|ignore|clear|relax)\s+(?:the\s+)?(?:location|geography|country|region)(?:\s+filter)?\b/i.test(value)
    || /\b(?:no|without)\s+(?:location|geography|country|region)\s+(?:filter|restriction|constraint)\b/i.test(value)
    || /\b(?:location|geography|country|region)\s+(?:doesn['’]?t|does\s+not)\s+matter\b/i.test(value);
}

function companyResearch(query, geography = '', entityMode = 'company') {
  const value = text(query);
  const geo = text(geography);
  const companyMode = /^(?:company|organization|organisation)$/i.test(text(entityMode));
  if (!companyMode) {
    return Object.freeze({ mode:'not-applicable', geography:geo, preferIndia:false, hardIndia:false, explicitOverride:false });
  }

  if (geo) {
    if (isIndiaLocation(geo)) {
      return Object.freeze({ mode:'india-explicit', geography:geo, preferIndia:true, hardIndia:true, explicitOverride:true });
    }
    return Object.freeze({ mode:'explicit-location-override', geography:geo, preferIndia:false, hardIndia:false, explicitOverride:true });
  }

  if (explicitGlobalScope(value) || explicitForeignScope(value) || explicitNoGeography(value)) {
    return Object.freeze({ mode:'explicit-scope-override', geography:'', preferIndia:false, hardIndia:false, explicitOverride:true });
  }

  // User preference: company research defaults to India. Explicit geography can
  // override it, keeping the system flexible rather than silently fighting the task.
  return Object.freeze({
    mode:'india-default',
    geography:'India',
    preferIndia:true,
    hardIndia:true,
    explicitOverride:false,
  });
}

function companyLocationEvidence(company = {}) {
  return [
    company.country,
    company.country_name,
    company.city,
    company.state,
    company.raw_address,
    company.location,
    company.headquarters,
  ].map(text).filter(Boolean).join(' ');
}

function companyIndiaPriority(company = {}) {
  return isIndiaLocation(companyLocationEvidence(company)) ? 1 : 0;
}

function strictIndianMobile(value, countryHint = '') {
  const raw = text(value);
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  const hint = text(countryHint).toLowerCase();
  const hintedIndia = ['in', 'ind', 'india', '+91', '91'].includes(hint) || /\bindia\b/i.test(hint);

  let national = '';
  if (digits.length === 12 && digits.startsWith('91')) national = digits.slice(2);
  else if (hintedIndia && digits.length === 10) national = digits;
  else if (hintedIndia && digits.length === 11 && digits.startsWith('0')) national = digits.slice(1);

  return /^[6-9]\d{9}$/.test(national) ? `+91${national}` : '';
}

function directPhoneAvailability(person = {}) {
  const raw = text(
    person.hasDirectPhone
    ?? person.has_direct_phone
    ?? person.directPhoneAvailability
    ?? ''
  ).toLowerCase();
  if (/^(?:yes|true|available|found|confirmed|1)$/.test(raw)) return 2;
  if (/\b(?:yes|available|direct phone available)\b/.test(raw)) return 2;
  if (/\b(?:maybe|request direct dial|possible|potential|likely)\b/.test(raw)) return 1;
  return 0;
}

function personIndiaPriority(person = {}) {
  const phone = text(person.phone || person.phone_number || person.mobile_phone);
  const location = [
    person.country,
    person.country_name,
    person.city,
    person.state,
    person.location,
    person.raw_address,
    person.present_raw_address,
    person.organization?.country,
    person.organization?.state,
    person.organization?.city,
    person.organization?.raw_address,
  ].map(text).filter(Boolean).join(' ');

  // A real +91 mobile is the strongest India signal. Do not let a malformed
  // "+91..." value receive India priority merely because it starts with +91.
  if (strictIndianMobile(phone, location)) return 4;

  // Apollo People Search does not expose the actual phone before enrichment.
  // Its has_direct_phone signal is therefore the strongest safe pre-hydration
  // proxy for an eventual phone on an India-located decision-maker.
  if (isIndiaLocation(location)) {
    const availability = directPhoneAvailability(person);
    if (availability >= 2) return 3;
    if (availability === 1) return 2;
    return 1;
  }

  return 0;
}

module.exports = {
  INDIA_LOCATIONS,
  text,
  normalized,
  isIndiaLocation,
  explicitGlobalScope,
  explicitForeignScope,
  explicitNoGeography,
  companyResearch,
  companyLocationEvidence,
  companyIndiaPriority,
  personIndiaPriority,
  // Canonical strict validator: a real Indian mobile, or nothing. Exported so
  // every policy layer (universal phone-first selection included) uses one
  // definition instead of re-implementing the +91 rules.
  strictIndianMobile,
};
