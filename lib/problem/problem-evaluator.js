const path = require('path');
const fs = require('fs-extra');

const PROBLEM_EVAL_API_VERSION = 'sce.problem-eval/v0.1';
const DEFAULT_POLICY_PATH = '.sce/config/problem-eval-policy.json';
const DEFAULT_REPORT_DIR = '.sce/reports/problem-eval';
const STUDIO_STAGES = Object.freeze(['plan', 'generate', 'apply', 'verify', 'release']);
const DEBUG_EVIDENCE_TAGS = Object.freeze(['debug-evidence', 'diagnostic-evidence', 'debug-log']);
const ONTOLOGY_AXES = Object.freeze(['entity', 'relation', 'business_rule', 'decision_policy', 'execution_flow']);

const DEFAULT_PROBLEM_EVAL_POLICY = Object.freeze({
  schema_version: '1.0',
  enabled: true,
  mode: 'required',
  enforce_on_stages: [...STUDIO_STAGES],
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
  problem_contract_required_stages: [...STUDIO_STAGES],
  problem_contract_block_stages: ['plan', 'apply', 'release'],
  ontology_alignment_required_stages: [...STUDIO_STAGES],
  ontology_alignment_block_stages: ['apply', 'release'],
  ontology_required_axes: [...ONTOLOGY_AXES],
  require_ontology_evidence_binding: true,
  ontology_evidence_min_bindings: 1,
  convergence_required_stages: ['verify', 'release'],
  convergence_block_stages: ['release'],
  release_block_on_high_alerts: true,
  release_require_governance_report: false
});

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeLowerText(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = normalizeLowerText(`${value || ''}`);
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

function normalizeInteger(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(`${value}`, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed < min) {
    return min;
  }
  if (parsed > max) {
    return max;
  }
  return parsed;
}

function normalizeArray(value = []) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => normalizeText(item)).filter(Boolean);
}

function normalizeTextList(value = [], limit = 20) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === 'string') {
        return normalizeText(item);
      }
      if (item && typeof item === 'object') {
        return normalizeText(item.step || item.description || item.id || item.name || '');
      }
      return '';
    })
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeStageArray(value, fallback = []) {
  const candidates = normalizeArray(value).map((item) => item.toLowerCase());
  const filtered = candidates.filter((item, index) => STUDIO_STAGES.includes(item) && candidates.indexOf(item) === index);
  return filtered.length > 0 ? filtered : [...fallback];
}

function normalizeOntologyAxisArray(value, fallback = []) {
  const candidates = normalizeArray(value).map((item) => item.toLowerCase());
  const filtered = candidates.filter((item, index) => ONTOLOGY_AXES.includes(item) && candidates.indexOf(item) === index);
  return filtered.length > 0 ? filtered : [...fallback];
}

function normalizeIncidentState(value, fallback = 'open') {
  const normalized = normalizeLowerText(value);
  if (!normalized) {
    return fallback;
  }
  if (normalized === 'open' || normalized === 'resolved') {
    return normalized;
  }
  return fallback;
}

function hasDebugEvidenceInAttempt(attempt = {}) {
  const tags = normalizeArray(attempt.tags).map((item) => item.toLowerCase());
  if (tags.some((tag) => DEBUG_EVIDENCE_TAGS.includes(tag))) {
    return true;
  }
  const verification = normalizeArray(attempt.verification_evidence);
  if (verification.some((item) => /^debug:/i.test(item))) {
    return true;
  }
  const notes = normalizeLowerText(attempt.notes);
  if (notes && /(debug|trace|diagnostic|observability|telemetry|日志|埋点|观测)/i.test(notes)) {
    return true;
  }
  return false;
}

function normalizePolicy(policy = {}, env = process.env) {
  const envMode = normalizeLowerText(env.SCE_PROBLEM_EVAL_MODE);
  const envDisabled = normalizeBoolean(env.SCE_PROBLEM_EVAL_DISABLED, false);
  const mode = envMode === 'off' || envMode === 'advisory' || envMode === 'required'
    ? envMode
    : normalizeLowerText(policy.mode) || DEFAULT_PROBLEM_EVAL_POLICY.mode;
  const enabled = envDisabled
    ? false
    : mode === 'off'
      ? false
      : normalizeBoolean(policy.enabled, DEFAULT_PROBLEM_EVAL_POLICY.enabled);
  const minByStage = {
    ...DEFAULT_PROBLEM_EVAL_POLICY.min_confidence_by_stage,
    ...(policy.min_confidence_by_stage && typeof policy.min_confidence_by_stage === 'object'
      ? policy.min_confidence_by_stage
      : {})
  };

  const normalized = {
    schema_version: normalizeText(policy.schema_version) || DEFAULT_PROBLEM_EVAL_POLICY.schema_version,
    enabled,
    mode: mode || DEFAULT_PROBLEM_EVAL_POLICY.mode,
    enforce_on_stages: normalizeStageArray(
      policy.enforce_on_stages,
      DEFAULT_PROBLEM_EVAL_POLICY.enforce_on_stages
    ),
    block_on_stages: normalizeStageArray(
      policy.block_on_stages,
      DEFAULT_PROBLEM_EVAL_POLICY.block_on_stages
    ),
    min_confidence_by_stage: {
      plan: normalizeInteger(minByStage.plan, DEFAULT_PROBLEM_EVAL_POLICY.min_confidence_by_stage.plan, 0, 100),
      generate: normalizeInteger(minByStage.generate, DEFAULT_PROBLEM_EVAL_POLICY.min_confidence_by_stage.generate, 0, 100),
      apply: normalizeInteger(minByStage.apply, DEFAULT_PROBLEM_EVAL_POLICY.min_confidence_by_stage.apply, 0, 100),
      verify: normalizeInteger(minByStage.verify, DEFAULT_PROBLEM_EVAL_POLICY.min_confidence_by_stage.verify, 0, 100),
      release: normalizeInteger(minByStage.release, DEFAULT_PROBLEM_EVAL_POLICY.min_confidence_by_stage.release, 0, 100)
    },
    high_risk_requires_debug_evidence: normalizeBoolean(
      policy.high_risk_requires_debug_evidence,
      DEFAULT_PROBLEM_EVAL_POLICY.high_risk_requires_debug_evidence
    ),
    high_risk_keywords: normalizeArray(policy.high_risk_keywords).length > 0
      ? normalizeArray(policy.high_risk_keywords).map((item) => item.toLowerCase())
      : [...DEFAULT_PROBLEM_EVAL_POLICY.high_risk_keywords],
    recommendation_limit: normalizeInteger(
      policy.recommendation_limit,
      DEFAULT_PROBLEM_EVAL_POLICY.recommendation_limit,
      1,
      20
    ),
    max_failed_rounds_before_debug: normalizeInteger(
      policy.max_failed_rounds_before_debug,
      DEFAULT_PROBLEM_EVAL_POLICY.max_failed_rounds_before_debug,
      1,
      10
    ),
    problem_contract_required_stages: normalizeStageArray(
      policy.problem_contract_required_stages,
      DEFAULT_PROBLEM_EVAL_POLICY.problem_contract_required_stages
    ),
    problem_contract_block_stages: normalizeStageArray(
      policy.problem_contract_block_stages,
      DEFAULT_PROBLEM_EVAL_POLICY.problem_contract_block_stages
    ),
    ontology_alignment_required_stages: normalizeStageArray(
      policy.ontology_alignment_required_stages,
      DEFAULT_PROBLEM_EVAL_POLICY.ontology_alignment_required_stages
    ),
    ontology_alignment_block_stages: normalizeStageArray(
      policy.ontology_alignment_block_stages,
      DEFAULT_PROBLEM_EVAL_POLICY.ontology_alignment_block_stages
    ),
    ontology_required_axes: normalizeOntologyAxisArray(
      policy.ontology_required_axes,
      DEFAULT_PROBLEM_EVAL_POLICY.ontology_required_axes
    ),
    require_ontology_evidence_binding: normalizeBoolean(
      policy.require_ontology_evidence_binding,
      DEFAULT_PROBLEM_EVAL_POLICY.require_ontology_evidence_binding
    ),
    ontology_evidence_min_bindings: normalizeInteger(
      policy.ontology_evidence_min_bindings,
      DEFAULT_PROBLEM_EVAL_POLICY.ontology_evidence_min_bindings,
      0,
      20
    ),
    convergence_required_stages: normalizeStageArray(
      policy.convergence_required_stages,
      DEFAULT_PROBLEM_EVAL_POLICY.convergence_required_stages
    ),
    convergence_block_stages: normalizeStageArray(
      policy.convergence_block_stages,
      DEFAULT_PROBLEM_EVAL_POLICY.convergence_block_stages
    ),
    release_block_on_high_alerts: normalizeBoolean(
      policy.release_block_on_high_alerts,
      DEFAULT_PROBLEM_EVAL_POLICY.release_block_on_high_alerts
    ),
    release_require_governance_report: normalizeBoolean(
      policy.release_require_governance_report,
      DEFAULT_PROBLEM_EVAL_POLICY.release_require_governance_report
    )
  };

  return normalized;
}

async function loadProblemEvalPolicy(projectPath = process.cwd(), fileSystem = fs, env = process.env) {
  const policyPath = path.join(projectPath, DEFAULT_POLICY_PATH);
  let payload = {};
  if (await fileSystem.pathExists(policyPath)) {
    try {
      payload = await fileSystem.readJson(policyPath);
    } catch (error) {
      throw new Error(`Failed to read problem-eval policy: ${error.message}`);
    }
  }

  const policy = normalizePolicy(payload, env);
  return {
    policy_path: policyPath,
    policy
  };
}

function scoreRisk(stage, text, policy, incidentSignals = {}, releaseChannel = '') {
  let score = 0;
  const signals = [];
  const keywords = Array.isArray(policy.high_risk_keywords) ? policy.high_risk_keywords : [];
  let keywordHits = 0;
  for (const keyword of keywords) {
    if (!keyword) {
      continue;
    }
    if (text.includes(keyword)) {
      keywordHits += 1;
    }
  }
  if (keywordHits > 0) {
    const keywordScore = Math.min(30, keywordHits * 6);
    score += keywordScore;
    signals.push(`high-risk-keywords:${keywordHits}`);
  }

  if (stage === 'release') {
    score += 28;
    signals.push('stage-release');
  } else if (stage === 'verify') {
    score += 18;
    signals.push('stage-verify');
  } else if (stage === 'apply') {
    score += 14;
    signals.push('stage-apply');
  } else if (stage === 'generate') {
    score += 8;
    signals.push('stage-generate');
  }

  if (normalizeLowerText(releaseChannel) === 'prod') {
    score += 18;
    signals.push('channel-prod');
  }

  const openIncidents = Number(incidentSignals.open_incident_count || 0);
  const maxAttempts = Number(incidentSignals.max_attempt_count || 0);
  if (openIncidents > 0) {
    score += Math.min(20, openIncidents * 3);
    signals.push(`open-incidents:${openIncidents}`);
  }
  const debugRoundThreshold = Number(policy.max_failed_rounds_before_debug || 2) + 1;
  if (maxAttempts >= debugRoundThreshold) {
    score += 16;
    signals.push(`repeat-attempts:${maxAttempts}`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  let level = 'low';
  if (score >= 70) {
    level = 'high';
  } else if (score >= 40) {
    level = 'medium';
  }

  return { score, level, signals };
}

function stageInPolicy(stage, list = []) {
  return Array.isArray(list) && list.includes(stage);
}

function countOntologyEvidenceBindings(domainChain = {}, summary = {}) {
  const summaryCount = Number(summary.evidence_binding_count || 0);
  if (Number.isFinite(summaryCount) && summaryCount > 0) {
    return summaryCount;
  }

  let total = 0;
  const explicitBindings = Array.isArray(domainChain.evidence_bindings)
    ? domainChain.evidence_bindings.length
    : 0;
  total += explicitBindings;

  const ontologyEvidence = domainChain.ontology_evidence && typeof domainChain.ontology_evidence === 'object'
    ? domainChain.ontology_evidence
    : {};
  for (const axis of ONTOLOGY_AXES) {
    total += normalizeTextList(ontologyEvidence[axis], 50).length;
  }

  const hypotheses = Array.isArray(domainChain.hypotheses) ? domainChain.hypotheses : [];
  for (const hypothesis of hypotheses.slice(0, 30)) {
    total += normalizeTextList(hypothesis && hypothesis.evidence, 20).length;
  }

  return total;
}

function extractDomainChainSummary(domainChain = {}) {
  const summary = domainChain.summary && typeof domainChain.summary === 'object'
    ? domainChain.summary
    : {};
  const payloadOntology = domainChain.ontology && typeof domainChain.ontology === 'object'
    ? domainChain.ontology
    : {};

  const fallbackCounts = {
    entity: normalizeTextList(payloadOntology.entity, 50).length,
    relation: normalizeTextList(payloadOntology.relation, 50).length,
    business_rule: normalizeTextList(payloadOntology.business_rule, 50).length,
    decision_policy: normalizeTextList(payloadOntology.decision_policy, 50).length,
    execution_flow: normalizeTextList(payloadOntology.execution_flow, 50).length
  };

  const summaryCounts = summary.ontology_counts && typeof summary.ontology_counts === 'object'
    ? summary.ontology_counts
    : {};
  const ontologyCounts = {
    entity: Number(summaryCounts.entity || fallbackCounts.entity || 0),
    relation: Number(summaryCounts.relation || fallbackCounts.relation || 0),
    business_rule: Number(summaryCounts.business_rule || fallbackCounts.business_rule || 0),
    decision_policy: Number(summaryCounts.decision_policy || fallbackCounts.decision_policy || 0),
    execution_flow: Number(summaryCounts.execution_flow || fallbackCounts.execution_flow || 0)
  };

  return {
    ontology_counts: ontologyCounts,
    decision_path_steps: Number(
      summary.decision_path_steps
      || (Array.isArray(domainChain.decision_execution_path) ? domainChain.decision_execution_path.length : 0)
      || 0
    ),
    verification_gates: Array.isArray(summary.verification_gates)
      ? summary.verification_gates
      : (domainChain?.verification?.gates && Array.isArray(domainChain.verification.gates) ? domainChain.verification.gates : []),
    hypothesis_count: Number(summary.hypothesis_count || (Array.isArray(domainChain.hypotheses) ? domainChain.hypotheses.length : 0) || 0),
    risk_count: Number(summary.risk_count || (Array.isArray(domainChain.risks) ? domainChain.risks.length : 0) || 0),
    evidence_binding_count: countOntologyEvidenceBindings(domainChain, summary)
  };
}

function deriveProblemContract(context = {}) {
  const domainChain = context.domain_chain && typeof context.domain_chain === 'object'
    ? context.domain_chain
    : {};
  const chainContext = domainChain.context && typeof domainChain.context === 'object'
    ? domainChain.context
    : {};
  const contractRaw = context.problem_contract && typeof context.problem_contract === 'object'
    ? context.problem_contract
    : {};

  const issueStatement = normalizeText(
    contractRaw.issue_statement
    || contractRaw.issue
    || contractRaw.problem_statement
    || chainContext?.problem?.statement
    || domainChain?.problem?.statement
    || context.goal
    || (context.scene_id ? `Stabilize scene ${normalizeText(context.scene_id)} execution.` : '')
  );
  const expectedOutcome = normalizeText(
    contractRaw.expected_outcome
    || contractRaw.expected
    || contractRaw.success_criteria
    || chainContext?.verification?.plan
    || domainChain?.verification?.plan
    || (context.scene_id ? `Scene ${normalizeText(context.scene_id)} reaches deterministic verification gates.` : '')
  );
  const reproductionStepsRaw = normalizeTextList(
    contractRaw.reproduction_steps
    || contractRaw.repro_steps
    || contractRaw.steps,
    20
  );
  const reproductionSteps = reproductionStepsRaw.length > 0
    ? reproductionStepsRaw
    : [
      normalizeText(context.goal) || 'Reproduce the reported failure path in the target scene.',
      'Capture execution trace and gate evidence for the failing path.'
    ].filter(Boolean);
  const impactScope = normalizeText(
    contractRaw.impact_scope
    || contractRaw.scope
    || chainContext?.problem?.scope
    || domainChain?.problem?.scope
    || context.scene_id
  );
  const forbiddenWorkaroundsRaw = normalizeTextList(
    contractRaw.forbidden_workarounds
    || contractRaw.prohibited_workarounds
    || contractRaw.disallowed_workarounds,
    20
  );
  const forbiddenWorkarounds = forbiddenWorkaroundsRaw.length > 0
    ? forbiddenWorkaroundsRaw
    : [
      'Do not bypass mandatory gates or tests.',
      'Do not silence errors without root-cause remediation.'
    ];
  return {
    issue_statement: issueStatement,
    expected_outcome: expectedOutcome,
    reproduction_steps: reproductionSteps,
    impact_scope: impactScope,
    forbidden_workarounds: forbiddenWorkarounds
  };
}

function evaluateProblemContract(context = {}) {
  const contract = deriveProblemContract(context);
  const checks = {
    issue_statement: normalizeText(contract.issue_statement).length > 0,
    expected_outcome: normalizeText(contract.expected_outcome).length > 0,
    reproduction_steps: Array.isArray(contract.reproduction_steps) && contract.reproduction_steps.length > 0,
    impact_scope: normalizeText(contract.impact_scope).length > 0,
    forbidden_workarounds: Array.isArray(contract.forbidden_workarounds) && contract.forbidden_workarounds.length > 0
  };
  const total = Object.keys(checks).length;
  const covered = Object.values(checks).filter(Boolean).length;
  return {
    contract,
    checks,
    total,
    covered,
    missing: Object.keys(checks).filter((key) => !checks[key]),
    score: Math.round((covered / total) * 100),
    passed: covered === total
  };
}

function evaluateOntologyAlignment(context = {}, policy = DEFAULT_PROBLEM_EVAL_POLICY) {
  const domainChain = context.domain_chain && typeof context.domain_chain === 'object'
    ? context.domain_chain
    : {};
  const summary = extractDomainChainSummary(domainChain);
  const requiredAxes = Array.isArray(policy.ontology_required_axes) && policy.ontology_required_axes.length > 0
    ? policy.ontology_required_axes
    : [...ONTOLOGY_AXES];
  const missingAxes = requiredAxes.filter((axis) => Number(summary?.ontology_counts?.[axis] || 0) <= 0);
  const evidenceBindingCount = Number(summary.evidence_binding_count || 0);
  const minBindings = Number(policy.ontology_evidence_min_bindings || 0);
  const hasDomainMaterial = domainChain.resolved === true
    || ONTOLOGY_AXES.some((axis) => Number(summary?.ontology_counts?.[axis] || 0) > 0)
    || normalizeText(context.spec_id).length > 0;
  if (!hasDomainMaterial) {
    return {
      required_axes: requiredAxes,
      missing_axes: [],
      ontology_counts: summary.ontology_counts,
      evidence_binding_count: evidenceBindingCount,
      required_evidence_bindings: minBindings,
      evidence_satisfied: true,
      score: 100,
      passed: true,
      skipped: true
    };
  }
  const evidenceSatisfied = policy.require_ontology_evidence_binding !== true
    ? true
    : evidenceBindingCount >= minBindings;

  let score = 0;
  if (requiredAxes.length > 0) {
    score += Math.round(((requiredAxes.length - missingAxes.length) / requiredAxes.length) * 80);
  }
  if (evidenceSatisfied) {
    score += 20;
  }
  score = Math.max(0, Math.min(100, score));

  return {
    required_axes: requiredAxes,
    missing_axes: missingAxes,
    ontology_counts: summary.ontology_counts,
    evidence_binding_count: evidenceBindingCount,
    required_evidence_bindings: minBindings,
    evidence_satisfied: evidenceSatisfied,
    score,
    passed: missingAxes.length === 0 && evidenceSatisfied
  };
}

function evaluateConvergence(context = {}, stage = '', policy = DEFAULT_PROBLEM_EVAL_POLICY) {
  const readiness = context.stage_readiness && typeof context.stage_readiness === 'object'
    ? context.stage_readiness
    : {};
  const checks = {
    prerequisites_ready: readiness.prerequisites_ready === true
  };
  if (stage === 'release') {
    checks.verify_report_ready = readiness.verify_report_ready === true;
    checks.verify_stage_passed = readiness.verify_stage_passed !== false;
    checks.regression_passed = readiness.regression_passed !== false;
    const highAlertCount = Number(readiness.high_alert_count || 0);
    checks.high_alerts_clear = policy.release_block_on_high_alerts === true
      ? highAlertCount <= 0
      : true;
    if (policy.release_require_governance_report === true) {
      checks.governance_report_ready = readiness.governance_report_ready === true;
    }
  }

  const total = Object.keys(checks).length;
  const covered = Object.values(checks).filter(Boolean).length;
  const missing = Object.keys(checks).filter((key) => !checks[key]);
  const score = total > 0 ? Math.round((covered / total) * 100) : 100;

  return {
    checks,
    missing,
    score,
    passed: missing.length === 0
  };
}

function scoreEvidence(context = {}, incidentSignals = {}) {
  const signals = [];
  let score = 0;
  const domainChain = context.domain_chain && typeof context.domain_chain === 'object'
    ? context.domain_chain
    : {};
  const summary = extractDomainChainSummary(domainChain);

  if (domainChain.resolved === true) {
    score += 20;
    signals.push('domain-chain-resolved');
  }
  const decisionSteps = Number(summary.decision_path_steps || 0);
  if (decisionSteps >= 3) {
    score += 15;
    signals.push(`decision-path:${decisionSteps}`);
  } else if (decisionSteps > 0) {
    score += 8;
    signals.push(`decision-path-partial:${decisionSteps}`);
  }
  const verificationGates = Array.isArray(summary.verification_gates) ? summary.verification_gates.length : 0;
  if (verificationGates > 0) {
    score += Math.min(12, verificationGates * 3);
    signals.push(`verification-gates:${verificationGates}`);
  }
  const relatedSpecsCount = Number(context.related_specs_count || 0);
  if (relatedSpecsCount > 0) {
    score += Math.min(15, 8 + relatedSpecsCount);
    signals.push(`related-specs:${relatedSpecsCount}`);
  }
  if (incidentSignals.has_debug_evidence === true) {
    score += 15;
    signals.push('debug-evidence-present');
  }
  const stageReadiness = context.stage_readiness && typeof context.stage_readiness === 'object'
    ? context.stage_readiness
    : {};
  if (stageReadiness.prerequisites_ready === true) {
    score += 8;
    signals.push('stage-prerequisites-ready');
  }
  if (stageReadiness.rollback_ready === true) {
    score += 10;
    signals.push('rollback-ready');
  }
  if (stageReadiness.gate_required_ready === true) {
    score += 6;
    signals.push('required-gates-available');
  }
  const evidenceBindingCount = Number(summary.evidence_binding_count || 0);
  if (evidenceBindingCount > 0) {
    score += Math.min(10, evidenceBindingCount);
    signals.push(`ontology-evidence-bindings:${evidenceBindingCount}`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, signals };
}

function scoreReadiness(context = {}) {
  const signals = [];
  let score = 0;
  const stageReadiness = context.stage_readiness && typeof context.stage_readiness === 'object'
    ? context.stage_readiness
    : {};

  if (normalizeText(context.scene_id)) {
    score += 20;
    signals.push('scene-defined');
  }
  if (normalizeText(context.goal)) {
    score += 10;
    signals.push('goal-defined');
  }
  if (normalizeText(context.spec_id)) {
    score += 10;
    signals.push('spec-bound');
  }
  if (stageReadiness.prerequisites_ready === true) {
    score += 25;
    signals.push('prerequisites-ready');
  }
  if (stageReadiness.patch_bundle_ready === true) {
    score += 15;
    signals.push('patch-bundle-ready');
  }
  if (stageReadiness.verify_report_ready === true) {
    score += 10;
    signals.push('verify-report-ready');
  }
  const gateSignals = context.gate_signals && typeof context.gate_signals === 'object'
    ? context.gate_signals
    : {};
  const requiredTotal = Number(gateSignals.required_total || 0);
  const requiredEnabled = Number(gateSignals.required_enabled || 0);
  if (requiredTotal > 0) {
    const ratio = requiredEnabled / requiredTotal;
    score += Math.round(Math.max(0, Math.min(10, ratio * 10)));
    signals.push(`gate-availability:${requiredEnabled}/${requiredTotal}`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, signals };
}

function deriveStrategy(stage, risk, evidence, confidence, incidentSignals = {}, policy = DEFAULT_PROBLEM_EVAL_POLICY) {
  const reasons = [];
  let strategy = 'direct-execution';
  const debugAttemptThreshold = Number(policy.max_failed_rounds_before_debug || 2) + 1;
  if (Number(incidentSignals.max_attempt_count || 0) >= debugAttemptThreshold
    && policy.high_risk_requires_debug_evidence
    && incidentSignals.has_debug_evidence !== true) {
    strategy = 'debug-first';
    reasons.push('repeated-failures-without-debug-evidence');
    return { strategy, reasons };
  }
  if (risk.level === 'high' && evidence.score < 55) {
    strategy = 'evidence-first';
    reasons.push('high-risk-insufficient-evidence');
    return { strategy, reasons };
  }
  if (confidence < 45) {
    strategy = 'explore-and-validate';
    reasons.push('low-confidence');
    return { strategy, reasons };
  }
  if (stage === 'release' && risk.level !== 'low') {
    strategy = 'controlled-execution';
    reasons.push('release-risk-control');
    return { strategy, reasons };
  }
  reasons.push('confidence-sufficient');
  return { strategy, reasons };
}

function evaluateProblemContext(context = {}, policy = DEFAULT_PROBLEM_EVAL_POLICY) {
  const stage = normalizeLowerText(context.stage);
  if (!STUDIO_STAGES.includes(stage)) {
    throw new Error(`Unsupported problem-eval stage: ${context.stage || 'unknown'}`);
  }

  const textForRisk = [
    normalizeLowerText(context.goal),
    normalizeLowerText(context.scene_id),
    normalizeLowerText(context.spec_id),
    normalizeLowerText(context?.domain_chain?.reason),
    normalizeLowerText(context.release_channel)
  ].join(' ');

  const incidentSignals = context.incident_signals && typeof context.incident_signals === 'object'
    ? context.incident_signals
    : {};
  const risk = scoreRisk(stage, textForRisk, policy, incidentSignals, context.release_channel);
  const evidence = scoreEvidence(context, incidentSignals);
  const readiness = scoreReadiness(context);
  const problemContract = evaluateProblemContract(context);
  const ontologyAlignment = evaluateOntologyAlignment(context, policy);
  const convergence = evaluateConvergence(context, stage, policy);
  const confidenceScore = Math.max(0, Math.min(100, Math.round(
    evidence.score * 0.32
    + readiness.score * 0.24
    + (100 - risk.score) * 0.14
    + problemContract.score * 0.15
    + ontologyAlignment.score * 0.10
    + convergence.score * 0.05
  )));

  const minConfidence = Number(policy?.min_confidence_by_stage?.[stage] || 0);
  const strategy = deriveStrategy(stage, risk, evidence, confidenceScore, incidentSignals, policy);
  const blockers = [];
  const warnings = [];

  const enforced = policy.enabled === true && Array.isArray(policy.enforce_on_stages) && policy.enforce_on_stages.includes(stage);
  const blockStage = Array.isArray(policy.block_on_stages) && policy.block_on_stages.includes(stage);
  const advisoryMode = policy.mode === 'advisory';

  if (confidenceScore < minConfidence) {
    warnings.push(`confidence ${confidenceScore} below threshold ${minConfidence}`);
    if (blockStage) {
      blockers.push(`confidence-too-low:${confidenceScore}<${minConfidence}`);
    }
  }

  const debugAttemptThreshold = Number(policy.max_failed_rounds_before_debug || 2) + 1;
  if (policy.high_risk_requires_debug_evidence
    && risk.level === 'high'
    && Number(incidentSignals.max_attempt_count || 0) >= debugAttemptThreshold
    && incidentSignals.has_debug_evidence !== true) {
    warnings.push('high risk with repeated failed attempts and no debug evidence');
    if (blockStage) {
      blockers.push('missing-debug-evidence-after-repeated-failures');
    }
  }

  if (evidence.score < 35) {
    warnings.push(`evidence score ${evidence.score} is low`);
    if (blockStage && risk.level === 'high') {
      blockers.push(`high-risk-low-evidence:${evidence.score}`);
    }
  }

  const problemContractRequired = stageInPolicy(stage, policy.problem_contract_required_stages);
  const problemContractBlockedStage = stageInPolicy(stage, policy.problem_contract_block_stages);
  if (problemContractRequired && !problemContract.passed) {
    warnings.push(`problem contract incomplete: ${problemContract.missing.join(', ')}`);
    if (problemContractBlockedStage) {
      blockers.push(`problem-contract-incomplete:${problemContract.missing.join('|')}`);
    }
  }

  const ontologyRequired = stageInPolicy(stage, policy.ontology_alignment_required_stages);
  const ontologyBlockedStage = stageInPolicy(stage, policy.ontology_alignment_block_stages);
  if (ontologyRequired && !ontologyAlignment.passed) {
    if (ontologyAlignment.missing_axes.length > 0) {
      warnings.push(`ontology alignment missing axes: ${ontologyAlignment.missing_axes.join(', ')}`);
    }
    if (!ontologyAlignment.evidence_satisfied) {
      warnings.push(
        `ontology evidence binding below threshold: ${ontologyAlignment.evidence_binding_count}<${ontologyAlignment.required_evidence_bindings}`
      );
    }
    if (ontologyBlockedStage) {
      if (ontologyAlignment.missing_axes.length > 0) {
        blockers.push(`ontology-alignment-missing:${ontologyAlignment.missing_axes.join('|')}`);
      }
      if (!ontologyAlignment.evidence_satisfied) {
        blockers.push(
          `ontology-evidence-binding-low:${ontologyAlignment.evidence_binding_count}<${ontologyAlignment.required_evidence_bindings}`
        );
      }
    }
  }

  const convergenceRequired = stageInPolicy(stage, policy.convergence_required_stages);
  const convergenceBlockedStage = stageInPolicy(stage, policy.convergence_block_stages);
  if (convergenceRequired && !convergence.passed) {
    warnings.push(`convergence checks pending: ${convergence.missing.join(', ')}`);
    if (convergenceBlockedStage) {
      blockers.push(`convergence-gate-missing:${convergence.missing.join('|')}`);
    }
  }

  const recommendations = [];
  if (strategy.strategy === 'debug-first') {
    recommendations.push('Capture debug trace/log evidence before the next patch attempt.');
  }
  if (strategy.strategy === 'evidence-first' || evidence.score < 45) {
    recommendations.push('Refresh domain artifacts and verify ontology coverage before execution.');
    recommendations.push('Load related historical specs and compare successful remediation paths.');
  }
  if (risk.level !== 'low') {
    recommendations.push('Prefer guarded execution with rollback checkpoints and release gates enabled.');
  }
  if (Number(incidentSignals.open_incident_count || 0) > 0) {
    recommendations.push('Review staging incident attempts to avoid repeating failed actions.');
  }
  if (!problemContract.passed) {
    recommendations.push('Complete the problem contract: issue, expected outcome, reproduction steps, impact scope, and forbidden workarounds.');
  }
  if (!ontologyAlignment.passed) {
    recommendations.push('Fill missing ontology axes and bind evidence references before further remediation.');
  }
  if (!convergence.passed) {
    recommendations.push('Close convergence checks (verify pass, regression pass, high-alert clear) before release.');
  }
  if (recommendations.length === 0) {
    recommendations.push('Proceed with direct execution and keep gate verification enabled.');
  }

  const cappedRecommendations = recommendations.slice(0, policy.recommendation_limit || 6);
  const hardBlockStage = blockStage || problemContractBlockedStage || ontologyBlockedStage || convergenceBlockedStage;
  const blocked = enforced && hardBlockStage && !advisoryMode && blockers.length > 0;

  return {
    mode: 'problem-eval',
    api_version: PROBLEM_EVAL_API_VERSION,
    generated_at: new Date().toISOString(),
    stage,
    scene_id: normalizeText(context.scene_id),
    spec_id: normalizeText(context.spec_id),
    job_id: normalizeText(context.job_id),
    policy: {
      enabled: policy.enabled === true,
      mode: policy.mode,
      enforced,
      block_stage: blockStage,
      hard_block_stage: hardBlockStage,
      min_confidence: minConfidence
    },
    dimensions: {
      risk,
      evidence,
      readiness,
      strategy,
      problem_contract: problemContract,
      ontology_alignment: ontologyAlignment,
      convergence
    },
    incident_signals: {
      ...incidentSignals
    },
    confidence_score: confidenceScore,
    warnings,
    blockers,
    recommendations: cappedRecommendations,
    passed: !blocked,
    blocked
  };
}

function isIncidentRelevantToContext(incident = {}, context = {}) {
  const wantedSpecId = normalizeText(context.spec_id);
  const wantedSceneId = normalizeText(context.scene_id);
  const wantedGoal = normalizeLowerText(context.goal);
  if (!wantedSpecId && !wantedSceneId && !wantedGoal) {
    return true;
  }

  const title = normalizeLowerText(incident.title);
  const symptom = normalizeLowerText(incident.symptom);
  const matchesGoal = wantedGoal && (title.includes(wantedGoal) || symptom.includes(wantedGoal));
  const matchesSpec = wantedSpecId
    && Array.isArray(incident.attempts)
    && incident.attempts.some((attempt) => normalizeText(attempt?.source?.spec) === wantedSpecId);
  const matchesScene = wantedSceneId
    && (title.includes(wantedSceneId.toLowerCase()) || symptom.includes(wantedSceneId.toLowerCase()));
  return Boolean(matchesSpec || matchesScene || matchesGoal);
}

async function collectIncidentSignals(projectPath = process.cwd(), context = {}, fileSystem = fs) {
  const indexPath = path.join(projectPath, '.sce', 'errorbook', 'staging', 'index.json');
  if (!await fileSystem.pathExists(indexPath)) {
    return {
      has_staging_data: false,
      total_incident_count: 0,
      open_incident_count: 0,
      resolved_incident_count: 0,
      relevant_incident_count: 0,
      max_attempt_count: 0,
      has_debug_evidence: false
    };
  }

  const indexPayload = await fileSystem.readJson(indexPath).catch(() => null);
  if (!indexPayload || !Array.isArray(indexPayload.incidents)) {
    return {
      has_staging_data: true,
      total_incident_count: 0,
      open_incident_count: 0,
      resolved_incident_count: 0,
      relevant_incident_count: 0,
      max_attempt_count: 0,
      has_debug_evidence: false
    };
  }

  const incidentsDir = path.join(projectPath, '.sce', 'errorbook', 'staging', 'incidents');
  let relevantCount = 0;
  let maxAttemptCount = 0;
  let hasDebugEvidence = false;

  for (const summary of indexPayload.incidents.slice(0, 200)) {
    const incidentId = normalizeText(summary.id);
    if (!incidentId) {
      continue;
    }
    const incidentPath = path.join(incidentsDir, `${incidentId}.json`);
    if (!await fileSystem.pathExists(incidentPath)) {
      continue;
    }
    const incident = await fileSystem.readJson(incidentPath).catch(() => null);
    if (!incident || !isIncidentRelevantToContext(incident, context)) {
      continue;
    }
    relevantCount += 1;
    const attemptCount = Number(incident.attempt_count || (Array.isArray(incident.attempts) ? incident.attempts.length : 0) || 0);
    if (attemptCount > maxAttemptCount) {
      maxAttemptCount = attemptCount;
    }
    if (Array.isArray(incident.attempts) && incident.attempts.some((attempt) => hasDebugEvidenceInAttempt(attempt))) {
      hasDebugEvidence = true;
    }
  }

  return {
    has_staging_data: true,
    total_incident_count: indexPayload.incidents.length,
    open_incident_count: indexPayload.incidents.filter((item) => normalizeIncidentState(item.state, 'open') === 'open').length,
    resolved_incident_count: indexPayload.incidents.filter((item) => normalizeIncidentState(item.state, 'open') === 'resolved').length,
    relevant_incident_count: relevantCount,
    max_attempt_count: maxAttemptCount,
    has_debug_evidence: hasDebugEvidence
  };
}

function toRelativePosix(projectPath, absolutePath) {
  return path.relative(projectPath, absolutePath).replace(/\\/g, '/');
}

function sanitizeSegment(value, fallback = 'adhoc') {
  const normalized = normalizeText(value);
  if (!normalized) {
    return fallback;
  }
  return normalized.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

async function runProblemEvaluation(context = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;
  const writeReport = dependencies.writeReport !== false;
  const policyBundle = dependencies.policyBundle || await loadProblemEvalPolicy(projectPath, fileSystem, env);
  const policy = policyBundle.policy;
  const incidentSignals = context.incident_signals || await collectIncidentSignals(projectPath, context, fileSystem);
  const report = evaluateProblemContext({
    ...context,
    incident_signals: incidentSignals
  }, policy);

  if (writeReport) {
    const reportDir = path.join(projectPath, DEFAULT_REPORT_DIR);
    const stage = sanitizeSegment(report.stage, 'stage');
    const jobId = sanitizeSegment(report.job_id, `adhoc-${Date.now()}`);
    const reportPath = path.join(reportDir, `${jobId}-${stage}.json`);
    await fileSystem.ensureDir(path.dirname(reportPath));
    await fileSystem.writeJson(reportPath, report, { spaces: 2 });
    report.report_file = toRelativePosix(projectPath, reportPath);
  }

  return report;
}

module.exports = {
  PROBLEM_EVAL_API_VERSION,
  DEFAULT_POLICY_PATH,
  DEFAULT_REPORT_DIR,
  DEFAULT_PROBLEM_EVAL_POLICY,
  normalizePolicy,
  loadProblemEvalPolicy,
  collectIncidentSignals,
  evaluateProblemContext,
  runProblemEvaluation
};
