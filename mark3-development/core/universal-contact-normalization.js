'use strict';

// Parsing never supplies identity/employer proof or invents a country code.
function splitIdentity(value) {
  const raw = String(value ?? '').trim();
  const split = raw.match(/^(.+?)\s+(?:[—–-]|\|)\s+(.+)$/)
    || raw.match(/^(.+?)\s*\(([^()]+)\)\s*$/)
    || raw.match(/^(.+?),\s+((?:.*\b)?(?:manager|director|founder|owner|recruiter|head|specialist|officer|president|partner|talent|hr|chief)\b.*)$/i);
  return split ? { name: split[1].trim(), designation: split[2].trim() } : { name: raw, designation: '' };
}

function normalizeEmail(value) {
  const matches = String(value ?? '').match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/gi) || [];
  const unique = [...new Set(matches.map(email => email.toLowerCase()))];
  return unique.length === 1 ? unique[0] : '';
}

function phone(value) {
  const raw = String(value ?? '').trim();
  if (!/^(?:\+|00)?[\d\s().-]+$/.test(raw)) return null;
  let digits = raw.replace(/\D/g, '');
  const international = raw.startsWith('+') || raw.startsWith('00');
  if (raw.startsWith('00')) digits = digits.slice(2);
  return digits.length >= 7 && digits.length <= 15 ? { digits, international } : null;
}

function equivalentPhone(left, right) {
  const a = phone(left), b = phone(right);
  if (!a || !b) return false;
  // Equal digits preserve a supplied international prefix; different country
  // codes must never match simply because subscriber-number suffixes agree.
  return a.digits === b.digits;
}

module.exports = { splitIdentity, normalizeEmail, phone, equivalentPhone };
