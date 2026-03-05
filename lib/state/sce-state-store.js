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

function normalizeBooleanValue(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = normalizeString(`${value || ''}`).toLowerCase();
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

function normalizeNonNegativeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(`${value}`, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
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
      timeline_snapshots: {},
      scene_session_cycles: {},
      agent_runtime: {},
      errorbook_entry_index: {},
      errorbook_incident_index: {},
      governance_spec_scene_override: {},
      governance_scene_index: {},
      migration_records: {},
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

      CREATE TABLE IF NOT EXISTS timeline_snapshot_registry (
        snapshot_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        trigger TEXT,
        event TEXT,
        summary TEXT,
        scene_id TEXT,
        session_id TEXT,
        command TEXT,
        file_count INTEGER,
        total_bytes INTEGER,
        snapshot_path TEXT,
        git_json TEXT,
        source TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_timeline_snapshot_registry_created
        ON timeline_snapshot_registry(created_at DESC);

      CREATE TABLE IF NOT EXISTS scene_session_cycle_registry (
        scene_id TEXT NOT NULL,
        cycle INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT,
        started_at TEXT,
        completed_at TEXT,
        source TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scene_id, cycle)
      );

      CREATE INDEX IF NOT EXISTS idx_scene_session_cycle_registry_session
        ON scene_session_cycle_registry(session_id);

      CREATE TABLE IF NOT EXISTS agent_runtime_registry (
        agent_id TEXT PRIMARY KEY,
        machine_id TEXT,
        instance_index INTEGER,
        hostname TEXT,
        registered_at TEXT,
        last_heartbeat TEXT,
        status TEXT,
        current_task_json TEXT,
        source TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_runtime_registry_status
        ON agent_runtime_registry(status);

      CREATE TABLE IF NOT EXISTS state_migration_registry (
        migration_id TEXT PRIMARY KEY,
        component_id TEXT NOT NULL,
        source_path TEXT,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        metrics_json TEXT,
        detail_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_state_migration_registry_component_started
        ON state_migration_registry(component_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS errorbook_entry_index_registry (
        entry_id TEXT PRIMARY KEY,
        fingerprint TEXT,
        title TEXT,
        status TEXT,
        quality_score INTEGER,
        tags_json TEXT,
        ontology_tags_json TEXT,
        temporary_mitigation_active INTEGER,
        temporary_mitigation_deadline_at TEXT,
        occurrences INTEGER,
        created_at TEXT,
        updated_at TEXT,
        source TEXT,
        indexed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_errorbook_entry_index_registry_status_updated
        ON errorbook_entry_index_registry(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS errorbook_incident_index_registry (
        incident_id TEXT PRIMARY KEY,
        fingerprint TEXT,
        title TEXT,
        symptom TEXT,
        state TEXT,
        attempt_count INTEGER,
        created_at TEXT,
        updated_at TEXT,
        last_attempt_at TEXT,
        resolved_at TEXT,
        linked_entry_id TEXT,
        source TEXT,
        indexed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_errorbook_incident_index_registry_state_updated
        ON errorbook_incident_index_registry(state, updated_at DESC);

      CREATE TABLE IF NOT EXISTS governance_spec_scene_override_registry (
        spec_id TEXT PRIMARY KEY,
        scene_id TEXT NOT NULL,
        source TEXT,
        rule_id TEXT,
        updated_at TEXT,
        indexed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_governance_spec_scene_override_registry_scene
        ON governance_spec_scene_override_registry(scene_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS governance_scene_index_registry (
        scene_id TEXT PRIMARY KEY,
        total_specs INTEGER,
        active_specs INTEGER,
        completed_specs INTEGER,
        stale_specs INTEGER,
        spec_ids_json TEXT,
        active_spec_ids_json TEXT,
        stale_spec_ids_json TEXT,
        generated_at TEXT,
        scene_filter TEXT,
        source TEXT,
        indexed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_governance_scene_index_registry_counts
        ON governance_scene_index_registry(total_specs DESC, active_specs DESC);
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

  _mapTimelineSnapshotRow(row) {
    if (!row) {
      return null;
    }
    return {
      snapshot_id: normalizeString(row.snapshot_id),
      created_at: normalizeIsoTimestamp(row.created_at) || null,
      trigger: normalizeString(row.trigger) || null,
      event: normalizeString(row.event) || null,
      summary: normalizeString(row.summary) || null,
      scene_id: normalizeString(row.scene_id) || null,
      session_id: normalizeString(row.session_id) || null,
      command: normalizeString(row.command) || null,
      file_count: normalizeNonNegativeInteger(row.file_count, 0),
      total_bytes: normalizeNonNegativeInteger(row.total_bytes, 0),
      snapshot_path: normalizeString(row.snapshot_path) || null,
      git: parseJsonSafe(row.git_json, {}) || {},
      source: normalizeString(row.source) || null,
      updated_at: normalizeIsoTimestamp(row.updated_at) || null
    };
  }

  _mapSceneSessionCycleRow(row) {
    if (!row) {
      return null;
    }
    return {
      scene_id: normalizeString(row.scene_id),
      cycle: normalizeNonNegativeInteger(row.cycle, 0),
      session_id: normalizeString(row.session_id),
      status: normalizeString(row.status) || null,
      started_at: normalizeIsoTimestamp(row.started_at) || null,
      completed_at: normalizeIsoTimestamp(row.completed_at) || null,
      source: normalizeString(row.source) || null,
      updated_at: normalizeIsoTimestamp(row.updated_at) || null
    };
  }

  _mapAgentRuntimeRow(row) {
    if (!row) {
      return null;
    }
    return {
      agent_id: normalizeString(row.agent_id),
      machine_id: normalizeString(row.machine_id) || null,
      instance_index: normalizeNonNegativeInteger(row.instance_index, 0),
      hostname: normalizeString(row.hostname) || null,
      registered_at: normalizeIsoTimestamp(row.registered_at) || null,
      last_heartbeat: normalizeIsoTimestamp(row.last_heartbeat) || null,
      status: normalizeString(row.status) || null,
      current_task: parseJsonSafe(row.current_task_json, null),
      source: normalizeString(row.source) || null,
      updated_at: normalizeIsoTimestamp(row.updated_at) || null
    };
  }

  _mapStateMigrationRow(row) {
    if (!row) {
      return null;
    }
    return {
      migration_id: normalizeString(row.migration_id),
      component_id: normalizeString(row.component_id),
      source_path: normalizeString(row.source_path) || null,
      mode: normalizeString(row.mode) || null,
      status: normalizeString(row.status) || null,
      metrics: parseJsonSafe(row.metrics_json, {}) || {},
      detail: parseJsonSafe(row.detail_json, {}) || {},
      started_at: normalizeIsoTimestamp(row.started_at) || null,
      completed_at: normalizeIsoTimestamp(row.completed_at) || null,
      updated_at: normalizeIsoTimestamp(row.updated_at) || null
    };
  }

  _mapErrorbookEntryIndexRow(row) {
    if (!row) {
      return null;
    }
    return {
      entry_id: normalizeString(row.entry_id),
      fingerprint: normalizeString(row.fingerprint) || null,
      title: normalizeString(row.title) || null,
      status: normalizeString(row.status) || null,
      quality_score: normalizeNonNegativeInteger(row.quality_score, 0),
      tags: normalizeStringArray(parseJsonSafe(row.tags_json, []), []),
      ontology_tags: normalizeStringArray(parseJsonSafe(row.ontology_tags_json, []), []),
      temporary_mitigation_active: Number(row.temporary_mitigation_active) === 1,
      temporary_mitigation_deadline_at: normalizeIsoTimestamp(row.temporary_mitigation_deadline_at, '') || null,
      occurrences: normalizeNonNegativeInteger(row.occurrences, 0),
      created_at: normalizeIsoTimestamp(row.created_at, '') || null,
      updated_at: normalizeIsoTimestamp(row.updated_at, '') || null,
      source: normalizeString(row.source) || null,
      indexed_at: normalizeIsoTimestamp(row.indexed_at, '') || null
    };
  }

  _mapErrorbookIncidentIndexRow(row) {
    if (!row) {
      return null;
    }
    return {
      incident_id: normalizeString(row.incident_id),
      fingerprint: normalizeString(row.fingerprint) || null,
      title: normalizeString(row.title) || null,
      symptom: normalizeString(row.symptom) || null,
      state: normalizeString(row.state) || null,
      attempt_count: normalizeNonNegativeInteger(row.attempt_count, 0),
      created_at: normalizeIsoTimestamp(row.created_at, '') || null,
      updated_at: normalizeIsoTimestamp(row.updated_at, '') || null,
      last_attempt_at: normalizeIsoTimestamp(row.last_attempt_at, '') || null,
      resolved_at: normalizeIsoTimestamp(row.resolved_at, '') || null,
      linked_entry_id: normalizeString(row.linked_entry_id) || null,
      source: normalizeString(row.source) || null,
      indexed_at: normalizeIsoTimestamp(row.indexed_at, '') || null
    };
  }

  _mapGovernanceSpecSceneOverrideRow(row) {
    if (!row) {
      return null;
    }
    return {
      spec_id: normalizeString(row.spec_id),
      scene_id: normalizeString(row.scene_id),
      source: normalizeString(row.source) || null,
      rule_id: normalizeString(row.rule_id) || null,
      updated_at: normalizeIsoTimestamp(row.updated_at, '') || null,
      indexed_at: normalizeIsoTimestamp(row.indexed_at, '') || null
    };
  }

  _mapGovernanceSceneIndexRow(row) {
    if (!row) {
      return null;
    }
    return {
      scene_id: normalizeString(row.scene_id),
      total_specs: normalizeNonNegativeInteger(row.total_specs, 0),
      active_specs: normalizeNonNegativeInteger(row.active_specs, 0),
      completed_specs: normalizeNonNegativeInteger(row.completed_specs, 0),
      stale_specs: normalizeNonNegativeInteger(row.stale_specs, 0),
      spec_ids: normalizeStringArray(parseJsonSafe(row.spec_ids_json, []), []),
      active_spec_ids: normalizeStringArray(parseJsonSafe(row.active_spec_ids_json, []), []),
      stale_spec_ids: normalizeStringArray(parseJsonSafe(row.stale_spec_ids_json, []), []),
      generated_at: normalizeIsoTimestamp(row.generated_at, '') || null,
      scene_filter: normalizeString(row.scene_filter) || null,
      source: normalizeString(row.source) || null,
      indexed_at: normalizeIsoTimestamp(row.indexed_at, '') || null
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

  async upsertTimelineSnapshotIndex(records = [], options = {}) {
    const source = normalizeString(options.source) || 'file.timeline.index';
    const nowIso = this.now();
    const normalizedRecords = Array.isArray(records)
      ? records.map((item) => ({
        snapshot_id: normalizeString(item && item.snapshot_id),
        created_at: normalizeIsoTimestamp(item && item.created_at, nowIso) || nowIso,
        trigger: normalizeString(item && item.trigger) || null,
        event: normalizeString(item && item.event) || null,
        summary: normalizeString(item && item.summary) || null,
        scene_id: normalizeString(item && item.scene_id) || null,
        session_id: normalizeString(item && item.session_id) || null,
        command: normalizeString(item && item.command) || null,
        file_count: normalizeNonNegativeInteger(item && item.file_count, 0),
        total_bytes: normalizeNonNegativeInteger(item && item.total_bytes, 0),
        snapshot_path: normalizeString(item && (item.snapshot_path || item.path)) || null,
        git: item && item.git && typeof item.git === 'object' ? item.git : {},
        source,
        updated_at: nowIso
      }))
        .filter((item) => item.snapshot_id)
      : [];

    if (this._useMemoryBackend()) {
      for (const item of normalizedRecords) {
        this._memory.timeline_snapshots[item.snapshot_id] = { ...item };
      }
      return {
        success: true,
        written: normalizedRecords.length,
        total: Object.keys(this._memory.timeline_snapshots || {}).length
      };
    }

    if (!await this.ensureReady()) {
      return null;
    }

    const statement = this._db.prepare(`
      INSERT OR REPLACE INTO timeline_snapshot_registry(
        snapshot_id, created_at, trigger, event, summary, scene_id, session_id, command,
        file_count, total_bytes, snapshot_path, git_json, source, updated_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._withTransaction(() => {
      for (const item of normalizedRecords) {
        statement.run(
          item.snapshot_id,
          item.created_at,
          item.trigger,
          item.event,
          item.summary,
          item.scene_id,
          item.session_id,
          item.command,
          item.file_count,
          item.total_bytes,
          item.snapshot_path,
          JSON.stringify(item.git || {}),
          item.source,
          item.updated_at
        );
      }
    });

    const totalRow = this._db
      .prepare('SELECT COUNT(*) AS total FROM timeline_snapshot_registry')
      .get();

    return {
      success: true,
      written: normalizedRecords.length,
      total: normalizeNonNegativeInteger(totalRow && totalRow.total, 0)
    };
  }

  async listTimelineSnapshotIndex(options = {}) {
    const limit = normalizeInteger(options.limit, 100);
    const triggerFilter = normalizeString(options.trigger);
    const snapshotIdFilter = normalizeString(options.snapshotId);

    if (this._useMemoryBackend()) {
      let rows = Object.values(this._memory.timeline_snapshots || {}).map((item) => ({ ...item }));
      if (triggerFilter) {
        rows = rows.filter((item) => normalizeString(item.trigger) === triggerFilter);
      }
      if (snapshotIdFilter) {
        rows = rows.filter((item) => normalizeString(item.snapshot_id) === snapshotIdFilter);
      }
      rows.sort((left, right) => (Date.parse(right.created_at || '') || 0) - (Date.parse(left.created_at || '') || 0));
      if (limit > 0) {
        rows = rows.slice(0, limit);
      }
      return rows.map((row) => this._mapTimelineSnapshotRow({
        ...row,
        git_json: JSON.stringify(row.git || {})
      }));
    }

    if (!await this.ensureReady()) {
      return null;
    }

    let query = `
      SELECT snapshot_id, created_at, trigger, event, summary, scene_id, session_id, command,
             file_count, total_bytes, snapshot_path, git_json, source, updated_at
      FROM timeline_snapshot_registry
    `;
    const clauses = [];
    const params = [];
    if (triggerFilter) {
      clauses.push('trigger = ?');
      params.push(triggerFilter);
    }
    if (snapshotIdFilter) {
      clauses.push('snapshot_id = ?');
      params.push(snapshotIdFilter);
    }
    if (clauses.length > 0) {
      query += ` WHERE ${clauses.join(' AND ')}`;
    }
    query += ' ORDER BY created_at DESC';
    if (limit > 0) {
      query += ' LIMIT ?';
      params.push(limit);
    }

    const rows = this._db.prepare(query).all(...params);
    return rows
      .map((row) => this._mapTimelineSnapshotRow(row))
      .filter(Boolean);
  }

  async upsertSceneSessionCycles(records = [], options = {}) {
    const source = normalizeString(options.source) || 'file.session.scene-index';
    const nowIso = this.now();
    const normalizedRecords = Array.isArray(records)
      ? records.map((item) => ({
        scene_id: normalizeString(item && item.scene_id),
        cycle: normalizeNonNegativeInteger(item && item.cycle, 0),
        session_id: normalizeString(item && item.session_id),
        status: normalizeString(item && item.status) || null,
        started_at: normalizeIsoTimestamp(item && item.started_at, nowIso) || nowIso,
        completed_at: normalizeIsoTimestamp(item && item.completed_at, '') || null,
        source,
        updated_at: nowIso
      }))
        .filter((item) => item.scene_id && item.cycle > 0 && item.session_id)
      : [];

    if (this._useMemoryBackend()) {
      for (const item of normalizedRecords) {
        const key = `${item.scene_id}::${item.cycle}`;
        this._memory.scene_session_cycles[key] = { ...item };
      }
      return {
        success: true,
        written: normalizedRecords.length,
        total: Object.keys(this._memory.scene_session_cycles || {}).length
      };
    }

    if (!await this.ensureReady()) {
      return null;
    }

    const statement = this._db.prepare(`
      INSERT OR REPLACE INTO scene_session_cycle_registry(
        scene_id, cycle, session_id, status, started_at, completed_at, source, updated_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._withTransaction(() => {
      for (const item of normalizedRecords) {
        statement.run(
          item.scene_id,
          item.cycle,
          item.session_id,
          item.status,
          item.started_at,
          item.completed_at,
          item.source,
          item.updated_at
        );
      }
    });

    const totalRow = this._db
      .prepare('SELECT COUNT(*) AS total FROM scene_session_cycle_registry')
      .get();

    return {
      success: true,
      written: normalizedRecords.length,
      total: normalizeNonNegativeInteger(totalRow && totalRow.total, 0)
    };
  }

  async listSceneSessionCycles(options = {}) {
    const limit = normalizeInteger(options.limit, 100);
    const sceneId = normalizeString(options.sceneId);

    if (this._useMemoryBackend()) {
      let rows = Object.values(this._memory.scene_session_cycles || {}).map((item) => ({ ...item }));
      if (sceneId) {
        rows = rows.filter((item) => normalizeString(item.scene_id) === sceneId);
      }
      rows.sort((left, right) => {
        const sceneCompare = `${left.scene_id}`.localeCompare(`${right.scene_id}`);
        if (sceneCompare !== 0) {
          return sceneCompare;
        }
        return right.cycle - left.cycle;
      });
      if (limit > 0) {
        rows = rows.slice(0, limit);
      }
      return rows.map((row) => this._mapSceneSessionCycleRow(row));
    }

    if (!await this.ensureReady()) {
      return null;
    }

    let query = `
      SELECT scene_id, cycle, session_id, status, started_at, completed_at, source, updated_at
      FROM scene_session_cycle_registry
    `;
    const params = [];
    if (sceneId) {
      query += ' WHERE scene_id = ?';
      params.push(sceneId);
    }
    query += ' ORDER BY scene_id ASC, cycle DESC';
    if (limit > 0) {
      query += ' LIMIT ?';
      params.push(limit);
    }

    const rows = this._db.prepare(query).all(...params);
    return rows
      .map((row) => this._mapSceneSessionCycleRow(row))
      .filter(Boolean);
  }

  async upsertAgentRuntimeRecords(records = [], options = {}) {
    const source = normalizeString(options.source) || 'file.agent-registry';
    const nowIso = this.now();
    const normalizedRecords = Array.isArray(records)
      ? records.map((item) => ({
        agent_id: normalizeString(item && item.agent_id),
        machine_id: normalizeString(item && item.machine_id) || null,
        instance_index: normalizeNonNegativeInteger(item && item.instance_index, 0),
        hostname: normalizeString(item && item.hostname) || null,
        registered_at: normalizeIsoTimestamp(item && item.registered_at, nowIso) || nowIso,
        last_heartbeat: normalizeIsoTimestamp(item && item.last_heartbeat, nowIso) || nowIso,
        status: normalizeString(item && item.status) || null,
        current_task: item && item.current_task && typeof item.current_task === 'object'
          ? item.current_task
          : null,
        source,
        updated_at: nowIso
      }))
        .filter((item) => item.agent_id)
      : [];

    if (this._useMemoryBackend()) {
      for (const item of normalizedRecords) {
        this._memory.agent_runtime[item.agent_id] = { ...item };
      }
      return {
        success: true,
        written: normalizedRecords.length,
        total: Object.keys(this._memory.agent_runtime || {}).length
      };
    }

    if (!await this.ensureReady()) {
      return null;
    }

    const statement = this._db.prepare(`
      INSERT OR REPLACE INTO agent_runtime_registry(
        agent_id, machine_id, instance_index, hostname, registered_at, last_heartbeat, status, current_task_json, source, updated_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._withTransaction(() => {
      for (const item of normalizedRecords) {
        statement.run(
          item.agent_id,
          item.machine_id,
          item.instance_index,
          item.hostname,
          item.registered_at,
          item.last_heartbeat,
          item.status,
          JSON.stringify(item.current_task),
          item.source,
          item.updated_at
        );
      }
    });

    const totalRow = this._db
      .prepare('SELECT COUNT(*) AS total FROM agent_runtime_registry')
      .get();

    return {
      success: true,
      written: normalizedRecords.length,
      total: normalizeNonNegativeInteger(totalRow && totalRow.total, 0)
    };
  }

  async listAgentRuntimeRecords(options = {}) {
    const limit = normalizeInteger(options.limit, 100);
    const status = normalizeString(options.status);

    if (this._useMemoryBackend()) {
      let rows = Object.values(this._memory.agent_runtime || {}).map((item) => ({ ...item }));
      if (status) {
        rows = rows.filter((item) => normalizeString(item.status) === status);
      }
      rows.sort((left, right) => (Date.parse(right.last_heartbeat || '') || 0) - (Date.parse(left.last_heartbeat || '') || 0));
      if (limit > 0) {
        rows = rows.slice(0, limit);
      }
      return rows.map((row) => this._mapAgentRuntimeRow({
        ...row,
        current_task_json: JSON.stringify(row.current_task || null)
      }));
    }

    if (!await this.ensureReady()) {
      return null;
    }

    let query = `
      SELECT agent_id, machine_id, instance_index, hostname, registered_at, last_heartbeat, status, current_task_json, source, updated_at
      FROM agent_runtime_registry
    `;
    const params = [];
    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }
    query += ' ORDER BY last_heartbeat DESC';
    if (limit > 0) {
      query += ' LIMIT ?';
      params.push(limit);
    }

    const rows = this._db.prepare(query).all(...params);
    return rows
      .map((row) => this._mapAgentRuntimeRow(row))
      .filter(Boolean);
  }

  async appendStateMigrationRecord(record = {}) {
    const componentId = normalizeString(record.component_id || record.componentId);
    if (!componentId) {
      return null;
    }
    const migrationId = normalizeString(record.migration_id || record.migrationId)
      || `migration-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const startedAt = normalizeIsoTimestamp(record.started_at || record.startedAt, this.now()) || this.now();
    const completedAt = normalizeIsoTimestamp(record.completed_at || record.completedAt, '') || null;
    const nowIso = this.now();
    const normalized = {
      migration_id: migrationId,
      component_id: componentId,
      source_path: normalizeString(record.source_path || record.sourcePath) || null,
      mode: normalizeString(record.mode) || 'unknown',
      status: normalizeString(record.status) || 'completed',
      metrics: record.metrics && typeof record.metrics === 'object' ? record.metrics : {},
      detail: record.detail && typeof record.detail === 'object' ? record.detail : {},
      started_at: startedAt,
      completed_at: completedAt,
      updated_at: nowIso
    };

    if (this._useMemoryBackend()) {
      this._memory.migration_records[normalized.migration_id] = { ...normalized };
      return { ...normalized };
    }

    if (!await this.ensureReady()) {
      return null;
    }

    this._db
      .prepare(`
        INSERT OR REPLACE INTO state_migration_registry(
          migration_id, component_id, source_path, mode, status, metrics_json, detail_json, started_at, completed_at, updated_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        normalized.migration_id,
        normalized.component_id,
        normalized.source_path,
        normalized.mode,
        normalized.status,
        JSON.stringify(normalized.metrics || {}),
        JSON.stringify(normalized.detail || {}),
        normalized.started_at,
        normalized.completed_at,
        normalized.updated_at
      );

    return this.listStateMigrations({ migrationId: normalized.migration_id, limit: 1 })
      .then((rows) => (Array.isArray(rows) && rows.length > 0 ? rows[0] : null));
  }

  async listStateMigrations(options = {}) {
    const limit = normalizeInteger(options.limit, 50);
    const componentId = normalizeString(options.componentId);
    const migrationId = normalizeString(options.migrationId);

    if (this._useMemoryBackend()) {
      let rows = Object.values(this._memory.migration_records || {}).map((item) => ({ ...item }));
      if (componentId) {
        rows = rows.filter((item) => normalizeString(item.component_id) === componentId);
      }
      if (migrationId) {
        rows = rows.filter((item) => normalizeString(item.migration_id) === migrationId);
      }
      rows.sort((left, right) => (Date.parse(right.started_at || '') || 0) - (Date.parse(left.started_at || '') || 0));
      if (limit > 0) {
        rows = rows.slice(0, limit);
      }
      return rows.map((row) => this._mapStateMigrationRow({
        ...row,
        metrics_json: JSON.stringify(row.metrics || {}),
        detail_json: JSON.stringify(row.detail || {})
      }));
    }

    if (!await this.ensureReady()) {
      return null;
    }

    let query = `
      SELECT migration_id, component_id, source_path, mode, status, metrics_json, detail_json, started_at, completed_at, updated_at
      FROM state_migration_registry
    `;
    const clauses = [];
    const params = [];
    if (componentId) {
      clauses.push('component_id = ?');
      params.push(componentId);
    }
    if (migrationId) {
      clauses.push('migration_id = ?');
      params.push(migrationId);
    }
    if (clauses.length > 0) {
      query += ` WHERE ${clauses.join(' AND ')}`;
    }
    query += ' ORDER BY started_at DESC';
    if (limit > 0) {
      query += ' LIMIT ?';
      params.push(limit);
    }

    const rows = this._db.prepare(query).all(...params);
    return rows
      .map((row) => this._mapStateMigrationRow(row))
      .filter(Boolean);
  }

  async upsertErrorbookEntryIndexRecords(records = [], options = {}) {
    const source = normalizeString(options.source) || 'file.errorbook.index';
    const nowIso = this.now();
    const normalizedRecords = Array.isArray(records)
      ? records.map((item) => ({
        entry_id: normalizeString(item && (item.entry_id || item.id)),
        fingerprint: normalizeString(item && item.fingerprint) || null,
        title: normalizeString(item && item.title) || null,
        status: normalizeString(item && item.status) || null,
        quality_score: normalizeNonNegativeInteger(item && item.quality_score, 0),
        tags: normalizeStringArray(item && item.tags, []),
        ontology_tags: normalizeStringArray(item && item.ontology_tags, []),
        temporary_mitigation_active: normalizeBooleanValue(item && item.temporary_mitigation_active, false),
        temporary_mitigation_deadline_at: normalizeIsoTimestamp(item && item.temporary_mitigation_deadline_at, '') || null,
        occurrences: normalizeNonNegativeInteger(item && item.occurrences, 0),
        created_at: normalizeIsoTimestamp(item && item.created_at, '') || null,
        updated_at: normalizeIsoTimestamp(item && item.updated_at, nowIso) || nowIso,
        source,
        indexed_at: nowIso
      }))
        .filter((item) => item.entry_id)
      : [];

    if (this._useMemoryBackend()) {
      for (const item of normalizedRecords) {
        this._memory.errorbook_entry_index[item.entry_id] = { ...item };
      }
      return {
        success: true,
        written: normalizedRecords.length,
        total: Object.keys(this._memory.errorbook_entry_index || {}).length
      };
    }

    if (!await this.ensureReady()) {
      return null;
    }

    const statement = this._db.prepare(`
      INSERT OR REPLACE INTO errorbook_entry_index_registry(
        entry_id, fingerprint, title, status, quality_score, tags_json, ontology_tags_json,
        temporary_mitigation_active, temporary_mitigation_deadline_at, occurrences, created_at, updated_at, source, indexed_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._withTransaction(() => {
      for (const item of normalizedRecords) {
        statement.run(
          item.entry_id,
          item.fingerprint,
          item.title,
          item.status,
          item.quality_score,
          JSON.stringify(item.tags || []),
          JSON.stringify(item.ontology_tags || []),
          item.temporary_mitigation_active ? 1 : 0,
          item.temporary_mitigation_deadline_at,
          item.occurrences,
          item.created_at,
          item.updated_at,
          item.source,
          item.indexed_at
        );
      }
    });

    const totalRow = this._db
      .prepare('SELECT COUNT(*) AS total FROM errorbook_entry_index_registry')
      .get();

    return {
      success: true,
      written: normalizedRecords.length,
      total: normalizeNonNegativeInteger(totalRow && totalRow.total, 0)
    };
  }

  async listErrorbookEntryIndexRecords(options = {}) {
    const limit = normalizeInteger(options.limit, 100);
    const status = normalizeString(options.status);

    if (this._useMemoryBackend()) {
      let rows = Object.values(this._memory.errorbook_entry_index || {}).map((item) => ({ ...item }));
      if (status) {
        rows = rows.filter((item) => normalizeString(item.status) === status);
      }
      rows.sort((left, right) => (Date.parse(right.updated_at || '') || 0) - (Date.parse(left.updated_at || '') || 0));
      if (limit > 0) {
        rows = rows.slice(0, limit);
      }
      return rows.map((row) => this._mapErrorbookEntryIndexRow({
        ...row,
        tags_json: JSON.stringify(row.tags || []),
        ontology_tags_json: JSON.stringify(row.ontology_tags || [])
      }));
    }

    if (!await this.ensureReady()) {
      return null;
    }

    let query = `
      SELECT entry_id, fingerprint, title, status, quality_score, tags_json, ontology_tags_json,
             temporary_mitigation_active, temporary_mitigation_deadline_at, occurrences, created_at, updated_at, source, indexed_at
      FROM errorbook_entry_index_registry
    `;
    const params = [];
    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }
    query += ' ORDER BY updated_at DESC';
    if (limit > 0) {
      query += ' LIMIT ?';
      params.push(limit);
    }

    const rows = this._db.prepare(query).all(...params);
    return rows
      .map((row) => this._mapErrorbookEntryIndexRow(row))
      .filter(Boolean);
  }

  async upsertErrorbookIncidentIndexRecords(records = [], options = {}) {
    const source = normalizeString(options.source) || 'file.errorbook.incident-index';
    const nowIso = this.now();
    const normalizedRecords = Array.isArray(records)
      ? records.map((item) => ({
        incident_id: normalizeString(item && (item.incident_id || item.id)),
        fingerprint: normalizeString(item && item.fingerprint) || null,
        title: normalizeString(item && item.title) || null,
        symptom: normalizeString(item && item.symptom) || null,
        state: normalizeString(item && item.state) || null,
        attempt_count: normalizeNonNegativeInteger(item && item.attempt_count, 0),
        created_at: normalizeIsoTimestamp(item && item.created_at, '') || null,
        updated_at: normalizeIsoTimestamp(item && item.updated_at, nowIso) || nowIso,
        last_attempt_at: normalizeIsoTimestamp(item && item.last_attempt_at, '') || null,
        resolved_at: normalizeIsoTimestamp(item && item.resolved_at, '') || null,
        linked_entry_id: normalizeString(item && item.linked_entry_id) || null,
        source,
        indexed_at: nowIso
      }))
        .filter((item) => item.incident_id)
      : [];

    if (this._useMemoryBackend()) {
      for (const item of normalizedRecords) {
        this._memory.errorbook_incident_index[item.incident_id] = { ...item };
      }
      return {
        success: true,
        written: normalizedRecords.length,
        total: Object.keys(this._memory.errorbook_incident_index || {}).length
      };
    }

    if (!await this.ensureReady()) {
      return null;
    }

    const statement = this._db.prepare(`
      INSERT OR REPLACE INTO errorbook_incident_index_registry(
        incident_id, fingerprint, title, symptom, state, attempt_count,
        created_at, updated_at, last_attempt_at, resolved_at, linked_entry_id, source, indexed_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._withTransaction(() => {
      for (const item of normalizedRecords) {
        statement.run(
          item.incident_id,
          item.fingerprint,
          item.title,
          item.symptom,
          item.state,
          item.attempt_count,
          item.created_at,
          item.updated_at,
          item.last_attempt_at,
          item.resolved_at,
          item.linked_entry_id,
          item.source,
          item.indexed_at
        );
      }
    });

    const totalRow = this._db
      .prepare('SELECT COUNT(*) AS total FROM errorbook_incident_index_registry')
      .get();

    return {
      success: true,
      written: normalizedRecords.length,
      total: normalizeNonNegativeInteger(totalRow && totalRow.total, 0)
    };
  }

  async listErrorbookIncidentIndexRecords(options = {}) {
    const limit = normalizeInteger(options.limit, 100);
    const state = normalizeString(options.state);

    if (this._useMemoryBackend()) {
      let rows = Object.values(this._memory.errorbook_incident_index || {}).map((item) => ({ ...item }));
      if (state) {
        rows = rows.filter((item) => normalizeString(item.state) === state);
      }
      rows.sort((left, right) => (Date.parse(right.updated_at || '') || 0) - (Date.parse(left.updated_at || '') || 0));
      if (limit > 0) {
        rows = rows.slice(0, limit);
      }
      return rows.map((row) => this._mapErrorbookIncidentIndexRow(row));
    }

    if (!await this.ensureReady()) {
      return null;
    }

    let query = `
      SELECT incident_id, fingerprint, title, symptom, state, attempt_count,
             created_at, updated_at, last_attempt_at, resolved_at, linked_entry_id, source, indexed_at
      FROM errorbook_incident_index_registry
    `;
    const params = [];
    if (state) {
      query += ' WHERE state = ?';
      params.push(state);
    }
    query += ' ORDER BY updated_at DESC';
    if (limit > 0) {
      query += ' LIMIT ?';
      params.push(limit);
    }

    const rows = this._db.prepare(query).all(...params);
    return rows
      .map((row) => this._mapErrorbookIncidentIndexRow(row))
      .filter(Boolean);
  }

  async upsertGovernanceSpecSceneOverrideRecords(records = [], options = {}) {
    const source = normalizeString(options.source) || 'file.spec-governance.spec-scene-overrides';
    const nowIso = this.now();
    const normalizedRecords = Array.isArray(records)
      ? records.map((item) => ({
        spec_id: normalizeString(item && item.spec_id),
        scene_id: normalizeString(item && item.scene_id),
        source: normalizeString(item && item.source) || source,
        rule_id: normalizeString(item && item.rule_id) || null,
        updated_at: normalizeIsoTimestamp(item && item.updated_at, nowIso) || nowIso,
        indexed_at: nowIso
      }))
        .filter((item) => item.spec_id && item.scene_id)
      : [];

    if (this._useMemoryBackend()) {
      for (const item of normalizedRecords) {
        this._memory.governance_spec_scene_override[item.spec_id] = { ...item };
      }
      return {
        success: true,
        written: normalizedRecords.length,
        total: Object.keys(this._memory.governance_spec_scene_override || {}).length
      };
    }

    if (!await this.ensureReady()) {
      return null;
    }

    const statement = this._db.prepare(`
      INSERT OR REPLACE INTO governance_spec_scene_override_registry(
        spec_id, scene_id, source, rule_id, updated_at, indexed_at
      )
      VALUES(?, ?, ?, ?, ?, ?)
    `);

    this._withTransaction(() => {
      for (const item of normalizedRecords) {
        statement.run(
          item.spec_id,
          item.scene_id,
          item.source,
          item.rule_id,
          item.updated_at,
          item.indexed_at
        );
      }
    });

    const totalRow = this._db
      .prepare('SELECT COUNT(*) AS total FROM governance_spec_scene_override_registry')
      .get();

    return {
      success: true,
      written: normalizedRecords.length,
      total: normalizeNonNegativeInteger(totalRow && totalRow.total, 0)
    };
  }

  async listGovernanceSpecSceneOverrideRecords(options = {}) {
    const limit = normalizeInteger(options.limit, 100);
    const sceneId = normalizeString(options.sceneId);
    const specId = normalizeString(options.specId);

    if (this._useMemoryBackend()) {
      let rows = Object.values(this._memory.governance_spec_scene_override || {}).map((item) => ({ ...item }));
      if (sceneId) {
        rows = rows.filter((item) => normalizeString(item.scene_id) === sceneId);
      }
      if (specId) {
        rows = rows.filter((item) => normalizeString(item.spec_id) === specId);
      }
      rows.sort((left, right) => (Date.parse(right.updated_at || '') || 0) - (Date.parse(left.updated_at || '') || 0));
      if (limit > 0) {
        rows = rows.slice(0, limit);
      }
      return rows.map((row) => this._mapGovernanceSpecSceneOverrideRow(row));
    }

    if (!await this.ensureReady()) {
      return null;
    }

    let query = `
      SELECT spec_id, scene_id, source, rule_id, updated_at, indexed_at
      FROM governance_spec_scene_override_registry
    `;
    const clauses = [];
    const params = [];
    if (sceneId) {
      clauses.push('scene_id = ?');
      params.push(sceneId);
    }
    if (specId) {
      clauses.push('spec_id = ?');
      params.push(specId);
    }
    if (clauses.length > 0) {
      query += ` WHERE ${clauses.join(' AND ')}`;
    }
    query += ' ORDER BY updated_at DESC, spec_id ASC';
    if (limit > 0) {
      query += ' LIMIT ?';
      params.push(limit);
    }

    const rows = this._db.prepare(query).all(...params);
    return rows
      .map((row) => this._mapGovernanceSpecSceneOverrideRow(row))
      .filter(Boolean);
  }

  async upsertGovernanceSceneIndexRecords(records = [], options = {}) {
    const source = normalizeString(options.source) || 'file.spec-governance.scene-index';
    const nowIso = this.now();
    const normalizedRecords = Array.isArray(records)
      ? records.map((item) => ({
        scene_id: normalizeString(item && item.scene_id),
        total_specs: normalizeNonNegativeInteger(item && item.total_specs, 0),
        active_specs: normalizeNonNegativeInteger(item && item.active_specs, 0),
        completed_specs: normalizeNonNegativeInteger(item && item.completed_specs, 0),
        stale_specs: normalizeNonNegativeInteger(item && item.stale_specs, 0),
        spec_ids: normalizeStringArray(item && item.spec_ids, []),
        active_spec_ids: normalizeStringArray(item && item.active_spec_ids, []),
        stale_spec_ids: normalizeStringArray(item && item.stale_spec_ids, []),
        generated_at: normalizeIsoTimestamp(item && item.generated_at, nowIso) || nowIso,
        scene_filter: normalizeString(item && item.scene_filter) || null,
        source: normalizeString(item && item.source) || source,
        indexed_at: nowIso
      }))
        .filter((item) => item.scene_id)
      : [];

    if (this._useMemoryBackend()) {
      for (const item of normalizedRecords) {
        this._memory.governance_scene_index[item.scene_id] = { ...item };
      }
      return {
        success: true,
        written: normalizedRecords.length,
        total: Object.keys(this._memory.governance_scene_index || {}).length
      };
    }

    if (!await this.ensureReady()) {
      return null;
    }

    const statement = this._db.prepare(`
      INSERT OR REPLACE INTO governance_scene_index_registry(
        scene_id, total_specs, active_specs, completed_specs, stale_specs,
        spec_ids_json, active_spec_ids_json, stale_spec_ids_json, generated_at,
        scene_filter, source, indexed_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._withTransaction(() => {
      for (const item of normalizedRecords) {
        statement.run(
          item.scene_id,
          item.total_specs,
          item.active_specs,
          item.completed_specs,
          item.stale_specs,
          JSON.stringify(item.spec_ids || []),
          JSON.stringify(item.active_spec_ids || []),
          JSON.stringify(item.stale_spec_ids || []),
          item.generated_at,
          item.scene_filter,
          item.source,
          item.indexed_at
        );
      }
    });

    const totalRow = this._db
      .prepare('SELECT COUNT(*) AS total FROM governance_scene_index_registry')
      .get();

    return {
      success: true,
      written: normalizedRecords.length,
      total: normalizeNonNegativeInteger(totalRow && totalRow.total, 0)
    };
  }

  async listGovernanceSceneIndexRecords(options = {}) {
    const limit = normalizeInteger(options.limit, 100);
    const sceneId = normalizeString(options.sceneId);

    if (this._useMemoryBackend()) {
      let rows = Object.values(this._memory.governance_scene_index || {}).map((item) => ({ ...item }));
      if (sceneId) {
        rows = rows.filter((item) => normalizeString(item.scene_id) === sceneId);
      }
      rows.sort((left, right) => {
        if (right.total_specs !== left.total_specs) {
          return right.total_specs - left.total_specs;
        }
        return `${left.scene_id}`.localeCompare(`${right.scene_id}`);
      });
      if (limit > 0) {
        rows = rows.slice(0, limit);
      }
      return rows.map((row) => this._mapGovernanceSceneIndexRow({
        ...row,
        spec_ids_json: JSON.stringify(row.spec_ids || []),
        active_spec_ids_json: JSON.stringify(row.active_spec_ids || []),
        stale_spec_ids_json: JSON.stringify(row.stale_spec_ids || [])
      }));
    }

    if (!await this.ensureReady()) {
      return null;
    }

    let query = `
      SELECT scene_id, total_specs, active_specs, completed_specs, stale_specs,
             spec_ids_json, active_spec_ids_json, stale_spec_ids_json, generated_at,
             scene_filter, source, indexed_at
      FROM governance_scene_index_registry
    `;
    const params = [];
    if (sceneId) {
      query += ' WHERE scene_id = ?';
      params.push(sceneId);
    }
    query += ' ORDER BY total_specs DESC, active_specs DESC, scene_id ASC';
    if (limit > 0) {
      query += ' LIMIT ?';
      params.push(limit);
    }

    const rows = this._db.prepare(query).all(...params);
    return rows
      .map((row) => this._mapGovernanceSceneIndexRow(row))
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
