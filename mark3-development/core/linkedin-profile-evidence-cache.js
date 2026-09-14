'use strict';

function profileFromJobDetails(missions = [], slug = '', now = Date.now()) {
  const normalized = String(slug || '').trim().toLowerCase();
  if (!normalized) return null;
  const companyUrl = 'linkedin.com/company/' + normalized;
  const seen = new Set();

  for (const mission of missions) {
    if (!mission || seen.has(mission.id)) continue;
    seen.add(mission.id);
    const ttl = mission?.prepared?.request?.resumeExistingPool
      ? 24 * 60 * 60 * 1000
      : 6 * 60 * 60 * 1000;

    for (const [key, cached] of Object.entries(mission.responses || {})) {
      let tool;
      try { [tool] = JSON.parse(key); } catch { continue; }
      if (tool !== 'get_job_details') continue;
      if (!cached || now - Number(cached.at || 0) >= ttl) continue;

      const text = JSON.stringify(cached.value || {});
      if (!text.toLowerCase().includes(companyUrl)) continue;

      const size = text.match(/([0-9][0-9,]*\s*(?:-|–|to)\s*[0-9][0-9,]*\s*employees?)/i)
        || text.match(/([0-9][0-9,]*\+\s*employees?)/i);
      if (!size?.[1]) continue;

      return {
        value: {
          url: 'https://www.linkedin.com/company/' + normalized,
          sections: { main: 'Company size: ' + size[1] },
          references: [],
          ultronJobDetailCompanyProfileCache: true,
        },
        sourceMissionId: mission.id,
      };
    }
  }

  return null;
}

module.exports = { profileFromJobDetails };
