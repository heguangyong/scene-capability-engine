const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');

const DEFAULT_BACKEND = 'sqlite';
const DEFAULT_DB_RELATIVE_PATH = path.join('.sce', 'state', 'sce-state.sqlite');
const SUPPORTED_BACKENDS = new Set(['sqlite']);

function normalizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(`${value}`, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseJsonSafe(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function normalizeStringArray(value, fallback = []) {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  return value
    .map((item) => normalizeString(item))
    .filter(Boolean);
}

function normalizeIsoTimestamp(value, fallback = '') {
  const normalized = normalizeString(value);
  if (!normalized) {
    return normalizeString(fallback);
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return normalizeString(fallback);
  }
  return new Date(parsed).toISOString();
}

function formatSegment(value) {
  const normalized = normalizeInteger(value, 0);
  if (normalized <= 0) {
    return '00';
  }
  return `${normalized}`.padStart(2, '0');
}

function buildTaskRef(sceneNo, specNo, taskNo) {
  return `${formatSegment(sceneNo)}.${formatSegment(specNo)}.${formatSegment(taskNo)}`;
}

function resolveBackend(explicitBackend = '', env = process.env) {
  const backendFromEnv = normalizeString(env && env.SCE_STATE_BACKEND);
  const normalized = normalizeString(explicitBackend || backendFromEnv || DEFAULT_BACKEND).toLowerCase();
  if (!SUPPORTED_BACKENDS.has(normalized)) {
    return DEFAULT_BACKEND;
  }
  return normalized;
}

function loadNodeSqlite(sqliteModule) {
  if (sqliteModule) {
    return sqliteModule;
  }
  try {
    return require('node:sqlite');
  } catch (_error) {
    return null;
  }
}

class SceStateStore {
  constructor(projectPath = process.cwd(), options = {}) {
    this.projectPath = projectPath;
    this.fileSystem = options.fileSystem || fs;
    this.env = options.env || process.env;
    this.backend = resolveBackend(options.backend, this.env);
    this.dbPath = options.dbPath || path.join(projectPath, DEFAULT_DB_RELATIVE_PATH);
    this.now = typeof options.now === 'function'
      ? options.now
      : () => new Date().toISOString();

    const sqlite = loadNodeSqlite(options.sqliteModule);
    this.DatabaseSync = sqlite && sqlite.DatabaseSync ? sqlite.DatabaseSync : null;
    this._db = null;
    this._ready = false;
    this._memory = {
      scenes: {},
      specs: {},
      tasks: {},
      refs: {},
      auth_leases: {},
      auth_events: [],
      sequences: {
        scene_next: 1,
        spec_next_by_scene: {},
        task_next_by_scene_spec: {}
      },
      events_by_job: {}
    };
  }

  isSqliteConfigured() {
    return this.backend === 'sqlite';
  }

  isSqliteAvailable() {
    return this.isSqliteConfigured() && Boolean(this.DatabaseSync);
  }

  getStoreRelativePath() {
    if (!this.isSqliteConfigured()) {
      return null;
    }
    return path.relative(this.projectPath, this.dbPath).replace(/\\/g, '/');
  }

  async ensureReady() {
    if (!this.isSqliteAvailable()) {
      return false;
    }
    if (this._ready && this._db) {
      return true;
    }

    await this.fileSystem.ensureDir(path.dirname(this.dbPath));
    this._db = new this.DatabaseSync(this.dbPath);
    this._initializeSchema();
    this._ready = true;
    return true;
  }

  _useMemoryBackend() {
    if (this.isSqliteAvailable()) {
      return false;
    }
    const memoryFallbackFlag = normalizeString(this.env && this.env.SCE_STATE_ALLOW_MEMORY_FALLBACK) === '1';
    const isTestEnv = normalizeString(this.env && this.env.NODE_ENV).toLowerCase() === 'test';
    return memoryFallbackFlag || isTestEnv;
  }

  _initializeSchema() {
    this._db.exec('PRAGMA journal_mode = WAL;');
    this._db.exec('PRAGMA foreign_keys = ON;');
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS scene_registry (
        scene_id TEXT PRIMARY KEY,
        scene_no INTEGER NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS spec_registry (
        scene_id TEXT NOT NULL,
        spec_id TEXT NOT NULL,
        spec_no INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scene_id, spec_id),
        UNIQUE (scene_id, spec_no),
        FOREIGN KEY (scene_id) REFERENCES scene_registry(scene_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS task_ref_registry (
        task_ref TEXT PRIMARY KEY,
        scene_id TEXT NOT NULL,
        spec_id TEXT NOT NULL,
        task_key TEXT NOT NULL,
        task_no INTEGER NOT NULL,
        source TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (scene_id, spec_id, task_key),
        UNIQUE (scene_id, spec_id, task_no),
        FOREIGN KEY (scene_id, spec_id) REFERENCES spec_registry(scene_id, spec_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS studio_event_stream (
        event_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_timestamp TEXT NOT NULL,
        scene_id TEXT,
        spec_id TEXT,
        created_at TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_studio_event_stream_job_ts
        ON studio_event_stream(job_id, event_timestamp);

      CREATE TABLE IF NOT EXISTS auth_lease_registry (
        lease_id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        role TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        reason TEXT,
        metadata_json TEXT,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_auth_lease_registry_expires
        ON auth_lease_registry(expires_at);

      CREATE TABLE IF NOT EXISTS auth_event_stream (
        event_id TEXT PRIMARY KEY,
        event_timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        action TEXT,
        actor TEXT,
        lease_id TEXT,
        result TEXT,
        target TEXT,
        detail_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_auth_event_stream_ts
        ON auth_event_stream(event_timestamp);
    `);
  }

  _withTransaction(callback) {
    this._db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this._db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this._db.exec('ROLLBACK');
      } catch (_rollbackError) {
        // Ignore rollback failure.
      }
      throw error;
    }
  }

  _ensureSceneRow(sceneId, nowIso) {
    const existing = this._db
      .prepare('SELECT scene_no FROM scene_registry WHERE scene_id = ?')
      .get(sceneId);
    if (existing && Number.isFinite(existing.scene_no)) {
      this._db
        .prepare('UPDATE scene_registry SET updated_at = ? WHERE scene_id = ?')
        .run(nowIso, sceneId);
      return Number(existing.scene_no);
    }

    const next = this._db
      .prepare('SELECT COALESCE(MAX(scene_no), 0) + 1 AS next_no FROM scene_registry')
      .get();
    const sceneNo = normalizeInteger(next && next.next_no, 1);
    this._db
      .prepare('INSERT INTO scene_registry(scene_id, scene_no, created_at, updated_at) VALUES(?, ?, ?, ?)')
      .run(sceneId, sceneNo, nowIso, nowIso);
    return sceneNo;
  }

  _ensureSpecRow(sceneId, specId, nowIso) {
    const existing = this._db
      .prepare('SELECT spec_no FROM spec_registry WHERE scene_id = ? AND spec_id = ?')
      .get(sceneId, specId);
    if (existing && Number.isFinite(existing.spec_no)) {
      this._db
        .prepare('UPDATE spec_registry SET updated_at = ? WHERE scene_id = ? AND spec_id = ?')
        .run(nowIso, sceneId, specId);
      return Number(existing.spec_no);
    }

    const next = this._db
      .prepare('SELECT COALESCE(MAX(spec_no), 0) + 1 AS next_no FROM spec_registry WHERE scene_id = ?')
      .get(sceneId);
    const specNo = normalizeInteger(next && next.next_no, 1);
    this._db
      .prepare('INSERT INTO spec_registry(scene_id, spec_id, spec_no, created_at, updated_at) VALUES(?, ?, ?, ?, ?)')
      .run(sceneId, specId, specNo, nowIso, nowIso);
    return specNo;
  }

  _mapTaskRefRow(row) {
    if (!row) {
      return null;
    }

    const sceneNo = normalizeInteger(row.scene_no, 0);
    const specNo = normalizeInteger(row.spec_no, 0);
    const taskNo = normalizeInteger(row.task_no, 0);

    return {
      task_ref: normalizeString(row.task_ref),
      scene_id: normalizeString(row.scene_id),
      spec_id: normalizeString(row.spec_id),
      task_key: normalizeString(row.task_key),
      scene_no: sceneNo,
      spec_no: specNo,
      task_no: taskNo,
      source: normalizeString(row.source) || 'unknown',
      metadata: parseJsonSafe(row.metadata_json, {}) || {}
    };
  }

  _mapAuthLeaseRow(row) {
    if (!row) {
      return null;
    }
    return {
      lease_id: normalizeString(row.lease_id),
      subject: normalizeString(row.subject),
      role: normalizeString(row.role),
      scope: normalizeStringArray(parseJsonSafe(row.scope_json, []), ['project:*']),
      reason: normalizeString(row.reason) || null,
      metadata: parseJsonSafe(row.metadata_json, {}) || {},
      issued_at: normalizeIsoTimestamp(row.issued_at) || null,
      expires_at: normalizeIsoTimestamp(row.expires_at) || null,
      revoked_at: normalizeIsoTimestamp(row.revoked_at) || null,
      created_at: normalizeIsoTimestamp(row.created_at) || null,
      updated_at: normalizeIsoTimestamp(row.updated_at) || null
    };
  }

  _mapAuthEventRow(row) {
    if (!row) {
      return null;
    }
    return {
      event_id: normalizeString(row.event_id),
      event_timestamp: normalizeIsoTimestamp(row.event_timestamp) || null,
      event_type: normalizeString(row.event_type),
      action: normalizeString(row.action) || null,
      actor: normalizeString(row.actor) || null,
      lease_id: normalizeString(row.lease_id) || null,
      result: normalizeString(row.result) || null,
      target: normalizeString(row.target) || null,
      detail: parseJsonSafe(row.detail_json, {}) || {},
      created_at: normalizeIsoTimestamp(row.created_at) || null
    };
  }

  async resolveOrCreateTaskRef(options = {}) {
    const sceneId = normalizeString(options.sceneId);
    const specId = normalizeString(options.specId);
    const taskKey = normalizeString(options.taskKey);
    if (!sceneId || !specId || !taskKey) {
      throw new Error('sceneId/specId/taskKey are required for sqlite task ref assignment');
    }

    const source = normalizeString(options.source) || 'unknown';
    const metadata = options.metadata && typeof options.metadata === 'object'
      ? options.metadata
      : {};

    if (this._useMemoryBackend()) {
      return this._resolveOrCreateTaskRefInMemory({
        sceneId,
        specId,
        taskKey,
        source,
        metadata
      });
    }

    if (!await this.ensureReady()) {
      return null;
    }

    const result = this._withTransaction(() => {
      const existing = this._db
        .prepare(`
          SELECT t.task_ref, t.scene_id, t.spec_id, t.task_key, t.task_no, t.source, t.metadata_json,
                 s.scene_no, p.spec_no
          FROM task_ref_registry t
          INNER JOIN scene_registry s ON s.scene_id = t.scene_id
          INNER JOIN spec_registry p ON p.scene_id = t.scene_id AND p.spec_id = t.spec_id
          WHERE t.scene_id = ? AND t.spec_id = ? AND t.task_key = ?
        `)
        .get(sceneId, specId, taskKey);

      if (existing) {
        const nowIso = this.now();
        const mergedMetadata = {
          ...(parseJsonSafe(existing.metadata_json, {}) || {}),
          ...metadata
        };
        this._db
          .prepare('UPDATE task_ref_registry SET source = ?, metadata_json = ?, updated_at = ? WHERE task_ref = ?')
          .run(source, JSON.stringify(mergedMetadata), nowIso, existing.task_ref);

        return this._db
          .prepare(`
            SELECT t.task_ref, t.scene_id, t.spec_id, t.task_key, t.task_no, t.source, t.metadata_json,
                   s.scene_no, p.spec_no
            FROM task_ref_registry t
            INNER JOIN scene_registry s ON s.scene_id = t.scene_id
            INNER JOIN spec_registry p ON p.scene_id = t.scene_id AND p.spec_id = t.spec_id
            WHERE t.task_ref = ?
          `)
          .get(existing.task_ref);
      }

      const nowIso = this.now();
      const sceneNo = this._ensureSceneRow(sceneId, nowIso);
      const specNo = this._ensureSpecRow(sceneId, specId, nowIso);

      const nextTask = this._db
        .prepare('SELECT COALESCE(MAX(task_no), 0) + 1 AS next_no FROM task_ref_registry WHERE scene_id = ? AND spec_id = ?')
        .get(sceneId, specId);
      const taskNo = normalizeInteger(nextTask && nextTask.next_no, 1);
      const taskRef = buildTaskRef(sceneNo, specNo, taskNo);

      this._db
        .prepare(`
          INSERT INTO task_ref_registry(task_ref, scene_id, spec_id, task_key, task_no, source, metadata_json, created_at, updated_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(taskRef, sceneId, specId, taskKey, taskNo, source, JSON.stringify(metadata), nowIso, nowIso);

      return this._db
        .prepare(`
          SELECT t.task_ref, t.scene_id, t.spec_id, t.task_key, t.task_no, t.source, t.metadata_json,
                 s.scene_no, p.spec_no
          FROM task_ref_registry t
          INNER JOIN scene_registry s ON s.scene_id = t.scene_id
          INNER JOIN spec_registry p ON p.scene_id = t.scene_id AND p.spec_id = t.spec_id
          WHERE t.task_ref = ?
        `)
        .get(taskRef);
    });

    return this._mapTaskRefRow(result);
  }

  async lookupTaskRef(taskRef) {
    const normalizedTaskRef = normalizeString(taskRef);
    if (!normalizedTaskRef) {
      return null;
    }

    if (this._useMemoryBackend()) {
      const row = this._memory.refs[normalizedTaskRef];
      return row ? { ...row, metadata: { ...(row.metadata || {}) } } : null;
    }

    if (!await this.ensureReady()) {
      return null;
    }

    const row = this._db
      .prepare(`
        SELECT t.task_ref, t.scene_id, t.spec_id, t.task_key, t.task_no, t.source, t.metadata_json,
               s.scene_no, p.spec_no
        FROM task_ref_registry t
        INNER JOIN scene_registry s ON s.scene_id = t.scene_id
        INNER JOIN spec_registry p ON p.scene_id = t.scene_id AND p.spec_id = t.spec_id
        WHERE t.task_ref = ?
      `)
      .get(normalizedTaskRef);

    return this._mapTaskRefRow(row);
  }

  async lookupTaskTuple(options = {}) {
    const sceneId = normalizeString(options.sceneId);
    const specId = normalizeString(options.specId);
    const taskKey = normalizeString(options.taskKey);
    if (!sceneId || !specId || !taskKey) {
      return null;
    }

    if (this._useMemoryBackend()) {
      const tupleKey = `${sceneId}::${specId}::${taskKey}`;
      const row = this._memory.tasks[tupleKey];
      return row ? { ...row, metadata: { ...(row.metadata || {}) } } : null;
    }

    if (!await this.ensureReady()) {
      return null;
    }

    const row = this._db
      .prepare(`
        SELECT t.task_ref, t.scene_id, t.spec_id, t.task_key, t.task_no, t.source, t.metadata_json,
               s.scene_no, p.spec_no
        FROM task_ref_registry t
        INNER JOIN scene_registry s ON s.scene_id = t.scene_id
        INNER JOIN spec_registry p ON p.scene_id = t.scene_id AND p.spec_id = t.spec_id
        WHERE t.scene_id = ? AND t.spec_id = ? AND t.task_key = ?
      `)
      .get(sceneId, specId, taskKey);

    return this._mapTaskRefRow(row);
  }

  async appendStudioEvent(event = {}) {
    const eventId = normalizeString(event.event_id);
    const jobId = normalizeString(event.job_id);
    const eventType = normalizeString(event.event_type);
    const timestamp = normalizeString(event.timestamp) || this.now();
    if (!eventId || !jobId || !eventType) {
      return false;
    }

    if (this._useMemoryBackend()) {
      if (!this._memory.events_by_job[jobId]) {
        this._memory.events_by_job[jobId] = [];
      }
      const existingIndex = this._memory.events_by_job[jobId]
        .findIndex((item) => normalizeString(item.event_id) === eventId);
      const normalized = {
        ...event,
        event_id: eventId,
        job_id: jobId,
        event_type: eventType,
        timestamp: timestamp
      };
      if (existingIndex >= 0) {
        this._memory.events_by_job[jobId][existingIndex] = normalized;
      } else {
        this._memory.events_by_job[jobId].push(normalized);
      }
      this._memory.events_by_job[jobId].sort((left, right) => {
        const l = Date.parse(left.timestamp || '') || 0;
        const r = Date.parse(right.timestamp || '') || 0;
        return l - r;
      });
      return true;
    }

    if (!await this.ensureReady()) {
      return false;
    }

    const sceneId = normalizeString(event.scene_id) || null;
    const specId = normalizeString(event.spec_id) || null;
    const rawJson = JSON.stringify(event);

    this._db
      .prepare(`
        INSERT OR REPLACE INTO studio_event_stream(event_id, job_id, event_type, event_timestamp, scene_id, spec_id, created_at, raw_json)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(eventId, jobId, eventType, timestamp, sceneId, specId, this.now(), rawJson);

    return true;
  }

  async listStudioEvents(jobId, options = {}) {
    const normalizedJobId = normalizeString(jobId);
    if (!normalizedJobId) {
      return [];
    }

    if (this._useMemoryBackend()) {
      const events = Array.isArray(this._memory.events_by_job[normalizedJobId])
        ? [...this._memory.events_by_job[normalizedJobId]]
        : [];
      const limit = normalizeInteger(options.limit, 50);
      if (limit <= 0) {
        return events;
      }
      return events.slice(-limit);
    }

    if (!await this.ensureReady()) {
      return null;
    }

    const limit = normalizeInteger(options.limit, 50);
    const query = limit > 0
      ? 'SELECT raw_json FROM studio_event_stream WHERE job_id = ? ORDER BY event_timestamp DESC LIMIT ?'
      : 'SELECT raw_json FROM studio_event_stream WHERE job_id = ? ORDER BY event_timestamp DESC';

    const statement = this._db.prepare(query);
    const rows = limit > 0
      ? statement.all(normalizedJobId, limit)
      : statement.all(normalizedJobId);

    const events = rows
      .map((row) => parseJsonSafe(row.raw_json, null))
      .filter(Boolean)
      .reverse();

    return events;
  }

  async issueAuthLease(options = {}) {
    const subject = normalizeString(options.subject) || 'unknown';
    const role = normalizeString(options.role) || 'maintainer';
    const scope = normalizeStringArray(options.scope, ['project:*']);
    const reason = normalizeString(options.reason) || null;
    const metadata = options.metadata && typeof options.metadata === 'object'
      ? options.metadata
      : {};
    const issuedAt = normalizeIsoTimestamp(options.issued_at || options.issuedAt, this.now()) || this.now();
    const ttlMinutes = normalizeInteger(options.ttl_minutes || options.ttlMinutes, 15);
    const fallbackExpiresAt = new Date(
      (Date.parse(issuedAt) || Date.now()) + (Math.max(ttlMinutes, 1) * 60 * 1000)
    ).toISOString();
    const expiresAt = normalizeIsoTimestamp(options.expires_at || options.expiresAt, fallbackExpiresAt) || fallbackExpiresAt;
    const leaseId = normalizeString(options.lease_id || options.leaseId)
      || `lease-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const nowIso = this.now();

    if (this._useMemoryBackend()) {
      return this._issueAuthLeaseInMemory({
        leaseId,
        subject,
        role,
        scope,
        reason,
        metadata,
        issuedAt,
        expiresAt,
        nowIso
      });
    }

    if (!await this.ensureReady()) {
      return null;
    }

    this._db
      .prepare(`
        INSERT OR REPLACE INTO auth_lease_registry(
          lease_id, subject, role, scope_json, reason, metadata_json, issued_at, expires_at, revoked_at, created_at, updated_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `)
      .run(
        leaseId,
        subject,
        role,
        JSON.stringify(scope),
        reason,
        JSON.stringify(metadata),
        issuedAt,
        expiresAt,
        nowIso,
        nowIso
      );

    return this.getAuthLease(leaseId);
  }

  async getAuthLease(leaseId) {
    const normalizedLeaseId = normalizeString(leaseId);
    if (!normalizedLeaseId) {
      return null;
    }

    if (this._useMemoryBackend()) {
      const row = this._memory.auth_leases[normalizedLeaseId];
      return row
        ? {
          ...row,
          scope: normalizeStringArray(row.scope, ['project:*']),
          metadata: { ...(row.metadata || {}) }
        }
        : null;
    }

    if (!await this.ensureReady()) {
      return null;
    }

    const row = this._db
      .prepare(`
        SELECT lease_id, subject, role, scope_json, reason, metadata_json, issued_at, expires_at, revoked_at, created_at, updated_at
        FROM auth_lease_registry
        WHERE lease_id = ?
      `)
      .get(normalizedLeaseId);
    return this._mapAuthLeaseRow(row);
  }

  async listAuthLeases(options = {}) {
    const activeOnly = options.activeOnly !== false;
    const limit = normalizeInteger(options.limit, 20);
    const nowIso = this.now();

    if (this._useMemoryBackend()) {
      let rows = Object.values(this._memory.auth_leases || {}).map((item) => ({
        ...item,
        scope: normalizeStringArray(item.scope, ['project:*']),
        metadata: { ...(item.metadata || {}) }
      }));
      if (activeOnly) {
        const nowTime = Date.parse(nowIso) || Date.now();
        rows = rows.filter((item) => {
          const revokedAt = normalizeString(item.revoked_at);
          if (revokedAt) {
            return false;
          }
          const expiresAt = Date.parse(item.expires_at || '') || 0;
          return expiresAt > nowTime;
        });
      }
      rows.sort((left, right) => (Date.parse(right.created_at || '') || 0) - (Date.parse(left.created_at || '') || 0));
      return limit > 0 ? rows.slice(0, limit) : rows;
    }

    if (!await this.ensureReady()) {
      return null;
    }

    const query = activeOnly
      ? `
        SELECT lease_id, subject, role, scope_json, reason, metadata_json, issued_at, expires_at, revoked_at, created_at, updated_at
        FROM auth_lease_registry
        WHERE revoked_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC
        LIMIT ?
      `
      : `
        SELECT lease_id, subject, role, scope_json, reason, metadata_json, issued_at, expires_at, revoked_at, created_at, updated_at
        FROM auth_lease_registry
        ORDER BY created_at DESC
        LIMIT ?
      `;

    const statement = this._db.prepare(query);
    const rows = activeOnly
      ? statement.all(nowIso, limit)
      : statement.all(limit);
    return rows
      .map((row) => this._mapAuthLeaseRow(row))
      .filter(Boolean);
  }

  async revokeAuthLease(leaseId, options = {}) {
    const normalizedLeaseId = normalizeString(leaseId);
    if (!normalizedLeaseId) {
      return null;
    }
    const revokedAt = normalizeIsoTimestamp(options.revoked_at || options.revokedAt, this.now()) || this.now();

    if (this._useMemoryBackend()) {
      const existing = this._memory.auth_leases[normalizedLeaseId];
      if (!existing) {
        return null;
      }
      existing.revoked_at = revokedAt;
      existing.updated_at = revokedAt;
      this._memory.auth_leases[normalizedLeaseId] = existing;
      return {
        ...existing,
        scope: normalizeStringArray(existing.scope, ['project:*']),
        metadata: { ...(existing.metadata || {}) }
      };
    }

    if (!await this.ensureReady()) {
      return null;
    }

    this._db
      .prepare('UPDATE auth_lease_registry SET revoked_at = ?, updated_at = ? WHERE lease_id = ?')
      .run(revokedAt, revokedAt, normalizedLeaseId);
    return this.getAuthLease(normalizedLeaseId);
  }

  async appendAuthEvent(event = {}) {
    const eventType = normalizeString(event.event_type || event.eventType);
    if (!eventType) {
      return false;
    }
    const eventId = normalizeString(event.event_id || event.eventId)
      || `auth-evt-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const timestamp = normalizeIsoTimestamp(event.event_timestamp || event.timestamp, this.now()) || this.now();
    const normalizedEvent = {
      event_id: eventId,
      event_timestamp: timestamp,
      event_type: eventType,
      action: normalizeString(event.action) || null,
      actor: normalizeString(event.actor) || null,
      lease_id: normalizeString(event.lease_id || event.leaseId) || null,
      result: normalizeString(event.result) || null,
      target: normalizeString(event.target) || null,
      detail: event.detail && typeof event.detail === 'object'
        ? event.detail
        : {}
    };

    if (this._useMemoryBackend()) {
      const existingIndex = this._memory.auth_events
        .findIndex((item) => normalizeString(item.event_id) === eventId);
      const row = {
        ...normalizedEvent,
        created_at: this.now()
      };
      if (existingIndex >= 0) {
        this._memory.auth_events[existingIndex] = row;
      } else {
        this._memory.auth_events.push(row);
      }
      this._memory.auth_events.sort((left, right) => {
        const l = Date.parse(left.event_timestamp || '') || 0;
        const r = Date.parse(right.event_timestamp || '') || 0;
        return l - r;
      });
      return true;
    }

    if (!await this.ensureReady()) {
      return false;
    }

    this._db
      .prepare(`
        INSERT OR REPLACE INTO auth_event_stream(
          event_id, event_timestamp, event_type, action, actor, lease_id, result, target, detail_json, created_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        normalizedEvent.event_id,
        normalizedEvent.event_timestamp,
        normalizedEvent.event_type,
        normalizedEvent.action,
        normalizedEvent.actor,
        normalizedEvent.lease_id,
        normalizedEvent.result,
        normalizedEvent.target,
        JSON.stringify(normalizedEvent.detail || {}),
        this.now()
      );
    return true;
  }

  async listAuthEvents(options = {}) {
    const limit = normalizeInteger(options.limit, 50);

    if (this._useMemoryBackend()) {
      const rows = [...this._memory.auth_events]
        .sort((left, right) => (Date.parse(right.event_timestamp || '') || 0) - (Date.parse(left.event_timestamp || '') || 0))
        .map((row) => ({
          ...row,
          detail: row.detail && typeof row.detail === 'object' ? row.detail : {}
        }));
      return limit > 0 ? rows.slice(0, limit) : rows;
    }

    if (!await this.ensureReady()) {
      return null;
    }

    const query = limit > 0
      ? `
        SELECT event_id, event_timestamp, event_type, action, actor, lease_id, result, target, detail_json, created_at
        FROM auth_event_stream
        ORDER BY event_timestamp DESC
        LIMIT ?
      `
      : `
        SELECT event_id, event_timestamp, event_type, action, actor, lease_id, result, target, detail_json, created_at
        FROM auth_event_stream
        ORDER BY event_timestamp DESC
      `;

    const statement = this._db.prepare(query);
    const rows = limit > 0 ? statement.all(limit) : statement.all();
    return rows
      .map((row) => this._mapAuthEventRow(row))
      .filter(Boolean);
  }

  _resolveOrCreateTaskRefInMemory(options = {}) {
    const sceneId = normalizeString(options.sceneId);
    const specId = normalizeString(options.specId);
    const taskKey = normalizeString(options.taskKey);
    const source = normalizeString(options.source) || 'unknown';
    const metadata = options.metadata && typeof options.metadata === 'object'
      ? options.metadata
      : {};
    const nowIso = this.now();

    if (!this._memory.scenes[sceneId]) {
      this._memory.scenes[sceneId] = normalizeInteger(this._memory.sequences.scene_next, 1);
      this._memory.sequences.scene_next = this._memory.scenes[sceneId] + 1;
    }
    const sceneNo = this._memory.scenes[sceneId];

    const sceneSpecKey = `${sceneId}::${specId}`;
    if (!this._memory.specs[sceneSpecKey]) {
      const nextSpec = normalizeInteger(this._memory.sequences.spec_next_by_scene[sceneId], 1);
      this._memory.specs[sceneSpecKey] = nextSpec;
      this._memory.sequences.spec_next_by_scene[sceneId] = nextSpec + 1;
    }
    const specNo = this._memory.specs[sceneSpecKey];

    const tupleKey = `${sceneId}::${specId}::${taskKey}`;
    if (this._memory.tasks[tupleKey]) {
      const existing = this._memory.tasks[tupleKey];
      existing.source = source;
      existing.metadata = { ...(existing.metadata || {}), ...metadata };
      existing.updated_at = nowIso;
      this._memory.refs[existing.task_ref] = existing;
      return { ...existing, metadata: { ...(existing.metadata || {}) } };
    }

    const nextTask = normalizeInteger(this._memory.sequences.task_next_by_scene_spec[sceneSpecKey], 1);
    const taskNo = nextTask;
    this._memory.sequences.task_next_by_scene_spec[sceneSpecKey] = nextTask + 1;
    const taskRef = buildTaskRef(sceneNo, specNo, taskNo);

    const row = {
      task_ref: taskRef,
      scene_id: sceneId,
      spec_id: specId,
      task_key: taskKey,
      scene_no: sceneNo,
      spec_no: specNo,
      task_no: taskNo,
      source,
      metadata: { ...metadata },
      created_at: nowIso,
      updated_at: nowIso
    };
    this._memory.tasks[tupleKey] = row;
    this._memory.refs[taskRef] = row;
    return { ...row, metadata: { ...(row.metadata || {}) } };
  }

  _issueAuthLeaseInMemory(options = {}) {
    const leaseId = normalizeString(options.leaseId)
      || `lease-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const row = {
      lease_id: leaseId,
      subject: normalizeString(options.subject) || 'unknown',
      role: normalizeString(options.role) || 'maintainer',
      scope: normalizeStringArray(options.scope, ['project:*']),
      reason: normalizeString(options.reason) || null,
      metadata: options.metadata && typeof options.metadata === 'object' ? { ...options.metadata } : {},
      issued_at: normalizeIsoTimestamp(options.issuedAt, this.now()) || this.now(),
      expires_at: normalizeIsoTimestamp(options.expiresAt, this.now()) || this.now(),
      revoked_at: null,
      created_at: normalizeIsoTimestamp(options.nowIso, this.now()) || this.now(),
      updated_at: normalizeIsoTimestamp(options.nowIso, this.now()) || this.now()
    };
    this._memory.auth_leases[leaseId] = row;
    return {
      ...row,
      scope: normalizeStringArray(row.scope, ['project:*']),
      metadata: { ...(row.metadata || {}) }
    };
  }
}

const STORE_CACHE = new Map();

function getSceStateStore(projectPath = process.cwd(), options = {}) {
  const normalizedRoot = path.resolve(projectPath);
  if (options.noCache === true) {
    return new SceStateStore(normalizedRoot, options);
  }

  if (!STORE_CACHE.has(normalizedRoot)) {
    STORE_CACHE.set(normalizedRoot, new SceStateStore(normalizedRoot, options));
  }

  return STORE_CACHE.get(normalizedRoot);
}

module.exports = {
  DEFAULT_BACKEND,
  DEFAULT_DB_RELATIVE_PATH,
  SceStateStore,
  getSceStateStore,
  resolveBackend,
  buildTaskRef,
  formatSegment
};
