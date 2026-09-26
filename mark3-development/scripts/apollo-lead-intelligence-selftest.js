'use strict';
const assert = require('node:assert/strict');
const intent = require('../core/apollo-lead-intent-compiler');
const ranker = require('../core/apollo-company-ranker');
const contact = require('../core/apollo-contactability-policy');
const selector = require('../core/apollo-poc-selector');
const discovery = require('../core/apollo-company-discovery');
const projector = require('../core/apollo-lead-sheet-projector');
const control = require('../core/command-control-plane');
const apolloLeadController = require('../core/apollo-lead-domain-controller');

function person(id, title, phone, email = '', extra = {}) { return { id, apolloPersonId: id, name: `Person ${id}`, title, phone, email, apolloSearchEmployerVerified: true, identityVerified: true, ...extra }; }
function company(id, name, employees, description = 'AI software product startup', extra = {}) { return { id, name, estimated_num_employees: employees, short_description: description, linkedin_url: `https://www.linkedin.com/company/${id}`, website_url: `https://${id}.example`, country: 'India', ...extra }; }
const mission = intent.compile('Find me 20 AI tech product startup companies based in India.');

(async () => {
  // 1 company discovery only
  assert.equal(mission.missionType, 'apollo_company_discovery'); assert.equal(mission.targetCount, 20); assert.equal(mission.enrichmentRequested, false);
  let pages = 0; const found = await discovery.discover(mission, { fetchPage: async () => { pages++; return { items: Array.from({ length: 25 }, (_, i) => company(`startup-${i}`, `AI Startup ${i}`, 30 + i)) }; } });
  assert.ok(found.organizations.length >= 20); assert.equal(new Set(found.organizations.map((o) => o.key)).size, found.organizations.length); assert.ok(pages >= 1); assert.equal(found.candidatePoolTarget, 100);
  // 2 small/medium bias
  const ranked = ranker.rankOrganizations([company('google','Google',190000), company('microsoft','Microsoft',220000), company('small-a','AI startup A',45), company('small-b','AI startup B',120)], mission);
  assert.deepEqual(ranked.slice(0,2).map((o) => o.name), ['AI startup A','AI startup B']);
  const target = { id: 'org-1', name: 'Target', domain: 'target.example' };
  // 3 POC-1 normal case
  let picked = selector.selectPocs([person('f','Founder','+919876543210','f@target.example'), person('h','HR Manager','+919876543211','h@target.example'), person('r','Recruiter','+919876543212')], target, 2); assert.equal(picked.poc1.apolloPersonId, 'f');
  // 4 contactability beats prestige
  picked = selector.selectPocs([person('f','Founder',''), person('h','HR Manager','+919876543211','h@target.example')], target, 1); assert.equal(picked.poc1.apolloPersonId, 'h');
  // 5 recruiter fallback
  picked = selector.selectPocs([person('a','Technical Recruiter','+919876543210'), person('b','Technical Recruiter','+919876543211')], target, 2); assert.equal(picked.selected.length, 2); assert.notEqual(picked.poc1.apolloPersonId, picked.poc2.apolloPersonId);
  // 6 Indian-number preference
  picked = selector.selectPocs([person('us','Founder','+14155550123','a@target.example'), person('in','HR Manager','+919876543210')], target, 1); assert.equal(picked.poc1.apolloPersonId, 'in');
  // 7 foreign fallback
  picked = selector.selectPocs([person('us','Director','+14155550123','a@target.example')], target, 1); assert.equal(picked.poc1.apolloPersonId, 'us'); assert.equal(contact.quality(picked.poc1), 2);
  // 8 contactability ranks people only; it never qualifies, rejects, or removes a company.
  const contactable = [{ name:'A', pocs:selector.selectPocs([person('x','Founder','')], target,2) }, { name:'B', pocs:selector.selectPocs([person('y','Founder','+919876543210')], target,2) }].filter((x) => x.pocs.selected.some((p) => contact.quality(p) >= 3)); assert.deepEqual(contactable.map((x) => x.name), ['B']);
  // 9 irrelevant company never qualifies merely for phone quality
  assert.equal(ranker.relevancePass(company('agency','Unrelated Staffing',50,'staffing recruitment agency'), mission), false);
  // 10 preserve existing valid POC
  assert.equal(selector.preserveExisting(person('keep','Founder','+919876543210'), target), true);
  // 11 no-phone existing POC is replaceable
  assert.equal(selector.preserveExisting(person('replace','Founder',''), target), false);
  // 12 universal schema heading variants
  const a = projector.directColumns(['COMPANY NAME','COMPANY LINK','1ST POC NAME','PHONE','EMAIL','2ND POC NAME','PHONE','EMAIL']); const b = projector.directColumns(['ORGANIZATION','WEBSITE','PRIMARY CONTACT','PRIMARY TITLE','PRIMARY PHONE','PRIMARY EMAIL','SECONDARY CONTACT','SECONDARY TITLE','SECONDARY PHONE','SECONDARY EMAIL']); assert.equal(a.companyName,0); assert.equal(a.companyLink,1); assert.equal(b.companyName,0); assert.equal(b.website,1);
  // 13 no cross-person writes
  const cols = { companyName:0, personGroups:[{ fields:{ name:{index:2}, phone:{index:3}, email:{index:4} } },{ fields:{ name:{index:5}, phone:{index:6}, email:{index:7} } }]}; const values = projector.rowValues({ name:'Target', poc1:person('a','Recruiter','+919000000001','a@target.example'), poc2:person('b','Recruiter','+919000000002','b@target.example') }, cols, true); assert.equal(values.get(3),'+919000000001'); assert.equal(values.get(7),'b@target.example');
  // 14 no duplicate POCs
  picked = selector.selectPocs([person('same','Recruiter','+919000000001'), person('same','Recruiter','+919000000001')], target,2); assert.equal(picked.selected.length,1);
  // 15 literal phone values
  assert.equal(contact.literalPhone('+919876543210'), '+919876543210'); assert.equal(contact.literalPhone('=1+1'), "'=1+1");
  // 16 paid-call dedupe key
  assert.equal(selector.personKey({ id:'abc' }), selector.personKey({ apolloPersonId:'abc' }));
  // 17 company discovery and contact enrichment are independent modes.
  const enriched = intent.compile('Find 20 AI startups in India and enrich both POCs'); assert.equal(enriched.missionType,'apollo_company_discovery'); assert.equal(enriched.enrichmentRequested,false); assert.equal(enriched.contactEnrichmentDeferred,true); assert.equal(enriched.reserveCount,0);
  // 18 discovery-only performs organization search without contact reveal
  let contactReveals = 0; await discovery.discover(mission,{fetchPage:async()=>({items:Array.from({length:20},(_,i)=>company(`zero-${i}`,`AI Zero ${i}`,50))}), reveal:async()=>{contactReveals++;}}); assert.equal(contactReveals,0);
  // Routing/source ownership
  assert.equal(control.claim('Find 20 AI startups in India').domain,'apollo-lead'); assert.equal(control.claim('Find 20 companies with active SAP jobs posted last week').domain,'linkedin'); assert.equal(control.claim('Find companies from LinkedIn').domain,'linkedin');
  // Simple company commands use an SMB-focused search preference, not a hidden hard cap.
  const simple = intent.compile('find me 25 tech product companies');
  assert.equal(control.claim(simple.query).domain, 'apollo-lead'); assert.equal(simple.targetCount, 25);
  assert.equal(intent.isApolloLeadControlRequest('Apollo lead progress'), true);
  assert.equal(control.claim('Apollo lead progress').domain, 'apollo-lead');
  assert.equal(control.claim('Apollo lead status').controller, 'apollo-lead-domain-controller');
  assert.equal(intent.isApolloLeadControlRequest('Apollo lead doctor'), true);
  assert.deepEqual(
    {
      min:simple.employeeRange.min,
      max:simple.employeeRange.max,
      preferredMin:simple.employeeRange.preferredMin,
      preferredMax:simple.employeeRange.preferredMax,
      hard:simple.employeeRange.hard,
    },
    { min:10, max:500, preferredMin:20, preferredMax:300, hard:false }
  );
  assert.equal(ranker.explicitSizePass(company('boundary','Boundary Product',1000), simple), true, 'implicit SMB preference must not hard-reject a larger otherwise-relevant company');
  assert.equal(ranker.explicitSizePass(company('too-large','Large Product',1001), simple), true);
  // Real-world discovery must broaden deterministically when a compound Apollo keyword search returns zero.
  const variants = discovery.buildSearchVariants(simple);
  assert.ok(variants.some((v) => v.keywords.length > 1), 'keep a precise compound search first');
  assert.ok(variants.some((v) => v.keywords.length === 1 && v.keywords[0] === 'product'));
  assert.ok(variants.some((v) => v.keywords.length === 1 && v.keywords[0] === 'technology'));
  assert.ok(variants.some((v) => v.relaxSize === true), 'implicit SMB preference must have a bounded relaxed-size fallback');

  const attemptedVariants = [];
  const broadened = await discovery.discover(simple, {
    maxSearchCalls: 5,
    fetchPage: async (_mission, _page, _perPage, variant) => {
      attemptedVariants.push(variant.id);
      if (variant.id === 'combined-keywords') return { items: [] };
      if (variant.id === 'keyword:product') {
        return { items: Array.from({ length: 30 }, (_, i) => company(`product-${i}`, `Product Tech ${i}`, 40 + i, 'technology software product platform')) };
      }
      return { items: [] };
    },
  });
  assert.ok(broadened.organizations.length >= 25);
  assert.deepEqual(attemptedVariants.slice(0, 2), ['combined-keywords', 'keyword:product']);
  assert.ok(broadened.apolloCalls >= 2 && broadened.apolloCalls <= 5);
  assert.ok(broadened.searchVariantsTried >= 2);
  assert.equal(broadened.searchDiagnostics[0].rawReturned, 0);
  assert.equal(broadened.searchDiagnostics[1].qualifiedAfterMerge >= 25, true);

  // Negated contact clauses do not steal discovery-only Sheet prompts from Apollo lead discovery.
  const detailedQuery = 'Find 25 technology product startup companies in India. Fill https://docs.google.com/spreadsheets/d/example/edit?gid=123 worksheet Arya-24 sept. Discovery only - do not find POCs, emails, or phone numbers.';
  assert.equal(intent.existingSheetEnrichment(detailedQuery), false); assert.equal(control.claim(detailedQuery).domain, 'apollo-lead');
  // Markdown-rendered Sheet links must use the destination URL, not an escaped visible label.
  const markdownSheetQuery = 'Find me 25 tech product companies. Fill this Google Sheet: [https://docs.google.com/spreadsheets/d/14A6ElzTqKG4Gxc\\_dqpI8Iz3NLrZ2MpcpfvBBym8hsww/edit?gid=1566066221#gid=1566066221](https://docs.google.com/spreadsheets/d/14A6ElzTqKG4Gxc_dqpI8Iz3NLrZ2MpcpfvBBym8hsww/edit?gid=1566066221#gid=1566066221), worksheet "Arya". Discovery only.';
  const markdownSheet = intent.compile(markdownSheetQuery).sheet;
  assert.equal(markdownSheet.url, 'https://docs.google.com/spreadsheets/d/14A6ElzTqKG4Gxc_dqpI8Iz3NLrZ2MpcpfvBBym8hsww/edit?gid=1566066221#gid=1566066221');
  assert.equal(markdownSheet.sheetName, 'Arya');
  // @mentions must be able to inherit a live Google Sheet identity from routed
  // attachment metadata. If that metadata is absent, the mission preflight must
  // fail before Apollo is approved/called rather than silently writing zero rows.
  const mentionedSheet = intent.compile(
    'Find me 25 tech product companies. Fill this Google Sheet: @24-sept, worksheet "Arya". Discovery only.',
    {
      attachments: [{
        id: 'file-24-sept',
        name: '24-sept.xlsx',
        source: 'google_drive',
        metadata: {
          spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/14A6ElzTqKG4Gxc_dqpI8Iz3NLrZ2MpcpfvBBym8hsww/edit',
        },
      }],
    },
  ).sheet;
  assert.equal(mentionedSheet.requested, true);
  assert.equal(mentionedSheet.attachmentResolved, true);
  assert.equal(mentionedSheet.url, 'https://docs.google.com/spreadsheets/d/14A6ElzTqKG4Gxc_dqpI8Iz3NLrZ2MpcpfvBBym8hsww/edit');
  assert.equal(mentionedSheet.sheetName, 'Arya');

  const unresolvedMention = intent.compile(
    'Find me 25 tech product companies. Fill this Google Sheet: @__apollo_selftest_unbound_20260924__, worksheet "Arya". Discovery only.',
    { attachments: [{ id:'local-only', name:'selftest.xlsx', source:'local', metadata:null }] },
  ).sheet;
  assert.equal(unresolvedMention.requested, true);
  assert.equal(unresolvedMention.url, '');
  await assert.rejects(
    () => apolloLeadController.preflightDestination({ ...simple, sheet: unresolvedMention }),
    (error) => error?.code === 'APOLLO_LEAD_SHEET_SOURCE_UNRESOLVED'
  );
  // A positive request to enrich POCs in an existing Sheet remains owned by universal enrichment.
  const enrichmentQuery = 'Use https://docs.google.com/spreadsheets/d/example/edit?gid=123 and enrich both POCs with Apollo.';
  assert.equal(intent.existingSheetEnrichment(enrichmentQuery), true); assert.equal(control.claim(enrichmentQuery).domain, 'spreadsheet-enrichment');
  // Multiple size bands preserve the wider hard allowance and narrower preference.
  const ranged = intent.parseEmployeeRange('Prefer 0-300 employees and allow 0-500 employees.');
  assert.deepEqual({ min:ranged.min, max:ranged.max, preferredMin:ranged.preferredMin, preferredMax:ranged.preferredMax }, { min:0, max:500, preferredMin:0, preferredMax:300 });
  console.log('Apollo Lead Intelligence self-test passed: Apollo progress ownership, attachment-backed Sheet targeting, company discovery broadening, SMB preference with bounded size relaxation, source ownership, strict split modes, verified two-POC selection, contactability policy, safe projection and zero-reveal discovery validated.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
