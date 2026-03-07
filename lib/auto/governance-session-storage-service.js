const path = require('path');

async function readGovernanceCloseLoopSessionEntries(projectPath, dependencies = {}) {
  const {
    getGovernanceCloseLoopSessionDir,
    fs,
    normalizeGovernanceReleaseGateSnapshot,
    summarizeGovernanceRoundReleaseGateTelemetry,
    normalizeGovernanceWeeklyOpsStopDetail,
    deriveGovernanceWeeklyOpsReasonFlags
  } = dependencies;
  const sessionDir = getGovernanceCloseLoopSessionDir(projectPath);
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

    const finalReleaseGate = normalizeGovernanceReleaseGateSnapshot(
      payload && payload.final_assessment && payload.final_assessment.health
        ? payload.final_assessment.health.release_gate
        : null
    );
    const roundReleaseGateTelemetry = summarizeGovernanceRoundReleaseGateTelemetry(payload && payload.rounds);
    const stopDetail = payload && payload.stop_detail && typeof payload.stop_detail === 'object' ? payload.stop_detail : null;
    const stopDetailReasons = Array.isArray(stopDetail && stopDetail.reasons) ? stopDetail.reasons : [];
    const stopDetailWeeklyOps = normalizeGovernanceWeeklyOpsStopDetail(stopDetail && stopDetail.weekly_ops);
    const stopDetailWeeklyOpsReasonFlags = deriveGovernanceWeeklyOpsReasonFlags(stopDetailReasons);

    const latestAuthTier = stopDetailWeeklyOps && stopDetailWeeklyOps.latest && Number.isFinite(stopDetailWeeklyOps.latest.authorization_tier_block_rate_percent)
      ? stopDetailWeeklyOps.latest.authorization_tier_block_rate_percent
      : (stopDetailWeeklyOps && stopDetailWeeklyOps.aggregates && Number.isFinite(stopDetailWeeklyOps.aggregates.authorization_tier_block_rate_max_percent)
        ? stopDetailWeeklyOps.aggregates.authorization_tier_block_rate_max_percent
        : null);
    const latestDialogue = stopDetailWeeklyOps && stopDetailWeeklyOps.latest && Number.isFinite(stopDetailWeeklyOps.latest.dialogue_authorization_block_rate_percent)
      ? stopDetailWeeklyOps.latest.dialogue_authorization_block_rate_percent
      : (stopDetailWeeklyOps && stopDetailWeeklyOps.aggregates && Number.isFinite(stopDetailWeeklyOps.aggregates.dialogue_authorization_block_rate_max_percent)
        ? stopDetailWeeklyOps.aggregates.dialogue_authorization_block_rate_max_percent
        : null);
    const latestRuntimeBlock = stopDetailWeeklyOps && stopDetailWeeklyOps.latest && Number.isFinite(stopDetailWeeklyOps.latest.runtime_block_rate_percent)
      ? stopDetailWeeklyOps.latest.runtime_block_rate_percent
      : (stopDetailWeeklyOps && stopDetailWeeklyOps.aggregates && Number.isFinite(stopDetailWeeklyOps.aggregates.runtime_block_rate_max_percent)
        ? stopDetailWeeklyOps.aggregates.runtime_block_rate_max_percent
        : null);
    const latestUiTotal = stopDetailWeeklyOps && stopDetailWeeklyOps.latest && Number.isFinite(stopDetailWeeklyOps.latest.runtime_ui_mode_violation_total)
      ? stopDetailWeeklyOps.latest.runtime_ui_mode_violation_total
      : (stopDetailWeeklyOps && stopDetailWeeklyOps.aggregates && Number.isFinite(stopDetailWeeklyOps.aggregates.runtime_ui_mode_violation_total)
        ? stopDetailWeeklyOps.aggregates.runtime_ui_mode_violation_total
        : null);
    const latestUiRate = stopDetailWeeklyOps && stopDetailWeeklyOps.latest && Number.isFinite(stopDetailWeeklyOps.latest.runtime_ui_mode_violation_rate_percent)
      ? stopDetailWeeklyOps.latest.runtime_ui_mode_violation_rate_percent
      : (stopDetailWeeklyOps && stopDetailWeeklyOps.aggregates && Number.isFinite(stopDetailWeeklyOps.aggregates.runtime_ui_mode_violation_rate_max_percent)
        ? stopDetailWeeklyOps.aggregates.runtime_ui_mode_violation_rate_max_percent
        : null);

    sessions.push({
      id: payload && payload.governance_session && typeof payload.governance_session.id === 'string' ? payload.governance_session.id : fallbackId,
      file: filePath,
      status: payload && typeof payload.status === 'string' ? payload.status : (parseError ? 'invalid' : 'unknown'),
      target_risk: payload && typeof payload.target_risk === 'string' ? payload.target_risk : null,
      final_risk: payload && payload.final_assessment && payload.final_assessment.health && typeof payload.final_assessment.health.risk_level === 'string'
        ? payload.final_assessment.health.risk_level
        : null,
      performed_rounds: Number(payload && payload.performed_rounds) || 0,
      max_rounds: Number(payload && payload.max_rounds) || null,
      converged: Boolean(payload && payload.converged),
      execute_advisory: payload && payload.execute_advisory === true,
      advisory_failed_actions: payload && payload.advisory_summary ? Number(payload.advisory_summary.failed_actions) || 0 : null,
      release_gate_available: finalReleaseGate ? finalReleaseGate.available : null,
      release_gate_latest_gate_passed: finalReleaseGate ? finalReleaseGate.latest_gate_passed : null,
      release_gate_pass_rate_percent: finalReleaseGate ? finalReleaseGate.pass_rate_percent : null,
      release_gate_scene_package_batch_pass_rate_percent: finalReleaseGate ? finalReleaseGate.scene_package_batch_pass_rate_percent : null,
      release_gate_drift_alert_rate_percent: finalReleaseGate ? finalReleaseGate.drift_alert_rate_percent : null,
      release_gate_drift_blocked_runs: finalReleaseGate ? finalReleaseGate.drift_blocked_runs : null,
      round_release_gate_observed: roundReleaseGateTelemetry.observed_rounds,
      round_release_gate_changed: roundReleaseGateTelemetry.changed_rounds,
      stop_detail_weekly_ops_available: stopDetailWeeklyOps !== null,
      stop_detail_weekly_ops_blocked: stopDetailWeeklyOpsReasonFlags.blocked,
      stop_detail_weekly_ops_high_pressure: stopDetailWeeklyOpsReasonFlags.high,
      stop_detail_weekly_ops_config_warning_positive: stopDetailWeeklyOpsReasonFlags.config_warning_positive,
      stop_detail_weekly_ops_auth_tier_block_rate_high: stopDetailWeeklyOpsReasonFlags.auth_tier_block_rate_high,
      stop_detail_weekly_ops_dialogue_authorization_block_rate_high: stopDetailWeeklyOpsReasonFlags.dialogue_authorization_block_rate_high,
      stop_detail_weekly_ops_runtime_block_rate_high: stopDetailWeeklyOpsReasonFlags.runtime_block_rate_high,
      stop_detail_weekly_ops_runtime_ui_mode_violation_high: stopDetailWeeklyOpsReasonFlags.runtime_ui_mode_violation_high,
      stop_detail_weekly_ops_blocked_runs: stopDetailWeeklyOps && stopDetailWeeklyOps.aggregates ? stopDetailWeeklyOps.aggregates.blocked_runs : null,
      stop_detail_weekly_ops_block_rate_percent: stopDetailWeeklyOps && stopDetailWeeklyOps.aggregates ? stopDetailWeeklyOps.aggregates.block_rate_percent : null,
      stop_detail_weekly_ops_config_warnings_total: stopDetailWeeklyOps && stopDetailWeeklyOps.aggregates ? stopDetailWeeklyOps.aggregates.config_warnings_total : null,
      stop_detail_weekly_ops_auth_tier_block_rate_percent: latestAuthTier,
      stop_detail_weekly_ops_dialogue_authorization_block_rate_percent: latestDialogue,
      stop_detail_weekly_ops_runtime_block_rate_percent: latestRuntimeBlock,
      stop_detail_weekly_ops_runtime_ui_mode_violation_total: latestUiTotal,
      stop_detail_weekly_ops_runtime_ui_mode_violation_rate_percent: latestUiRate,
      stop_reason: payload && typeof payload.stop_reason === 'string' ? payload.stop_reason : null,
      resumed_from_governance_session_id: payload && payload.resumed_from_governance_session && typeof payload.resumed_from_governance_session.id === 'string'
        ? payload.resumed_from_governance_session.id
        : null,
      updated_at: payload && typeof payload.updated_at === 'string' ? payload.updated_at : fallbackTimestamp,
      parse_error: parseError ? parseError.message : null,
      mtime_ms: stats.mtimeMs
    });
  }

  sessions.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return sessions;
}

async function resolveGovernanceCloseLoopSessionFile(projectPath, sessionCandidate, dependencies = {}) {
  const { readGovernanceCloseLoopSessionEntries, getGovernanceCloseLoopSessionDir, sanitizeBatchSessionId, fs } = dependencies;
  if (typeof sessionCandidate !== 'string' || !sessionCandidate.trim()) {
    throw new Error('--governance-resume requires a session id/file or "latest".');
  }
  const normalizedCandidate = sessionCandidate.trim();
  if (normalizedCandidate.toLowerCase() === 'latest') {
    const sessions = await readGovernanceCloseLoopSessionEntries(projectPath, dependencies);
    if (sessions.length === 0) {
      throw new Error(`No governance close-loop sessions found in: ${getGovernanceCloseLoopSessionDir(projectPath)}`);
    }
    return sessions[0].file;
  }
  if (path.isAbsolute(normalizedCandidate)) {
    return normalizedCandidate;
  }
  if (normalizedCandidate.includes('/') || normalizedCandidate.includes('\\') || normalizedCandidate.toLowerCase().endsWith('.json')) {
    return path.join(projectPath, normalizedCandidate);
  }
  const byId = path.join(getGovernanceCloseLoopSessionDir(projectPath), `${sanitizeBatchSessionId(normalizedCandidate)}.json`);
  if (await fs.pathExists(byId)) {
    return byId;
  }
  return path.join(projectPath, normalizedCandidate);
}

async function loadGovernanceCloseLoopSessionPayload(projectPath, sessionCandidate, dependencies = {}) {
  const { fs } = dependencies;
  const sessionFile = await resolveGovernanceCloseLoopSessionFile(projectPath, sessionCandidate, dependencies);
  if (!(await fs.pathExists(sessionFile))) {
    throw new Error(`Governance close-loop session file not found: ${sessionFile}`);
  }
  let payload = null;
  try {
    payload = await fs.readJson(sessionFile);
  } catch (error) {
    throw new Error(`Invalid governance close-loop session JSON: ${sessionFile} (${error.message})`);
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error(`Invalid governance close-loop session payload: ${sessionFile}`);
  }
  const sessionId = payload && payload.governance_session && payload.governance_session.id
    ? payload.governance_session.id
    : path.basename(sessionFile, '.json');
  return { id: sessionId, file: sessionFile, payload };
}

async function persistGovernanceCloseLoopSession(projectPath, sessionId, payload, status = 'running', dependencies = {}) {
  const { sanitizeBatchSessionId, getGovernanceCloseLoopSessionDir, schemaVersion, fs, now = () => new Date() } = dependencies;
  const safeSessionId = sanitizeBatchSessionId(sessionId);
  if (!safeSessionId) {
    return null;
  }
  const sessionDir = getGovernanceCloseLoopSessionDir(projectPath);
  const sessionFile = path.join(sessionDir, `${safeSessionId}.json`);
  const nowValue = now();
  const updatedAt = nowValue instanceof Date ? nowValue.toISOString() : new Date(nowValue).toISOString();
  const persisted = {
    ...payload,
    schema_version: schemaVersion,
    status,
    governance_session: { id: safeSessionId, file: sessionFile },
    updated_at: updatedAt
  };
  await fs.ensureDir(sessionDir);
  await fs.writeJson(sessionFile, persisted, { spaces: 2 });
  return { id: safeSessionId, file: sessionFile };
}

module.exports = {
  readGovernanceCloseLoopSessionEntries,
  resolveGovernanceCloseLoopSessionFile,
  loadGovernanceCloseLoopSessionPayload,
  persistGovernanceCloseLoopSession
};
