async function listCloseLoopSessions(projectPath, options = {}, dependencies = {}) {
  const {
    readCloseLoopSessionEntries,
    normalizeStatusFilter,
    filterEntriesByStatus,
    normalizeLimit,
    presentCloseLoopSessionList,
    buildStatusCounts,
    getCloseLoopSessionDir
  } = dependencies;
  const sessions = await readCloseLoopSessionEntries(projectPath);
  const statusFilter = normalizeStatusFilter(options.status);
  const filteredSessions = filterEntriesByStatus(sessions, statusFilter);
  const limit = normalizeLimit(options.limit, 20);
  return presentCloseLoopSessionList(
    projectPath,
    filteredSessions,
    statusFilter,
    limit,
    buildStatusCounts,
    getCloseLoopSessionDir
  );
}

async function statsCloseLoopSessions(projectPath, options = {}, dependencies = {}) {
  const {
    readCloseLoopSessionEntries,
    normalizeStatsWindowDays,
    normalizeStatusFilter,
    filterEntriesByStatus,
    presentCloseLoopSessionStats,
    buildStatusCounts,
    buildMasterSpecCounts,
    isFailedStatus,
    getCloseLoopSessionDir,
    now = () => Date.now()
  } = dependencies;
  const sessions = await readCloseLoopSessionEntries(projectPath);
  const days = normalizeStatsWindowDays(options.days);
  const statusFilter = normalizeStatusFilter(options.status);
  const nowMs = typeof now === 'function' ? Number(now()) : Date.now();
  const cutoffMs = days === null ? null : nowMs - (days * 24 * 60 * 60 * 1000);
  const withinWindow = sessions.filter((session) => cutoffMs === null || Number(session && session.mtime_ms) >= cutoffMs);
  const filteredSessions = filterEntriesByStatus(withinWindow, statusFilter);
  return presentCloseLoopSessionStats(
    getCloseLoopSessionDir(projectPath),
    filteredSessions,
    statusFilter,
    cutoffMs,
    buildStatusCounts,
    buildMasterSpecCounts,
    isFailedStatus
  );
}

async function listGovernanceCloseLoopSessions(projectPath, options = {}, dependencies = {}) {
  const {
    readGovernanceCloseLoopSessionEntries,
    normalizeStatusFilter,
    filterEntriesByStatus,
    filterGovernanceEntriesByResumeMode,
    normalizeLimit,
    presentGovernanceSessionList,
    buildStatusCounts,
    getGovernanceCloseLoopSessionDir
  } = dependencies;
  const sessions = await readGovernanceCloseLoopSessionEntries(projectPath);
  const statusFilter = normalizeStatusFilter(options.status);
  const resumeOnly = Boolean(options.resumeOnly);
  const statusFiltered = filterEntriesByStatus(sessions, statusFilter);
  const filteredSessions = filterGovernanceEntriesByResumeMode(statusFiltered, resumeOnly);
  const limit = normalizeLimit(options.limit, 20);
  return presentGovernanceSessionList(
    projectPath,
    filteredSessions,
    statusFilter,
    resumeOnly,
    buildStatusCounts,
    getGovernanceCloseLoopSessionDir,
    limit
  );
}

async function statsGovernanceCloseLoopSessions(projectPath, options = {}, dependencies = {}) {
  const {
    readGovernanceCloseLoopSessionEntries,
    normalizeStatsWindowDays,
    normalizeStatusFilter,
    filterEntriesByStatus,
    filterGovernanceEntriesByResumeMode,
    presentGovernanceSessionStats,
    normalizeStatusToken,
    isCompletedStatus,
    isFailedStatus,
    calculatePercent,
    toGovernanceReleaseGateNumber,
    getGovernanceCloseLoopSessionDir,
    buildStatusCounts,
    parseAutoHandoffGateBoolean,
    now = () => Date.now()
  } = dependencies;
  const sessions = await readGovernanceCloseLoopSessionEntries(projectPath);
  const days = normalizeStatsWindowDays(options.days);
  const statusFilter = normalizeStatusFilter(options.status);
  const resumeOnly = Boolean(options.resumeOnly);
  const nowMs = typeof now === 'function' ? Number(now()) : Date.now();
  const cutoffMs = days === null ? null : nowMs - (days * 24 * 60 * 60 * 1000);
  const withinWindow = sessions.filter((session) => cutoffMs === null || Number(session && session.mtime_ms) >= cutoffMs);
  const statusFiltered = filterEntriesByStatus(withinWindow, statusFilter);
  const filteredSessions = filterGovernanceEntriesByResumeMode(statusFiltered, resumeOnly);
  return presentGovernanceSessionStats(projectPath, filteredSessions, {
    days,
    status_filter: statusFilter,
    resume_only: resumeOnly,
    cutoff_ms: cutoffMs
  }, {
    normalizeStatusToken,
    isCompletedStatus,
    isFailedStatus,
    calculatePercent,
    toGovernanceReleaseGateNumber,
    getGovernanceCloseLoopSessionDir,
    buildStatusCounts,
    parseAutoHandoffGateBoolean
  });
}

async function listCloseLoopControllerSessions(projectPath, options = {}, dependencies = {}) {
  const {
    readCloseLoopControllerSessionEntries,
    normalizeStatusFilter,
    filterEntriesByStatus,
    normalizeLimit,
    presentControllerSessionList,
    buildStatusCounts,
    getCloseLoopControllerSessionDir
  } = dependencies;
  const sessions = await readCloseLoopControllerSessionEntries(projectPath);
  const statusFilter = normalizeStatusFilter(options.status);
  const filteredSessions = filterEntriesByStatus(sessions, statusFilter);
  const limit = normalizeLimit(options.limit, 20);
  return presentControllerSessionList(
    projectPath,
    filteredSessions,
    statusFilter,
    limit,
    buildStatusCounts,
    getCloseLoopControllerSessionDir
  );
}

async function statsCloseLoopControllerSessions(projectPath, options = {}, dependencies = {}) {
  const {
    readCloseLoopControllerSessionEntries,
    normalizeStatsWindowDays,
    normalizeStatusFilter,
    filterEntriesByStatus,
    normalizeStatusToken,
    isFailedStatus,
    buildStatusCounts,
    buildQueueFormatCounts,
    getCloseLoopControllerSessionDir,
    now = () => Date.now()
  } = dependencies;
  const sessions = await readCloseLoopControllerSessionEntries(projectPath);
  const days = normalizeStatsWindowDays(options.days);
  const statusFilter = normalizeStatusFilter(options.status);
  const nowMs = typeof now === 'function' ? Number(now()) : Date.now();
  const cutoffMs = days === null ? null : nowMs - (days * 24 * 60 * 60 * 1000);
  const withinWindow = sessions.filter((session) => cutoffMs === null || Number(session && session.mtime_ms) >= cutoffMs);
  const filteredSessions = filterEntriesByStatus(withinWindow, statusFilter);

  let completedSessions = 0;
  let failedSessions = 0;
  let processedGoalsSum = 0;
  let pendingGoalsSum = 0;
  let sessionsWithProcessed = 0;
  let sessionsWithPending = 0;

  for (const session of filteredSessions) {
    const status = normalizeStatusToken(session && session.status) || 'unknown';
    if (status === 'completed') {
      completedSessions += 1;
    }
    if (isFailedStatus(status)) {
      failedSessions += 1;
    }
    const processedGoals = Number(session && session.processed_goals);
    if (Number.isFinite(processedGoals)) {
      processedGoalsSum += processedGoals;
      sessionsWithProcessed += 1;
    }
    const pendingGoals = Number(session && session.pending_goals);
    if (Number.isFinite(pendingGoals)) {
      pendingGoalsSum += pendingGoals;
      sessionsWithPending += 1;
    }
  }

  const totalSessions = filteredSessions.length;
  const completionRate = totalSessions > 0 ? Number(((completedSessions / totalSessions) * 100).toFixed(2)) : 0;
  const failureRate = totalSessions > 0 ? Number(((failedSessions / totalSessions) * 100).toFixed(2)) : 0;
  const latestSession = totalSessions > 0 ? filteredSessions[0] : null;
  const oldestSession = totalSessions > 0 ? filteredSessions[totalSessions - 1] : null;

  return {
    mode: 'auto-controller-session-stats',
    session_dir: getCloseLoopControllerSessionDir(projectPath),
    criteria: {
      days,
      status_filter: statusFilter,
      since: cutoffMs === null ? null : new Date(cutoffMs).toISOString()
    },
    total_sessions: totalSessions,
    completed_sessions: completedSessions,
    failed_sessions: failedSessions,
    completion_rate_percent: completionRate,
    failure_rate_percent: failureRate,
    processed_goals_sum: processedGoalsSum,
    pending_goals_sum: pendingGoalsSum,
    average_processed_goals_per_session: sessionsWithProcessed > 0 ? Number((processedGoalsSum / sessionsWithProcessed).toFixed(2)) : 0,
    average_pending_goals_per_session: sessionsWithPending > 0 ? Number((pendingGoalsSum / sessionsWithPending).toFixed(2)) : 0,
    status_counts: buildStatusCounts(filteredSessions),
    queue_format_counts: buildQueueFormatCounts(filteredSessions),
    latest_updated_at: latestSession ? latestSession.updated_at : null,
    oldest_updated_at: oldestSession ? oldestSession.updated_at : null,
    latest_sessions: filteredSessions.slice(0, 10).map((item) => ({
      id: item.id,
      status: item.status,
      queue_file: item.queue_file,
      queue_format: item.queue_format,
      processed_goals: item.processed_goals,
      pending_goals: item.pending_goals,
      updated_at: item.updated_at,
      parse_error: item.parse_error
    }))
  };
}

module.exports = {
  listCloseLoopSessions,
  statsCloseLoopSessions,
  listGovernanceCloseLoopSessions,
  statsGovernanceCloseLoopSessions,
  listCloseLoopControllerSessions,
  statsCloseLoopControllerSessions
};
