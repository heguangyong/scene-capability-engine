const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs-extra');
const chalk = require('chalk');
const { SessionStore } = require('../runtime/session-store');
const {
  DOMAIN_CHAIN_RELATIVE_PATH,
  ensureSpecDomainArtifacts
} = require('../spec/domain-modeling');
const { findRelatedSpecs } = require('../spec/related-specs');
const { captureTimelineCheckpoint } = require('../runtime/project-timeline');
const { runProblemEvaluation } = require('../problem/problem-evaluator');
const {
  loadStudioIntakePolicy,
  runStudioAutoIntake,
  runStudioSpecGovernance,
  runStudioSceneBackfill
} = require('../studio/spec-intake-governor');

const STUDIO_JOB_API_VERSION = 'sce.studio.job/v0.1';
const STAGE_ORDER = ['plan', 'generate', 'apply', 'verify', 'release'];
const RELEASE_CHANNELS = new Set(['dev', 'prod']);
const STUDIO_EVENT_API_VERSION = 'sce.studio.event/v0.1';
const VERIFY_PROFILES = new Set(['fast', 'standard', 'strict']);
const RELEASE_PROFILES = new Set(['standard', 'strict']);
const STUDIO_REPORTS_DIR = '.sce/reports/studio';
const DEFAULT_INTERACTIVE_GOVERNANCE_REPORT = '.sce/reports/interactive-governance-report.json';
const DEFAULT_PROBLEM_CONTRACT_RELATIVE_PATH = path.join('custom', 'problem-contract.json');
const MAX_OUTPUT_PREVIEW_LENGTH = 2000;
const DEFAULT_STUDIO_SECURITY_POLICY = Object.freeze({
  enabled: false,
  require_auth_for: ['apply', 'release', 'rollback'],
  password_env: 'SCE_STUDIO_AUTH_PASSWORD'
});

function resolveStudioPaths(projectPath = process.cwd()) {
  const studioDir = path.join(projectPath, '.sce', 'studio');
  return {
    projectPath,
    studioDir,
    jobsDir: path.join(studioDir, 'jobs'),
    latestFile: path.join(studioDir, 'latest-job.json'),
    eventsDir: path.join(studioDir, 'events')
  };
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function createJobId(prefix = 'studio') {
  const random = crypto.randomBytes(4).toString('hex');
  return `${prefix}-${Date.now()}-${random}`;
}

function createStageState() {
  return {
    plan: { status: 'pending', completed_at: null, metadata: {} },
    generate: { status: 'pending', completed_at: null, metadata: {} },
    apply: { status: 'pending', completed_at: null, metadata: {} },
    verify: { status: 'pending', completed_at: null, metadata: {} },
    release: { status: 'pending', completed_at: null, metadata: {} }
  };
}

function clipOutput(value) {
  if (typeof value !== 'string') {
    return '';
  }
  if (value.length <= MAX_OUTPUT_PREVIEW_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_OUTPUT_PREVIEW_LENGTH)}...[truncated]`;
}

function defaultCommandRunner(command, args = [], options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 10,
    windowsHide: true
  });

  return {
    status: Number.isInteger(result.status) ? result.status : 1,
    stdout: `${result.stdout || ''}`,
    stderr: `${result.stderr || ''}`,
    error: result.error ? `${result.error.message || result.error}` : null,
    duration_ms: Date.now() - startedAt
  };
}

function buildCommandString(command, args = []) {
  return [command, ...args].join(' ').trim();
}

function normalizeGateStep(step) {
  return {
    id: normalizeString(step.id),
    name: normalizeString(step.name) || normalizeString(step.id),
    command: normalizeString(step.command),
    args: Array.isArray(step.args) ? step.args.map((item) => `${item}`) : [],
    cwd: normalizeString(step.cwd) || null,
    enabled: step.enabled !== false,
    skip_reason: normalizeString(step.skip_reason),
    required: step.required !== false
  };
}

function createGateFailureFingerprint(failure = {}, context = {}) {
  const basis = JSON.stringify({
    stage: normalizeString(context.stage),
    profile: normalizeString(context.profile),
    job_id: normalizeString(context.job_id),
    step_id: normalizeString(failure.id),
    command: normalizeString(failure.command),
    exit_code: Number.isFinite(Number(failure.exit_code)) ? Number(failure.exit_code) : null,
    skip_reason: normalizeString(failure.skip_reason),
    stderr: normalizeString(failure?.output?.stderr || '').slice(0, 400)
  });
  const digest = crypto.createHash('sha1').update(basis).digest('hex').slice(0, 16);
  return `studio-gate-${digest}`;
}

async function autoRecordGateFailure(failure = {}, context = {}, dependencies = {}) {
  if (dependencies.autoRecordFailures === false) {
    return null;
  }

  try {
    const { runErrorbookRecordCommand } = require('./errorbook');
    const stage = normalizeString(context.stage) || 'verify';
    const profile = normalizeString(context.profile) || 'standard';
    const jobId = normalizeString(context.job_id);
    const stepId = normalizeString(failure.id) || normalizeString(failure.name) || 'unknown-step';
    const commandText = normalizeString(failure.command) || 'n/a';
    const skipReason = normalizeString(failure.skip_reason);
    const stderr = normalizeString(failure?.output?.stderr || '');
    const errorText = normalizeString(failure?.output?.error || '');
    const symptom = skipReason
      ? `Required studio ${stage} gate step "${stepId}" is unavailable: ${skipReason}.`
      : `Required studio ${stage} gate step "${stepId}" failed (exit=${failure.exit_code ?? 'n/a'}).`;
    const rootCause = skipReason
      ? `Gate dependency missing or disabled for studio ${stage} profile ${profile}; remediation required before release.`
      : `Gate command execution failure in studio ${stage} profile ${profile}; root cause analysis pending.`;
    const fixActions = [
      `Inspect failed gate step ${stepId} in studio ${stage} stage.`,
      `Rerun gate command: ${commandText}`
    ];
    if (stderr) {
      fixActions.push(`Analyze stderr signal: ${stderr.slice(0, 200)}`);
    } else if (errorText) {
      fixActions.push(`Analyze runtime error signal: ${errorText.slice(0, 200)}`);
    }

    const title = `[studio:${stage}] gate failure: ${stepId}`;
    const tags = ['studio', 'gate-failure', 'release-blocker', `stage-${stage}`];
    const fingerprint = createGateFailureFingerprint(failure, context);
    const specRef = normalizeString(context.spec_id) || normalizeString(context.scene_id) || jobId;

    const result = await runErrorbookRecordCommand({
      title,
      symptom,
      rootCause,
      fixAction: fixActions,
      tags: tags.join(','),
      ontology: 'execution_flow,decision_policy',
      status: 'candidate',
      fingerprint,
      spec: specRef,
      notes: `auto-captured from studio ${stage} gate`
    }, {
      projectPath: dependencies.projectPath || process.cwd(),
      fileSystem: dependencies.fileSystem || fs
    });

    return {
      errorbook_entry_id: result && result.entry ? result.entry.id : null,
      fingerprint
    };
  } catch (_error) {
    return null;
  }
}

async function executeGateSteps(steps, dependencies = {}) {
  const runner = dependencies.commandRunner || defaultCommandRunner;
  const projectPath = dependencies.projectPath || process.cwd();
  const env = dependencies.env || process.env;
  const failOnRequiredSkip = dependencies.failOnRequiredSkip === true;
  const onFailure = typeof dependencies.onFailure === 'function'
    ? dependencies.onFailure
    : null;

  const normalizedSteps = Array.isArray(steps) ? steps.map((step) => normalizeGateStep(step)) : [];
  const results = [];
  let hasFailure = false;

  for (const step of normalizedSteps) {
    if (!step.enabled) {
      const skippedAsFailure = failOnRequiredSkip && step.required;
      if (skippedAsFailure) {
        hasFailure = true;
      }
      results.push({
        id: step.id,
        name: step.name,
        status: skippedAsFailure ? 'failed' : 'skipped',
        required: step.required,
        command: buildCommandString(step.command, step.args),
        skip_reason: step.skip_reason || 'disabled',
        output: skippedAsFailure
          ? { stdout: '', stderr: '', error: 'required gate step disabled under strict profile' }
          : undefined
      });
      if (skippedAsFailure && onFailure) {
        const failure = results[results.length - 1];
        await Promise.resolve(onFailure({
          reason: 'required_skip',
          step,
          failure
        })).catch(() => {});
      }
      continue;
    }

    const startedAt = nowIso();
    const raw = await Promise.resolve(runner(step.command, step.args, {
      cwd: step.cwd || projectPath,
      env
    }));
    const statusCode = Number.isInteger(raw && raw.status) ? raw.status : 1;
    const passed = statusCode === 0;
    const endedAt = nowIso();
    const output = {
      stdout: clipOutput(raw && raw.stdout ? `${raw.stdout}` : ''),
      stderr: clipOutput(raw && raw.stderr ? `${raw.stderr}` : ''),
      error: raw && raw.error ? `${raw.error}` : null
    };
    const durationMs = Number.isFinite(Number(raw && raw.duration_ms))
      ? Number(raw.duration_ms)
      : null;

    results.push({
      id: step.id,
      name: step.name,
      status: passed ? 'passed' : 'failed',
      required: step.required,
      command: buildCommandString(step.command, step.args),
      exit_code: statusCode,
      started_at: startedAt,
      completed_at: endedAt,
      duration_ms: durationMs,
      output
    });

    if (!passed && step.required) {
      hasFailure = true;
      if (onFailure) {
        const failure = results[results.length - 1];
        await Promise.resolve(onFailure({
          reason: 'command_failed',
          step,
          failure
        })).catch(() => {});
      }
    }
  }

  return {
    passed: !hasFailure,
    steps: results
  };
}

async function readPackageJson(projectPath, fileSystem = fs) {
  const packageJsonPath = path.join(projectPath, 'package.json');
  const exists = await fileSystem.pathExists(packageJsonPath);
  if (!exists) {
    return null;
  }

  try {
    return await fileSystem.readJson(packageJsonPath);
  } catch (_error) {
    return null;
  }
}

function normalizeSecurityPolicy(policy) {
  const normalized = {
    enabled: policy && policy.enabled === true,
    require_auth_for: Array.isArray(policy && policy.require_auth_for)
      ? policy.require_auth_for
        .map((item) => normalizeString(item))
        .filter(Boolean)
      : [...DEFAULT_STUDIO_SECURITY_POLICY.require_auth_for],
    password_env: normalizeString(policy && policy.password_env) || DEFAULT_STUDIO_SECURITY_POLICY.password_env
  };
  return normalized;
}

async function loadStudioSecurityPolicy(projectPath, fileSystem = fs, env = process.env) {
  const policyPath = path.join(projectPath, '.sce', 'config', 'studio-security.json');
  let filePolicy = {};

  if (await fileSystem.pathExists(policyPath)) {
    try {
      filePolicy = await fileSystem.readJson(policyPath);
    } catch (error) {
      throw new Error(`Failed to read studio security policy: ${error.message}`);
    }
  }

  const envEnabled = `${env.SCE_STUDIO_REQUIRE_AUTH || ''}`.trim() === '1';
  const envPasswordVar = normalizeString(env.SCE_STUDIO_PASSWORD_ENV);

  return normalizeSecurityPolicy({
    ...DEFAULT_STUDIO_SECURITY_POLICY,
    ...filePolicy,
    enabled: envEnabled || filePolicy.enabled === true,
    password_env: envPasswordVar || filePolicy.password_env || DEFAULT_STUDIO_SECURITY_POLICY.password_env
  });
}

async function ensureStudioAuthorization(action, options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const env = dependencies.env || process.env;
  const policy = await loadStudioSecurityPolicy(projectPath, fileSystem, env);
  const requiredActions = new Set(policy.require_auth_for);
  const requiresAuth = options.requireAuth === true || (policy.enabled && requiredActions.has(action));

  if (!requiresAuth) {
    return {
      required: false,
      passed: true,
      policy
    };
  }

  const passwordEnv = normalizeString(policy.password_env) || DEFAULT_STUDIO_SECURITY_POLICY.password_env;
  const expectedPassword = normalizeString(dependencies.authSecret || env[passwordEnv]);
  if (!expectedPassword) {
    throw new Error(`Authorization required for studio ${action}, but ${passwordEnv} is not configured`);
  }

  const providedPassword = normalizeString(options.authPassword);
  if (!providedPassword) {
    throw new Error(`Authorization required for studio ${action}. Provide --auth-password`);
  }

  if (providedPassword !== expectedPassword) {
    throw new Error(`Authorization failed for studio ${action}: invalid password`);
  }

  return {
    required: true,
    passed: true,
    policy,
    password_env: passwordEnv
  };
}

async function buildVerifyGateSteps(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const profile = normalizeString(options.profile) || 'standard';
  const specId = normalizeString(options.specId || dependencies.specId);

  if (!VERIFY_PROFILES.has(profile)) {
    throw new Error(`Invalid verify profile "${profile}". Expected one of: ${Array.from(VERIFY_PROFILES).join(', ')}`);
  }

  const packageJson = await readPackageJson(projectPath, fileSystem);
  const scripts = packageJson && packageJson.scripts ? packageJson.scripts : {};
  const hasUnit = typeof scripts['test:unit'] === 'string';
  const hasTest = typeof scripts.test === 'string';

  const steps = [];
  if (hasUnit || hasTest) {
    const npmCommand = hasUnit
      ? { args: ['run', 'test:unit', '--', '--runInBand'], name: 'npm run test:unit -- --runInBand', id: 'unit-tests' }
      : { args: ['test', '--', '--runInBand'], name: 'npm test -- --runInBand', id: 'tests' };
    steps.push({
      id: npmCommand.id,
      name: npmCommand.name,
      command: 'npm',
      args: npmCommand.args,
      required: true
    });
  } else {
    steps.push({
      id: 'tests',
      name: 'No npm test script',
      command: 'npm',
      args: ['test', '--', '--runInBand'],
      enabled: false,
      required: profile === 'strict',
      skip_reason: 'package.json test script not found'
    });
  }

  if (profile === 'standard' || profile === 'strict') {
    const problemClosureGateScript = path.join(projectPath, 'scripts', 'problem-closure-gate.js');
    const hasProblemClosureGateScript = await fileSystem.pathExists(problemClosureGateScript);
    const canRunProblemClosureGate = hasProblemClosureGateScript && Boolean(specId);
    steps.push({
      id: 'problem-closure-gate',
      name: 'problem closure gate (verify)',
      command: 'node',
      args: ['scripts/problem-closure-gate.js', '--stage', 'verify', '--spec', specId, '--fail-on-block', '--json'],
      required: Boolean(specId),
      enabled: canRunProblemClosureGate,
      skip_reason: canRunProblemClosureGate
        ? ''
        : (specId ? 'scripts/problem-closure-gate.js not found' : 'spec id unavailable for problem-closure gate')
    });

    const governanceScript = path.join(projectPath, 'scripts', 'interactive-governance-report.js');
    const hasGovernanceScript = await fileSystem.pathExists(governanceScript);
    steps.push({
      id: 'interactive-governance-report',
      name: 'interactive-governance-report',
      command: 'node',
      args: ['scripts/interactive-governance-report.js', '--period', 'weekly', '--json'],
      required: true,
      enabled: hasGovernanceScript,
      skip_reason: hasGovernanceScript ? '' : 'scripts/interactive-governance-report.js not found'
    });

    const handoffManifest = path.join(projectPath, 'docs', 'handoffs', 'handoff-manifest.json');
    const hasHandoffManifest = await fileSystem.pathExists(handoffManifest);
    steps.push({
      id: 'scene-package-publish-batch-dry-run',
      name: 'scene package publish-batch dry-run',
      command: 'node',
      args: ['bin/sce.js', 'scene', 'package-publish-batch', '--manifest', 'docs/handoffs/handoff-manifest.json', '--dry-run', '--json'],
      required: true,
      enabled: hasHandoffManifest,
      skip_reason: hasHandoffManifest ? '' : 'docs/handoffs/handoff-manifest.json not found'
    });
  }

  return steps;
}

async function buildReleaseGateSteps(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const profile = normalizeString(options.profile) || 'standard';
  const specId = normalizeString(options.specId || dependencies.specId);
  const verifyReportPath = normalizeString(options.verifyReportPath || dependencies.verifyReportPath);
  if (!RELEASE_PROFILES.has(profile)) {
    throw new Error(`Invalid release profile "${profile}". Expected one of: ${Array.from(RELEASE_PROFILES).join(', ')}`);
  }

  const steps = [];
  const problemClosureGateScript = path.join(projectPath, 'scripts', 'problem-closure-gate.js');
  const hasProblemClosureGateScript = await fileSystem.pathExists(problemClosureGateScript);
  const canRunProblemClosureGate = hasProblemClosureGateScript && Boolean(specId);
  const problemClosureArgs = ['scripts/problem-closure-gate.js', '--stage', 'release', '--spec', specId, '--fail-on-block', '--json'];
  if (verifyReportPath) {
    problemClosureArgs.push('--verify-report', verifyReportPath);
  }
  steps.push({
    id: 'problem-closure-gate',
    name: 'problem closure gate (release)',
    command: 'node',
    args: problemClosureArgs,
    required: Boolean(specId),
    enabled: canRunProblemClosureGate,
    skip_reason: canRunProblemClosureGate
      ? ''
      : (specId ? 'scripts/problem-closure-gate.js not found' : 'spec id unavailable for problem-closure gate')
  });

  steps.push({
    id: 'npm-pack-dry-run',
    name: 'npm pack --dry-run',
    command: 'npm',
    args: ['pack', '--dry-run'],
    required: true
  });

  const gitManagedGateScript = path.join(projectPath, 'scripts', 'git-managed-gate.js');
  const hasGitManagedGateScript = await fileSystem.pathExists(gitManagedGateScript);
  steps.push({
    id: 'git-managed-gate',
    name: 'git managed release gate',
    command: 'node',
    args: ['scripts/git-managed-gate.js', '--fail-on-violation', '--json'],
    required: true,
    enabled: hasGitManagedGateScript,
    skip_reason: hasGitManagedGateScript ? '' : 'scripts/git-managed-gate.js not found'
  });

  const errorbookReleaseGateScript = path.join(projectPath, 'scripts', 'errorbook-release-gate.js');
  const hasErrorbookReleaseGateScript = await fileSystem.pathExists(errorbookReleaseGateScript);
  steps.push({
    id: 'errorbook-release-gate',
    name: 'errorbook release gate',
    command: 'node',
    args: ['scripts/errorbook-release-gate.js', '--fail-on-block', '--json'],
    required: true,
    enabled: hasErrorbookReleaseGateScript,
    skip_reason: hasErrorbookReleaseGateScript ? '' : 'scripts/errorbook-release-gate.js not found'
  });

  const weeklySummaryPath = path.join(projectPath, '.sce', 'reports', 'release-evidence', 'release-ops-weekly-summary.json');
  const hasWeeklySummary = await fileSystem.pathExists(weeklySummaryPath);
  steps.push({
    id: 'release-weekly-ops-gate',
    name: 'release weekly ops gate',
    command: 'node',
    args: ['scripts/release-weekly-ops-gate.js'],
    required: true,
    enabled: hasWeeklySummary,
    skip_reason: hasWeeklySummary ? '' : '.sce/reports/release-evidence/release-ops-weekly-summary.json not found'
  });

  const releaseEvidenceDir = path.join(projectPath, '.sce', 'reports', 'release-evidence');
  const hasReleaseEvidenceDir = await fileSystem.pathExists(releaseEvidenceDir);
  steps.push({
    id: 'release-asset-integrity',
    name: 'release asset integrity',
    command: 'node',
    args: ['scripts/release-asset-integrity-check.js'],
    required: true,
    enabled: hasReleaseEvidenceDir,
    skip_reason: hasReleaseEvidenceDir ? '' : '.sce/reports/release-evidence directory not found'
  });

  const handoffManifest = path.join(projectPath, 'docs', 'handoffs', 'handoff-manifest.json');
  const hasHandoffManifest = await fileSystem.pathExists(handoffManifest);
  steps.push({
    id: 'scene-package-publish-batch-dry-run',
    name: 'scene package publish-batch dry-run (ontology gate)',
    command: 'node',
    args: [
      'bin/sce.js',
      'scene',
      'package-publish-batch',
      '--manifest',
      'docs/handoffs/handoff-manifest.json',
      '--dry-run',
      '--ontology-min-average-score',
      '70',
      '--ontology-min-valid-rate',
      '100',
      '--json'
    ],
    required: true,
    enabled: hasHandoffManifest,
    skip_reason: hasHandoffManifest ? '' : 'docs/handoffs/handoff-manifest.json not found'
  });

  steps.push({
    id: 'handoff-capability-matrix-gate',
    name: 'handoff capability matrix gate',
    command: 'node',
    args: [
      'bin/sce.js',
      'auto',
      'handoff',
      'capability-matrix',
      '--manifest',
      'docs/handoffs/handoff-manifest.json',
      '--profile',
      'moqui',
      '--fail-on-gap',
      '--json'
    ],
    required: true,
    enabled: hasHandoffManifest,
    skip_reason: hasHandoffManifest ? '' : 'docs/handoffs/handoff-manifest.json not found'
  });

  return steps;
}

async function writeStudioReport(projectPath, relativePath, payload, fileSystem = fs) {
  const absolutePath = path.join(projectPath, relativePath);
  await fileSystem.ensureDir(path.dirname(absolutePath));
  await fileSystem.writeJson(absolutePath, payload, { spaces: 2 });
}

async function ensureStudioDirectories(paths, fileSystem = fs) {
  await fileSystem.ensureDir(paths.jobsDir);
  await fileSystem.ensureDir(paths.eventsDir);
}

async function writeLatestJob(paths, jobId, fileSystem = fs) {
  await fileSystem.writeJson(paths.latestFile, {
    job_id: jobId,
    updated_at: nowIso()
  }, { spaces: 2 });
}

async function readLatestJob(paths, fileSystem = fs) {
  const exists = await fileSystem.pathExists(paths.latestFile);
  if (!exists) {
    return null;
  }

  const payload = await fileSystem.readJson(paths.latestFile);
  const jobId = normalizeString(payload.job_id);
  return jobId || null;
}

function getJobFilePath(paths, jobId) {
  return path.join(paths.jobsDir, `${jobId}.json`);
}

function getEventLogFilePath(paths, jobId) {
  return path.join(paths.eventsDir, `${jobId}.jsonl`);
}

async function saveJob(paths, job, fileSystem = fs) {
  const jobFile = getJobFilePath(paths, job.job_id);
  await fileSystem.writeJson(jobFile, job, { spaces: 2 });
}

async function appendStudioEvent(paths, job, eventType, metadata = {}, fileSystem = fs) {
  const event = {
    api_version: STUDIO_EVENT_API_VERSION,
    event_id: `evt-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
    job_id: job.job_id,
    event_type: eventType,
    timestamp: nowIso(),
    metadata
  };
  const eventLine = `${JSON.stringify(event)}\n`;
  const eventFile = getEventLogFilePath(paths, job.job_id);
  await fileSystem.appendFile(eventFile, eventLine, 'utf8');
}

async function readStudioEvents(paths, jobId, options = {}, fileSystem = fs) {
  const { limit = 50 } = options;
  const eventFile = getEventLogFilePath(paths, jobId);
  const exists = await fileSystem.pathExists(eventFile);
  if (!exists) {
    return [];
  }

  const content = await fileSystem.readFile(eventFile, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed = [];
  for (const line of lines) {
    try {
      const payload = JSON.parse(line);
      parsed.push(payload);
    } catch (_error) {
      // Ignore malformed lines to keep event stream robust.
    }
  }

  if (limit <= 0) {
    return parsed;
  }
  return parsed.slice(-limit);
}

async function loadJob(paths, jobId, fileSystem = fs) {
  const jobFile = getJobFilePath(paths, jobId);
  const exists = await fileSystem.pathExists(jobFile);
  if (!exists) {
    throw new Error(`Studio job not found: ${jobId}`);
  }
  return fileSystem.readJson(jobFile);
}

function resolveRequestedJobId(options, latestJobId) {
  const requested = normalizeString(options.job);
  if (requested) {
    return requested;
  }
  return latestJobId;
}

function buildProgress(job) {
  const completed = STAGE_ORDER.filter((stageName) => {
    const stage = job.stages && job.stages[stageName];
    return stage && stage.status === 'completed';
  }).length;

  return {
    completed,
    total: STAGE_ORDER.length,
    percent: Number(((completed / STAGE_ORDER.length) * 100).toFixed(2))
  };
}

function resolveNextAction(job) {
  const sceneRef = normalizeString(job && job.scene && job.scene.id);
  const planSceneArg = sceneRef || '<scene-id>';
  if (job.status === 'rolled_back') {
    return `sce studio plan --scene ${planSceneArg} --from-chat <session>`;
  }
  if (!job.stages.plan || job.stages.plan.status !== 'completed') {
    return `sce studio plan --scene ${planSceneArg} --from-chat <session> --job ${job.job_id}`;
  }
  if (!job.stages.generate || job.stages.generate.status !== 'completed') {
    return `sce studio generate --job ${job.job_id}`;
  }
  if (!job.stages.apply || job.stages.apply.status !== 'completed') {
    const patchBundleId = job.artifacts.patch_bundle_id || '<patch-bundle-id>';
    return `sce studio apply --patch-bundle ${patchBundleId} --job ${job.job_id}`;
  }
  if (!job.stages.verify || job.stages.verify.status !== 'completed') {
    return `sce studio verify --profile standard --job ${job.job_id}`;
  }
  if (!job.stages.release || job.stages.release.status !== 'completed') {
    return `sce studio release --channel dev --job ${job.job_id}`;
  }
  return 'complete';
}

function toRelativePosix(projectPath, absolutePath) {
  return path.relative(projectPath, absolutePath).replace(/\\/g, '/');
}

async function readSpecDomainChain(projectPath, specId, fileSystem = fs) {
  const specRoot = path.join(projectPath, '.sce', 'specs', specId);
  const chainPath = path.join(specRoot, DOMAIN_CHAIN_RELATIVE_PATH);
  if (!await fileSystem.pathExists(chainPath)) {
    return null;
  }
  try {
    const payload = await fileSystem.readJson(chainPath);
    const stat = await fileSystem.stat(chainPath);
    return {
      spec_id: specId,
      chain_path: toRelativePosix(projectPath, chainPath),
      payload,
      updated_at: stat && stat.mtime ? stat.mtime.toISOString() : null,
      mtime_ms: Number(stat && stat.mtimeMs) || 0
    };
  } catch (_error) {
    return null;
  }
}

async function readSpecProblemContract(projectPath, specId, fileSystem = fs) {
  const specRoot = path.join(projectPath, '.sce', 'specs', specId);
  const contractPath = path.join(specRoot, DEFAULT_PROBLEM_CONTRACT_RELATIVE_PATH);
  if (!await fileSystem.pathExists(contractPath)) {
    return null;
  }
  try {
    const payload = await fileSystem.readJson(contractPath);
    const stat = await fileSystem.stat(contractPath);
    return {
      spec_id: specId,
      contract_path: toRelativePosix(projectPath, contractPath),
      payload,
      updated_at: stat && stat.mtime ? stat.mtime.toISOString() : null,
      mtime_ms: Number(stat && stat.mtimeMs) || 0
    };
  } catch (_error) {
    return null;
  }
}

async function readGovernanceSignals(projectPath, fileSystem = fs) {
  const reportPath = path.join(projectPath, DEFAULT_INTERACTIVE_GOVERNANCE_REPORT);
  if (!await fileSystem.pathExists(reportPath)) {
    return {
      available: false,
      report_path: null,
      high_breach_count: 0,
      medium_breach_count: 0
    };
  }
  const payload = await fileSystem.readJson(reportPath).catch(() => null);
  const summary = extractGovernanceBreachSignals(payload || {});
  return {
    ...summary,
    report_path: toRelativePosix(projectPath, reportPath)
  };
}

async function readVerifyReportSignals(projectPath, verifyReportPath = '', fileSystem = fs) {
  const normalized = normalizeString(verifyReportPath);
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
  const failedStepCount = steps.filter((step) => normalizeString(step && step.status) === 'failed').length;
  return {
    available: true,
    report_path: toRelativePosix(projectPath, absolutePath),
    passed: payload && payload.passed === true && failedStepCount === 0,
    failed_step_count: failedStepCount
  };
}

function normalizeChainList(value, limit = 5) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => item && (typeof item === 'string' || typeof item === 'object'))
    .slice(0, limit)
    .map((item) => {
      if (typeof item === 'string') {
        return normalizeString(item);
      }
      return item;
    });
}

function normalizeProblemContract(contract = {}, context = {}) {
  const source = contract && typeof contract === 'object' ? contract : {};
  const issueStatement = normalizeString(
    source.issue_statement
    || source.issue
    || source.problem_statement
    || context.problem_statement
    || context.goal
  );
  const expectedOutcome = normalizeString(
    source.expected_outcome
    || source.expected
    || source.success_criteria
    || context.verification_plan
    || (context.scene_id ? `Scene ${context.scene_id} reaches deterministic verification gates.` : '')
  );
  const reproductionSteps = normalizeChainList(
    source.reproduction_steps || source.repro_steps || source.steps,
    20
  );
  const fallbackRepro = reproductionSteps.length > 0
    ? reproductionSteps
    : [
      normalizeString(context.goal) || 'Reproduce the reported issue in the target scene.',
      'Capture logs and gate evidence for the failing path.'
    ].filter(Boolean);
  const forbiddenWorkarounds = normalizeChainList(
    source.forbidden_workarounds || source.prohibited_workarounds || source.disallowed_workarounds,
    20
  );
  const fallbackForbidden = forbiddenWorkarounds.length > 0
    ? forbiddenWorkarounds
    : [
      'Do not bypass gates or tests.',
      'Do not silence runtime errors.'
    ];

  return {
    issue_statement: issueStatement,
    expected_outcome: expectedOutcome,
    reproduction_steps: fallbackRepro,
    impact_scope: normalizeString(source.impact_scope || source.scope || context.scene_id),
    forbidden_workarounds: fallbackForbidden
  };
}

function extractGovernanceBreachSignals(report = {}) {
  if (!report || typeof report !== 'object') {
    return {
      available: false,
      high_breach_count: 0,
      medium_breach_count: 0
    };
  }
  const alerts = Array.isArray(report.alerts) ? report.alerts : [];
  let highBreachCount = 0;
  let mediumBreachCount = 0;
  for (const alert of alerts) {
    const status = normalizeString(alert && alert.status).toLowerCase();
    const severity = normalizeString(alert && alert.severity).toLowerCase();
    if (status !== 'breach') {
      continue;
    }
    if (severity === 'high') {
      highBreachCount += 1;
    } else if (severity === 'medium') {
      mediumBreachCount += 1;
    }
  }
  return {
    available: true,
    high_breach_count: highBreachCount,
    medium_breach_count: mediumBreachCount
  };
}

function summarizeDomainChain(payload = {}) {
  const ontology = payload && typeof payload.ontology === 'object' ? payload.ontology : {};
  const ontologyEvidence = payload && typeof payload.ontology_evidence === 'object' ? payload.ontology_evidence : {};
  const decisionPath = Array.isArray(payload.decision_execution_path) ? payload.decision_execution_path : [];
  const correctionLoop = payload && typeof payload.correction_loop === 'object' ? payload.correction_loop : {};
  const verification = payload && typeof payload.verification === 'object' ? payload.verification : {};
  const hypotheses = Array.isArray(payload.hypotheses) ? payload.hypotheses : [];
  const risks = Array.isArray(payload.risks) ? payload.risks : [];
  const evidenceBindingCount = (
    normalizeChainList(ontologyEvidence.entity, 50).length
    + normalizeChainList(ontologyEvidence.relation, 50).length
    + normalizeChainList(ontologyEvidence.business_rule, 50).length
    + normalizeChainList(ontologyEvidence.decision_policy, 50).length
    + normalizeChainList(ontologyEvidence.execution_flow, 50).length
  );

  return {
    scene_id: normalizeString(payload.scene_id) || null,
    spec_id: normalizeString(payload.spec_id) || null,
    problem_statement: normalizeString(payload?.problem?.statement) || null,
    ontology_counts: {
      entity: Array.isArray(ontology.entity) ? ontology.entity.length : 0,
      relation: Array.isArray(ontology.relation) ? ontology.relation.length : 0,
      business_rule: Array.isArray(ontology.business_rule) ? ontology.business_rule.length : 0,
      decision_policy: Array.isArray(ontology.decision_policy) ? ontology.decision_policy.length : 0,
      execution_flow: Array.isArray(ontology.execution_flow) ? ontology.execution_flow.length : 0
    },
    hypothesis_count: hypotheses.length,
    risk_count: risks.length,
    decision_path_steps: decisionPath.length,
    evidence_binding_count: evidenceBindingCount,
    verification_plan: normalizeString(verification.plan) || null,
    correction_loop: {
      triggers: normalizeChainList(correctionLoop.triggers, 5),
      actions: normalizeChainList(correctionLoop.actions, 5)
    },
    verification_gates: normalizeChainList(verification.gates, 6)
  };
}

function buildDomainChainRuntimeContext(payload = {}) {
  return {
    scene_id: normalizeString(payload.scene_id) || null,
    spec_id: normalizeString(payload.spec_id) || null,
    problem: {
      statement: normalizeString(payload?.problem?.statement) || null,
      scope: normalizeString(payload?.problem?.scope) || null,
      symptom: normalizeString(payload?.problem?.symptom) || null
    },
    ontology: {
      entity: normalizeChainList(payload?.ontology?.entity, 20),
      relation: normalizeChainList(payload?.ontology?.relation, 20),
      business_rule: normalizeChainList(payload?.ontology?.business_rule, 20),
      decision_policy: normalizeChainList(payload?.ontology?.decision_policy, 20),
      execution_flow: normalizeChainList(payload?.ontology?.execution_flow, 20)
    },
    hypotheses: normalizeChainList(payload.hypotheses, 10),
    risks: normalizeChainList(payload.risks, 10),
    decision_execution_path: normalizeChainList(payload.decision_execution_path, 12),
    correction_loop: {
      triggers: normalizeChainList(payload?.correction_loop?.triggers, 10),
      actions: normalizeChainList(payload?.correction_loop?.actions, 10)
    },
    verification: {
      plan: normalizeString(payload?.verification?.plan) || null,
      gates: normalizeChainList(payload?.verification?.gates, 10)
    },
    problem_contract: normalizeProblemContract(payload?.problem_contract || {}, {
      scene_id: normalizeString(payload.scene_id) || '',
      goal: normalizeString(payload?.problem?.statement) || '',
      problem_statement: normalizeString(payload?.problem?.statement) || '',
      verification_plan: normalizeString(payload?.verification?.plan) || ''
    })
  };
}

async function resolveSceneDomainChainCandidates(projectPath, sceneId, fileSystem = fs) {
  const specsRoot = path.join(projectPath, '.sce', 'specs');
  if (!await fileSystem.pathExists(specsRoot)) {
    return [];
  }
  const entries = await fileSystem.readdir(specsRoot);
  const candidates = [];
  for (const entry of entries) {
    const specRoot = path.join(specsRoot, entry);
    let stat = null;
    try {
      stat = await fileSystem.stat(specRoot);
    } catch (_error) {
      continue;
    }
    if (!stat || !stat.isDirectory()) {
      continue;
    }
    const chain = await readSpecDomainChain(projectPath, entry, fileSystem);
    if (!chain) {
      continue;
    }
    if (normalizeString(chain?.payload?.scene_id) !== sceneId) {
      continue;
    }
    candidates.push(chain);
  }
  candidates.sort((left, right) => (right.mtime_ms || 0) - (left.mtime_ms || 0));
  return candidates;
}

async function resolveDomainChainBinding(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const sceneId = normalizeString(options.sceneId);
  const explicitSpec = normalizeString(options.specId);
  const goal = normalizeString(options.goal);

  if (explicitSpec) {
    const specRoot = path.join(projectPath, '.sce', 'specs', explicitSpec);
    if (!await fileSystem.pathExists(specRoot)) {
      throw new Error(`--spec not found under .sce/specs: ${explicitSpec}`);
    }
    await ensureSpecDomainArtifacts(projectPath, explicitSpec, {
      fileSystem,
      sceneId,
      problemStatement: goal || `Studio scene cycle for ${sceneId}`
    });
    const chain = await readSpecDomainChain(projectPath, explicitSpec, fileSystem);
    const problemContract = await readSpecProblemContract(projectPath, explicitSpec, fileSystem);
    if (!chain) {
      return {
        resolved: false,
        source: 'explicit-spec',
        spec_id: explicitSpec,
        reason: 'domain_chain_missing',
        problem_contract: problemContract
          ? normalizeProblemContract(problemContract.payload, {
            scene_id: sceneId,
            goal
          })
          : normalizeProblemContract({}, {
            scene_id: sceneId,
            goal
          })
      };
    }
    return {
      resolved: true,
      source: 'explicit-spec',
      spec_id: explicitSpec,
      chain_path: chain.chain_path,
      updated_at: chain.updated_at,
      summary: summarizeDomainChain(chain.payload),
      context: buildDomainChainRuntimeContext(chain.payload),
      problem_contract: normalizeProblemContract(
        problemContract && problemContract.payload ? problemContract.payload : chain.payload?.problem_contract || {},
        {
          scene_id: sceneId,
          goal,
          problem_statement: normalizeString(chain?.payload?.problem?.statement),
          verification_plan: normalizeString(chain?.payload?.verification?.plan)
        }
      ),
      problem_contract_path: problemContract ? problemContract.contract_path : null
    };
  }

  if (!sceneId) {
    return {
      resolved: false,
      source: 'none',
      spec_id: null,
      reason: 'scene_id_missing'
    };
  }

  const candidates = await resolveSceneDomainChainCandidates(projectPath, sceneId, fileSystem);
  if (candidates.length === 0) {
    return {
      resolved: false,
      source: 'none',
      spec_id: null,
      reason: 'no_scene_bound_domain_chain'
    };
  }

  const selected = candidates[0];
  const selectedContract = await readSpecProblemContract(projectPath, selected.spec_id, fileSystem);
  return {
    resolved: true,
    source: candidates.length === 1 ? 'scene-auto-single' : 'scene-auto-latest',
    spec_id: selected.spec_id,
    chain_path: selected.chain_path,
    updated_at: selected.updated_at,
    candidate_count: candidates.length,
    candidates: candidates.slice(0, 5).map((item) => ({
      spec_id: item.spec_id,
      chain_path: item.chain_path,
      updated_at: item.updated_at
    })),
    summary: summarizeDomainChain(selected.payload),
    context: buildDomainChainRuntimeContext(selected.payload),
    problem_contract: normalizeProblemContract(
      selectedContract && selectedContract.payload ? selectedContract.payload : selected.payload?.problem_contract || {},
      {
        scene_id: sceneId,
        goal,
        problem_statement: normalizeString(selected?.payload?.problem?.statement),
        verification_plan: normalizeString(selected?.payload?.verification?.plan)
      }
    ),
    problem_contract_path: selectedContract ? selectedContract.contract_path : null
  };
}

function printStudioPayload(payload, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(chalk.blue(`Studio job: ${payload.job_id}`));
  console.log(`  Status: ${payload.status}`);
  console.log(`  Progress: ${payload.progress.completed}/${payload.progress.total} (${payload.progress.percent}%)`);
  console.log(`  Next: ${payload.next_action}`);
}

function ensureStageCompleted(job, stageName, metadata = {}) {
  if (!job.stages || !job.stages[stageName]) {
    job.stages = job.stages || createStageState();
    job.stages[stageName] = { status: 'pending', completed_at: null, metadata: {} };
  }

  job.stages[stageName] = {
    status: 'completed',
    completed_at: nowIso(),
    metadata
  };
}

function isStageCompleted(job, stageName) {
  return Boolean(job && job.stages && job.stages[stageName] && job.stages[stageName].status === 'completed');
}

function ensureStagePrerequisite(job, stageName, prerequisiteStage) {
  if (!isStageCompleted(job, prerequisiteStage)) {
    throw new Error(`Cannot run studio ${stageName}: stage "${prerequisiteStage}" is not completed`);
  }
}

function ensureNotRolledBack(job, stageName) {
  if (job.status === 'rolled_back') {
    throw new Error(`Cannot run studio ${stageName}: job ${job.job_id} is rolled back`);
  }
}

function buildCommandPayload(mode, job) {
  return {
    mode,
    success: true,
    job_id: job.job_id,
    status: job.status,
    progress: buildProgress(job),
    next_action: resolveNextAction(job),
    artifacts: { ...job.artifacts }
  };
}

function buildJobDomainChainMetadata(job = {}) {
  const domainChain = job && job.source && job.source.domain_chain
    ? job.source.domain_chain
    : null;
  const summary = domainChain && domainChain.summary ? domainChain.summary : null;
  const context = domainChain && domainChain.context ? domainChain.context : null;
  const problemContract = job?.source?.problem_contract && typeof job.source.problem_contract === 'object'
    ? job.source.problem_contract
    : normalizeProblemContract(context && context.problem_contract ? context.problem_contract : {}, {
      scene_id: normalizeString(job?.scene?.id),
      goal: normalizeString(job?.source?.goal),
      problem_statement: normalizeString(summary && summary.problem_statement),
      verification_plan: normalizeString(summary && summary.verification_plan)
    });
  return {
    resolved: domainChain && domainChain.resolved === true,
    source: domainChain && domainChain.source ? domainChain.source : 'none',
    spec_id: normalizeString(job?.source?.spec_id) || normalizeString(job?.scene?.spec_id) || null,
    chain_path: domainChain && domainChain.chain_path ? domainChain.chain_path : null,
    reason: domainChain && domainChain.reason ? domainChain.reason : null,
    decision_path_steps: summary ? Number(summary.decision_path_steps || 0) : 0,
    risk_count: summary ? Number(summary.risk_count || 0) : 0,
    evidence_binding_count: summary ? Number(summary.evidence_binding_count || 0) : 0,
    correction_triggers: summary && summary.correction_loop
      ? normalizeChainList(summary.correction_loop.triggers, 10)
      : [],
    verification_gates: summary
      ? normalizeChainList(summary.verification_gates, 10)
      : [],
    problem_contract: problemContract,
    summary: summary || null,
    context: context || null
  };
}

function summarizeProblemEvaluation(evaluation = {}) {
  return {
    passed: evaluation.passed === true,
    blocked: evaluation.blocked === true,
    confidence_score: Number(evaluation.confidence_score || 0),
    risk_level: normalizeString(evaluation?.dimensions?.risk?.level) || 'low',
    strategy: normalizeString(evaluation?.dimensions?.strategy?.strategy) || 'direct-execution',
    contract_score: Number(evaluation?.dimensions?.problem_contract?.score || 0),
    ontology_score: Number(evaluation?.dimensions?.ontology_alignment?.score || 0),
    convergence_score: Number(evaluation?.dimensions?.convergence?.score || 0),
    contract_missing: Array.isArray(evaluation?.dimensions?.problem_contract?.missing)
      ? evaluation.dimensions.problem_contract.missing
      : [],
    ontology_missing_axes: Array.isArray(evaluation?.dimensions?.ontology_alignment?.missing_axes)
      ? evaluation.dimensions.ontology_alignment.missing_axes
      : [],
    convergence_missing: Array.isArray(evaluation?.dimensions?.convergence?.missing)
      ? evaluation.dimensions.convergence.missing
      : [],
    blockers: Array.isArray(evaluation.blockers) ? evaluation.blockers : [],
    warnings: Array.isArray(evaluation.warnings) ? evaluation.warnings : [],
    recommendations: Array.isArray(evaluation.recommendations) ? evaluation.recommendations : [],
    report_file: normalizeString(evaluation.report_file) || null
  };
}

function deriveGateSignals(steps = []) {
  const normalized = Array.isArray(steps) ? steps : [];
  const requiredTotal = normalized.filter((step) => step && step.required !== false).length;
  const requiredEnabled = normalized.filter((step) => step && step.required !== false && step.enabled !== false).length;
  return {
    required_total: requiredTotal,
    required_enabled: requiredEnabled,
    required_missing: Math.max(0, requiredTotal - requiredEnabled)
  };
}

function buildStageReadiness(job = {}, stage = '', overrides = {}) {
  const normalizedStage = normalizeString(stage).toLowerCase();
  const patchBundleReady = normalizeString(job?.artifacts?.patch_bundle_id).length > 0;
  const verifyReportReady = normalizeString(job?.artifacts?.verify_report).length > 0;
  const readiness = {
    prerequisites_ready: true,
    rollback_ready: isStageCompleted(job, 'apply'),
    patch_bundle_ready: patchBundleReady,
    verify_report_ready: verifyReportReady
  };

  if (normalizedStage === 'generate') {
    readiness.prerequisites_ready = isStageCompleted(job, 'plan');
  } else if (normalizedStage === 'apply') {
    readiness.prerequisites_ready = isStageCompleted(job, 'generate');
  } else if (normalizedStage === 'verify') {
    readiness.prerequisites_ready = isStageCompleted(job, 'apply');
  } else if (normalizedStage === 'release') {
    readiness.prerequisites_ready = isStageCompleted(job, 'verify');
  }

  return {
    ...readiness,
    ...overrides
  };
}

function assignProblemEvalArtifact(job = {}, stage = '', evaluation = {}) {
  const normalizedStage = normalizeString(stage).toLowerCase();
  if (!normalizedStage) {
    return;
  }
  job.artifacts = job.artifacts || {};
  const reports = job.artifacts.problem_eval_reports && typeof job.artifacts.problem_eval_reports === 'object'
    ? job.artifacts.problem_eval_reports
    : {};
  reports[normalizedStage] = normalizeString(evaluation.report_file) || null;
  job.artifacts.problem_eval_reports = reports;
}

async function enforceProblemEvaluationForStage(job = {}, stage = '', context = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const evaluation = await runProblemEvaluation({
    stage,
    job_id: normalizeString(job.job_id),
    scene_id: normalizeString(context.scene_id || job?.scene?.id),
    spec_id: normalizeString(context.spec_id || job?.source?.spec_id || job?.scene?.spec_id),
    goal: normalizeString(context.goal || job?.source?.goal),
    release_channel: normalizeString(context.release_channel || ''),
    domain_chain: context.domain_chain || (job?.source?.domain_chain || {}),
    problem_contract: context.problem_contract || job?.source?.problem_contract || {},
    related_specs_count: Number(context.related_specs_count || job?.source?.related_specs?.total_candidates || 0),
    stage_readiness: context.stage_readiness || buildStageReadiness(job, stage),
    gate_signals: context.gate_signals || {}
  }, {
    projectPath,
    fileSystem,
    env: dependencies.env,
    writeReport: true
  });
  assignProblemEvalArtifact(job, stage, evaluation);
  return evaluation;
}

async function markStudioStageBlockedByProblemEval(paths, job, stageName, evaluation, fileSystem = fs) {
  const summary = summarizeProblemEvaluation(evaluation);
  job.status = `${stageName}_blocked`;
  job.updated_at = nowIso();
  job.stages = job.stages || createStageState();
  job.stages[stageName] = {
    status: 'blocked',
    completed_at: null,
    metadata: {
      problem_evaluation: summary
    }
  };
  await saveJob(paths, job, fileSystem);
  await appendStudioEvent(paths, job, `stage.${stageName}.blocked`, {
    problem_evaluation: summary
  }, fileSystem);
  await writeLatestJob(paths, job.job_id, fileSystem);

  const reason = summary.blockers.length > 0
    ? summary.blockers.join(', ')
    : 'problem-evaluation-policy';
  throw new Error(`studio ${stageName} blocked by problem evaluation: ${reason}`);
}

async function runStudioPlanCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const fromChat = normalizeString(options.fromChat);
  const sceneId = normalizeString(options.scene);
  const specId = normalizeString(options.spec);
  const goal = normalizeString(options.goal);
  const manualSpecMode = options.manualSpec === true;
  const skipSpecGovernance = options.specGovernance === false;

  if (!fromChat) {
    throw new Error('--from-chat is required');
  }
  if (!sceneId) {
    throw new Error('--scene is required');
  }

  const intakePolicyBundle = await loadStudioIntakePolicy(projectPath, fileSystem);
  const intakePolicy = intakePolicyBundle.policy || {};
  const governancePolicy = intakePolicy.governance || {};
  if (manualSpecMode && intakePolicy.allow_manual_spec_override !== true) {
    throw new Error(
      '--manual-spec is disabled by studio intake policy (allow_manual_spec_override=false)'
    );
  }
  if (skipSpecGovernance && governancePolicy.require_auto_on_plan !== false) {
    throw new Error(
      '--no-spec-governance is disabled by studio intake policy (governance.require_auto_on_plan=true)'
    );
  }

  let domainChainBinding = await resolveDomainChainBinding({
    sceneId,
    specId,
    goal
  }, {
    projectPath,
    fileSystem
  });

  let relatedSpecLookup = await findRelatedSpecs({
    query: goal,
    sceneId,
    limit: 8,
    excludeSpecId: domainChainBinding.spec_id || specId || null
  }, {
    projectPath,
    fileSystem
  });

  const intake = await runStudioAutoIntake({
    scene_id: sceneId,
    from_chat: fromChat,
    goal,
    explicit_spec_id: specId,
    domain_chain_binding: domainChainBinding,
    related_specs: relatedSpecLookup,
    apply: !manualSpecMode,
    skip: manualSpecMode
  }, {
    projectPath,
    fileSystem
  });

  const intakeSpecId = normalizeString(intake && intake.selected_spec_id);
  const effectiveSpecId = intakeSpecId || normalizeString(domainChainBinding.spec_id) || specId || null;

  if (effectiveSpecId && effectiveSpecId !== normalizeString(domainChainBinding.spec_id)) {
    domainChainBinding = await resolveDomainChainBinding({
      sceneId,
      specId: effectiveSpecId,
      goal
    }, {
      projectPath,
      fileSystem
    });
  }

  relatedSpecLookup = await findRelatedSpecs({
    query: goal,
    sceneId,
    limit: 8,
    excludeSpecId: effectiveSpecId || null
  }, {
    projectPath,
    fileSystem
  });

  const relatedSpecItems = Array.isArray(relatedSpecLookup.related_specs)
    ? relatedSpecLookup.related_specs.map((item) => ({
      spec_id: item.spec_id,
      scene_id: item.scene_id || null,
      score: Number(item.score || 0),
      reasons: Array.isArray(item.reasons) ? item.reasons : [],
      matched_tokens: Array.isArray(item.matched_tokens) ? item.matched_tokens : [],
      updated_at: item.updated_at || null
    }))
    : [];

  const paths = resolveStudioPaths(projectPath);
  await ensureStudioDirectories(paths, fileSystem);

  const jobId = normalizeString(options.job) || createJobId();
  const now = nowIso();
  const problemContract = normalizeProblemContract(
    domainChainBinding.problem_contract || {},
    {
      scene_id: sceneId,
      goal,
      problem_statement: normalizeString(domainChainBinding?.summary?.problem_statement),
      verification_plan: normalizeString(domainChainBinding?.summary?.verification_plan)
    }
  );
  const planShadowJob = {
    job_id: jobId,
    scene: {
      id: sceneId,
      spec_id: effectiveSpecId
    },
    source: {
      goal: goal || null,
      spec_id: effectiveSpecId,
      problem_contract: problemContract,
      problem_contract_path: domainChainBinding.problem_contract_path || null,
      domain_chain: {
        resolved: domainChainBinding.resolved === true,
        summary: domainChainBinding.summary || null
      },
      related_specs: {
        total_candidates: Number(relatedSpecLookup.total_candidates || 0)
      }
    },
    artifacts: {}
  };
  const planProblemEvaluation = await enforceProblemEvaluationForStage(planShadowJob, 'plan', {
    scene_id: sceneId,
    spec_id: effectiveSpecId,
    goal: goal || null,
    problem_contract: problemContract,
    domain_chain: {
      resolved: domainChainBinding.resolved === true,
      summary: domainChainBinding.summary || null
    },
    related_specs_count: Number(relatedSpecLookup.total_candidates || 0),
    stage_readiness: {
      prerequisites_ready: true,
      rollback_ready: false,
      patch_bundle_ready: false,
      verify_report_ready: false
    }
  }, {
    projectPath,
    fileSystem,
    env: dependencies.env
  });
  if (!planProblemEvaluation.passed) {
    const blockers = Array.isArray(planProblemEvaluation.blockers) && planProblemEvaluation.blockers.length > 0
      ? planProblemEvaluation.blockers.join(', ')
      : 'problem-evaluation-policy';
    throw new Error(`studio plan blocked by problem evaluation: ${blockers}`);
  }
  const stages = createStageState();
  const sessionStore = dependencies.sessionStore || new SessionStore(projectPath);
  const sceneSessionBinding = await sessionStore.beginSceneSession({
    sceneId,
    objective: goal || `Studio scene cycle for ${sceneId}`,
    tool: normalizeString(options.tool) || 'generic'
  });

  let governanceSnapshot = null;
  let governanceWarning = '';
  const autoRunGovernance = !(skipSpecGovernance)
    && (!intake || !intake.policy || !intake.policy.governance || intake.policy.governance.auto_run_on_plan !== false);
  if (autoRunGovernance) {
    try {
      governanceSnapshot = await runStudioSpecGovernance({
        apply: true,
        scene: sceneId
      }, {
        projectPath,
        fileSystem
      });
    } catch (error) {
      governanceWarning = normalizeString(error && error.message);
    }
  }

  stages.plan = {
    status: 'completed',
    completed_at: now,
    metadata: {
      from_chat: fromChat,
      scene_id: sceneId,
      spec_id: effectiveSpecId,
      scene_session_id: sceneSessionBinding.session.session_id,
      scene_cycle: sceneSessionBinding.scene_cycle,
      domain_chain_resolved: domainChainBinding.resolved === true,
      domain_chain_source: domainChainBinding.source || 'none',
      domain_chain_spec_id: domainChainBinding.spec_id || null,
      domain_chain_path: domainChainBinding.chain_path || null,
      domain_chain_summary: domainChainBinding.summary || null,
      domain_chain_reason: domainChainBinding.reason || null,
      problem_contract: problemContract,
      intake: intake ? {
        enabled: intake.enabled === true,
        intent_type: intake.intent ? intake.intent.intent_type : null,
        decision_action: intake.decision ? intake.decision.action : null,
        decision_reason: intake.decision ? intake.decision.reason : null,
        selected_spec_id: intake.selected_spec_id || effectiveSpecId || null,
        created_spec_id: intake.created_spec && intake.created_spec.created ? intake.created_spec.spec_id : null,
        policy_path: intake.policy_path || null
      } : null,
      problem_evaluation: summarizeProblemEvaluation(planProblemEvaluation),
      spec_governance: governanceSnapshot ? governanceSnapshot.summary : null,
      spec_governance_warning: governanceWarning || null,
      related_specs_total: Number(relatedSpecLookup.total_candidates || 0),
      related_specs_top: relatedSpecItems
    }
  };

  const job = {
    api_version: STUDIO_JOB_API_VERSION,
    job_id: jobId,
    created_at: now,
    updated_at: now,
    status: 'planned',
    source: {
      from_chat: fromChat,
      goal: goal || null,
      spec_id: effectiveSpecId,
      problem_contract: problemContract,
      problem_contract_path: domainChainBinding.problem_contract_path || null,
      intake: intake ? {
        enabled: intake.enabled === true,
        policy_path: intake.policy_path || null,
        policy_loaded_from: intake.policy_loaded_from || null,
        intent: intake.intent || null,
        decision: intake.decision || null,
        selected_spec_id: intake.selected_spec_id || effectiveSpecId || null,
        created_spec: intake.created_spec || null
      } : null,
      domain_chain: {
        resolved: domainChainBinding.resolved === true,
        source: domainChainBinding.source || 'none',
        reason: domainChainBinding.reason || null,
        spec_id: effectiveSpecId || domainChainBinding.spec_id || null,
        chain_path: domainChainBinding.chain_path || null,
        candidate_count: Number.isFinite(Number(domainChainBinding.candidate_count))
          ? Number(domainChainBinding.candidate_count)
          : 0,
        candidates: Array.isArray(domainChainBinding.candidates) ? domainChainBinding.candidates : [],
        summary: domainChainBinding.summary || null,
        context: domainChainBinding.context || null,
        updated_at: domainChainBinding.updated_at || null
      },
      related_specs: {
        query: relatedSpecLookup.query || '',
        scene_id: relatedSpecLookup.scene_id || null,
        total_candidates: Number(relatedSpecLookup.total_candidates || 0),
        items: relatedSpecItems
      },
      spec_governance: governanceSnapshot
        ? {
          status: governanceSnapshot.summary ? governanceSnapshot.summary.status : null,
          alert_count: governanceSnapshot.summary ? Number(governanceSnapshot.summary.alert_count || 0) : 0,
          report_file: governanceSnapshot.report_file || null,
          scene_index_file: governanceSnapshot.scene_index_file || null
        }
        : null,
      spec_governance_warning: governanceWarning || null
    },
    scene: {
      id: sceneId,
      spec_id: effectiveSpecId,
      related_spec_ids: relatedSpecItems.map((item) => item.spec_id)
    },
    session: {
      policy: 'mandatory.scene-primary',
      scene_id: sceneId,
      scene_session_id: sceneSessionBinding.session.session_id,
      scene_cycle: sceneSessionBinding.scene_cycle,
      created_new_scene_session: sceneSessionBinding.created_new === true
    },
    target: normalizeString(options.target) || 'default',
    stages,
    artifacts: {
      patch_bundle_id: null,
      verify_report: null,
      release_ref: null,
      spec_portfolio_report: governanceSnapshot && governanceSnapshot.report_file
        ? governanceSnapshot.report_file
        : null,
      spec_scene_index: governanceSnapshot && governanceSnapshot.scene_index_file
        ? governanceSnapshot.scene_index_file
        : null,
      problem_eval_reports: {
        plan: normalizeString(planProblemEvaluation.report_file) || null
      }
    }
  };

  await saveJob(paths, job, fileSystem);
  await appendStudioEvent(paths, job, 'stage.plan.completed', {
    from_chat: fromChat,
    scene_id: sceneId,
    spec_id: effectiveSpecId,
    scene_session_id: sceneSessionBinding.session.session_id,
    scene_cycle: sceneSessionBinding.scene_cycle,
    target: job.target,
    domain_chain_resolved: domainChainBinding.resolved === true,
    domain_chain_source: domainChainBinding.source || 'none',
    domain_chain_spec_id: domainChainBinding.spec_id || null,
    domain_chain_path: domainChainBinding.chain_path || null,
    problem_contract: problemContract,
    intake_action: intake && intake.decision ? intake.decision.action : null,
    intake_reason: intake && intake.decision ? intake.decision.reason : null,
    intake_selected_spec_id: intake ? intake.selected_spec_id || effectiveSpecId || null : effectiveSpecId,
    intake_created_spec_id: intake && intake.created_spec && intake.created_spec.created
      ? intake.created_spec.spec_id
      : null,
    problem_evaluation: summarizeProblemEvaluation(planProblemEvaluation),
    spec_governance: governanceSnapshot ? governanceSnapshot.summary : null,
    spec_governance_warning: governanceWarning || null,
    related_specs_total: Number(relatedSpecLookup.total_candidates || 0),
    related_spec_ids: relatedSpecItems.map((item) => item.spec_id)
  }, fileSystem);
  await writeLatestJob(paths, jobId, fileSystem);

  const payload = buildCommandPayload('studio-plan', job);
  payload.scene = {
    id: sceneId,
    spec_id: effectiveSpecId
  };
  payload.intake = job.source && job.source.intake ? job.source.intake : null;
  payload.spec_governance = governanceSnapshot ? governanceSnapshot.summary : null;
  printStudioPayload(payload, options);
  return payload;
}

async function runStudioGenerateCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const sceneArg = normalizeString(options.scene);

  const paths = resolveStudioPaths(projectPath);
  await ensureStudioDirectories(paths, fileSystem);
  const latestJobId = await readLatestJob(paths, fileSystem);
  const jobId = resolveRequestedJobId(options, latestJobId);
  if (!jobId) {
    throw new Error('No studio job found. Run: sce studio plan --scene <scene-id> --from-chat <session>');
  }

  const job = await loadJob(paths, jobId, fileSystem);
  ensureNotRolledBack(job, 'generate');
  ensureStagePrerequisite(job, 'generate', 'plan');
  const jobSceneId = normalizeString(job && job.scene && job.scene.id);
  if (!jobSceneId) {
    throw new Error('Cannot run studio generate: scene is not defined in plan stage');
  }
  if (sceneArg && sceneArg !== jobSceneId) {
    throw new Error(`Scene mismatch: planned scene is "${jobSceneId}" but --scene provided "${sceneArg}"`);
  }
  const sceneId = sceneArg || jobSceneId;
  const generateProblemEvaluation = await enforceProblemEvaluationForStage(job, 'generate', {
    scene_id: sceneId,
    spec_id: normalizeString(job?.source?.spec_id) || normalizeString(job?.scene?.spec_id) || null,
    goal: normalizeString(job?.source?.goal),
    domain_chain: job?.source?.domain_chain || {},
    related_specs_count: Number(job?.source?.related_specs?.total_candidates || 0),
    stage_readiness: buildStageReadiness(job, 'generate')
  }, {
    projectPath,
    fileSystem,
    env: dependencies.env
  });
  if (!generateProblemEvaluation.passed) {
    await markStudioStageBlockedByProblemEval(paths, job, 'generate', generateProblemEvaluation, fileSystem);
  }
  const patchBundleId = normalizeString(options.patchBundle) || `patch-${sceneId}-${Date.now()}`;
  const domainChainMetadata = buildJobDomainChainMetadata(job);
  const generateReportPath = `${STUDIO_REPORTS_DIR}/generate-${job.job_id}.json`;
  const generateReport = {
    mode: 'studio-generate',
    api_version: STUDIO_JOB_API_VERSION,
    job_id: job.job_id,
    scene_id: sceneId,
    target: normalizeString(options.target) || job.target || 'default',
    patch_bundle_id: patchBundleId,
    generated_at: nowIso(),
    domain_chain: domainChainMetadata
  };
  await writeStudioReport(projectPath, generateReportPath, generateReport, fileSystem);

  job.scene = job.scene || {};
  job.scene.id = sceneId;
  job.scene.spec_id = normalizeString(job?.source?.spec_id) || normalizeString(job?.scene?.spec_id) || null;
  job.target = normalizeString(options.target) || job.target || 'default';
  job.status = 'generated';
  job.artifacts = job.artifacts || {};
  job.artifacts.patch_bundle_id = patchBundleId;
  job.artifacts.generate_report = generateReportPath;
  job.updated_at = nowIso();

  ensureStageCompleted(job, 'generate', {
    scene_id: sceneId,
    target: job.target,
    patch_bundle_id: patchBundleId,
    problem_evaluation: summarizeProblemEvaluation(generateProblemEvaluation),
    domain_chain: domainChainMetadata,
    report: generateReportPath
  });

  await saveJob(paths, job, fileSystem);
  await appendStudioEvent(paths, job, 'stage.generate.completed', {
    scene_id: sceneId,
    target: job.target,
    patch_bundle_id: patchBundleId,
    problem_evaluation: summarizeProblemEvaluation(generateProblemEvaluation),
    domain_chain: domainChainMetadata,
    report: generateReportPath
  }, fileSystem);
  await writeLatestJob(paths, jobId, fileSystem);

  const payload = buildCommandPayload('studio-generate', job);
  printStudioPayload(payload, options);
  return payload;
}

async function runStudioApplyCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const paths = resolveStudioPaths(projectPath);
  await ensureStudioDirectories(paths, fileSystem);

  const latestJobId = await readLatestJob(paths, fileSystem);
  const jobId = resolveRequestedJobId(options, latestJobId);
  if (!jobId) {
    throw new Error('No studio job found. Run: sce studio plan --scene <scene-id> --from-chat <session>');
  }

  const job = await loadJob(paths, jobId, fileSystem);
  ensureNotRolledBack(job, 'apply');
  ensureStagePrerequisite(job, 'apply', 'generate');
  const authResult = await ensureStudioAuthorization('apply', options, {
    projectPath,
    fileSystem,
    env: dependencies.env,
    authSecret: dependencies.authSecret
  });
  const patchBundleId = normalizeString(options.patchBundle) || normalizeString(job.artifacts.patch_bundle_id);
  if (!patchBundleId) {
    throw new Error('--patch-bundle is required (or generate stage must provide one)');
  }
  const applyProblemEvaluation = await enforceProblemEvaluationForStage(job, 'apply', {
    scene_id: normalizeString(job?.scene?.id),
    spec_id: normalizeString(job?.source?.spec_id) || normalizeString(job?.scene?.spec_id) || null,
    goal: normalizeString(job?.source?.goal),
    domain_chain: job?.source?.domain_chain || {},
    related_specs_count: Number(job?.source?.related_specs?.total_candidates || 0),
    stage_readiness: buildStageReadiness(job, 'apply', {
      patch_bundle_ready: normalizeString(patchBundleId).length > 0
    })
  }, {
    projectPath,
    fileSystem,
    env: dependencies.env
  });
  if (!applyProblemEvaluation.passed) {
    await markStudioStageBlockedByProblemEval(paths, job, 'apply', applyProblemEvaluation, fileSystem);
  }

  job.status = 'applied';
  job.artifacts = job.artifacts || {};
  job.artifacts.patch_bundle_id = patchBundleId;
  job.updated_at = nowIso();

  ensureStageCompleted(job, 'apply', {
    patch_bundle_id: patchBundleId,
    auth_required: authResult.required,
    problem_evaluation: summarizeProblemEvaluation(applyProblemEvaluation)
  });

  await saveJob(paths, job, fileSystem);
  await appendStudioEvent(paths, job, 'stage.apply.completed', {
    patch_bundle_id: patchBundleId,
    auth_required: authResult.required,
    problem_evaluation: summarizeProblemEvaluation(applyProblemEvaluation)
  }, fileSystem);
  await writeLatestJob(paths, jobId, fileSystem);

  const payload = buildCommandPayload('studio-apply', job);
  printStudioPayload(payload, options);
  return payload;
}

async function runStudioVerifyCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const paths = resolveStudioPaths(projectPath);
  await ensureStudioDirectories(paths, fileSystem);

  const latestJobId = await readLatestJob(paths, fileSystem);
  const jobId = resolveRequestedJobId(options, latestJobId);
  if (!jobId) {
    throw new Error('No studio job found. Run: sce studio plan --scene <scene-id> --from-chat <session>');
  }

  const profile = normalizeString(options.profile) || 'standard';
  const job = await loadJob(paths, jobId, fileSystem);
  ensureNotRolledBack(job, 'verify');
  ensureStagePrerequisite(job, 'verify', 'apply');

  const verifyReportPath = `${STUDIO_REPORTS_DIR}/verify-${job.job_id}.json`;
  const verifyStartedAt = nowIso();
  const domainChainMetadata = buildJobDomainChainMetadata(job);
  const autoErrorbookRecords = [];
  const gateSteps = await buildVerifyGateSteps({ profile }, {
    projectPath,
    fileSystem,
    specId: normalizeString(domainChainMetadata.spec_id) || null
  });
  const verifyProblemEvaluation = await enforceProblemEvaluationForStage(job, 'verify', {
    scene_id: normalizeString(job?.scene?.id),
    spec_id: normalizeString(domainChainMetadata.spec_id) || normalizeString(job?.source?.spec_id),
    goal: normalizeString(job?.source?.goal),
    domain_chain: job?.source?.domain_chain || {},
    problem_contract: job?.source?.problem_contract || {},
    related_specs_count: Number(job?.source?.related_specs?.total_candidates || 0),
    stage_readiness: buildStageReadiness(job, 'verify', {
      gate_required_ready: deriveGateSignals(gateSteps).required_missing === 0,
      convergence_strict: profile === 'strict'
    }),
    gate_signals: deriveGateSignals(gateSteps)
  }, {
    projectPath,
    fileSystem,
    env: dependencies.env
  });
  if (!verifyProblemEvaluation.passed) {
    await markStudioStageBlockedByProblemEval(paths, job, 'verify', verifyProblemEvaluation, fileSystem);
  }
  const gateResult = await executeGateSteps(gateSteps, {
    projectPath,
    commandRunner: dependencies.commandRunner,
    env: dependencies.env,
    failOnRequiredSkip: profile === 'strict',
    onFailure: async ({ failure }) => {
      const captured = await autoRecordGateFailure(failure, {
        stage: 'verify',
        profile,
        job_id: job.job_id,
        scene_id: job?.scene?.id,
        spec_id: domainChainMetadata.spec_id
      }, {
        projectPath,
        fileSystem,
        autoRecordFailures: dependencies.autoRecordFailures
      });
      if (captured && captured.errorbook_entry_id) {
        autoErrorbookRecords.push({
          step_id: failure.id,
          entry_id: captured.errorbook_entry_id,
          fingerprint: captured.fingerprint
        });
      }
    }
  });
  const verifyCompletedAt = nowIso();
  const verifyReport = {
    mode: 'studio-verify',
    api_version: STUDIO_JOB_API_VERSION,
    job_id: job.job_id,
    profile,
    started_at: verifyStartedAt,
    completed_at: verifyCompletedAt,
    passed: gateResult.passed,
    steps: gateResult.steps,
    domain_chain: domainChainMetadata,
    problem_evaluation: summarizeProblemEvaluation(verifyProblemEvaluation),
    auto_errorbook_records: autoErrorbookRecords
  };

  await writeStudioReport(projectPath, verifyReportPath, verifyReport, fileSystem);

  job.artifacts = job.artifacts || {};
  job.artifacts.verify_report = verifyReportPath;
  job.updated_at = verifyCompletedAt;

  if (!gateResult.passed) {
    job.status = 'verify_failed';
    job.stages.verify = {
      status: 'failed',
      completed_at: null,
      metadata: {
        profile,
        passed: false,
        report: verifyReportPath,
        problem_evaluation: summarizeProblemEvaluation(verifyProblemEvaluation),
        domain_chain: domainChainMetadata,
        auto_errorbook_records: autoErrorbookRecords
      }
    };
    await saveJob(paths, job, fileSystem);
    await appendStudioEvent(paths, job, 'stage.verify.failed', {
      profile,
      report: verifyReportPath,
      problem_evaluation: summarizeProblemEvaluation(verifyProblemEvaluation),
      domain_chain: domainChainMetadata,
      auto_errorbook_records: autoErrorbookRecords
    }, fileSystem);
    await writeLatestJob(paths, jobId, fileSystem);
    throw new Error(`studio verify failed: ${gateResult.steps.filter((step) => step.status === 'failed').map((step) => step.id).join(', ')}`);
  }

  job.status = 'verified';
  ensureStageCompleted(job, 'verify', {
    profile,
    passed: true,
    report: verifyReportPath,
    problem_evaluation: summarizeProblemEvaluation(verifyProblemEvaluation),
    domain_chain: domainChainMetadata,
    auto_errorbook_records: autoErrorbookRecords
  });

  await saveJob(paths, job, fileSystem);
  await appendStudioEvent(paths, job, 'stage.verify.completed', {
    profile,
    passed: true,
    report: verifyReportPath,
    problem_evaluation: summarizeProblemEvaluation(verifyProblemEvaluation),
    domain_chain: domainChainMetadata,
    auto_errorbook_records: autoErrorbookRecords
  }, fileSystem);
  await writeLatestJob(paths, jobId, fileSystem);

  const payload = buildCommandPayload('studio-verify', job);
  printStudioPayload(payload, options);
  return payload;
}

async function runStudioReleaseCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const paths = resolveStudioPaths(projectPath);
  await ensureStudioDirectories(paths, fileSystem);

  const latestJobId = await readLatestJob(paths, fileSystem);
  const jobId = resolveRequestedJobId(options, latestJobId);
  if (!jobId) {
    throw new Error('No studio job found. Run: sce studio plan --scene <scene-id> --from-chat <session>');
  }

  const channel = normalizeString(options.channel) || 'dev';
  if (!RELEASE_CHANNELS.has(channel)) {
    throw new Error(`Invalid --channel "${channel}". Expected one of: ${Array.from(RELEASE_CHANNELS).join(', ')}`);
  }

  const job = await loadJob(paths, jobId, fileSystem);
  ensureNotRolledBack(job, 'release');
  ensureStagePrerequisite(job, 'release', 'verify');
  const authResult = await ensureStudioAuthorization('release', options, {
    projectPath,
    fileSystem,
    env: dependencies.env,
    authSecret: dependencies.authSecret
  });
  const releaseRef = normalizeString(options.releaseRef) || `${channel}-${Date.now()}`;

  const profile = normalizeString(options.profile) || 'standard';
  const releaseReportPath = `${STUDIO_REPORTS_DIR}/release-${job.job_id}.json`;
  const releaseStartedAt = nowIso();
  const domainChainMetadata = buildJobDomainChainMetadata(job);
  const autoErrorbookRecords = [];
  const verifyReportSignals = await readVerifyReportSignals(
    projectPath,
    normalizeString(job?.artifacts?.verify_report),
    fileSystem
  );
  const governanceSignals = await readGovernanceSignals(projectPath, fileSystem);
  const gateSteps = await buildReleaseGateSteps({ profile }, {
    projectPath,
    fileSystem,
    specId: normalizeString(domainChainMetadata.spec_id) || null,
    verifyReportPath: normalizeString(job?.artifacts?.verify_report) || null
  });
  const releaseGateSignals = deriveGateSignals(gateSteps);
  const releaseProblemEvaluation = await enforceProblemEvaluationForStage(job, 'release', {
    scene_id: normalizeString(job?.scene?.id),
    spec_id: normalizeString(domainChainMetadata.spec_id) || normalizeString(job?.source?.spec_id),
    goal: normalizeString(job?.source?.goal),
    release_channel: channel,
    domain_chain: job?.source?.domain_chain || {},
    problem_contract: job?.source?.problem_contract || {},
    related_specs_count: Number(job?.source?.related_specs?.total_candidates || 0),
    stage_readiness: buildStageReadiness(job, 'release', {
      gate_required_ready: releaseGateSignals.required_missing === 0,
      convergence_strict: profile === 'strict',
      verify_stage_passed: isStageCompleted(job, 'verify'),
      verify_report_ready: verifyReportSignals.available,
      verify_report_passed: verifyReportSignals.passed,
      regression_passed: verifyReportSignals.passed && verifyReportSignals.failed_step_count === 0,
      governance_report_ready: governanceSignals.available,
      high_alert_count: Number(governanceSignals.high_breach_count || 0)
    }),
    gate_signals: releaseGateSignals
  }, {
    projectPath,
    fileSystem,
    env: dependencies.env
  });
  if (!releaseProblemEvaluation.passed) {
    await markStudioStageBlockedByProblemEval(paths, job, 'release', releaseProblemEvaluation, fileSystem);
  }
  const gateResult = await executeGateSteps(gateSteps, {
    projectPath,
    commandRunner: dependencies.commandRunner,
    env: dependencies.env,
    failOnRequiredSkip: profile === 'strict',
    onFailure: async ({ failure }) => {
      const captured = await autoRecordGateFailure(failure, {
        stage: 'release',
        profile,
        job_id: job.job_id,
        scene_id: job?.scene?.id,
        spec_id: domainChainMetadata.spec_id
      }, {
        projectPath,
        fileSystem,
        autoRecordFailures: dependencies.autoRecordFailures
      });
      if (captured && captured.errorbook_entry_id) {
        autoErrorbookRecords.push({
          step_id: failure.id,
          entry_id: captured.errorbook_entry_id,
          fingerprint: captured.fingerprint
        });
      }
    }
  });
  const releaseCompletedAt = nowIso();
  const releaseReport = {
    mode: 'studio-release',
    api_version: STUDIO_JOB_API_VERSION,
    job_id: job.job_id,
    profile,
    channel,
    release_ref: releaseRef,
    started_at: releaseStartedAt,
    completed_at: releaseCompletedAt,
    passed: gateResult.passed,
    steps: gateResult.steps,
    domain_chain: domainChainMetadata,
    verify_signals: verifyReportSignals,
    governance_signals: governanceSignals,
    problem_evaluation: summarizeProblemEvaluation(releaseProblemEvaluation),
    auto_errorbook_records: autoErrorbookRecords
  };

  await writeStudioReport(projectPath, releaseReportPath, releaseReport, fileSystem);

  job.artifacts = job.artifacts || {};
  job.artifacts.release_ref = releaseRef;
  job.artifacts.release_report = releaseReportPath;
  job.updated_at = releaseCompletedAt;

  if (!gateResult.passed) {
    job.status = 'release_failed';
    job.stages.release = {
      status: 'failed',
      completed_at: null,
      metadata: {
        channel,
        release_ref: releaseRef,
        passed: false,
        report: releaseReportPath,
        auth_required: authResult.required,
        problem_evaluation: summarizeProblemEvaluation(releaseProblemEvaluation),
        domain_chain: domainChainMetadata,
        auto_errorbook_records: autoErrorbookRecords
      }
    };
    await saveJob(paths, job, fileSystem);
    await appendStudioEvent(paths, job, 'stage.release.failed', {
      channel,
      release_ref: releaseRef,
      report: releaseReportPath,
      auth_required: authResult.required,
      problem_evaluation: summarizeProblemEvaluation(releaseProblemEvaluation),
      domain_chain: domainChainMetadata,
      auto_errorbook_records: autoErrorbookRecords
    }, fileSystem);
    await writeLatestJob(paths, jobId, fileSystem);
    throw new Error(`studio release failed: ${gateResult.steps.filter((step) => step.status === 'failed').map((step) => step.id).join(', ')}`);
  }

  job.status = 'released';
  ensureStageCompleted(job, 'release', {
    channel,
    release_ref: releaseRef,
    report: releaseReportPath,
    auth_required: authResult.required,
    problem_evaluation: summarizeProblemEvaluation(releaseProblemEvaluation),
    domain_chain: domainChainMetadata,
    auto_errorbook_records: autoErrorbookRecords
  });

  const sceneId = normalizeString(job && job.scene && job.scene.id);
  const sceneSessionId = normalizeString(job && job.session && job.session.scene_session_id);
  if (sceneId && sceneSessionId) {
    const sessionStore = dependencies.sessionStore || new SessionStore(projectPath);
    const rollover = await sessionStore.completeSceneSession(sceneId, sceneSessionId, {
      summary: `Scene ${sceneId} completed by studio release ${releaseRef}`,
      status: 'completed',
      jobId: job.job_id,
      releaseRef,
      channel,
      nextObjective: `Next cycle for scene ${sceneId} after release ${releaseRef}`
    });
    job.session = {
      ...(job.session || {}),
      completed_scene_session_id: rollover.completed_session.session_id,
      scene_session_id: rollover.next_session ? rollover.next_session.session_id : null,
      scene_cycle: rollover.next_scene_cycle || null,
      rolled_over_at: nowIso()
    };
  }

  await saveJob(paths, job, fileSystem);
  await appendStudioEvent(paths, job, 'stage.release.completed', {
    channel,
    release_ref: releaseRef,
    report: releaseReportPath,
    auth_required: authResult.required,
    problem_evaluation: summarizeProblemEvaluation(releaseProblemEvaluation),
    domain_chain: domainChainMetadata,
    auto_errorbook_records: autoErrorbookRecords
  }, fileSystem);
  await writeLatestJob(paths, jobId, fileSystem);

  const payload = buildCommandPayload('studio-release', job);
  printStudioPayload(payload, options);
  return payload;
}

async function runStudioResumeCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const paths = resolveStudioPaths(projectPath);
  await ensureStudioDirectories(paths, fileSystem);

  const latestJobId = await readLatestJob(paths, fileSystem);
  const jobId = resolveRequestedJobId(options, latestJobId);
  if (!jobId) {
    throw new Error('No studio job found. Run: sce studio plan --scene <scene-id> --from-chat <session>');
  }

  const job = await loadJob(paths, jobId, fileSystem);
  const payload = buildCommandPayload('studio-resume', job);
  payload.success = true;
  printStudioPayload(payload, options);
  return payload;
}

async function runStudioRollbackCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const paths = resolveStudioPaths(projectPath);
  await ensureStudioDirectories(paths, fileSystem);

  const latestJobId = await readLatestJob(paths, fileSystem);
  const jobId = resolveRequestedJobId(options, latestJobId);
  if (!jobId) {
    throw new Error('No studio job found. Run: sce studio plan --scene <scene-id> --from-chat <session>');
  }

  const reason = normalizeString(options.reason) || 'manual-rollback';
  const job = await loadJob(paths, jobId, fileSystem);
  const authResult = await ensureStudioAuthorization('rollback', options, {
    projectPath,
    fileSystem,
    env: dependencies.env,
    authSecret: dependencies.authSecret
  });
  if (!isStageCompleted(job, 'apply')) {
    throw new Error(`Cannot rollback studio job ${job.job_id}: apply stage is not completed`);
  }

  job.status = 'rolled_back';
  job.updated_at = nowIso();
  job.rollback = {
    reason,
    rolled_back_at: job.updated_at,
    auth_required: authResult.required
  };

  const sceneSessionId = normalizeString(job && job.session && job.session.scene_session_id);
  if (sceneSessionId) {
    const sessionStore = dependencies.sessionStore || new SessionStore(projectPath);
    await sessionStore.snapshotSession(sceneSessionId, {
      summary: `Studio rollback: ${reason}`,
      status: 'rolled_back',
      payload: {
        job_id: job.job_id,
        reason
      }
    });
  }

  await saveJob(paths, job, fileSystem);
  await appendStudioEvent(paths, job, 'job.rolled_back', {
    reason
  }, fileSystem);
  await writeLatestJob(paths, jobId, fileSystem);

  const payload = buildCommandPayload('studio-rollback', job);
  payload.rollback = { ...job.rollback };
  printStudioPayload(payload, options);
  return payload;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function printStudioEventsPayload(payload, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(chalk.blue(`Studio events: ${payload.job_id}`));
  console.log(`  Count: ${payload.events.length}`);
  for (const event of payload.events) {
    console.log(`  - ${event.timestamp} ${event.event_type}`);
  }
}

async function runStudioEventsCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const paths = resolveStudioPaths(projectPath);
  await ensureStudioDirectories(paths, fileSystem);

  const latestJobId = await readLatestJob(paths, fileSystem);
  const jobId = resolveRequestedJobId(options, latestJobId);
  if (!jobId) {
    throw new Error('No studio job found. Run: sce studio plan --scene <scene-id> --from-chat <session>');
  }

  const limit = normalizePositiveInteger(options.limit, 50);
  const events = await readStudioEvents(paths, jobId, { limit }, fileSystem);

  const payload = {
    mode: 'studio-events',
    success: true,
    job_id: jobId,
    limit,
    events
  };
  printStudioEventsPayload(payload, options);
  return payload;
}

function printStudioIntakePayload(payload, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(chalk.blue('Studio intake'));
  console.log(`  Scene: ${payload.scene_id || 'n/a'}`);
  console.log(`  Goal: ${payload.goal || '(empty)'}`);
  console.log(`  Intent: ${payload.intent && payload.intent.intent_type ? payload.intent.intent_type : 'unknown'}`);
  console.log(`  Decision: ${payload.decision && payload.decision.action ? payload.decision.action : 'none'}`);
  console.log(`  Spec: ${payload.selected_spec_id || 'n/a'}`);
}

async function runStudioIntakeCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const sceneId = normalizeString(options.scene);
  const fromChat = normalizeString(options.fromChat);
  const goal = normalizeString(options.goal);
  const specId = normalizeString(options.spec);

  if (!sceneId) {
    throw new Error('--scene is required');
  }
  if (!fromChat) {
    throw new Error('--from-chat is required');
  }

  const domainChainBinding = await resolveDomainChainBinding({
    sceneId,
    specId,
    goal
  }, {
    projectPath,
    fileSystem
  });

  const relatedSpecLookup = await findRelatedSpecs({
    query: goal,
    sceneId,
    limit: 8,
    excludeSpecId: domainChainBinding.spec_id || specId || null
  }, {
    projectPath,
    fileSystem
  });

  const intake = await runStudioAutoIntake({
    scene_id: sceneId,
    from_chat: fromChat,
    goal,
    explicit_spec_id: specId,
    domain_chain_binding: domainChainBinding,
    related_specs: relatedSpecLookup,
    apply: options.apply === true,
    skip: options.manualSpec === true
  }, {
    projectPath,
    fileSystem
  });

  const payload = {
    ...intake,
    domain_chain_source: domainChainBinding.source || 'none',
    domain_chain_spec_id: domainChainBinding.spec_id || null,
    related_specs_total: Number(relatedSpecLookup.total_candidates || 0)
  };
  printStudioIntakePayload(payload, options);
  return payload;
}

function printStudioPortfolioPayload(payload, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const summary = payload.summary || {};
  console.log(chalk.blue('Studio portfolio governance'));
  console.log(`  Status: ${summary.status || 'unknown'}`);
  console.log(`  Scenes: ${summary.scene_count || 0}`);
  console.log(`  Specs: ${summary.total_specs || 0}`);
  console.log(`  Active: ${summary.active_specs || 0}`);
  console.log(`  Completed: ${summary.completed_specs || 0}`);
  console.log(`  Stale: ${summary.stale_specs || 0}`);
  console.log(`  Duplicate pairs: ${summary.duplicate_pairs || 0}`);
  console.log(`  Overflow scenes: ${summary.overflow_scenes || 0}`);
}

function printStudioBackfillPayload(payload, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(chalk.blue('Studio scene backfill'));
  console.log(`  Source scene: ${payload.source_scene || 'scene.unassigned'}`);
  console.log(`  Candidates: ${payload.summary ? payload.summary.candidate_count : 0}`);
  console.log(`  Changed: ${payload.summary ? payload.summary.changed_count : 0}`);
  console.log(`  Apply: ${payload.apply ? 'yes' : 'no'}`);
  console.log(`  Override file: ${payload.override_file || 'n/a'}`);
}

async function runStudioPortfolioCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const payload = await runStudioSpecGovernance({
    scene: normalizeString(options.scene),
    apply: options.apply !== false
  }, {
    projectPath,
    fileSystem
  });

  if (options.strict && payload.summary && Number(payload.summary.alert_count || 0) > 0) {
    throw new Error(
      `studio portfolio governance has alerts: ${payload.summary.alert_count} (duplicate/stale/overflow)`
    );
  }

  printStudioPortfolioPayload(payload, options);
  return payload;
}

async function runStudioBackfillSpecScenesCommand(options = {}, dependencies = {}) {
  const projectPath = dependencies.projectPath || process.cwd();
  const fileSystem = dependencies.fileSystem || fs;
  const backfillOptions = {
    scene: normalizeString(options.scene),
    all: options.all === true,
    limit: options.limit,
    apply: options.apply === true,
    refresh_governance: options.refreshGovernance !== false
  };
  if (options.activeOnly === true) {
    backfillOptions.active_only = true;
  }

  const payload = await runStudioSceneBackfill(backfillOptions, {
    projectPath,
    fileSystem
  });

  printStudioBackfillPayload(payload, options);
  return payload;
}

async function runStudioCommand(handler, options, stageName = '') {
  try {
    const stage = normalizeString(stageName) || 'unknown';
    const sceneId = normalizeString(options && options.scene);
    const summaryGoal = normalizeString(options && options.goal);
    const fromChat = normalizeString(options && options.fromChat);
    const summaryParts = [
      'studio',
      stage,
      sceneId ? `scene=${sceneId}` : '',
      summaryGoal ? `goal=${summaryGoal}` : '',
      fromChat ? `chat=${fromChat}` : ''
    ].filter(Boolean);

    await captureTimelineCheckpoint({
      trigger: 'key-event',
      event: `studio.${stage}`,
      summary: summaryParts.join(' | '),
      command: `sce studio ${stage}`.trim(),
      sceneId
    }, {
      projectPath: process.cwd()
    });

    await handler(options);
  } catch (error) {
    console.error(chalk.red(`Studio command failed: ${error.message}`));
    process.exitCode = 1;
  }
}

function registerStudioCommands(program) {
  const studio = program
    .command('studio')
    .description('Run studio chat-to-release orchestration workflow');

  studio
    .command('plan')
    .description('Create/refresh a studio plan job from chat context')
    .requiredOption('--scene <scene-id>', 'Scene identifier (mandatory primary session anchor)')
    .requiredOption('--from-chat <session>', 'Chat session identifier or transcript reference')
    .option('--spec <spec-id>', 'Optional spec binding for domain-chain context ingestion')
    .option('--goal <goal>', 'Optional goal summary')
    .option('--manual-spec', 'Legacy bypass flag (disabled by default policy)')
    .option('--target <target>', 'Target integration profile', 'default')
    .option('--no-spec-governance', 'Legacy bypass flag (disabled by default policy)')
    .option('--job <job-id>', 'Reuse an explicit studio job id')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => runStudioCommand(runStudioPlanCommand, options, 'plan'));

  studio
    .command('intake')
    .description('Analyze chat goal and auto-resolve spec binding/create decision')
    .requiredOption('--scene <scene-id>', 'Scene identifier')
    .requiredOption('--from-chat <session>', 'Chat session identifier or transcript reference')
    .option('--spec <spec-id>', 'Optional explicit spec id')
    .option('--goal <goal>', 'Goal text used for intent classification')
    .option('--apply', 'Create spec when decision is create_spec')
    .option('--manual-spec', 'Legacy bypass flag (disabled by default policy)')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => runStudioCommand(runStudioIntakeCommand, options, 'intake'));

  studio
    .command('portfolio')
    .description('Build scene-organized spec governance portfolio')
    .option('--scene <scene-id>', 'Optional scene filter')
    .option('--no-apply', 'Do not write portfolio/index artifacts to .sce/spec-governance/')
    .option('--strict', 'Fail when governance alerts are detected')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => runStudioCommand(runStudioPortfolioCommand, options, 'portfolio'));

  studio
    .command('backfill-spec-scenes')
    .description('Backfill scene bindings for historical specs (writes override mapping when --apply)')
    .option('--scene <scene-id>', 'Source scene filter (default: scene.unassigned)')
    .option('--all', 'Include completed/stale specs (default uses active-only policy)')
    .option('--active-only', 'Force active-only filtering')
    .option('--limit <n>', 'Maximum number of specs to process')
    .option('--apply', 'Write mapping to .sce/spec-governance/spec-scene-overrides.json')
    .option('--no-refresh-governance', 'Skip portfolio refresh after apply')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => runStudioCommand(runStudioBackfillSpecScenesCommand, options, 'backfill-spec-scenes'));

  studio
    .command('generate')
    .description('Generate patch bundle metadata for a planned studio job (scene inherited from plan)')
    .option('--scene <scene-id>', 'Optional scene identifier; must match planned scene when provided')
    .option('--target <target>', 'Target integration profile override')
    .option('--patch-bundle <id>', 'Explicit patch bundle id')
    .option('--job <job-id>', 'Studio job id (defaults to latest)')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => runStudioCommand(runStudioGenerateCommand, options, 'generate'));

  studio
    .command('apply')
    .description('Apply generated patch bundle metadata to studio job')
    .option('--patch-bundle <id>', 'Patch bundle identifier (defaults to generated artifact)')
    .option('--auth-password <password>', 'Authorization password for protected apply action')
    .option('--require-auth', 'Require authorization even when policy is advisory')
    .option('--job <job-id>', 'Studio job id (defaults to latest)')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => runStudioCommand(runStudioApplyCommand, options, 'apply'));

  studio
    .command('verify')
    .description('Record verification stage for studio job')
    .option('--profile <profile>', 'Verification profile', 'standard')
    .option('--job <job-id>', 'Studio job id (defaults to latest)')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => runStudioCommand(runStudioVerifyCommand, options, 'verify'));

  studio
    .command('release')
    .description('Record release stage for studio job')
    .option('--channel <channel>', 'Release channel (dev|prod)', 'dev')
    .option('--profile <profile>', 'Release gate profile', 'standard')
    .option('--auth-password <password>', 'Authorization password for protected release action')
    .option('--require-auth', 'Require authorization even when policy is advisory')
    .option('--release-ref <ref>', 'Explicit release reference/tag')
    .option('--job <job-id>', 'Studio job id (defaults to latest)')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => runStudioCommand(runStudioReleaseCommand, options, 'release'));

  studio
    .command('resume')
    .description('Inspect current studio job and next action')
    .option('--job <job-id>', 'Studio job id (defaults to latest)')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => runStudioCommand(runStudioResumeCommand, options, 'resume'));

  studio
    .command('events')
    .description('Show studio job event stream')
    .option('--job <job-id>', 'Studio job id (defaults to latest)')
    .option('--limit <number>', 'Maximum number of recent events to return', '50')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => runStudioCommand(runStudioEventsCommand, options, 'events'));

  studio
    .command('rollback')
    .description('Rollback a studio job after apply/release')
    .option('--job <job-id>', 'Studio job id (defaults to latest)')
    .option('--reason <reason>', 'Rollback reason')
    .option('--auth-password <password>', 'Authorization password for protected rollback action')
    .option('--require-auth', 'Require authorization even when policy is advisory')
    .option('--json', 'Print machine-readable JSON output')
    .action(async (options) => runStudioCommand(runStudioRollbackCommand, options, 'rollback'));
}

module.exports = {
  STUDIO_JOB_API_VERSION,
  STUDIO_EVENT_API_VERSION,
  STAGE_ORDER,
  RELEASE_CHANNELS,
  resolveStudioPaths,
  createJobId,
  createStageState,
  readStudioEvents,
  readLatestJob,
  executeGateSteps,
  loadStudioSecurityPolicy,
  ensureStudioAuthorization,
  buildVerifyGateSteps,
  buildReleaseGateSteps,
  resolveNextAction,
  buildProgress,
  runStudioPlanCommand,
  runStudioIntakeCommand,
  runStudioGenerateCommand,
  runStudioApplyCommand,
  runStudioVerifyCommand,
  runStudioReleaseCommand,
  runStudioRollbackCommand,
  runStudioEventsCommand,
  runStudioPortfolioCommand,
  runStudioBackfillSpecScenesCommand,
  runStudioResumeCommand,
  registerStudioCommands
};
