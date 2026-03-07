async function resolveLatestRecoverableBatchSummary(projectPath, resumeStrategy = 'pending', dependencies = {}) {
  const {
    readCloseLoopBatchSummaryEntries,
    loadCloseLoopBatchSummaryPayload,
    buildCloseLoopBatchGoalsFromSummaryPayload
  } = dependencies;
  const entries = await readCloseLoopBatchSummaryEntries(projectPath);
  for (const entry of entries) {
    if (!entry || !entry.file) {
      continue;
    }
    let loaded = null;
    try {
      loaded = await loadCloseLoopBatchSummaryPayload(projectPath, entry.file);
      const goalsResult = await buildCloseLoopBatchGoalsFromSummaryPayload(
        loaded.payload,
        loaded.file,
        projectPath,
        'auto',
        resumeStrategy
      );
      if (Array.isArray(goalsResult.goals) && goalsResult.goals.length > 0) {
        return loaded;
      }
    } catch (_error) {
      continue;
    }
  }
  return null;
}

async function resolveLatestPendingControllerSession(projectPath, dependencies = {}) {
  const {
    readCloseLoopControllerSessionEntries,
    loadCloseLoopControllerSessionPayload
  } = dependencies;
  const sessions = await readCloseLoopControllerSessionEntries(projectPath);
  const pendingSession = sessions.find((session) => Number(session && session.pending_goals) > 0);
  if (!pendingSession || !pendingSession.file) {
    return null;
  }
  try {
    return await loadCloseLoopControllerSessionPayload(projectPath, pendingSession.file);
  } catch (_error) {
    return null;
  }
}

module.exports = {
  resolveLatestRecoverableBatchSummary,
  resolveLatestPendingControllerSession
};
