const path = require('path');

async function readCloseLoopControllerSessionEntries(projectPath, dependencies = {}) {
  const { getCloseLoopControllerSessionDir, fs } = dependencies;
  const sessionDir = getCloseLoopControllerSessionDir(projectPath);
  if (!(await fs.pathExists(sessionDir))) {
    return [];
  }

  const files = (await fs.readdir(sessionDir)).filter((item) => item.toLowerCase().endsWith('.json'));
  const sessions = [];
  for (const file of files) {
    const filePath = path.join(sessionDir, file);
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
      id: payload && typeof payload.controller_session === 'object' && typeof payload.controller_session.id === 'string'
        ? payload.controller_session.id
        : fallbackId,
      file: filePath,
      status: payload && typeof payload.status === 'string'
        ? payload.status
        : parseError
          ? 'invalid'
          : 'unknown',
      queue_file: payload && typeof payload.queue_file === 'string' ? payload.queue_file : null,
      queue_format: payload && typeof payload.queue_format === 'string' ? payload.queue_format : null,
      processed_goals: payload && Number.isFinite(Number(payload.processed_goals)) ? Number(payload.processed_goals) : null,
      pending_goals: payload && Number.isFinite(Number(payload.pending_goals)) ? Number(payload.pending_goals) : null,
      updated_at: payload && typeof payload.updated_at === 'string' ? payload.updated_at : fallbackTimestamp,
      parse_error: parseError ? parseError.message : null,
      mtime_ms: stats.mtimeMs
    });
  }

  sessions.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return sessions;
}

async function resolveCloseLoopControllerSessionFile(projectPath, sessionCandidate, dependencies = {}) {
  const { readCloseLoopControllerSessionEntries, getCloseLoopControllerSessionDir, sanitizeBatchSessionId, fs } = dependencies;
  if (typeof sessionCandidate !== 'string' || !sessionCandidate.trim()) {
    throw new Error('--controller-resume requires a session id/file or "latest".');
  }

  const normalizedCandidate = sessionCandidate.trim();
  if (normalizedCandidate.toLowerCase() === 'latest') {
    const sessions = await readCloseLoopControllerSessionEntries(projectPath, dependencies);
    if (sessions.length === 0) {
      throw new Error(`No controller sessions found in: ${getCloseLoopControllerSessionDir(projectPath)}`);
    }
    return sessions[0].file;
  }

  if (path.isAbsolute(normalizedCandidate)) {
    return normalizedCandidate;
  }
  if (normalizedCandidate.includes('/') || normalizedCandidate.includes('\\') || normalizedCandidate.toLowerCase().endsWith('.json')) {
    return path.join(projectPath, normalizedCandidate);
  }

  const byId = path.join(getCloseLoopControllerSessionDir(projectPath), `${sanitizeBatchSessionId(normalizedCandidate)}.json`);
  if (await fs.pathExists(byId)) {
    return byId;
  }
  return path.join(projectPath, normalizedCandidate);
}

async function loadCloseLoopControllerSessionPayload(projectPath, sessionCandidate, dependencies = {}) {
  const { fs } = dependencies;
  const sessionFile = await resolveCloseLoopControllerSessionFile(projectPath, sessionCandidate, dependencies);
  if (!(await fs.pathExists(sessionFile))) {
    throw new Error(`Controller session file not found: ${sessionFile}`);
  }
  let payload = null;
  try {
    payload = await fs.readJson(sessionFile);
  } catch (error) {
    throw new Error(`Invalid controller session JSON: ${sessionFile} (${error.message})`);
  }
  const sessionId = payload && payload.controller_session && payload.controller_session.id
    ? payload.controller_session.id
    : path.basename(sessionFile, '.json');
  return {
    id: sessionId,
    file: sessionFile,
    payload: payload || {}
  };
}

module.exports = {
  readCloseLoopControllerSessionEntries,
  resolveCloseLoopControllerSessionFile,
  loadCloseLoopControllerSessionPayload
};
