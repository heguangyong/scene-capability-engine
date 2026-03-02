#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs-extra');
const {
  validateSpecDomainArtifacts,
  analyzeSpecDomainCoverage
} = require('../lib/spec/domain-modeling');

const DEFAULT_POLICY_PATH = '.sce/config/problem-closure-policy.json';
const DEFAULT_GOVERNANCE_REPORT = '.sce/reports/interactive-governance-report.json';
const DEFAULT_CONTRACT_RELATIVE_PATH = path.join('custom', 'problem-contract.json');
const DEFAULT_POLICY = Object.freeze({
  schema_version: '1.0',
  enabled: true,
  governance_report_path: DEFAULT_GOVERNANCE_REPORT,
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

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
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

function parseArgs(argv = []) {
  const options = {
    projectPath: process.cwd(),
    stage: 'release',
    spec: '',
    policy: DEFAULT_POLICY_PATH,
    verifyReport: '',
    governanceReport: DEFAULT_GOVERNANCE_REPORT,
    failOnBlock: false,
    json: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--project-path' && next) {
      options.projectPath = path.resolve(next);
      index += 1;
    } else if (token === '--stage' && next) {
      options.stage = normalizeText(next).toLowerCase();
      index += 1;
    } else if ((token === '--spec' || token === '--spec-id') && next) {
      options.spec = normalizeText(next);
      index += 1;
    } else if (token === '--policy' && next) {
      options.policy = normalizeText(next);
      index += 1;
    } else if (token === '--verify-report' && next) {
      options.verifyReport = normalizeText(next);
      index += 1;
    } else if (token === '--governance-report' && next) {
      options.governanceReport = normalizeText(next);
      index += 1;
    } else if (token === '--fail-on-block') {
      options.failOnBlock = true;
    } else if (token === '--json') {
      options.json = true;
    } else if (token === '--help' || token === '-h') {
      options.help = true;
    }
  }
  return options;
}

function printHelp() {
  const lines = [
    'Usage: node scripts/problem-closure-gate.js [options]',
    '',
    'Options:',
    '  --stage <verify|release>      Gate stage (default: release)',
    '  --spec <spec-id>              Spec id under .sce/specs (required for strict checks)',
    `  --policy <path>               Policy path (default: ${DEFAULT_POLICY_PATH})`,
    '  --verify-report <path>        Verify report path (required for release stage convergence)',
    `  --governance-report <path>    Governance report path (default: ${DEFAULT_GOVERNANCE_REPORT})`,
    '  --project-path <path>         Project path (default: cwd)',
    '  --fail-on-block               Exit with code 2 when blocked',
    '  --json                        Print JSON payload',
    '  -h, --help                    Show help'
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function loadPolicy(raw = {}) {
  const payload = raw && typeof raw === 'object' ? raw : {};
  const verify = payload.verify && typeof payload.verify === 'object' ? payload.verify : {};
  const release = payload.release && typeof payload.release === 'object' ? payload.release : {};
  return {
    schema_version: normalizeText(payload.schema_version) || DEFAULT_POLICY.schema_version,
    enabled: payload.enabled !== false,
    governance_report_path: normalizeText(payload.governance_report_path) || DEFAULT_POLICY.governance_report_path,
    verify: {
      require_problem_contract: verify.require_problem_contract !== false,
      require_domain_validation: verify.require_domain_validation !== false,
      require_domain_coverage: verify.require_domain_coverage !== false
    },
    release: {
      require_problem_contract: release.require_problem_contract !== false,
      require_domain_validation: release.require_domain_validation !== false,
      require_domain_coverage: release.require_domain_coverage !== false,
      require_verify_report: release.require_verify_report !== false,
      require_governance_report: release.require_governance_report === true,
      block_on_high_governance_alerts: release.block_on_high_governance_alerts !== false
    }
  };
}

function evaluateProblemContract(contract = {}) {
  const source = contract && typeof contract === 'object' ? contract : {};
  const checks = {
    issue_statement: normalizeText(source.issue_statement || source.issue || source.problem_statement).length > 0,
    expected_outcome: normalizeText(source.expected_outcome || source.expected || source.success_criteria).length > 0,
    reproduction_steps: normalizeTextList(source.reproduction_steps || source.repro_steps || source.steps).length > 0,
    impact_scope: normalizeText(source.impact_scope || source.scope).length > 0,
    forbidden_workarounds: normalizeTextList(
      source.forbidden_workarounds || source.prohibited_workarounds || source.disallowed_workarounds
    ).length > 0
  };
  const missing = Object.keys(checks).filter((key) => !checks[key]);
  return {
    passed: missing.length === 0,
    checks,
    missing
  };
}

async function readVerifySignals(projectPath, reportPath, fileSystem = fs) {
  const normalized = normalizeText(reportPath);
  if (!normalized) {
    return {
      available: false,
      report_path: null,
      passed: false,
      failed_step_count: 0
    };
  }
  const absolutePath = path.isAbsolute(normalized)
    ? normalized
    : path.join(projectPath, normalized);
  if (!await fileSystem.pathExists(absolutePath)) {
    return {
      available: false,
      report_path: normalized,
      passed: false,
      failed_step_count: 0
    };
  }
  const payload = await fileSystem.readJson(absolutePath).catch(() => null);
  const steps = Array.isArray(payload && payload.steps) ? payload.steps : [];
  const failedStepCount = steps.filter((step) => normalizeText(step && step.status).toLowerCase() === 'failed').length;
  return {
    available: true,
    report_path: path.relative(projectPath, absolutePath).replace(/\\/g, '/'),
    passed: payload && payload.passed === true && failedStepCount === 0,
    failed_step_count: failedStepCount
  };
}

async function readGovernanceSignals(projectPath, reportPath, fileSystem = fs) {
  const normalized = normalizeText(reportPath) || DEFAULT_GOVERNANCE_REPORT;
  const absolutePath = path.isAbsolute(normalized)
    ? normalized
    : path.join(projectPath, normalized);
  if (!await fileSystem.pathExists(absolutePath)) {
    return {
      available: false,
      report_path: normalized,
      high_breach_count: 0,
      medium_breach_count: 0
    };
  }
  const payload = await fileSystem.readJson(absolutePath).catch(() => null);
  const alerts = Array.isArray(payload && payload.alerts) ? payload.alerts : [];
  let high = 0;
  let medium = 0;
  for (const alert of alerts) {
    const status = normalizeText(alert && alert.status).toLowerCase();
    const severity = normalizeText(alert && alert.severity).toLowerCase();
    if (status !== 'breach') {
      continue;
    }
    if (severity === 'high') {
      high += 1;
    } else if (severity === 'medium') {
      medium += 1;
    }
  }
  return {
    available: true,
    report_path: path.relative(projectPath, absolutePath).replace(/\\/g, '/'),
    high_breach_count: high,
    medium_breach_count: medium
  };
}

async function evaluateProblemClosureGate(options = {}, dependencies = {}) {
  const projectPath = options.projectPath || dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const stage = normalizeText(options.stage || 'release').toLowerCase();
  const specId = normalizeText(options.spec || options.specId);
  const policyPath = normalizeText(options.policy || options.policyPath || DEFAULT_POLICY_PATH);
  const policyAbsolutePath = path.isAbsolute(policyPath)
    ? policyPath
    : path.join(projectPath, policyPath);
  const policyPayload = await fileSystem.readJson(policyAbsolutePath).catch(() => ({}));
  const policy = loadPolicy(policyPayload);
  const stagePolicy = stage === 'release' ? policy.release : policy.verify;
  const verifyReport = normalizeText(options.verifyReport || options.verify_report);
  const governanceReport = normalizeText(
    options.governanceReport || options.governance_report || policy.governance_report_path || DEFAULT_GOVERNANCE_REPORT
  );
  if (!['verify', 'release'].includes(stage)) {
    throw new Error(`--stage must be verify|release, received: ${stage || '(empty)'}`);
  }

  const warnings = [];
  const violations = [];
  const checks = {
    spec_available: false,
    problem_contract: {
      available: false,
      passed: false,
      missing: []
    },
    domain_artifacts: {
      passed: false,
      warnings: []
    },
    domain_coverage: {
      passed: false,
      uncovered: []
    },
    convergence: {
      verify_report: {
        available: false,
        passed: false,
        failed_step_count: 0
      },
      governance: {
        available: false,
        high_breach_count: 0,
        medium_breach_count: 0
      }
    }
  };

  if (policy.enabled !== true) {
    warnings.push('problem closure gate disabled by policy');
    return {
      mode: 'problem-closure-gate',
      stage,
      spec_id: specId || null,
      skipped: true,
      passed: true,
      policy,
      warnings,
      violations: [],
      checks
    };
  }

  if (!specId) {
    warnings.push('spec id is not provided; problem closure gate skipped');
    return {
      mode: 'problem-closure-gate',
      stage,
      spec_id: null,
      skipped: true,
      passed: true,
      policy,
      warnings,
      violations: [],
      checks
    };
  }

  const specRoot = path.join(projectPath, '.sce', 'specs', specId);
  const specExists = await fileSystem.pathExists(specRoot);
  checks.spec_available = specExists;
  if (!specExists) {
    violations.push(`spec not found: ${specId}`);
  } else {
    const contractPath = path.join(specRoot, DEFAULT_CONTRACT_RELATIVE_PATH);
    const contractExists = await fileSystem.pathExists(contractPath);
    checks.problem_contract.available = contractExists;
    if (!contractExists && stagePolicy.require_problem_contract) {
      violations.push(`missing required artifact: .sce/specs/${specId}/${DEFAULT_CONTRACT_RELATIVE_PATH.replace(/\\/g, '/')}`);
    } else if (contractExists) {
      const contractPayload = await fileSystem.readJson(contractPath).catch(() => null);
      const contractEval = evaluateProblemContract(contractPayload || {});
      checks.problem_contract.passed = contractEval.passed;
      checks.problem_contract.missing = contractEval.missing;
      if (!contractEval.passed && stagePolicy.require_problem_contract) {
        violations.push(`problem contract incomplete: ${contractEval.missing.join(', ')}`);
      }
    }

    const domainValidation = await validateSpecDomainArtifacts(projectPath, specId, fileSystem);
    checks.domain_artifacts.passed = domainValidation.passed;
    checks.domain_artifacts.warnings = Array.isArray(domainValidation.warnings) ? domainValidation.warnings : [];
    if (!domainValidation.passed && stagePolicy.require_domain_validation) {
      violations.push(`spec-domain validation failed: ${checks.domain_artifacts.warnings.join('; ')}`);
    }

    const domainCoverage = await analyzeSpecDomainCoverage(projectPath, specId, fileSystem);
    checks.domain_coverage.passed = domainCoverage.passed;
    checks.domain_coverage.uncovered = Array.isArray(domainCoverage.uncovered) ? domainCoverage.uncovered : [];
    if (!domainCoverage.passed && stagePolicy.require_domain_coverage) {
      violations.push(`spec-domain coverage gaps: ${checks.domain_coverage.uncovered.join(', ')}`);
    }
  }

  if (stage === 'release') {
    const verifySignals = await readVerifySignals(projectPath, verifyReport, fileSystem);
    checks.convergence.verify_report = verifySignals;
    if (!verifySignals.available && stagePolicy.require_verify_report) {
      violations.push('verify report is required for release convergence gate');
    } else if (verifySignals.available && !verifySignals.passed && stagePolicy.require_verify_report) {
      violations.push('verify report indicates failed checks or failed steps');
    }

    const governanceSignals = await readGovernanceSignals(projectPath, governanceReport, fileSystem);
    checks.convergence.governance = governanceSignals;
    if (!governanceSignals.available && stagePolicy.require_governance_report) {
      violations.push('governance report is required for release convergence gate');
    }
    if (
      governanceSignals.available
      && governanceSignals.high_breach_count > 0
      && stagePolicy.block_on_high_governance_alerts
    ) {
      violations.push(`interactive governance has high-severity breaches: ${governanceSignals.high_breach_count}`);
    }
  }

  return {
    mode: 'problem-closure-gate',
    stage,
    spec_id: specId,
    skipped: false,
    policy,
    passed: violations.length === 0,
    blocked: violations.length > 0,
    warnings,
    violations,
    checks
  };
}

async function runProblemClosureGateScript(options = {}, dependencies = {}) {
  const payload = await evaluateProblemClosureGate(options, dependencies);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (payload.passed) {
    process.stdout.write('[problem-closure-gate] passed\n');
    if (payload.skipped) {
      process.stdout.write('[problem-closure-gate] skipped: no bound spec\n');
    }
  } else {
    process.stdout.write('[problem-closure-gate] blocked\n');
    payload.violations.forEach((item) => {
      process.stdout.write(`[problem-closure-gate] violation=${item}\n`);
    });
  }
  return {
    ...payload,
    exit_code: options.failOnBlock && payload.passed !== true ? 2 : 0
  };
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    process.exit(0);
  }
  runProblemClosureGateScript(options)
    .then((result) => {
      process.exitCode = result.exit_code;
    })
    .catch((error) => {
      if (options.json) {
        process.stdout.write(`${JSON.stringify({
          mode: 'problem-closure-gate',
          passed: false,
          error: error.message
        }, null, 2)}\n`);
      } else {
        process.stderr.write(`[problem-closure-gate] error=${error.message}\n`);
      }
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_POLICY_PATH,
  DEFAULT_POLICY,
  DEFAULT_GOVERNANCE_REPORT,
  parseArgs,
  loadPolicy,
  evaluateProblemContract,
  evaluateProblemClosureGate,
  runProblemClosureGateScript
};
