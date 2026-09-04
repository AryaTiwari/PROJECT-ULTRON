const store = require('./mission-store');

function resetRetryable(missionId = null) {
  const mission = missionId ? store.load(missionId) : store.list(1)[0];
  if (!mission) throw new Error('No Forge mission is available to retry.');
  const jobs = store.jobs(mission.id);
  const reset = [];
  for (const job of jobs) {
    if (job.status === 'failed' || (job.status === 'blocked' && job.blockedReason === 'dependency-not-satisfied')) {
      job.status = 'pending';
      job.attempts = 0;
      job.error = null;
      job.blockedReason = null;
      job.updatedAt = new Date().toISOString();
      reset.push(job.id);
    }
  }
  if (!reset.length) return { missionId: mission.id, resetJobs: [] };
  store.saveJobs(mission.id, jobs);
  store.checkpoint(mission.id, { status: 'ready', phase: 'execute', error: null });
  store.event(mission.id, 'mission_partial_retry', { jobs: reset });
  return { missionId: mission.id, resetJobs: reset };
}

module.exports = { resetRetryable };
