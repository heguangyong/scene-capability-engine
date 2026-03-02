const fs = require('fs-extra');
const path = require('path');
const { mergeConfigs } = require('../auto/config-schema');
const {
  SteeringContract,
  DEFAULT_LAYER_FILES,
  MANIFEST_FILENAME,
  SCE_STEERING_DIR,
} = require('../runtime/steering-contract');

const TAKEOVER_BASELINE_SCHEMA_VERSION = '1.0';

const SESSION_GOVERNANCE_DEFAULTS = Object.freeze({
  schema_version: '1.0',
  scene_primary_session_required: true,
  one_scene_one_primary_session: true,
  spec_runs_bind_child_session: true,
  scene_completion_auto_rollover: true,
  auto_archive_spec_sessions: true
});

const SPEC_DOMAIN_POLICY_DEFAULTS = Object.freeze({
  schema_version: '1.0',
  closed_loop_research_required: true,
  coverage_validation_required: true,
  fail_on_gap_default: true,
  problem_contract_required: true,
  ontology_axes_required: ['entity', 'relation', 'business_rule', 'decision_policy', 'execution_flow']
});

const PROBLEM_EVAL_POLICY_DEFAULTS = Object.freeze({
  schema_version: '1.0',
  enabled: true,
  mode: 'required',
  enforce_on_stages: ['plan', 'generate', 'apply', 'verify', 'release'],
  block_on_stages: ['apply', 'release'],
  min_confidence_by_stage: {
    plan: 20,
    generate: 25,
    apply: 30,
    verify: 35,
    release: 40
  },
  high_risk_requires_debug_evidence: true,
  high_risk_keywords: [
    'auth',
    'payment',
    'security',
    'delete',
    'rollback',
    'production',
    'migrate',
    'compliance',
    'data-loss'
  ],
  recommendation_limit: 6,
  max_failed_rounds_before_debug: 2,
  problem_contract_required_stages: ['plan', 'generate', 'apply', 'verify', 'release'],
  problem_contract_block_stages: ['plan', 'apply', 'release'],
  ontology_alignment_required_stages: ['plan', 'generate', 'apply', 'verify', 'release'],
  ontology_alignment_block_stages: ['apply', 'release'],
  ontology_required_axes: ['entity', 'relation', 'business_rule', 'decision_policy', 'execution_flow'],
  require_ontology_evidence_binding: true,
  ontology_evidence_min_bindings: 1,
  convergence_required_stages: ['verify', 'release'],
  convergence_block_stages: ['release'],
  release_block_on_high_alerts: true,
  release_require_governance_report: false
});

const PROBLEM_CLOSURE_POLICY_DEFAULTS = Object.freeze({
  schema_version: '1.0',
  enabled: true,
  governance_report_path: '.sce/reports/interactive-governance-report.json',
  verify: {
    require_problem_contract: true,
    require_domain_validation: true,
    require_domain_coverage: true
  },
  release: {
    require_problem_contract: true,
    require_domain_validation: true,
    require_domain_coverage: true,
    require_verify_report: true,
    require_governance_report: false,
    block_on_high_governance_alerts: true
  }
});

const STUDIO_INTAKE_POLICY_DEFAULTS = Object.freeze({
  schema_version: '1.0',
  enabled: true,
  auto_create_spec: true,
  force_spec_for_studio_plan: true,
  allow_manual_spec_override: false,
  prefer_existing_scene_spec: true,
  related_spec_min_score: 45,
  allow_new_spec_when_goal_diverges: true,
  divergence_similarity_threshold: 0.2,
  goal_missing_strategy: 'create_for_tracking',
  question_only_patterns: [
    'how', 'what', 'why', 'when', 'where', 'which', 'can', 'could', 'should', 'would',
    '是否', '怎么', '如何', '为什么', '吗', '么'
  ],
  change_intent_patterns: [
    'implement', 'build', 'create', 'add', 'update', 'upgrade', 'refactor', 'fix', 'stabilize',
    'optimize', 'deliver', 'release', 'bootstrap', 'repair', 'patch',
    '新增', '增加', '实现', '构建', '开发', '修复', '优化', '重构', '发布', '改造', '完善', '增强'
  ],
  spec_id: {
    prefix: 'auto',
    max_goal_slug_tokens: 6
  },
  governance: {
    auto_run_on_plan: true,
    require_auto_on_plan: true,
    max_active_specs_per_scene: 3,
    stale_days: 14,
    duplicate_similarity_threshold: 0.66
  },
  backfill: {
    enabled: true,
    active_only_default: true,
    default_scene_id: 'scene.sce-core',
    override_file: '.sce/spec-governance/spec-scene-overrides.json',
    rules: [
      { id: 'moqui-core', scene_id: 'scene.moqui-core', keywords: ['moqui'] },
      { id: 'orchestration', scene_id: 'scene.sce-orchestration', keywords: ['orchestrate', 'runtime', 'controller', 'batch', 'parallel'] },
      { id: 'template-registry', scene_id: 'scene.sce-template-registry', keywords: ['template', 'scene-package', 'registry', 'catalog', 'scene-template'] },
      { id: 'spec-governance', scene_id: 'scene.sce-spec-governance', keywords: ['spec', 'gate', 'ontology', 'governance', 'policy'] },
      { id: 'quality', scene_id: 'scene.sce-quality', keywords: ['test', 'quality', 'stability', 'jest', 'coverage'] },
      { id: 'docs', scene_id: 'scene.sce-docs', keywords: ['document', 'documentation', 'onboarding', 'guide'] },
      { id: 'platform', scene_id: 'scene.sce-platform', keywords: ['adopt', 'upgrade', 'workspace', 'repo', 'environment', 'devops', 'release', 'github', 'npm'] }
    ]
  }
});

const TAKEOVER_DEFAULTS = Object.freeze({
  autonomous: {
    enabled: true,
    mode: 'aggressive',
    require_step_confirmation: false,
    apply_all_work_by_default: true
  },
  session_governance: {
    scene_primary_session_required: true,
    one_scene_one_primary_session: true,
    spec_runs_bind_child_session: true,
    scene_completion_auto_rollover: true
  },
  spec_domain_policy: {
    closed_loop_research_required: true,
    coverage_validation_required: true,
    fail_on_gap_default: true,
    problem_contract_required: true,
    ontology_axes_required: ['entity', 'relation', 'business_rule', 'decision_policy', 'execution_flow']
  },
  problem_evaluation: {
    enabled: true,
    mode: 'required',
    enforce_on_stages: ['plan', 'generate', 'apply', 'verify', 'release'],
    block_on_stages: ['apply', 'release'],
    problem_contract_required_stages: ['plan', 'generate', 'apply', 'verify', 'release'],
    problem_contract_block_stages: ['plan', 'apply', 'release'],
    ontology_alignment_required_stages: ['plan', 'generate', 'apply', 'verify', 'release'],
    ontology_alignment_block_stages: ['apply', 'release'],
    convergence_required_stages: ['verify', 'release'],
    convergence_block_stages: ['release'],
    max_failed_rounds_before_debug: 2
  },
  problem_closure: {
    enabled: true,
    governance_report_path: '.sce/reports/interactive-governance-report.json',
    verify: {
      require_problem_contract: true,
      require_domain_validation: true,
      require_domain_coverage: true
    },
    release: {
      require_problem_contract: true,
      require_domain_validation: true,
      require_domain_coverage: true,
      require_verify_report: true,
      require_governance_report: false,
      block_on_high_governance_alerts: true
    }
  },
  studio_intake: {
    enabled: true,
    auto_create_spec: true,
    force_spec_for_studio_plan: true,
    allow_manual_spec_override: false,
    prefer_existing_scene_spec: true,
    related_spec_min_score: 45,
    allow_new_spec_when_goal_diverges: true,
    divergence_similarity_threshold: 0.2,
    goal_missing_strategy: 'create_for_tracking',
    governance: {
      auto_run_on_plan: true,
      require_auto_on_plan: true,
      max_active_specs_per_scene: 3,
      stale_days: 14,
      duplicate_similarity_threshold: 0.66
    },
    backfill: {
      enabled: true,
      active_only_default: true,
      default_scene_id: 'scene.sce-core',
      override_file: '.sce/spec-governance/spec-scene-overrides.json'
    }
  },
  debug_policy: {
    prioritize_root_cause_fix: true,
    max_direct_fix_rounds_before_debug: 2,
    forbid_bypass_workarounds: true
  },
  migration_policy: {
    legacy_kiro_supported: false,
    require_manual_legacy_migration_confirmation: true
  }
});

function _toRelativePosix(projectPath, absolutePath) {
  return path.relative(projectPath, absolutePath).replace(/\\/g, '/');
}

function _isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function _clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function _deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function _deepMerge(base, patch) {
  const output = _isObject(base) ? _clone(base) : {};
  if (!_isObject(patch)) {
    return output;
  }

  for (const [key, value] of Object.entries(patch)) {
    if (_isObject(value)) {
      output[key] = _deepMerge(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

async function _readJsonSafe(filePath, fileSystem) {
  if (!await fileSystem.pathExists(filePath)) {
    return null;
  }
  try {
    return await fileSystem.readJson(filePath);
  } catch (_error) {
    return null;
  }
}

function _buildAutoConfig(existing) {
  const merged = mergeConfigs({}, _isObject(existing) ? existing : {});
  merged.mode = 'aggressive';
  merged.checkpoints = {
    ...(merged.checkpoints || {}),
    requirementsReview: false,
    designReview: false,
    tasksReview: false,
    phaseCompletion: false,
    finalReview: false
  };
  merged.errorRecovery = {
    ...(merged.errorRecovery || {}),
    enabled: true,
    maxAttempts: Math.max(3, Number(merged?.errorRecovery?.maxAttempts || 0) || 0)
  };
  merged.performance = {
    ...(merged.performance || {}),
    maxConcurrentTasks: Math.max(1, Number(merged?.performance?.maxConcurrentTasks || 0) || 1)
  };
  merged.takeover = {
    managed: true,
    require_step_confirmation: false,
    apply_all_work_by_default: true
  };
  return merged;
}

function _buildAdoptionConfig(existing, nowIso, sceVersion) {
  const base = _isObject(existing) ? _clone(existing) : {};
  const adoptedAt = typeof base.adoptedAt === 'string' && base.adoptedAt.trim()
    ? base.adoptedAt
    : nowIso;

  return {
    ...base,
    version: typeof base.version === 'string' && base.version.trim() ? base.version : '1.0.0',
    adoptedAt,
    steeringStrategy: typeof base.steeringStrategy === 'string' && base.steeringStrategy.trim()
      ? base.steeringStrategy
      : 'use-kse',
    multiUserMode: base.multiUserMode === true,
    runtimePolicy: {
      agent_parity_permissions: true,
      autonomous_default: true
    },
    takeover: {
      managed: true,
      schema_version: TAKEOVER_BASELINE_SCHEMA_VERSION,
      auto_detect_on_startup: true,
      legacy_kiro_supported: false
    },
    defaults: _clone(TAKEOVER_DEFAULTS),
    lastAlignedSceVersion: sceVersion
  };
}

function _buildTakeoverBaselineConfig(existing, sceVersion) {
  const base = _isObject(existing) ? _clone(existing) : {};
  return {
    ...base,
    schema_version: TAKEOVER_BASELINE_SCHEMA_VERSION,
    engine: 'sce',
    managed: true,
    last_aligned_sce_version: sceVersion,
    defaults: _clone(TAKEOVER_DEFAULTS)
  };
}

async function _reconcileJsonFile(filePath, desired, options = {}) {
  const {
    projectPath,
    apply,
    fileSystem,
    managedBy = 'takeover-baseline'
  } = options;
  const existing = await _readJsonSafe(filePath, fileSystem);
  const existed = existing !== null;
  const changed = !existed || !_deepEqual(existing, desired);

  if (apply && changed) {
    await fileSystem.ensureDir(path.dirname(filePath));
    await fileSystem.writeJson(filePath, desired, { spaces: 2 });
  }

  return {
    path: _toRelativePosix(projectPath, filePath),
    existed,
    changed,
    status: existed ? (changed ? 'updated' : 'unchanged') : (changed ? 'created' : 'unchanged'),
    managed_by: managedBy
  };
}

async function _inspectSteeringState(projectPath, fileSystem) {
  const steeringDir = path.join(projectPath, SCE_STEERING_DIR);
  const manifestPath = path.join(steeringDir, MANIFEST_FILENAME);
  const layers = Object.values(DEFAULT_LAYER_FILES).map((filename) => path.join(steeringDir, filename));
  const files = [manifestPath, ...layers];
  let missing = 0;
  for (const filePath of files) {
    if (!await fileSystem.pathExists(filePath)) {
      missing += 1;
    }
  }
  return {
    steeringDir,
    manifestPath,
    layerFiles: layers,
    missing
  };
}

async function _reconcileSteeringContract(projectPath, options = {}) {
  const { apply, fileSystem } = options;
  const before = await _inspectSteeringState(projectPath, fileSystem);
  let ensureResult = null;
  if (apply) {
    const contract = new SteeringContract(projectPath);
    ensureResult = await contract.ensureContract();
  }
  const after = await _inspectSteeringState(projectPath, fileSystem);
  const changed = before.missing !== after.missing;

  return {
    path: _toRelativePosix(projectPath, before.steeringDir),
    changed,
    status: changed ? 'updated' : 'unchanged',
    managed_by: 'steering-contract',
    details: {
      missing_before: before.missing,
      missing_after: after.missing,
      ensure_result: ensureResult
    }
  };
}

function _summarize(items) {
  const summary = {
    created: 0,
    updated: 0,
    unchanged: 0,
    pending: 0
  };

  for (const item of items) {
    if (!item) {
      continue;
    }
    if (item.status === 'created') {
      summary.created += 1;
    } else if (item.status === 'updated') {
      summary.updated += 1;
    } else if (item.status === 'pending') {
      summary.pending += 1;
    } else {
      summary.unchanged += 1;
    }
  }
  return summary;
}

function _toAuditStatus(items, apply) {
  if (apply) {
    return items.map((item) => item);
  }
  return items.map((item) => {
    if (item.status === 'created' || item.status === 'updated') {
      return {
        ...item,
        status: 'pending',
        changed: true
      };
    }
    return item;
  });
}

async function applyTakeoverBaseline(projectPath = process.cwd(), options = {}) {
  const fileSystem = options.fileSystem || fs;
  const apply = options.apply !== false;
  const writeReport = options.writeReport === true;
  const now = options.now || new Date();
  const nowIso = typeof now.toISOString === 'function' ? now.toISOString() : new Date().toISOString();
  const sceVersion = typeof options.sceVersion === 'string' && options.sceVersion.trim()
    ? options.sceVersion.trim()
    : 'unknown';

  const sceRoot = path.join(projectPath, '.sce');
  if (!await fileSystem.pathExists(sceRoot)) {
    return {
      mode: 'workspace-takeover-baseline',
      detected_project: false,
      apply,
      passed: true,
      project_path: projectPath,
      drift_count: 0,
      files: [],
      summary: {
        created: 0,
        updated: 0,
        unchanged: 0,
        pending: 0
      },
      message: 'No .sce directory found; takeover baseline skipped.'
    };
  }

  const adoptionPath = path.join(sceRoot, 'adoption-config.json');
  const autoConfigPath = path.join(sceRoot, 'auto', 'config.json');
  const takeoverConfigPath = path.join(sceRoot, 'config', 'takeover-baseline.json');
  const sessionGovernancePath = path.join(sceRoot, 'config', 'session-governance.json');
  const specDomainPolicyPath = path.join(sceRoot, 'config', 'spec-domain-policy.json');
  const problemEvalPolicyPath = path.join(sceRoot, 'config', 'problem-eval-policy.json');
  const problemClosurePolicyPath = path.join(sceRoot, 'config', 'problem-closure-policy.json');
  const studioIntakePolicyPath = path.join(sceRoot, 'config', 'studio-intake-policy.json');
  const reportPath = path.join(sceRoot, 'reports', 'takeover-baseline-latest.json');

  const existingAdoption = await _readJsonSafe(adoptionPath, fileSystem);
  const existingAuto = await _readJsonSafe(autoConfigPath, fileSystem);
  const existingTakeover = await _readJsonSafe(takeoverConfigPath, fileSystem);
  const existingSessionGovernance = await _readJsonSafe(sessionGovernancePath, fileSystem);
  const existingSpecDomainPolicy = await _readJsonSafe(specDomainPolicyPath, fileSystem);
  const existingProblemEvalPolicy = await _readJsonSafe(problemEvalPolicyPath, fileSystem);
  const existingProblemClosurePolicy = await _readJsonSafe(problemClosurePolicyPath, fileSystem);
  const existingStudioIntakePolicy = await _readJsonSafe(studioIntakePolicyPath, fileSystem);

  const desiredAdoption = _buildAdoptionConfig(existingAdoption, nowIso, sceVersion);
  const desiredAutoConfig = _buildAutoConfig(existingAuto);
  const desiredTakeover = _buildTakeoverBaselineConfig(existingTakeover, sceVersion);
  const desiredSessionGovernance = _deepMerge(existingSessionGovernance || {}, SESSION_GOVERNANCE_DEFAULTS);
  const desiredSpecDomainPolicy = _deepMerge(existingSpecDomainPolicy || {}, SPEC_DOMAIN_POLICY_DEFAULTS);
  const desiredProblemEvalPolicy = _deepMerge(existingProblemEvalPolicy || {}, PROBLEM_EVAL_POLICY_DEFAULTS);
  const desiredProblemClosurePolicy = _deepMerge(existingProblemClosurePolicy || {}, PROBLEM_CLOSURE_POLICY_DEFAULTS);
  const desiredStudioIntakePolicy = _deepMerge(existingStudioIntakePolicy || {}, STUDIO_INTAKE_POLICY_DEFAULTS);

  const fileResults = [];
  fileResults.push(await _reconcileJsonFile(adoptionPath, desiredAdoption, {
    projectPath,
    apply,
    fileSystem
  }));
  fileResults.push(await _reconcileJsonFile(autoConfigPath, desiredAutoConfig, {
    projectPath,
    apply,
    fileSystem
  }));
  fileResults.push(await _reconcileJsonFile(takeoverConfigPath, desiredTakeover, {
    projectPath,
    apply,
    fileSystem
  }));
  fileResults.push(await _reconcileJsonFile(sessionGovernancePath, desiredSessionGovernance, {
    projectPath,
    apply,
    fileSystem
  }));
  fileResults.push(await _reconcileJsonFile(specDomainPolicyPath, desiredSpecDomainPolicy, {
    projectPath,
    apply,
    fileSystem
  }));
  fileResults.push(await _reconcileJsonFile(problemEvalPolicyPath, desiredProblemEvalPolicy, {
    projectPath,
    apply,
    fileSystem
  }));
  fileResults.push(await _reconcileJsonFile(problemClosurePolicyPath, desiredProblemClosurePolicy, {
    projectPath,
    apply,
    fileSystem
  }));
  fileResults.push(await _reconcileJsonFile(studioIntakePolicyPath, desiredStudioIntakePolicy, {
    projectPath,
    apply,
    fileSystem
  }));
  fileResults.push(await _reconcileSteeringContract(projectPath, {
    apply,
    fileSystem
  }));

  const auditFiles = _toAuditStatus(fileResults, apply);
  const summary = _summarize(auditFiles);
  const driftCount = summary.pending;
  const passed = driftCount === 0;

  const report = {
    mode: 'workspace-takeover-baseline',
    generated_at: nowIso,
    detected_project: true,
    apply,
    passed,
    project_path: projectPath,
    sce_version: sceVersion,
    drift_count: driftCount,
    enforced_defaults: _clone(TAKEOVER_DEFAULTS),
    files: auditFiles,
    summary
  };

  if (apply && writeReport) {
    const reportExists = await fileSystem.pathExists(reportPath);
    const shouldWriteReport = options.forceWriteReport === true
      || !reportExists
      || summary.created > 0
      || summary.updated > 0;

    if (shouldWriteReport) {
      await fileSystem.ensureDir(path.dirname(reportPath));
      await fileSystem.writeJson(reportPath, report, { spaces: 2 });
    }
    if (reportExists || shouldWriteReport) {
      report.report_file = _toRelativePosix(projectPath, reportPath);
    }
  }

  return report;
}

module.exports = {
  TAKEOVER_BASELINE_SCHEMA_VERSION,
  TAKEOVER_DEFAULTS,
  SESSION_GOVERNANCE_DEFAULTS,
  SPEC_DOMAIN_POLICY_DEFAULTS,
  PROBLEM_CLOSURE_POLICY_DEFAULTS,
  PROBLEM_EVAL_POLICY_DEFAULTS,
  STUDIO_INTAKE_POLICY_DEFAULTS,
  applyTakeoverBaseline
};
