#!/usr/bin/env node
const assert = require('assert');

process.env.SERP_API_KEY = process.env.SERP_API_KEY || 'test-serp-key';
process.env.APIFY_API_KEY = process.env.APIFY_API_KEY || 'test-apify-key';

const fusion = require('../core/lead-source-fusion');
const workspace = require('../core/lead-workspace-operator-v3');

const status = fusion.status();
assert.equal(status.serpApiConfigured, true);
assert.equal(status.apifyConfigured, true);
assert.equal(status.apifyActor, process.env.APIFY_GOOGLE_MAPS_ACTOR || 'compass~crawler-google-places');

assert.equal(fusion.detectLocation('marketing agencies in New Delhi'), 'New Delhi, India');
assert.equal(fusion.detectLocation('gyms near Kolkata'), 'Kolkata, India');
assert.equal(fusion.detectLocation('remote SAP recruiters'), 'India');

assert.equal(fusion.jobSearchQuery('50 SAP recruiter leads from Naukri in India'), '50 SAP recruiter in India');
assert.equal(fusion.mapsSearchQuery('marketing agency founders in Kolkata from Google Maps'), 'marketing agency');

const hiringPlan = fusion.sourcePlan('Find 50 recruiters from Naukri and Indeed', 'HR recruiters India');
assert.equal(hiringPlan.useJobs, true);
assert.equal(hiringPlan.explicitJobs, true);

const mapsPlan = fusion.sourcePlan('Find 40 gyms in Kolkata from Google Maps', 'gyms Kolkata');
assert.equal(mapsPlan.useMaps, true);
assert.equal(mapsPlan.explicitMaps, true);

const signals = {
  plan: { useJobs: true, useMaps: true },
  jobs: [
    { company: 'Acme Technologies Pvt Ltd', title: 'SAP Consultant', via: 'Indeed', location: 'Bengaluru' },
    { company: 'Acme Technologies', title: 'SAP Basis', via: 'Naukri', location: 'Bengaluru' },
  ],
  maps: [
    { company: 'Fit House Kolkata', category: 'Gym', rating: 4.7, reviews: 310, website: 'https://fithouse.example' },
  ],
};

const seeds = fusion.seedQueries(signals, 'SAP recruiters India', 50);
assert.ok(seeds.some((query) => /Acme Technologies/i.test(query) && /linkedin\.com\/in/i.test(query)));
assert.ok(seeds.some((query) => /Fit House Kolkata/i.test(query) && /founder|owner/i.test(query)));
assert.equal(seeds.some((query) => /site:naukri\.com/i.test(query)), false);

assert.equal(fusion.companyMatches('Acme Technologies Pvt. Ltd.', 'Acme Technologies'), true);
assert.equal(fusion.companyMatches('Completely Different Co', 'Acme Technologies'), false);

const annotation = fusion.annotateLead({ company: 'Acme Technologies Pvt Ltd' }, signals);
assert.equal(annotation.sourceCount, 1);
assert.ok(annotation.boost >= 10);
assert.ok(/Indeed|Naukri/i.test(annotation.hiringSignal));

assert.equal(workspace.sourceKeyForHeader('Hiring Signal'), 'hiring');
assert.equal(workspace.sourceKeyForHeader('Maps Signal'), 'maps');
assert.equal(workspace.sourceKeyForHeader('Source Count'), 'source_count');
assert.equal(workspace.sourceKeyForHeader('Evidence Sources'), 'evidence');

const row = workspace.leadRow({
  name: 'Aarti',
  company: 'Acme Technologies',
  role: 'Recruiter',
  linkedin: 'https://www.linkedin.com/in/aarti/',
  hiringSignal: 'SAP Consultant via Indeed',
  mapSignal: '',
  sourceCount: 1,
  sourceEvidence: ['google-jobs'],
  relevanceScore: 91,
}, ['Name', 'Company', 'LinkedIn', 'Hiring Signal', 'Source Count', 'Evidence Sources', 'Lead Score']);
assert.equal(row[0], 'Aarti');
assert.equal(row[3], 'SAP Consultant via Indeed');
assert.equal(row[4], 1);
assert.equal(row[5], 'google-jobs');
assert.equal(row[6], 91);

console.log('Lead Source Fusion self-test passed. SerpApi fallback, Google Jobs planning, Apify Google Maps planning, location/query cleanup, source-seeded LinkedIn discovery, company matching and source-aware sheet columns are structurally healthy.');
