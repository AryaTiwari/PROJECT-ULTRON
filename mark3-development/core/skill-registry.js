'use strict';

const SKILLS = Object.freeze([
  {
    id:'spreadsheet.resume-contact-enrichment',
    domain:'spreadsheet-enrichment',
    controller:'universal-spreadsheet-domain-controller',
    description:'Resume or continue verified POC/contact enrichment in an existing spreadsheet.',
    signals:[/\b(?:resume|continue)\s+enrichment\b/i,/\b(?:poc|contact|phone|email)\b/i,/docs\.google\.com\/spreadsheets/i],
    required:['spreadsheet'],
    risk:'paid-after-approval',
  },
  {
    id:'spreadsheet.contact-enrichment',
    domain:'spreadsheet-enrichment',
    controller:'universal-spreadsheet-domain-controller',
    description:'Enrich existing spreadsheet rows with verified people, POCs, phone and email.',
    signals:[/\b(?:enrich|fill|complete|repair|verify)\b/i,/\b(?:poc|contact|phone|email|decision maker)\b/i,/\b(?:sheet|spreadsheet|worksheet|tab)\b/i],
    required:['spreadsheet'],
    risk:'paid-after-approval',
  },
  {
    id:'apollo.company-research',
    domain:'apollo-lead',
    controller:'apollo-lead-domain-controller',
    description:'Research companies with Apollo under structured geography/size/topic constraints.',
    signals:[/\bapollo\b/i,/\b(?:companies|company|startups|businesses|organizations)\b/i,/\b(?:find|research|discover|search|source)\b/i],
    required:[],
    risk:'paid-after-approval',
  },
  {
    id:'apollo.people-research',
    domain:'apollo-lead',
    controller:'apollo-lead-domain-controller',
    description:'Research people or decision-makers with Apollo.',
    signals:[/\bapollo\b/i,/\b(?:people|persons|founders|recruiters|decision makers|contacts)\b/i,/\b(?:find|research|discover|search|source)\b/i],
    required:[],
    risk:'paid-after-approval',
  },
  {
    id:'linkedin.company-research',
    domain:'linkedin',
    controller:'linkedin-domain-controller',
    description:'Research companies/jobs on LinkedIn under mission safety limits.',
    signals:[/\blinkedin\b/i,/\b(?:companies|company|jobs|hiring|employers)\b/i,/\b(?:find|research|discover|search|source)\b/i],
    required:[],
    risk:'account-safety',
  },
  {
    id:'linkedin.people-research',
    domain:'linkedin',
    controller:'linkedin-domain-controller',
    description:'Research people/profiles on LinkedIn under mission safety limits.',
    signals:[/\blinkedin\b/i,/\b(?:people|persons|profiles|recruiters|founders|employees)\b/i,/\b(?:find|research|discover|search|source)\b/i],
    required:[],
    risk:'account-safety',
  },
  {
    id:'system.diagnostic',
    domain:'diagnostic',
    controller:'diagnostic-domain-controller',
    description:'Inspect Mark 3 routing, provider, enrichment and recovery health without side effects.',
    signals:[/\b(?:mark\s*3|ultron)\b/i,/\b(?:diagnostic|doctor|health|self[- ]?heal|why.*(?:fail|break))\b/i],
    required:[],
    risk:'read-only',
  },
]);

function list() { return SKILLS.map((skill)=>({ ...skill, signals:undefined })); }
function get(id) { return SKILLS.find((skill)=>skill.id===id) || null; }

module.exports={SKILLS,list,get};
