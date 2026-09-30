'use strict';

const apollo = require('./apollo-enrichment');
const ranker = require('./universal-authority-ranker');

function text(value) { return String(value == null ? '' : value).trim(); }

function pocGroup(plan, ordinal) {
  const all = [
    ...(plan?.groups?.open || []),
    ...(plan?.groups?.partial || []),
    ...(plan?.groups?.existing || []),
    ...(plan?.groups?.complete || []),
  ];
  return all.find((item) => Number(item?.group?.ordinal || 0) === Number(ordinal))?.group || null;
}

function isSemanticPersonAnchor(plan = {}) {
  return Boolean(plan?.anchor?.type === 'person' && plan?.anchor?.semanticRecovery === true);
}

function anchorEmployerVerified(person = {}, companyContext = {}) {
  if (!person || person.identityVerified === false || person.noMatch || person.ambiguous) return false;
  if (!text(companyContext.company) && !text(companyContext.domain)) return false;
  if (person.linkedinEmployerVerified === true || person.apolloSearchEmployerVerified === true) return true;
  return ranker.sameEmployer(person, companyContext);
}

function anchorContactable(person = {}) {
  return Boolean(apollo.validPhone(person?.phone || ''));
}

function decision(plan = {}, anchorPerson = null, companyContext = {}) {
  if (!isSemanticPersonAnchor(plan)) {
    return Object.freeze({ mode:'not-semantic-person-anchor', useAnchorAsPoc1:false, reason:'not-semantic-person-anchor' });
  }
  const destination = pocGroup(plan, 1);
  if (!destination) {
    return Object.freeze({ mode:'no-poc1-destination', useAnchorAsPoc1:false, reason:'no-poc1-destination' });
  }
  if (!anchorEmployerVerified(anchorPerson, companyContext)) {
    return Object.freeze({ mode:'company-fallback', useAnchorAsPoc1:false, reason:'anchor-employer-not-verified', destination });
  }
  if (!anchorContactable(anchorPerson)) {
    return Object.freeze({ mode:'company-fallback', useAnchorAsPoc1:false, reason:'anchor-phone-unavailable', destination });
  }
  return Object.freeze({
    mode:'anchor-person-poc1',
    useAnchorAsPoc1:true,
    reason:'exact-anchor-has-usable-phone',
    destination,
  });
}

module.exports = {
  text,
  pocGroup,
  isSemanticPersonAnchor,
  anchorEmployerVerified,
  anchorContactable,
  decision,
};
