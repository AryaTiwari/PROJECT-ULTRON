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
  return INDIA_LOCATIONS.some((item) => v === item || v.includes(item));
}

function explicitGlobalScope(query) {
  return /\b(?:global|worldwide|anywhere|any country|international|across the world)\b/i.test(text(query));
}

function explicitForeignScope(query) {
  const value = text(query);
  return /\b(?:united states|usa|u\.s\.|united kingdom|uk|singapore|dubai|uae|germany|france|canada|australia|europe|japan)\b/i.test(value)
    && !/\bindia\b/i.test(value);
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

  if (explicitGlobalScope(value) || explicitForeignScope(value)) {
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

function personIndiaPriority(person = {}) {
  const phone = text(person.phone || person.phone_number || person.mobile_phone);
  const location = [
    person.country,
    person.country_name,
    person.city,
    person.state,
    person.location,
    person.organization?.country,
  ].map(text).filter(Boolean).join(' ');
  if (/^\+91/.test(phone.replace(/\s/g,''))) return 3;
  if (isIndiaLocation(location)) return 2;
  return 0;
}

module.exports = {
  INDIA_LOCATIONS,
  text,
  normalized,
  isIndiaLocation,
  explicitGlobalScope,
  explicitForeignScope,
  companyResearch,
  companyLocationEvidence,
  companyIndiaPriority,
  personIndiaPriority,
};
