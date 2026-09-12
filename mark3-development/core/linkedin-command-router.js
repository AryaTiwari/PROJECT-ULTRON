const googleAuth = require('./google-sheets-auth');
const sheets = require('./google-sheets-operator');
const finalMaster = require('./linkedin-final-master');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function requestedContactEnrichment(text) {
  return /\b(?:enrich|enrichment|apollo|email|e-?mail|phone|mobile|contact\s+(?:info|information|details?|number)|decision[- ]?maker|head(?:s)?|recruiter(?:s)?|talent\s+acquisition|hr\s+contact)\b/i.test(String(text || ''));
}

function isApolloEnrichmentRequest(text) {
  const value = String(text || '');
  return /\b(?:apollo|enrich|enrichment)\b/i.test(value)
    && /\b(?:lead|leads|companies|company|them|those|these|email|phone|number|contacts?)\b/i.test(value);
}

function genericLocationFromText(text, existing = '') {
  if (String(existing || '').trim()) return String(existing).trim();
  const value = String(text || '')
    .replace(/https?:\/\/docs\.google\.com\/spreadsheets\/d\/[^\s]+/gi, ' ')
    .replace(/\bon\s+linkedin\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const stop = '(?=\\s*(?:,?\\s+(?:remote|hybrid|on[- ]?site|under|below|less\\s+than|fewer\\s+than|over|above|more\\s+than|at\\s+least|with|having|past\\s+(?:24\\s+hours?|week|month)|full[- ]?time|part[- ]?time|contract|internship|easy\\s+apply|and\\s+(?:under|remote|hybrid|with|past|add|put|write|append|save|fill|send|keep)|(?:add|put|write|append|save|fill|send|keep)\\s+.+\\s+(?:sheet|spreadsheet)|in\\s+(?:the\\s+)?(?:current|same|existing|master|consolidated)\\s+(?:google\\s+)?(?:sheet|spreadsheet)|to\\s+(?:the\\s+)?(?:current|same|existing|master|consolidated)\\s+(?:google\\s+)?(?:sheet|spreadsheet)))|$)';
  const patterns = [
    new RegExp('\\b(?:located|based|headquartered)\\s+in\\s+([A-Za-z][A-Za-z .-]*(?:,\\s*[A-Za-z][A-Za-z .-]*)?)' + stop, 'i'),
    new RegExp('\\b(?:jobs?|roles?|openings?|vacancies)\\s+in\\s+([A-Za-z][A-Za-z .-]*(?:,\\s*[A-Za-z][A-Za-z .-]*)?)' + stop, 'i'),
    new RegExp('\\bfrom\\s+([A-Za-z][A-Za-z .-]*(?:,\\s*[A-Za-z][A-Za-z .-]*)?)' + stop, 'i'),
    new RegExp('\\bin\\s+([A-Za-z][A-Za-z .-]*(?:,\\s*[A-Za-z][A-Za-z .-]*)?)' + stop, 'i'),
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match?.[1]) continue;
    const location = match[1]
      .replace(/\s+and\s+(?:add|put|write|append|save|fill|send|keep)\b[\s\S]*$/i, '')
      .replace(/\s+(?:to|in)\s+(?:the\s+)?(?:current|same|existing|master|consolidated)\s+(?:google\s+)?(?:sheet|spreadsheet)\b[\s\S]*$/i, '')
      .replace(/\b(?:companies?|people|professionals?|recruiters?|jobs?|roles?|openings?)\b.*$/i, '')
      .replace(/[.,;:]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (location && !/^(?:linkedin|the|a|an)$/i.test(location)) return location;
  }
  return '';
}

function genericTopicFromText(text, request = {}, location = '') {
  let value = String(request.criteriaText || text || '');
  value = value
    .replace(/https?:\/\/docs\.google\.com\/spreadsheets\/d\/[^\s]+/gi, ' ')
    .replace(/\b(?:hey\s+)?ultron\b/gi, ' ')
    .replace(/\b(?:find|get|bring|research|source|collect|search|list|show|extract|discover)\s+(?:me\s+)?\d{0,3}\b/gi, ' ')
    .replace(/\b(?:on|using|via)\s+linkedin\b/gi, ' ')
    .replace(/\b(?:companies?|company|people|persons?|professionals?|profiles?|recruiters?|founders?|leads?)\b/gi, ' ')
    .replace(/\b(?:hiring|recruiting|jobs?|vacanc(?:y|ies)|openings?|roles?|positions?)\b/gi, ' ')
    .replace(/\b(?:under|below|fewer\s+than|less\s+than|up\s+to|maximum|max|over|above|more\s+than|at\s+least|minimum|min)\s*\d[\d,]*\s*(?:employees?)?/gi, ' ')
    .replace(/\b(?:remote|hybrid|on[- ]?site|in[- ]?office|easy\s+apply|full[- ]?time|part[- ]?time|contract|internship)\b/gi, ' ')
    .replace(/\b(?:located|based|headquartered)\s+in\b/gi, ' ')
    .replace(/\b(?:and\s+)?(?:add|put|write|append|save|fill|send|keep)\b[\s\S]*?\b(?:sheet|spreadsheet)\b/gi, ' ')
    .replace(/\b(?:current|same|existing|last|latest|master|consolidated)\s+(?:google\s+)?(?:sheet|spreadsheet)\b/gi, ' ')
    .replace(/\b(?:from|in|at|near|around|with|and|to)\b/gi, ' ');
  if (location) {
    const escaped = String(location).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    value = value.replace(new RegExp(escaped, 'gi'), ' ');
  }
  value = value.replace(/[.,;:!?()[\]{}]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\bsap\b/i.test(value)) {
    const module = value.match(/\bsap\s+(fico|mm|sd|abap|basis|s\/?4hana|successfactors|hana|bw|bpc|ariba|ewm|tm|btp|cpi|security)\b/i);
    return module ? (/^s\/?4hana$/i.test(module[1]) ? 'SAP S/4HANA' : `SAP ${module[1].toUpperCase()}`) : 'SAP';
  }
  return value || request.topic || (request.entityMode === 'company' ? 'companies' : 'professionals');
}


function employeeRangeFromText(text) {
  const value = String(text || '');
  const range = value.match(/\b(\d[\d,]*)\s*(?:-|to)\s*(\d[\d,]*)\s+employees?\b/i);
  if (range) return { min: Number(range[1].replace(/,/g, '')), max: Number(range[2].replace(/,/g, '')), explicit: true };
  const max = value.match(/\b(?:under|below|fewer\s+than|less\s+than|up\s+to|maximum|max)\s*(\d[\d,]*)\s*(?:employees?)?\b/i);
  const min = value.match(/\b(?:over|above|more\s+than|at\s+least|minimum|min)\s*(\d[\d,]*)\s*(?:employees?)?\b/i);
  return { min: min ? Number(min[1].replace(/,/g, '')) : null, max: max ? Number(max[1].replace(/,/g, '')) : null, explicit: Boolean(min || max) };
}

function explicitRefinementLocation(text) {
  const value = String(text || '').trim();
  if (/\b(?:all\s+india|pan[- ]?india|india[- ]?wide|across\s+india|within\s+india|anywhere\s+in\s+india|nationwide(?:\s+in\s+india)?)\b/i.test(value)) return 'India';
  const generic = genericLocationFromText(value, '');
  if (generic) return generic;
  const directed = value.match(/\b(?:location|area|region|state|city)\s*(?:to|=|as)\s*["']?([A-Za-z][A-Za-z .-]*(?:,\s*[A-Za-z][A-Za-z .-]*)?)["']?/i)
    || value.match(/\b(?:expand|broaden|switch|change|move)\s+(?:the\s+)?(?:search|location|area|region)?\s*(?:to|into|across)\s+["']?([A-Za-z][A-Za-z .-]*(?:,\s*[A-Za-z][A-Za-z .-]*)?)["']?/i);
  if (directed && directed[1]) {
    return directed[1].replace(/\s+(?:and|but)\b[\s\S]*$/i, '').replace(/[.,;:]+$/, '').trim();
  }
  const only = value.match(/^\s*([A-Z][A-Za-z .-]{1,45}(?:,\s*[A-Za-z][A-Za-z .-]*)?)\s+only\s*$/)
    || value.match(/\b(?:same|previous|last)(?:\s+search)?\s*(?:but|except)?\s*(?:make\s+it\s+)?([A-Z][A-Za-z .-]{1,45}(?:,\s*[A-Za-z][A-Za-z .-]*)?)\s+only\b/i)
    || value.match(/\b(?:make|change|switch)\s+(?:the\s+)?(?:location\s+)?(?:to\s+)?([A-Z][A-Za-z .-]{1,45}(?:,\s*[A-Za-z][A-Za-z .-]*)?)\s+only\b/i);
  if (only && only[1] && !/^(?:remote|hybrid|onsite|on-site|full time|part time)$/i.test(only[1].trim())) return only[1].trim();
  return '';
}

function explicitTopicRefinement(text) {
  const value = String(text || '').trim();
  const match = value.match(/\b(?:role|roles|topic|keyword|job\s+title)\s*(?:to|=|as)\s*["']?(.+?)["']?(?=\s+(?:in|within|for|under|with|and|but)\b|$)/i)
    || value.match(/\b(?:same\s+search|same|previous\s+search)\s+(?:but|except)\s+(?:for\s+)?(.+?)\s+(?:roles?|jobs?|openings?)\b/i)
    || value.match(/\binstead\s+(?:find|search\s+for|look\s+for)?\s*["']?(.+?)["']?\s+(?:roles?|jobs?|openings?)\b/i);
  if (!match || !match[1]) return '';
  return match[1].replace(/\b(?:remote|hybrid|on[- ]?site|under|below|over|above)\b[\s\S]*$/i, '').replace(/[.,;:]+$/, '').trim();
}

function refinementCount(text, mission = {}) {
  const value = String(text || '');
  const more = value.match(/\b(?:add|find|get|bring|append|search\s+for)\s+(?:me\s+)?(\d{1,3})\s+(?:more\s+)?(?:companies|company|people|profiles?|results?|leads?)\b/i)
    || value.match(/\b(\d{1,3})\s+more\s+(?:companies|company|people|profiles?|results?|leads?)\b/i);
  if (more) return { count: Math.max(1, Math.min(100, Number(more[1]))), mode: 'additional' };
  const total = value.match(/\b(?:make|bring|get|take|increase|raise)\s+(?:(?:the\s+)?(?:list|master|sheet|database|total|count)|it)?\s*(?:go|reach|to)?\s*(\d{1,3})\s*(?:total)?\b/i)
    || value.match(/\b(?:get|take|bring)\s+(?:the\s+)?(?:list|master|sheet|database)\s+to\s+(\d{1,3})\b/i)
    || value.match(/\btotal\s+(?:of\s+)?(\d{1,3})\b/i);
  if (total) {
    const desired = Math.max(1, Math.min(100, Number(total[1])));
    const masterBased = mission.request?.entityMode === 'company' && finalMaster.masterSheetUrl();
    const already = masterBased
      ? finalMaster.masterCount()
      : Math.max(0, Number(mission.added != null ? mission.added : (mission.records ? mission.records.length : (mission.verifiedRecords ? mission.verifiedRecords.length : 0))));
    return { count: Math.max(0, desired - already), mode: masterBased ? 'master_total' : 'total', desired, already };
  }
  if (/\b(?:fulfil|fulfill|complete|finish|reach)\b[\s\S]{0,35}\b(?:required|requested|original|target|remaining)\b|\bfill\s+(?:the\s+)?remaining\b|\bremaining\s+(?:amount|count|companies|results)\b/i.test(value)) {
    const desired = Math.max(1, Number(mission.requested != null ? mission.requested : ((mission.request && mission.request.count) || 25)));
    const already = mission.request?.entityMode === 'company' && finalMaster.masterSheetUrl()
      ? finalMaster.masterCount()
      : Math.max(0, Number(mission.added != null ? mission.added : (mission.records ? mission.records.length : (mission.verifiedRecords ? mission.verifiedRecords.length : 0))));
    return { count: Math.max(0, desired - already), mode: mission.request?.entityMode === 'company' && finalMaster.masterSheetUrl() ? 'master_total' : 'remaining', desired, already };
  }
  return null;
}


function autoRelaxCandidate(mission = {}) {
  const rejected = mission && mission.filterVerification && mission.filterVerification.rejected
    ? mission.filterVerification.rejected
    : {};
  const request = mission.request || {};
  const filters = request.filters || {};
  const candidates = [
    { key: 'work_type', count: Number(rejected.work_type || 0), active: Boolean(filters.workType), priority: 3 },
    { key: 'employee_count', count: Number(rejected.employee_count || 0), active: filters.employeeMin != null || filters.employeeMax != null, priority: 2 },
    { key: 'location', count: Number(rejected.location || 0), active: Boolean(request.location), priority: 1 },
  ].filter((item) => item.active);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.count - a.count || b.priority - a.priority);
  return candidates[0];
}

function isMissionRefinementRequest(text, mission = null) {
  if (!mission || !mission.request || mission.status !== 'completed') return false;
  const value = String(text || '').trim();
  if (!value) return false;
  if (requestedContactEnrichment(value) && !/\b(?:same|previous|last|more|continue|filter|location|remote|hybrid|employee|company\s+size)\b/i.test(value)) return false;
  const referencesPrevious = /\b(?:same|previous|last|continue|resume|more|remaining|again|instead|change|switch|expand|broaden|relax|remove|drop|ignore|without|keep|only|all|across|nationwide|anywhere|fulfil|fulfill|complete|finish|reach|filter)\b/i.test(value);
  const hasConstraint = Boolean(
    explicitRefinementLocation(value)
    || explicitTopicRefinement(value)
    || refinementCount(value, mission)
    || /\b(?:remove|drop|relax)\s+(?:one|a|the)?\s*(?:(?:biggest|main|blocking|most\s+restrictive)(?:\s+(?:biggest|main|blocking|most\s+restrictive))*)?\s*filter\b/i.test(value)
    || /\b(?:remote|hybrid|on[- ]?site|work\s*type|workplace|employees?|employee\s+count|company\s+size|headcount|easy\s+apply|full[- ]?time|part[- ]?time|contract|internship|experience|past\s+(?:24\s+hours?|week|month)|hiring|location|city|state|region|india)\b/i.test(value)
  );
  return referencesPrevious && hasConstraint;
}

function buildMissionRefinement(text, mission = {}, workspaceSheetUrl = null) {
  if (!mission || !mission.request) return null;
  const value = String(text || '').trim();
  const request = {
    ...mission.request,
    filters: { ...(mission.request.filters || {}) },
    originalMessage: value,
    destinationSheetUrl: sheets.extractSheetUrl(value) || workspaceSheetUrl || mission.sheetUrl || mission.request.destinationSheetUrl || null,
    destinationSheet: undefined,
    continueFromPrevious: true,
    usePrevious: false,
    useDefault: true,
    explicitHeaders: undefined,
    wantsContacts: requestedContactEnrichment(value),
  };
  const changes = [];

  const countChange = refinementCount(value, mission);
  if (countChange) {
    request.count = countChange.count;
    if (countChange.mode === 'master_total') {
      request.targetMode = 'master_total';
      request.targetTotal = countChange.desired;
      request.destinationSheetUrl = finalMaster.masterSheetUrl() || request.destinationSheetUrl;
    }
    changes.push('count:' + countChange.mode + ':' + countChange.count);
  } else {
    const desired = Math.max(1, Number(mission.requested != null ? mission.requested : ((mission.request && mission.request.count) || 25)));
    const already = Math.max(0, Number(mission.added != null ? mission.added : (mission.records ? mission.records.length : (mission.verifiedRecords ? mission.verifiedRecords.length : 0))));
    request.count = already < desired ? (desired - already) : desired;
    changes.push('count:auto:' + request.count);
  }

  const wantsAutoRelax = /\b(?:remove|drop|relax)\s+(?:one|a|the)?\s*(?:(?:biggest|main|blocking|most\s+restrictive)(?:\s+(?:biggest|main|blocking|most\s+restrictive))*)?\s*filter\b|\brelax\s+(?:whatever|whichever)\s+filter\b/i.test(value);
  const autoRelax = wantsAutoRelax ? autoRelaxCandidate(mission) : null;
  if (autoRelax) {
    if (autoRelax.key === 'work_type') {
      request.filters.workType = null;
      changes.push('workType:auto-removed');
    } else if (autoRelax.key === 'employee_count') {
      request.filters.employeeMin = null;
      request.filters.employeeMax = null;
      changes.push('employees:auto-removed');
    } else if (autoRelax.key === 'location') {
      request.location = '';
      changes.push('location:auto-removed');
    }
  }

  const removeLocation = /\b(?:remove|drop|ignore|clear|relax)\s+(?:the\s+)?(?:location|city|state|region)(?:\s+filter)?\b|\b(?:any|anywhere)\s+location\b|\blocation\s+(?:doesn['’]?t|does\s+not)\s+matter\b/i.test(value);
  const location = removeLocation ? '' : explicitRefinementLocation(value);
  if (removeLocation && (!autoRelax || autoRelax.key !== 'location')) {
    request.location = '';
    changes.push('location:removed');
  } else if (location) {
    request.location = location;
    request.locationScope = request.hiring ? 'job' : request.locationScope;
    if (/^india$/i.test(location)) {
      request.locationPolicy = { scope: 'India', preferredLocations: ['Maharashtra'], allowOtherIndia: true };
    }
    changes.push('location:' + location);
  }

  const removeWorkType = /\b(?:remove|drop|ignore|clear|relax)\s+(?:the\s+)?(?:remote|hybrid|on[- ]?site|work\s*type|workplace)(?:\s+filter)?\b|\b(?:any|either)\s+(?:work\s*type|workplace|remote\/hybrid\/on[- ]?site)\b|\b(?:remote|work\s*type|workplace)\s+(?:doesn['’]?t|does\s+not)\s+matter\b|\b(?:doesn['’]?t|does\s+not)\s+(?:have|need)\s+to\s+be\s+remote\b|\bnot\s+necessarily\s+remote\b/i.test(value);
  if (removeWorkType && (!autoRelax || autoRelax.key !== 'work_type')) {
    request.filters.workType = null;
    changes.push('workType:removed');
  } else if (!autoRelax && /\bremote\b/i.test(value)) {
    request.filters.workType = 'remote';
    changes.push('workType:remote');
  } else if (/\bhybrid\b/i.test(value)) {
    request.filters.workType = 'hybrid';
    changes.push('workType:hybrid');
  } else if (/\b(?:on[- ]?site|in[- ]?office)\b/i.test(value)) {
    request.filters.workType = 'on_site';
    changes.push('workType:on_site');
  }

  const removeEmployees = /\b(?:remove|drop|ignore|clear|relax)\s+(?:the\s+)?(?:employee|employees|employee\s+count|company\s+size|headcount)(?:\s+(?:filter|limit|restriction))?\b|\b(?:any|all)\s+company\s+size\b|\bno\s+(?:employee|headcount|company\s+size)\s+limit\b|\b(?:employee\s+count|company\s+size|headcount)\s+(?:doesn['’]?t|does\s+not)\s+matter\b/i.test(value);
  const employee = employeeRangeFromText(value);
  if (removeEmployees && (!autoRelax || autoRelax.key !== 'employee_count')) {
    request.filters.employeeMin = null;
    request.filters.employeeMax = null;
    changes.push('employees:removed');
  } else if (!autoRelax && employee.explicit) {
    request.filters.employeeMin = employee.min;
    request.filters.employeeMax = employee.max;
    changes.push('employees:' + (employee.min == null ? '' : employee.min) + '-' + (employee.max == null ? '' : employee.max));
  }

  const removeJobType = /\b(?:remove|drop|ignore|clear|relax)\s+(?:the\s+)?job\s*type(?:\s+filter)?\b|\bany\s+job\s*type\b/i.test(value);
  if (removeJobType) {
    request.filters.jobType = null;
    changes.push('jobType:removed');
  } else if (/\bpart[- ]?time\b/i.test(value)) {
    request.filters.jobType = 'part_time';
    changes.push('jobType:part_time');
  } else if (/\bfull[- ]?time\b/i.test(value)) {
    request.filters.jobType = 'full_time';
    changes.push('jobType:full_time');
  } else if (/\bcontract\b/i.test(value)) {
    request.filters.jobType = 'contract';
    changes.push('jobType:contract');
  } else if (/\bintern(?:ship)?\b/i.test(value)) {
    request.filters.jobType = 'internship';
    changes.push('jobType:internship');
  }

  const removeDate = /\b(?:remove|drop|ignore|clear|relax)\s+(?:the\s+)?(?:date|posted|recency)(?:\s+filter)?\b|\bany\s+(?:date|posting\s+date)\b/i.test(value);
  if (removeDate) {
    request.filters.datePosted = null;
    changes.push('datePosted:removed');
  } else if (/\b(?:past|last)\s+24\s+hours?\b/i.test(value)) {
    request.filters.datePosted = 'past_24_hours';
    changes.push('datePosted:past_24_hours');
  } else if (/\b(?:past|last)\s+week\b/i.test(value)) {
    request.filters.datePosted = 'past_week';
    changes.push('datePosted:past_week');
  } else if (/\b(?:past|last)\s+month\b/i.test(value)) {
    request.filters.datePosted = 'past_month';
    changes.push('datePosted:past_month');
  }

  if (/\b(?:remove|drop|ignore|clear)\s+(?:the\s+)?easy\s+apply(?:\s+filter)?\b|\bany\s+application\s+type\b/i.test(value)) {
    request.filters.easyApply = false;
    changes.push('easyApply:removed');
  } else if (/\beasy\s+apply\b/i.test(value)) {
    request.filters.easyApply = true;
    changes.push('easyApply:true');
  }

  if (/\b(?:remove|drop|ignore|relax)\s+(?:the\s+)?(?:hiring|job\s+opening|openings?|vacanc(?:y|ies))(?:\s+filter)?\b|\bcompanies\s+(?:do\s+not|don['’]?t)\s+need\s+to\s+be\s+hiring\b/i.test(value)) {
    request.hiring = false;
    request.locationScope = 'company';
    changes.push('hiring:false');
  } else if (/\b(?:must\s+be\s+)?(?:hiring|recruiting|with\s+openings?|with\s+vacanc(?:y|ies))\b/i.test(value)) {
    request.hiring = true;
    request.locationScope = 'job';
    changes.push('hiring:true');
  }

  const topic = explicitTopicRefinement(value);
  if (topic) {
    request.topic = topic;
    changes.push('topic:' + topic);
  }

  const wantsNewSheet = /\b(?:new|separate|fresh)\s+(?:google\s+)?(?:sheet|spreadsheet)\b/i.test(value);
  if (wantsNewSheet) {
    request.destinationSheetUrl = null;
    changes.push('destination:new');
  }

  return { request, changes, satisfied: Number(request.count) === 0, countChange };
}

function wantsMasterSheet(text) {
  return /\b(?:current|same|existing|last|latest|master|consolidated)\s+(?:google\s+)?(?:sheet|spreadsheet)\b/i.test(String(text || ''));
}

function enhanceRequest(request, text, workspaceSheetUrl = null) {
  if (!request) return request;
  const location = genericLocationFromText(text, request.location);
  const inferredLocation = !request.location && Boolean(location);
  const topic = inferredLocation ? genericTopicFromText(text, request, location) : request.topic;
  return {
    ...request,
    location: location || request.location || '',
    locationScope: request.locationScope || (request.hiring ? 'job' : 'company'),
    topic,
    wantsContacts: requestedContactEnrichment(text),
    destinationSheetUrl: request.destinationSheetUrl || (wantsMasterSheet(text) ? workspaceSheetUrl : null),
  };
}

function sheetUrlFromText(text, workspaceSheetUrl = null) {
  return sheets.extractSheetUrl(text) || workspaceSheetUrl || null;
}

function isSetWorkspaceRequest(text) {
  const value = String(text || '');
  if (!sheets.extractSheetUrl(value)) return false;
  return /\b(?:use|set|make|remember)\b/i.test(value)
    && /\b(?:current|master|default|linkedin)\b/i.test(value)
    && /\b(?:sheet|spreadsheet)\b/i.test(value);
}

function parseColumnList(value) {
  return String(value || '')
    .replace(/\b(?:to|in|into|on|from)\s+(?:the\s+)?(?:current|same|existing|master|linkedin)?\s*(?:google\s+)?(?:sheet|spreadsheet)\b[\s\S]*$/i, '')
    .split(/\s*,\s*|\s+and\s+/i)
    .map((item) => item.replace(/^["'`]+|["'`.]+$/g, '').trim())
    .filter(Boolean)
    .slice(0, 20);
}

function parseSheetEdit(text) {
  const value = String(text || '').trim();
  let match = value.match(/\brename\s+(?:the\s+)?(?:column|header)\s+["'`]?([^"'`]+?)["'`]?\s+to\s+["'`]?([^"'`]+?)["'`]?(?=\s+(?:in|on)\s+(?:the\s+)?(?:current|same|existing|master|linkedin)?\s*(?:google\s+)?(?:sheet|spreadsheet)\b|$)/i);
  if (match) return { operation: 'rename', from: match[1].trim(), to: match[2].trim() };

  match = value.match(/\b(?:add|insert|create)\s+(?:a\s+|new\s+|the\s+)*(?:columns?|headers?)\s+(.+)$/i);
  if (match) {
    const columns = parseColumnList(match[1]);
    if (columns.length) return { operation: 'add', columns };
  }

  match = value.match(/\b(?:delete|remove)\s+(?:the\s+)*(?:columns?|headers?)\s+(.+)$/i);
  if (match) {
    const columns = parseColumnList(match[1]);
    if (columns.length) return { operation: 'delete', columns };
  }
  return null;
}

function isSheetEditRequest(text, workspaceSheetUrl = null) {
  if (!sheetUrlFromText(text, workspaceSheetUrl)) return false;
  if (!/\b(?:sheet|spreadsheet|column|header)\b/i.test(String(text || ''))) return false;
  return Boolean(parseSheetEdit(text));
}

function headerScore(row) {
  const known = /^(?:name|company|company name|company link|linkedin|role|job title|job role|job link|location|work type|employees|company size|email|phone|phone number|remarks|website|lead score|source|hiring signal|no of applicants)$/i;
  const nonEmpty = (row || []).map((item) => String(item || '').trim()).filter(Boolean);
  const recognized = nonEmpty.filter((item) => known.test(normalize(item))).length;
  return recognized * 20 + Math.min(nonEmpty.length, 12);
}

async function inspectSheet(sheetUrl) {
  const spreadsheetId = sheets.spreadsheetId(sheetUrl);
  const meta = await sheets.metadata(spreadsheetId);
  const gid = sheets.sheetGid(sheetUrl);
  const tabs = [...(meta.sheets || [])].sort((a, b) => {
    if (gid != null) {
      if (a?.properties?.sheetId === gid) return -1;
      if (b?.properties?.sheetId === gid) return 1;
    }
    return Number(a?.properties?.index || 0) - Number(b?.properties?.index || 0);
  });
  let best = null;
  for (const tab of tabs) {
    const title = tab?.properties?.title;
    if (!title) continue;
    const rows = await sheets.values(spreadsheetId, `${sheets.quoteSheet(title)}!A1:ZZ40`);
    if (!rows.length) {
      if (!best) best = { sheetId: tab.properties.sheetId, sheetName: title, rowIndex: 0, headers: [] };
      continue;
    }
    for (let index = 0; index < Math.min(rows.length, 30); index++) {
      const row = rows[index] || [];
      const score = headerScore(row) - index * 0.1;
      if (!best || score > best.score) best = { sheetId: tab.properties.sheetId, sheetName: title, rowIndex: index, headers: row.map(String), score };
    }
    if (gid != null && tab.properties.sheetId === gid && best) break;
  }
  if (!best) throw new Error('The target Google Sheet has no accessible tab.');
  return {
    spreadsheetId,
    spreadsheetTitle: meta?.properties?.title || 'Google Sheet',
    sheetId: best.sheetId,
    sheetName: best.sheetName,
    headerRowNumber: best.rowIndex + 1,
    headers: best.headers || [],
    url: sheetUrl,
  };
}

async function sheetsApi(url, options = {}) {
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
  if (!response.ok) throw new Error(data?.error?.message || `Google Sheets API failed (${response.status}).`);
  return data;
}

async function executeSheetEdit(text, workspaceSheetUrl = null) {
  const edit = parseSheetEdit(text);
  if (!edit) throw new Error('I could not safely parse the requested Sheet column edit.');
  const sheetUrl = sheetUrlFromText(text, workspaceSheetUrl);
  if (!sheetUrl) throw new Error('There is no current LinkedIn Sheet. Provide a Google Sheets URL first.');
  const target = await inspectSheet(sheetUrl);
  const headers = target.headers.slice();

  if (edit.operation === 'add') {
    const existing = new Set(headers.map(normalize));
    const added = [];
    for (const column of edit.columns) {
      if (existing.has(normalize(column))) continue;
      const index = headers.length + added.length;
      await sheets.writeCells(target.spreadsheetId, [{
        range: sheets.cellRange(target.sheetName, target.headerRowNumber, index),
        value: column,
      }]);
      existing.add(normalize(column));
      added.push(column);
    }
    return { ok: true, operation: 'add', changed: added, sheetUrl, ...target };
  }

  if (edit.operation === 'rename') {
    const index = headers.findIndex((header) => normalize(header) === normalize(edit.from));
    if (index < 0) throw new Error(`Column “${edit.from}” was not found in the current LinkedIn Sheet.`);
    await sheets.writeCells(target.spreadsheetId, [{
      range: sheets.cellRange(target.sheetName, target.headerRowNumber, index),
      value: edit.to,
    }]);
    return { ok: true, operation: 'rename', changed: [`${edit.from} → ${edit.to}`], sheetUrl, ...target };
  }

  const indices = edit.columns
    .map((column) => ({ column, index: headers.findIndex((header) => normalize(header) === normalize(column)) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => b.index - a.index);
  if (!indices.length) throw new Error('None of the requested columns were found in the current LinkedIn Sheet.');
  await sheetsApi(`${API}/${encodeURIComponent(target.spreadsheetId)}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: indices.map((item) => ({
        deleteDimension: {
          range: { sheetId: target.sheetId, dimension: 'COLUMNS', startIndex: item.index, endIndex: item.index + 1 },
        },
      })),
    }),
  });
  return { ok: true, operation: 'delete', changed: indices.map((item) => item.column), sheetUrl, ...target };
}

module.exports = {
  normalize,
  requestedContactEnrichment,
  isApolloEnrichmentRequest,
  genericLocationFromText,
  genericTopicFromText,
  employeeRangeFromText,
  explicitRefinementLocation,
  explicitTopicRefinement,
  refinementCount,
  autoRelaxCandidate,
  isMissionRefinementRequest,
  buildMissionRefinement,
  wantsMasterSheet,
  enhanceRequest,
  sheetUrlFromText,
  isSetWorkspaceRequest,
  parseColumnList,
  parseSheetEdit,
  isSheetEditRequest,
  inspectSheet,
  executeSheetEdit,
};
