const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs-extra');
const minimatchModule = require('minimatch');
const { getSceStateStore } = require('../state/sce-state-store');

const minimatch = typeof minimatchModule === 'function'
  ? minimatchModule
  : (minimatchModule && typeof minimatchModule.minimatch === 'function'
    ? minimatchModule.minimatch
    : () => false);

const TIMELINE_SCHEMA_VERSION = '1.0';
const TIMELINE_CONFIG_RELATIVE_PATH = path.join('.sce', 'config', 'timeline.json');
const TIMELINE_DIR = path.join('.sce', 'timeline');
const TIMELINE_INDEX_FILE = 'index.json';
const TIMELINE_SNAPSHOTS_DIR = 'snapshots';

const DEFAULT_TIMELINE_CONFIG = Object.freeze({
  enabled: true,
  auto_interval_minutes: 30,
  max_entries: 120,
  exclude_paths: [
    '.git/**',
    'node_modules/**',
    '.sce/timeline/**',
    'coverage/**',
    'dist/**',
    'build/**',
    '.next/**',
    'tmp/**',
    'temp/**'
  ]
});

function nowIso() {
  return new Date().toISOString();
}

function normalizePosix(relativePath) {
  return `${relativePath || ''}`.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = `${value || ''}`.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizePositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(`${value}`, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function safeSnapshotId(value) {
  return `${value || ''}`
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function createSnapshotId(prefix = 'ts') {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = `${now.getUTCMonth() + 1}`.padStart(2, '0');
  const dd = `${now.getUTCDate()}`.padStart(2, '0');
  const hh = `${now.getUTCHours()}`.padStart(2, '0');
  const mi = `${now.getUTCMinutes()}`.padStart(2, '0');
  const ss = `${now.getUTCSeconds()}`.padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${yyyy}${mm}${dd}-${hh}${mi}${ss}-${rand}`;
}

class ProjectTimelineStore {
  constructor(projectPath = process.cwd(), fileSystem = fs, options = {}) {
    this._projectPath = projectPath;
    this._fileSystem = fileSystem;
    this._timelineDir = path.join(projectPath, TIMELINE_DIR);
    this._indexPath = path.join(this._timelineDir, TIMELINE_INDEX_FILE);
    this._snapshotsDir = path.join(this._timelineDir, TIMELINE_SNAPSHOTS_DIR);
    this._configPath = path.join(projectPath, TIMELINE_CONFIG_RELATIVE_PATH);
    this._env = options.env || process.env;
    this._stateStore = options.stateStore || getSceStateStore(projectPath, {
      fileSystem: this._fileSystem,
      env: this._env,
      sqliteModule: options.sqliteModule
    });
    this._preferSqliteReads = normalizeBoolean(
      options.preferSqliteReads !== undefined
        ? options.preferSqliteReads
        : (this._env && this._env.SCE_TIMELINE_PREFER_SQLITE_READS),
      true
    );
  }

  async getConfig() {
    let filePayload = {};
    if (await this._fileSystem.pathExists(this._configPath)) {
      try {
        filePayload = await this._fileSystem.readJson(this._configPath);
      } catch (_error) {
        filePayload = {};
      }
    }

    const merged = {
      ...DEFAULT_TIMELINE_CONFIG,
      ...(filePayload && typeof filePayload === 'object' ? filePayload : {})
    };

    merged.enabled = normalizeBoolean(merged.enabled, DEFAULT_TIMELINE_CONFIG.enabled);
    merged.auto_interval_minutes = normalizePositiveInteger(
      merged.auto_interval_minutes,
      DEFAULT_TIMELINE_CONFIG.auto_interval_minutes,
      24 * 60
    );
    merged.max_entries = normalizePositiveInteger(
      merged.max_entries,
      DEFAULT_TIMELINE_CONFIG.max_entries,
      10000
    );

    const rawExcludes = Array.isArray(merged.exclude_paths)
      ? merged.exclude_paths
      : DEFAULT_TIMELINE_CONFIG.exclude_paths;
    merged.exclude_paths = Array.from(new Set(
      rawExcludes
        .map((item) => normalizePosix(item))
        .filter(Boolean)
    ));

    return merged;
  }

  async updateConfig(patch = {}) {
    const current = await this.getConfig();
    const next = {
      ...current,
      ...(patch && typeof patch === 'object' ? patch : {})
    };

    next.enabled = normalizeBoolean(next.enabled, current.enabled);
    next.auto_interval_minutes = normalizePositiveInteger(next.auto_interval_minutes, current.auto_interval_minutes, 24 * 60);
    next.max_entries = normalizePositiveInteger(next.max_entries, current.max_entries, 10000);
    next.exclude_paths = Array.from(new Set(
      (Array.isArray(next.exclude_paths) ? next.exclude_paths : current.exclude_paths)
        .map((item) => normalizePosix(item))
        .filter(Boolean)
    ));

    await this._fileSystem.ensureDir(path.dirname(this._configPath));
    await this._fileSystem.writeJson(this._configPath, next, { spaces: 2 });
    return next;
  }

  async maybeAutoSnapshot(options = {}) {
    const config = await this.getConfig();
    if (!config.enabled) {
      return {
        mode: 'timeline-auto',
        success: true,
        created: false,
        reason: 'disabled'
      };
    }

    const readResult = await this._readTimelineEntriesForRead({ limit: 1 });
    const latest = Array.isArray(readResult.entries) && readResult.entries.length > 0
      ? readResult.entries[0]
      : null;
    const intervalMinutes = normalizePositiveInteger(options.intervalMinutes, config.auto_interval_minutes, 24 * 60);

    if (latest && latest.created_at) {
      const elapsedMs = Date.now() - Date.parse(latest.created_at);
      if (Number.isFinite(elapsedMs) && elapsedMs < intervalMinutes * 60 * 1000) {
        return {
          mode: 'timeline-auto',
          success: true,
          created: false,
          reason: 'interval-not-reached',
          latest_snapshot_id: latest.snapshot_id,
          minutes_remaining: Math.max(0, Math.ceil((intervalMinutes * 60 * 1000 - elapsedMs) / 60000))
        };
      }
    }

    const created = await this.saveSnapshot({
      trigger: 'auto',
      event: options.event || 'auto.tick',
      summary: options.summary || 'auto timeline checkpoint'
    });
    return {
      mode: 'timeline-auto',
      success: true,
      created: true,
      snapshot: created
    };
  }

  async saveSnapshot(options = {}) {
    const config = await this.getConfig();
    if (!config.enabled && options.force !== true) {
      return {
        mode: 'timeline-save',
        success: true,
        created: false,
        reason: 'disabled'
      };
    }

    await this._fileSystem.ensureDir(this._snapshotsDir);

    const requestedId = safeSnapshotId(options.snapshotId);
    const snapshotId = requestedId || createSnapshotId('tl');
    const createdAt = nowIso();

    const snapshotRoot = path.join(this._snapshotsDir, snapshotId);
    const workspaceRoot = path.join(snapshotRoot, 'workspace');
    await this._fileSystem.ensureDir(workspaceRoot);

    const excludePatterns = this._buildExcludePatterns(config.exclude_paths);
    const files = await this._collectWorkspaceFiles(excludePatterns);

    let totalBytes = 0;
    for (const relativePath of files) {
      const sourcePath = path.join(this._projectPath, relativePath);
      const targetPath = path.join(workspaceRoot, relativePath);
      await this._fileSystem.ensureDir(path.dirname(targetPath));
      await this._fileSystem.copyFile(sourcePath, targetPath);
      const stat = await this._fileSystem.stat(targetPath);
      totalBytes += Number(stat.size || 0);
    }

    const metadata = {
      schema_version: TIMELINE_SCHEMA_VERSION,
      snapshot_id: snapshotId,
      created_at: createdAt,
      trigger: `${options.trigger || 'manual'}`,
      event: `${options.event || 'manual.save'}`,
      summary: `${options.summary || ''}`.trim(),
      session_id: `${options.sessionId || ''}`.trim() || null,
      scene_id: `${options.sceneId || ''}`.trim() || null,
      command: `${options.command || ''}`.trim() || null,
      file_count: files.length,
      total_bytes: totalBytes,
      git: this._readGitStatus(),
      files_manifest: 'files.json'
    };

    await this._fileSystem.writeJson(path.join(snapshotRoot, 'snapshot.json'), metadata, { spaces: 2 });
    await this._fileSystem.writeJson(path.join(snapshotRoot, 'files.json'), {
      snapshot_id: snapshotId,
      file_count: files.length,
      files
    }, { spaces: 2 });

    const index = await this._readIndex();
    const entry = {
      snapshot_id: snapshotId,
      created_at: createdAt,
      trigger: metadata.trigger,
      event: metadata.event,
      summary: metadata.summary,
      scene_id: metadata.scene_id,
      session_id: metadata.session_id,
      command: metadata.command,
      file_count: files.length,
      total_bytes: totalBytes,
      path: this._toRelativePosix(snapshotRoot),
      git: metadata.git
    };

    index.snapshots = Array.isArray(index.snapshots) ? index.snapshots : [];
    index.snapshots.unshift(entry);

    const limit = normalizePositiveInteger(config.max_entries, DEFAULT_TIMELINE_CONFIG.max_entries, 10000);
    if (index.snapshots.length > limit) {
      const removed = index.snapshots.splice(limit);
      for (const obsolete of removed) {
        const obsoletePath = path.join(this._projectPath, normalizePosix(obsolete.path || ''));
        try {
          await this._fileSystem.remove(obsoletePath);
        } catch (_error) {
          // best effort cleanup
        }
      }
    }

    await this._writeIndex(index);
    await this._syncTimelineIndexEntries([entry], 'runtime.project-timeline.save');

    return {
      ...entry,
      snapshot_root: snapshotRoot,
      workspace_root: workspaceRoot
    };
  }

  async listSnapshots(options = {}) {
    const trigger = `${options.trigger || ''}`.trim();
    const limit = normalizePositiveInteger(options.limit, 20, 1000);
    const readResult = await this._readTimelineEntriesForRead({
      trigger,
      limit
    });
    const consistency = await this._getTimelineIndexConsistency();

    return {
      mode: 'timeline-list',
      success: true,
      total: readResult.entries.length,
      read_source: readResult.source,
      consistency,
      snapshots: readResult.entries
    };
  }

  async getSnapshot(snapshotId) {
    const normalizedId = safeSnapshotId(snapshotId);
    if (!normalizedId) {
      throw new Error('snapshotId is required');
    }

    const resolved = await this._resolveTimelineEntryBySnapshotIdWithSource(normalizedId);
    const entry = resolved.entry;
    if (!entry) {
      throw new Error(`Timeline snapshot not found: ${normalizedId}`);
    }

    const snapshotRoot = path.join(this._projectPath, normalizePosix(entry.path || ''));
    const metadataPath = path.join(snapshotRoot, 'snapshot.json');
    const filesPath = path.join(snapshotRoot, 'files.json');

    let metadata = null;
    let files = null;
    try {
      metadata = await this._fileSystem.readJson(metadataPath);
    } catch (_error) {
      metadata = null;
    }
    try {
      files = await this._fileSystem.readJson(filesPath);
    } catch (_error) {
      files = null;
    }

    return {
      mode: 'timeline-show',
      success: true,
      read_source: resolved.source,
      consistency: await this._getTimelineIndexConsistency(),
      snapshot: entry,
      metadata,
      files
    };
  }

  async restoreSnapshot(snapshotId, options = {}) {
    const normalizedId = safeSnapshotId(snapshotId);
    if (!normalizedId) {
      throw new Error('snapshotId is required');
    }

    const config = await this.getConfig();
    const entry = await this._resolveTimelineEntryBySnapshotId(normalizedId);
    if (!entry) {
      throw new Error(`Timeline snapshot not found: ${normalizedId}`);
    }

    const snapshotRoot = path.join(this._projectPath, normalizePosix(entry.path || ''));
    const workspaceRoot = path.join(snapshotRoot, 'workspace');
    if (!await this._fileSystem.pathExists(workspaceRoot)) {
      throw new Error(`Timeline snapshot workspace missing: ${normalizedId}`);
    }

    if (options.preSave !== false) {
      await this.saveSnapshot({
        trigger: 'manual',
        event: 'restore.pre-save',
        summary: `pre-restore checkpoint before ${normalizedId}`,
        force: true
      });
    }

    const excludePatterns = this._buildExcludePatterns(config.exclude_paths);
    const snapshotFiles = await this._collectFilesFromDirectory(workspaceRoot, excludePatterns, true);

    for (const relativePath of snapshotFiles) {
      const sourcePath = path.join(workspaceRoot, relativePath);
      const targetPath = path.join(this._projectPath, relativePath);
      await this._fileSystem.ensureDir(path.dirname(targetPath));
      await this._fileSystem.copyFile(sourcePath, targetPath);
    }

    if (options.prune === true) {
      const currentFiles = await this._collectWorkspaceFiles(excludePatterns);
      const snapshotSet = new Set(snapshotFiles);
      for (const relativePath of currentFiles) {
        if (!snapshotSet.has(relativePath)) {
          await this._fileSystem.remove(path.join(this._projectPath, relativePath));
        }
      }
    }

    const restored = await this.saveSnapshot({
      trigger: 'restore',
      event: 'restore.completed',
      summary: `restored from ${normalizedId}`,
      force: true
    });

    return {
      mode: 'timeline-restore',
      success: true,
      restored_from: normalizedId,
      restored_snapshot: restored,
      pruned: options.prune === true
    };
  }

  _normalizeTimelineIndexedEntry(row = {}) {
    return {
      snapshot_id: `${row.snapshot_id || ''}`.trim(),
      created_at: `${row.created_at || ''}`.trim(),
      trigger: `${row.trigger || ''}`.trim(),
      event: `${row.event || ''}`.trim(),
      summary: `${row.summary || ''}`.trim(),
      scene_id: row.scene_id ? `${row.scene_id}`.trim() : null,
      session_id: row.session_id ? `${row.session_id}`.trim() : null,
      command: row.command ? `${row.command}`.trim() : null,
      file_count: Number.isFinite(Number(row.file_count)) ? Number(row.file_count) : 0,
      total_bytes: Number.isFinite(Number(row.total_bytes)) ? Number(row.total_bytes) : 0,
      path: `${row.snapshot_path || row.path || ''}`.trim(),
      git: row && typeof row.git === 'object' ? row.git : {}
    };
  }

  async _readTimelineEntriesFromSqlite(options = {}) {
    if (!this._stateStore || this._preferSqliteReads !== true) {
      return null;
    }
    try {
      const rows = await this._stateStore.listTimelineSnapshotIndex({
        trigger: options.trigger,
        snapshotId: options.snapshotId,
        limit: options.limit
      });
      if (!Array.isArray(rows) || rows.length === 0) {
        return [];
      }
      return rows.map((row) => this._normalizeTimelineIndexedEntry(row));
    } catch (_error) {
      return null;
    }
  }

  async _readTimelineEntriesFromFile(options = {}) {
    const index = await this._readIndex();
    const trigger = `${options.trigger || ''}`.trim();
    const snapshotId = safeSnapshotId(options.snapshotId);
    const limit = normalizePositiveInteger(options.limit, 20, 1000);

    let snapshots = Array.isArray(index.snapshots) ? [...index.snapshots] : [];
    if (trigger) {
      snapshots = snapshots.filter((item) => `${item.trigger || ''}`.trim() === trigger);
    }
    if (snapshotId) {
      snapshots = snapshots.filter((item) => `${item.snapshot_id || ''}`.trim() === snapshotId);
    }
    if (limit > 0) {
      snapshots = snapshots.slice(0, limit);
    }
    return snapshots.map((item) => this._normalizeTimelineIndexedEntry(item));
  }

  async _readTimelineEntriesForRead(options = {}) {
    const sqliteEntries = await this._readTimelineEntriesFromSqlite(options);
    if (Array.isArray(sqliteEntries) && sqliteEntries.length > 0) {
      return {
        source: 'sqlite',
        entries: sqliteEntries
      };
    }
    const fileEntries = await this._readTimelineEntriesFromFile(options);
    return {
      source: 'file',
      entries: fileEntries
    };
  }

  async _resolveTimelineEntryBySnapshotId(snapshotId) {
    const resolved = await this._resolveTimelineEntryBySnapshotIdWithSource(snapshotId);
    return resolved.entry;
  }

  async _resolveTimelineEntryBySnapshotIdWithSource(snapshotId) {
    const normalizedId = safeSnapshotId(snapshotId);
    if (!normalizedId) {
      return {
        source: 'file',
        entry: null
      };
    }
    const fromSqlite = await this._readTimelineEntriesFromSqlite({
      snapshotId: normalizedId,
      limit: 1
    });
    if (Array.isArray(fromSqlite) && fromSqlite.length > 0) {
      return {
        source: 'sqlite',
        entry: fromSqlite[0]
      };
    }
    const fromFile = await this._readTimelineEntriesFromFile({
      snapshotId: normalizedId,
      limit: 1
    });
    return {
      source: 'file',
      entry: Array.isArray(fromFile) && fromFile.length > 0 ? fromFile[0] : null
    };
  }

  async _syncTimelineIndexEntries(entries = [], source = 'runtime.project-timeline') {
    if (!this._stateStore || !Array.isArray(entries) || entries.length === 0) {
      return;
    }
    try {
      await this._stateStore.upsertTimelineSnapshotIndex(entries.map((item) => ({
        snapshot_id: item.snapshot_id,
        created_at: item.created_at,
        trigger: item.trigger,
        event: item.event,
        summary: item.summary,
        scene_id: item.scene_id,
        session_id: item.session_id,
        command: item.command,
        file_count: item.file_count,
        total_bytes: item.total_bytes,
        snapshot_path: item.path,
        git: item.git || {}
      })), {
        source
      });
    } catch (_error) {
      // best effort sync, keep file index as source of truth
    }
  }

  async _getTimelineIndexConsistency() {
    const index = await this._readIndex();
    const fileCount = Array.isArray(index.snapshots) ? index.snapshots.length : 0;
    let sqliteCount = null;
    if (this._stateStore) {
      try {
        const rows = await this._stateStore.listTimelineSnapshotIndex({ limit: 0 });
        if (Array.isArray(rows)) {
          sqliteCount = rows.length;
        }
      } catch (_error) {
        sqliteCount = null;
      }
    }

    let status = 'file-only';
    if (sqliteCount === null) {
      status = 'sqlite-unavailable';
    } else if (fileCount === 0 && sqliteCount === 0) {
      status = 'empty';
    } else if (fileCount === 0 && sqliteCount > 0) {
      status = 'sqlite-only';
    } else if (fileCount > 0 && sqliteCount === 0) {
      status = 'file-only';
    } else if (fileCount === sqliteCount) {
      status = 'aligned';
    } else if (sqliteCount < fileCount) {
      status = 'pending-sync';
    } else if (sqliteCount > fileCount) {
      status = 'sqlite-ahead';
    }

    return {
      file_index_count: fileCount,
      sqlite_index_count: sqliteCount,
      status
    };
  }

  _buildExcludePatterns(configPatterns = []) {
    const defaults = DEFAULT_TIMELINE_CONFIG.exclude_paths;
    return Array.from(new Set([
      ...defaults,
      ...(Array.isArray(configPatterns) ? configPatterns : [])
    ].map((item) => normalizePosix(item)).filter(Boolean)));
  }

  _isExcluded(relativePath, patterns = []) {
    const normalized = normalizePosix(relativePath);
    if (!normalized) {
      return false;
    }
    for (const pattern of patterns) {
      if (minimatch(normalized, pattern, { dot: true })) {
        return true;
      }
    }
    return false;
  }

  async _collectWorkspaceFiles(excludePatterns = []) {
    return this._collectFilesFromDirectory(this._projectPath, excludePatterns, false);
  }

  async _collectFilesFromDirectory(rootPath, excludePatterns = [], relativeMode = false) {
    const files = [];
    const queue = [''];

    while (queue.length > 0) {
      const currentRelative = queue.shift();
      const currentAbsolute = currentRelative
        ? path.join(rootPath, currentRelative)
        : rootPath;

      let entries = [];
      try {
        entries = await this._fileSystem.readdir(currentAbsolute, { withFileTypes: true });
      } catch (_error) {
        continue;
      }

      for (const entry of entries) {
        const childRelative = currentRelative
          ? normalizePosix(path.join(currentRelative, entry.name))
          : normalizePosix(entry.name);

        if (this._isExcluded(childRelative, excludePatterns)) {
          continue;
        }

        if (entry.isDirectory()) {
          queue.push(childRelative);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        files.push(relativeMode ? childRelative : childRelative);
      }
    }

    files.sort();
    return files;
  }

  _toRelativePosix(absolutePath) {
    return path.relative(this._projectPath, absolutePath).replace(/\\/g, '/');
  }

  _readGitStatus() {
    const branch = this._spawnGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    const head = this._spawnGit(['rev-parse', 'HEAD']);
    const porcelain = this._spawnGit(['status', '--porcelain']);
    const dirtyFiles = porcelain.ok
      ? porcelain.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      : [];
    return {
      branch: branch.ok ? branch.stdout : null,
      head: head.ok ? head.stdout : null,
      dirty: dirtyFiles.length > 0,
      dirty_count: dirtyFiles.length,
      dirty_files: dirtyFiles.slice(0, 100)
    };
  }

  _spawnGit(args = []) {
    try {
      const result = spawnSync('git', args, {
        cwd: this._projectPath,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        return { ok: false, stdout: '', stderr: `${result.stderr || ''}`.trim() };
      }
      return { ok: true, stdout: `${result.stdout || ''}`.trim(), stderr: '' };
    } catch (error) {
      return { ok: false, stdout: '', stderr: error.message };
    }
  }

  async _readIndex() {
    if (!await this._fileSystem.pathExists(this._indexPath)) {
      return {
        schema_version: TIMELINE_SCHEMA_VERSION,
        updated_at: nowIso(),
        snapshots: []
      };
    }

    try {
      const payload = await this._fileSystem.readJson(this._indexPath);
      return {
        schema_version: payload && payload.schema_version ? payload.schema_version : TIMELINE_SCHEMA_VERSION,
        updated_at: payload && payload.updated_at ? payload.updated_at : nowIso(),
        snapshots: Array.isArray(payload && payload.snapshots) ? payload.snapshots : []
      };
    } catch (_error) {
      return {
        schema_version: TIMELINE_SCHEMA_VERSION,
        updated_at: nowIso(),
        snapshots: []
      };
    }
  }

  async _writeIndex(index = {}) {
    const payload = {
      schema_version: TIMELINE_SCHEMA_VERSION,
      updated_at: nowIso(),
      snapshots: Array.isArray(index.snapshots) ? index.snapshots : []
    };

    await this._fileSystem.ensureDir(this._timelineDir);
    await this._fileSystem.writeJson(this._indexPath, payload, { spaces: 2 });
    return payload;
  }
}

async function captureTimelineCheckpoint(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const store = dependencies.timelineStore || new ProjectTimelineStore(projectPath, dependencies.fileSystem || fs, dependencies);

  try {
    if (options.auto !== false) {
      await store.maybeAutoSnapshot({
        event: options.event || 'checkpoint.auto',
        summary: options.autoSummary || options.summary || ''
      });
    }
    return await store.saveSnapshot({
      trigger: options.trigger || 'key-event',
      event: options.event || 'checkpoint.event',
      summary: options.summary || '',
      command: options.command || '',
      sessionId: options.sessionId,
      sceneId: options.sceneId
    });
  } catch (error) {
    return {
      mode: 'timeline-checkpoint',
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  ProjectTimelineStore,
  TIMELINE_SCHEMA_VERSION,
  TIMELINE_CONFIG_RELATIVE_PATH,
  TIMELINE_DIR,
  TIMELINE_INDEX_FILE,
  TIMELINE_SNAPSHOTS_DIR,
  DEFAULT_TIMELINE_CONFIG,
  captureTimelineCheckpoint
};
