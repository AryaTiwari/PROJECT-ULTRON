// Read-only diagnostic: never starts MCP or calls LinkedIn, Sheets, or Apollo.
const runner = require('../core/linkedin-mission-runner');
const operator = require('../core/linkedin-account-operator');
const id = process.argv[2];
if (!id) throw new Error('Usage: node scripts/linkedin-saved-diagnostic.js <mission-id>');
const mission = runner.get(id);
const request = mission.prepared?.request || {};
const discovered = new Set();
const checked = new Set();
const reasons = {};
const samples = [];
let missingPosting = 0;
for (const [key, cached] of Object.entries(mission.responses || {})) {
  let tool, args;
  try { [tool, args] = JSON.parse(key); } catch { continue; }
  if (tool === 'search_jobs') operator.jobIdsFromResult(cached.value).forEach(id => discovered.add(id));
  if (tool !== 'get_job_details') continue;
  checked.add(String(args.job_id));
  const detail = cached.value;
  const text = operator.flattenText(detail);
  const refs = operator.linkedInReferences(detail, 'company');
  const role = operator.jobTitleFromDetail(detail, '');
  const record = { role, jobEvidenceText: text, hiringSignal: '', hiringVerified: Boolean(text && refs.length) };
  const failures = operator.jobLevelFailures(record, request);
  failures.forEach(reason => { reasons[reason] = (reasons[reason] || 0) + 1; });
  if (!detail?.sections?.job_posting) missingPosting++;
  // Whitelist only diagnostic fields; never export raw responses or credentials.
  if (samples.length < 16) samples.push({ jobId: String(args.job_id), title: role.slice(0,140),
    detailCharacters: text.length, sectionNames: Object.keys(detail?.sections || {}).filter(k => !/token|cookie|password|session/i.test(k)),
    sectionErrorNames: Object.keys(detail?.section_errors || {}).filter(k => !/token|cookie|password|session/i.test(k)),
    companyLinks: refs.length, failures });
}
console.log(JSON.stringify({ missionId: id, status: mission.status,
  interpretation: { topic: request.topic, entityMode: request.entityMode, locations: request.allowedLocations,
    workType: request.filters?.workType, preferredWorkType: request.preferredWorkType,
    employeeMax: request.filters?.employeeMax, targetMode: request.targetMode, targetTotal: request.targetTotal },
  discovered: discovered.size, cachedJobDetails: checked.size,
  remainingUncached: [...discovered].filter(id => !checked.has(id)).length,
  missingJobPostingSection: missingPosting, detailOnlyRejectionReasons: reasons,
  note: 'Detail-only checks intentionally exclude search-filter provenance; compare these with the original mission rejection counts.', samples }, null, 2));
