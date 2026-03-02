const crypto = require('crypto');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs-extra');
const chalk = require('chalk');
const Table = require('cli-table3');

const ERRORBOOK_INDEX_API_VERSION = 'sce.errorbook.index/v0.1';
const ERRORBOOK_ENTRY_API_VERSION = 'sce.errorbook.entry/v0.1';
const ERRORBOOK_REGISTRY_API_VERSION = 'sce.errorbook.registry/v0.1';
const ERRORBOOK_REGISTRY_CACHE_API_VERSION = 'sce.errorbook.registry-cache/v0.1';
const ERRORBOOK_REGISTRY_INDEX_API_VERSION = 'sce.errorbook.registry-index/v0.1';
const ERRORBOOK_INCIDENT_INDEX_API_VERSION = 'sce.errorbook.incident-index/v0.1';
const ERRORBOOK_INCIDENT_API_VERSION = 'sce.errorbook.incident/v0.1';
const ERRORBOOK_STATUSES = Object.freeze(['candidate', 'verified', 'promoted', 'deprecated']);
const TEMPORARY_MITIGATION_TAG = 'temporary-mitigation';
const DEFAULT_ERRORBOOK_REGISTRY_CONFIG = '.sce/config/errorbook-registry.json';
const DEFAULT_ERRORBOOK_REGISTRY_CACHE = '.sce/errorbook/registry-cache.json';
const DEFAULT_ERRORBOOK_REGISTRY_EXPORT = '.sce/errorbook/exports/errorbook-registry-export.json';
const STATUS_RANK = Object.freeze({
  deprecated: 0,
  candidate: 1,
  verified: 2,
  promoted: 3
});
const ERRORBOOK_ONTOLOGY_TAGS = Object.freeze([
  'entity',
  'relation',
  'business_rule',
  'decision_policy',
  'execution_flow'
]);
const ONTOLOGY_TAG_ALIASES = Object.freeze({
  entities: 'entity',
  relations: 'relation',
  rule: 'business_rule',
  rules: 'business_rule',
  business_rules: 'business_rule',
  decision: 'decision_policy',
  decisions: 'decision_policy',
  policy: 'decision_policy',
  policies: 'decision_policy',
  execution: 'execution_flow',
  flow: 'execution_flow',
  workflow: 'execution_flow',
  workflows: 'execution_flow',
  action_chain: 'execution_flow'
});
const DEFAULT_PROMOTE_MIN_QUALITY = 75;
const DEFAULT_RELEASE_GATE_MIN_QUALITY = 70;
const ERRORBOOK_RISK_LEVELS = Object.freeze(['low', 'medium', 'high']);
const DEBUG_EVIDENCE_TAGS = Object.freeze([
  'debug-evidence',
  'diagnostic-evidence',
  'debug-log'
]);
const HIGH_RISK_SIGNAL_TAGS = Object.freeze([
  'release-blocker',
  'security',
  'auth',
  'payment',
  'data-loss',
  'integrity',
  'compliance',
  'incident'
]);

function resolveErrorbookPaths(projectPath = process.cwd()) {
  const baseDir = path.join(projectPath, '.sce', 'errorbook');
  const stagingDir = path.join(baseDir, 'staging');
  return {
    projectPath,
    baseDir,
    entriesDir: path.join(baseDir, 'entries'),
    indexFile: path.join(baseDir, 'index.json'),
    stagingDir,
    incidentsDir: path.join(stagingDir, 'incidents'),
    resolvedDir: path.join(stagingDir, 'resolved'),
    incidentIndexFile: path.join(stagingDir, 'index.json')
  };
}

function resolveProjectPath(projectPath, maybeRelativePath, fallbackRelativePath) {
  const normalized = normalizeText(maybeRelativePath || fallbackRelativePath || '');
  if (!normalized) {
    return path.resolve(projectPath, fallbackRelativePath || '');
  }
  return path.isAbsolute(normalized)
    ? normalized
    : path.resolve(projectPath, normalized);
}

function resolveErrorbookRegistryPaths(projectPath = process.cwd(), overrides = {}) {
  const configFile = resolveProjectPath(projectPath, overrides.configPath, DEFAULT_ERRORBOOK_REGISTRY_CONFIG);
  const cacheFile = resolveProjectPath(projectPath, overrides.cachePath, DEFAULT_ERRORBOOK_REGISTRY_CACHE);
  const exportFile = resolveProjectPath(projectPath, overrides.exportPath, DEFAULT_ERRORBOOK_REGISTRY_EXPORT);
  return {
    projectPath,
    configFile,
    cacheFile,
    exportFile
  };
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = normalizeText(`${value || ''}`).toLowerCase();
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

function normalizeCsv(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeStringList(...rawInputs) {
  const merged = [];
  for (const raw of rawInputs) {
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const normalized = normalizeText(`${item}`);
        if (normalized) {
          merged.push(normalized);
        }
      }
      continue;
    }

    if (typeof raw === 'string') {
      for (const item of normalizeCsv(raw)) {
        const normalized = normalizeText(item);
        if (normalized) {
          merged.push(normalized);
        }
      }
    }
  }

  return Array.from(new Set(merged));
}

function normalizeIsoTimestamp(value, fieldName = 'datetime') {
  const normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) {
    throw new Error(`${fieldName} must be a valid ISO datetime`);
  }
  return new Date(parsed).toISOString();
}

function normalizeOntologyTags(...rawInputs) {
  const normalized = normalizeStringList(...rawInputs).map((item) => item.toLowerCase());
  const mapped = normalized.map((item) => ONTOLOGY_TAG_ALIASES[item] || item);
  const valid = mapped.filter((item) => ERRORBOOK_ONTOLOGY_TAGS.includes(item));
  return Array.from(new Set(valid));
}

function hasMitigationInput(options = {}, fromFilePayload = {}) {
  const mitigation = fromFilePayload && typeof fromFilePayload.temporary_mitigation === 'object'
    ? fromFilePayload.temporary_mitigation
    : {};
  return Boolean(
    options.temporaryMitigation === true ||
    normalizeBoolean(mitigation.enabled, false) ||
    normalizeText(options.mitigationReason || mitigation.reason || mitigation.notes) ||
    normalizeText(options.mitigationExit || mitigation.exit_criteria || mitigation.exitCriteria) ||
    normalizeText(options.mitigationCleanup || mitigation.cleanup_task || mitigation.cleanupTask) ||
    normalizeText(options.mitigationDeadline || mitigation.deadline_at || mitigation.deadlineAt)
  );
}

function normalizeTemporaryMitigation(options = {}, fromFilePayload = {}) {
  const mitigationFromFile = fromFilePayload && typeof fromFilePayload.temporary_mitigation === 'object'
    ? fromFilePayload.temporary_mitigation
    : {};
  if (!hasMitigationInput(options, fromFilePayload)) {
    return { enabled: false };
  }

  return {
    enabled: true,
    reason: normalizeText(options.mitigationReason || mitigationFromFile.reason || mitigationFromFile.notes),
    exit_criteria: normalizeText(options.mitigationExit || mitigationFromFile.exit_criteria || mitigationFromFile.exitCriteria),
    cleanup_task: normalizeText(options.mitigationCleanup || mitigationFromFile.cleanup_task || mitigationFromFile.cleanupTask),
    deadline_at: normalizeIsoTimestamp(
      options.mitigationDeadline || mitigationFromFile.deadline_at || mitigationFromFile.deadlineAt,
      '--mitigation-deadline'
    ),
    created_at: normalizeIsoTimestamp(mitigationFromFile.created_at || mitigationFromFile.createdAt, 'temporary_mitigation.created_at') || '',
    updated_at: normalizeIsoTimestamp(mitigationFromFile.updated_at || mitigationFromFile.updatedAt, 'temporary_mitigation.updated_at') || '',
    resolved_at: normalizeIsoTimestamp(mitigationFromFile.resolved_at || mitigationFromFile.resolvedAt, 'temporary_mitigation.resolved_at') || ''
  };
}

function normalizeExistingTemporaryMitigation(value = {}) {
  if (!value || typeof value !== 'object' || normalizeBoolean(value.enabled, false) !== true) {
    return { enabled: false };
  }
  return {
    enabled: true,
    reason: normalizeText(value.reason || value.notes),
    exit_criteria: normalizeText(value.exit_criteria || value.exitCriteria),
    cleanup_task: normalizeText(value.cleanup_task || value.cleanupTask),
    deadline_at: normalizeText(value.deadline_at || value.deadlineAt),
    created_at: normalizeText(value.created_at || value.createdAt),
    updated_at: normalizeText(value.updated_at || value.updatedAt),
    resolved_at: normalizeText(value.resolved_at || value.resolvedAt)
  };
}

function resolveMergedTemporaryMitigation(existingEntry = {}, incomingPayload = {}) {
  const existing = normalizeExistingTemporaryMitigation(existingEntry.temporary_mitigation);
  const incoming = normalizeExistingTemporaryMitigation(incomingPayload.temporary_mitigation);
  if (!incoming.enabled) {
    return existing;
  }

  return {
    enabled: true,
    reason: normalizeText(incoming.reason) || existing.reason || '',
    exit_criteria: normalizeText(incoming.exit_criteria) || existing.exit_criteria || '',
    cleanup_task: normalizeText(incoming.cleanup_task) || existing.cleanup_task || '',
    deadline_at: normalizeText(incoming.deadline_at) || existing.deadline_at || '',
    created_at: normalizeText(existing.created_at) || nowIso(),
    updated_at: nowIso(),
    resolved_at: ''
  };
}

function markTemporaryMitigationResolved(entry = {}, resolvedAt = nowIso()) {
  const current = normalizeExistingTemporaryMitigation(entry.temporary_mitigation);
  if (!current.enabled || normalizeText(current.resolved_at)) {
    return current.enabled ? {
      ...current,
      resolved_at: normalizeText(current.resolved_at) || resolvedAt,
      updated_at: normalizeText(current.updated_at) || resolvedAt
    } : { enabled: false };
  }
  return {
    ...current,
    resolved_at: resolvedAt,
    updated_at: resolvedAt
  };
}

function evaluateTemporaryMitigationPolicy(entry = {}) {
  const mitigation = normalizeExistingTemporaryMitigation(entry.temporary_mitigation);
  const status = normalizeStatus(entry.status, 'candidate');
  if (!mitigation.enabled || ['promoted', 'deprecated'].includes(status)) {
    return null;
  }
  if (normalizeText(mitigation.resolved_at)) {
    return null;
  }

  const policyViolations = [];
  if (!normalizeText(mitigation.exit_criteria)) {
    policyViolations.push('temporary_mitigation.exit_criteria');
  }
  if (!normalizeText(mitigation.cleanup_task)) {
    policyViolations.push('temporary_mitigation.cleanup_task');
  }
  const deadlineAtRaw = normalizeText(mitigation.deadline_at);
  let deadlineAt = deadlineAtRaw;
  let deadlineExpired = false;
  if (!deadlineAtRaw) {
    policyViolations.push('temporary_mitigation.deadline_at');
  } else {
    const parsed = Date.parse(deadlineAtRaw);
    if (Number.isNaN(parsed)) {
      policyViolations.push('temporary_mitigation.deadline_at:invalid_datetime');
    } else {
      deadlineAt = new Date(parsed).toISOString();
      if (parsed <= Date.now()) {
        deadlineExpired = true;
        policyViolations.push('temporary_mitigation.deadline_at:expired');
      }
    }
  }

  return {
    enabled: true,
    reason: mitigation.reason,
    exit_criteria: mitigation.exit_criteria,
    cleanup_task: mitigation.cleanup_task,
    deadline_at: deadlineAt,
    deadline_expired: deadlineExpired,
    policy_violations: policyViolations
  };
}

function normalizeStatus(input, fallback = 'candidate') {
  const normalized = normalizeText(`${input || ''}`).toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (!ERRORBOOK_STATUSES.includes(normalized)) {
    throw new Error(`status must be one of: ${ERRORBOOK_STATUSES.join(', ')}`);
  }

  return normalized;
}

function selectStatus(...candidates) {
  let selected = 'candidate';
  for (const candidate of candidates) {
    const status = normalizeStatus(candidate, 'candidate');
    if ((STATUS_RANK[status] || 0) > (STATUS_RANK[selected] || 0)) {
      selected = status;
    }
  }
  return selected;
}

function createFingerprint(input = {}) {
  const explicit = normalizeText(input.fingerprint);
  if (explicit) {
    return explicit;
  }

  const basis = [
    normalizeText(input.title).toLowerCase(),
    normalizeText(input.symptom).toLowerCase(),
    normalizeText(input.root_cause || input.rootCause).toLowerCase()
  ].join('|');

  const digest = crypto.createHash('sha1').update(basis).digest('hex').slice(0, 16);
  return `fp-${digest}`;
}

function buildDefaultIndex() {
  return {
    api_version: ERRORBOOK_INDEX_API_VERSION,
    updated_at: nowIso(),
    total_entries: 0,
    entries: []
  };
}

async function ensureErrorbookStorage(paths, fileSystem = fs) {
  await fileSystem.ensureDir(paths.entriesDir);
  if (!await fileSystem.pathExists(paths.indexFile)) {
    await fileSystem.writeJson(paths.indexFile, buildDefaultIndex(), { spaces: 2 });
  }
}

async function readErrorbookIndex(paths, fileSystem = fs) {
  await ensureErrorbookStorage(paths, fileSystem);
  const index = await fileSystem.readJson(paths.indexFile);
  if (!index || typeof index !== 'object' || !Array.isArray(index.entries)) {
    return buildDefaultIndex();
  }

  return {
    api_version: index.api_version || ERRORBOOK_INDEX_API_VERSION,
    updated_at: index.updated_at || nowIso(),
    total_entries: Number.isInteger(index.total_entries) ? index.total_entries : index.entries.length,
    entries: index.entries
  };
}

async function writeErrorbookIndex(paths, index, fileSystem = fs) {
  const payload = {
    ...index,
    api_version: ERRORBOOK_INDEX_API_VERSION,
    updated_at: nowIso(),
    total_entries: Array.isArray(index.entries) ? index.entries.length : 0
  };
  await fileSystem.ensureDir(path.dirname(paths.indexFile));
  await fileSystem.writeJson(paths.indexFile, payload, { spaces: 2 });
  return payload;
}

function buildEntryFilePath(paths, entryId) {
  return path.join(paths.entriesDir, `${entryId}.json`);
}

async function readErrorbookEntry(paths, entryId, fileSystem = fs) {
  const entryPath = buildEntryFilePath(paths, entryId);
  if (!await fileSystem.pathExists(entryPath)) {
    return null;
  }
  return fileSystem.readJson(entryPath);
}

async function writeErrorbookEntry(paths, entry, fileSystem = fs) {
  const entryPath = buildEntryFilePath(paths, entry.id);
  await fileSystem.ensureDir(path.dirname(entryPath));
  await fileSystem.writeJson(entryPath, entry, { spaces: 2 });
  return entryPath;
}

function buildDefaultIncidentIndex() {
  return {
    api_version: ERRORBOOK_INCIDENT_INDEX_API_VERSION,
    updated_at: nowIso(),
    total_incidents: 0,
    incidents: []
  };
}

function normalizeIncidentState(value, fallback = 'open') {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === 'open' || normalized === 'resolved') {
    return normalized;
  }
  return fallback;
}

function shouldResolveIncidentByStatus(status = '') {
  const normalized = normalizeStatus(status, 'candidate');
  return normalized === 'verified' || normalized === 'promoted' || normalized === 'deprecated';
}

function createIncidentId() {
  return `ebi-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function createIncidentAttemptId() {
  return `attempt-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
}

function buildIncidentFilePath(paths, incidentId) {
  return path.join(paths.incidentsDir, `${incidentId}.json`);
}

function buildIncidentResolvedSnapshotPath(paths, incidentId) {
  return path.join(paths.resolvedDir, `${incidentId}.json`);
}

async function ensureIncidentStorage(paths, fileSystem = fs) {
  await fileSystem.ensureDir(paths.incidentsDir);
  await fileSystem.ensureDir(paths.resolvedDir);
  if (!await fileSystem.pathExists(paths.incidentIndexFile)) {
    await fileSystem.writeJson(paths.incidentIndexFile, buildDefaultIncidentIndex(), { spaces: 2 });
  }
}

async function readIncidentIndex(paths, fileSystem = fs) {
  await ensureIncidentStorage(paths, fileSystem);
  const payload = await fileSystem.readJson(paths.incidentIndexFile).catch(() => null);
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.incidents)) {
    return buildDefaultIncidentIndex();
  }
  return {
    api_version: payload.api_version || ERRORBOOK_INCIDENT_INDEX_API_VERSION,
    updated_at: normalizeText(payload.updated_at) || nowIso(),
    total_incidents: Number.isInteger(payload.total_incidents) ? payload.total_incidents : payload.incidents.length,
    incidents: payload.incidents
  };
}

async function writeIncidentIndex(paths, index, fileSystem = fs) {
  const payload = {
    api_version: ERRORBOOK_INCIDENT_INDEX_API_VERSION,
    updated_at: nowIso(),
    incidents: Array.isArray(index.incidents) ? index.incidents : []
  };
  payload.total_incidents = payload.incidents.length;
  await fileSystem.ensureDir(path.dirname(paths.incidentIndexFile));
  await fileSystem.writeJson(paths.incidentIndexFile, payload, { spaces: 2 });
  return payload;
}

async function readIncident(paths, incidentId, fileSystem = fs) {
  const filePath = buildIncidentFilePath(paths, incidentId);
  if (!await fileSystem.pathExists(filePath)) {
    return null;
  }
  return fileSystem.readJson(filePath);
}

async function writeIncident(paths, incident, fileSystem = fs) {
  const filePath = buildIncidentFilePath(paths, incident.id);
  await fileSystem.ensureDir(path.dirname(filePath));
  await fileSystem.writeJson(filePath, incident, { spaces: 2 });
  return filePath;
}

function createIncidentAttemptSignature(payload = {}) {
  const attemptContract = payload && payload.attempt_contract && typeof payload.attempt_contract === 'object'
    ? payload.attempt_contract
    : {};
  const basis = JSON.stringify({
    root_cause: normalizeText(payload.root_cause),
    fix_actions: normalizeStringList(payload.fix_actions),
    verification_evidence: normalizeStringList(payload.verification_evidence),
    notes: normalizeText(payload.notes),
    attempt_contract: {
      hypothesis: normalizeText(attemptContract.hypothesis),
      change_points: normalizeStringList(attemptContract.change_points),
      verification_result: normalizeText(attemptContract.verification_result),
      rollback_point: normalizeText(attemptContract.rollback_point),
      conclusion: normalizeText(attemptContract.conclusion)
    },
    source: {
      spec: normalizeText(payload?.source?.spec),
      files: normalizeStringList(payload?.source?.files),
      tests: normalizeStringList(payload?.source?.tests)
    }
  });
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

function createIncidentSummaryFromIncident(incident = {}) {
  return {
    id: incident.id,
    fingerprint: normalizeText(incident.fingerprint),
    title: normalizeText(incident.title),
    symptom: normalizeText(incident.symptom),
    state: normalizeIncidentState(incident.state, 'open'),
    attempt_count: Number(incident.attempt_count || 0),
    created_at: normalizeText(incident.created_at),
    updated_at: normalizeText(incident.updated_at),
    last_attempt_at: normalizeText(incident.last_attempt_at),
    resolved_at: normalizeText(incident.resolved_at),
    linked_entry_id: normalizeText(incident?.resolution?.entry_id || '')
  };
}

async function syncIncidentLoopForRecord(paths, payload = {}, entry = {}, options = {}, fileSystem = fs) {
  await ensureIncidentStorage(paths, fileSystem);
  const incidentIndex = await readIncidentIndex(paths, fileSystem);
  const fingerprint = normalizeText(payload.fingerprint || entry.fingerprint);
  const title = normalizeText(payload.title || entry.title);
  const symptom = normalizeText(payload.symptom || entry.symptom);
  const currentTime = normalizeText(options.nowIso) || nowIso();

  let incidentSummary = incidentIndex.incidents.find((item) => item.fingerprint === fingerprint) || null;
  let incident = incidentSummary ? await readIncident(paths, incidentSummary.id, fileSystem) : null;

  if (!incident) {
    const incidentId = incidentSummary ? incidentSummary.id : createIncidentId();
    incident = {
      api_version: ERRORBOOK_INCIDENT_API_VERSION,
      id: incidentId,
      fingerprint,
      title,
      symptom,
      state: 'open',
      created_at: currentTime,
      updated_at: currentTime,
      last_attempt_at: '',
      resolved_at: '',
      attempt_count: 0,
      attempts: [],
      resolution: {
        entry_id: '',
        status: '',
        quality_score: 0,
        resolved_at: ''
      },
      tags: [],
      ontology_tags: []
    };
  }

  const existingAttempts = Array.isArray(incident.attempts) ? incident.attempts : [];
  const attemptNo = existingAttempts.length + 1;
  const attemptSignature = createIncidentAttemptSignature(payload);
  const duplicateOf = existingAttempts.find((item) => normalizeText(item.signature) === attemptSignature);
  const attempt = {
    id: createIncidentAttemptId(),
    attempt_no: attemptNo,
    recorded_at: currentTime,
    signature: attemptSignature,
    duplicate_of_attempt_no: duplicateOf ? Number(duplicateOf.attempt_no || 0) : 0,
    entry_status: normalizeStatus(entry.status, 'candidate'),
    quality_score: Number(entry.quality_score || scoreQuality(entry)),
    root_cause: normalizeText(payload.root_cause || entry.root_cause),
    fix_actions: normalizeStringList(payload.fix_actions || entry.fix_actions),
    verification_evidence: normalizeStringList(payload.verification_evidence || entry.verification_evidence),
    tags: normalizeStringList(payload.tags || entry.tags),
    ontology_tags: normalizeOntologyTags(payload.ontology_tags || entry.ontology_tags),
    notes: normalizeText(payload.notes || entry.notes),
    attempt_contract: {
      hypothesis: normalizeText(payload?.attempt_contract?.hypothesis || entry?.attempt_contract?.hypothesis),
      change_points: normalizeStringList(payload?.attempt_contract?.change_points || entry?.attempt_contract?.change_points),
      verification_result: normalizeText(
        payload?.attempt_contract?.verification_result || entry?.attempt_contract?.verification_result
      ),
      rollback_point: normalizeText(payload?.attempt_contract?.rollback_point || entry?.attempt_contract?.rollback_point),
      conclusion: normalizeText(payload?.attempt_contract?.conclusion || entry?.attempt_contract?.conclusion)
    },
    source: {
      spec: normalizeText(payload?.source?.spec || entry?.source?.spec),
      files: normalizeStringList(payload?.source?.files || entry?.source?.files),
      tests: normalizeStringList(payload?.source?.tests || entry?.source?.tests)
    }
  };

  incident.attempts = [...existingAttempts, attempt];
  incident.attempt_count = incident.attempts.length;
  incident.title = title || incident.title;
  incident.symptom = symptom || incident.symptom;
  incident.tags = normalizeStringList(incident.tags, attempt.tags);
  incident.ontology_tags = normalizeOntologyTags(incident.ontology_tags, attempt.ontology_tags);
  incident.last_attempt_at = currentTime;
  incident.updated_at = currentTime;

  const resolveIncident = shouldResolveIncidentByStatus(entry.status);
  if (resolveIncident) {
    incident.state = 'resolved';
    incident.resolved_at = currentTime;
    incident.resolution = {
      entry_id: normalizeText(entry.id),
      status: normalizeStatus(entry.status, 'candidate'),
      quality_score: Number(entry.quality_score || scoreQuality(entry)),
      resolved_at: currentTime
    };
  } else {
    incident.state = 'open';
    incident.resolved_at = '';
    incident.resolution = {
      entry_id: '',
      status: '',
      quality_score: 0,
      resolved_at: ''
    };
  }

  await writeIncident(paths, incident, fileSystem);
  if (incident.state === 'resolved') {
    const resolvedSnapshotPath = buildIncidentResolvedSnapshotPath(paths, incident.id);
    await fileSystem.ensureDir(path.dirname(resolvedSnapshotPath));
    await fileSystem.writeJson(resolvedSnapshotPath, incident, { spaces: 2 });
  }

  const summary = createIncidentSummaryFromIncident(incident);
  const summaryIndex = incidentIndex.incidents.findIndex((item) => item.id === summary.id);
  if (summaryIndex >= 0) {
    incidentIndex.incidents[summaryIndex] = summary;
  } else {
    incidentIndex.incidents.push(summary);
  }
  incidentIndex.incidents.sort((left, right) => `${right.updated_at || ''}`.localeCompare(`${left.updated_at || ''}`));
  await writeIncidentIndex(paths, incidentIndex, fileSystem);

  return {
    incident: summary,
    latest_attempt: {
      id: attempt.id,
      attempt_no: attempt.attempt_no,
      duplicate_of_attempt_no: attempt.duplicate_of_attempt_no,
      signature: attempt.signature
    }
  };
}

function scoreQuality(entry = {}) {
  let score = 0;

  if (normalizeText(entry.title)) {
    score += 10;
  }
  if (normalizeText(entry.symptom)) {
    score += 10;
  }
  if (normalizeText(entry.fingerprint)) {
    score += 10;
  }
  if (normalizeText(entry.root_cause)) {
    score += 20;
  }
  if (Array.isArray(entry.fix_actions) && entry.fix_actions.length > 0) {
    score += 20;
  }
  if (Array.isArray(entry.verification_evidence) && entry.verification_evidence.length > 0) {
    score += 20;
  }
  if (Array.isArray(entry.ontology_tags) && entry.ontology_tags.length > 0) {
    score += 5;
  }
  if (Array.isArray(entry.tags) && entry.tags.length > 0) {
    score += 3;
  }
  if (normalizeText(entry.symptom).length >= 24 && normalizeText(entry.root_cause).length >= 24) {
    score += 2;
  }
  const attemptContract = entry && typeof entry.attempt_contract === 'object'
    ? entry.attempt_contract
    : {};
  const attemptContractComplete = Boolean(
    normalizeText(attemptContract.hypothesis)
    && normalizeStringList(attemptContract.change_points).length > 0
    && normalizeText(attemptContract.verification_result)
    && normalizeText(attemptContract.rollback_point)
    && normalizeText(attemptContract.conclusion)
  );
  if (attemptContractComplete) {
    score += 5;
  }

  return Math.max(0, Math.min(100, score));
}

function validateRecordPayload(payload) {
  if (!normalizeText(payload.title)) {
    throw new Error('--title is required');
  }
  if (!normalizeText(payload.symptom)) {
    throw new Error('--symptom is required');
  }
  if (!normalizeText(payload.root_cause)) {
    throw new Error('--root-cause is required');
  }
  if (!Array.isArray(payload.fix_actions) || payload.fix_actions.length === 0) {
    throw new Error('at least one --fix-action is required');
  }
  const attemptContract = payload.attempt_contract && typeof payload.attempt_contract === 'object'
    ? payload.attempt_contract
    : {};
  if (!normalizeText(attemptContract.hypothesis)) {
    throw new Error('attempt contract requires hypothesis');
  }
  if (!Array.isArray(attemptContract.change_points) || attemptContract.change_points.length === 0) {
    throw new Error('attempt contract requires change_points');
  }
  if (!normalizeText(attemptContract.verification_result)) {
    throw new Error('attempt contract requires verification_result');
  }
  if (!normalizeText(attemptContract.rollback_point)) {
    throw new Error('attempt contract requires rollback_point');
  }
  if (!normalizeText(attemptContract.conclusion)) {
    throw new Error('attempt contract requires conclusion');
  }

  const status = normalizeStatus(payload.status, 'candidate');
  if (status === 'promoted') {
    throw new Error('record does not accept status=promoted. Use "sce errorbook promote <id>"');
  }
  if (status === 'verified' && (!Array.isArray(payload.verification_evidence) || payload.verification_evidence.length === 0)) {
    throw new Error('status=verified requires at least one --verification evidence');
  }
  const mitigation = normalizeExistingTemporaryMitigation(payload.temporary_mitigation);
  if (mitigation.enabled) {
    if (!normalizeText(mitigation.exit_criteria)) {
      throw new Error('temporary mitigation requires --mitigation-exit');
    }
    if (!normalizeText(mitigation.cleanup_task)) {
      throw new Error('temporary mitigation requires --mitigation-cleanup');
    }
    if (!normalizeText(mitigation.deadline_at)) {
      throw new Error('temporary mitigation requires --mitigation-deadline');
    }
  }
}

function hasDebugEvidenceSignals(entry = {}) {
  const tags = normalizeStringList(entry.tags).map((item) => item.toLowerCase());
  if (tags.some((tag) => DEBUG_EVIDENCE_TAGS.includes(tag))) {
    return true;
  }

  const verificationEvidence = normalizeStringList(entry.verification_evidence);
  if (verificationEvidence.some((item) => /^debug:/i.test(item))) {
    return true;
  }

  const sourceFiles = normalizeStringList(entry?.source?.files);
  if (sourceFiles.some((item) => /(^|[\\/._-])(debug|trace|diagnostic|observability|telemetry|stack)/i.test(item))) {
    return true;
  }

  const notes = normalizeText(entry.notes).toLowerCase();
  if (notes && /(debug|trace|diagnostic|observability|telemetry|stack|日志|埋点|观测)/i.test(notes)) {
    return true;
  }

  return false;
}

function enforceDebugEvidenceAfterRepeatedFailures(entry = {}, options = {}) {
  const attemptCount = Number(options.attemptCount || 0);
  if (!Number.isFinite(attemptCount) || attemptCount < 3) {
    return;
  }
  if (hasDebugEvidenceSignals(entry)) {
    return;
  }
  throw new Error(
    'two failed fix rounds detected (attempt #3+): debug evidence is required. '
    + 'Provide --verification "debug: ...", add tag debug-evidence, or include debug trace/log file references.'
  );
}

function normalizeRecordPayload(options = {}, fromFilePayload = {}) {
  const temporaryMitigation = normalizeTemporaryMitigation(options, fromFilePayload);
  const payload = {
    title: normalizeText(options.title || fromFilePayload.title),
    symptom: normalizeText(options.symptom || fromFilePayload.symptom),
    root_cause: normalizeText(options.rootCause || options.root_cause || fromFilePayload.root_cause || fromFilePayload.rootCause),
    fix_actions: normalizeStringList(fromFilePayload.fix_actions, fromFilePayload.fixActions, options.fixAction, options.fixActions),
    verification_evidence: normalizeStringList(
      fromFilePayload.verification_evidence,
      fromFilePayload.verificationEvidence,
      options.verification,
      options.verificationEvidence
    ),
    tags: normalizeStringList(
      fromFilePayload.tags,
      options.tags,
      temporaryMitigation.enabled ? TEMPORARY_MITIGATION_TAG : []
    ),
    ontology_tags: normalizeOntologyTags(fromFilePayload.ontology_tags, fromFilePayload.ontology, options.ontology),
    status: normalizeStatus(options.status || fromFilePayload.status || 'candidate'),
    source: {
      spec: normalizeText(options.spec || fromFilePayload?.source?.spec),
      files: normalizeStringList(fromFilePayload?.source?.files, options.files),
      tests: normalizeStringList(fromFilePayload?.source?.tests, options.tests)
    },
    temporary_mitigation: temporaryMitigation,
    notes: normalizeText(options.notes || fromFilePayload.notes),
    fingerprint: createFingerprint({
      fingerprint: options.fingerprint || fromFilePayload.fingerprint,
      title: options.title || fromFilePayload.title,
      symptom: options.symptom || fromFilePayload.symptom,
      root_cause: options.rootCause || options.root_cause || fromFilePayload.root_cause || fromFilePayload.rootCause
    })
  };

  const attemptContractFromFile = fromFilePayload && typeof fromFilePayload.attempt_contract === 'object'
    ? fromFilePayload.attempt_contract
    : {};
  payload.attempt_contract = {
    hypothesis: normalizeText(
      options.attemptHypothesis
      || attemptContractFromFile.hypothesis
      || payload.root_cause
    ),
    change_points: normalizeStringList(
      options.attemptChangePoints,
      attemptContractFromFile.change_points,
      attemptContractFromFile.changePoints,
      payload.fix_actions
    ),
    verification_result: normalizeText(
      options.attemptVerificationResult
      || attemptContractFromFile.verification_result
      || attemptContractFromFile.verificationResult
      || (payload.verification_evidence[0] || '')
      || 'pending-verification'
    ),
    rollback_point: normalizeText(
      options.attemptRollbackPoint
      || attemptContractFromFile.rollback_point
      || attemptContractFromFile.rollbackPoint
      || 'not-required'
    ),
    conclusion: normalizeText(
      options.attemptConclusion
      || attemptContractFromFile.conclusion
      || payload.notes
      || payload.root_cause
    )
  };

  return payload;
}

function createEntryId() {
  return `eb-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function buildIndexSummary(entry) {
  const mitigation = normalizeExistingTemporaryMitigation(entry.temporary_mitigation);
  const mitigationActive = mitigation.enabled && !normalizeText(mitigation.resolved_at);
  return {
    id: entry.id,
    fingerprint: entry.fingerprint,
    title: entry.title,
    status: entry.status,
    quality_score: entry.quality_score,
    tags: entry.tags,
    ontology_tags: entry.ontology_tags,
    temporary_mitigation_active: mitigationActive,
    temporary_mitigation_deadline_at: mitigationActive ? normalizeText(mitigation.deadline_at) : '',
    occurrences: entry.occurrences || 1,
    created_at: entry.created_at,
    updated_at: entry.updated_at
  };
}

function findSummaryById(index, id) {
  const normalized = normalizeText(id);
  if (!normalized) {
    return null;
  }

  const exact = index.entries.find((item) => item.id === normalized);
  if (exact) {
    return exact;
  }

  const startsWith = index.entries.filter((item) => item.id.startsWith(normalized));
  if (startsWith.length === 1) {
    return startsWith[0];
  }
  if (startsWith.length > 1) {
    throw new Error(`entry id prefix "${normalized}" is ambiguous (${startsWith.length} matches)`);
  }
  return null;
}

function mergeEntry(existingEntry, incomingPayload) {
  const temporaryMitigation = resolveMergedTemporaryMitigation(existingEntry, incomingPayload);
  const mergedTags = normalizeStringList(
    existingEntry.tags,
    incomingPayload.tags,
    temporaryMitigation.enabled ? TEMPORARY_MITIGATION_TAG : []
  );
  const merged = {
    ...existingEntry,
    title: normalizeText(incomingPayload.title) || existingEntry.title,
    symptom: normalizeText(incomingPayload.symptom) || existingEntry.symptom,
    root_cause: normalizeText(incomingPayload.root_cause) || existingEntry.root_cause,
    fix_actions: normalizeStringList(existingEntry.fix_actions, incomingPayload.fix_actions),
    verification_evidence: normalizeStringList(existingEntry.verification_evidence, incomingPayload.verification_evidence),
    tags: mergedTags,
    ontology_tags: normalizeOntologyTags(existingEntry.ontology_tags, incomingPayload.ontology_tags),
    status: selectStatus(existingEntry.status, incomingPayload.status),
    notes: normalizeText(incomingPayload.notes) || existingEntry.notes || '',
    attempt_contract: {
      hypothesis: normalizeText(incomingPayload?.attempt_contract?.hypothesis)
        || normalizeText(existingEntry?.attempt_contract?.hypothesis)
        || normalizeText(incomingPayload.root_cause)
        || normalizeText(existingEntry.root_cause),
      change_points: normalizeStringList(
        existingEntry?.attempt_contract?.change_points,
        incomingPayload?.attempt_contract?.change_points,
        incomingPayload.fix_actions
      ),
      verification_result: normalizeText(incomingPayload?.attempt_contract?.verification_result)
        || normalizeText(existingEntry?.attempt_contract?.verification_result)
        || normalizeStringList(incomingPayload.verification_evidence, existingEntry.verification_evidence)[0]
        || '',
      rollback_point: normalizeText(incomingPayload?.attempt_contract?.rollback_point)
        || normalizeText(existingEntry?.attempt_contract?.rollback_point)
        || 'not-required',
      conclusion: normalizeText(incomingPayload?.attempt_contract?.conclusion)
        || normalizeText(existingEntry?.attempt_contract?.conclusion)
        || normalizeText(incomingPayload.notes)
        || normalizeText(existingEntry.notes)
        || normalizeText(incomingPayload.root_cause)
        || normalizeText(existingEntry.root_cause)
    },
    source: {
      spec: normalizeText(incomingPayload?.source?.spec) || normalizeText(existingEntry?.source?.spec),
      files: normalizeStringList(existingEntry?.source?.files, incomingPayload?.source?.files),
      tests: normalizeStringList(existingEntry?.source?.tests, incomingPayload?.source?.tests)
    },
    temporary_mitigation: temporaryMitigation,
    occurrences: Number(existingEntry.occurrences || 1) + 1,
    updated_at: nowIso()
  };
  merged.quality_score = scoreQuality(merged);
  return merged;
}

async function loadRecordPayloadFromFile(projectPath, sourcePath, fileSystem = fs) {
  const normalized = normalizeText(sourcePath);
  if (!normalized) {
    return {};
  }

  const absolutePath = path.isAbsolute(normalized)
    ? normalized
    : path.join(projectPath, normalized);

  if (!await fileSystem.pathExists(absolutePath)) {
    throw new Error(`record source file not found: ${sourcePath}`);
  }

  try {
    const payload = await fileSystem.readJson(absolutePath);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('record source JSON must be an object');
    }
    return payload;
  } catch (error) {
    throw new Error(`failed to parse record source file (${sourcePath}): ${error.message}`);
  }
}

function normalizeStatusList(values = [], fallback = ['promoted']) {
  const raw = Array.isArray(values) ? values : normalizeStringList(values);
  const list = raw.length > 0 ? raw : fallback;
  const normalized = list
    .map((item) => normalizeText(item).toLowerCase())
    .filter(Boolean);
  const unique = Array.from(new Set(normalized));
  for (const status of unique) {
    if (!ERRORBOOK_STATUSES.includes(status)) {
      throw new Error(`invalid status in list: ${status}`);
    }
  }
  return unique;
}

function normalizeRegistrySource(input = {}) {
  const candidate = input || {};
  const name = normalizeText(candidate.name) || 'default';
  const url = normalizeText(candidate.url || candidate.source);
  const file = normalizeText(candidate.file || candidate.path);
  const source = url || file;
  const indexUrl = normalizeText(candidate.index_url || candidate.indexUrl || candidate.registry_index || candidate.registryIndex);
  return {
    name,
    source,
    index_url: indexUrl,
    enabled: candidate.enabled !== false
  };
}

function normalizeRegistryMode(value, fallback = 'cache') {
  const normalized = normalizeText(`${value || ''}`).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['cache', 'remote', 'hybrid'].includes(normalized)) {
    return normalized;
  }
  throw new Error('registry mode must be one of: cache, remote, hybrid');
}

async function readErrorbookRegistryConfig(paths, fileSystem = fs) {
  const fallback = {
    enabled: false,
    search_mode: 'cache',
    cache_file: DEFAULT_ERRORBOOK_REGISTRY_CACHE,
    sources: []
  };
  if (!await fileSystem.pathExists(paths.configFile)) {
    return fallback;
  }
  const payload = await fileSystem.readJson(paths.configFile).catch(() => null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return fallback;
  }
  const sources = Array.isArray(payload.sources)
    ? payload.sources.map((item) => normalizeRegistrySource(item)).filter((item) => item.enabled && item.source)
    : [];
  return {
    enabled: normalizeBoolean(payload.enabled, true),
    search_mode: normalizeRegistryMode(payload.search_mode || payload.searchMode, 'cache'),
    cache_file: normalizeText(payload.cache_file || payload.cacheFile || DEFAULT_ERRORBOOK_REGISTRY_CACHE),
    sources
  };
}

function isHttpSource(source = '') {
  return /^https?:\/\//i.test(normalizeText(source));
}

function fetchJsonFromHttp(source, timeoutMs = 15000) {
  const normalized = normalizeText(source);
  if (!normalized) {
    return Promise.reject(new Error('registry source is required'));
  }
  const client = normalized.startsWith('https://') ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(normalized, {
      timeout: timeoutMs,
      headers: {
        Accept: 'application/json'
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`registry source responded ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`registry source returned invalid JSON: ${error.message}`));
        }
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error('registry source request timed out'));
    });
    request.on('error', reject);
  });
}

async function loadRegistryPayload(projectPath, source, fileSystem = fs) {
  const normalized = normalizeText(source);
  if (!normalized) {
    throw new Error('registry source is required');
  }
  if (isHttpSource(normalized)) {
    return fetchJsonFromHttp(normalized);
  }
  const absolutePath = path.isAbsolute(normalized)
    ? normalized
    : path.resolve(projectPath, normalized);
  if (!await fileSystem.pathExists(absolutePath)) {
    throw new Error(`registry source file not found: ${source}`);
  }
  return fileSystem.readJson(absolutePath);
}

function normalizeRegistryEntry(entry = {}, sourceName = 'registry') {
  const title = normalizeText(entry.title || entry.name);
  const symptom = normalizeText(entry.symptom);
  const rootCause = normalizeText(entry.root_cause || entry.rootCause);
  const fingerprint = createFingerprint({
    fingerprint: normalizeText(entry.fingerprint),
    title,
    symptom,
    root_cause: rootCause
  });
  const statusRaw = normalizeText(entry.status || 'candidate').toLowerCase();
  const status = ERRORBOOK_STATUSES.includes(statusRaw) ? statusRaw : 'candidate';
  const mitigation = normalizeExistingTemporaryMitigation(entry.temporary_mitigation);

  return {
    id: normalizeText(entry.id) || `registry-${fingerprint}`,
    fingerprint,
    title,
    symptom,
    root_cause: rootCause,
    fix_actions: normalizeStringList(entry.fix_actions, entry.fixActions),
    verification_evidence: normalizeStringList(entry.verification_evidence, entry.verificationEvidence),
    tags: normalizeStringList(entry.tags, mitigation.enabled ? TEMPORARY_MITIGATION_TAG : []),
    ontology_tags: normalizeOntologyTags(entry.ontology_tags),
    status,
    quality_score: Number.isFinite(Number(entry.quality_score)) ? Number(entry.quality_score) : scoreQuality(entry),
    updated_at: normalizeIsoTimestamp(entry.updated_at || entry.updatedAt, 'registry.updated_at') || nowIso(),
    source: {
      ...entry.source,
      registry: sourceName
    },
    temporary_mitigation: mitigation,
    entry_source: 'registry'
  };
}

function extractRegistryEntries(payload = {}, sourceName = 'registry') {
  const rawEntries = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.entries)
      ? payload.entries
      : [];
  const normalized = [];
  for (const item of rawEntries) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const entry = normalizeRegistryEntry(item, sourceName);
    if (!entry.title || !entry.fingerprint) {
      continue;
    }
    normalized.push(entry);
  }
  const deduped = new Map();
  for (const entry of normalized) {
    const key = entry.fingerprint;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, entry);
      continue;
    }
    if ((Number(entry.quality_score) || 0) >= (Number(existing.quality_score) || 0)) {
      deduped.set(key, entry);
    }
  }
  return Array.from(deduped.values());
}

async function loadRegistryCache(projectPath, cachePathInput = '', fileSystem = fs) {
  const cachePath = resolveProjectPath(projectPath, cachePathInput, DEFAULT_ERRORBOOK_REGISTRY_CACHE);
  if (!await fileSystem.pathExists(cachePath)) {
    return {
      cache_path: cachePath,
      entries: []
    };
  }
  const payload = await fileSystem.readJson(cachePath).catch(() => null);
  const entries = extractRegistryEntries(payload || {}, 'registry-cache');
  return {
    cache_path: cachePath,
    entries
  };
}

function tokenizeQueryText(query = '') {
  return normalizeText(query)
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function normalizeRegistryIndex(payload = {}, sourceName = '') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  return {
    api_version: normalizeText(payload.api_version || payload.version || ERRORBOOK_REGISTRY_INDEX_API_VERSION),
    source_name: sourceName || normalizeText(payload.source_name || payload.sourceName),
    min_token_length: Number.isFinite(Number(payload.min_token_length))
      ? Number(payload.min_token_length)
      : 2,
    token_to_source: payload.token_to_source && typeof payload.token_to_source === 'object'
      ? payload.token_to_source
      : {},
    token_to_bucket: payload.token_to_bucket && typeof payload.token_to_bucket === 'object'
      ? payload.token_to_bucket
      : {},
    buckets: payload.buckets && typeof payload.buckets === 'object'
      ? payload.buckets
      : {},
    default_source: normalizeText(payload.default_source || payload.fallback_source || '')
  };
}

function collectRegistryShardSources(indexPayload, queryTokens = [], maxShards = 8) {
  const index = normalizeRegistryIndex(indexPayload);
  if (!index) {
    return [];
  }
  const sources = [];
  const minTokenLength = Number.isFinite(index.min_token_length) ? index.min_token_length : 2;
  for (const token of queryTokens) {
    const normalizedToken = normalizeText(token).toLowerCase();
    if (!normalizedToken || normalizedToken.length < minTokenLength) {
      continue;
    }
    const direct = index.token_to_source[normalizedToken];
    if (direct) {
      const items = Array.isArray(direct) ? direct : [direct];
      for (const item of items) {
        sources.push(normalizeText(item));
      }
      continue;
    }
    const bucket = normalizeText(index.token_to_bucket[normalizedToken]);
    if (!bucket) {
      continue;
    }
    const bucketSource = normalizeText(index.buckets[bucket] || index.buckets[normalizedToken]);
    if (bucketSource) {
      sources.push(bucketSource);
    }
  }

  const deduped = Array.from(new Set(sources.filter(Boolean)));
  if (deduped.length > 0) {
    return Number.isFinite(Number(maxShards)) && Number(maxShards) > 0
      ? deduped.slice(0, Number(maxShards))
      : deduped;
  }
  if (index.default_source) {
    return [index.default_source];
  }
  return [];
}

async function searchRegistryRemote(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const source = normalizeRegistrySource(options.source || {});
  const query = normalizeText(options.query);
  const queryTokens = Array.isArray(options.queryTokens) ? options.queryTokens : tokenizeQueryText(query);
  const requestedStatus = options.requestedStatus || null;
  const maxShards = Number.isFinite(Number(options.maxShards)) ? Number(options.maxShards) : 8;
  const allowRemoteFullscan = options.allowRemoteFullscan === true;

  if (!source.source) {
    return {
      source_name: source.name || 'registry',
      shard_sources: [],
      matched_count: 0,
      candidates: [],
      warnings: ['registry source is empty']
    };
  }

  const warnings = [];
  let shardSources = [];
  if (source.index_url) {
    try {
      const indexPayload = await loadRegistryPayload(projectPath, source.index_url, fileSystem);
      shardSources = collectRegistryShardSources(indexPayload, queryTokens, maxShards);
    } catch (error) {
      warnings.push(`failed to load registry index (${source.index_url}): ${error.message}`);
    }
  }

  if (shardSources.length === 0) {
    if (allowRemoteFullscan) {
      shardSources = [source.source];
      warnings.push('remote index unavailable; fallback to full-source scan');
    } else {
      warnings.push('remote index unavailable and full-source scan disabled');
      return {
        source_name: source.name || 'registry',
        shard_sources: [],
        matched_count: 0,
        candidates: [],
        warnings
      };
    }
  }

  const candidates = [];
  for (const shardSource of shardSources) {
    try {
      const payload = await loadRegistryPayload(projectPath, shardSource, fileSystem);
      const entries = extractRegistryEntries(payload, source.name || 'registry');
      for (const entry of entries) {
        if (requestedStatus && normalizeStatus(entry.status, 'candidate') !== requestedStatus) {
          continue;
        }
        const matchScore = scoreSearchMatch(entry, queryTokens);
        if (matchScore <= 0) {
          continue;
        }
        candidates.push({
          id: entry.id,
          entry_source: 'registry-remote',
          registry_source: source.name || 'registry',
          status: entry.status,
          quality_score: entry.quality_score,
          title: entry.title,
          fingerprint: entry.fingerprint,
          tags: normalizeStringList(entry.tags),
          ontology_tags: normalizeOntologyTags(entry.ontology_tags),
          match_score: matchScore,
          updated_at: entry.updated_at
        });
      }
    } catch (error) {
      warnings.push(`failed to load registry shard (${shardSource}): ${error.message}`);
    }
  }

  const deduped = new Map();
  for (const item of candidates) {
    const key = normalizeText(item.fingerprint || item.id);
    const existing = deduped.get(key);
    if (!existing || Number(item.match_score || 0) >= Number(existing.match_score || 0)) {
      deduped.set(key, item);
    }
  }

  return {
    source_name: source.name || 'registry',
    shard_sources: shardSources,
    matched_count: deduped.size,
    candidates: Array.from(deduped.values()),
    warnings
  };
}

function printRecordSummary(result) {
  const action = result.created ? 'Recorded new entry' : 'Updated duplicate fingerprint';
  console.log(chalk.green(`✓ ${action}`));
  console.log(chalk.gray(`  id: ${result.entry.id}`));
  console.log(chalk.gray(`  status: ${result.entry.status}`));
  console.log(chalk.gray(`  quality: ${result.entry.quality_score}`));
  console.log(chalk.gray(`  fingerprint: ${result.entry.fingerprint}`));
}

function printListSummary(payload) {
  if (payload.entries.length === 0) {
    console.log(chalk.gray('No errorbook entries found'));
    return;
  }

  const table = new Table({
    head: ['ID', 'Status', 'Quality', 'Title', 'Updated', 'Occurrences'].map((item) => chalk.cyan(item)),
    colWidths: [16, 12, 10, 44, 22, 12]
  });

  payload.entries.forEach((entry) => {
    table.push([
      entry.id,
      entry.status,
      entry.quality_score,
      entry.title.length > 40 ? `${entry.title.slice(0, 40)}...` : entry.title,
      entry.updated_at,
      entry.occurrences || 1
    ]);
  });

  console.log(table.toString());
  console.log(chalk.gray(`Total: ${payload.total_results} (stored: ${payload.total_entries})`));
}

function scoreSearchMatch(entry, queryTokens) {
  const title = normalizeText(entry.title).toLowerCase();
  const symptom = normalizeText(entry.symptom).toLowerCase();
  const rootCause = normalizeText(entry.root_cause).toLowerCase();
  const fingerprint = normalizeText(entry.fingerprint).toLowerCase();
  const tagText = normalizeStringList(entry.tags, entry.ontology_tags).join(' ').toLowerCase();
  const fixText = normalizeStringList(entry.fix_actions).join(' ').toLowerCase();

  let score = 0;
  for (const token of queryTokens) {
    if (!token) {
      continue;
    }
    if (title.includes(token)) {
      score += 8;
    }
    if (symptom.includes(token)) {
      score += 5;
    }
    if (rootCause.includes(token)) {
      score += 5;
    }
    if (fixText.includes(token)) {
      score += 3;
    }
    if (tagText.includes(token)) {
      score += 2;
    }
    if (fingerprint.includes(token)) {
      score += 1;
    }
  }

  score += (Number(entry.quality_score) || 0) / 20;
  score += STATUS_RANK[entry.status] || 0;
  return Number(score.toFixed(3));
}

function normalizeRiskLevel(value, fallback = 'high') {
  const normalized = normalizeText(`${value || ''}`).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (!ERRORBOOK_RISK_LEVELS.includes(normalized)) {
    throw new Error(`risk level must be one of: ${ERRORBOOK_RISK_LEVELS.join(', ')}`);
  }
  return normalized;
}

function riskRank(level) {
  const normalized = normalizeRiskLevel(level, 'high');
  if (normalized === 'high') {
    return 3;
  }
  if (normalized === 'medium') {
    return 2;
  }
  return 1;
}

function evaluateEntryRisk(entry = {}) {
  const status = normalizeStatus(entry.status, 'candidate');
  if (status === 'promoted' || status === 'deprecated') {
    return 'low';
  }

  const qualityScore = Number(entry.quality_score || 0);
  const tags = normalizeStringList(entry.tags).map((item) => item.toLowerCase());
  const ontologyTags = normalizeOntologyTags(entry.ontology_tags);
  const hasHighRiskTag = tags.some((tag) => HIGH_RISK_SIGNAL_TAGS.includes(tag));

  if (hasHighRiskTag) {
    return 'high';
  }
  if (status === 'candidate' && qualityScore > 85) {
    return 'high';
  }
  if (status === 'candidate' && qualityScore >= 75 && ontologyTags.includes('decision_policy')) {
    return 'high';
  }
  if (status === 'candidate') {
    return 'medium';
  }
  if (qualityScore > 85 && ontologyTags.includes('decision_policy')) {
    return 'high';
  }
  return 'medium';
}

async function evaluateErrorbookReleaseGate(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const paths = resolveErrorbookPaths(projectPath);
  const index = await readErrorbookIndex(paths, fileSystem);
  const minRisk = normalizeRiskLevel(options.minRisk || options.min_risk || 'high', 'high');
  const includeVerified = options.includeVerified === true;
  const minQuality = Number.isFinite(Number(options.minQuality || options.min_quality))
    ? Math.max(0, Math.min(100, Number(options.minQuality || options.min_quality)))
    : DEFAULT_RELEASE_GATE_MIN_QUALITY;

  const inspected = [];
  const mitigationInspected = [];
  const mitigationBlocked = [];
  for (const summary of index.entries) {
    const entry = await readErrorbookEntry(paths, summary.id, fileSystem);
    if (!entry) {
      continue;
    }

    const status = normalizeStatus(entry.status, 'candidate');
    const risk = evaluateEntryRisk(entry);
    const mitigation = evaluateTemporaryMitigationPolicy(entry);
    if (mitigation) {
      const mitigationItem = {
        id: entry.id,
        title: entry.title,
        status,
        risk,
        quality_score: Number(entry.quality_score || 0),
        tags: normalizeStringList(entry.tags),
        updated_at: entry.updated_at,
        temporary_mitigation: mitigation
      };
      mitigationInspected.push(mitigationItem);
      if (Array.isArray(mitigation.policy_violations) && mitigation.policy_violations.length > 0) {
        mitigationBlocked.push({
          ...mitigationItem,
          block_reasons: ['temporary_mitigation_policy'],
          policy_violations: mitigation.policy_violations
        });
      }
    }

    const unresolved = status === 'candidate' || (includeVerified && status === 'verified');
    if (!unresolved) {
      continue;
    }

    inspected.push({
      id: entry.id,
      title: entry.title,
      status,
      risk,
      quality_score: Number(entry.quality_score || 0),
      tags: normalizeStringList(entry.tags),
      updated_at: entry.updated_at
    });
  }

  const riskBlocked = inspected
    .filter((item) => riskRank(item.risk) >= riskRank(minRisk))
    .map((item) => ({
      ...item,
      block_reasons: ['risk_threshold']
    }));

  const curationBlocked = inspected
    .filter((item) => item.status === 'verified' && Number(item.quality_score || 0) < minQuality)
    .map((item) => ({
      ...item,
      block_reasons: ['curation_quality'],
      policy_violations: [`quality_score<${minQuality}`]
    }));

  const blockedById = new Map();
  for (const item of riskBlocked) {
    blockedById.set(item.id, {
      ...item,
      policy_violations: []
    });
  }
  for (const item of mitigationBlocked) {
    const existing = blockedById.get(item.id);
    if (!existing) {
      blockedById.set(item.id, {
        ...item,
        policy_violations: Array.isArray(item.policy_violations) ? item.policy_violations : []
      });
      continue;
    }
    existing.block_reasons = normalizeStringList(existing.block_reasons, item.block_reasons);
    existing.policy_violations = normalizeStringList(existing.policy_violations, item.policy_violations);
    if (!existing.temporary_mitigation && item.temporary_mitigation) {
      existing.temporary_mitigation = item.temporary_mitigation;
    }
    blockedById.set(existing.id, existing);
  }
  for (const item of curationBlocked) {
    const existing = blockedById.get(item.id);
    if (!existing) {
      blockedById.set(item.id, {
        ...item,
        policy_violations: normalizeStringList(item.policy_violations)
      });
      continue;
    }
    existing.block_reasons = normalizeStringList(existing.block_reasons, item.block_reasons);
    existing.policy_violations = normalizeStringList(existing.policy_violations, item.policy_violations);
    blockedById.set(existing.id, existing);
  }

  const blocked = Array.from(blockedById.values())
    .sort((left, right) => {
      const mitigationDiff = Number((right.policy_violations || []).length > 0) - Number((left.policy_violations || []).length > 0);
      if (mitigationDiff !== 0) {
        return mitigationDiff;
      }
      const riskDiff = riskRank(right.risk) - riskRank(left.risk);
      if (riskDiff !== 0) {
        return riskDiff;
      }
      const qualityDiff = Number(right.quality_score || 0) - Number(left.quality_score || 0);
      if (qualityDiff !== 0) {
        return qualityDiff;
      }
      return `${right.updated_at || ''}`.localeCompare(`${left.updated_at || ''}`);
    });

  return {
    mode: 'errorbook-release-gate',
    gate: {
      min_risk: minRisk,
      min_quality: minQuality,
      include_verified: includeVerified,
      mitigation_policy_enforced: true
    },
    passed: blocked.length === 0,
    inspected_count: inspected.length,
    risk_blocked_count: riskBlocked.length,
    curation_blocked_count: curationBlocked.length,
    mitigation_inspected_count: mitigationInspected.length,
    mitigation_blocked_count: mitigationBlocked.length,
    blocked_count: blocked.length,
    blocked_entries: blocked
  };
}

function validatePromoteCandidate(entry, minQuality = DEFAULT_PROMOTE_MIN_QUALITY) {
  const missing = [];
  if (!normalizeText(entry.root_cause)) {
    missing.push('root_cause');
  }
  if (!Array.isArray(entry.fix_actions) || entry.fix_actions.length === 0) {
    missing.push('fix_actions');
  }
  if (!Array.isArray(entry.verification_evidence) || entry.verification_evidence.length === 0) {
    missing.push('verification_evidence');
  }
  if (!Array.isArray(entry.ontology_tags) || entry.ontology_tags.length === 0) {
    missing.push('ontology_tags');
  }
  if ((Number(entry.quality_score) || 0) < minQuality) {
    missing.push(`quality_score>=${minQuality}`);
  }
  if (entry.status === 'deprecated') {
    missing.push('status!=deprecated');
  }
  return missing;
}

async function runErrorbookRecordCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const paths = resolveErrorbookPaths(projectPath);

  const fromFilePayload = await loadRecordPayloadFromFile(projectPath, options.from, fileSystem);
  const normalized = normalizeRecordPayload(options, fromFilePayload);
  validateRecordPayload(normalized);

  const index = await readErrorbookIndex(paths, fileSystem);
  const existingSummary = index.entries.find((entry) => entry.fingerprint === normalized.fingerprint);
  const timestamp = nowIso();

  let entry;
  let created = false;
  let deduplicated = false;

  if (existingSummary) {
    const existingEntry = await readErrorbookEntry(paths, existingSummary.id, fileSystem);
    if (!existingEntry) {
      throw new Error(`errorbook index references missing entry: ${existingSummary.id}`);
    }
    entry = mergeEntry(existingEntry, normalized);
    enforceDebugEvidenceAfterRepeatedFailures(entry, {
      attemptCount: Number(entry.occurrences || 0)
    });
    deduplicated = true;
  } else {
    const temporaryMitigation = normalizeExistingTemporaryMitigation(normalized.temporary_mitigation);
    const mitigationPayload = temporaryMitigation.enabled
      ? {
        ...temporaryMitigation,
        created_at: nowIso(),
        updated_at: nowIso(),
        resolved_at: ''
      }
      : { enabled: false };
    entry = {
      api_version: ERRORBOOK_ENTRY_API_VERSION,
      id: createEntryId(),
      created_at: timestamp,
      updated_at: timestamp,
      fingerprint: normalized.fingerprint,
      title: normalized.title,
      symptom: normalized.symptom,
      root_cause: normalized.root_cause,
      fix_actions: normalized.fix_actions,
      verification_evidence: normalized.verification_evidence,
      tags: normalized.tags,
      ontology_tags: normalized.ontology_tags,
      status: normalized.status,
      source: normalized.source,
      temporary_mitigation: mitigationPayload,
      notes: normalized.notes || '',
      attempt_contract: normalized.attempt_contract,
      occurrences: 1
    };
    entry.quality_score = scoreQuality(entry);
    created = true;
  }

  entry.updated_at = nowIso();
  entry.quality_score = scoreQuality(entry);
  await writeErrorbookEntry(paths, entry, fileSystem);

  const summary = buildIndexSummary(entry);
  const summaryIndex = index.entries.findIndex((item) => item.id === summary.id);
  if (summaryIndex >= 0) {
    index.entries[summaryIndex] = summary;
  } else {
    index.entries.push(summary);
  }
  index.entries.sort((left, right) => `${right.updated_at}`.localeCompare(`${left.updated_at}`));
  await writeErrorbookIndex(paths, index, fileSystem);
  const incidentLoop = await syncIncidentLoopForRecord(paths, normalized, entry, {
    nowIso: entry.updated_at
  }, fileSystem);

  const result = {
    mode: 'errorbook-record',
    created,
    deduplicated,
    entry,
    incident_loop: incidentLoop
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!options.silent) {
    printRecordSummary(result);
  }

  return result;
}

async function runErrorbookExportCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const paths = resolveErrorbookPaths(projectPath);
  const registryPaths = resolveErrorbookRegistryPaths(projectPath, {
    exportPath: options.out
  });
  const index = await readErrorbookIndex(paths, fileSystem);

  const statuses = normalizeStatusList(options.statuses || options.status || 'promoted', ['promoted']);
  const minQuality = Number.isFinite(Number(options.minQuality))
    ? Number(options.minQuality)
    : 75;
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Number(options.limit)
    : 0;

  const selected = [];
  for (const summary of index.entries) {
    const entry = await readErrorbookEntry(paths, summary.id, fileSystem);
    if (!entry) {
      continue;
    }
    const status = normalizeStatus(entry.status, 'candidate');
    if (!statuses.includes(status)) {
      continue;
    }
    if (Number(entry.quality_score || 0) < minQuality) {
      continue;
    }
    selected.push({
      id: entry.id,
      fingerprint: entry.fingerprint,
      title: entry.title,
      symptom: entry.symptom,
      root_cause: entry.root_cause,
      fix_actions: normalizeStringList(entry.fix_actions),
      verification_evidence: normalizeStringList(entry.verification_evidence),
      tags: normalizeStringList(entry.tags),
      ontology_tags: normalizeOntologyTags(entry.ontology_tags),
      status,
      quality_score: Number(entry.quality_score || 0),
      updated_at: entry.updated_at,
      source: entry.source || {},
      temporary_mitigation: normalizeExistingTemporaryMitigation(entry.temporary_mitigation)
    });
  }

  selected.sort((left, right) => {
    const qualityDiff = Number(right.quality_score || 0) - Number(left.quality_score || 0);
    if (qualityDiff !== 0) {
      return qualityDiff;
    }
    return `${right.updated_at || ''}`.localeCompare(`${left.updated_at || ''}`);
  });

  const entries = limit > 0 ? selected.slice(0, limit) : selected;
  const payload = {
    api_version: ERRORBOOK_REGISTRY_API_VERSION,
    generated_at: nowIso(),
    source: {
      project: path.basename(projectPath),
      statuses,
      min_quality: minQuality
    },
    total_entries: entries.length,
    entries
  };

  await fileSystem.ensureDir(path.dirname(registryPaths.exportFile));
  await fileSystem.writeJson(registryPaths.exportFile, payload, { spaces: 2 });

  const result = {
    mode: 'errorbook-export',
    out_file: registryPaths.exportFile,
    statuses,
    min_quality: minQuality,
    total_entries: entries.length
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!options.silent) {
    console.log(chalk.green('✓ Exported curated errorbook entries'));
    console.log(chalk.gray(`  out: ${registryPaths.exportFile}`));
    console.log(chalk.gray(`  total: ${entries.length}`));
    console.log(chalk.gray(`  statuses: ${statuses.join(', ')}`));
  }

  return result;
}

async function runErrorbookSyncRegistryCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const registryPaths = resolveErrorbookRegistryPaths(projectPath, {
    configPath: options.config,
    cachePath: options.cache
  });

  const config = await readErrorbookRegistryConfig(registryPaths, fileSystem);
  const sourceOption = normalizeText(options.source);
  const configuredSource = config.sources.find((item) => item.enabled && item.source);
  const source = sourceOption || (configuredSource ? configuredSource.source : '');
  if (!source) {
    throw new Error('registry source is required (use --source or configure .sce/config/errorbook-registry.json)');
  }
  const sourceName = normalizeText(options.sourceName)
    || (configuredSource ? configuredSource.name : '')
    || 'registry';

  const payload = await loadRegistryPayload(projectPath, source, fileSystem);
  const entries = extractRegistryEntries(payload, sourceName);
  const cachePath = resolveProjectPath(projectPath, options.cache, config.cache_file || DEFAULT_ERRORBOOK_REGISTRY_CACHE);
  const cachePayload = {
    api_version: ERRORBOOK_REGISTRY_CACHE_API_VERSION,
    synced_at: nowIso(),
    source: {
      name: sourceName,
      uri: source
    },
    total_entries: entries.length,
    entries
  };

  await fileSystem.ensureDir(path.dirname(cachePath));
  await fileSystem.writeJson(cachePath, cachePayload, { spaces: 2 });

  const result = {
    mode: 'errorbook-sync-registry',
    source,
    source_name: sourceName,
    cache_file: cachePath,
    total_entries: entries.length
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!options.silent) {
    console.log(chalk.green('✓ Synced external errorbook registry'));
    console.log(chalk.gray(`  source: ${source}`));
    console.log(chalk.gray(`  cache: ${cachePath}`));
    console.log(chalk.gray(`  entries: ${entries.length}`));
  }

  return result;
}

async function runErrorbookRegistryHealthCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const registryPaths = resolveErrorbookRegistryPaths(projectPath, {
    configPath: options.config,
    cachePath: options.cache
  });

  const warnings = [];
  const errors = [];
  const overrideSource = normalizeText(options.source);
  const overrideIndex = normalizeText(options.index || options.registryIndex);
  const overrideSourceName = normalizeText(options.sourceName || options.registrySourceName) || 'override';

  const configExists = await fileSystem.pathExists(registryPaths.configFile);
  if (configExists) {
    try {
      const rawConfig = await fileSystem.readJson(registryPaths.configFile);
      if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
        errors.push(`registry config must be a JSON object: ${registryPaths.configFile}`);
      }
    } catch (error) {
      errors.push(`failed to parse registry config (${registryPaths.configFile}): ${error.message}`);
    }
  } else if (!overrideSource) {
    errors.push(`registry config file not found: ${registryPaths.configFile}`);
  }

  const config = await readErrorbookRegistryConfig(registryPaths, fileSystem);
  let registryEnabled = normalizeBoolean(config.enabled, true);
  let sources = Array.isArray(config.sources) ? config.sources : [];

  if (overrideSource) {
    registryEnabled = true;
    sources = [normalizeRegistrySource({
      name: overrideSourceName,
      source: overrideSource,
      index_url: overrideIndex
    })];
  } else if (overrideIndex && sources.length > 0) {
    sources = sources.map((source, sourceIndex) => (
      sourceIndex === 0 ? { ...source, index_url: overrideIndex } : source
    ));
  }

  if (!registryEnabled) {
    warnings.push('registry config is disabled');
  }
  if (registryEnabled && sources.length === 0) {
    errors.push('registry enabled but no sources configured');
  }

  const maxShards = Number.isFinite(Number(options.maxShards)) && Number(options.maxShards) > 0
    ? Number(options.maxShards)
    : 8;
  const shardSample = Number.isFinite(Number(options.shardSample)) && Number(options.shardSample) > 0
    ? Number(options.shardSample)
    : 2;

  const sourceResults = [];
  for (const source of sources) {
    const sourceName = normalizeText(source.name) || 'registry';
    const sourceReport = {
      source_name: sourceName,
      source: normalizeText(source.source),
      index_url: normalizeText(source.index_url),
      source_ok: false,
      index_ok: null,
      shard_sources_checked: 0,
      source_entries: 0,
      shard_entries: 0,
      warnings: [],
      errors: []
    };

    if (!sourceReport.source) {
      sourceReport.errors.push('source is empty');
    } else {
      try {
        const payload = await loadRegistryPayload(projectPath, sourceReport.source, fileSystem);
        const entries = extractRegistryEntries(payload, sourceName);
        sourceReport.source_ok = true;
        sourceReport.source_entries = entries.length;
        if (entries.length === 0) {
          sourceReport.warnings.push('source returned no valid entries');
        }
      } catch (error) {
        sourceReport.errors.push(`failed to load source (${sourceReport.source}): ${error.message}`);
      }
    }

    if (!sourceReport.index_url) {
      sourceReport.warnings.push('index_url not configured; remote indexed lookup health is partially validated');
    } else {
      try {
        const indexPayload = await loadRegistryPayload(projectPath, sourceReport.index_url, fileSystem);
        const index = normalizeRegistryIndex(indexPayload, sourceName);
        if (!index) {
          sourceReport.errors.push(`invalid index payload: ${sourceReport.index_url}`);
        } else {
          sourceReport.index_ok = true;
          const tokenToBucket = index.token_to_bucket || {};
          const unresolved = [];
          for (const [token, bucketRaw] of Object.entries(tokenToBucket)) {
            const bucket = normalizeText(bucketRaw);
            if (!bucket) {
              continue;
            }
            const bucketSource = normalizeText(index.buckets[bucket] || index.buckets[token]);
            if (!bucketSource) {
              unresolved.push(`${token}->${bucket}`);
            }
          }
          if (unresolved.length > 0) {
            sourceReport.errors.push(`unresolved index bucket mappings: ${unresolved.slice(0, 10).join(', ')}`);
          }

          const sampleTokens = Object.keys(tokenToBucket).slice(0, 64);
          const shardSources = collectRegistryShardSources(index, sampleTokens, maxShards);
          sourceReport.shard_sources_checked = shardSources.length;
          if (shardSources.length === 0) {
            sourceReport.warnings.push('index resolved zero shard sources');
          }

          for (const shardSource of shardSources.slice(0, shardSample)) {
            try {
              const shardPayload = await loadRegistryPayload(projectPath, shardSource, fileSystem);
              const shardEntries = extractRegistryEntries(shardPayload, `${sourceName}-shard`);
              sourceReport.shard_entries += shardEntries.length;
            } catch (error) {
              sourceReport.errors.push(`failed to load shard (${shardSource}): ${error.message}`);
            }
          }
        }
      } catch (error) {
        sourceReport.index_ok = false;
        sourceReport.errors.push(`failed to load index (${sourceReport.index_url}): ${error.message}`);
      }
    }

    for (const message of sourceReport.warnings) {
      warnings.push(`[${sourceName}] ${message}`);
    }
    for (const message of sourceReport.errors) {
      errors.push(`[${sourceName}] ${message}`);
    }
    sourceResults.push(sourceReport);
  }

  const result = {
    mode: 'errorbook-health-registry',
    checked_at: nowIso(),
    passed: errors.length === 0,
    warning_count: warnings.length,
    error_count: errors.length,
    paths: {
      config_file: registryPaths.configFile,
      cache_file: registryPaths.cacheFile
    },
    config: {
      exists: configExists,
      enabled: registryEnabled,
      search_mode: config.search_mode || 'cache',
      source_count: sources.length
    },
    sources: sourceResults,
    warnings,
    errors
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!options.silent) {
    if (result.passed) {
      console.log(chalk.green('✓ Errorbook registry health check passed'));
    } else {
      console.log(chalk.red('✗ Errorbook registry health check failed'));
    }
    console.log(chalk.gray(`  sources: ${result.config.source_count}`));
    console.log(chalk.gray(`  warnings: ${result.warning_count}`));
    console.log(chalk.gray(`  errors: ${result.error_count}`));
  }

  if (options.failOnAlert && !result.passed) {
    throw new Error(`errorbook registry health failed: ${result.error_count} error(s)`);
  }

  return result;
}

function findIncidentSummaryById(index, id) {
  const normalized = normalizeText(id);
  if (!normalized) {
    return null;
  }
  const exact = index.incidents.find((item) => item.id === normalized);
  if (exact) {
    return exact;
  }
  const startsWith = index.incidents.filter((item) => item.id.startsWith(normalized));
  if (startsWith.length === 1) {
    return startsWith[0];
  }
  if (startsWith.length > 1) {
    throw new Error(`incident id prefix "${normalized}" is ambiguous (${startsWith.length} matches)`);
  }
  return null;
}

async function runErrorbookIncidentListCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const paths = resolveErrorbookPaths(projectPath);
  const index = await readIncidentIndex(paths, fileSystem);

  const stateFilter = normalizeText(options.state).toLowerCase();
  if (stateFilter && !['open', 'resolved'].includes(stateFilter)) {
    throw new Error('incident state must be one of: open, resolved');
  }
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Number(options.limit)
    : 20;

  let incidents = [...index.incidents];
  if (stateFilter) {
    incidents = incidents.filter((item) => normalizeIncidentState(item.state) === stateFilter);
  }
  incidents.sort((left, right) => `${right.updated_at || ''}`.localeCompare(`${left.updated_at || ''}`));

  const result = {
    mode: 'errorbook-incident-list',
    total_incidents: index.incidents.length,
    total_results: incidents.length,
    incidents: incidents.slice(0, limit)
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!options.silent) {
    if (result.incidents.length === 0) {
      console.log(chalk.gray('No staging incidents found'));
    } else {
      const table = new Table({
        head: ['ID', 'State', 'Attempts', 'Title', 'Updated'].map((item) => chalk.cyan(item)),
        colWidths: [20, 12, 10, 56, 24]
      });
      result.incidents.forEach((incident) => {
        table.push([
          incident.id,
          incident.state,
          Number(incident.attempt_count || 0),
          normalizeText(incident.title).length > 52
            ? `${normalizeText(incident.title).slice(0, 52)}...`
            : normalizeText(incident.title),
          incident.updated_at || ''
        ]);
      });
      console.log(table.toString());
      console.log(chalk.gray(`Total: ${result.total_results} (stored: ${result.total_incidents})`));
    }
  }

  return result;
}

async function runErrorbookIncidentShowCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const paths = resolveErrorbookPaths(projectPath);
  const index = await readIncidentIndex(paths, fileSystem);

  const id = normalizeText(options.id || options.incidentId);
  if (!id) {
    throw new Error('incident id is required');
  }

  const summary = findIncidentSummaryById(index, id);
  if (!summary) {
    throw new Error(`staging incident not found: ${id}`);
  }

  const incident = await readIncident(paths, summary.id, fileSystem);
  if (!incident) {
    throw new Error(`staging incident file not found: ${summary.id}`);
  }

  const result = {
    mode: 'errorbook-incident-show',
    incident
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!options.silent) {
    console.log(chalk.cyan.bold(incident.title || summary.title || summary.id));
    console.log(chalk.gray(`id: ${incident.id}`));
    console.log(chalk.gray(`state: ${incident.state}`));
    console.log(chalk.gray(`attempts: ${Number(incident.attempt_count || 0)}`));
    console.log(chalk.gray(`fingerprint: ${incident.fingerprint}`));
    console.log(chalk.gray(`updated_at: ${incident.updated_at}`));
    if (incident.state === 'resolved') {
      console.log(chalk.gray(`resolved_at: ${incident.resolved_at || '(none)'}`));
      if (incident.resolution && incident.resolution.entry_id) {
        console.log(chalk.gray(`linked_entry: ${incident.resolution.entry_id}`));
      }
    }
  }

  return result;
}

async function runErrorbookListCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const paths = resolveErrorbookPaths(projectPath);
  const index = await readErrorbookIndex(paths, fileSystem);

  const requestedStatus = options.status ? normalizeStatus(options.status) : null;
  const requestedTag = normalizeText(options.tag).toLowerCase();
  const requestedOntology = normalizeOntologyTags(options.ontology)[0] || '';
  const minQuality = Number.isFinite(Number(options.minQuality)) ? Number(options.minQuality) : null;
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Number(options.limit)
    : 20;

  let filtered = [...index.entries];
  if (requestedStatus) {
    filtered = filtered.filter((entry) => entry.status === requestedStatus);
  }
  if (requestedTag) {
    filtered = filtered.filter((entry) => normalizeStringList(entry.tags).some((tag) => tag.toLowerCase() === requestedTag));
  }
  if (requestedOntology) {
    filtered = filtered.filter((entry) => normalizeOntologyTags(entry.ontology_tags).includes(requestedOntology));
  }
  if (minQuality !== null) {
    filtered = filtered.filter((entry) => Number(entry.quality_score || 0) >= minQuality);
  }

  filtered.sort((left, right) => {
    const qualityDiff = Number(right.quality_score || 0) - Number(left.quality_score || 0);
    if (qualityDiff !== 0) {
      return qualityDiff;
    }
    return `${right.updated_at}`.localeCompare(`${left.updated_at}`);
  });

  const result = {
    mode: 'errorbook-list',
    total_entries: index.entries.length,
    total_results: filtered.length,
    entries: filtered.slice(0, limit).map((entry) => ({
      ...entry,
      tags: normalizeStringList(entry.tags),
      ontology_tags: normalizeOntologyTags(entry.ontology_tags)
    }))
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!options.silent) {
    printListSummary(result);
  }

  return result;
}

async function runErrorbookShowCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const paths = resolveErrorbookPaths(projectPath);
  const index = await readErrorbookIndex(paths, fileSystem);

  const id = normalizeText(options.id || options.entryId);
  if (!id) {
    throw new Error('entry id is required');
  }

  const summary = findSummaryById(index, id);
  if (!summary) {
    throw new Error(`errorbook entry not found: ${id}`);
  }

  const entry = await readErrorbookEntry(paths, summary.id, fileSystem);
  if (!entry) {
    throw new Error(`errorbook entry file not found: ${summary.id}`);
  }

  const result = {
    mode: 'errorbook-show',
    entry
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!options.silent) {
    const mitigation = normalizeExistingTemporaryMitigation(entry.temporary_mitigation);
    console.log(chalk.cyan.bold(entry.title));
    console.log(chalk.gray(`id: ${entry.id}`));
    console.log(chalk.gray(`status: ${entry.status}`));
    console.log(chalk.gray(`quality: ${entry.quality_score}`));
    console.log(chalk.gray(`fingerprint: ${entry.fingerprint}`));
    console.log(chalk.gray(`symptom: ${entry.symptom}`));
    console.log(chalk.gray(`root_cause: ${entry.root_cause}`));
    console.log(chalk.gray(`fix_actions: ${entry.fix_actions.join(' | ')}`));
    console.log(chalk.gray(`verification: ${entry.verification_evidence.join(' | ') || '(none)'}`));
    console.log(chalk.gray(`ontology: ${entry.ontology_tags.join(', ') || '(none)'}`));
    if (mitigation.enabled) {
      const active = !normalizeText(mitigation.resolved_at);
      console.log(chalk.gray(`temporary_mitigation: ${active ? 'active' : 'resolved'}`));
      console.log(chalk.gray(`  exit: ${mitigation.exit_criteria || '(none)'}`));
      console.log(chalk.gray(`  cleanup: ${mitigation.cleanup_task || '(none)'}`));
      console.log(chalk.gray(`  deadline: ${mitigation.deadline_at || '(none)'}`));
      if (mitigation.resolved_at) {
        console.log(chalk.gray(`  resolved_at: ${mitigation.resolved_at}`));
      }
    }
  }

  return result;
}

async function runErrorbookFindCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const paths = resolveErrorbookPaths(projectPath);
  const index = await readErrorbookIndex(paths, fileSystem);

  const query = normalizeText(options.query);
  if (!query) {
    throw new Error('--query is required');
  }

  const requestedStatus = options.status ? normalizeStatus(options.status) : null;
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Number(options.limit)
    : 10;
  const tokens = tokenizeQueryText(query);
  const includeRegistry = options.includeRegistry === true;

  const candidates = [];
  let localMatched = 0;
  let registryMatched = 0;
  let registryCacheMatched = 0;
  let registryRemoteMatched = 0;
  const registryWarnings = [];
  for (const summary of index.entries) {
    if (requestedStatus && summary.status !== requestedStatus) {
      continue;
    }
    const entry = await readErrorbookEntry(paths, summary.id, fileSystem);
    if (!entry) {
      continue;
    }
    const matchScore = scoreSearchMatch(entry, tokens);
    if (matchScore <= 0) {
      continue;
    }
    localMatched += 1;
    candidates.push({
      id: entry.id,
      entry_source: 'local',
      status: entry.status,
      quality_score: entry.quality_score,
      title: entry.title,
      fingerprint: entry.fingerprint,
      tags: normalizeStringList(entry.tags),
      ontology_tags: normalizeOntologyTags(entry.ontology_tags),
      match_score: matchScore,
      updated_at: entry.updated_at
    });
  }

  if (includeRegistry) {
    const configPaths = resolveErrorbookRegistryPaths(projectPath, {
      configPath: options.config,
      cachePath: options.registryCache
    });
    const registryConfig = await readErrorbookRegistryConfig(configPaths, fileSystem);
    const registryMode = normalizeRegistryMode(options.registryMode, registryConfig.search_mode || 'cache');
    const useCache = registryMode === 'cache' || registryMode === 'hybrid';
    const useRemote = registryMode === 'remote' || registryMode === 'hybrid';

    if (useRemote) {
      const configuredSources = Array.isArray(registryConfig.sources)
        ? registryConfig.sources.filter((item) => item.enabled && item.source)
        : [];
      const overrideSource = normalizeText(options.registrySource);
      const remoteSources = overrideSource
        ? [normalizeRegistrySource({
          name: normalizeText(options.registrySourceName) || 'override',
          source: overrideSource,
          index_url: normalizeText(options.registryIndex)
        })]
        : configuredSources;

      for (const source of remoteSources) {
        const remoteResult = await searchRegistryRemote({
          source,
          query,
          queryTokens: tokens,
          requestedStatus,
          maxShards: options.registryMaxShards,
          allowRemoteFullscan: options.allowRemoteFullscan === true
        }, {
          projectPath,
          fileSystem
        });
        registryRemoteMatched += Number(remoteResult.matched_count || 0);
        registryMatched += Number(remoteResult.matched_count || 0);
        if (Array.isArray(remoteResult.warnings)) {
          registryWarnings.push(...remoteResult.warnings);
        }
        if (Array.isArray(remoteResult.candidates)) {
          candidates.push(...remoteResult.candidates);
        }
      }
    }

    if (useCache) {
      const cachePath = resolveProjectPath(
        projectPath,
        options.registryCache,
        registryConfig.cache_file || DEFAULT_ERRORBOOK_REGISTRY_CACHE
      );
      const registryCache = await loadRegistryCache(projectPath, cachePath, fileSystem);
      for (const entry of registryCache.entries) {
        if (requestedStatus && normalizeStatus(entry.status, 'candidate') !== requestedStatus) {
          continue;
        }
        const matchScore = scoreSearchMatch(entry, tokens);
        if (matchScore <= 0) {
          continue;
        }
        registryMatched += 1;
        registryCacheMatched += 1;
        candidates.push({
          id: entry.id,
          entry_source: 'registry-cache',
          status: entry.status,
          quality_score: entry.quality_score,
          title: entry.title,
          fingerprint: entry.fingerprint,
          tags: normalizeStringList(entry.tags),
          ontology_tags: normalizeOntologyTags(entry.ontology_tags),
          match_score: matchScore,
          updated_at: entry.updated_at
        });
      }
    }
  }

  const dedupedCandidates = new Map();
  for (const item of candidates) {
    const key = normalizeText(item.fingerprint || item.id);
    const existing = dedupedCandidates.get(key);
    if (!existing || Number(item.match_score || 0) >= Number(existing.match_score || 0)) {
      dedupedCandidates.set(key, item);
    }
  }
  const sortedCandidates = Array.from(dedupedCandidates.values());

  sortedCandidates.sort((left, right) => {
    const scoreDiff = Number(right.match_score) - Number(left.match_score);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return `${right.updated_at}`.localeCompare(`${left.updated_at}`);
  });

  const result = {
    mode: 'errorbook-find',
    query,
    include_registry: includeRegistry,
    source_breakdown: {
      local_results: localMatched,
      registry_results: registryMatched,
      registry_cache_results: registryCacheMatched,
      registry_remote_results: registryRemoteMatched
    },
    warnings: normalizeStringList(registryWarnings),
    total_results: sortedCandidates.length,
    entries: sortedCandidates.slice(0, limit)
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!options.silent) {
    printListSummary({
      entries: result.entries,
      total_results: result.total_results,
      total_entries: index.entries.length
    });
  }

  return result;
}

async function runErrorbookPromoteCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const paths = resolveErrorbookPaths(projectPath);
  const index = await readErrorbookIndex(paths, fileSystem);

  const id = normalizeText(options.id || options.entryId);
  if (!id) {
    throw new Error('entry id is required');
  }

  const summary = findSummaryById(index, id);
  if (!summary) {
    throw new Error(`errorbook entry not found: ${id}`);
  }

  const entry = await readErrorbookEntry(paths, summary.id, fileSystem);
  if (!entry) {
    throw new Error(`errorbook entry file not found: ${summary.id}`);
  }

  entry.quality_score = scoreQuality(entry);
  const missing = validatePromoteCandidate(entry, DEFAULT_PROMOTE_MIN_QUALITY);
  if (missing.length > 0) {
    throw new Error(`promote gate failed: ${missing.join(', ')}`);
  }

  entry.status = 'promoted';
  entry.promoted_at = nowIso();
  entry.temporary_mitigation = markTemporaryMitigationResolved(entry, entry.promoted_at);
  entry.updated_at = entry.promoted_at;
  await writeErrorbookEntry(paths, entry, fileSystem);

  const updatedSummary = buildIndexSummary(entry);
  const targetIndex = index.entries.findIndex((item) => item.id === entry.id);
  if (targetIndex >= 0) {
    index.entries[targetIndex] = updatedSummary;
  } else {
    index.entries.push(updatedSummary);
  }
  index.entries.sort((left, right) => `${right.updated_at}`.localeCompare(`${left.updated_at}`));
  await writeErrorbookIndex(paths, index, fileSystem);

  const result = {
    mode: 'errorbook-promote',
    promoted: true,
    entry
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!options.silent) {
    console.log(chalk.green('✓ Promoted errorbook entry'));
    console.log(chalk.gray(`  id: ${entry.id}`));
    console.log(chalk.gray(`  quality: ${entry.quality_score}`));
    console.log(chalk.gray(`  promoted_at: ${entry.promoted_at}`));
  }

  return result;
}

async function runErrorbookReleaseGateCommand(options = {}, dependencies = {}) {
  const payload = await evaluateErrorbookReleaseGate(options, dependencies);

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (!options.silent) {
    if (payload.passed) {
      console.log(chalk.green('✓ Errorbook release gate passed'));
      console.log(chalk.gray(`  inspected: ${payload.inspected_count}`));
      return payload;
    }
    console.log(chalk.red('✗ Errorbook release gate blocked'));
    console.log(chalk.gray(`  blocked: ${payload.blocked_count}`));
    payload.blocked_entries.slice(0, 10).forEach((item) => {
      console.log(chalk.gray(`  - ${item.id} [${item.risk}] ${item.title}`));
    });
  }

  if (options.failOnBlock && !payload.passed) {
    throw new Error(
      `errorbook release gate blocked: ${payload.blocked_count} unresolved entries (min-risk=${payload.gate.min_risk})`
    );
  }

  return payload;
}

async function runErrorbookDeprecateCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const paths = resolveErrorbookPaths(projectPath);
  const index = await readErrorbookIndex(paths, fileSystem);

  const id = normalizeText(options.id || options.entryId);
  if (!id) {
    throw new Error('entry id is required');
  }

  const summary = findSummaryById(index, id);
  if (!summary) {
    throw new Error(`errorbook entry not found: ${id}`);
  }

  const reason = normalizeText(options.reason);
  if (!reason) {
    throw new Error('--reason is required for deprecate');
  }

  const replacement = normalizeText(options.replacement);
  if (replacement && replacement === summary.id) {
    throw new Error('--replacement cannot reference the same entry id');
  }

  const entry = await readErrorbookEntry(paths, summary.id, fileSystem);
  if (!entry) {
    throw new Error(`errorbook entry file not found: ${summary.id}`);
  }

  entry.status = 'deprecated';
  entry.updated_at = nowIso();
  entry.temporary_mitigation = markTemporaryMitigationResolved(entry, entry.updated_at);
  entry.deprecated_at = entry.updated_at;
  entry.deprecation = {
    reason,
    replacement_id: replacement || null
  };
  entry.quality_score = scoreQuality(entry);
  await writeErrorbookEntry(paths, entry, fileSystem);

  const updatedSummary = buildIndexSummary(entry);
  const targetIndex = index.entries.findIndex((item) => item.id === entry.id);
  if (targetIndex >= 0) {
    index.entries[targetIndex] = updatedSummary;
  } else {
    index.entries.push(updatedSummary);
  }
  index.entries.sort((left, right) => `${right.updated_at}`.localeCompare(`${left.updated_at}`));
  await writeErrorbookIndex(paths, index, fileSystem);

  const result = {
    mode: 'errorbook-deprecate',
    deprecated: true,
    entry
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!options.silent) {
    console.log(chalk.yellow('✓ Deprecated errorbook entry'));
    console.log(chalk.gray(`  id: ${entry.id}`));
    console.log(chalk.gray(`  reason: ${reason}`));
    if (replacement) {
      console.log(chalk.gray(`  replacement: ${replacement}`));
    }
  }

  return result;
}

async function runErrorbookRequalifyCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const paths = resolveErrorbookPaths(projectPath);
  const index = await readErrorbookIndex(paths, fileSystem);

  const id = normalizeText(options.id || options.entryId);
  if (!id) {
    throw new Error('entry id is required');
  }

  const summary = findSummaryById(index, id);
  if (!summary) {
    throw new Error(`errorbook entry not found: ${id}`);
  }

  const status = normalizeStatus(options.status || 'verified');
  if (status === 'promoted') {
    throw new Error('requalify does not accept status=promoted. Use "sce errorbook promote <id>"');
  }
  if (status === 'deprecated') {
    throw new Error('requalify does not accept status=deprecated. Use "sce errorbook deprecate <id>"');
  }

  const entry = await readErrorbookEntry(paths, summary.id, fileSystem);
  if (!entry) {
    throw new Error(`errorbook entry file not found: ${summary.id}`);
  }

  if (status === 'verified' && (!Array.isArray(entry.verification_evidence) || entry.verification_evidence.length === 0)) {
    throw new Error('requalify to verified requires verification_evidence');
  }

  entry.status = status;
  entry.updated_at = nowIso();
  entry.requalified_at = entry.updated_at;
  if (entry.deprecation) {
    delete entry.deprecation;
  }
  entry.quality_score = scoreQuality(entry);
  await writeErrorbookEntry(paths, entry, fileSystem);

  const updatedSummary = buildIndexSummary(entry);
  const targetIndex = index.entries.findIndex((item) => item.id === entry.id);
  if (targetIndex >= 0) {
    index.entries[targetIndex] = updatedSummary;
  } else {
    index.entries.push(updatedSummary);
  }
  index.entries.sort((left, right) => `${right.updated_at}`.localeCompare(`${left.updated_at}`));
  await writeErrorbookIndex(paths, index, fileSystem);

  const result = {
    mode: 'errorbook-requalify',
    requalified: true,
    entry
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!options.silent) {
    console.log(chalk.green('✓ Requalified errorbook entry'));
    console.log(chalk.gray(`  id: ${entry.id}`));
    console.log(chalk.gray(`  status: ${entry.status}`));
  }

  return result;
}

function collectOptionValue(value, previous = []) {
  const next = Array.isArray(previous) ? previous : [];
  next.push(value);
  return next;
}

function emitCommandError(error, json) {
  if (json) {
    console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
  } else {
    console.error(chalk.red('Error:'), error.message);
  }
  process.exit(1);
}

function registerErrorbookCommands(program) {
  const errorbook = program
    .command('errorbook')
    .description('Curated failure-remediation knowledge base');

  errorbook
    .command('record')
    .description('Record a high-signal failure remediation entry')
    .option('--title <text>', 'Entry title')
    .option('--symptom <text>', 'Observed symptom')
    .option('--root-cause <text>', 'Validated root cause')
    .option('--fix-action <text>', 'Concrete fix action (repeatable)', collectOptionValue, [])
    .option('--verification <text>', 'Verification evidence (repeatable)', collectOptionValue, [])
    .option('--tags <csv>', 'Tags, comma-separated')
    .option('--ontology <csv>', `Ontology focus tags (${ERRORBOOK_ONTOLOGY_TAGS.join(', ')})`)
    .option('--status <status>', 'candidate|verified', 'candidate')
    .option('--temporary-mitigation', 'Mark this entry as temporary fallback/mitigation (requires governance fields)')
    .option('--mitigation-reason <text>', 'Temporary mitigation reason/context')
    .option('--mitigation-exit <text>', 'Exit criteria that define mitigation cleanup completion')
    .option('--mitigation-cleanup <text>', 'Cleanup task/spec to remove temporary mitigation')
    .option('--mitigation-deadline <iso>', 'Deadline for mitigation cleanup (ISO datetime)')
    .option('--fingerprint <text>', 'Custom deduplication fingerprint')
    .option('--from <path>', 'Load payload from JSON file')
    .option('--spec <spec>', 'Related spec id/name')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (options) => {
      try {
        await runErrorbookRecordCommand(options);
      } catch (error) {
        emitCommandError(error, options.json);
      }
    });

  const incident = errorbook
    .command('incident')
    .description('Inspect temporary trial-and-error incident loop before final curation');

  incident
    .command('list')
    .description('List staging incidents')
    .option('--state <state>', 'Filter incident state (open|resolved)')
    .option('--limit <n>', 'Maximum incidents returned', parseInt, 20)
    .option('--json', 'Emit machine-readable JSON')
    .action(async (options) => {
      try {
        await runErrorbookIncidentListCommand(options);
      } catch (error) {
        emitCommandError(error, options.json);
      }
    });

  incident
    .command('show <id>')
    .description('Show a staging incident with all attempts')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (id, options) => {
      try {
        await runErrorbookIncidentShowCommand({ ...options, id });
      } catch (error) {
        emitCommandError(error, options.json);
      }
    });

  errorbook
    .command('list')
    .description('List curated errorbook entries')
    .option('--status <status>', `Filter by status (${ERRORBOOK_STATUSES.join(', ')})`)
    .option('--tag <tag>', 'Filter by tag')
    .option('--ontology <tag>', `Filter by ontology tag (${ERRORBOOK_ONTOLOGY_TAGS.join(', ')})`)
    .option('--min-quality <n>', 'Minimum quality score', parseInt)
    .option('--limit <n>', 'Maximum entries returned', parseInt, 20)
    .option('--json', 'Emit machine-readable JSON')
    .action(async (options) => {
      try {
        await runErrorbookListCommand(options);
      } catch (error) {
        emitCommandError(error, options.json);
      }
    });

  errorbook
    .command('show <id>')
    .description('Show a single errorbook entry')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (id, options) => {
      try {
        await runErrorbookShowCommand({ ...options, id });
      } catch (error) {
        emitCommandError(error, options.json);
      }
    });

  errorbook
    .command('find')
    .description('Search curated entries with ranking')
    .requiredOption('--query <text>', 'Search query')
    .option('--status <status>', `Filter by status (${ERRORBOOK_STATUSES.join(', ')})`)
    .option('--limit <n>', 'Maximum entries returned', parseInt, 10)
    .option('--include-registry', 'Include external registry entries in search')
    .option('--registry-mode <mode>', 'Registry lookup mode (cache|remote|hybrid)')
    .option('--registry-source <url-or-path>', 'Override registry source (for remote mode)')
    .option('--registry-source-name <name>', 'Override registry source label')
    .option('--registry-index <url-or-path>', 'Override registry index source (for remote mode)')
    .option('--registry-max-shards <n>', 'Max remote shards to fetch per query', parseInt, 8)
    .option('--allow-remote-fullscan', 'Allow remote full-source fallback when index is unavailable')
    .option('--registry-cache <path>', `Registry cache path (default: ${DEFAULT_ERRORBOOK_REGISTRY_CACHE})`)
    .option('--config <path>', `Registry config path (default: ${DEFAULT_ERRORBOOK_REGISTRY_CONFIG})`)
    .option('--json', 'Emit machine-readable JSON')
    .action(async (options) => {
      try {
        await runErrorbookFindCommand(options);
      } catch (error) {
        emitCommandError(error, options.json);
      }
    });

  errorbook
    .command('export')
    .description('Export curated local entries for external registry publication')
    .option('--status <csv>', 'Statuses to include (csv, default: promoted)', 'promoted')
    .option('--min-quality <n>', 'Minimum quality score (default: 75)', parseInt)
    .option('--limit <n>', 'Maximum entries exported', parseInt)
    .option('--out <path>', `Output file (default: ${DEFAULT_ERRORBOOK_REGISTRY_EXPORT})`)
    .option('--json', 'Emit machine-readable JSON')
    .action(async (options) => {
      try {
        await runErrorbookExportCommand(options);
      } catch (error) {
        emitCommandError(error, options.json);
      }
    });

  errorbook
    .command('sync-registry')
    .description('Sync external errorbook registry to local cache')
    .option('--source <url-or-path>', 'Registry source JSON (https://... or local file)')
    .option('--source-name <name>', 'Registry source name label')
    .option('--cache <path>', `Registry cache output path (default: ${DEFAULT_ERRORBOOK_REGISTRY_CACHE})`)
    .option('--config <path>', `Registry config path (default: ${DEFAULT_ERRORBOOK_REGISTRY_CONFIG})`)
    .option('--json', 'Emit machine-readable JSON')
    .action(async (options) => {
      try {
        await runErrorbookSyncRegistryCommand(options);
      } catch (error) {
        emitCommandError(error, options.json);
      }
    });

  errorbook
    .command('health-registry')
    .description('Validate external registry config/source/index health')
    .option('--config <path>', `Registry config path (default: ${DEFAULT_ERRORBOOK_REGISTRY_CONFIG})`)
    .option('--cache <path>', `Registry cache path (default: ${DEFAULT_ERRORBOOK_REGISTRY_CACHE})`)
    .option('--source <url-or-path>', 'Override registry source JSON (https://... or local file)')
    .option('--source-name <name>', 'Override source name label')
    .option('--index <url-or-path>', 'Override registry index source (https://... or local file)')
    .option('--max-shards <n>', 'Max index-resolved shards to validate', parseInt, 8)
    .option('--shard-sample <n>', 'Shard sample count to fetch and validate', parseInt, 2)
    .option('--fail-on-alert', 'Exit with error when health check finds errors')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (options) => {
      try {
        await runErrorbookRegistryHealthCommand(options);
      } catch (error) {
        emitCommandError(error, options.json);
      }
    });

  errorbook
    .command('promote <id>')
    .description('Promote entry after strict quality gate')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (id, options) => {
      try {
        await runErrorbookPromoteCommand({ ...options, id });
      } catch (error) {
        emitCommandError(error, options.json);
      }
    });

  errorbook
    .command('release-gate')
    .description('Block release on unresolved high-risk entries and temporary-mitigation policy violations')
    .option('--min-risk <level>', 'Risk threshold (low|medium|high)', 'high')
    .option('--min-quality <n>', `Minimum quality for unresolved entries (default: ${DEFAULT_RELEASE_GATE_MIN_QUALITY})`, parseInt)
    .option('--include-verified', 'Also inspect verified (non-promoted) entries')
    .option('--fail-on-block', 'Exit with error when gate is blocked')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (options) => {
      try {
        await runErrorbookReleaseGateCommand(options);
      } catch (error) {
        emitCommandError(error, options.json);
      }
    });

  errorbook
    .command('deprecate <id>')
    .description('Deprecate low-value or obsolete entry')
    .requiredOption('--reason <text>', 'Deprecation reason')
    .option('--replacement <id>', 'Replacement entry id')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (id, options) => {
      try {
        await runErrorbookDeprecateCommand({ ...options, id });
      } catch (error) {
        emitCommandError(error, options.json);
      }
    });

  errorbook
    .command('requalify <id>')
    .description('Requalify deprecated/candidate entry back to candidate|verified')
    .option('--status <status>', 'candidate|verified', 'verified')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (id, options) => {
      try {
        await runErrorbookRequalifyCommand({ ...options, id });
      } catch (error) {
        emitCommandError(error, options.json);
      }
    });
}

module.exports = {
  ERRORBOOK_STATUSES,
  ERRORBOOK_ONTOLOGY_TAGS,
  ERRORBOOK_RISK_LEVELS,
  TEMPORARY_MITIGATION_TAG,
  DEFAULT_ERRORBOOK_REGISTRY_CONFIG,
  DEFAULT_ERRORBOOK_REGISTRY_CACHE,
  DEFAULT_ERRORBOOK_REGISTRY_EXPORT,
  HIGH_RISK_SIGNAL_TAGS,
  DEBUG_EVIDENCE_TAGS,
  DEFAULT_PROMOTE_MIN_QUALITY,
  DEFAULT_RELEASE_GATE_MIN_QUALITY,
  ERRORBOOK_INCIDENT_INDEX_API_VERSION,
  ERRORBOOK_INCIDENT_API_VERSION,
  resolveErrorbookPaths,
  resolveErrorbookRegistryPaths,
  normalizeOntologyTags,
  normalizeRecordPayload,
  scoreQuality,
  evaluateEntryRisk,
  evaluateErrorbookReleaseGate,
  runErrorbookRecordCommand,
  runErrorbookExportCommand,
  runErrorbookSyncRegistryCommand,
  runErrorbookRegistryHealthCommand,
  runErrorbookIncidentListCommand,
  runErrorbookIncidentShowCommand,
  runErrorbookListCommand,
  runErrorbookShowCommand,
  runErrorbookFindCommand,
  runErrorbookPromoteCommand,
  runErrorbookReleaseGateCommand,
  runErrorbookDeprecateCommand,
  runErrorbookRequalifyCommand,
  registerErrorbookCommands
};
