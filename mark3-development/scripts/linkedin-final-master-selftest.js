const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-linkedin-final-master-'));
const configPath = require.resolve('../core/config');
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: { projectRoot, mark3Root: projectRoot },
};

const master = require('../core/linkedin-final-master');

const tech = {
  company: 'TechVerito',
  linkedin: 'https://www.linkedin.com/company/techverito/',
  website: 'https://www.techverito.com',
  role: 'SAP Consultant',
  jobUrl: 'https://www.linkedin.com/jobs/view/1',
  location: 'Mumbai, Maharashtra, India',
  workType: 'remote',
  employeeCount: { min: 51, max: 200, label: '51-200' },
  hiringSignal: 'SAP Consultant · Remote · Mumbai, Maharashtra, India',
};

const duplicatePresentation = {
  company: 'TECHVERITO',
  linkedin: 'https://linkedin.com/company/techverito?trk=foo',
  role: 'SAP ABAP Developer',
  jobUrl: 'https://www.linkedin.com/jobs/view/2',
  workType: 'remote',
  employeeCount: { min: 51, max: 200, label: '51-200' },
  hiringSignal: 'SAP ABAP remote role',
};

const unrelated = {
  company: 'Peakflo',
  linkedin: 'https://www.linkedin.com/company/peakflo',
  role: 'Product Manager Intern',
  jobUrl: 'https://www.linkedin.com/jobs/view/3',
  workType: 'remote',
  employeeCount: { min: 11, max: 50, label: '11-50' },
  hiringSignal: 'Product Manager Intern',
};

assert.deepEqual(master.FINAL_MASTER_HEADERS, [
  'COMPANY NAME',
  'COMPANY LINK',
  'JOB LINK',
  'LOCATION',
  'NO. OF APPLICANTS',
  'PHONE',
  'EMAIL',
  'REMARKS',
]);
assert.equal(master.normalizeLinkedIn(tech.linkedin), 'https://www.linkedin.com/company/techverito');
assert.equal(master.companyKey(tech), master.companyKey(duplicatePresentation));
assert.equal(master.qualifies(tech, { topic: 'SAP', employeeMax: 1000, allowedLocations: ['Maharashtra', 'Bengaluru'] }), true);
assert.equal(master.locationAllowed({ location: 'Bangalore, Karnataka, India' }, ['Bengaluru']), true);
assert.equal(master.locationAllowed({ location: 'Bhubaneswar, Odisha, India' }, ['Maharashtra', 'Bengaluru']), false);
assert.equal(master.qualifies(unrelated, { topic: 'SAP', employeeMax: 1000, allowedLocations: ['Maharashtra', 'Bengaluru'] }), false);
assert.equal(master.masterCount(), 0);
assert.deepEqual(master.remainingForTarget(30), { desired: 30, current: 0, remaining: 30 });

tech.applicants = '11';
tech.phone = '11';
tech.email = '11';
master.registerRecords([tech], { missionId: 'mission-1' });
assert.equal(master.masterCount(), 1);
assert.equal(master.seen(duplicatePresentation), true);
assert.equal(master.filterUnseen([duplicatePresentation]).records.length, 0);
assert.equal(master.filterUnseen([duplicatePresentation]).skipped.length, 1);
assert.equal(master.filterUnseen([duplicatePresentation], { allowPreviouslySeen: true }).records.length, 1);
assert.deepEqual(master.remainingForTarget(30), { desired: 30, current: 1, remaining: 29 });

const outsideMaster = {
  company: 'Outside Region',
  linkedin: 'https://www.linkedin.com/company/outside-region',
  role: 'SAP FICO Consultant',
  jobUrl: 'https://www.linkedin.com/jobs/view/10',
  location: 'Bhubaneswar, Odisha, India',
  employeeCount: { min: 51, max: 200, label: '51-200' },
  hiringSignal: 'SAP FICO Consultant · Bhubaneswar',
};
master.registerRecords([outsideMaster], { missionId: 'outside-region' });
assert.equal(master.masterCount(), 2);
assert.equal(master.masterCount({ topic: 'SAP', employeeMax: 1000, allowedLocations: ['Maharashtra', 'Bengaluru'] }), 1);
assert.deepEqual(
  master.remainingForTarget(30, { topic: 'SAP', employeeMax: 1000, allowedLocations: ['Maharashtra', 'Bengaluru'] }),
  { desired: 30, current: 1, remaining: 29 },
);

const filler = {
  company: 'Seen But Not In Master',
  linkedin: 'https://www.linkedin.com/company/seen-but-not-master',
  role: 'SAP MM Consultant',
  jobUrl: 'https://www.linkedin.com/jobs/view/9',
  workType: 'hybrid',
  employeeCount: { min: 51, max: 200, label: '51-200' },
  hiringSignal: 'SAP MM Consultant · Bengaluru, India',
};
master.registerRecords([filler], { missionId: 'seen-history', master: false });
assert.equal(master.seen(filler), true);
assert.equal(master.masterCount(), 2);
master.replaceMasterRecords([tech], { missionId: 'rebuild' });
assert.equal(master.seen(filler), true);
assert.equal(master.masterCount(), 1);
assert.deepEqual(master.remainingForTarget(30), { desired: 30, current: 1, remaining: 29 });
assert.deepEqual(master.rowFor(tech), [
  'TechVerito',
  'https://www.linkedin.com/company/techverito',
  'https://www.linkedin.com/jobs/view/1',
  'Mumbai, Maharashtra, India',
  '11',
  '',
  '',
  '',
]);
assert.equal(master.contactRemark('Test Contact', 'Founder'), 'Test Contact (Founder)');
const techKey = master.companyKey(tech);
master.contactUpdate(techKey, {
  name: 'Test Contact',
  title: 'Founder',
  email: 'test@example.invalid',
  phone: '+10000000000',
  status: 'ENRICHED',
});
assert.deepEqual(master.rowFor(tech), [
  'TechVerito',
  'https://www.linkedin.com/company/techverito',
  'https://www.linkedin.com/jobs/view/1',
  '',
  '11',
  '+10000000000',
  'test@example.invalid',
  'Test Contact (Founder)',
]);

assert.equal(master.allowRepeatFromText('include companies we have already seen'), true);
assert.equal(master.allowRepeatFromText('find more new companies'), false);

master.setMasterSheet({
  url: 'https://docs.google.com/spreadsheets/d/final-master/edit',
  spreadsheetId: 'final-master',
  sheetName: 'Leads',
  title: 'ULTRON LinkedIn Final Lead Master',
});
assert.equal(master.masterSheetUrl(), 'https://docs.google.com/spreadsheets/d/final-master/edit');
assert.equal(master.schemaCurrent(), true);

console.log('LinkedIn Final Master tests passed: exact compact schema, normalized company names, location/headcount-aware qualified counting, global seen history separation, and master-total accounting.');
