const fs = require('fs-extra');
const path = require('path');
const { SteeringContract, normalizeToolName } = require('./steering-contract');
const { getSceStateStore } = require('../state/sce-state-store');

const SESSION_SCHEMA_VERSION = '1.0';
const SESSION_DIR = path.join('.sce', 'sessions');
const SESSION_GOVERNANCE_SCHEMA_VERSION = '1.0';
const SESSION_GOVERNANCE_DIR = path.join('.sce', 'session-governance');
const SESSION_SCENE_INDEX_FILE = 'scene-index.json';

function toRelativePosix(workspaceRoot, absolutePath) {
  return path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
}

function safeSessionId(value) {
  return `${value || ''}`.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function generateSessionId() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = `${now.getUTCMonth() + 1}`.padStart(2, '0');
  const dd = `${now.getUTCDate()}`.padStart(2, '0');
  const hh = `${now.getUTCHours()}`.padStart(2, '0');
  const mi = `${now.getUTCMinutes()}`.padStart(2, '0');
  const ss = `${now.getUTCSeconds()}`.padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 8);
  return `sess-${yyyy}${mm}${dd}-${hh}${mi}${ss}-${rand}`;
}

function nowIso() {
  return new Date().toISOString();
}

function safeSceneId(value) {
  const normalized = `${value || ''}`.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'scene';
}

function nextSnapshotId(session) {
  const snapshots = Array.isArray(session && session.snapshots) ? session.snapshots : [];
  return `snap-${snapshots.length + 1}`;
}

class SessionStore {
  constructor(workspaceRoot, steeringContract = null, options = {}) {
    this._workspaceRoot = workspaceRoot;
    this._sessionsDir = path.join(workspaceRoot, SESSION_DIR);
    this._sessionGovernanceDir = path.join(workspaceRoot, SESSION_GOVERNANCE_DIR);
    this._sceneIndexPath = path.join(this._sessionGovernanceDir, SESSION_SCENE_INDEX_FILE);
    this._steeringContract = steeringContract || new SteeringContract(workspaceRoot);
    this._fileSystem = options.fileSystem || fs;
    this._env = options.env || process.env;
    this._stateStore = options.stateStore || getSceStateStore(workspaceRoot, {
      fileSystem: this._fileSystem,
      env: this._env,
      sqliteModule: options.sqliteModule
    });
    this._preferSqliteSceneReads = options.preferSqliteSceneReads !== undefined
      ? options.preferSqliteSceneReads === true
      : true;
  }

  async startSession(options = {}) {
    const tool = normalizeToolName(options.tool || 'generic');
    const agentVersion = options.agentVersion ? `${options.agentVersion}` : null;
    const objective = `${options.objective || ''}`.trim();
    const requestedId = safeSessionId(options.sessionId);
    const sessionId = requestedId || generateSessionId();
    const now = nowIso();

    await this._steeringContract.ensureContract();
    const steeringPayload = await this._steeringContract.buildCompilePayload(tool, agentVersion);
    await this._fileSystem.ensureDir(this._sessionsDir);

    const sessionPath = this._sessionPath(sessionId);
    if (await this._fileSystem.pathExists(sessionPath)) {
      throw new Error(`Session already exists: ${sessionId}`);
    }

    const session = {
      schema_version: SESSION_SCHEMA_VERSION,
      session_id: sessionId,
      tool,
      agent_version: agentVersion,
      objective,
      status: 'active',
      started_at: now,
      updated_at: now,
      workspace: {
        root: this._workspaceRoot,
      },
      steering: {
        manifest_path: toRelativePosix(this._workspaceRoot, this._steeringContract.manifestPath),
        source_mode: steeringPayload.source_mode,
        compatibility: steeringPayload.compatibility,
      },
      snapshots: [],
      timeline: [
        {
          at: now,
          event: 'session_started',
          detail: {
            tool,
            agent_version: agentVersion,
            objective,
          },
        },
      ],
    };

    await this._writeSession(sessionId, session);
    return session;
  }

  async resumeSession(sessionRef = 'latest', options = {}) {
    const { sessionId, session } = await this._resolveSession(sessionRef);
    const now = nowIso();
    const status = `${options.status || 'active'}`.trim() || 'active';

    session.status = status;
    session.updated_at = now;
    session.timeline = Array.isArray(session.timeline) ? session.timeline : [];
    session.timeline.push({
      at: now,
      event: 'session_resumed',
      detail: { status },
    });

    await this._writeSession(sessionId, session);
    return session;
  }

  async snapshotSession(sessionRef = 'latest', options = {}) {
    const { sessionId, session } = await this._resolveSession(sessionRef);
    const now = nowIso();
    const summary = `${options.summary || ''}`.trim();
    const status = options.status ? `${options.status}`.trim() : session.status;
    const payload = options.payload == null ? null : options.payload;

    session.snapshots = Array.isArray(session.snapshots) ? session.snapshots : [];
    session.timeline = Array.isArray(session.timeline) ? session.timeline : [];

    const snapshot = {
      snapshot_id: `snap-${session.snapshots.length + 1}`,
      captured_at: now,
      status,
      summary,
      payload,
    };

    session.snapshots.push(snapshot);
    session.status = status;
    session.updated_at = now;
    session.timeline.push({
      at: now,
      event: 'snapshot_created',
      detail: {
        snapshot_id: snapshot.snapshot_id,
        status,
      },
    });

    await this._writeSession(sessionId, session);
    return session;
  }

  async getSession(sessionRef = 'latest') {
    const resolved = await this._resolveSession(sessionRef);
    return resolved.session;
  }

  async listSessions() {
    if (!await this._fileSystem.pathExists(this._sessionsDir)) {
      return [];
    }
    const entries = await this._fileSystem.readdir(this._sessionsDir);
    const records = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      const sessionId = entry.slice(0, -'.json'.length);
      try {
        const session = await this._fileSystem.readJson(this._sessionPath(sessionId));
        records.push(session);
      } catch (_error) {
        // Ignore unreadable entries.
      }
    }
    records.sort((a, b) => {
      const left = Date.parse(a.updated_at || a.started_at || 0);
      const right = Date.parse(b.updated_at || b.started_at || 0);
      return right - left;
    });
    return records;
  }

  async beginSceneSession(options = {}) {
    const sceneId = `${options.sceneId || ''}`.trim();
    if (!sceneId) {
      throw new Error('sceneId is required for beginSceneSession');
    }

    const forceNew = options.forceNew === true;
    const sceneIndex = await this._readSceneIndex();
    const sceneRecord = sceneIndex.scenes[sceneId] || {
      scene_id: sceneId,
      active_session_id: null,
      active_cycle: null,
      latest_completed_session_id: null,
      last_cycle: 0,
      cycles: []
    };

    if (!forceNew && sceneRecord.active_session_id) {
      try {
        const activeSession = await this.getSession(sceneRecord.active_session_id);
        if (
          activeSession &&
          activeSession.status === 'active' &&
          activeSession.scene &&
          activeSession.scene.id === sceneId
        ) {
          return {
            created_new: false,
            scene_cycle: Number(sceneRecord.active_cycle || 1),
            session: activeSession,
            scene_record: sceneRecord
          };
        }
      } catch (_error) {
        // stale active pointer; continue and create a new one
      }
    }

    const cycle = Number(sceneRecord.last_cycle || 0) + 1;
    const requestedSessionId = safeSessionId(options.sessionId);
    const generatedScenePrefix = `scene-${safeSceneId(sceneId)}-c${cycle}`;
    const candidateSessionId = requestedSessionId || `${generatedScenePrefix}-${Math.random().toString(36).slice(2, 8)}`;

    const session = await this.startSession({
      tool: options.tool || 'generic',
      agentVersion: options.agentVersion || null,
      objective: options.objective || `Scene ${sceneId} cycle ${cycle}`,
      sessionId: candidateSessionId
    });

    const now = nowIso();
    session.scene = {
      id: sceneId,
      role: 'primary',
      cycle,
      state: 'active'
    };
    session.children = session.children || {};
    session.children.spec_sessions = Array.isArray(session.children.spec_sessions)
      ? session.children.spec_sessions
      : [];
    session.updated_at = now;
    session.timeline = Array.isArray(session.timeline) ? session.timeline : [];
    session.timeline.push({
      at: now,
      event: 'scene_session_started',
      detail: {
        scene_id: sceneId,
        cycle
      }
    });
    await this._writeSession(session.session_id, session);

    sceneRecord.active_session_id = session.session_id;
    sceneRecord.active_cycle = cycle;
    sceneRecord.last_cycle = cycle;
    sceneRecord.updated_at = now;
    sceneRecord.cycles = Array.isArray(sceneRecord.cycles) ? sceneRecord.cycles : [];
    sceneRecord.cycles.push({
      cycle,
      session_id: session.session_id,
      status: 'active',
      started_at: session.started_at,
      completed_at: null
    });
    sceneIndex.scenes[sceneId] = sceneRecord;
    await this._writeSceneIndex(sceneIndex);

    return {
      created_new: true,
      scene_cycle: cycle,
      session,
      scene_record: sceneRecord
    };
  }

  async completeSceneSession(sceneId, sessionRef = null, options = {}) {
    const normalizedSceneId = `${sceneId || ''}`.trim();
    if (!normalizedSceneId) {
      throw new Error('sceneId is required for completeSceneSession');
    }

    const sceneIndex = await this._readSceneIndex();
    const sceneRecord = sceneIndex.scenes[normalizedSceneId];
    if (!sceneRecord) {
      throw new Error(`Scene is not tracked in session governance: ${normalizedSceneId}`);
    }

    const resolvedSessionRef = `${sessionRef || sceneRecord.active_session_id || ''}`.trim();
    if (!resolvedSessionRef) {
      throw new Error(`No active scene session to complete: ${normalizedSceneId}`);
    }

    const { sessionId, session } = await this._resolveSession(resolvedSessionRef);
    if (!session.scene || session.scene.id !== normalizedSceneId) {
      throw new Error(`Session ${sessionId} is not bound to scene ${normalizedSceneId}`);
    }

    const now = nowIso();
    const completionStatus = `${options.status || 'completed'}`.trim() || 'completed';
    const summary = `${options.summary || ''}`.trim();
    const payload = {
      job_id: options.jobId || null,
      release_ref: options.releaseRef || null,
      channel: options.channel || null
    };

    session.snapshots = Array.isArray(session.snapshots) ? session.snapshots : [];
    session.snapshots.push({
      snapshot_id: nextSnapshotId(session),
      captured_at: now,
      status: completionStatus,
      summary,
      payload
    });
    session.status = completionStatus;
    session.updated_at = now;
    session.scene.state = 'completed';
    session.scene.completed_at = now;
    session.timeline = Array.isArray(session.timeline) ? session.timeline : [];
    session.timeline.push({
      at: now,
      event: 'scene_session_completed',
      detail: {
        scene_id: normalizedSceneId,
        release_ref: payload.release_ref,
        channel: payload.channel
      }
    });
    await this._writeSession(sessionId, session);

    sceneRecord.cycles = Array.isArray(sceneRecord.cycles) ? sceneRecord.cycles : [];
    for (const cycle of sceneRecord.cycles) {
      if (cycle && cycle.session_id === sessionId) {
        cycle.status = completionStatus;
        cycle.completed_at = now;
        cycle.release_ref = payload.release_ref;
      }
    }
    sceneRecord.active_session_id = null;
    sceneRecord.active_cycle = null;
    sceneRecord.latest_completed_session_id = sessionId;
    sceneRecord.updated_at = now;
    sceneIndex.scenes[normalizedSceneId] = sceneRecord;
    await this._writeSceneIndex(sceneIndex);

    if (options.autoStartNext === false) {
      return {
        completed_session: session,
        next_session: null,
        next_scene_cycle: null
      };
    }

    const next = await this.beginSceneSession({
      sceneId: normalizedSceneId,
      tool: session.tool,
      agentVersion: session.agent_version || null,
      objective: options.nextObjective || `Scene ${normalizedSceneId} follow-up cycle`
    });
    next.session.timeline = Array.isArray(next.session.timeline) ? next.session.timeline : [];
    next.session.timeline.push({
      at: nowIso(),
      event: 'scene_session_rollover',
      detail: {
        from_session_id: sessionId,
        scene_id: normalizedSceneId
      }
    });
    await this._writeSession(next.session.session_id, next.session);

    return {
      completed_session: session,
      next_session: next.session,
      next_scene_cycle: next.scene_cycle
    };
  }

  async startSpecSession(options = {}) {
    const sceneId = `${options.sceneId || ''}`.trim();
    const specId = `${options.specId || ''}`.trim();
    if (!sceneId) {
      throw new Error('sceneId is required for startSpecSession');
    }
    if (!specId) {
      throw new Error('specId is required for startSpecSession');
    }

    const sceneIndex = await this._readSceneIndex();
    const sceneRecord = sceneIndex.scenes[sceneId];
    if (!sceneRecord || !sceneRecord.active_session_id) {
      throw new Error(`No active scene session for scene: ${sceneId}`);
    }

    const parentSession = await this.getSession(sceneRecord.active_session_id);
    const cycle = parentSession && parentSession.scene && parentSession.scene.cycle
      ? Number(parentSession.scene.cycle)
      : Number(sceneRecord.active_cycle || 1);
    const specSessionId = safeSessionId(options.sessionId)
      || `spec-${safeSceneId(specId)}-${Math.random().toString(36).slice(2, 8)}`;

    const specSession = await this.startSession({
      tool: parentSession.tool || options.tool || 'generic',
      agentVersion: parentSession.agent_version || options.agentVersion || null,
      objective: options.objective || `Spec ${specId} for scene ${sceneId}`,
      sessionId: specSessionId
    });

    const now = nowIso();
    specSession.scene = {
      id: sceneId,
      role: 'spec',
      cycle,
      parent_session_id: parentSession.session_id,
      spec_id: specId,
      state: 'active'
    };
    specSession.updated_at = now;
    specSession.timeline = Array.isArray(specSession.timeline) ? specSession.timeline : [];
    specSession.timeline.push({
      at: now,
      event: 'spec_session_started',
      detail: {
        scene_id: sceneId,
        spec_id: specId,
        parent_session_id: parentSession.session_id
      }
    });
    await this._writeSession(specSession.session_id, specSession);

    parentSession.children = parentSession.children || {};
    parentSession.children.spec_sessions = Array.isArray(parentSession.children.spec_sessions)
      ? parentSession.children.spec_sessions
      : [];
    parentSession.children.spec_sessions.push({
      spec_id: specId,
      spec_session_id: specSession.session_id,
      status: 'active',
      started_at: now
    });
    parentSession.updated_at = now;
    parentSession.timeline = Array.isArray(parentSession.timeline) ? parentSession.timeline : [];
    parentSession.timeline.push({
      at: now,
      event: 'spec_session_attached',
      detail: {
        scene_id: sceneId,
        spec_id: specId,
        spec_session_id: specSession.session_id
      }
    });
    await this._writeSession(parentSession.session_id, parentSession);

    return {
      scene_session: parentSession,
      spec_session: specSession
    };
  }

  async completeSpecSession(options = {}) {
    const specSessionRef = `${options.specSessionRef || ''}`.trim();
    if (!specSessionRef) {
      throw new Error('specSessionRef is required for completeSpecSession');
    }

    const now = nowIso();
    const summary = `${options.summary || ''}`.trim();
    const status = `${options.status || 'completed'}`.trim() || 'completed';
    const payload = options.payload == null ? null : options.payload;

    const { sessionId, session } = await this._resolveSession(specSessionRef);
    if (!session.scene || session.scene.role !== 'spec') {
      throw new Error(`Session ${sessionId} is not a spec child session`);
    }

    session.snapshots = Array.isArray(session.snapshots) ? session.snapshots : [];
    session.snapshots.push({
      snapshot_id: nextSnapshotId(session),
      captured_at: now,
      status,
      summary,
      payload
    });
    session.status = status;
    session.scene.state = 'completed';
    session.scene.completed_at = now;
    session.updated_at = now;
    session.timeline = Array.isArray(session.timeline) ? session.timeline : [];
    session.timeline.push({
      at: now,
      event: 'spec_session_completed',
      detail: {
        scene_id: session.scene.id,
        spec_id: session.scene.spec_id
      }
    });
    await this._writeSession(sessionId, session);

    if (session.scene.parent_session_id) {
      try {
        const parent = await this.getSession(session.scene.parent_session_id);
        parent.children = parent.children || {};
        parent.children.spec_sessions = Array.isArray(parent.children.spec_sessions)
          ? parent.children.spec_sessions
          : [];
        parent.children.spec_sessions = parent.children.spec_sessions.map((entry) => {
          if (entry && entry.spec_session_id === sessionId) {
            return {
              ...entry,
              status,
              completed_at: now
            };
          }
          return entry;
        });
        parent.updated_at = now;
        parent.timeline = Array.isArray(parent.timeline) ? parent.timeline : [];
        parent.timeline.push({
          at: now,
          event: 'spec_session_archived',
          detail: {
            scene_id: session.scene.id,
            spec_id: session.scene.spec_id,
            spec_session_id: sessionId
          }
        });
        await this._writeSession(parent.session_id, parent);
      } catch (_error) {
        // parent may have been removed manually; spec session has already been archived
      }
    }

    return session;
  }

  async listSceneRecords() {
    const sqliteRecords = await this._readSceneRecordsFromSqlite();
    if (Array.isArray(sqliteRecords) && sqliteRecords.length > 0) {
      return sqliteRecords;
    }
    const sceneIndex = await this._readSceneIndex();
    return Object.values(sceneIndex.scenes || {});
  }

  async getSceneIndexDiagnostics() {
    const sceneIndex = await this._readSceneIndex();
    const fileRecords = Object.values(sceneIndex.scenes || {});
    const sqliteRecords = await this._readSceneRecordsFromSqlite();

    const fileCount = fileRecords.length;
    const sqliteCount = Array.isArray(sqliteRecords) ? sqliteRecords.length : null;

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
      read_preference: this._preferSqliteSceneReads ? 'sqlite' : 'file',
      file_scene_count: fileCount,
      sqlite_scene_count: sqliteCount,
      status
    };
  }

  async listActiveSceneSessions() {
    const records = await this.listSceneRecords();
    const active = [];
    for (const record of records) {
      if (!record || !record.active_session_id) {
        continue;
      }
      try {
        const session = await this.getSession(record.active_session_id);
        if (session && session.status === 'active') {
          active.push({
            scene_id: record.scene_id,
            scene_cycle: record.active_cycle,
            session
          });
        }
      } catch (_error) {
        // skip stale references
      }
    }
    return active;
  }

  async getActiveSceneSession(sceneId) {
    const normalizedSceneId = `${sceneId || ''}`.trim();
    if (!normalizedSceneId) {
      throw new Error('sceneId is required for getActiveSceneSession');
    }
    const sceneIndex = await this._readSceneIndex();
    const record = sceneIndex.scenes[normalizedSceneId];
    if (!record || !record.active_session_id) {
      return null;
    }
    try {
      const session = await this.getSession(record.active_session_id);
      if (!session || session.status !== 'active') {
        return null;
      }
      return {
        scene_id: normalizedSceneId,
        scene_cycle: record.active_cycle,
        session
      };
    } catch (_error) {
      return null;
    }
  }

  async _resolveSession(sessionRef) {
    const ref = `${sessionRef || 'latest'}`.trim();
    if (ref === 'latest') {
      const sessions = await this.listSessions();
      if (sessions.length === 0) {
        throw new Error('No session found');
      }
      const session = sessions[0];
      return { sessionId: session.session_id, session };
    }

    const sessionId = safeSessionId(ref);
    if (!sessionId) {
      throw new Error(`Invalid session id: ${ref}`);
    }
    const sessionPath = this._sessionPath(sessionId);
    if (!await this._fileSystem.pathExists(sessionPath)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const session = await this._fileSystem.readJson(sessionPath);
    return { sessionId, session };
  }

  async _writeSession(sessionId, session) {
    await this._fileSystem.ensureDir(this._sessionsDir);
    await this._fileSystem.writeJson(this._sessionPath(sessionId), session, { spaces: 2 });
  }

  async _readSceneIndex() {
    if (!await this._fileSystem.pathExists(this._sceneIndexPath)) {
      return {
        schema_version: SESSION_GOVERNANCE_SCHEMA_VERSION,
        updated_at: nowIso(),
        scenes: {}
      };
    }

    try {
      const payload = await this._fileSystem.readJson(this._sceneIndexPath);
      return {
        schema_version: payload && payload.schema_version
          ? payload.schema_version
          : SESSION_GOVERNANCE_SCHEMA_VERSION,
        updated_at: payload && payload.updated_at ? payload.updated_at : nowIso(),
        scenes: payload && typeof payload.scenes === 'object' && payload.scenes
          ? payload.scenes
          : {}
      };
    } catch (_error) {
      return {
        schema_version: SESSION_GOVERNANCE_SCHEMA_VERSION,
        updated_at: nowIso(),
        scenes: {}
      };
    }
  }

  async _writeSceneIndex(indexPayload) {
    const payload = {
      schema_version: SESSION_GOVERNANCE_SCHEMA_VERSION,
      updated_at: nowIso(),
      scenes: indexPayload && typeof indexPayload.scenes === 'object' && indexPayload.scenes
        ? indexPayload.scenes
        : {}
    };
    await this._fileSystem.ensureDir(this._sessionGovernanceDir);
    await this._fileSystem.writeJson(this._sceneIndexPath, payload, { spaces: 2 });
    await this._syncSceneIndexToStateStore(payload);
    return payload;
  }

  async _readSceneRecordsFromSqlite() {
    if (this._preferSqliteSceneReads !== true || !this._stateStore) {
      return null;
    }
    try {
      const cycles = await this._stateStore.listSceneSessionCycles({ limit: 0 });
      if (!Array.isArray(cycles) || cycles.length === 0) {
        return [];
      }
      const grouped = new Map();
      for (const cycle of cycles) {
        const sceneId = `${cycle.scene_id || ''}`.trim();
        if (!sceneId) {
          continue;
        }
        if (!grouped.has(sceneId)) {
          grouped.set(sceneId, []);
        }
        grouped.get(sceneId).push({
          cycle: Number(cycle.cycle || 0),
          session_id: `${cycle.session_id || ''}`.trim(),
          status: `${cycle.status || ''}`.trim() || null,
          started_at: cycle.started_at || null,
          completed_at: cycle.completed_at || null
        });
      }

      const sceneRecords = [];
      for (const [sceneId, rows] of grouped.entries()) {
        rows.sort((left, right) => right.cycle - left.cycle);
        const active = rows.find((item) => item.status === 'active') || null;
        const completed = rows.find((item) => item.status === 'completed') || null;
        const lastCycle = rows.length > 0 ? rows[0].cycle : 0;

        sceneRecords.push({
          scene_id: sceneId,
          active_session_id: active ? active.session_id : null,
          active_cycle: active ? active.cycle : null,
          latest_completed_session_id: completed ? completed.session_id : null,
          last_cycle: lastCycle,
          cycles: rows.map((item) => ({
            cycle: item.cycle,
            session_id: item.session_id,
            status: item.status,
            started_at: item.started_at,
            completed_at: item.completed_at
          }))
        });
      }

      sceneRecords.sort((left, right) => `${left.scene_id}`.localeCompare(`${right.scene_id}`));
      return sceneRecords;
    } catch (_error) {
      return null;
    }
  }

  _flattenSceneCycleRows(indexPayload = {}) {
    const scenes = indexPayload && typeof indexPayload.scenes === 'object' && indexPayload.scenes
      ? indexPayload.scenes
      : {};
    const records = [];
    for (const [sceneId, sceneRecord] of Object.entries(scenes)) {
      const normalizedSceneId = `${sceneId || ''}`.trim();
      if (!normalizedSceneId) {
        continue;
      }
      const cycles = Array.isArray(sceneRecord && sceneRecord.cycles) ? sceneRecord.cycles : [];
      for (const cycle of cycles) {
        const cycleNo = Number.parseInt(`${cycle && cycle.cycle}`, 10);
        const sessionId = `${cycle && cycle.session_id ? cycle.session_id : ''}`.trim();
        if (!Number.isFinite(cycleNo) || cycleNo <= 0 || !sessionId) {
          continue;
        }
        records.push({
          scene_id: normalizedSceneId,
          cycle: cycleNo,
          session_id: sessionId,
          status: `${cycle && cycle.status ? cycle.status : ''}`.trim() || null,
          started_at: cycle && cycle.started_at ? cycle.started_at : null,
          completed_at: cycle && cycle.completed_at ? cycle.completed_at : null
        });
      }
    }
    return records;
  }

  async _syncSceneIndexToStateStore(indexPayload = {}) {
    if (!this._stateStore) {
      return;
    }
    try {
      const records = this._flattenSceneCycleRows(indexPayload);
      if (records.length === 0) {
        return;
      }
      await this._stateStore.upsertSceneSessionCycles(records, {
        source: 'runtime.session-store'
      });
    } catch (_error) {
      // best effort sync only
    }
  }

  _sessionPath(sessionId) {
    return path.join(this._sessionsDir, `${sessionId}.json`);
  }
}

module.exports = {
  SessionStore,
  SESSION_SCHEMA_VERSION,
  SESSION_DIR,
  SESSION_GOVERNANCE_SCHEMA_VERSION,
  SESSION_GOVERNANCE_DIR,
  SESSION_SCENE_INDEX_FILE,
};
