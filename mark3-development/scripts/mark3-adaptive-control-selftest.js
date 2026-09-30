#!/usr/bin/env node
'use strict';

const assert=require('node:assert/strict');

require('../core/universal-deterministic-bootstrap').install();

const schemaTools=require('../core/universal-sheet-schema');
const engine=require('../core/universal-enrichment-engine');
const operator=require('../core/universal-sheet-enrichment-operator');
const anchorPolicy=require('../core/person-anchor-enrichment-policy');
const indiaPolicy=require('../core/india-preference-policy');
const apollo=require('../core/apollo-enrichment');
const apolloCompiler=require('../core/apollo-lead-intent-compiler');
const apolloRanker=require('../core/apollo-company-ranker');
const linkedinCompiler=require('../core/linkedin-request-compiler');
const linkedinContract=require('../core/linkedin-mission-contract');
const chooser=require('../core/skill-chooser');
const diagnostics=require('../core/adaptive-diagnostic-layer');
const commandControl=require('../core/command-control-plane');
const universalController=require('../core/universal-spreadsheet-domain-controller');

(async()=>{
  const headers=['COMPANY NAME','COMPANY LINK','1st POC NAME','PHONE','EMAIL','2ND POC NAME','PHONE','EMAIL'];
  const row=['Abhishek Tiwari','ID: https://www.linkedin.com/in/abhishek-tiwari-31174012a/','','','','','',''];
  const rows=[headers,row];
  const schema=schemaTools.inferSchema(rows,{expectedPersonGroups:2});
  const plan=engine.analyzeSheet(rows,{schema:{expectedPersonGroups:2}}).rowPlans[0].plan;
  const poc1=anchorPolicy.pocGroup(plan,1);

  assert.equal(anchorPolicy.isSemanticPersonAnchor(plan),true);
  assert.ok(poc1);
  assert.equal(operator.anchorNeedsHydration(plan,{},poc1),true,'semantic anchor must request POC-1 contact fields');

  const originalResolve=apollo.resolvePersonProfile;
  let resolveOptions=null;
  apollo.resolvePersonProfile=async(_url,options)=>{
    resolveOptions={...options};
    return {
      id:'apollo-anchor-1',
      apolloPersonId:'apollo-anchor-1',
      name:'Abhishek Tiwari',
      title:'Senior Talent Acquisition Manager',
      linkedinUrl:'https://www.linkedin.com/in/abhishek-tiwari-31174012a/',
      organizationName:'Example India Pvt Ltd',
      organizationDomain:'example.in',
      country:'India',
      phone:'+919876543210',
      email:'abhishek@example.in',
      identityVerified:true,
    };
  };
  try{
    const resolved=await operator.resolvePersonAnchor(plan,row,{
      completeContacts:true,
      allowLinkedInEmployerFallback:false,
      destinationGroup:poc1,
    });
    assert.equal(resolveOptions.needPhone,true);
    assert.equal(resolveOptions.needEmail,true);
    assert.equal(resolved.company,'Example India Pvt Ltd');
    const decision=anchorPolicy.decision(plan,resolved.anchorPerson,resolved);
    assert.equal(decision.useAnchorAsPoc1,true);
    assert.equal(decision.reason,'exact-anchor-has-usable-phone');
  }finally{apollo.resolvePersonProfile=originalResolve;}

  const noPhone={
    name:'Abhishek Tiwari',title:'Senior Talent Acquisition Manager',
    organizationName:'Example India Pvt Ltd',organizationDomain:'example.in',
    linkedinUrl:'https://www.linkedin.com/in/abhishek-tiwari-31174012a/',
    identityVerified:true,
  };
  const fallback=anchorPolicy.decision(plan,noPhone,{company:'Example India Pvt Ltd',domain:'example.in'});
  assert.equal(fallback.useAnchorAsPoc1,false);
  assert.equal(fallback.reason,'anchor-phone-unavailable');

  assert.equal(indiaPolicy.companyResearch('find 20 SaaS companies on Apollo','','organization').geography,'India');
  assert.equal(indiaPolicy.companyResearch('find 20 SaaS companies in Singapore on Apollo','Singapore','organization').preferIndia,false);
  assert.equal(indiaPolicy.companyResearch('remove location filter and find 20 companies','','organization').preferIndia,false,'explicit no-location instruction must override the India default');

  const apolloIndia=apolloCompiler.compile('find 20 SaaS companies on Apollo');
  assert.equal(apolloIndia.geography,'India');
  assert.equal(apolloIndia.indiaCompanyPolicy.preferIndia,true);
  const apolloSingapore=apolloCompiler.compile('find 20 SaaS companies in Singapore on Apollo');
  assert.equal(apolloSingapore.geography,'Singapore');
  assert.equal(apolloSingapore.indiaCompanyPolicy.preferIndia,false);

  const ranked=apolloRanker.rankOrganizations([
    {id:'us',name:'US SaaS',linkedin_url:'https://linkedin.com/company/us-saas',country:'United States',estimated_num_employees:100,keywords:['saas','software']},
    {id:'in',name:'India SaaS',linkedin_url:'https://linkedin.com/company/india-saas',country:'India',estimated_num_employees:100,keywords:['saas','software']},
  ],apolloIndia);
  assert.equal(ranked[0].id,'in','India-first company policy must rank Indian company first');

  const ir={
    entityMode:'company',targetMode:'additional',targetValue:20,topic:'SaaS',hiringRequired:false,
    locationScope:'job',allowedLocations:[],preferredLocations:[],employeeMin:null,employeeMax:null,
    workType:null,workTypeStrictness:'none',jobType:null,experienceLevel:null,datePosted:null,postingAgeDays:null,
    workplaceTypes:[],preferredWorkplaceTypes:[],applicantMax:null,locationRadiusKm:null,locationExpandable:false,
    locationMaximumRadiusKm:null,outputMode:'lead-discovery',easyApply:false,useFinalMaster:false,
    resumeExistingPool:false,reuseCachedEvidence:false,wantsContacts:false,linkedinOnly:true,
  };
  const validated=linkedinCompiler.normalizedIR(ir);
  assert.equal(validated.ok,true);
  const linkedinIndia=linkedinCompiler.applyCompanyResearchPolicy(validated.value,'find 20 SaaS companies on LinkedIn');
  assert.deepEqual(linkedinIndia.allowedLocations,['India']);
  assert.deepEqual(linkedinIndia.preferredLocations,['India']);
  const linkedinGlobal=linkedinCompiler.applyCompanyResearchPolicy(linkedinCompiler.normalizedIR(ir).value,'find 20 SaaS companies worldwide on LinkedIn');
  assert.deepEqual(linkedinGlobal.allowedLocations,[]);

  const contract=linkedinContract.compile('find 20 companies on LinkedIn',{entityMode:'company',count:20},{knownLocations:['India','Maharashtra','Bengaluru']});
  assert.deepEqual(contract.hard.locations,['India']);
  assert.deepEqual(contract.preferences.locations,['India']);

  const sheetSkill=chooser.choose(
    'google sheet url: https://docs.google.com/spreadsheets/d/abc/edit worksheet name - Aryatry resume enrichment with number and email of 1st poc and 2nd poc',
    {domain:'spreadsheet-enrichment',controller:'universal-spreadsheet-domain-controller'}
  );
  assert.equal(sheetSkill.selected,'spreadsheet.resume-contact-enrichment');
  assert.equal(sheetSkill.executionAuthority,false);
  assert.ok(sheetSkill.candidates.length<=3);

  const apolloSkill=chooser.choose('find 30 software companies using Apollo',{domain:'apollo-lead',controller:'apollo-lead-domain-controller'});
  assert.equal(apolloSkill.selected,'apollo.company-research');

  const healthSkill=chooser.choose('Ultron Mark 3 diagnostic',{domain:'diagnostic',controller:'diagnostic-domain-controller'});
  assert.equal(healthSkill.selected,'system.diagnostic');

  const networkError=Object.assign(new Error('Failed to fetch Google Sheets metadata'),{
    code:'GOOGLE_SHEETS_NETWORK',subsystem:'GOOGLE_SHEETS',errorType:'NETWORK',stage:'preapproval-inspection',
  });
  const safe=diagnostics.assess(networkError,{route:'spreadsheet-enrichment',approvalReentry:false,paidExecution:false});
  assert.equal(safe.autoRetry,true);
  assert.equal(safe.safeAction,'retry_safe_read');

  const paid=diagnostics.assess(networkError,{route:'spreadsheet-enrichment',approvalReentry:true,paidExecution:true});
  assert.equal(paid.autoRetry,false,'paid approval execution must never replay automatically');

  const schemaError=Object.assign(new Error('schema confidence low'),{
    code:'UNIVERSAL_SCHEMA_CONFIDENCE_TOO_LOW',subsystem:'SCHEMA',errorType:'SCHEMA',stage:'preapproval-inspection',
  });
  const uncertain=diagnostics.assess(schemaError,{route:'spreadsheet-enrichment'});
  assert.equal(uncertain.userActionRequired,true);
  assert.match(uncertain.question,/which columns/i);

  const originalHandle=universalController.handle;
  try{
    let attempts=0;
    universalController.handle=async()=>{
      attempts++;
      if(attempts===1){
        return {
          ok:false,
          text:'Universal spreadsheet inspection stopped safely.',
          response:'Universal spreadsheet inspection stopped safely.',
          error:'GOOGLE_SHEETS_NETWORK',
          errorCode:'GOOGLE_SHEETS_NETWORK',
          errorSubsystem:'GOOGLE_SHEETS',
          errorType:'NETWORK',
          errorStage:'preapproval-inspection',
          errorMessage:'Failed to fetch Google Sheets metadata',
        };
      }
      return {ok:true,text:'Recovered after one safe read retry.',response:'Recovered after one safe read retry.'};
    };
    const healed=await commandControl.dispatch(
      'google sheet url: https://docs.google.com/spreadsheets/d/adaptivefixture/edit worksheet name - Aryatry resume enrichment with number and email of 1st poc and 2nd poc'
    );
    assert.equal(attempts,2,'typed returned safe-read failure must receive one bounded retry');
    assert.equal(healed.ok,true);
    assert.equal(healed.diagnostic?.healed,true);

    attempts=0;
    universalController.handle=async()=>{
      attempts++;
      return {
        ok:false,
        text:'Universal spreadsheet enrichment stopped safely.',
        response:'Universal spreadsheet enrichment stopped safely.',
        error:'UNIVERSAL_SCHEMA_CONFIDENCE_TOO_LOW',
        errorCode:'UNIVERSAL_SCHEMA_CONFIDENCE_TOO_LOW',
        errorSubsystem:'SCHEMA',
        errorType:'SCHEMA',
        errorStage:'schema-confidence-gate',
        errorMessage:'Schema confidence is below the safe threshold.',
      };
    };
    const clarification=await commandControl.dispatch(
      'google sheet url: https://docs.google.com/spreadsheets/d/adaptivefixture/edit worksheet name - Aryatry resume enrichment with number and email of 1st poc and 2nd poc'
    );
    assert.equal(attempts,1,'schema ambiguity must not be blindly retried');
    assert.equal(clarification.ok,false);
    assert.match(clarification.text,/which columns/i,'returned schema ambiguity must ask a targeted user question');
  }finally{
    universalController.handle=originalHandle;
  }

  console.log('Mark 3 adaptive control regression passed: Aryatry person anchors request exact Apollo POC-1 contact data, no-phone anchors fall back to company decision-makers, India-first company research is shared across Apollo/LinkedIn, skill selection is top-k/read-only, returned/thrown diagnostics retry only safe pre-approval reads, and schema ambiguity asks the user instead of guessing.');
})().catch((error)=>{console.error(error);process.exitCode=1;});
