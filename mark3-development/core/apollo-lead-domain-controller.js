'use strict';
const compiler = require('./apollo-lead-intent-compiler');
const paid = require('./paid-tool-approval');
const missionStore = require('./apollo-lead-mission-store');
const companies = require('./apollo-company-discovery');
const people = require('./apollo-people-discovery');
const apollo = require('./apollo-enrichment');
const selector = require('./apollo-poc-selector');
const contact = require('./apollo-contactability-policy');
const projector = require('./apollo-lead-sheet-projector');
const runtimeBuild = require('./runtime-build');
const OPERATION = 'apollo-lead-intelligence';
const running = new Map();

function response(ok, body, extra = {}) { return { ok, response: body, text: body, model: 'apollo-lead-intelligence', provider: 'apollo', taskType: 'apollo-lead-intelligence', mode: 'operator', toolRounds: 0, ...extra }; }
function summary(mission) { const range = mission.compiledFilters.employeeRange || {}; return `Mission ${mission.missionId}: ${mission.missionType}; target ${mission.targetCount}; geography ${mission.compiledFilters.geography || 'any'}; size ${range.min ?? 0}-${range.max ?? 'any'}; contact enrichment ${mission.compiledFilters.enrichmentRequested ? 'requested' : 'not requested'}.`; }
function elapsed(mission) { const start = Date.parse(mission?.startedAt || mission?.createdAt || ''); return Number.isFinite(start) ? Math.max(0, Math.round((Date.now() - start) / 1000)) : 0; }
function progressSummary(mission) {
  if (!mission) return 'No Apollo lead mission exists yet.';
  if (mission.currentPhase === 'completed' && mission.finalMessage) return `${mission.finalMessage}\nMission ${mission.missionId} completed in ${elapsed(mission)}s with ${mission.apolloCalls || 0} Apollo organization-search call(s). Runtime build: ${mission.runtimeBuild || 'unknown'}.`;
  if (mission.currentPhase === 'failed') return `Apollo lead mission ${mission.missionId} failed safely: ${mission.failureMessage || mission.failureCode || 'unknown failure'}. Apollo calls: ${mission.apolloCalls || 0}. Runtime build: ${mission.runtimeBuild || 'unknown'}.`;
  return `Apollo lead mission ${mission.missionId}: ${mission.currentPhase || 'created'}. Runtime build: ${mission.runtimeBuild || 'unknown'}. Qualified companies: ${mission.companiesQualified || 0}/${mission.targetCount || 0}; candidates received: ${mission.companyCandidatesFound || 0}; queries: ${mission.queriesCompleted || 0}/${mission.queriesPlanned || '?'}${mission.currentQuery ? ` (${mission.currentQuery})` : ''}; Apollo organization-search calls: ${mission.apolloCalls || 0}; rows written: ${mission.rowsWritten || 0}; remaining: ${mission.remainingTarget ?? mission.targetCount ?? 0}; elapsed: ${elapsed(mission)}s.`;
}
function formatCompanyLines(rows) { return rows.slice(0, 30).map((r, i) => `${i + 1}. ${r.name} — ${r.companyLink}`).join('\n'); }
function formatPeopleLines(rows) { return rows.slice(0, 30).map((r, i) => `${i + 1}. ${r.name} — ${r.title || 'role unavailable'} — ${r.linkedinUrl || 'Apollo profile'}`).join('\n'); }

function track(missionId, promise) {
  running.set(missionId, promise);
  promise.catch((error) => missionStore.update(missionId, { currentPhase: 'failed', safetyState: 'failed', failureCode: error.code || 'APOLLO_LEAD_MISSION_FAILED', failureMessage: error.message, completedAt: new Date().toISOString() })).finally(() => running.delete(missionId));
  return promise;
}

async function hydrateCompanyPocs(company, compiled, state) {
  const candidates = await people.forCompany(company, { location: compiled.geography, limit: 12 }); state.peopleDiscovered += candidates.length; state.apolloCalls += 1;
  const ranked = [...candidates].filter((p) => selector.acceptable(p, company)).sort(selector.compare(1)).slice(0, 3); const hydrated = [];
  for (const candidate of ranked) { try { const item = await apollo.resolveDecisionMaker(candidate, company.name, company.domain, { needEmail: true, needPhone: true }); state.apolloCalls++; state.paidCalls++; state.peopleVerified++; state.phoneAvailabilityChecked++; if (item.phone) state.phoneReveals++; if (item.email) state.emailReveals++; hydrated.push(item); } catch (error) { if (!['APOLLO_IDENTITY_MISMATCH','APOLLO_COMPANY_MISMATCH_AFTER_HYDRATION'].includes(error.code)) throw error; } }
  return selector.selectPocs(hydrated, company, compiled.requestedPocs);
}

async function executeApproved(compiled, missionId) {
  const startedAt = new Date().toISOString();
  const plans = companies.queryPlans(compiled);
  const mission = missionStore.update(missionId, { currentPhase: 'searching', safetyState: 'approved', startedAt, runtimeBuild: runtimeBuild.id, searchVariants: plans.map((plan) => plan.label), queriesPlanned: plans.length, queriesCompleted: 0, companyCandidatesFound: 0, companiesQualified: 0 }) || missionStore.create(compiled);
  const state = { apolloCalls: 0, paidCalls: 0, peopleDiscovered: 0, peopleVerified: 0, phoneAvailabilityChecked: 0, phoneReveals: 0, emailReveals: 0 };
  if (compiled.missionType === 'apollo_people_discovery') {
    const found = await people.discoverPeople(compiled); const rows = found.people;
    missionStore.update(mission.missionId, { currentPhase: 'writing', peopleDiscovered: found.candidatesFound, peopleVerified: rows.length, apolloCalls: found.apolloCalls, paidCalls: found.paidCalls });
    const projection = await projector.project(compiled, rows.map((p) => ({ name: p.organizationName || p.organization_name || 'Apollo people result', companyLink: p.organizationDomain ? 'https://' + p.organizationDomain : '', poc1: p })), { includePeople: true });
    const body = `Source: Apollo\nPeople discovered: ${rows.length}\nRows written: ${projection.rowsWritten}\nApollo contact reveals: 0\n${formatPeopleLines(rows)}`;
    const final = missionStore.update(mission.missionId, { currentPhase: 'completed', completionReason: rows.length >= compiled.targetCount ? 'target_reached' : 'source_exhausted', companiesSelected: rows.length, rowsWritten: projection.rowsWritten, remainingTarget: Math.max(0, compiled.targetCount - rows.length), safetyState: 'complete', completedAt: new Date().toISOString(), finalMessage: body, sheetName: projection.sheetName, sheetUrl: projection.sheetUrl });
    return response(true, body, { mission: final, records: rows, projection });
  }
  const discovered = await companies.discover(compiled, { plans, onProgress: (progress) => missionStore.update(mission.missionId, { currentPhase: progress.phase, currentQuery: progress.query, queriesPlanned: progress.queriesPlanned, queriesCompleted: progress.queriesCompleted, companyCandidatesFound: progress.candidatesFound, companiesQualified: progress.companiesQualified, remainingTarget: progress.remainingTarget, apolloCalls: progress.apolloCalls, paidCalls: progress.paidCalls, providerFailures: progress.providerFailures }) });
  state.apolloCalls += discovered.apolloCalls; state.paidCalls += discovered.paidCalls; let selected = discovered.organizations.slice(0, compiled.targetCount); let replacements = 0;
  if (compiled.enrichmentRequested) { selected = []; const foreignFallback = []; for (const company of discovered.organizations) { if (selected.length >= compiled.targetCount) break; const pocs = await hydrateCompanyPocs(company, compiled, state); const row = { ...company, ...pocs }; const qualities = pocs.selected.map(contact.quality); if (qualities.some((q) => q >= 3)) selected.push(row); else if (qualities.some((q) => q >= 1)) foreignFallback.push(row); else replacements++; } for (const row of foreignFallback) { if (selected.length >= compiled.targetCount) break; selected.push(row); } }
  missionStore.update(mission.missionId, { currentPhase: 'writing', companiesSelected: selected.length, remainingTarget: Math.max(0, compiled.targetCount - selected.length) });
  const projection = await projector.project(compiled, selected, { includePeople: compiled.enrichmentRequested });
  const p1 = selected.filter((r) => r.poc1).length; const p2 = selected.filter((r) => r.poc2).length; const india = selected.flatMap((r) => [r.poc1, r.poc2]).filter((p) => p && contact.indianPhone(p.phone, p.country || p.location)).length; const foreign = selected.flatMap((r) => [r.poc1, r.poc2]).filter((p) => p && contact.validPhone(p.phone) && !contact.indianPhone(p.phone, p.country || p.location)).length;
  const body = compiled.enrichmentRequested ? `Source: Apollo\nCompanies selected: ${selected.length}\nCompanies written: ${projection.rowsWritten}\nPOC-1 filled: ${p1}\nPOC-2 filled: ${p2}\nDiscovery candidates omitted before Sheet insertion due to unusable finalist contacts: ${replacements}\nIndian-number POCs: ${india}\nForeign-number fallback POCs: ${foreign}\nApollo contact reveals: ${state.phoneReveals}` : `Source: Apollo\nCompanies discovered: ${selected.length}\nCompanies written: ${projection.rowsWritten}\nPOC enrichment: not requested\nApollo contact reveals: 0\n${formatCompanyLines(selected)}`;
  const final = missionStore.update(mission.missionId, { currentPhase: 'completed', completionReason: selected.length >= compiled.targetCount ? 'target_reached' : 'query_plan_exhausted', companyCandidatesFound: discovered.candidatesFound, companiesQualified: discovered.qualified, companiesRejected: discovered.rejected, companiesSelected: selected.length, peopleDiscovered: state.peopleDiscovered, peopleVerified: state.peopleVerified, phoneAvailabilityChecked: state.phoneAvailabilityChecked, phoneReveals: state.phoneReveals, emailReveals: state.emailReveals, POC1Selected: p1, POC2Selected: p2, companiesReplacedForContactability: replacements, apolloCalls: state.apolloCalls, paidCalls: state.paidCalls, rowsWritten: projection.rowsWritten, remainingTarget: Math.max(0, compiled.targetCount - selected.length), safetyState: 'complete', completedAt: new Date().toISOString(), finalMessage: body, sheetName: projection.sheetName, sheetUrl: projection.sheetUrl, queriesPlanned: discovered.queriesPlanned, queriesCompleted: discovered.queriesCompleted, providerFailures: discovered.providerFailures, runtimeBuild: runtimeBuild.id });
  return response(true, body, { mission: final, records: selected, projection });
}

async function handle(message, options = {}) {
  if (/\bapollo\s+(?:lead\s+)?(?:mission\s+)?(?:progress|status)\b/i.test(message)) { const latest = missionStore.latest(); return response(true, progressSummary(latest), { mission: latest, background: Boolean(latest && running.has(latest.missionId)) }); }
  const compiled = compiler.compile(message);
  if (compiled.missionType === 'apollo_existing_sheet_enrichment') return require('./universal-spreadsheet-domain-controller').handle(message, options);
  const mission = missionStore.create(compiled); missionStore.update(mission.missionId, { runtimeBuild: runtimeBuild.id, searchVariants: companies.queryPlans(compiled).map((plan) => plan.label) }); const approval = paid.request('apollo', OPERATION, { compiled, missionId: mission.missionId }, summary(mission)); missionStore.update(mission.missionId, { currentPhase: 'waiting_approval', approvalId: approval.id }); return response(true, paid.prompt(approval), { mission, paidToolApproval: approval, apolloCalled: false, approvalRequired: true });
}
module.exports = { OPERATION, response, summary, elapsed, progressSummary, track, running, hydrateCompanyPocs, executeApproved, handle };