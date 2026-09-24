'use strict';

function text(v) { return String(v == null ? '' : v).trim(); }
function words(v) { return new Set(text(v).toLowerCase().replace(/[^a-z0-9+]+/g, ' ').split(/\s+/).filter((w) => w.length > 1)); }
function domain(value) { try { return new URL(/^https?:\/\//i.test(text(value)) ? text(value) : `https://${text(value)}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } }
function employeeCount(o = {}) { return Number(o.estimated_num_employees ?? o.employee_count ?? o.num_employees ?? o.organization_headcount ?? 0) || null; }
function linkedin(o = {}) { return text(o.linkedin_url || o.linkedin || o.linkedin_company_url); }
function website(o = {}) { return text(o.website_url || o.website || o.primary_domain || o.domain); }
function name(o = {}) { return text(o.name || o.organization_name); }
function locationText(o = {}) { return [o.city, o.state, o.country, o.raw_address, o.location].map(text).filter(Boolean).join(' '); }
function evidenceText(o = {}) { return [name(o), o.short_description, o.description, o.industry, ...(o.keywords || []), ...(o.technology_names || []), ...(o.__apolloQueryEvidence || [])].map(text).filter(Boolean).join(' '); }

function scoreOrganization(o, mission = {}) {
  const evidence = words(evidenceText(o));
  const wanted = (mission.expandedKeywords || mission.keywords || []).flatMap((k) => [...words(k)]);
  const hits = wanted.filter((w) => evidence.has(w)).length;
  const count = employeeCount(o);
  const location = locationText(o).toLowerCase();
  const geography = text(mission.geography).toLowerCase();
  let score = Math.min(45, hits * 7);
  if (geography && location.includes(geography)) score += 20;
  if (count != null && count >= 20 && count <= 300) score += 22;
  else if (count != null && count >= 10 && count <= 500) score += 14;
  else if (count != null && count > 5000) score -= 35;
  else if (count != null && count > 1000) score -= 20;
  if (/\b(product|platform|saas|software|startup|technology|cloud|subscription)\b/i.test(evidenceText(o))) score += 10;
  if (/\b(staffing|recruitment agency|training institute|outsourcing[- ]only|consulting[- ]only|body shopping|digital marketing agency|web development agency|service provider)\b/i.test(evidenceText(o)) && !/\b(staffing|recruit|consult|service provider)/i.test(mission.query || '')) score -= 30;
  if (linkedin(o)) score += 4;
  if (domain(website(o))) score += 4;
  return score;
}

function organizationKey(o = {}) { return text(o.id || o.organization_id) || domain(website(o)) || linkedin(o).toLowerCase() || name(o).toLowerCase().replace(/\W+/g, ''); }
function normalizeOrganization(o, mission = {}) {
  return { raw: o, id: text(o.id || o.organization_id), name: name(o), domain: domain(website(o)), website: website(o), linkedinUrl: linkedin(o), companyLink: linkedin(o) || website(o), employees: employeeCount(o), industry: text(o.industry), location: locationText(o), description: text(o.short_description || o.description), score: scoreOrganization(o, mission), key: organizationKey(o) };
}
function explicitSizePass(o, mission = {}) { const r = mission.employeeRange || {}; if (!r.explicit && !r.hard) return true; const n = employeeCount(o); if (n == null) return Boolean(o.__apolloEmployeeRangeVerified); return (r.min == null || n >= r.min) && (r.max == null || n <= r.max); }
function relevancePass(o, mission = {}) { const normalized = o.raw ? o : normalizeOrganization(o, mission); const evidence = words(evidenceText(normalized.raw || o)); const wanted = (mission.expandedKeywords || mission.keywords || []).flatMap((keyword) => [...words(keyword)]); const keywordMatch = !wanted.length || wanted.some((word) => evidence.has(word)); return normalized.name && normalized.companyLink && keywordMatch && normalized.score >= (mission.keywords?.length ? 20 : 5); }
function rankOrganizations(items = [], mission = {}) {
  const seen = new Set();
  return items.map((o) => normalizeOrganization(o, mission)).filter((o) => {
    if (!o.key || seen.has(o.key) || !explicitSizePass(o.raw, mission) || !relevancePass(o, mission)) return false;
    seen.add(o.key); return true;
  }).sort((a, b) => b.score - a.score || ((a.employees || 999999) - (b.employees || 999999)) || a.name.localeCompare(b.name));
}

module.exports = { text, domain, employeeCount, linkedin, website, name, locationText, evidenceText, scoreOrganization, organizationKey, normalizeOrganization, explicitSizePass, relevancePass, rankOrganizations };
