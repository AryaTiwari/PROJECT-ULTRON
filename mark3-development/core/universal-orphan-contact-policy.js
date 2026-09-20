'use strict';

// Deterministic safety policy for partially populated contact blocks that have
// phone/email data but no person identity. A new identity may be attached only
// when every existing orphan contact value can be proven to belong to the
// hydrated candidate. Existing values are never cleared or reassigned here.

function text(value) { return String(value ?? '').trim(); }

function normalizeEmail(value) {
  return require('./universal-contact-normalization').normalizeEmail(value);
}

function phoneDigits(value) {
  return text(value).replace(/\D/g, '');
}

function equivalentPhone(a, b) {
  return require('./universal-contact-normalization').equivalentPhone(a, b);
}

function personEmail(person = {}) {
  return text(person.email || person.workEmail || person.businessEmail || person.emailAddress);
}

function personPhone(person = {}) {
  return text(person.phone || person.phoneNumber || person.mobile || person.mobileNumber);
}

function isOrphanContactTarget(item) {
  const snapshot = item?.snapshot || {};
  const values = snapshot.values || {};
  return Boolean(
    !item?.isAnchor
    && !snapshot.hasIdentity
    && (text(values.email) || text(values.phone))
  );
}

function verify(snapshot = {}, person = {}) {
  const values = snapshot.values || snapshot || {};
  const existingEmail = normalizeEmail(values.email);
  const existingPhone = text(values.phone);
  const candidateEmail = normalizeEmail(personEmail(person));
  const candidatePhone = personPhone(person);
  const proof = [];
  const mismatches = [];
  if (text(values.email) && !existingEmail) mismatches.push('existing-email-ambiguous');

  if (existingEmail) {
    if (!candidateEmail) mismatches.push('candidate-email-missing');
    else if (existingEmail !== candidateEmail) mismatches.push('email-mismatch');
    else proof.push('email-match');
  }

  if (existingPhone) {
    if (!candidatePhone) mismatches.push('candidate-phone-missing');
    else if (!equivalentPhone(existingPhone, candidatePhone)) mismatches.push('phone-mismatch');
    else proof.push('phone-match');
  }

  const existingSignals = Number(Boolean(existingEmail)) + Number(Boolean(existingPhone));
  return {
    verified: existingSignals > 0 && mismatches.length === 0 && proof.length === existingSignals,
    proof,
    mismatches,
    existingSignals,
  };
}

module.exports = {
  normalizeEmail,
  phoneDigits,
  equivalentPhone,
  personEmail,
  personPhone,
  isOrphanContactTarget,
  verify,
};
