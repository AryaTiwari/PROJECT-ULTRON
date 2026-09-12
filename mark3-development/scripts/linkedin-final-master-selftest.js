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
  company: 'TechVerito 12,345 followers',
  linkedin: 'https://www.linkedin.com/company/techverito/',
  website: 'https://www.techverito.com',
  role: 'SAP Consultant',
  jobUrl: 'https://www.linkedin.com/jobs/view/1',
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

assert.equal(master.normalizeLinkedIn(tech.linkedin), 'https://www.linkedin.com/company/techverito');
assert.equal(master.companyKey(tech), master.companyKey(duplicatePresentation));
assert.equal(master.qualifies(tech, { topic: 'SAP', workType: 'remote', employeeMax: 1000 }), true);
assert.equal(master.qualifies(unrelated, { topic: 'SAP', workType: 'remote', employeeMax: 1000 }), false);
assert.equal(master.masterCount(), 0);
assert.deepEqual(master.remainingForTarget(30), { desired: 30, current: 0, remaining: 30 });

master.registerRecords([tech], { missionId: 'mission-1' });
assert.equal(master.masterCount(), 1);
assert.equal(master.seen(duplicatePresentation), true);
assert.equal(master.filterUnseen([duplicatePresentation]).records.length, 0);
assert.equal(master.filterUnseen([duplicatePresentation]).skipped.length, 1);
assert.equal(master.filterUnseen([duplicatePresentation], { allowPreviouslySeen: true }).records.length, 1);
assert.deepEqual(master.remainingForTarget(30), { desired: 30, current: 1, remaining: 29 });

assert.equal(master.allowRepeatFromText('include companies we have already seen'), true);
assert.equal(master.allowRepeatFromText('find more new companies'), false);

master.setMasterSheet({
  url: 'https://docs.google.com/spreadsheets/d/final-master/edit',
  spreadsheetId: 'final-master',
  sheetName: 'Leads',
  title: 'ULTRON LinkedIn Final Lead Master',
});
assert.equal(master.masterSheetUrl(), 'https://docs.google.com/spreadsheets/d/final-master/edit');

console.log('LinkedIn Final Master tests passed: canonical company identity, SAP qualification, global never-repeat, explicit repeat override, total-target accounting and persistent master routing are healthy.');
