'use strict';

const PERSONAL = /@(gmail|yahoo|hotmail|outlook|icloud|aol|protonmail)\./i;
function text(v) { return String(v == null ? '' : v).trim(); }
function digits(v) { return text(v).replace(/\D/g, ''); }
function validPhone(v) { const d = digits(v); return d.length >= 7 && d.length <= 15; }
function indianPhone(v, country = '') { const raw = text(v); const d = digits(raw); return validPhone(raw) && (/^\+91/.test(raw.replace(/\s/g, '')) || /^91\d{10}$/.test(d) || (d.length === 10 && /\bindia\b/i.test(country))); }
function workEmail(v) { const s = text(v).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && !PERSONAL.test(s); }
function quality(person = {}) {
  const phone = text(person.phone || person.phone_number || person.mobile_phone);
  const email = text(person.email || person.work_email);
  const india = indianPhone(phone, person.country || person.location || '');
  if (india && workEmail(email)) return 4;
  if (india) return 3;
  if (validPhone(phone) && workEmail(email)) return 2;
  if (validPhone(phone)) return 1;
  return 0;
}
function literalPhone(v) { const raw = text(v); return raw.startsWith('=') ? `'${raw}` : raw; }
module.exports = { validPhone, indianPhone, workEmail, quality, literalPhone };
