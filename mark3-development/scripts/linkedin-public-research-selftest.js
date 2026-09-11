#!/usr/bin/env node
const assert = require('assert');
const linkedin = require('../core/linkedin-public-research');

const company = linkedin.normalizeLinkedInEntityUrl('https://www.linkedin.com/company/acme-tech/?trk=public', 'company');
assert.equal(company?.url, 'https://www.linkedin.com/company/acme-tech');
assert.equal(company?.type, 'company');

const person = linkedin.normalizeLinkedInEntityUrl('https://linkedin.com/in/aarti-maurya/', 'person');
assert.equal(person?.url, 'https://www.linkedin.com/in/aarti-maurya');
assert.equal(person?.type, 'person');
assert.equal(linkedin.normalizeLinkedInEntityUrl('https://linkedin.com/company/acme-tech', 'person'), null);

const companyPlan = linkedin.plan(
  'Find me 50 companies on LinkedIn that are hiring SAP professionals from Maharashtra',
  'companies hiring SAP professionals Maharashtra'
);
assert.equal(companyPlan.enabled, true);
assert.equal(companyPlan.entityMode, 'company');
assert.equal(companyPlan.location, 'Maharashtra');
assert.equal(companyPlan.hiring, true);
assert.ok(linkedin.queryPlan('companies hiring SAP professionals Maharashtra', 50, companyPlan)
  .every((query) => /site:linkedin\.com\/company/i.test(query)));
assert.ok(linkedin.queryPlan(
  'companies hiring SAP professionals Maharashtra',
  50,
  { ...companyPlan, companyNames: ['Tata Consultancy Services', 'Infosys'] }
).some((query) => /SAP professionals/i.test(query)));
assert.ok(linkedin.queryPlan(
  'companies hiring SAP professionals Maharashtra',
  50,
  { ...companyPlan, companyNames: ['Tata Consultancy Services', 'Infosys'] }
).some((query) => /"Tata Consultancy Services"|"Infosys"/i.test(query)));

const weakCompany = linkedin.parseResult({
  title: 'Random Retail Group | LinkedIn',
  snippet: 'A consumer retail company with offices across India.',
  url: 'https://www.linkedin.com/company/random-retail-group/',
}, { entityMode: 'company', location: 'Maharashtra' });

const signaledCompany = linkedin.parseResult({
  title: 'Tata Consultancy Services | LinkedIn',
  snippet: 'Enterprise technology services and SAP delivery teams.',
  url: 'https://www.linkedin.com/company/tata-consultancy-services/',
}, { entityMode: 'company', location: 'Maharashtra' });

assert.ok(linkedin.scoreRecord(signaledCompany, {
  criteria: 'companies hiring SAP professionals Maharashtra',
  location: 'Maharashtra',
  hiring: true,
  companyNames: ['Tata Consultancy Services'],
}) > linkedin.scoreRecord(weakCompany, {
  criteria: 'companies hiring SAP professionals Maharashtra',
  location: 'Maharashtra',
  hiring: true,
  companyNames: ['Tata Consultancy Services'],
}));
assert.equal(linkedin.companySignalMatch(signaledCompany, ['Tata Consultancy Services']), true);

const personPlan = linkedin.plan('Find me 30 SAP recruiters on LinkedIn from Pune', 'SAP recruiters Pune');
assert.equal(personPlan.entityMode, 'person');
assert.equal(personPlan.location, 'Pune');
assert.ok(linkedin.queryPlan('SAP recruiters Pune', 30, personPlan)
  .every((query) => /site:linkedin\.com\/in/i.test(query)));

const parsedCompany = linkedin.parseResult({
  title: 'Acme Technologies | LinkedIn',
  snippet: 'Pune, Maharashtra · We are hiring SAP professionals across S/4HANA roles.',
  url: 'https://www.linkedin.com/company/acme-technologies/',
}, { entityMode: 'company', location: 'Maharashtra' });
assert.equal(parsedCompany.company, 'Acme Technologies');
assert.equal(parsedCompany.entityType, 'company');
assert.ok(parsedCompany.hiringSignal);

const parsedPerson = linkedin.parseResult({
  title: 'Aarti Maurya - SAP Recruiter - Acme Technologies | LinkedIn',
  snippet: 'Pune, Maharashtra · Talent acquisition for SAP and enterprise technology.',
  url: 'https://www.linkedin.com/in/aarti-maurya/',
}, { entityMode: 'person', location: 'Pune' });
assert.equal(parsedPerson.entityType, 'person');
assert.equal(parsedPerson.name, 'Aarti Maurya');
assert.equal(parsedPerson.linkedin, 'https://www.linkedin.com/in/aarti-maurya');

assert.equal(linkedin.publicPageLooksUsable({ text: 'Sign in to LinkedIn to continue and join LinkedIn today.' }), false);
assert.equal(linkedin.publicPageLooksUsable({ text: 'Acme Technologies builds enterprise software. '.repeat(8) }), true);

const status = linkedin.status();
assert.equal(status.directLinkedInLogin, false);
assert.equal(status.sessionCookies, false);
assert.equal(status.antiBotBypass, false);
assert.ok(status.maxSearchCalls <= 20);
assert.ok(status.maxResults <= 200);

console.log('LinkedIn public research self-test passed. Company/person normalization, mixed broad+signal query planning, stronger relevance scoring, public result parsing, login-wall rejection and no-login/no-bypass controls are healthy.');
