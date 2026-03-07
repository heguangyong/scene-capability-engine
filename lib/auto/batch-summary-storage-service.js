const path = require('path');

function getCloseLoopBatchSummaryDir(projectPath) {
  return path.join(projectPath, '.sce', 'auto', 'close-loop-batch-summaries');
}

async function readCloseLoopBatchSummaryEntries(projectPath, dependencies = {}) {
  const { fs } = dependencies;
  const summaryDir = getCloseLoopBatchSummaryDir(projectPath);
  if (!(await fs.pathExists(summaryDir))) {
    return [];
  }

  const files = (await fs.readdir(summaryDir)).filter((item) => item.toLowerCase().endsWith('.json'));
  const sessions = [];
  for (const file of files) {
    const filePath = path.join(summaryDir, file);
    const stats = await fs.stat(filePath);
    const fallbackTimestamp = new Date(stats.mtimeMs).toISOString();
    const fallbackId = path.basename(file, '.json');
    let payload = null;
    let parseError = null;

    try {
      payload = await fs.readJson(filePath);
    } catch (error) {
      parseError = error;
    }

    sessions.push({
      id: payload && typeof payload.batch_session === 'object' && typeof payload.batch_session.id === 'string'
        ? payload.batch_session.id
        : fallbackId,
      file: filePath,
      status: payload && typeof payload.status === 'string'
        ? payload.status
        : parseError
          ? 'invalid'
          : 'unknown',
      goals_file: payload && typeof payload.goals_file === 'string' ? payload.goals_file : null,
      total_goals: payload && Number.isInteger(Number(payload.total_goals)) ? Number(payload.total_goals) : null,
      processed_goals: payload && Number.isInteger(Number(payload.processed_goals)) ? Number(payload.processed_goals) : null,
      updated_at: payload && typeof payload.updated_at === 'string' ? payload.updated_at : fallbackTimestamp,
      parse_error: parseError ? parseError.message : null,
      mtime_ms: stats.mtimeMs
    });
  }

  sessions.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return sessions;
}

async function resolveCloseLoopBatchSummaryFile(projectPath, summaryCandidate, dependencies = {}) {
  const { fs } = dependencies;
  if (typeof summaryCandidate !== 'string' || !summaryCandidate.trim()) {
    throw new Error('--resume-from-summary requires a file path or "latest".');
  }

  const normalizedCandidate = summaryCandidate.trim();
  if (normalizedCandidate.toLowerCase() === 'latest') {
    const summaryDir = getCloseLoopBatchSummaryDir(projectPath);
    if (!(await fs.pathExists(summaryDir))) {
      throw new Error(`No batch summary sessions found in: ${summaryDir}`);
    }
    const candidates = (await fs.readdir(summaryDir)).filter((item) => item.toLowerCase().endsWith('.json'));
    if (candidates.length === 0) {
      throw new Error(`No batch summary sessions found in: ${summaryDir}`);
    }
    const entries = [];
    for (const file of candidates) {
      const filePath = path.join(summaryDir, file);
      const stats = await fs.stat(filePath);
      entries.push({ file: filePath, mtimeMs: stats.mtimeMs });
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return entries[0].file;
  }

  return path.isAbsolute(normalizedCandidate)
    ? normalizedCandidate
    : path.join(projectPath, normalizedCandidate);
}

async function loadCloseLoopBatchSummaryPayload(projectPath, summaryCandidate, dependencies = {}) {
  const { fs } = dependencies;
  const summaryFile = await resolveCloseLoopBatchSummaryFile(projectPath, summaryCandidate, dependencies);
  if (!(await fs.pathExists(summaryFile))) {
    throw new Error(`Batch summary file not found: ${summaryFile}`);
  }

  let payload = null;
  try {
    payload = await fs.readJson(summaryFile);
  } catch (error) {
    throw new Error(`Invalid batch summary JSON: ${summaryFile} (${error.message})`);
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error(`Invalid batch summary payload: ${summaryFile}`);
  }

  return { file: summaryFile, payload };
}

module.exports = {
  getCloseLoopBatchSummaryDir,
  readCloseLoopBatchSummaryEntries,
  resolveCloseLoopBatchSummaryFile,
  loadCloseLoopBatchSummaryPayload
};
