const googleAuth = require('./google-sheets-auth');
const sheets = require('./google-sheets-operator');
const web = require('./web');
const leadResearch = require('./lead-research-operator');
const leadEnrichment = require('./lead-enrichment-operator');
const apollo = require('./apollo-enrichment');
const v2 = require('./lead-workspace-operator-v2');
const sourceFusion = require('./lead-source-fusion');
const linkedinPublic = require('./linkedin-public-research');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const MAX_LEADS = v2.MAX_LEADS;
const DEFAULT_HEADERS = v2.DEFAULT_HEADERS;
const LINKEDIN_COMPANY_HEADERS = ['Company', 'LinkedIn Company URL', 'Location', 'Hiring Signal', 'Post Details', 'Website', 'Phone No', 'Email', 'Source', 'Lead Score'];
const PENDING_TTL_MS = 45 * 60 * 1000;
const SEARCH_RETRY_DELAYS = [450, 1200];

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(url, options = {}) {
  const token = await googleAuth.accessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Google Sheets API failed (${response.status}).`);
    error.status = response.status;
    error.code = response.status === 403 ? 'GOOGLE_SHEETS_FORBIDDEN' : 'GOOGLE_SHEETS_API_ERROR';
    throw error;
  }
  return data;
}

async function appendValues(id, sheetName, rows) {
  if (!rows.length) return { updatedRows: 0 };
  const full = `${sheets.quoteSheet(sheetName)}!A:ZZ`;
  const result = await request(`${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(full)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
  });
  return { updatedRows: Number(result?.updates?.updatedRows || rows.length) };
}

function sourceKeyForHeader(value) {
  const h = v2.normalizeHeader(value);
  if (/^(?:linkedin company|linkedin company url|company linkedin|company linkedin url)$/.test(h)) return 'linkedin';
  if (/^(?:hiring signal|job signal|hiring activity|job activity)$/.test(h)) return 'hiring';
  if (/^(?:maps signal|google maps signal|local signal|business signal)$/.test(h)) return 'maps';
  if (/^(?:source count|evidence count|sources count)$/.test(h)) return 'source_count';
  if (/^(?:evidence sources|source signals|signals|evidence)$/.test(h)) return 'evidence';
  return v2.keyForHeader(value);
}

function leadRow(lead, headers) {
  const row = Array(headers.length).fill('');
  for (let index = 0; index < headers.length; index++) {
    const key = sourceKeyForHeader(headers[index]);
    if (key === 'name') row[index] = lead.name || '';
    else if (key === 'company') row[index] = lead.company || '';
    else if (key === 'role') row[index] = lead.role || '';
    else if (key === 'linkedin') row[index] = lead.linkedin || '';
    else if (key === 'phone') row[index] = lead.phone || '';
    else if (key === 'email') row[index] = lead.email || '';
    else if (key === 'source') row[index] = lead.publicContactSource || lead.source || '';
    else if (key === 'details') row[index] = lead.snippet || '';
    else if (key === 'website') row[index] = lead.signalWebsite || lead.publicContactSource || '';
    else if (key === 'location') row[index] = lead.location || '';
    else if (key === 'quality') row[index] = lead.relevanceScore ?? '';
    else if (key === 'hiring') row[index] = lead.hiringSignal || '';
    else if (key === 'maps') row[index] = lead.mapSignal || '';
    else if (key === 'source_count') row[index] = lead.sourceCount || 0;
    else if (key === 'evidence') row[index] = (lead.sourceEvidence || []).join(', ');
  }
  return row;
}

function normalizeMissionLinkedIn(value, entityMode = 'person') {
  if (entityMode === 'company') return linkedinPublic.normalizeLinkedInEntityUrl(value, 'company')?.url || null;
  return apollo.normalizeLinkedIn(value);
}

function ensureCompanyHeaders(headers, wantsContacts = false) {
  const source = Array.isArray(headers) && headers.length ? headers : LINKEDIN_COMPANY_HEADERS;
  const out = source.map((value) => String(value ?? '').trim()).slice(0, 30);
  const keys = new Set(out.map(sourceKeyForHeader).filter(Boolean));
  if (!keys.has('company') && !keys.has('name')) out.unshift('Company');
  if (!keys.has('linkedin')) out.push('LinkedIn Company URL');
  if (!keys.has('location')) out.push('Location');
  if (!keys.has('hiring')) out.push('Hiring Signal');
  if (wantsContacts && !keys.has('phone')) out.push('Phone No');
  if (wantsContacts && !keys.has('email')) out.push('Email');
  if (!keys.has('source')) out.push('Source');
  return out.slice(0, 30);
}

function dedupeMissionLeads(leads, entityMode = 'person') {
  if (entityMode !== 'company') return v2.dedupeLeads(leads);
  const seenUrl = new Set();
  const seenCompany = new Set();
  const unique = [];
  let removed = 0;
  for (const lead of leads || []) {
    const linkedin = normalizeMissionLinkedIn(lead?.linkedin, 'company');
    const company = sourceFusion.normalizeCompany(lead?.company || lead?.name);
    if ((linkedin && seenUrl.has(linkedin)) || (company && seenCompany.has(company))) {
      removed++;
      continue;
    }
    if (linkedin) seenUrl.add(linkedin);
    if (company) seenCompany.add(company);
    unique.push({ ...lead, linkedin: linkedin || lead.linkedin, entityType: 'company' });
  }
  return { leads: unique, removed };
}

function missionById(state, id) {
  return (state.missions || []).find((item) => item.id === id) || null;
}

function saveMission(mission) {
  const state = v2.loadState();
  const target = missionById(state, mission.id);
  if (target) Object.assign(target, mission);
  else state.missions.push(mission);
  v2.saveState(state);
}

function retryable(error) {
  return v2.retryableWebError(error);
}

async function searchWithFusion(query, options = {}) {
  let primaryError = null;
  const webReady = Boolean(typeof web.status === 'function' ? web.status().configured : false);
  if (webReady) {
    for (let attempt = 0; attempt <= SEARCH_RETRY_DELAYS.length; attempt++) {
      try {
        return await web.searchWeb(query, options);
      } catch (error) {
        primaryError = error;
        if (!retryable(error) || attempt >= SEARCH_RETRY_DELAYS.length) break;
        await sleep(SEARCH_RETRY_DELAYS[attempt]);
      }
    }
  }
  if (sourceFusion.status().serpApiConfigured) {
    const result = await sourceFusion.serpSearch(query, options);
    return { ...result, primaryError: primaryError?.message || null };
  }
  if (primaryError) throw primaryError;
  throw new Error('No public lead search provider is configured.');
}

async function existingLinkedIns(mission) {
  const range = `${sheets.quoteSheet(mission.sheetName)}!A:ZZ`;
  const result = await request(`${API}/${encodeURIComponent(mission.spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`);
  const rows = result.values || [];
  const linkedinIndex = mission.headers.findIndex((header) => sourceKeyForHeader(header) === 'linkedin');
  if (linkedinIndex < 0) throw new Error('The destination sheet no longer has a LinkedIn column, so ULTRON stopped before writing.');
  const set = new Set();
  for (let i = 1; i < rows.length; i++) {
    const url = normalizeMissionLinkedIn(rows[i]?.[linkedinIndex], mission.entityMode || 'person');
    if (url) set.add(url);
  }
  return set;
}

function annotateLead(lead, mission) {
  const annotation = sourceFusion.annotateLead(lead, mission.sourceFusion);
  const evidence = [...new Set([...(lead.sourceEvidence || []), ...(annotation.evidence || [])])];
  lead.sourceCount = evidence.length;
  lead.sourceEvidence = evidence;
  lead.hiringSignal = lead.hiringSignal || annotation.hiringSignal;
  lead.mapSignal = lead.mapSignal || annotation.mapSignal;
  lead.signalWebsite = lead.signalWebsite || annotation.signalWebsite;
  if (!lead.phone && annotation.signalPhone && mission.entityMode === 'company') lead.phone = annotation.signalPhone;
  const baseScore = Number.isFinite(Number(lead.relevanceScore))
    ? Number(lead.relevanceScore)
    : v2.leadRelevanceScore(lead, mission.criteria);
  lead.relevanceScore = Math.min(100, baseScore + annotation.boost);
  return lead;
}

async function deepResearch(leads, mission) {
  const candidates = leads.filter((lead) => !lead.email || !lead.phone);
  const budgets = v2.deepBudgets(leads.length);
  const limited = candidates.slice(0, budgets.maxLeads);
  let searches = Number(mission.deepSearches || 0);
  let fetches = Number(mission.deepFetches || 0);
  let index = Math.max(0, Number(mission.deepIndex || 0));

  for (; index < limited.length; index++) {
    if (searches >= budgets.maxSearches || fetches >= budgets.maxFetches) break;
    const lead = limited[index];
    if (!lead.name) {
      mission.deepIndex = index + 1;
      saveMission(mission);
      continue;
    }

    if (lead.signalWebsite && fetches < budgets.maxFetches && v2.publicScrapeCandidate(lead.signalWebsite)) {
      try {
        const page = await web.fetchPage(lead.signalWebsite, { maxTextChars: 18000 });
        fetches++;
        if (v2.identityEvidence(page.text, lead)) {
          if (!lead.email) lead.email = leadEnrichment.extractRowEmail([page.text]) || lead.email;
          if (!lead.phone) lead.phone = leadEnrichment.extractRowPhone([page.text]) || lead.phone;
          if ((lead.email || lead.phone) && !lead.publicContactSource) lead.publicContactSource = page.url;
        }
      } catch {}
    }

    const company = lead.company ? `"${String(lead.company).replace(/"/g, '')}"` : mission.criteria;
    const queries = mission.entityMode === 'company'
      ? [`${company} official website contact email phone`, `${company} contact careers`]
      : [`"${lead.name}" ${company} email phone contact`, `"${lead.name}" ${company} contact`];
    for (const query of queries) {
      if ((lead.email && lead.phone) || searches >= budgets.maxSearches) break;
      try {
        const result = await searchWithFusion(query, { limit: 5 });
        searches++;
        mission.searchProviders[result.provider || 'unknown'] = Number(mission.searchProviders[result.provider || 'unknown'] || 0) + 1;
        for (const item of result.results || []) {
          const snippet = `${item?.title || ''}\n${item?.snippet || ''}`;
          if (v2.identityEvidence(snippet, lead)) {
            if (!lead.email) lead.email = leadEnrichment.extractRowEmail([snippet]) || lead.email;
            if (!lead.phone) lead.phone = leadEnrichment.extractRowPhone([snippet]) || lead.phone;
            if ((lead.email || lead.phone) && !lead.publicContactSource) lead.publicContactSource = item?.url || lead.publicContactSource;
          }
          if (lead.email && lead.phone) break;
          if (fetches >= budgets.maxFetches || !v2.publicScrapeCandidate(item?.url)) continue;
          try {
            const page = await web.fetchPage(item.url, { maxTextChars: 18000 });
            fetches++;
            if (!v2.identityEvidence(page.text, lead)) continue;
            if (!lead.email) lead.email = leadEnrichment.extractRowEmail([page.text]) || lead.email;
            if (!lead.phone) lead.phone = leadEnrichment.extractRowPhone([page.text]) || lead.phone;
            if ((lead.email || lead.phone) && !lead.publicContactSource) lead.publicContactSource = page.url;
          } catch {}
          if (lead.email && lead.phone) break;
        }
      } catch {}
    }
    mission.deepIndex = index + 1;
    mission.deepSearches = searches;
    mission.deepFetches = fetches;
    mission.updatedAt = nowIso();
    saveMission(mission);
  }

  mission.deepBudgets = budgets;
  mission.deepIndex = index;
  mission.deepSearches = searches;
  mission.deepFetches = fetches;
  mission.updatedAt = nowIso();
  saveMission(mission);
}

async function ensureLinkedInResearch(mission) {
  if (!mission.linkedinPlan?.enabled) return null;
  if (mission.linkedinResearch?.completed) return mission.linkedinResearch;

  mission.phase = 'linkedin-public-research';
  mission.status = 'linkedin-public-research';
  mission.updatedAt = nowIso();
  saveMission(mission);

  const companyNames = mission.entityMode === 'company'
    ? [...new Set((mission.sourceFusion?.jobs || []).map((item) => item.company).filter(Boolean))].slice(0, 12)
    : [];

  const result = await linkedinPublic.research(mission.originalMessage || mission.criteria, mission.requested, {
    entityMode: mission.entityMode,
    location: mission.linkedinPlan.location,
    hiring: mission.linkedinPlan.hiring,
    companyNames,
  });

  mission.linkedinResearch = {
    ...result,
    records: undefined,
  };

  const current = Array.isArray(mission.leads) ? mission.leads : [];
  const incoming = (result.records || []).map((record) => annotateLead({ ...record }, mission));
  const merged = dedupeMissionLeads([...current, ...incoming], mission.entityMode);
  mission.leads = merged.leads;
  mission.duplicatesRemoved = Number(mission.duplicatesRemoved || 0) + merged.removed;

  if (mission.entityMode === 'company') {
    mission.queries = linkedinPublic.queryPlan(mission.originalMessage || mission.criteria, mission.requested, {
      entityMode: 'company',
      location: mission.linkedinPlan.location,
      hiring: mission.linkedinPlan.hiring,
      companyNames,
    });
    if (mission.leads.length >= mission.requested) mission.queryIndex = mission.queries.length;
  }

  mission.updatedAt = nowIso();
  saveMission(mission);
  return mission.linkedinResearch;
}

async function ensureSourceFusion(mission) {
  if (mission.sourceFusion?.completed) return mission.sourceFusion;
  mission.phase = 'source-fusion';
  mission.status = 'source-fusion';
  mission.updatedAt = nowIso();
  saveMission(mission);
  const signals = await sourceFusion.gatherSources({
    originalMessage: mission.originalMessage,
    criteria: mission.criteria,
    count: mission.requested,
  });
  mission.sourceFusion = signals;
  const base = mission.queries?.length ? mission.queries : v2.queryPlan(mission.criteria, mission.requested);
  if (Number(mission.queryIndex || 0) === 0) mission.queries = sourceFusion.mergeQueries(base, signals, mission.criteria, mission.requested);
  else mission.queries = [...new Set([...base, ...(signals.seedQueries || [])])].slice(0, 48);
  mission.updatedAt = nowIso();
  saveMission(mission);
  return signals;
}

async function continueMission(id) {
  const state = v2.loadState();
  const mission = missionById(state, id);
  if (!mission) throw new Error('Lead mission was not found.');
  mission.searchProviders = mission.searchProviders || {};
  mission.failures = mission.failures || [];
  mission.leads = mission.leads || [];

  try {
    await ensureSourceFusion(mission);
    await ensureLinkedInResearch(mission);
    mission.phase = 'search';
    mission.status = 'researching';
    mission.updatedAt = nowIso();
    saveMission(mission);

    const cleaned = dedupeMissionLeads(mission.leads, mission.entityMode || 'person');
    mission.leads = cleaned.leads;
    mission.duplicatesRemoved = Number(mission.duplicatesRemoved || 0) + cleaned.removed;
    const seen = new Set(mission.leads.map((lead) => normalizeMissionLinkedIn(lead.linkedin, mission.entityMode || 'person')).filter(Boolean));
    const seenSecondary = new Set(mission.entityMode === 'company' ? [] : mission.leads.map(v2.secondaryLeadKey).filter(Boolean));
    const queries = mission.queries || v2.queryPlan(mission.criteria, mission.requested);
    mission.queries = queries;
    mission.rejectedLowRelevance = Number(mission.rejectedLowRelevance || 0);
    const failuresAtStart = mission.failures.length;

    for (let i = Number(mission.queryIndex || 0); i < queries.length && mission.leads.length < mission.requested; i++) {
      const query = queries[i];
      try {
        const result = await searchWithFusion(query, { limit: 10 });
        mission.searchProviders[result.provider || 'unknown'] = Number(mission.searchProviders[result.provider || 'unknown'] || 0) + 1;
        for (const item of result.results || []) {
          const lead = mission.entityMode === 'company'
            ? linkedinPublic.parseResult(item, { entityMode: 'company', location: mission.linkedinPlan?.location || '' })
            : leadResearch.parseLead(item, query);
          if (!lead) continue;
          if (mission.entityMode === 'company') {
            lead.relevanceScore = linkedinPublic.scoreRecord(lead, {
              criteria: mission.originalMessage || mission.criteria,
              location: mission.linkedinPlan?.location || '',
              hiring: Boolean(mission.linkedinPlan?.hiring),
              companyNames: (mission.sourceFusion?.jobs || []).map((job) => job.company).filter(Boolean),
            });
          }
          annotateLead(lead, mission);
          const sourceConfirmed = Number(lead.sourceCount || 0) > 0;
          const sourceThreshold = mission.entityMode === 'company' ? 50 : 30;
          if (!v2.qualifiedLead(lead, mission.criteria) && !(sourceConfirmed && lead.relevanceScore >= sourceThreshold)) {
            mission.rejectedLowRelevance++;
            continue;
          }
          const linkedin = normalizeMissionLinkedIn(lead.linkedin, mission.entityMode || 'person');
          const secondary = mission.entityMode === 'company' ? sourceFusion.normalizeCompany(lead.company || lead.name) : v2.secondaryLeadKey(lead);
          if (!linkedin || seen.has(linkedin) || (secondary && seenSecondary.has(secondary))) {
            mission.duplicatesRemoved = Number(mission.duplicatesRemoved || 0) + 1;
            continue;
          }
          seen.add(linkedin);
          if (secondary) seenSecondary.add(secondary);
          lead.linkedin = linkedin;
          if (lead.hiringSignal && !String(lead.snippet || '').includes('Hiring signal:')) lead.snippet = `${lead.snippet || ''}\nHiring signal: ${lead.hiringSignal}`.trim();
          if (lead.mapSignal && !String(lead.snippet || '').includes('Maps signal:')) lead.snippet = `${lead.snippet || ''}\nMaps signal: ${lead.mapSignal}`.trim();
          mission.leads.push(lead);
          if (mission.leads.length >= mission.requested) break;
        }
      } catch (error) {
        mission.failures.push({ query, error: error.message, at: nowIso() });
      }
      mission.queryIndex = i + 1;
      mission.updatedAt = nowIso();
      saveMission(mission);
    }

    const failuresThisPass = mission.failures.length - failuresAtStart;
    if (!mission.leads.length && mission.queryIndex >= queries.length && failuresThisPass >= queries.length) {
      mission.queryIndex = 0;
      const error = new Error('Every public people-search query failed. The source signals and empty destination sheet were preserved; fix search access and resume the mission.');
      error.code = 'LEAD_RESEARCH_UNAVAILABLE';
      throw error;
    }

    mission.phase = 'deep-public-contact-research';
    mission.status = 'deep-public-contact-research';
    mission.updatedAt = nowIso();
    saveMission(mission);
    await deepResearch(mission.leads, mission);

    mission.phase = 'writing-sheet';
    mission.status = 'writing-sheet';
    mission.updatedAt = nowIso();
    saveMission(mission);
    const existing = await existingLinkedIns(mission);
    const freshLeads = mission.leads.filter((lead) => {
      const linkedin = normalizeMissionLinkedIn(lead.linkedin, mission.entityMode || 'person');
      return linkedin && !existing.has(linkedin);
    });
    const rows = freshLeads.map((lead) => leadRow(lead, mission.headers));
    const appended = await appendValues(mission.spreadsheetId, mission.sheetName, rows);

    mission.added = Number(mission.added || 0) + appended.updatedRows;
    mission.publicEmails = mission.leads.filter((lead) => lead.email).length;
    mission.publicPhones = mission.leads.filter((lead) => lead.phone).length;
    mission.missingContacts = mission.leads.filter((lead) => !lead.email || !lead.phone).length;
    mission.multiSourceLeads = mission.leads.filter((lead) => Number(lead.sourceCount || 0) > 0).length;
    mission.averageRelevance = mission.leads.length
      ? Math.round(mission.leads.reduce((sum, lead) => sum + Number(lead.relevanceScore || 0), 0) / mission.leads.length)
      : 0;
    mission.status = mission.entityMode !== 'company' && mission.wantsContactEnrichment && mission.missingContacts > 0 ? 'awaiting-apollo-approval' : 'completed';
    mission.phase = mission.status;
    mission.completedAt = nowIso();
    mission.updatedAt = nowIso();
    saveMission(mission);
    v2.rememberTemplate(mission.headers, { sourceTitle: mission.spreadsheetTitle, sourceUrl: mission.sheetUrl, provider: 'google' });
    return mission;
  } catch (error) {
    mission.status = error.code === 'LEAD_RESEARCH_UNAVAILABLE' ? 'research-blocked' : 'failed';
    mission.lastError = error.message;
    mission.updatedAt = nowIso();
    saveMission(mission);
    throw error;
  }
}

async function startMission(plan, headers) {
  const webReady = Boolean(typeof web.status === 'function' ? web.status().configured : false);
  const fusionStatus = sourceFusion.status();
  if (!webReady && !fusionStatus.serpApiConfigured) {
    const error = new Error('No public people-search provider is configured. Configure TinyFish or SERP_API_KEY before starting the mission; no spreadsheet was created.');
    error.code = 'LEAD_WEB_SEARCH_NOT_CONFIGURED';
    throw error;
  }
  const linkedinPlan = linkedinPublic.plan(plan.originalMessage || plan.criteria, plan.criteria);
  const entityMode = linkedinPlan.enabled ? linkedinPlan.entityMode : 'person';
  const defaultCompanyRequested = entityMode === 'company'
    && JSON.stringify(headers || []) === JSON.stringify(DEFAULT_HEADERS);
  const headerSource = defaultCompanyRequested ? LINKEDIN_COMPANY_HEADERS : headers;
  const finalHeaders = entityMode === 'company'
    ? ensureCompanyHeaders(headerSource, plan.wantsContactEnrichment)
    : v2.ensureCoreHeaders(headerSource, plan.wantsContactEnrichment);
  const created = await v2.createSpreadsheet(`ULTRON Leads - ${String(plan.criteria || 'Leads').replace(/[^a-z0-9 ()&+._-]+/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 70)} - ${new Date().toISOString().slice(0, 10)}`, finalHeaders, plan.count);
  const state = v2.loadState();
  const mission = {
    id: `lead-mission-v3-${Date.now()}`,
    version: 3,
    status: 'created',
    phase: 'created',
    requested: Math.max(1, Math.min(MAX_LEADS, Number(plan.count || 25))),
    criteria: plan.criteria,
    originalMessage: plan.originalMessage || plan.criteria,
    entityMode,
    linkedinPlan,
    linkedinResearch: null,
    wantsContactEnrichment: Boolean(plan.wantsContactEnrichment),
    headers: finalHeaders,
    spreadsheetId: created.spreadsheetId,
    spreadsheetTitle: created.title,
    sheetName: created.sheetName,
    sheetUrl: created.url,
    sheetFormatted: Boolean(created.formatted),
    queryIndex: 0,
    deepIndex: 0,
    queries: null,
    sourceFusion: null,
    searchProviders: {},
    leads: [],
    failures: [],
    duplicatesRemoved: 0,
    rejectedLowRelevance: 0,
    added: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.missions.push(mission);
  state.pendingPlan = null;
  v2.saveState(state);
  return continueMission(mission.id);
}

function setPendingPlan(plan, template) {
  const state = v2.loadState();
  state.pendingPlan = {
    ...plan,
    leadWorkspaceVersion: 3,
    suggestedTemplateId: template?.id || null,
    suggestedHeaders: template?.headers || DEFAULT_HEADERS,
    suggestedSourceTitle: template?.sourceTitle || null,
    createdAt: nowIso(),
  };
  v2.saveState(state);
  return state.pendingPlan;
}

function pendingPlan() {
  const state = v2.loadState();
  const plan = state.pendingPlan;
  if (!plan) return null;
  const age = Date.now() - Date.parse(plan.createdAt || 0);
  if (!Number.isFinite(age) || age > PENDING_TTL_MS) {
    state.pendingPlan = null;
    v2.saveState(state);
    return null;
  }
  return plan;
}

async function prepareRequest(plan) {
  if (plan.explicitHeaders?.length) return { type: 'run', mission: await startMission(plan, plan.explicitHeaders) };
  let template = v2.latestTemplate();
  if (!template || plan.usePrevious) template = await v2.learnLatestSpreadsheetTemplate();
  if (plan.usePrevious) return { type: 'run', mission: await startMission(plan, template?.headers || DEFAULT_HEADERS) };
  const pending = setPendingPlan(plan, template);
  const source = template?.sourceTitle ? ` from ${template.sourceTitle}` : '';
  const linkedPlan = linkedinPublic.plan(plan.originalMessage || plan.criteria, plan.criteria);
  const defaultHint = linkedPlan.enabled && linkedPlan.entityMode === 'company'
    ? ` The LinkedIn-company default is: ${LINKEDIN_COMPANY_HEADERS.join(' | ')}.`
    : '';
  return {
    type: 'clarification',
    text: `I can run this as a multi-source lead mission and create the Google Sheet. Your latest reusable layout${source} is: ${v2.templatePreview(template)}. Do you want those previous headings, the default lead format, or a different layout?${defaultHint}`,
    pending,
  };
}

async function resolvePending(text) {
  const pending = pendingPlan();
  if (!pending) return null;
  const value = String(text || '').trim();
  if (/\b(?:cancel|stop|never mind|nevermind)\b/i.test(value)) {
    v2.clearPendingPlan();
    return { type: 'cancelled', text: 'Lead mission cancelled before creating or scraping anything.' };
  }
  const headers = v2.headersFromText(value);
  if (headers) return { type: 'run', mission: await startMission(pending, headers) };
  if (/\b(?:use|same as|keep|go with|like)\b[\s\S]{0,35}\b(?:previous|last|same|that)\b|\bprevious format\b|\bsame format\b|\buse it\b|\blike before\b/i.test(value)) {
    return { type: 'run', mission: await startMission(pending, pending.suggestedHeaders || DEFAULT_HEADERS) };
  }
  if (/\b(?:default|standard|canonical)\b/i.test(value)) {
    const linkedPlan = linkedinPublic.plan(pending.originalMessage || pending.criteria, pending.criteria);
    const defaults = linkedPlan.enabled && linkedPlan.entityMode === 'company' ? LINKEDIN_COMPANY_HEADERS : DEFAULT_HEADERS;
    return { type: 'run', mission: await startMission(pending, defaults) };
  }
  if (/\b(?:different|new|custom)\b[\s\S]{0,30}\b(?:format|layout|headers?|columns?|plan)\b/i.test(value)) {
    return { type: 'clarification', text: 'Send the headings once as: headers: Name, Company, Role, LinkedIn, Post Details, Phone, Email. Optional source-aware columns are Hiring Signal, Maps Signal, Source Count and Evidence Sources.' };
  }
  return null;
}

function latestMission() {
  return v2.latestMission();
}

async function resumeLatestMission() {
  const mission = latestMission();
  if (!mission) return { ok: false, text: 'There is no saved lead mission to resume.' };
  if (mission.status === 'completed') return { ok: true, mission, alreadyComplete: true };
  if (mission.status === 'awaiting-apollo-approval') return { ok: true, mission, awaitingApollo: true };
  return { ok: true, mission: await continueMission(mission.id) };
}

function sourceSummary(mission) {
  const fusion = sourceFusion.summary(mission?.sourceFusion);
  const linked = mission?.linkedinPlan?.enabled ? linkedinPublic.summary(mission?.linkedinResearch) : '';
  return [fusion, linked].filter(Boolean).join('; ');
}

function isLinkedInStatusRequest(text) {
  return /\blinkedin(?:\s+public)?\s+(?:scraper|research|source|tool)?\s*(?:status|health|doctor)\b|\b(?:status|health|doctor)\s+(?:of\s+)?linkedin(?:\s+(?:scraper|research|source|tool))?\b/i.test(String(text || ''));
}

function linkedinStatusText() {
  const s = linkedinPublic.status();
  return `LinkedIn Public Research: ${s.configured ? 'ready' : 'SERP_API_KEY missing'}. Supports public-indexed person and company profiles, up to ${s.maxResults} results with a ${s.maxSearchCalls}-search-call safety cap. Direct LinkedIn login/session-cookie scraping and anti-bot bypass are disabled. Optional direct public-page fetch is ${s.directPublicFetch ? 'on' : 'off'} and never signs in.`;
}

function isSourceStatusRequest(text) {
  return /\b(?:lead|leads?)\s+(?:source|sources|research source|source fusion)\s+(?:status|health|doctor)\b|\b(?:serpapi|apify)\s+(?:status|health)\b/i.test(String(text || ''));
}

function sourceStatusText() {
  const s = sourceFusion.status();
  return `Lead Source Fusion: SerpApi ${s.serpApiConfigured ? 'ready' : 'not configured'}; Google Jobs ${s.serpGoogleJobs ? 'ready' : 'unavailable'}; Apify ${s.apifyConfigured ? 'ready' : 'not configured'}; Google Maps actor ${s.apifyGoogleMaps ? s.apifyActor : 'unavailable'}. Per-mission safety caps: up to ${s.maxJobSignals} job signals and ${s.maxMapPlaces} Maps places. Apify paid add-ons for contact enrichment/social enrichment/competitor analysis are disabled; Apollo remains a separate explicit-approval stage.`;
}

function statusText() {
  const mission = latestMission();
  const sourceStatus = sourceFusion.status();
  if (!mission) {
    return `Lead Workspace v3 is ready. Multi-source discovery is on: TinyFish/public web plus SerpApi search${sourceStatus.serpGoogleJobs ? ' + Google Jobs' : ''}${sourceStatus.apifyGoogleMaps ? ' + Apify Google Maps' : ''}. It can create formatted Google Sheets, remember layouts, rank and deduplicate leads, scrape identity-checked public contact evidence, checkpoint long missions, and hand only unresolved contacts to Apollo.`;
  }
  const discovered = Number(mission.leads?.length || 0);
  const providers = Object.entries(mission.searchProviders || {}).map(([name, count]) => `${name}:${count}`).join(', ') || 'none yet';
  const noun = mission.entityMode === 'company' ? 'companies' : 'people';
  return `Lead mission ${mission.status}: ${mission.criteria}. ${discovered}/${mission.requested} qualifying ${noun} discovered; ${mission.added || 0} rows written. Source fusion: ${sourceSummary(mission)}. Multi-source-confirmed ${noun}: ${mission.multiSourceLeads || 0}. Public contacts: ${mission.publicEmails || 0} emails, ${mission.publicPhones || 0} phones. Average relevance ${mission.averageRelevance || 0}/100. Search providers: ${providers}. Search ${mission.queryIndex || 0}/${mission.queries?.length || 0}; deep searches ${mission.deepSearches || 0}, page fetches ${mission.deepFetches || 0}. Sheet: ${mission.sheetUrl || 'not created yet'}`;
}

function formatMission(mission) {
  const discovered = Number(mission.leads?.length || 0);
  const noun = mission.entityMode === 'company' ? 'companies' : 'people';
  const shortfall = discovered < Number(mission.requested || 0) ? ` I found ${discovered}/${mission.requested} qualifying ${noun} in this pass.` : '';
  const contactPhrase = mission.entityMode === 'company'
    ? `Public company research found ${mission.publicEmails || 0} emails and ${mission.publicPhones || 0} phones`
    : `Public research found ${mission.publicEmails || 0} emails and ${mission.publicPhones || 0} phones before Apollo`;
  return `Lead mission complete, Sir. Created “${mission.spreadsheetTitle}” and added ${mission.added || 0} lead${mission.added === 1 ? '' : 's'} for “${mission.criteria}”. Source fusion: ${sourceSummary(mission)}. ${mission.multiSourceLeads || 0} accepted ${noun} had independent source evidence. ${contactPhrase}; average relevance ${mission.averageRelevance || 0}/100. Duplicates skipped ${mission.duplicatesRemoved || 0}; low-relevance results rejected ${mission.rejectedLowRelevance || 0}.${shortfall} ${mission.sheetUrl}`;
}

function status() {
  const base = v2.status();
  const fusion = sourceFusion.status();
  const webReady = Boolean(typeof web.status === 'function' ? web.status().configured : false);
  return {
    ...base,
    ready: Boolean(googleAuth.status().credentialsReady && googleAuth.status().authorized && (webReady || fusion.serpApiConfigured)),
    stateVersion: 3,
    sourceFusion: fusion,
    publicWebSearchReady: webReady || fusion.serpApiConfigured,
    serpApiFallback: fusion.serpApiConfigured,
    googleJobsSignals: fusion.serpGoogleJobs,
    apifyGoogleMapsSignals: fusion.apifyGoogleMaps,
    multiSourceRanking: true,
    sourceAwareColumns: true,
    linkedinPublicResearch: linkedinPublic.status(),
  };
}

module.exports = {
  ...v2,
  MAX_LEADS,
  DEFAULT_HEADERS,
  LINKEDIN_COMPANY_HEADERS,
  sourceKeyForHeader,
  normalizeMissionLinkedIn,
  ensureCompanyHeaders,
  dedupeMissionLeads,
  leadRow,
  searchWithFusion,
  annotateLead,
  continueMission,
  startMission,
  prepareRequest,
  resolvePending,
  pendingPlan,
  latestMission,
  resumeLatestMission,
  statusText,
  isSourceStatusRequest,
  sourceStatusText,
  isLinkedInStatusRequest,
  linkedinStatusText,
  formatMission,
  status,
  sourceFusion,
  linkedinPublic,
};
