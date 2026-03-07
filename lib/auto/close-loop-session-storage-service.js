const path = require('path');

function getCloseLoopSessionDir(projectPath) {
  return path.join(projectPath, '.sce', 'auto', 'close-loop-sessions');
}

async function readCloseLoopSessionEntries(projectPath, dependencies = {}) {
  const { fs } = dependencies;
  const sessionDir = getCloseLoopSessionDir(projectPath);
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
      id: payload && payload.session_id ? payload.session_id : fallbackId,
      file: filePath,
      status: payload && typeof payload.status === 'string' ? payload.status : (parseError ? 'invalid' : 'unknown'),
      goal: payload && typeof payload.goal === 'string' ? payload.goal : null,
      master_spec: payload && payload.portfolio && typeof payload.portfolio.master_spec === 'string' ? payload.portfolio.master_spec : null,
      sub_spec_count: payload && payload.portfolio && Array.isArray(payload.portfolio.sub_specs) ? payload.portfolio.sub_specs.length : null,
      updated_at: payload && typeof payload.updated_at === 'string' ? payload.updated_at : fallbackTimestamp,
      parse_error: parseError ? parseError.message : null,
      mtime_ms: stats.mtimeMs
    });
  }

  sessions.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return sessions;
}

module.exports = {
  getCloseLoopSessionDir,
  readCloseLoopSessionEntries
};
