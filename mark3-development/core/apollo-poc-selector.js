'use strict';
const contact = require('./apollo-contactability-policy');

const POC1 = [
  [/\b(founder|co[- ]?founder|owner|managing director|executive director|partner|ceo|chief executive|president)\b/i, 1],
  [/\b(director|general manager|business manager|operations manager|department head|head of people|head hr|hr manager|human resources manager|talent acquisition manager|recruitment manager|hiring manager|people manager)\b/i, 2],
  [/\b(recruit(?:er|ment|ing)?|talent|staffing|people operations|hr business partner|hiring specialist)\b/i, 3],
];
const POC2 = [
  [/\b(head recruiter|recruitment head|head of talent acquisition|talent acquisition lead|recruitment lead|recruitment manager|talent acquisition manager)\b/i, 1],
  [/\b(hr manager|human resources manager|hr recruiter|technical recruiter|talent acquisition recruiter|recruiter|staffing specialist|people operations|hr business partner|hiring specialist)\b/i, 2],
  [/\b(founder|owner|director|manager|head|partner|ceo|president)\b/i, 3],
];
function tier(title, ordinal) { const list = ordinal === 2 ? POC2 : POC1; return list.find(([re]) => re.test(String(title || '')))?.[1] || 99; }
function personKey(p = {}) { return String(p.apolloPersonId || p.id || p.linkedinUrl || p.linkedin_url || p.email || p.name || '').trim().toLowerCase(); }
function employerVerified(p = {}, company = {}) { if (p.currentEmployerVerified === false || p.apolloSearchEmployerVerified === false || p.identityVerified === false) return false; const pid = String(p.organizationId || p.organization_id || p.organization?.id || ''); if (company.id && pid) return String(company.id) === pid; const pd = String(p.organizationDomain || p.organization_domain || p.organization?.primary_domain || '').toLowerCase(); if (company.domain && pd) return company.domain.toLowerCase() === pd.replace(/^www\./, ''); const pn = String(p.organizationName || p.organization_name || p.organization?.name || '').toLowerCase().replace(/\W+/g, ''); const cn = String(company.name || '').toLowerCase().replace(/\W+/g, ''); return Boolean(cn && pn && (cn === pn || cn.includes(pn) || pn.includes(cn)) || p.apolloSearchEmployerVerified === true); }
function acceptable(p, company) { return tier(p.title || p.headline, 1) < 99 && employerVerified(p, company); }
function compare(ordinal) { return (a, b) => contact.quality(b) - contact.quality(a) || tier(a.title || a.headline, ordinal) - tier(b.title || b.headline, ordinal) || String(a.name || '').localeCompare(String(b.name || '')); }
function selectPocs(people = [], company = {}, count = 2) { const seen = new Set(); const pool = people.filter((p) => acceptable(p, company)).filter((p) => { const k = personKey(p); if (!k || seen.has(k)) return false; seen.add(k); return true; }); const first = [...pool].sort(compare(1))[0] || null; const second = count > 1 ? [...pool].filter((p) => personKey(p) !== personKey(first)).sort(compare(2))[0] || null : null; return { poc1: first, poc2: second, selected: [first, second].filter(Boolean) }; }
function preserveExisting(existing = {}, company = {}) { return Boolean(existing.name && employerVerified(existing, company) && contact.validPhone(existing.phone)); }
module.exports = { POC1, POC2, tier, personKey, employerVerified, acceptable, compare, selectPocs, preserveExisting };
