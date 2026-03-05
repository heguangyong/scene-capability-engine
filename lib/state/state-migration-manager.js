const path = require('path');
const fs = require('fs-extra');
const { getSceStateStore } = require('./sce-state-store');
const { ProjectTimelineStore } = require('../runtime/project-timeline');
const { SessionStore } = require('../runtime/session-store');

const COMPONENT_AGENT_REGISTRY = 'collab.agent-registry';
const COMPONENT_TIMELINE_INDEX = 'runtime.timeline-index';
const COMPONENT_SCENE_SESSION_INDEX = 'runtime.scene-session-index';
const COMPONENT_ERRORBOOK_ENTRY_INDEX = 'errorbook.entry-index';
const COMPONENT_ERRORBOOK_INCIDENT_INDEX = 'errorbook.incident-index';
const COMPONENT_SPEC_SCENE_OVERRIDES = 'governance.spec-scene-overrides';
const COMPONENT_SPEC_SCENE_INDEX = 'governance.scene-index';
const DEFAULT_STATE_EXPORT_PATH = '.sce/reports/state-migration/state-export.latest.json';

const COMPONENT_DEFINITIONS = Object.freeze([
  {
    id: COMPONENT_AGENT_REGISTRY,
    source_path: '.sce/config/agent-registry.json'
  },
  {
    id: COMPONENT_TIMELINE_INDEX,
    source_path: '.sce/timeline/index.json'
  },
  {
    id: COMPONENT_SCENE_SESSION_INDEX,
    source_path: '.sce/session-governance/scene-index.json'
  },
  {
    id: COMPONENT_ERRORBOOK_ENTRY_INDEX,
    source_path: '.sce/errorbook/index.json'
  },
  {
    id: COMPONENT_ERRORBOOK_INCIDENT_INDEX,
    source_path: '.sce/errorbook/staging/index.json'
  },
  {
    id: COMPONENT_SPEC_SCENE_OVERRIDES,
    source_path: '.sce/spec-governance/spec-scene-overrides.json'
  },
  {
    id: COMPONENT_SPEC_SCENE_INDEX,
    source_path: '.sce/spec-governance/scene-index.json'
  }
]);

function normalizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = normalizeString(`${value}`).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(`${value}`, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeCount(value) {
  if (!Number.isFinite(Number(value))) {
    return 0;
  }
  return Math.max(0, Number.parseInt(`${value}`, 10) || 0);
}

function parseComponentIds(value) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((item) => normalizeString(item)).filter(Boolean)));
  }
  const normalized = normalizeString(value);
  if (!normalized) {
    return [];
  }
  return Array.from(new Set(normalized.split(/[,\s]+/g).map((item) => normalizeString(item)).filter(Boolean)));
}

function resolveDefinitionsById(componentIds = []) {
  if (!Array.isArray(componentIds) || componentIds.length === 0) {
    return [...COMPONENT_DEFINITIONS];
  }
  const selected = new Set(componentIds);
  return COMPONENT_DEFINITIONS.filter((item) => selected.has(item.id));
}

function mapAgentRegistryPayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || !payload.agents || typeof payload.agents !== 'object') {
    return [];
  }
  return Object.values(payload.agents)
    .map((item) => ({
      agent_id: normalizeString(item && item.agentId),
      machine_id: normalizeString(item && item.machineId),
      instance_index: normalizeInteger(item && item.instanceIndex, 0),
      hostname: normalizeString(item && item.hostname),
      registered_at: normalizeString(item && item.registeredAt),
      last_heartbeat: normalizeString(item && item.lastHeartbeat),
      status: normalizeString(item && item.status),
      current_task: item && item.currentTask && typeof item.currentTask === 'object'
        ? item.currentTask
        : null
    }))
    .filter((item) => item.agent_id);
}

function mapTimelineIndexPayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.snapshots)) {
    return [];
  }
  return payload.snapshots
    .map((item) => ({
      snapshot_id: normalizeString(item && item.snapshot_id),
      created_at: normalizeString(item && item.created_at),
      trigger: normalizeString(item && item.trigger),
      event: normalizeString(item && item.event),
      summary: normalizeString(item && item.summary),
      scene_id: normalizeString(item && item.scene_id),
      session_id: normalizeString(item && item.session_id),
      command: normalizeString(item && item.command),
      file_count: normalizeInteger(item && item.file_count, 0),
      total_bytes: normalizeInteger(item && item.total_bytes, 0),
      snapshot_path: normalizeString(item && (item.path || item.snapshot_path)),
      git: item && item.git && typeof item.git === 'object' ? item.git : {}
    }))
    .filter((item) => item.snapshot_id);
}

function mapSceneSessionIndexPayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || !payload.scenes || typeof payload.scenes !== 'object') {
    return [];
  }

  const records = [];
  for (const [sceneId, sceneRecord] of Object.entries(payload.scenes)) {
    const normalizedSceneId = normalizeString(sceneId);
    if (!normalizedSceneId) {
      continue;
    }
    const cycles = Array.isArray(sceneRecord && sceneRecord.cycles) ? sceneRecord.cycles : [];
    for (const cycle of cycles) {
      const cycleNo = normalizeInteger(cycle && cycle.cycle, 0);
      const sessionId = normalizeString(cycle && cycle.session_id);
      if (!cycleNo || !sessionId) {
        continue;
      }
      records.push({
        scene_id: normalizedSceneId,
        cycle: cycleNo,
        session_id: sessionId,
        status: normalizeString(cycle && cycle.status),
        started_at: normalizeString(cycle && cycle.started_at),
        completed_at: normalizeString(cycle && cycle.completed_at)
      });
    }
  }
  return records;
}

function mapErrorbookEntryIndexPayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.entries)) {
    return [];
  }
  return payload.entries
    .map((item) => ({
      entry_id: normalizeString(item && (item.id || item.entry_id)),
      fingerprint: normalizeString(item && item.fingerprint),
      title: normalizeString(item && item.title),
      status: normalizeString(item && item.status),
      quality_score: normalizeInteger(item && item.quality_score, 0),
      tags: Array.isArray(item && item.tags)
        ? item.tags.map((token) => normalizeString(token)).filter(Boolean)
        : [],
      ontology_tags: Array.isArray(item && item.ontology_tags)
        ? item.ontology_tags.map((token) => normalizeString(token)).filter(Boolean)
        : [],
      temporary_mitigation_active: item && item.temporary_mitigation_active === true,
      temporary_mitigation_deadline_at: normalizeString(item && item.temporary_mitigation_deadline_at),
      occurrences: normalizeInteger(item && item.occurrences, 0),
      created_at: normalizeString(item && item.created_at),
      updated_at: normalizeString(item && item.updated_at)
    }))
    .filter((item) => item.entry_id);
}

function mapErrorbookIncidentIndexPayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.incidents)) {
    return [];
  }
  return payload.incidents
    .map((item) => ({
      incident_id: normalizeString(item && (item.id || item.incident_id)),
      fingerprint: normalizeString(item && item.fingerprint),
      title: normalizeString(item && item.title),
      symptom: normalizeString(item && item.symptom),
      state: normalizeString(item && item.state),
      attempt_count: normalizeInteger(item && item.attempt_count, 0),
      created_at: normalizeString(item && item.created_at),
      updated_at: normalizeString(item && item.updated_at),
      last_attempt_at: normalizeString(item && item.last_attempt_at),
      resolved_at: normalizeString(item && item.resolved_at),
      linked_entry_id: normalizeString(item && item.linked_entry_id)
    }))
    .filter((item) => item.incident_id);
}

function mapSpecSceneOverridesPayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || !payload.mappings || typeof payload.mappings !== 'object') {
    return [];
  }
  return Object.entries(payload.mappings)
    .map(([specId, mapping]) => {
      if (typeof mapping === 'string') {
        return {
          spec_id: normalizeString(specId),
          scene_id: normalizeString(mapping),
          source: 'override',
          rule_id: '',
          updated_at: normalizeString(payload && payload.updated_at)
        };
      }
      return {
        spec_id: normalizeString(specId),
        scene_id: normalizeString(mapping && mapping.scene_id),
        source: normalizeString(mapping && mapping.source) || 'override',
        rule_id: normalizeString(mapping && mapping.rule_id),
        updated_at: normalizeString(mapping && mapping.updated_at) || normalizeString(payload && payload.updated_at)
      };
    })
    .filter((item) => item.spec_id && item.scene_id);
}

function mapSpecSceneIndexPayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || !payload.scenes || typeof payload.scenes !== 'object') {
    return [];
  }
  const generatedAt = normalizeString(payload.generated_at) || normalizeString(payload.updated_at);
  const sceneFilter = normalizeString(payload.scene_filter);
  return Object.entries(payload.scenes)
    .map(([sceneId, scene]) => ({
      scene_id: normalizeString(sceneId),
      total_specs: normalizeInteger(scene && scene.total_specs, 0),
      active_specs: normalizeInteger(scene && scene.active_specs, 0),
      completed_specs: normalizeInteger(scene && scene.completed_specs, 0),
      stale_specs: normalizeInteger(scene && scene.stale_specs, 0),
      spec_ids: Array.isArray(scene && scene.spec_ids)
        ? scene.spec_ids.map((token) => normalizeString(token)).filter(Boolean)
        : [],
      active_spec_ids: Array.isArray(scene && scene.active_spec_ids)
        ? scene.active_spec_ids.map((token) => normalizeString(token)).filter(Boolean)
        : [],
      stale_spec_ids: Array.isArray(scene && scene.stale_spec_ids)
        ? scene.stale_spec_ids.map((token) => normalizeString(token)).filter(Boolean)
        : [],
      generated_at: generatedAt,
      scene_filter: sceneFilter
    }))
    .filter((item) => item.scene_id);
}

async function readJsonSource(absolutePath, fileSystem = fs) {
  if (!await fileSystem.pathExists(absolutePath)) {
    return {
      exists: false,
      payload: null,
      parse_error: null
    };
  }

  try {
    const payload = await fileSystem.readJson(absolutePath);
    return {
      exists: true,
      payload,
      parse_error: null
    };
  } catch (error) {
    return {
      exists: true,
      payload: null,
      parse_error: error.message
    };
  }
}

async function readComponentSnapshot(component = {}, projectPath = process.cwd(), fileSystem = fs) {
  const absolutePath = path.join(projectPath, component.source_path);
  const source = await readJsonSource(absolutePath, fileSystem);

  let records = [];
  if (!source.parse_error && source.payload) {
    if (component.id === COMPONENT_AGENT_REGISTRY) {
      records = mapAgentRegistryPayload(source.payload);
    } else if (component.id === COMPONENT_TIMELINE_INDEX) {
      records = mapTimelineIndexPayload(source.payload);
    } else if (component.id === COMPONENT_SCENE_SESSION_INDEX) {
      records = mapSceneSessionIndexPayload(source.payload);
    } else if (component.id === COMPONENT_ERRORBOOK_ENTRY_INDEX) {
      records = mapErrorbookEntryIndexPayload(source.payload);
    } else if (component.id === COMPONENT_ERRORBOOK_INCIDENT_INDEX) {
      records = mapErrorbookIncidentIndexPayload(source.payload);
    } else if (component.id === COMPONENT_SPEC_SCENE_OVERRIDES) {
      records = mapSpecSceneOverridesPayload(source.payload);
    } else if (component.id === COMPONENT_SPEC_SCENE_INDEX) {
      records = mapSpecSceneIndexPayload(source.payload);
    }
  }

  return {
    id: component.id,
    source_path: component.source_path,
    exists: source.exists,
    parse_error: source.parse_error,
    source_record_count: records.length,
    records
  };
}

function buildComponentPlan(componentSnapshot = {}) {
  const exists = componentSnapshot.exists === true;
  const parseError = normalizeString(componentSnapshot.parse_error);
  const sourceCount = normalizeInteger(componentSnapshot.source_record_count, 0);
  let status = 'ready';
  if (!exists) {
    status = 'missing';
  } else if (parseError) {
    status = 'parse-error';
  } else if (sourceCount <= 0) {
    status = 'empty';
  }

  return {
    id: componentSnapshot.id,
    source_path: componentSnapshot.source_path,
    exists,
    parse_error: parseError || null,
    source_record_count: sourceCount,
    status
  };
}

async function buildStateMigrationPlan(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;
  const componentIds = parseComponentIds(options.components || options.component || options.componentIds);
  const definitions = resolveDefinitionsById(componentIds);
  const stateStore = dependencies.stateStore || getSceStateStore(projectPath, { fileSystem, env });

  const snapshots = [];
  for (const definition of definitions) {
    const snapshot = await readComponentSnapshot(definition, projectPath, fileSystem);
    snapshots.push(snapshot);
  }

  const components = snapshots.map((snapshot) => buildComponentPlan(snapshot));
  const totalSourceRecords = components.reduce((sum, item) => sum + normalizeInteger(item.source_record_count, 0), 0);
  const readyComponents = components.filter((item) => item.status === 'ready').length;

  return {
    mode: 'state-plan',
    success: true,
    generated_at: nowIso(),
    store_path: stateStore.getStoreRelativePath ? stateStore.getStoreRelativePath() : null,
    sqlite: {
      configured: stateStore.isSqliteConfigured ? stateStore.isSqliteConfigured() : false,
      available: stateStore.isSqliteAvailable ? stateStore.isSqliteAvailable() : false
    },
    components,
    summary: {
      total_components: components.length,
      ready_components: readyComponents,
      total_source_records: totalSourceRecords
    },
    snapshots
  };
}

async function writeComponentToStateStore(componentSnapshot = {}, stateStore, componentId = '') {
  if (componentId === COMPONENT_AGENT_REGISTRY) {
    return stateStore.upsertAgentRuntimeRecords(componentSnapshot.records, {
      source: componentId
    });
  }
  if (componentId === COMPONENT_TIMELINE_INDEX) {
    return stateStore.upsertTimelineSnapshotIndex(componentSnapshot.records, {
      source: componentId
    });
  }
  if (componentId === COMPONENT_SCENE_SESSION_INDEX) {
    return stateStore.upsertSceneSessionCycles(componentSnapshot.records, {
      source: componentId
    });
  }
  if (componentId === COMPONENT_ERRORBOOK_ENTRY_INDEX) {
    return stateStore.upsertErrorbookEntryIndexRecords(componentSnapshot.records, {
      source: componentId
    });
  }
  if (componentId === COMPONENT_ERRORBOOK_INCIDENT_INDEX) {
    return stateStore.upsertErrorbookIncidentIndexRecords(componentSnapshot.records, {
      source: componentId
    });
  }
  if (componentId === COMPONENT_SPEC_SCENE_OVERRIDES) {
    return stateStore.upsertGovernanceSpecSceneOverrideRecords(componentSnapshot.records, {
      source: componentId
    });
  }
  if (componentId === COMPONENT_SPEC_SCENE_INDEX) {
    return stateStore.upsertGovernanceSceneIndexRecords(componentSnapshot.records, {
      source: componentId
    });
  }
  return null;
}

async function runStateMigration(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;
  const apply = normalizeBoolean(options.apply, false);
  const requestedIds = parseComponentIds(options.components || options.component || options.componentIds);
  const migrateAll = options.all === true || requestedIds.length === 0;
  const selectedIds = migrateAll
    ? COMPONENT_DEFINITIONS.map((item) => item.id)
    : requestedIds;

  const plan = await buildStateMigrationPlan({
    componentIds: selectedIds
  }, {
    projectPath,
    fileSystem,
    env
  });
  const stateStore = dependencies.stateStore || getSceStateStore(projectPath, { fileSystem, env });

  const operations = [];
  let migratedComponents = 0;
  let migratedRecords = 0;

  for (const snapshot of plan.snapshots) {
    const componentPlan = buildComponentPlan(snapshot);
    const op = {
      component_id: snapshot.id,
      source_path: snapshot.source_path,
      source_record_count: snapshot.source_record_count,
      status: componentPlan.status,
      applied: false,
      result: null
    };

    if (componentPlan.status !== 'ready') {
      operations.push(op);
      continue;
    }

    if (!apply) {
      op.status = 'planned';
      operations.push(op);
      continue;
    }

    const startedAt = nowIso();
    const writeResult = await writeComponentToStateStore(snapshot, stateStore, snapshot.id);
    if (!writeResult) {
      op.status = 'failed';
      op.error = 'SQLite state backend unavailable for migration write';
      operations.push(op);
      await stateStore.appendStateMigrationRecord({
        component_id: snapshot.id,
        source_path: snapshot.source_path,
        mode: 'apply',
        status: 'failed',
        metrics: {
          source_record_count: snapshot.source_record_count
        },
        detail: {
          error: op.error
        },
        started_at: startedAt,
        completed_at: nowIso()
      });
      continue;
    }

    op.applied = true;
    op.status = 'migrated';
    op.result = writeResult;
    operations.push(op);
    migratedComponents += 1;
    migratedRecords += normalizeInteger(writeResult.written, 0);

    await stateStore.appendStateMigrationRecord({
      component_id: snapshot.id,
      source_path: snapshot.source_path,
      mode: 'apply',
      status: 'completed',
      metrics: {
        source_record_count: snapshot.source_record_count,
        written: normalizeInteger(writeResult.written, 0),
        target_total: normalizeInteger(writeResult.total, 0)
      },
      detail: {
        component_id: snapshot.id
      },
      started_at: startedAt,
      completed_at: nowIso()
    });
  }

  return {
    mode: 'state-migrate',
    success: operations.every((item) => item.status !== 'failed'),
    apply,
    generated_at: nowIso(),
    store_path: stateStore.getStoreRelativePath ? stateStore.getStoreRelativePath() : null,
    operations,
    summary: {
      selected_components: selectedIds.length,
      migrated_components: migratedComponents,
      migrated_records: migratedRecords
    }
  };
}

async function runStateDoctor(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;
  const stateStore = dependencies.stateStore || getSceStateStore(projectPath, { fileSystem, env });
  const plan = await buildStateMigrationPlan({}, { projectPath, fileSystem, env, stateStore });

  const [
    agentRows,
    timelineRows,
    sessionRows,
    errorbookEntryRows,
    errorbookIncidentRows,
    governanceOverrideRows,
    governanceSceneRows,
    migrations
  ] = await Promise.all([
    stateStore.listAgentRuntimeRecords({ limit: 0 }),
    stateStore.listTimelineSnapshotIndex({ limit: 0 }),
    stateStore.listSceneSessionCycles({ limit: 0 }),
    stateStore.listErrorbookEntryIndexRecords({ limit: 0 }),
    stateStore.listErrorbookIncidentIndexRecords({ limit: 0 }),
    stateStore.listGovernanceSpecSceneOverrideRecords({ limit: 0 }),
    stateStore.listGovernanceSceneIndexRecords({ limit: 0 }),
    stateStore.listStateMigrations({ limit: 20 })
  ]);

  const targetCounts = new Map([
    [COMPONENT_AGENT_REGISTRY, Array.isArray(agentRows) ? agentRows.length : 0],
    [COMPONENT_TIMELINE_INDEX, Array.isArray(timelineRows) ? timelineRows.length : 0],
    [COMPONENT_SCENE_SESSION_INDEX, Array.isArray(sessionRows) ? sessionRows.length : 0],
    [COMPONENT_ERRORBOOK_ENTRY_INDEX, Array.isArray(errorbookEntryRows) ? errorbookEntryRows.length : 0],
    [COMPONENT_ERRORBOOK_INCIDENT_INDEX, Array.isArray(errorbookIncidentRows) ? errorbookIncidentRows.length : 0],
    [COMPONENT_SPEC_SCENE_OVERRIDES, Array.isArray(governanceOverrideRows) ? governanceOverrideRows.length : 0],
    [COMPONENT_SPEC_SCENE_INDEX, Array.isArray(governanceSceneRows) ? governanceSceneRows.length : 0]
  ]);

  const checks = plan.components.map((component) => {
    const sourceCount = normalizeInteger(component.source_record_count, 0);
    const targetCount = normalizeInteger(targetCounts.get(component.id), 0);
    let syncStatus = 'synced';
    if (component.status === 'missing') {
      syncStatus = targetCount > 0 ? 'sqlite-only' : 'missing-source';
    } else if (component.status === 'parse-error') {
      syncStatus = 'source-parse-error';
    } else if (sourceCount === 0 && targetCount === 0) {
      syncStatus = 'empty';
    } else if (targetCount < sourceCount) {
      syncStatus = 'pending-migration';
    }
    return {
      id: component.id,
      source_path: component.source_path,
      source_record_count: sourceCount,
      sqlite_record_count: targetCount,
      source_status: component.status,
      sync_status: syncStatus
    };
  });

  const runtime = await collectRuntimeDiagnostics({
    projectPath,
    fileSystem,
    env,
    stateStore
  });

  const blocking = [];
  if (!plan.sqlite.available) {
    blocking.push('sqlite-unavailable');
  }
  if (checks.some((item) => item.sync_status === 'source-parse-error')) {
    blocking.push('source-parse-error');
  }

  const alerts = checks
    .filter((item) => item.sync_status === 'pending-migration')
    .map((item) => `pending migration: ${item.id}`);

  if (runtime.timeline && runtime.timeline.consistency && runtime.timeline.consistency.status === 'pending-sync') {
    alerts.push('runtime timeline index pending-sync');
  }
  if (runtime.timeline && runtime.timeline.consistency && runtime.timeline.consistency.status === 'sqlite-ahead') {
    alerts.push('runtime timeline index sqlite-ahead');
  }
  if (runtime.scene_session && runtime.scene_session.consistency && runtime.scene_session.consistency.status === 'pending-sync') {
    alerts.push('runtime scene-session index pending-sync');
  }
  if (runtime.scene_session && runtime.scene_session.consistency && runtime.scene_session.consistency.status === 'sqlite-ahead') {
    alerts.push('runtime scene-session index sqlite-ahead');
  }

  const summary = summarizeDoctorChecks(checks, alerts, blocking);

  return {
    mode: 'state-doctor',
    success: blocking.length === 0,
    generated_at: nowIso(),
    store_path: plan.store_path,
    sqlite: plan.sqlite,
    summary,
    runtime,
    checks,
    migrations: Array.isArray(migrations) ? migrations : [],
    blocking,
    alerts
  };
}

function summarizeDoctorChecks(checks = [], alerts = [], blocking = []) {
  const normalizedChecks = Array.isArray(checks) ? checks : [];
  const sourceRecords = normalizedChecks.reduce((sum, item) => sum + normalizeCount(item.source_record_count), 0);
  const sqliteRecords = normalizedChecks.reduce((sum, item) => sum + normalizeCount(item.sqlite_record_count), 0);
  const pendingComponents = normalizedChecks.filter((item) => item.sync_status === 'pending-migration').length;
  const syncedComponents = normalizedChecks.filter((item) => item.sync_status === 'synced').length;
  const sqliteOnlyComponents = normalizedChecks.filter((item) => item.sync_status === 'sqlite-only').length;
  const missingSourceComponents = normalizedChecks.filter((item) => item.sync_status === 'missing-source').length;
  const driftRecords = normalizedChecks.reduce((sum, item) => {
    const source = normalizeCount(item.source_record_count);
    const target = normalizeCount(item.sqlite_record_count);
    return sum + Math.abs(source - target);
  }, 0);

  return {
    total_components: normalizedChecks.length,
    synced_components: syncedComponents,
    pending_components: pendingComponents,
    sqlite_only_components: sqliteOnlyComponents,
    missing_source_components: missingSourceComponents,
    total_source_records: sourceRecords,
    total_sqlite_records: sqliteRecords,
    total_record_drift: driftRecords,
    blocking_count: Array.isArray(blocking) ? blocking.length : 0,
    alert_count: Array.isArray(alerts) ? alerts.length : 0
  };
}

async function collectRuntimeDiagnostics(dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;
  const stateStore = dependencies.stateStore || getSceStateStore(projectPath, {
    fileSystem,
    env
  });

  const runtime = {
    timeline: {
      read_source: 'unavailable',
      consistency: {
        status: 'unavailable',
        file_index_count: 0,
        sqlite_index_count: null
      }
    },
    scene_session: {
      read_preference: 'file',
      consistency: {
        status: 'unavailable',
        file_index_count: 0,
        sqlite_index_count: null
      }
    }
  };

  try {
    const timelineStore = new ProjectTimelineStore(projectPath, fileSystem, {
      env,
      stateStore,
      preferSqliteReads: true
    });
    const timelineView = await timelineStore.listSnapshots({ limit: 1 });
    runtime.timeline = {
      read_source: normalizeString(timelineView.read_source) || 'file',
      consistency: {
        status: normalizeString(timelineView && timelineView.consistency && timelineView.consistency.status) || 'unknown',
        file_index_count: normalizeCount(timelineView && timelineView.consistency && timelineView.consistency.file_index_count),
        sqlite_index_count: Number.isFinite(Number(timelineView && timelineView.consistency && timelineView.consistency.sqlite_index_count))
          ? Number.parseInt(`${timelineView.consistency.sqlite_index_count}`, 10)
          : null
      }
    };
  } catch (_error) {
    runtime.timeline = {
      read_source: 'unavailable',
      consistency: {
        status: 'unavailable',
        file_index_count: 0,
        sqlite_index_count: null
      }
    };
  }

  try {
    const sessionStore = new SessionStore(projectPath, fileSystem, {
      env,
      stateStore,
      preferSqliteSceneReads: true
    });
    const sceneIndex = await sessionStore.getSceneIndexDiagnostics();
    runtime.scene_session = {
      read_preference: normalizeString(sceneIndex.read_preference) || 'file',
      consistency: {
        status: normalizeString(sceneIndex.status) || 'unknown',
        file_index_count: normalizeCount(sceneIndex.file_scene_count),
        sqlite_index_count: Number.isFinite(Number(sceneIndex.sqlite_scene_count))
          ? Number.parseInt(`${sceneIndex.sqlite_scene_count}`, 10)
          : null
      }
    };
  } catch (_error) {
    runtime.scene_session = {
      read_preference: 'file',
      consistency: {
        status: 'unavailable',
        file_index_count: 0,
        sqlite_index_count: null
      }
    };
  }

  return runtime;
}

async function runStateExport(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;
  const outPathRaw = normalizeString(options.out) || DEFAULT_STATE_EXPORT_PATH;
  const outPath = path.isAbsolute(outPathRaw)
    ? outPathRaw
    : path.join(projectPath, outPathRaw);
  const stateStore = dependencies.stateStore || getSceStateStore(projectPath, { fileSystem, env });

  const [
    agentRows,
    timelineRows,
    sessionRows,
    errorbookEntryRows,
    errorbookIncidentRows,
    governanceOverrideRows,
    governanceSceneRows,
    migrations
  ] = await Promise.all([
    stateStore.listAgentRuntimeRecords({ limit: 0 }),
    stateStore.listTimelineSnapshotIndex({ limit: 0 }),
    stateStore.listSceneSessionCycles({ limit: 0 }),
    stateStore.listErrorbookEntryIndexRecords({ limit: 0 }),
    stateStore.listErrorbookIncidentIndexRecords({ limit: 0 }),
    stateStore.listGovernanceSpecSceneOverrideRecords({ limit: 0 }),
    stateStore.listGovernanceSceneIndexRecords({ limit: 0 }),
    stateStore.listStateMigrations({ limit: 0 })
  ]);

  const payload = {
    mode: 'state-export',
    success: true,
    exported_at: nowIso(),
    store_path: stateStore.getStoreRelativePath ? stateStore.getStoreRelativePath() : null,
    tables: {
      agent_runtime_registry: Array.isArray(agentRows) ? agentRows : [],
      timeline_snapshot_registry: Array.isArray(timelineRows) ? timelineRows : [],
      scene_session_cycle_registry: Array.isArray(sessionRows) ? sessionRows : [],
      errorbook_entry_index_registry: Array.isArray(errorbookEntryRows) ? errorbookEntryRows : [],
      errorbook_incident_index_registry: Array.isArray(errorbookIncidentRows) ? errorbookIncidentRows : [],
      governance_spec_scene_override_registry: Array.isArray(governanceOverrideRows) ? governanceOverrideRows : [],
      governance_scene_index_registry: Array.isArray(governanceSceneRows) ? governanceSceneRows : [],
      state_migration_registry: Array.isArray(migrations) ? migrations : []
    },
    summary: {
      agent_runtime_registry: Array.isArray(agentRows) ? agentRows.length : 0,
      timeline_snapshot_registry: Array.isArray(timelineRows) ? timelineRows.length : 0,
      scene_session_cycle_registry: Array.isArray(sessionRows) ? sessionRows.length : 0,
      errorbook_entry_index_registry: Array.isArray(errorbookEntryRows) ? errorbookEntryRows.length : 0,
      errorbook_incident_index_registry: Array.isArray(errorbookIncidentRows) ? errorbookIncidentRows.length : 0,
      governance_spec_scene_override_registry: Array.isArray(governanceOverrideRows) ? governanceOverrideRows.length : 0,
      governance_scene_index_registry: Array.isArray(governanceSceneRows) ? governanceSceneRows.length : 0,
      state_migration_registry: Array.isArray(migrations) ? migrations.length : 0
    },
    out_file: path.relative(projectPath, outPath).replace(/\\/g, '/')
  };

  await fileSystem.ensureDir(path.dirname(outPath));
  await fileSystem.writeJson(outPath, payload, { spaces: 2 });
  return payload;
}

module.exports = {
  COMPONENT_AGENT_REGISTRY,
  COMPONENT_TIMELINE_INDEX,
  COMPONENT_SCENE_SESSION_INDEX,
  COMPONENT_ERRORBOOK_ENTRY_INDEX,
  COMPONENT_ERRORBOOK_INCIDENT_INDEX,
  COMPONENT_SPEC_SCENE_OVERRIDES,
  COMPONENT_SPEC_SCENE_INDEX,
  COMPONENT_DEFINITIONS,
  DEFAULT_STATE_EXPORT_PATH,
  buildStateMigrationPlan,
  runStateMigration,
  runStateDoctor,
  runStateExport
};
