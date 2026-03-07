/**
 * Autonomous Control CLI Commands
 */

const AutonomousEngine = require('../auto/autonomous-engine');
const { mergeConfigs, DEFAULT_CONFIG } = require('../auto/config-schema');
const { runAutoCloseLoop } = require('../auto/close-loop-runner');
const { analyzeGoalSemantics } = require('../auto/semantic-decomposer');
const { buildMoquiRegressionRecoverySequenceLines } = require('../auto/moqui-recovery-sequence');
const { buildStatusCounts, buildQueueFormatCounts, buildMasterSpecCounts } = require('../auto/session-metrics');
const { normalizeStatusToken, isCompletedStatus, isFailedStatus, normalizeStatsWindowDays, filterEntriesByStatus, filterGovernanceEntriesByResumeMode, calculatePercent } = require('../auto/archive-summary');
const { normalizeKeep, normalizeSpecKeep, normalizeOlderThanDays, normalizeSpecSessionProtectWindowDays, normalizeSpecSessionMaxTotal, normalizeSpecSessionMaxCreated, normalizeSpecSessionMaxCreatedPerGoal, normalizeSpecSessionMaxDuplicateGoals } = require('../auto/retention-policy');
const { collectSpecNamesFromBatchSummary, collectSpecNamesFromCloseLoopSessionPayload, collectSpecNamesFromBatchSummaryPayload, createProtectionReasonRecord, ensureProtectionReasonRecord, incrementProtectionReason, buildProtectionRanking, buildSpecProtectionReasonPayload } = require('../auto/spec-protection');
const { presentCloseLoopSessionList, presentCloseLoopSessionStats, presentControllerSessionList } = require('../auto/session-presenter');
const { normalizeHandoffText, parseAutoHandoffGateBoolean, normalizeAutoHandoffGateRiskLevel, toGovernanceReleaseGateNumber, normalizeGovernanceReleaseGateSnapshot, normalizeGovernanceWeeklyOpsStopDetail } = require('../auto/governance-signals');
const { deriveGovernanceRiskLevel, buildGovernanceConcerns, buildGovernanceRecommendations } = require('../auto/governance-summary');
const { presentGovernanceSessionList } = require('../auto/governance-session-presenter');
const { presentGovernanceSessionStats } = require('../auto/governance-stats-presenter');
const { buildAutoGovernanceMaintenancePlan, summarizeGovernanceMaintenanceExecution } = require('../auto/governance-maintenance-presenter');
const { runAutoGovernanceMaintenance: runAutoGovernanceMaintenanceService } = require('../auto/governance-maintenance-service');
const { runAutoGovernanceCloseLoop: runAutoGovernanceCloseLoopService } = require('../auto/governance-close-loop-service');
const { buildAutoGovernanceStats: buildAutoGovernanceStatsService } = require('../auto/governance-stats-service');
const { executeGovernanceAdvisoryRecover: executeGovernanceAdvisoryRecoverService, executeGovernanceAdvisoryControllerResume: executeGovernanceAdvisoryControllerResumeService } = require('../auto/governance-advisory-service');
const { listCloseLoopSessions: listCloseLoopSessionsService, statsCloseLoopSessions: statsCloseLoopSessionsService, listGovernanceCloseLoopSessions: listGovernanceCloseLoopSessionsService, statsGovernanceCloseLoopSessions: statsGovernanceCloseLoopSessionsService, listCloseLoopControllerSessions: listCloseLoopControllerSessionsService, statsCloseLoopControllerSessions: statsCloseLoopControllerSessionsService } = require('../auto/session-query-service');
const { buildProgramFailureClusters, buildProgramRemediationActions, buildProgramDiagnostics } = require('../auto/program-diagnostics');
const MOQUI_CAPABILITY_LEXICON = require('../data/moqui-capability-lexicon.json');
const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const { spawnSync } = require('child_process');

const AUTO_ARCHIVE_SCHEMA_VERSION = '1.0';
const AUTO_ARCHIVE_SCHEMA_SUPPORTED_VERSIONS = new Set([AUTO_ARCHIVE_SCHEMA_VERSION]);
const AUTO_HANDOFF_DEFAULT_QUEUE_FILE = '.sce/auto/handoff-goals.lines';
const AUTO_HANDOFF_RUN_REPORT_DIR = '.sce/reports/handoff-runs';
const AUTO_HANDOFF_RELEASE_EVIDENCE_FILE = '.sce/reports/release-evidence/handoff-runs.json';
const AUTO_HANDOFF_EVIDENCE_REVIEW_DEFAULT_FILE = '.sce/reports/release-evidence/handoff-evidence-review.md';
const AUTO_HANDOFF_RELEASE_EVIDENCE_DIR = '.sce/reports/release-evidence';
const AUTO_HANDOFF_RELEASE_GATE_HISTORY_FILE = '.sce/reports/release-evidence/release-gate-history.json';
const AUTO_HANDOFF_MOQUI_BASELINE_JSON_FILE = '.sce/reports/release-evidence/moqui-template-baseline.json';
const AUTO_HANDOFF_MOQUI_BASELINE_MARKDOWN_FILE = '.sce/reports/release-evidence/moqui-template-baseline.md';
const AUTO_HANDOFF_SCENE_PACKAGE_BATCH_JSON_FILE = '.sce/reports/release-evidence/scene-package-publish-batch-dry-run.json';
const AUTO_HANDOFF_SCENE_PACKAGE_BATCH_TASK_QUEUE_FILE = '.sce/auto/ontology-remediation.lines';
const AUTO_HANDOFF_MOQUI_CAPABILITY_COVERAGE_JSON_FILE = '.sce/reports/release-evidence/moqui-capability-coverage.json';
const AUTO_HANDOFF_MOQUI_CAPABILITY_COVERAGE_MARKDOWN_FILE = '.sce/reports/release-evidence/moqui-capability-coverage.md';
const AUTO_HANDOFF_MOQUI_REMEDIATION_QUEUE_FILE = '.sce/auto/moqui-remediation.lines';
const AUTO_HANDOFF_MOQUI_CLUSTER_REMEDIATION_FILE = '.sce/auto/matrix-remediation.capability-clusters.json';
const AUTO_HANDOFF_CLI_SCRIPT_FILE = path.resolve(__dirname, '..', '..', 'bin', 'scene-capability-engine.js');
const MOQUI_CAPABILITY_LEXICON_INDEX = buildMoquiCapabilityLexiconIndex(MOQUI_CAPABILITY_LEXICON);
const AUTO_HANDOFF_POLICY_PROFILE_PRESETS = {
  default: {
    min_spec_success_rate: 100,
    max_risk_level: 'high',
    min_ontology_score: 0,
    min_capability_coverage_percent: 100,
    min_capability_semantic_percent: 100,
    max_moqui_matrix_regressions: 0,
    max_unmapped_rules: null,
    max_undecided_decisions: null,
    require_ontology_validation: true,
    require_moqui_baseline: true,
    require_scene_package_batch: true,
    require_capability_coverage: true,
    require_capability_semantic: true,
    require_capability_lexicon: true,
    require_release_gate_preflight: true,
    dependency_batching: true,
    release_evidence_window: 5
  },
  moqui: {
    min_spec_success_rate: 100,
    max_risk_level: 'high',
    min_ontology_score: 0,
    min_capability_coverage_percent: 100,
    min_capability_semantic_percent: 100,
    max_moqui_matrix_regressions: 0,
    max_unmapped_rules: null,
    max_undecided_decisions: null,
    require_ontology_validation: true,
    require_moqui_baseline: true,
    require_scene_package_batch: true,
    require_capability_coverage: true,
    require_capability_semantic: true,
    require_capability_lexicon: true,
    require_release_gate_preflight: true,
    dependency_batching: true,
    release_evidence_window: 5
  },
  enterprise: {
    min_spec_success_rate: 100,
    max_risk_level: 'medium',
    min_ontology_score: 0,
    min_capability_coverage_percent: 100,
    min_capability_semantic_percent: 100,
    max_moqui_matrix_regressions: 0,
    max_unmapped_rules: null,
    max_undecided_decisions: null,
    require_ontology_validation: true,
    require_moqui_baseline: true,
    require_scene_package_batch: true,
    require_capability_coverage: true,
    require_capability_semantic: true,
    require_capability_lexicon: true,
    require_release_gate_preflight: true,
    dependency_batching: true,
    release_evidence_window: 10
  }
};

/**
 * Register auto commands
 * @param {Object} program - Commander program
 */
function registerAutoCommands(program) {
  const auto = program
    .command('auto')
    .description('Autonomous execution control');
  
  // sce auto run
  auto
    .command('run <spec-name>')
    .description('Run Spec autonomously')
    .option('-m, --mode <mode>', 'Execution mode (conservative|balanced|aggressive)', 'aggressive')
    .action(async (specName, options) => {
      try {
        console.log(chalk.blue(`Starting autonomous execution: ${specName}`));
        console.log(chalk.gray(`Mode: ${options.mode}`));
        
        const config = await loadConfig(options.mode);
        const engine = new AutonomousEngine(specName, config);
        
        await engine.initialize();
        await engine.start();
        await engine.executeTaskQueue();
        await engine.stop();
        
        const status = engine.getStatus();
        console.log(chalk.green('\n✓ Execution completed'));
        console.log(chalk.gray(`Tasks completed: ${status.queueStatus.completed}/${status.queueStatus.total}`));
        
      } catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
        process.exit(1);
      }
    });
  
  // sce auto create
  auto
    .command('create <feature-description>')
    .description('Create and run Spec autonomously')
    .option('-n, --name <name>', 'Spec name')
    .option('-m, --mode <mode>', 'Execution mode', 'aggressive')
    .action(async (description, options) => {
      try {
        const specName = options.name || generateSpecName(description);
        
        console.log(chalk.blue(`Creating Spec: ${specName}`));
        console.log(chalk.gray(`Description: ${description}`));
        
        const config = await loadConfig(options.mode);
        const engine = new AutonomousEngine(specName, config);
        
        await engine.initialize();
        await engine.start();
        
        const result = await engine.createSpecAutonomously(description);
        
        console.log(chalk.green('\n✓ Spec created'));
        console.log(chalk.gray(`Requirements: ${result.requirementsCreated ? '✓' : '✗'}`));
        console.log(chalk.gray(`Design: ${result.designCreated ? '✓' : '✗'}`));
        console.log(chalk.gray(`Tasks: ${result.tasksCreated ? '✓' : '✗'}`));
        
        await engine.stop();
        
      } catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
        process.exit(1);
      }
    });
  
  // sce auto status
  auto
    .command('status [spec-name]')
    .description('Show autonomous execution status')
    .action(async (specName) => {
      try {
        if (!specName) {
          // Show all active executions
          console.log(chalk.blue('Active autonomous executions:'));
          console.log(chalk.gray('(No active executions)'));
          return;
        }
        
        const config = await loadConfig();
        const engine = new AutonomousEngine(specName, config);
        
        await engine.initialize();
        const status = engine.getStatus();
        
        console.log(chalk.blue(`\nStatus: ${specName}`));
        console.log(chalk.gray(`Running: ${status.isRunning ? 'Yes' : 'No'}`));
        console.log(chalk.gray(`Paused: ${status.isPaused ? 'Yes' : 'No'}`));
        console.log(chalk.gray(`Current task: ${status.currentTask || 'None'}`));
        console.log(chalk.gray(`Progress: ${status.progress.overallProgress}%`));
        console.log(chalk.gray(`Tasks: ${status.queueStatus.completed}/${status.queueStatus.total}`));
        
      } catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
        process.exit(1);
      }
    });
  
  // sce auto resume
  auto
    .command('resume [spec-name]')
    .description('Resume paused execution')
    .action(async (specName) => {
      try {
        if (!specName) {
          console.error(chalk.red('Error: Spec name required'));
          process.exit(1);
        }
        
        const config = await loadConfig();
        const engine = new AutonomousEngine(specName, config);
        
        await engine.initialize();
        await engine.resume();
        await engine.executeTaskQueue();
        await engine.stop();
        
        console.log(chalk.green('✓ Execution resumed and completed'));
        
      } catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
        process.exit(1);
      }
    });
  
  // sce auto stop
  auto
    .command('stop <spec-name>')
    .description('Stop autonomous execution')
    .action(async (specName) => {
      try {
        const config = await loadConfig();
        const engine = new AutonomousEngine(specName, config);
        
        await engine.initialize();
        await engine.stop();
        
        console.log(chalk.green('✓ Execution stopped'));
        
      } catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
        process.exit(1);
      }
    });
  
  // sce auto config
  auto
    .command('config')
    .description('Show/edit autonomous configuration')
    .option('--show', 'Show current configuration')
    .option('--mode <mode>', 'Set default mode')
    .action(async (options) => {
      try {
        const configPath = path.join(process.cwd(), '.sce', 'auto', 'config.json');
        
        if (options.show) {
          const config = await loadConfig();
          console.log(chalk.blue('Current configuration:'));
          console.log(JSON.stringify(config, null, 2));
          return;
        }
        
        if (options.mode) {
          const config = await loadConfig();
          config.mode = options.mode;
          await fs.ensureDir(path.dirname(configPath));
          await fs.writeJson(configPath, config, { spaces: 2 });
          console.log(chalk.green(`✓ Mode set to: ${options.mode}`));
          return;
        }
        
        console.log(chalk.gray('Use --show to view configuration'));
        console.log(chalk.gray('Use --mode <mode> to set default mode'));
        
      } catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
        process.exit(1);
      }
    });

  const runCloseLoopCommand = async (goal, options, extra = {}) => {
    const resumeAliases = new Set(['continue', '继续']);
    let normalizedGoal = goal;
    let resumeRef = typeof options.resume === 'string' && options.resume.trim()
      ? options.resume.trim()
      : null;

    if (!resumeRef) {
      const goalToken = typeof goal === 'string' ? goal.trim() : '';
      const normalizedGoalToken = goalToken.toLowerCase();
      if (resumeAliases.has(goalToken) || resumeAliases.has(normalizedGoalToken)) {
        resumeRef = 'interrupted';
        normalizedGoal = undefined;
      }
    }

    if (extra.forceResumeRef) {
      resumeRef = extra.forceResumeRef;
      normalizedGoal = undefined;
    }

    const effectiveOptions = resumeRef
      ? { ...options, resume: resumeRef }
      : options;

    if (!effectiveOptions.resume && (!normalizedGoal || `${normalizedGoal}`.trim() === '')) {
      throw new Error('Goal is required unless --resume is provided.');
    }
    return runAutoCloseLoop(normalizedGoal, effectiveOptions);
  };

  // sce auto close-loop
  applyCloseLoopOptions(
    auto
      .command('close-loop [goal]')
      .description('Autonomously decompose one goal into master/sub Specs and execute to closure'),
    { includeOut: true }
  )
    .action(async (goal, options) => {
      try {
        const result = await runCloseLoopCommand(goal, options);
        if (result.status === 'failed') {
          process.exit(1);
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  // sce auto continue
  applyCloseLoopOptions(
    auto
      .command('continue')
      .description('Continue latest interrupted close-loop session'),
    { includeOut: true }
  )
    .action(async (options) => {
      try {
        const result = await runCloseLoopCommand(undefined, options, {
          forceResumeRef: 'interrupted'
        });
        if (result.status === 'failed') {
          process.exit(1);
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  // sce auto close-loop-batch
  applyCloseLoopOptions(
    auto
      .command('close-loop-batch [goals-file]')
      .description('Run autonomous close-loop for multiple goals from a file'),
    { includeOut: false }
  )
    .option('--format <format>', 'Goals file format: auto|json|lines (default: auto)', 'auto')
    .option('--decompose-goal <goal>', 'Decompose one broad goal into multiple batch goals automatically')
    .option('--program-goals <n>', 'Target number of generated goals for --decompose-goal (default: adaptive)', parseInt)
    .option('--program-min-quality-score <n>', 'Minimum decomposition quality score before automatic refinement (0-100, default: 70)', parseFloat)
    .option('--program-quality-gate', 'Fail when final decomposition quality is below --program-min-quality-score')
    .option('--resume-from-summary <path|latest>', 'Resume pending goals from a previous close-loop-batch summary JSON (or latest)')
    .option('--resume-strategy <strategy>', 'Resume strategy for --resume-from-summary: pending|failed-only (default: pending)', 'pending')
    .option('--batch-parallel <n>', 'Maximum goals to run concurrently in batch mode (default: adaptive under autonomous policy)', parseInt)
    .option('--batch-agent-budget <n>', 'Global parallel-agent budget shared across all batch goals', parseInt)
    .option('--batch-priority <strategy>', 'Batch goal priority strategy: fifo|complex-first|complex-last|critical-first (default: complex-first under autonomous policy)', 'fifo')
    .option('--batch-aging-factor <n>', 'Aging boost per scheduling cycle for waiting goals (default: 2 under autonomous policy)', parseInt)
    .option('--batch-retry-rounds <n>', 'Automatically retry failed/stopped goals for N extra rounds (default: 0, or until-complete under autonomous policy)', parseInt)
    .option('--batch-retry-strategy <strategy>', 'Batch retry strategy: adaptive|strict (default: adaptive)', 'adaptive')
    .option('--batch-retry-until-complete', 'Keep retrying failed/stopped goals until completed or retry max is reached')
    .option('--batch-retry-max-rounds <n>', 'Max extra rounds when --batch-retry-until-complete is enabled (default: 10)', parseInt)
    .option('--no-batch-autonomous', 'Disable autonomous batch policy and use explicit batch flags only')
    .option('--batch-session-id <id>', 'Set explicit batch session id for batch summary persistence')
    .option('--batch-session-keep <n>', 'Keep newest N batch summary sessions after each batch run', parseInt)
    .option('--batch-session-older-than-days <n>', 'Only prune batch summary sessions older than N days', parseInt)
    .option('--spec-session-keep <n>', 'After run, keep newest N spec directories under .sce/specs', parseInt)
    .option('--spec-session-older-than-days <n>', 'Only prune spec directories older than N days', parseInt)
    .option('--no-spec-session-protect-active', 'Allow spec retention prune to delete active/recently referenced specs')
    .option('--spec-session-protect-window-days <n>', 'Protection window (days) for recent session references when pruning specs', parseInt)
    .option('--spec-session-max-total <n>', 'Spec directory budget: maximum total directories allowed under .sce/specs', parseInt)
    .option('--spec-session-max-created <n>', 'Spec growth guard: maximum estimated created directories in this run', parseInt)
    .option('--spec-session-max-created-per-goal <n>', 'Spec growth guard: maximum estimated created directories per processed goal', parseFloat)
    .option('--spec-session-max-duplicate-goals <n>', 'Spec growth guard: maximum duplicate goals allowed in one batch input', parseInt)
    .option('--spec-session-budget-hard-fail', 'Fail run when spec directory budget is exceeded before/after execution')
    .option('--no-batch-session', 'Disable automatic close-loop-batch summary session persistence')
    .option('--continue-on-error', 'Continue processing remaining goals when one goal fails')
    .option('--out <path>', 'Write batch summary JSON to file')
    .action(async (goalsFile, options) => {
      try {
        if (options.resume) {
          throw new Error('--resume is not supported in close-loop-batch. Use per-goal close-loop or remove --resume.');
        }
        if (options.sessionId) {
          throw new Error('--session-id is not supported in close-loop-batch. Session ids are generated per goal.');
        }
        if (options.programGoals !== undefined && options.programGoals !== null && !options.decomposeGoal) {
          throw new Error('--program-goals requires --decompose-goal.');
        }
        const batchAutonomousEnabled = options.batchAutonomous !== false;
        if (
          options.batchRetryMaxRounds !== undefined &&
          options.batchRetryMaxRounds !== null &&
          !options.batchRetryUntilComplete &&
          !batchAutonomousEnabled
        ) {
          throw new Error('--batch-retry-max-rounds requires --batch-retry-until-complete.');
        }
        if (options.batchRetryMaxRounds !== undefined && options.batchRetryMaxRounds !== null) {
          normalizeBatchRetryMaxRounds(options.batchRetryMaxRounds);
        }
        if (options.batchSessionKeep !== undefined && options.batchSessionKeep !== null) {
          normalizeBatchSessionKeep(options.batchSessionKeep);
        }
        if (options.batchSessionOlderThanDays !== undefined && options.batchSessionOlderThanDays !== null) {
          normalizeBatchSessionOlderThanDays(options.batchSessionOlderThanDays);
        }
        if (options.specSessionKeep !== undefined && options.specSessionKeep !== null) {
          normalizeSpecKeep(options.specSessionKeep);
        }
        if (options.specSessionOlderThanDays !== undefined && options.specSessionOlderThanDays !== null) {
          normalizeOlderThanDays(options.specSessionOlderThanDays);
        }
        if (options.specSessionProtectWindowDays !== undefined && options.specSessionProtectWindowDays !== null) {
          normalizeSpecSessionProtectWindowDays(options.specSessionProtectWindowDays);
        }
        if (options.specSessionMaxTotal !== undefined && options.specSessionMaxTotal !== null) {
          normalizeSpecSessionMaxTotal(options.specSessionMaxTotal);
        }
        if (options.specSessionMaxCreated !== undefined && options.specSessionMaxCreated !== null) {
          normalizeSpecSessionMaxCreated(options.specSessionMaxCreated);
        }
        if (options.specSessionMaxCreatedPerGoal !== undefined && options.specSessionMaxCreatedPerGoal !== null) {
          normalizeSpecSessionMaxCreatedPerGoal(options.specSessionMaxCreatedPerGoal);
        }
        if (options.specSessionMaxDuplicateGoals !== undefined && options.specSessionMaxDuplicateGoals !== null) {
          normalizeSpecSessionMaxDuplicateGoals(options.specSessionMaxDuplicateGoals);
        }
        if (options.batchSessionId !== undefined && options.batchSessionId !== null) {
          const sanitizedBatchSessionId = sanitizeBatchSessionId(options.batchSessionId);
          if (!sanitizedBatchSessionId) {
            throw new Error('--batch-session-id is invalid after sanitization.');
          }
        }
        if (options.resumeFromSummary && goalsFile) {
          throw new Error('Provide either <goals-file> or --resume-from-summary, not both.');
        }
        if (options.decomposeGoal && goalsFile) {
          throw new Error('Provide either <goals-file> or --decompose-goal, not both.');
        }
        if (options.decomposeGoal && options.resumeFromSummary) {
          throw new Error('Provide either --resume-from-summary or --decompose-goal, not both.');
        }
        if (!options.resumeFromSummary && !options.decomposeGoal && (!goalsFile || `${goalsFile}`.trim() === '')) {
          throw new Error('<goals-file> is required unless --resume-from-summary or --decompose-goal is provided.');
        }

        const projectPath = process.cwd();
        const goalsResult = options.decomposeGoal
          ? buildCloseLoopBatchGoalsFromGoal(
            options.decomposeGoal,
            options.programGoals,
            {
              minQualityScore: options.programMinQualityScore,
              enforceQualityGate: Boolean(options.programQualityGate)
            }
          )
          : options.resumeFromSummary
            ? await loadCloseLoopBatchGoalsFromSummary(
              projectPath,
              options.resumeFromSummary,
              options.format,
              options.resumeStrategy
            )
            : await loadCloseLoopBatchGoals(projectPath, goalsFile, options.format);
        if (goalsResult.goals.length === 0) {
          throw new Error(`No goals found in batch file: ${goalsResult.file}`);
        }

        const summary = await executeCloseLoopBatch(goalsResult, options, projectPath, 'auto-close-loop-batch');
        printCloseLoopBatchSummary(summary, options);

        if (
          summary.status !== 'completed' ||
          isSpecSessionBudgetHardFailure(summary) ||
          isSpecSessionGrowthGuardHardFailure(summary)
        ) {
          process.exit(1);
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  // sce auto close-loop-program
  applyCloseLoopOptions(
    auto
      .command('close-loop-program <goal>')
      .description('Autonomously decompose one broad goal into multiple close-loop goals and run as a program'),
    { includeOut: false }
  )
    .option('--program-goals <n>', 'Target number of generated goals for program decomposition (default: adaptive)', parseInt)
    .option('--program-min-quality-score <n>', 'Minimum decomposition quality score before automatic refinement (0-100, default: 70)', parseFloat)
    .option('--program-quality-gate', 'Fail when final decomposition quality is below --program-min-quality-score')
    .option('--batch-parallel <n>', 'Maximum goals to run concurrently in program mode', parseInt)
    .option('--batch-agent-budget <n>', 'Global parallel-agent budget shared across all program goals', parseInt)
    .option('--batch-priority <strategy>', 'Program goal priority strategy: fifo|complex-first|complex-last|critical-first', 'fifo')
    .option('--batch-aging-factor <n>', 'Aging boost per scheduling cycle for waiting goals', parseInt)
    .option('--batch-retry-rounds <n>', 'Automatically retry failed/stopped goals for N extra rounds', parseInt)
    .option('--batch-retry-strategy <strategy>', 'Batch retry strategy: adaptive|strict', 'adaptive')
    .option('--batch-retry-until-complete', 'Keep retrying failed/stopped goals until completed or retry max is reached')
    .option('--batch-retry-max-rounds <n>', 'Max extra rounds for retry-until-complete mode (default: 10)', parseInt)
    .option('--no-batch-autonomous', 'Disable autonomous batch policy in close-loop-program')
    .option('--batch-session-id <id>', 'Set explicit batch session id for summary persistence')
    .option('--batch-session-keep <n>', 'Keep newest N batch summary sessions after each program run', parseInt)
    .option('--batch-session-older-than-days <n>', 'Only prune batch summary sessions older than N days', parseInt)
    .option('--spec-session-keep <n>', 'After run, keep newest N spec directories under .sce/specs', parseInt)
    .option('--spec-session-older-than-days <n>', 'Only prune spec directories older than N days', parseInt)
    .option('--no-spec-session-protect-active', 'Allow spec retention prune to delete active/recently referenced specs')
    .option('--spec-session-protect-window-days <n>', 'Protection window (days) for recent session references when pruning specs', parseInt)
    .option('--spec-session-max-total <n>', 'Spec directory budget: maximum total directories allowed under .sce/specs', parseInt)
    .option('--spec-session-max-created <n>', 'Spec growth guard: maximum estimated created directories in this run', parseInt)
    .option('--spec-session-max-created-per-goal <n>', 'Spec growth guard: maximum estimated created directories per processed goal', parseFloat)
    .option('--spec-session-max-duplicate-goals <n>', 'Spec growth guard: maximum duplicate goals allowed in one batch input', parseInt)
    .option('--spec-session-budget-hard-fail', 'Fail run when spec directory budget is exceeded before/after execution')
    .option('--no-batch-session', 'Disable automatic close-loop-program summary session persistence')
    .option('--continue-on-error', 'Continue processing remaining goals when one goal fails')
    .option('--no-program-auto-recover', 'Disable automatic recovery loop when program run ends with unresolved goals')
    .option('--program-recover-use-action <n>', 'Preferred remediation action index for program auto recovery (default: memory/default)', parseInt)
    .option('--program-recover-resume-strategy <strategy>', 'Program auto recovery resume strategy: pending|failed-only (default: pending)', 'pending')
    .option('--program-recover-max-rounds <n>', 'Max rounds for program auto recovery (default: 5)', parseInt)
    .option('--program-recover-max-minutes <n>', 'Max elapsed minutes for program auto recovery loop (default: unlimited)', parseInt)
    .option('--program-gate-profile <profile>', 'Program convergence gate profile: default|dev|staging|prod', 'default')
    .option('--program-gate-fallback-profile <profile>', 'Fallback gate profile when primary gate fails: none|default|dev|staging|prod', 'none')
    .option('--program-gate-fallback-chain <profiles>', 'Ordered fallback gate profiles (comma-separated): none|default|dev|staging|prod')
    .option('--program-min-success-rate <n>', 'Program convergence gate: minimum success rate percent (default: 100)', parseFloat)
    .option('--program-max-risk-level <level>', 'Program convergence gate: maximum allowed risk level (low|medium|high)')
    .option('--program-max-elapsed-minutes <n>', 'Program convergence gate: maximum elapsed minutes (default: unlimited)', parseInt)
    .option('--program-max-agent-budget <n>', 'Program convergence gate: maximum allowed agent budget/effective parallel budget', parseInt)
    .option('--program-max-total-sub-specs <n>', 'Program convergence gate: maximum total sub-specs generated across program goals', parseInt)
    .option('--no-program-gate-auto-remediate', 'Disable automatic remediation patch/prune suggestions after gate failure')
    .option('--program-govern-until-stable', 'Enable post-run governance loop until gate/anomaly stability is reached')
    .option('--program-govern-max-rounds <n>', 'Max governance rounds when --program-govern-until-stable is enabled (default: 3)', parseInt)
    .option('--program-govern-max-minutes <n>', 'Max elapsed minutes for governance loop (default: 60)', parseInt)
    .option('--program-govern-anomaly-weeks <n>', 'KPI trend lookback weeks for governance anomaly checks (default: 8)', parseInt)
    .option('--program-govern-anomaly-period <period>', 'KPI trend period for governance anomaly checks: week|day', 'week')
    .option('--no-program-govern-anomaly', 'Disable anomaly-triggered governance decisions (gate-only)')
    .option('--program-govern-use-action <n>', 'Pinned remediation action index used by governance rounds (default: memory/default)', parseInt)
    .option('--no-program-govern-auto-action', 'Disable automatic remediation action selection/execution inside governance loop')
    .option('--recovery-memory-scope <scope>', 'Recovery memory scope key (default: auto: project + git branch)')
    .option('--program-audit-out <path>', 'Write program audit JSON with recovery and coordination trace')
    .option('--program-kpi-out <path>', 'Write program KPI snapshot JSON to file')
    .option('--out <path>', 'Write program summary JSON to file')
    .action(async (goal, options) => {
      try {
        const result = await executeCloseLoopProgramGoal(goal, options, {
          projectPath: process.cwd(),
          printSummary: true,
          writeOutputs: true
        });
        if (result.exitCode !== 0) {
          process.exit(1);
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  // sce auto close-loop-controller
  auto
    .command('close-loop-controller [queue-file]')
    .description('Run a persistent autonomous controller that drains a goal queue via close-loop-program execution')
    .option('--controller-resume <session>', 'Resume controller from persisted session id/file/latest')
    .option('--queue-format <format>', 'Queue file format: auto|json|lines (default: auto)', 'auto')
    .option('--no-controller-dedupe', 'Disable duplicate broad-goal deduplication when loading queue entries')
    .option('--dequeue-limit <n>', 'Maximum goals to consume from queue per controller cycle (default: all pending goals)', parseInt)
    .option('--wait-on-empty', 'Keep polling when queue is empty instead of exiting')
    .option('--poll-seconds <n>', 'Polling interval seconds when --wait-on-empty is enabled (default: 30)', parseInt)
    .option('--max-cycles <n>', 'Maximum controller cycles before exit (default: 1000)', parseInt)
    .option('--max-minutes <n>', 'Maximum controller elapsed minutes before exit (default: 120)', parseInt)
    .option('--controller-lock-file <path>', 'Controller lease lock file path (default: <queue-file>.lock)')
    .option('--controller-lock-ttl-seconds <n>', 'Stale lock takeover threshold seconds (default: 1800)', parseInt)
    .option('--no-controller-lock', 'Disable controller lease lock (not recommended in concurrent runs)')
    .option('--stop-on-goal-failure', 'Stop controller immediately when one dequeued goal fails')
    .option('--controller-session-id <id>', 'Set explicit controller session id for summary persistence')
    .option('--controller-session-keep <n>', 'Keep newest N controller sessions after each controller run', parseInt)
    .option('--controller-session-older-than-days <n>', 'Only prune controller sessions older than N days', parseInt)
    .option('--no-controller-session', 'Disable close-loop-controller summary session persistence')
    .option('--controller-out <path>', 'Write controller summary JSON to file')
    .option('--controller-done-file <path>', 'Append completed goals to a line-based archive file')
    .option('--controller-failed-file <path>', 'Append failed goals to a line-based archive file')
    .option('--controller-print-program-summary', 'Print per-goal close-loop-program summary while controller runs')
    .option('--program-goals <n>', 'Target number of generated goals for program decomposition (default: adaptive)', parseInt)
    .option('--program-min-quality-score <n>', 'Minimum decomposition quality score before automatic refinement (0-100, default: 70)', parseFloat)
    .option('--program-quality-gate', 'Fail when final decomposition quality is below --program-min-quality-score')
    .option('--batch-parallel <n>', 'Maximum goals to run concurrently in program mode', parseInt)
    .option('--batch-agent-budget <n>', 'Global parallel-agent budget shared across all program goals', parseInt)
    .option('--batch-priority <strategy>', 'Program goal priority strategy: fifo|complex-first|complex-last|critical-first', 'fifo')
    .option('--batch-aging-factor <n>', 'Aging boost per scheduling cycle for waiting goals', parseInt)
    .option('--batch-retry-rounds <n>', 'Automatically retry failed/stopped goals for N extra rounds', parseInt)
    .option('--batch-retry-strategy <strategy>', 'Batch retry strategy: adaptive|strict', 'adaptive')
    .option('--batch-retry-until-complete', 'Keep retrying failed/stopped goals until completed or retry max is reached')
    .option('--batch-retry-max-rounds <n>', 'Max extra rounds for retry-until-complete mode (default: 10)', parseInt)
    .option('--no-batch-autonomous', 'Disable autonomous batch policy in close-loop-controller')
    .option('--continue-on-error', 'Continue processing remaining goals when one goal fails')
    .option('--no-program-auto-recover', 'Disable automatic recovery loop when program run ends with unresolved goals')
    .option('--program-recover-use-action <n>', 'Preferred remediation action index for program auto recovery (default: memory/default)', parseInt)
    .option('--program-recover-resume-strategy <strategy>', 'Program auto recovery resume strategy: pending|failed-only (default: pending)', 'pending')
    .option('--program-recover-max-rounds <n>', 'Max rounds for program auto recovery (default: 5)', parseInt)
    .option('--program-recover-max-minutes <n>', 'Max elapsed minutes for program auto recovery loop (default: unlimited)', parseInt)
    .option('--program-gate-profile <profile>', 'Program convergence gate profile: default|dev|staging|prod', 'default')
    .option('--program-gate-fallback-profile <profile>', 'Fallback gate profile when primary gate fails: none|default|dev|staging|prod', 'none')
    .option('--program-gate-fallback-chain <profiles>', 'Ordered fallback gate profiles (comma-separated): none|default|dev|staging|prod')
    .option('--program-min-success-rate <n>', 'Program convergence gate: minimum success rate percent (default: 100)', parseFloat)
    .option('--program-max-risk-level <level>', 'Program convergence gate: maximum allowed risk level (low|medium|high)')
    .option('--program-max-elapsed-minutes <n>', 'Program convergence gate: maximum elapsed minutes (default: unlimited)', parseInt)
    .option('--program-max-agent-budget <n>', 'Program convergence gate: maximum allowed agent budget/effective parallel budget', parseInt)
    .option('--program-max-total-sub-specs <n>', 'Program convergence gate: maximum total sub-specs generated across program goals', parseInt)
    .option('--no-program-gate-auto-remediate', 'Disable automatic remediation patch/prune suggestions after gate failure')
    .option('--program-govern-until-stable', 'Enable post-run governance loop until gate/anomaly stability is reached')
    .option('--program-govern-max-rounds <n>', 'Max governance rounds when --program-govern-until-stable is enabled (default: 3)', parseInt)
    .option('--program-govern-max-minutes <n>', 'Max elapsed minutes for governance loop (default: 60)', parseInt)
    .option('--program-govern-anomaly-weeks <n>', 'KPI trend lookback weeks for governance anomaly checks (default: 8)', parseInt)
    .option('--program-govern-anomaly-period <period>', 'KPI trend period for governance anomaly checks: week|day', 'week')
    .option('--no-program-govern-anomaly', 'Disable anomaly-triggered governance decisions (gate-only)')
    .option('--program-govern-use-action <n>', 'Pinned remediation action index used by governance rounds (default: memory/default)', parseInt)
    .option('--no-program-govern-auto-action', 'Disable automatic remediation action selection/execution inside governance loop')
    .option('--recovery-memory-scope <scope>', 'Recovery memory scope key (default: auto: project + git branch)')
    .option('--dry-run', 'Preview decomposition without writing files')
    .option('--json', 'Output machine-readable JSON')
    .action(async (queueFile, options) => {
      try {
        const projectPath = process.cwd();
        if (options.controllerResume && queueFile) {
          throw new Error('[queue-file] cannot be combined with --controller-resume.');
        }
        const resumedSession = options.controllerResume
          ? await loadCloseLoopControllerSessionPayload(projectPath, options.controllerResume)
          : null;
        const summary = await runCloseLoopController(queueFile, options, {
          projectPath,
          resumedSession
        });
        if (options.json) {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          printCloseLoopControllerSummary(summary);
        }
        if (summary.status !== 'completed') {
          process.exit(1);
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  // sce auto close-loop-recover
  applyCloseLoopOptions(
    auto
      .command('close-loop-recover [summary]')
      .description('Automatically recover unresolved goals from a prior close-loop program/batch summary using remediation actions'),
    { includeOut: false }
  )
    .option('--use-action <n>', 'Select remediation action index from diagnostics (default: 1)', parseInt)
    .option('--resume-strategy <strategy>', 'Resume strategy for summary recovery: pending|failed-only (default: pending)', 'pending')
    .option('--recover-until-complete', 'Keep running recovery rounds until completion or recover max rounds is reached')
    .option('--recover-max-rounds <n>', 'Max recovery rounds when --recover-until-complete is enabled (default: 5)', parseInt)
    .option('--recover-max-minutes <n>', 'Max elapsed minutes for recovery loop (default: unlimited)', parseInt)
    .option('--recovery-memory-ttl-days <n>', 'Prune recovery memory entries older than N days before selecting action', parseInt)
    .option('--recovery-memory-scope <scope>', 'Recovery memory scope key (default: auto: project + git branch)')
    .option('--batch-parallel <n>', 'Maximum goals to run concurrently during recovery', parseInt)
    .option('--batch-agent-budget <n>', 'Global parallel-agent budget shared across recovery goals', parseInt)
    .option('--batch-priority <strategy>', 'Recovery goal priority strategy: fifo|complex-first|complex-last|critical-first', 'fifo')
    .option('--batch-aging-factor <n>', 'Aging boost per scheduling cycle for waiting goals', parseInt)
    .option('--batch-retry-rounds <n>', 'Automatically retry failed/stopped goals for N extra rounds', parseInt)
    .option('--batch-retry-strategy <strategy>', 'Batch retry strategy: adaptive|strict', 'adaptive')
    .option('--batch-retry-until-complete', 'Keep retrying failed/stopped goals until completed or retry max is reached')
    .option('--batch-retry-max-rounds <n>', 'Max extra rounds for retry-until-complete mode (default: 10)', parseInt)
    .option('--no-batch-autonomous', 'Disable autonomous batch policy in close-loop-recover')
    .option('--batch-session-id <id>', 'Set explicit batch session id for summary persistence')
    .option('--batch-session-keep <n>', 'Keep newest N batch summary sessions after each recovery run', parseInt)
    .option('--batch-session-older-than-days <n>', 'Only prune batch summary sessions older than N days', parseInt)
    .option('--spec-session-keep <n>', 'After run, keep newest N spec directories under .sce/specs', parseInt)
    .option('--spec-session-older-than-days <n>', 'Only prune spec directories older than N days', parseInt)
    .option('--no-spec-session-protect-active', 'Allow spec retention prune to delete active/recently referenced specs')
    .option('--spec-session-protect-window-days <n>', 'Protection window (days) for recent session references when pruning specs', parseInt)
    .option('--spec-session-max-total <n>', 'Spec directory budget: maximum total directories allowed under .sce/specs', parseInt)
    .option('--spec-session-max-created <n>', 'Spec growth guard: maximum estimated created directories in this run', parseInt)
    .option('--spec-session-max-created-per-goal <n>', 'Spec growth guard: maximum estimated created directories per processed goal', parseFloat)
    .option('--spec-session-max-duplicate-goals <n>', 'Spec growth guard: maximum duplicate goals allowed in one batch input', parseInt)
    .option('--spec-session-budget-hard-fail', 'Fail run when spec directory budget is exceeded before/after execution')
    .option('--program-gate-profile <profile>', 'Recovery convergence gate profile: default|dev|staging|prod', 'default')
    .option('--program-gate-fallback-profile <profile>', 'Recovery fallback gate profile: none|default|dev|staging|prod', 'none')
    .option('--program-gate-fallback-chain <profiles>', 'Recovery ordered fallback gate profiles (comma-separated): none|default|dev|staging|prod')
    .option('--program-min-success-rate <n>', 'Recovery convergence gate: minimum success rate percent', parseFloat)
    .option('--program-max-risk-level <level>', 'Recovery convergence gate: maximum allowed risk level (low|medium|high)')
    .option('--program-max-elapsed-minutes <n>', 'Recovery convergence gate: maximum elapsed minutes', parseInt)
    .option('--program-max-agent-budget <n>', 'Recovery convergence gate: maximum allowed agent budget/effective parallel budget', parseInt)
    .option('--program-max-total-sub-specs <n>', 'Recovery convergence gate: maximum total sub-specs generated across goals', parseInt)
    .option('--no-program-gate-auto-remediate', 'Disable automatic remediation patch/prune suggestions after gate failure')
    .option('--no-batch-session', 'Disable automatic close-loop-recover summary session persistence')
    .option('--program-kpi-out <path>', 'Write recovery KPI snapshot JSON to file')
    .option('--program-audit-out <path>', 'Write recovery audit JSON with strategy and round history')
    .option('--continue-on-error', 'Continue processing remaining goals when one goal fails')
    .option('--out <path>', 'Write recovery summary JSON to file')
    .action(async (summaryCandidate, options) => {
      try {
        const projectPath = process.cwd();
        const summaryInput = typeof summaryCandidate === 'string' && summaryCandidate.trim()
          ? summaryCandidate.trim()
          : 'latest';
        const recoverAutonomousEnabled = options.batchAutonomous !== false;
        const resumeStrategy = normalizeResumeStrategy(options.resumeStrategy);
        const recoverUntilComplete = Boolean(options.recoverUntilComplete);
        const recoverMaxRounds = recoverUntilComplete
          ? normalizeRecoverMaxRounds(options.recoverMaxRounds)
          : 1;
        const recoverMaxMinutes = normalizeRecoverMaxMinutes(options.recoverMaxMinutes, '--recover-max-minutes');
        const recoveryStartedAt = Date.now();
        const programGatePolicy = resolveProgramGatePolicy({
          profile: options.programGateProfile,
          minSuccessRate: options.programMinSuccessRate,
          maxRiskLevel: options.programMaxRiskLevel,
          maxElapsedMinutes: options.programMaxElapsedMinutes,
          maxAgentBudget: options.programMaxAgentBudget,
          maxTotalSubSpecs: options.programMaxTotalSubSpecs
        });
        const gateFallbackProfile = normalizeProgramGateFallbackProfile(options.programGateFallbackProfile);
        const gateFallbackChain = resolveProgramGateFallbackChain(options.programGateFallbackChain, gateFallbackProfile);
        const recoveryMemoryTtlDays = normalizeRecoveryMemoryTtlDays(options.recoveryMemoryTtlDays);
        const recoveryMemoryScope = await resolveRecoveryMemoryScope(projectPath, options.recoveryMemoryScope);

        if (options.resume) {
          throw new Error('--resume is not supported in close-loop-recover. Recovery source is selected by [summary].');
        }
        if (options.sessionId) {
          throw new Error('--session-id is not supported in close-loop-recover. Session ids are generated per goal.');
        }
        if (
          options.recoverMaxRounds !== undefined &&
          options.recoverMaxRounds !== null &&
          !recoverUntilComplete
        ) {
          throw new Error('--recover-max-rounds requires --recover-until-complete.');
        }
        if (
          options.batchRetryMaxRounds !== undefined &&
          options.batchRetryMaxRounds !== null &&
          !options.batchRetryUntilComplete &&
          !recoverAutonomousEnabled
        ) {
          throw new Error('--batch-retry-max-rounds requires --batch-retry-until-complete.');
        }
        if (options.batchRetryMaxRounds !== undefined && options.batchRetryMaxRounds !== null) {
          normalizeBatchRetryMaxRounds(options.batchRetryMaxRounds);
        }
        if (options.batchSessionKeep !== undefined && options.batchSessionKeep !== null) {
          normalizeBatchSessionKeep(options.batchSessionKeep);
        }
        if (options.batchSessionOlderThanDays !== undefined && options.batchSessionOlderThanDays !== null) {
          normalizeBatchSessionOlderThanDays(options.batchSessionOlderThanDays);
        }
        if (options.specSessionKeep !== undefined && options.specSessionKeep !== null) {
          normalizeSpecKeep(options.specSessionKeep);
        }
        if (options.specSessionOlderThanDays !== undefined && options.specSessionOlderThanDays !== null) {
          normalizeOlderThanDays(options.specSessionOlderThanDays);
        }
        if (options.specSessionProtectWindowDays !== undefined && options.specSessionProtectWindowDays !== null) {
          normalizeSpecSessionProtectWindowDays(options.specSessionProtectWindowDays);
        }
        if (options.specSessionMaxTotal !== undefined && options.specSessionMaxTotal !== null) {
          normalizeSpecSessionMaxTotal(options.specSessionMaxTotal);
        }
        if (options.specSessionMaxCreated !== undefined && options.specSessionMaxCreated !== null) {
          normalizeSpecSessionMaxCreated(options.specSessionMaxCreated);
        }
        if (options.specSessionMaxCreatedPerGoal !== undefined && options.specSessionMaxCreatedPerGoal !== null) {
          normalizeSpecSessionMaxCreatedPerGoal(options.specSessionMaxCreatedPerGoal);
        }
        if (options.specSessionMaxDuplicateGoals !== undefined && options.specSessionMaxDuplicateGoals !== null) {
          normalizeSpecSessionMaxDuplicateGoals(options.specSessionMaxDuplicateGoals);
        }
        if (options.batchSessionId !== undefined && options.batchSessionId !== null) {
          const sanitizedBatchSessionId = sanitizeBatchSessionId(options.batchSessionId);
          if (!sanitizedBatchSessionId) {
            throw new Error('--batch-session-id is invalid after sanitization.');
          }
        }

        const sourceSummary = await loadCloseLoopBatchSummaryPayload(projectPath, summaryInput);
        const recoveryResult = await executeCloseLoopRecoveryCycle({
          projectPath,
          sourceSummary,
          baseOptions: options,
          recoverAutonomousEnabled,
          resumeStrategy,
          recoverUntilComplete,
          recoverMaxRounds,
          recoverMaxDurationMs: recoverMaxMinutes === null ? null : recoverMaxMinutes * 60 * 1000,
          recoveryMemoryTtlDays,
          recoveryMemoryScope,
          actionCandidate: options.useAction
        });
        const recoveryCompletedAt = Date.now();
        recoveryResult.summary.program_started_at = new Date(recoveryStartedAt).toISOString();
        recoveryResult.summary.program_completed_at = new Date(recoveryCompletedAt).toISOString();
        recoveryResult.summary.program_elapsed_ms = Math.max(0, recoveryCompletedAt - recoveryStartedAt);
        await applyProgramGateOutcome(recoveryResult.summary, {
          projectPath,
          options,
          programGatePolicy,
          gateFallbackChain,
          enableAutoRemediation: options.programGateAutoRemediate !== false
        });
        await maybeWriteProgramAudit(recoveryResult.summary, options.programAuditOut, projectPath);

        printCloseLoopBatchSummary(recoveryResult.summary, recoveryResult.options || options);

        if (
          recoveryResult.summary.status !== 'completed' ||
          !recoveryResult.summary.program_gate_effective.passed ||
          isSpecSessionBudgetHardFailure(recoveryResult.summary) ||
          isSpecSessionGrowthGuardHardFailure(recoveryResult.summary)
        ) {
          process.exit(1);
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  const autoBatchSession = auto
    .command('batch-session')
    .description('Manage close-loop-batch summary sessions');

  autoBatchSession
    .command('list')
    .description('List persisted close-loop-batch summary sessions')
    .option('--limit <n>', 'Maximum sessions to show (default: 20)', parseInt)
    .option('--status <statuses>', 'Filter by status token(s), comma-separated (case-insensitive)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await listCloseLoopBatchSummarySessions(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.total === 0) {
          console.log(chalk.gray('No close-loop-batch summary sessions found.'));
          return;
        }

        if (Array.isArray(result.status_filter) && result.status_filter.length > 0) {
          console.log(chalk.gray(`Status filter: ${result.status_filter.join(', ')}`));
        }
        console.log(chalk.blue(`Close-loop-batch summary sessions (${result.total}):`));
        if (result.status_counts && Object.keys(result.status_counts).length > 0) {
          console.log(chalk.gray(`  Status counts: ${JSON.stringify(result.status_counts)}`));
        }
        result.sessions.forEach(session => {
          const updated = session.updated_at || 'unknown-time';
          const status = session.status || 'unknown';
          console.log(chalk.gray(`- ${session.id} | ${status} | ${updated} | processed ${session.processed_goals}/${session.total_goals}`));
        });
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoBatchSession
    .command('stats')
    .description('Aggregate persisted close-loop-batch summary session telemetry')
    .option('--days <n>', 'Only include sessions updated within last N days', parseInt)
    .option('--status <statuses>', 'Filter by status token(s), comma-separated (case-insensitive)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await statsCloseLoopBatchSummarySessions(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.total_sessions === 0) {
          console.log(chalk.gray('No close-loop-batch summary sessions found for the selected stats filter.'));
          return;
        }

        console.log(chalk.blue('Close-loop-batch session stats:'));
        if (result.criteria.days !== null) {
          console.log(chalk.gray(`  Window days: ${result.criteria.days}`));
        }
        if (Array.isArray(result.criteria.status_filter) && result.criteria.status_filter.length > 0) {
          console.log(chalk.gray(`  Status filter: ${result.criteria.status_filter.join(', ')}`));
        }
        console.log(chalk.gray(`  Sessions: ${result.total_sessions}`));
        console.log(chalk.gray(`  Completion rate: ${result.completion_rate_percent}%`));
        console.log(chalk.gray(`  Failure rate: ${result.failure_rate_percent}%`));
        console.log(chalk.gray(`  Total goals sum: ${result.total_goals_sum}`));
        console.log(chalk.gray(`  Processed goals sum: ${result.processed_goals_sum}`));
        console.log(chalk.gray(`  Unprocessed goals sum: ${result.unprocessed_goals_sum}`));
        if (result.status_counts && Object.keys(result.status_counts).length > 0) {
          console.log(chalk.gray(`  Status counts: ${JSON.stringify(result.status_counts)}`));
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoBatchSession
    .command('prune')
    .description('Prune old close-loop-batch summary sessions by retention policy')
    .option('--keep <n>', 'Keep newest N sessions (default: 20)', parseInt)
    .option('--older-than-days <n>', 'Only prune sessions older than N days', parseInt)
    .option('--dry-run', 'Preview prune result without deleting files')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await pruneCloseLoopBatchSummarySessionsCli(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(chalk.blue('Close-loop-batch summary session prune summary:'));
        console.log(chalk.gray(`  Total: ${result.total_sessions}`));
        console.log(chalk.gray(`  Kept: ${result.kept_sessions}`));
        console.log(chalk.gray(`  Deleted: ${result.deleted_count}`));
        if (result.dry_run) {
          console.log(chalk.gray('  Mode: dry-run (no files deleted)'));
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  const autoControllerSession = auto
    .command('controller-session')
    .description('Manage close-loop-controller summary sessions');

  autoControllerSession
    .command('list')
    .description('List persisted close-loop-controller summary sessions')
    .option('--limit <n>', 'Maximum sessions to show (default: 20)', parseInt)
    .option('--status <statuses>', 'Filter by status token(s), comma-separated (case-insensitive)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await listCloseLoopControllerSessions(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.total === 0) {
          console.log(chalk.gray('No close-loop-controller summary sessions found.'));
          return;
        }

        if (Array.isArray(result.status_filter) && result.status_filter.length > 0) {
          console.log(chalk.gray(`Status filter: ${result.status_filter.join(', ')}`));
        }
        console.log(chalk.blue(`Close-loop-controller summary sessions (${result.total}):`));
        if (result.status_counts && Object.keys(result.status_counts).length > 0) {
          console.log(chalk.gray(`  Status counts: ${JSON.stringify(result.status_counts)}`));
        }
        result.sessions.forEach(session => {
          const updated = session.updated_at || 'unknown-time';
          const status = session.status || 'unknown';
          const processed = Number(session.processed_goals);
          const pending = Number(session.pending_goals);
          const processedDisplay = Number.isFinite(processed) ? processed : '?';
          const totalDisplay = (Number.isFinite(processed) && Number.isFinite(pending))
            ? processed + pending
            : '?';
          console.log(chalk.gray(`- ${session.id} | ${status} | ${updated} | processed ${processedDisplay}/${totalDisplay}`));
        });
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoControllerSession
    .command('stats')
    .description('Aggregate persisted close-loop-controller summary session telemetry')
    .option('--days <n>', 'Only include sessions updated within last N days', parseInt)
    .option('--status <statuses>', 'Filter by status token(s), comma-separated (case-insensitive)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await statsCloseLoopControllerSessions(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.total_sessions === 0) {
          console.log(chalk.gray('No close-loop-controller summary sessions found for the selected stats filter.'));
          return;
        }

        console.log(chalk.blue('Close-loop-controller session stats:'));
        if (result.criteria.days !== null) {
          console.log(chalk.gray(`  Window days: ${result.criteria.days}`));
        }
        if (Array.isArray(result.criteria.status_filter) && result.criteria.status_filter.length > 0) {
          console.log(chalk.gray(`  Status filter: ${result.criteria.status_filter.join(', ')}`));
        }
        console.log(chalk.gray(`  Sessions: ${result.total_sessions}`));
        console.log(chalk.gray(`  Completion rate: ${result.completion_rate_percent}%`));
        console.log(chalk.gray(`  Failure rate: ${result.failure_rate_percent}%`));
        console.log(chalk.gray(`  Processed goals sum: ${result.processed_goals_sum}`));
        console.log(chalk.gray(`  Pending goals sum: ${result.pending_goals_sum}`));
        if (result.status_counts && Object.keys(result.status_counts).length > 0) {
          console.log(chalk.gray(`  Status counts: ${JSON.stringify(result.status_counts)}`));
        }
        if (result.queue_format_counts && Object.keys(result.queue_format_counts).length > 0) {
          console.log(chalk.gray(`  Queue formats: ${JSON.stringify(result.queue_format_counts)}`));
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoControllerSession
    .command('prune')
    .description('Prune old close-loop-controller summary sessions by retention policy')
    .option('--keep <n>', 'Keep newest N sessions (default: 20)', parseInt)
    .option('--older-than-days <n>', 'Only prune sessions older than N days', parseInt)
    .option('--dry-run', 'Preview prune result without deleting files')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await pruneCloseLoopControllerSessionsCli(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(chalk.blue('Close-loop-controller summary session prune summary:'));
        console.log(chalk.gray(`  Total: ${result.total_sessions}`));
        console.log(chalk.gray(`  Kept: ${result.kept_sessions}`));
        console.log(chalk.gray(`  Deleted: ${result.deleted_count}`));
        if (result.dry_run) {
          console.log(chalk.gray('  Mode: dry-run (no files deleted)'));
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  // sce auto session
  const autoSession = auto
    .command('session')
    .description('Manage close-loop session snapshots');

  autoSession
    .command('list')
    .description('List persisted close-loop sessions')
    .option('--limit <n>', 'Maximum sessions to show (default: 20)', parseInt)
    .option('--status <statuses>', 'Filter by status token(s), comma-separated (case-insensitive)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await listCloseLoopSessions(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.total === 0) {
          console.log(chalk.gray('No close-loop sessions found.'));
          return;
        }

        if (Array.isArray(result.status_filter) && result.status_filter.length > 0) {
          console.log(chalk.gray(`Status filter: ${result.status_filter.join(', ')}`));
        }
        console.log(chalk.blue(`Close-loop sessions (${result.total}):`));
        if (result.status_counts && Object.keys(result.status_counts).length > 0) {
          console.log(chalk.gray(`  Status counts: ${JSON.stringify(result.status_counts)}`));
        }
        result.sessions.forEach(session => {
          const updated = session.updated_at || 'unknown-time';
          const master = session.master_spec || 'unknown-master';
          const status = session.status || 'unknown';
          console.log(chalk.gray(`- ${session.id} | ${status} | ${updated} | ${master}`));
        });
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoSession
    .command('stats')
    .description('Aggregate persisted close-loop session telemetry')
    .option('--days <n>', 'Only include sessions updated within last N days', parseInt)
    .option('--status <statuses>', 'Filter by status token(s), comma-separated (case-insensitive)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await statsCloseLoopSessions(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.total_sessions === 0) {
          console.log(chalk.gray('No close-loop sessions found for the selected stats filter.'));
          return;
        }

        console.log(chalk.blue('Close-loop session stats:'));
        if (result.criteria.days !== null) {
          console.log(chalk.gray(`  Window days: ${result.criteria.days}`));
        }
        if (Array.isArray(result.criteria.status_filter) && result.criteria.status_filter.length > 0) {
          console.log(chalk.gray(`  Status filter: ${result.criteria.status_filter.join(', ')}`));
        }
        console.log(chalk.gray(`  Sessions: ${result.total_sessions}`));
        console.log(chalk.gray(`  Completion rate: ${result.completion_rate_percent}%`));
        console.log(chalk.gray(`  Failure rate: ${result.failure_rate_percent}%`));
        console.log(chalk.gray(`  Sub-spec sum: ${result.sub_spec_count_sum}`));
        console.log(chalk.gray(`  Unique master specs: ${result.unique_master_spec_count}`));
        if (result.status_counts && Object.keys(result.status_counts).length > 0) {
          console.log(chalk.gray(`  Status counts: ${JSON.stringify(result.status_counts)}`));
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoSession
    .command('prune')
    .description('Prune old close-loop sessions by retention policy')
    .option('--keep <n>', 'Keep newest N sessions (default: 20)', parseInt)
    .option('--older-than-days <n>', 'Only prune sessions older than N days', parseInt)
    .option('--dry-run', 'Preview prune result without deleting files')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await pruneCloseLoopSessions(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(chalk.blue('Close-loop session prune summary:'));
        console.log(chalk.gray(`  Total: ${result.total_sessions}`));
        console.log(chalk.gray(`  Kept: ${result.kept_sessions}`));
        console.log(chalk.gray(`  Deleted: ${result.deleted_count}`));
        if (result.dry_run) {
          console.log(chalk.gray('  Mode: dry-run (no files deleted)'));
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  // sce auto spec-session
  const autoSpecSession = auto
    .command('spec-session')
    .description('Manage .sce/specs directory retention and cleanup');

  autoSpecSession
    .command('list')
    .description('List persisted spec directories under .sce/specs')
    .option('--limit <n>', 'Maximum specs to show (default: 20)', parseInt)
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await listSpecSessions(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.total === 0) {
          console.log(chalk.gray('No spec directories found.'));
          return;
        }

        console.log(chalk.blue(`Spec directories (${result.total}):`));
        result.specs.forEach(spec => {
          const updated = spec.updated_at || 'unknown-time';
          console.log(chalk.gray(`- ${spec.id} | ${updated} | ${spec.file}`));
        });
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoSpecSession
    .command('prune')
    .description('Prune old spec directories by retention policy')
    .option('--keep <n>', 'Keep newest N spec directories (default: 200)', parseInt)
    .option('--older-than-days <n>', 'Only prune spec directories older than N days', parseInt)
    .option('--no-protect-active', 'Allow pruning directories even when they appear active')
    .option('--protect-window-days <n>', 'Protection window (days) for recent session references (default: 7)', parseInt)
    .option('--show-protection-reasons', 'Include per-spec protection reason details in output')
    .option('--dry-run', 'Preview prune result without deleting directories')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await pruneSpecSessions(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(chalk.blue('Spec directory prune summary:'));
        console.log(chalk.gray(`  Total: ${result.total_specs}`));
        console.log(chalk.gray(`  Kept: ${result.kept_specs}`));
        console.log(chalk.gray(`  Deleted: ${result.deleted_count}`));
        if (result.protected_count > 0) {
          console.log(chalk.gray(`  Protected: ${result.protected_count}`));
        }
        if (result.dry_run) {
          console.log(chalk.gray('  Mode: dry-run (no directories deleted)'));
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  const autoKpi = auto
    .command('kpi')
    .description('Inspect autonomous execution KPI snapshots and trends');

  autoKpi
    .command('trend')
    .description('Aggregate periodic KPI trend from persisted batch/program/recover/controller summaries')
    .option('--weeks <n>', 'Number of recent weeks to include (default: 8)', parseInt)
    .option('--mode <mode>', 'Summary mode filter: all|batch|program|recover|controller (default: all)', 'all')
    .option('--period <period>', 'Bucket period: week|day (default: week)', 'week')
    .option('--csv', 'Output trend buckets as CSV (stdout and --out file)')
    .option('--out <path>', 'Write KPI trend output to file (JSON default, CSV when --csv)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await buildAutoKpiTrend(process.cwd(), options);
        if (options.out) {
          if (options.csv && !options.json) {
            const csv = formatAutoKpiTrendCsv(result);
            await maybeWriteTextOutput(result, csv, options.out, process.cwd());
          } else {
            await maybeWriteOutput(result, options.out, process.cwd());
          }
        }
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (options.csv) {
          console.log(formatAutoKpiTrendCsv(result));
          return;
        }

        console.log(chalk.blue('Autonomous KPI trend summary:'));
        console.log(chalk.gray(`  Weeks: ${result.weeks}`));
        console.log(chalk.gray(`  Period: ${result.period_unit}`));
        console.log(chalk.gray(`  Mode: ${result.mode}`));
        console.log(chalk.gray(`  Runs analyzed: ${result.total_runs}`));
        console.log(chalk.gray(`  Overall success rate: ${result.overall.success_rate_percent}%`));
        console.log(chalk.gray(`  Anomalies detected: ${result.anomalies.length}`));
        if (result.trend.length > 0) {
          console.log(chalk.gray('  Trend buckets:'));
          result.trend.forEach(item => {
            console.log(chalk.gray(
              `    - ${item.period}: runs=${item.runs}, success=${item.success_rate_percent}%`
            ));
          });
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  const autoObservability = auto
    .command('observability')
    .description('Build unified autonomous observability snapshots across archives and trends');

  autoObservability
    .command('snapshot')
    .description('Generate one unified observability snapshot for sessions, governance, and KPI trend')
    .option('--days <n>', 'Only include sessions updated within last N days', parseInt)
    .option('--status <statuses>', 'Filter session status token(s), comma-separated (case-insensitive)')
    .option('--weeks <n>', 'Number of recent weeks to include in KPI trend (default: 8)', parseInt)
    .option('--trend-mode <mode>', 'Trend mode: all|batch|program|recover|controller (default: all)', 'all')
    .option('--trend-period <period>', 'Trend period: week|day (default: week)', 'week')
    .option('--out <path>', 'Write observability snapshot JSON to file')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await buildAutoObservabilitySnapshot(process.cwd(), options);
        if (options.out) {
          await maybeWriteOutput(result, options.out, process.cwd());
        }
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.blue('Autonomous observability snapshot:'));
        if (result.criteria.days !== null) {
          console.log(chalk.gray(`  Window days: ${result.criteria.days}`));
        }
        if (Array.isArray(result.criteria.status_filter) && result.criteria.status_filter.length > 0) {
          console.log(chalk.gray(`  Status filter: ${result.criteria.status_filter.join(', ')}`));
        }
        console.log(chalk.gray(`  Session total: ${result.highlights.total_sessions}`));
        console.log(chalk.gray(`  Completion rate: ${result.highlights.completion_rate_percent}%`));
        console.log(chalk.gray(`  Failure rate: ${result.highlights.failure_rate_percent}%`));
        console.log(chalk.gray(`  Governance risk: ${result.highlights.governance_risk_level}`));
        console.log(chalk.gray(`  Trend anomalies: ${result.highlights.kpi_anomaly_count}`));
        if (result.output_file) {
          console.log(chalk.gray(`  Output: ${result.output_file}`));
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  const autoSpec = auto
    .command('spec')
    .description('Agent-facing spec status and execution instruction interfaces');

  autoSpec
    .command('status <spec-name>')
    .description('Show structured status for one spec directory')
    .option('--json', 'Output machine-readable JSON')
    .action(async (specName, options) => {
      try {
        const result = await buildAutoSpecStatus(process.cwd(), specName);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.blue(`Spec status: ${result.spec.name}`));
        console.log(chalk.gray(`  Path: ${result.spec.path}`));
        console.log(chalk.gray(`  Collaboration status: ${result.collaboration.status}`));
        console.log(chalk.gray(`  Docs complete: ${result.docs.all_required_present ? 'yes' : 'no'}`));
        console.log(chalk.gray(
          `  Task progress: ${result.task_progress.closed}/${result.task_progress.total} (${result.task_progress.completion_rate_percent}%)`
        ));
        if (result.health.blockers.length > 0) {
          console.log(chalk.gray(`  Blockers: ${result.health.blockers.join(' | ')}`));
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoSpec
    .command('instructions <spec-name>')
    .description('Generate execution instructions for one spec (agent-oriented)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (specName, options) => {
      try {
        const result = await buildAutoSpecInstructions(process.cwd(), specName);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.blue(`Spec instructions: ${result.spec.name}`));
        result.instructions.next_actions.forEach((item, index) => {
          console.log(chalk.gray(`  ${index + 1}. ${item}`));
        });
        if (result.instructions.priority_open_tasks.length > 0) {
          console.log(chalk.gray('  Priority open tasks:'));
          result.instructions.priority_open_tasks.slice(0, 5).forEach(item => {
            console.log(chalk.gray(`    - ${item}`));
          });
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  const autoHandoff = auto
    .command('handoff')
    .description('Plan and stage dual-track handoff integration workflows');

  autoHandoff
    .command('plan')
    .description('Build an executable sce integration plan from a handoff manifest JSON')
    .requiredOption('--manifest <path>', 'Path to handoff-manifest.json')
    .option('--out <path>', 'Write generated integration plan JSON to file')
    .option('--strict', 'Fail when manifest validation contains errors')
    .option('--strict-warnings', 'Fail when manifest validation contains warnings')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await buildAutoHandoffPlan(process.cwd(), options);
        if (options.out) {
          await maybeWriteOutput(result, options.out, process.cwd());
        }
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.blue('Auto handoff integration plan:'));
        console.log(chalk.gray(`  Manifest: ${result.manifest_path}`));
        console.log(chalk.gray(`  Source project: ${result.source_project || 'unknown'}`));
        console.log(chalk.gray(`  Specs: ${result.handoff.spec_count}`));
        console.log(chalk.gray(`  Templates: ${result.handoff.template_count}`));
        console.log(chalk.gray(`  Validation errors: ${result.validation.errors.length}`));
        console.log(chalk.gray(`  Validation warnings: ${result.validation.warnings.length}`));
        console.log(chalk.gray(`  Phases: ${result.phases.length}`));
        if (result.output_file) {
          console.log(chalk.gray(`  Output: ${result.output_file}`));
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoHandoff
    .command('queue')
    .description('Generate close-loop queue goals from a handoff manifest JSON')
    .requiredOption('--manifest <path>', 'Path to handoff-manifest.json')
    .option('--out <path>', `Queue output file (default: ${AUTO_HANDOFF_DEFAULT_QUEUE_FILE})`, AUTO_HANDOFF_DEFAULT_QUEUE_FILE)
    .option('--append', 'Append generated goals to existing queue file')
    .option('--no-include-known-gaps', 'Exclude known_gaps entries from generated queue goals')
    .option('--dry-run', 'Preview generated queue goals without writing file')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await buildAutoHandoffQueue(process.cwd(), options);
        if (!result.dry_run) {
          await writeAutoHandoffQueueFile(process.cwd(), result, options);
        }
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.blue('Auto handoff queue generated:'));
        console.log(chalk.gray(`  Manifest: ${result.manifest_path}`));
        console.log(chalk.gray(`  Goals: ${result.goal_count}`));
        console.log(chalk.gray(`  Include known gaps: ${result.include_known_gaps ? 'yes' : 'no'}`));
        console.log(chalk.gray(`  Mode: ${result.dry_run ? 'dry-run' : (result.append ? 'append' : 'overwrite')}`));
        if (result.output_file) {
          console.log(chalk.gray(`  Queue file: ${result.output_file}`));
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoHandoff
    .command('template-diff')
    .description('Compare manifest templates with local template registry and exports')
    .requiredOption('--manifest <path>', 'Path to handoff-manifest.json')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await buildAutoHandoffTemplateDiff(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.blue('Auto handoff template diff:'));
        console.log(chalk.gray(`  Manifest templates: ${result.manifest.template_count}`));
        console.log(chalk.gray(`  Local templates: ${result.local.template_count}`));
        console.log(chalk.gray(`  Missing in local: ${result.diff.missing_in_local.length}`));
        console.log(chalk.gray(`  Extra in local: ${result.diff.extra_in_local.length}`));
        console.log(chalk.gray(`  Compatibility: ${result.compatibility}`));
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoHandoff
    .command('capability-matrix')
    .description('Build Moqui template capability matrix from handoff manifest and local template library')
    .requiredOption('--manifest <path>', 'Path to handoff-manifest.json')
    .option('--profile <profile>', 'Handoff policy profile: default|moqui|enterprise (default: default)', 'default')
    .option('--strict', 'Fail when manifest validation contains errors')
    .option('--strict-warnings', 'Fail when manifest validation contains warnings')
    .option('--min-capability-coverage <n>', 'Minimum Moqui capability coverage percent (default: 100)', parseFloat)
    .option('--min-capability-semantic <n>', 'Minimum Moqui capability semantic completeness percent (default: 100)', parseFloat)
    .option('--require-capability-semantic', 'Require capability semantic completeness gate (default: enabled)')
    .option('--no-require-capability-semantic', 'Disable capability semantic completeness gate (not recommended)')
    .option('--require-capability-lexicon', 'Require capability lexicon normalization gate (default: enabled)')
    .option('--no-require-capability-lexicon', 'Disable capability lexicon normalization gate (not recommended)')
    .option('--format <type>', 'Matrix report format: json|markdown (default: json)', 'json')
    .option('--out <path>', 'Write matrix report output file')
    .option('--remediation-queue-out <path>', `Write remediation queue lines (default: ${AUTO_HANDOFF_MOQUI_REMEDIATION_QUEUE_FILE})`, AUTO_HANDOFF_MOQUI_REMEDIATION_QUEUE_FILE)
    .option('--fail-on-gap', 'Exit non-zero when matrix gate is not passed')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const projectPath = process.cwd();
        const outputFormat = normalizeHandoffRegressionFormat(options.format);
        const result = await buildAutoHandoffCapabilityMatrix(projectPath, options);
        result.report_format = outputFormat;
        if (options.out) {
          if (outputFormat === 'markdown') {
            const markdown = renderAutoHandoffCapabilityMatrixMarkdown(result);
            await maybeWriteTextOutput(result, markdown, options.out, projectPath);
          } else {
            await maybeWriteOutput(result, options.out, projectPath);
          }
        }
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (outputFormat === 'markdown') {
          console.log(renderAutoHandoffCapabilityMatrixMarkdown(result));
        } else {
          console.log(chalk.blue('Auto handoff capability matrix:'));
          console.log(chalk.gray(`  Status: ${result.status}`));
          console.log(chalk.gray(`  Manifest: ${result.manifest_path}`));
          console.log(chalk.gray(`  Policy profile: ${result.policy && result.policy.profile ? result.policy.profile : 'default'}`));
          console.log(chalk.gray(`  Capabilities: ${result.handoff.capability_count}`));
          if (result.capability_coverage && result.capability_coverage.summary) {
            const summary = result.capability_coverage.summary;
            const coverageText = Number.isFinite(Number(summary.coverage_percent))
              ? `${summary.coverage_percent}%`
              : 'n/a';
            const semanticText = Number.isFinite(Number(summary.semantic_complete_percent))
              ? `${summary.semantic_complete_percent}%`
              : 'n/a';
            console.log(chalk.gray(
              `  Coverage: ${coverageText} (${summary.covered_capabilities}/${summary.total_capabilities})`
            ));
            console.log(chalk.gray(
              `  Semantic: ${semanticText} (${summary.semantic_complete_capabilities}/${summary.total_capabilities})`
            ));
          }
          console.log(chalk.gray(`  Gate passed: ${result.gates.passed ? 'yes' : 'no'}`));
          console.log(chalk.gray(`  Template sync: ${result.template_diff.compatibility}`));
          if (result.gates && result.gates.capability_semantic) {
            console.log(chalk.gray(`  Semantic gate: ${result.gates.capability_semantic.passed ? 'pass' : 'fail'}`));
          }
          if (result.gates && result.gates.capability_lexicon) {
            console.log(chalk.gray(`  Lexicon gate: ${result.gates.capability_lexicon.passed ? 'pass' : 'fail'}`));
          }
          if (result.remediation_queue && result.remediation_queue.file) {
            console.log(chalk.gray(`  Remediation queue: ${result.remediation_queue.file} (${result.remediation_queue.goal_count})`));
          }
          if (result.output_file) {
            console.log(chalk.gray(`  Output: ${result.output_file}`));
          }
        }
        if (options.failOnGap && result.gates && result.gates.passed === false) {
          process.exit(1);
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoHandoff
    .command('regression')
    .description('Compare one handoff run report with its previous run')
    .option('--session-id <id|latest>', 'Handoff run session id or "latest"', 'latest')
    .option('--window <n>', 'Number of runs in regression trend window (default: 2)', value => parseInt(value, 10), 2)
    .option('--format <type>', 'Regression report format: json|markdown (default: json)', 'json')
    .option('--out <path>', 'Write regression report JSON to file')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const outputFormat = normalizeHandoffRegressionFormat(options.format);
        const result = await buildAutoHandoffRegressionReport(process.cwd(), options);
        result.report_format = outputFormat;
        if (options.out) {
          if (outputFormat === 'markdown') {
            const markdown = renderAutoHandoffRegressionMarkdown(result);
            await maybeWriteTextOutput(result, markdown, options.out, process.cwd());
          } else {
            await maybeWriteOutput(result, options.out, process.cwd());
          }
        }
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (outputFormat === 'markdown') {
          console.log(renderAutoHandoffRegressionMarkdown(result));
          return;
        }
        console.log(chalk.blue('Auto handoff regression:'));
        console.log(chalk.gray(`  Session: ${result.current.session_id}`));
        console.log(chalk.gray(`  Compared to: ${result.previous ? result.previous.session_id : 'none'}`));
        if (result.window) {
          console.log(chalk.gray(`  Window: ${result.window.actual}/${result.window.requested}`));
        }
        console.log(chalk.gray(`  Trend: ${result.trend}`));
        console.log(chalk.gray(`  Success-rate delta: ${result.delta.spec_success_rate_percent}`));
        console.log(chalk.gray(`  Risk-level delta: ${result.delta.risk_level_rank}`));
        if (result.output_file) {
          console.log(chalk.gray(`  Output: ${result.output_file}`));
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoHandoff
    .command('evidence')
    .description('Review merged handoff release evidence snapshot and current session overview')
    .option('--file <path>', `Release evidence file path (default: ${AUTO_HANDOFF_RELEASE_EVIDENCE_FILE})`, AUTO_HANDOFF_RELEASE_EVIDENCE_FILE)
    .option('--session-id <id|latest>', 'Session id to inspect from release evidence', 'latest')
    .option('--window <n>', 'Number of sessions in review window (default: 5)', value => parseInt(value, 10), 5)
    .option('--format <type>', 'Evidence report format: json|markdown (default: json)', 'json')
    .option('--out <path>', 'Write evidence review report to file')
    .option('--review-out <path>', `Write evidence review markdown for release drafting (default: ${AUTO_HANDOFF_EVIDENCE_REVIEW_DEFAULT_FILE})`)
    .option('--release-draft <path>', 'Write release notes draft markdown with handoff evidence summary')
    .option('--release-version <version>', 'Release version tag for release draft (default: v<package.json version>)')
    .option('--release-date <yyyy-mm-dd>', 'Release date for release draft (default: today UTC)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const projectPath = process.cwd();
        const outputFormat = normalizeHandoffRegressionFormat(options.format);
        const result = await buildAutoHandoffEvidenceReviewReport(projectPath, options);
        result.report_format = outputFormat;
        const reviewMarkdown = renderAutoHandoffEvidenceReviewMarkdown(result);
        if (options.out) {
          if (outputFormat === 'markdown') {
            await maybeWriteTextOutput(result, reviewMarkdown, options.out, projectPath);
          } else {
            await maybeWriteOutput(result, options.out, projectPath);
          }
        }
        if (typeof options.releaseDraft === 'string' && options.releaseDraft.trim()) {
          const reviewOutCandidate = typeof options.reviewOut === 'string' && options.reviewOut.trim()
            ? options.reviewOut.trim()
            : (
              outputFormat === 'markdown' && typeof options.out === 'string' && options.out.trim()
                ? options.out.trim()
                : AUTO_HANDOFF_EVIDENCE_REVIEW_DEFAULT_FILE
            );
          const reviewOutFile = path.isAbsolute(reviewOutCandidate)
            ? reviewOutCandidate
            : path.join(projectPath, reviewOutCandidate);
          await fs.ensureDir(path.dirname(reviewOutFile));
          await fs.writeFile(reviewOutFile, reviewMarkdown, 'utf8');

          const releaseDraftContext = await resolveAutoHandoffReleaseDraftContext(projectPath, options);
          const releaseMarkdown = renderAutoHandoffReleaseNotesDraft(result, {
            version: releaseDraftContext.version,
            releaseDate: releaseDraftContext.releaseDate,
            reviewFile: reviewOutFile
          });
          const releaseDraftCandidate = options.releaseDraft.trim();
          const releaseDraftFile = path.isAbsolute(releaseDraftCandidate)
            ? releaseDraftCandidate
            : path.join(projectPath, releaseDraftCandidate);
          await fs.ensureDir(path.dirname(releaseDraftFile));
          await fs.writeFile(releaseDraftFile, releaseMarkdown, 'utf8');
          result.release_draft = {
            file: releaseDraftFile,
            version: releaseDraftContext.version,
            release_date: releaseDraftContext.releaseDate,
            review_file: reviewOutFile
          };
        }
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (outputFormat === 'markdown') {
          console.log(renderAutoHandoffEvidenceReviewMarkdown(result));
          return;
        }
        console.log(chalk.blue('Auto handoff release evidence review:'));
        console.log(chalk.gray(`  Evidence file: ${result.evidence_file}`));
        console.log(chalk.gray(`  Session: ${result.current && result.current.session_id ? result.current.session_id : 'n/a'}`));
        console.log(chalk.gray(`  Status: ${result.current && result.current.status ? result.current.status : 'n/a'}`));
        console.log(chalk.gray(`  Trend: ${result.trend}`));
        if (result.window) {
          console.log(chalk.gray(`  Window: ${result.window.actual}/${result.window.requested}`));
        }
        if (result.current_overview && result.current_overview.gate) {
          console.log(chalk.gray(`  Gate passed: ${result.current_overview.gate.passed ? 'yes' : 'no'}`));
        }
        if (result.current_overview && result.current_overview.moqui_baseline) {
          const moquiBaseline = result.current_overview.moqui_baseline;
          const moquiSummary = moquiBaseline && moquiBaseline.summary ? moquiBaseline.summary : null;
          console.log(chalk.gray(`  Moqui baseline: ${moquiBaseline.status || 'n/a'}`));
          if (moquiSummary) {
            const scoreText = Number.isFinite(Number(moquiSummary.avg_score))
              ? `${moquiSummary.avg_score}`
              : 'n/a';
            const validRateText = Number.isFinite(Number(moquiSummary.valid_rate_percent))
              ? `${moquiSummary.valid_rate_percent}%`
              : 'n/a';
            console.log(chalk.gray(`    Portfolio: ${moquiSummary.portfolio_passed === true ? 'pass' : 'fail'} | avg=${scoreText} | valid-rate=${validRateText}`));
            const entityRateText = formatAutoHandoffMoquiCoverageMetric(moquiSummary, 'entity_coverage', 'rate_percent', '%');
            const ruleClosedRateText = formatAutoHandoffMoquiCoverageMetric(moquiSummary, 'business_rule_closed', 'rate_percent', '%');
            const decisionClosedRateText = formatAutoHandoffMoquiCoverageMetric(moquiSummary, 'decision_closed', 'rate_percent', '%');
            console.log(chalk.gray(`    Coverage: entity=${entityRateText} | rule-closed=${ruleClosedRateText} | decision-closed=${decisionClosedRateText}`));
            const regressionText = formatAutoHandoffMoquiCoverageRegressions(
              moquiBaseline && moquiBaseline.compare ? moquiBaseline.compare : {},
              3
            );
            console.log(chalk.gray(`    Regressions: ${regressionText}`));
          }
        }
        if (result.current_overview && result.current_overview.scene_package_batch) {
          const scenePackageBatch = result.current_overview.scene_package_batch;
          const sceneSummary = scenePackageBatch && scenePackageBatch.summary ? scenePackageBatch.summary : null;
          console.log(chalk.gray(`  Scene package batch: ${scenePackageBatch.status || 'n/a'}`));
          if (sceneSummary) {
            console.log(
              chalk.gray(
                `    Selected: ${sceneSummary.selected || 0} | ` +
                `failed=${sceneSummary.failed || 0} | ` +
                `batch-gate=${sceneSummary.batch_gate_passed === true ? 'pass' : 'fail'}`
              )
            );
          }
        }
        if (result.current_overview && result.current_overview.capability_coverage) {
          const capabilityCoverage = result.current_overview.capability_coverage;
          const capabilitySummary = capabilityCoverage && capabilityCoverage.summary ? capabilityCoverage.summary : null;
          console.log(chalk.gray(`  Capability coverage: ${capabilityCoverage.status || 'n/a'}`));
          if (capabilitySummary) {
            const coverageText = Number.isFinite(Number(capabilitySummary.coverage_percent))
              ? `${capabilitySummary.coverage_percent}%`
              : 'n/a';
            console.log(
              chalk.gray(
                `    Passed: ${capabilitySummary.passed === true ? 'yes' : 'no'} | ` +
                `coverage=${coverageText} | min=${capabilitySummary.min_required_percent}%`
              )
            );
          }
        }
        if (result.output_file) {
          console.log(chalk.gray(`  Output: ${result.output_file}`));
        }
        if (result.release_draft && result.release_draft.file) {
          console.log(chalk.gray(`  Release draft: ${result.release_draft.file}`));
          console.log(chalk.gray(`  Review markdown: ${result.release_draft.review_file}`));
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoHandoff
    .command('gate-index')
    .description('Build release gate history index from release-gate reports')
    .option('--dir <path>', `Directory containing release-gate-*.json files (default: ${AUTO_HANDOFF_RELEASE_EVIDENCE_DIR})`, AUTO_HANDOFF_RELEASE_EVIDENCE_DIR)
    .option('--history-file <path>', 'Optional existing history index JSON to merge')
    .option('--keep <n>', 'Keep latest N entries in index (default: 200)', value => parseInt(value, 10), 200)
    .option('--out <path>', `Write gate history index JSON to file (default: ${AUTO_HANDOFF_RELEASE_GATE_HISTORY_FILE})`, AUTO_HANDOFF_RELEASE_GATE_HISTORY_FILE)
    .option('--markdown-out <path>', 'Write human-readable gate history markdown summary')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const projectPath = process.cwd();
        const result = await buildAutoHandoffReleaseGateHistoryIndex(projectPath, options);
        await maybeWriteOutput(result, options.out, projectPath);
        if (typeof options.markdownOut === 'string' && options.markdownOut.trim()) {
          const markdownPath = path.isAbsolute(options.markdownOut.trim())
            ? options.markdownOut.trim()
            : path.join(projectPath, options.markdownOut.trim());
          await fs.ensureDir(path.dirname(markdownPath));
          await fs.writeFile(markdownPath, renderAutoHandoffReleaseGateHistoryMarkdown(result), 'utf8');
          result.markdown_file = markdownPath;
        }
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.blue('Auto handoff release gate history index:'));
        console.log(chalk.gray(`  Source dir: ${result.source_dir}`));
        console.log(chalk.gray(`  Entries: ${result.total_entries}`));
        if (result.latest) {
          console.log(chalk.gray(`  Latest: ${result.latest.tag || 'n/a'} (${result.latest.evaluated_at || 'n/a'})`));
          console.log(chalk.gray(`  Latest gate passed: ${result.latest.gate_passed === true ? 'yes' : (result.latest.gate_passed === false ? 'no' : 'n/a')}`));
        }
        if (result.aggregates) {
          console.log(chalk.gray(`  Gate pass rate: ${formatAutoHandoffRegressionValue(result.aggregates.pass_rate_percent)}%`));
          console.log(chalk.gray(`  Failed gates: ${result.aggregates.gate_failed_count}`));
        }
        if (result.warnings_count > 0) {
          console.log(chalk.yellow(`  Warnings: ${result.warnings_count}`));
        }
        if (result.output_file) {
          console.log(chalk.gray(`  Output: ${result.output_file}`));
        }
        if (result.markdown_file) {
          console.log(chalk.gray(`  Markdown: ${result.markdown_file}`));
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoHandoff
    .command('preflight-check')
    .description('Evaluate release-gate preflight readiness from gate-history signals')
    .option('--profile <profile>', 'Handoff policy profile: default|moqui|enterprise (default: default)', 'default')
    .option('--history-file <path>', `Release gate history file (default: ${AUTO_HANDOFF_RELEASE_GATE_HISTORY_FILE})`)
    .option('--require-release-gate-preflight', 'Gate: require release-gate preflight signal to be available and unblocked (default: enabled)')
    .option('--no-require-release-gate-preflight', 'Gate: disable release-gate preflight hard requirement (not recommended)')
    .option('--release-evidence-window <n>', 'Release evidence trend window size (2-50, default from profile)', parseInt)
    .option('--require-pass', 'Exit non-zero when preflight status is not pass')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await buildAutoHandoffPreflightCheck(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(chalk.blue('Auto handoff preflight check:'));
          console.log(chalk.gray(`  Status: ${result.status}`));
          console.log(chalk.gray(`  Profile: ${result.policy.profile}`));
          console.log(chalk.gray(`  Hard-gate preflight: ${result.policy.require_release_gate_preflight ? 'enabled' : 'advisory'}`));
          console.log(chalk.gray(`  History file: ${result.release_gate_preflight.file || 'n/a'}`));
          console.log(chalk.gray(`  Preflight available: ${result.release_gate_preflight.available === true ? 'yes' : 'no'}`));
          console.log(chalk.gray(`  Preflight blocked: ${result.release_gate_preflight.blocked === true ? 'yes' : 'no'}`));
          if (result.release_gate_preflight.latest_tag) {
            console.log(chalk.gray(`  Latest tag: ${result.release_gate_preflight.latest_tag}`));
          }
          if (
            Number.isFinite(Number(result.release_gate_preflight.latest_weekly_ops_runtime_block_rate_percent)) ||
            Number.isFinite(Number(result.release_gate_preflight.latest_weekly_ops_runtime_ui_mode_violation_total))
          ) {
            const runtimeBlockRateText = Number.isFinite(Number(result.release_gate_preflight.latest_weekly_ops_runtime_block_rate_percent))
              ? `${result.release_gate_preflight.latest_weekly_ops_runtime_block_rate_percent}%`
              : 'n/a';
            const runtimeUiModeTotalText = Number.isFinite(Number(result.release_gate_preflight.latest_weekly_ops_runtime_ui_mode_violation_total))
              ? `${result.release_gate_preflight.latest_weekly_ops_runtime_ui_mode_violation_total}`
              : 'n/a';
            const runtimeUiModeRateText = Number.isFinite(Number(result.release_gate_preflight.latest_weekly_ops_runtime_ui_mode_violation_rate_percent))
              ? `${result.release_gate_preflight.latest_weekly_ops_runtime_ui_mode_violation_rate_percent}%`
              : 'n/a';
            console.log(
              chalk.gray(
                `  Runtime pressure (latest): block-rate=${runtimeBlockRateText} | ui-mode=${runtimeUiModeTotalText}/${runtimeUiModeRateText}`
              )
            );
          }
          if (Array.isArray(result.reasons) && result.reasons.length > 0) {
            console.log(chalk.gray('  Reasons:'));
            result.reasons.forEach(item => {
              console.log(chalk.gray(`    - ${item}`));
            });
          }
          if (Array.isArray(result.recommended_commands) && result.recommended_commands.length > 0) {
            console.log(chalk.gray('  Recommended commands:'));
            result.recommended_commands.slice(0, 5).forEach(item => {
              console.log(chalk.gray(`    - ${item}`));
            });
          }
        }
        if (options.requirePass && result.status !== 'pass') {
          process.exit(1);
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoHandoff
    .command('run')
    .description('Execute handoff integration pipeline: plan -> queue -> close-loop-batch -> observability')
    .requiredOption('--manifest <path>', 'Path to handoff-manifest.json')
    .option('--profile <profile>', 'Handoff policy profile: default|moqui|enterprise (default: default)', 'default')
    .option('--out <path>', 'Write handoff run report JSON to file')
    .option('--queue-out <path>', `Queue output file (default: ${AUTO_HANDOFF_DEFAULT_QUEUE_FILE})`, AUTO_HANDOFF_DEFAULT_QUEUE_FILE)
    .option('--append', 'Append generated goals to existing queue file')
    .option('--no-include-known-gaps', 'Exclude known_gaps entries from generated queue goals')
    .option('--continue-from <session|latest|file>', 'Continue pending goals from prior handoff run report')
    .option('--continue-strategy <strategy>', 'Resume strategy for --continue-from: auto|pending|failed-only (default: auto)', 'auto')
    .option('--dry-run', 'Preview execution plan and queue without running close-loop-batch')
    .option('--strict', 'Fail when manifest validation contains errors')
    .option('--strict-warnings', 'Fail when manifest validation contains warnings')
    .option('--no-dependency-batching', 'Disable dependency-aware spec execution batches')
    .option('--no-batch-autonomous', 'Disable autonomous batch policy during handoff close-loop execution')
    .option('--no-continue-on-error', 'Stop handoff close-loop-batch on first failed goal')
    .option('--batch-parallel <n>', 'Maximum concurrent goals during close-loop-batch', parseInt)
    .option('--batch-agent-budget <n>', 'Shared parallel-agent budget for close-loop-batch', parseInt)
    .option('--batch-retry-rounds <n>', 'Retry failed goals for N rounds during close-loop-batch', parseInt)
    .option('--batch-retry-until-complete', 'Retry until all goals complete or retry max is reached')
    .option('--batch-retry-max-rounds <n>', 'Max retry rounds when --batch-retry-until-complete is enabled', parseInt)
    .option('--min-spec-success-rate <n>', 'Gate: minimum handoff spec success rate percent (default: 100)', parseFloat)
    .option('--max-risk-level <level>', 'Gate: maximum allowed risk level (low|medium|high)')
    .option('--min-ontology-score <n>', 'Gate: minimum ontology quality score (0-100, default: 0)', parseFloat)
    .option('--max-unmapped-rules <n>', 'Gate: maximum allowed unmapped business rules (optional)', parseInt)
    .option('--max-undecided-decisions <n>', 'Gate: maximum allowed undecided decisions (optional)', parseInt)
    .option('--require-ontology-validation', 'Gate: require manifest ontology_validation to be present and passed (default: enabled)')
    .option('--no-require-ontology-validation', 'Gate: disable manifest ontology_validation requirement (not recommended)')
    .option('--require-moqui-baseline', 'Gate: require Moqui baseline portfolio to pass (default: enabled)')
    .option('--no-require-moqui-baseline', 'Gate: disable Moqui baseline portfolio requirement (not recommended)')
    .option('--max-moqui-matrix-regressions <n>', 'Gate: maximum allowed Moqui matrix regression signals (default: 0)', parseInt)
    .option('--require-scene-package-batch', 'Gate: require scene package publish-batch dry-run gate to pass when applicable (default: enabled)')
    .option('--no-require-scene-package-batch', 'Gate: disable scene package publish-batch dry-run requirement (not recommended)')
    .option('--min-capability-coverage <n>', 'Gate: minimum Moqui capability coverage percent (default: 100)', parseFloat)
    .option('--require-capability-coverage', 'Gate: require capability coverage threshold when capabilities are declared (default: enabled)')
    .option('--no-require-capability-coverage', 'Gate: disable capability coverage requirement (not recommended)')
    .option('--require-capability-lexicon', 'Gate: require capability lexicon normalization (unknown expected/provided aliases not allowed, default: enabled)')
    .option('--no-require-capability-lexicon', 'Gate: disable capability lexicon normalization requirement (not recommended)')
    .option('--require-release-gate-preflight', 'Gate: require release-gate preflight signal to be available and unblocked (default: enabled)')
    .option('--no-require-release-gate-preflight', 'Gate: disable release-gate preflight hard requirement (not recommended)')
    .option('--release-evidence-window <n>', 'Release evidence trend window size (2-50, default: 5)', parseInt)
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await runAutoHandoff(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(chalk.blue('Auto handoff run:'));
          console.log(chalk.gray(`  Session: ${result.session_id}`));
          console.log(chalk.gray(`  Status: ${result.status}`));
          console.log(chalk.gray(`  Manifest: ${result.manifest_path}`));
          console.log(chalk.gray(`  Policy profile: ${result.policy && result.policy.profile ? result.policy.profile : 'default'}`));
          console.log(chalk.gray(`  Specs: ${result.handoff && result.handoff.spec_count ? result.handoff.spec_count : 0}`));
          console.log(chalk.gray(`  Queue goals: ${result.queue && result.queue.goal_count ? result.queue.goal_count : 0}`));
          if (result.template_diff) {
            console.log(chalk.gray(`  Template compatibility: ${result.template_diff.compatibility}`));
          }
          if (result.dependency_execution && Array.isArray(result.dependency_execution.batches)) {
            console.log(chalk.gray(`  Execution batches: ${result.dependency_execution.batches.length}`));
          }
          if (result.gates) {
            console.log(chalk.gray(`  Gate passed: ${result.gates.passed ? 'yes' : 'no'}`));
          }
          if (result.release_gate_preflight) {
            const preflight = result.release_gate_preflight;
            const blockedText = preflight.blocked === true ? 'blocked' : 'clear';
            console.log(
              chalk.gray(
                `  Release gate preflight: ${preflight.available === true ? blockedText : 'unavailable'}`
              )
            );
            if (preflight.latest_tag) {
              console.log(chalk.gray(`    Latest tag: ${preflight.latest_tag}`));
            }
            if (
              Number.isFinite(Number(preflight.latest_weekly_ops_runtime_block_rate_percent)) ||
              Number.isFinite(Number(preflight.latest_weekly_ops_runtime_ui_mode_violation_total))
            ) {
              const runtimeBlockRateText = Number.isFinite(Number(preflight.latest_weekly_ops_runtime_block_rate_percent))
                ? `${preflight.latest_weekly_ops_runtime_block_rate_percent}%`
                : 'n/a';
              const runtimeUiModeTotalText = Number.isFinite(Number(preflight.latest_weekly_ops_runtime_ui_mode_violation_total))
                ? `${preflight.latest_weekly_ops_runtime_ui_mode_violation_total}`
                : 'n/a';
              const runtimeUiModeRateText = Number.isFinite(Number(preflight.latest_weekly_ops_runtime_ui_mode_violation_rate_percent))
                ? `${preflight.latest_weekly_ops_runtime_ui_mode_violation_rate_percent}%`
                : 'n/a';
              console.log(
                chalk.gray(
                  `    Runtime pressure: block-rate=${runtimeBlockRateText} | ui-mode=${runtimeUiModeTotalText}/${runtimeUiModeRateText}`
                )
              );
            }
            if (preflight.reasons && preflight.reasons.length > 0) {
              console.log(chalk.gray(`    Reasons: ${preflight.reasons.join(' | ')}`));
            }
          }
          if (result.moqui_baseline) {
            console.log(chalk.gray(`  Moqui baseline: ${result.moqui_baseline.status || 'unknown'}`));
            if (result.moqui_baseline.summary) {
              const baselineSummary = result.moqui_baseline.summary;
              const scoreText = Number.isFinite(Number(baselineSummary.avg_score))
                ? `${baselineSummary.avg_score}`
                : 'n/a';
              const validRateText = Number.isFinite(Number(baselineSummary.valid_rate_percent))
                ? `${baselineSummary.valid_rate_percent}%`
                : 'n/a';
              console.log(chalk.gray(`    Portfolio: ${baselineSummary.portfolio_passed ? 'pass' : 'fail'} | avg=${scoreText} | valid-rate=${validRateText}`));
              const entityRateText = formatAutoHandoffMoquiCoverageMetric(baselineSummary, 'entity_coverage', 'rate_percent', '%');
              const ruleClosedRateText = formatAutoHandoffMoquiCoverageMetric(baselineSummary, 'business_rule_closed', 'rate_percent', '%');
              const decisionClosedRateText = formatAutoHandoffMoquiCoverageMetric(baselineSummary, 'decision_closed', 'rate_percent', '%');
              console.log(chalk.gray(`    Coverage: entity=${entityRateText} | rule-closed=${ruleClosedRateText} | decision-closed=${decisionClosedRateText}`));
              const regressionText = formatAutoHandoffMoquiCoverageRegressions(
                result.moqui_baseline && result.moqui_baseline.compare ? result.moqui_baseline.compare : {},
                3
              );
              console.log(chalk.gray(`    Regressions: ${regressionText}`));
            }
            if (result.moqui_baseline.output && result.moqui_baseline.output.json) {
              console.log(chalk.gray(`    Baseline report: ${result.moqui_baseline.output.json}`));
            }
          }
          if (result.scene_package_batch) {
            console.log(chalk.gray(`  Scene package batch: ${result.scene_package_batch.status || 'unknown'}`));
            if (result.scene_package_batch.summary) {
              const sceneSummary = result.scene_package_batch.summary;
              console.log(
                chalk.gray(
                  `    Selected: ${sceneSummary.selected || 0} | ` +
                  `failed=${sceneSummary.failed || 0} | ` +
                  `batch-gate=${sceneSummary.batch_gate_passed === true ? 'pass' : 'fail'}`
                )
              );
            }
            if (result.scene_package_batch.output && result.scene_package_batch.output.json) {
              console.log(chalk.gray(`    Batch report: ${result.scene_package_batch.output.json}`));
            }
          }
          if (result.moqui_capability_coverage) {
            console.log(chalk.gray(`  Capability coverage: ${result.moqui_capability_coverage.status || 'unknown'}`));
            if (result.moqui_capability_coverage.summary) {
              const coverageSummary = result.moqui_capability_coverage.summary;
              const coverageText = Number.isFinite(Number(coverageSummary.coverage_percent))
                ? `${coverageSummary.coverage_percent}%`
                : 'n/a';
              console.log(
                chalk.gray(
                  `    Passed: ${coverageSummary.passed === true ? 'yes' : 'no'} | ` +
                  `coverage=${coverageText} | min=${coverageSummary.min_required_percent}%`
                )
              );
            }
          }
          if (result.remediation_queue && result.remediation_queue.file) {
            console.log(chalk.gray(`  Remediation queue: ${toAutoHandoffCliPath(process.cwd(), result.remediation_queue.file)} (${result.remediation_queue.goal_count})`));
          }
          if (result.output_file) {
            console.log(chalk.gray(`  Report: ${result.output_file}`));
          }
          if (result.release_evidence && result.release_evidence.file) {
            const mergeState = result.release_evidence.merged === false
              ? (result.release_evidence.skipped ? 'skipped' : 'failed')
              : 'merged';
            console.log(chalk.gray(`  Release evidence: ${result.release_evidence.file} (${mergeState})`));
          }
          if (Array.isArray(result.recommendations) && result.recommendations.length > 0) {
            console.log(chalk.gray('  Recommendations:'));
            result.recommendations.slice(0, 3).forEach(item => {
              console.log(chalk.gray(`    - ${item}`));
            });
          }
          if (
            result.status === 'failed' &&
            result.failure_summary &&
            Array.isArray(result.failure_summary.highlights) &&
            result.failure_summary.highlights.length > 0
          ) {
            console.log(chalk.gray('  Failure summary:'));
            result.failure_summary.highlights.slice(0, 3).forEach(item => {
              console.log(chalk.gray(`    - ${item}`));
            });
          }
        }
        if (result.status === 'failed') {
          process.exit(1);
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  const autoSchema = auto
    .command('schema')
    .description('Check and migrate autonomous archive schema compatibility');

  autoSchema
    .command('check')
    .description('Check autonomous archive schema compatibility')
    .option('--only <scopes>', 'Scope filter: all|close-loop-session|batch-session|controller-session|governance-session', 'all')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await checkAutoArchiveSchema(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.blue('Auto archive schema check:'));
        console.log(chalk.gray(`  Scope: ${result.scope.join(', ')}`));
        console.log(chalk.gray(`  Total files: ${result.summary.total_files}`));
        console.log(chalk.gray(`  Compatible: ${result.summary.compatible_files}`));
        console.log(chalk.gray(`  Missing schema_version: ${result.summary.missing_schema_version_files}`));
        console.log(chalk.gray(`  Incompatible: ${result.summary.incompatible_files}`));
        console.log(chalk.gray(`  Parse errors: ${result.summary.parse_error_files}`));
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoSchema
    .command('migrate')
    .description('Backfill or migrate autonomous archive schema_version')
    .option('--only <scopes>', 'Scope filter: all|close-loop-session|batch-session|controller-session|governance-session', 'all')
    .option('--target-version <version>', `Target schema version (default: ${AUTO_ARCHIVE_SCHEMA_VERSION})`, AUTO_ARCHIVE_SCHEMA_VERSION)
    .option('--apply', 'Apply migration writes (default: dry-run)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await migrateAutoArchiveSchema(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.blue('Auto archive schema migrate:'));
        console.log(chalk.gray(`  Scope: ${result.scope.join(', ')}`));
        console.log(chalk.gray(`  Target version: ${result.target_version}`));
        console.log(chalk.gray(`  Mode: ${result.dry_run ? 'dry-run' : 'apply'}`));
        console.log(chalk.gray(`  Total files: ${result.summary.total_files}`));
        console.log(chalk.gray(`  Candidates: ${result.summary.candidate_files}`));
        console.log(chalk.gray(`  Updated: ${result.summary.updated_files}`));
        console.log(chalk.gray(`  Parse errors: ${result.summary.parse_error_files}`));
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  const autoGovernance = auto
    .command('governance')
    .description('Aggregate autonomous governance telemetry across archives');

  autoGovernance
    .command('stats')
    .description('Aggregate cross-archive session health, throughput, and recovery memory telemetry')
    .option('--days <n>', 'Only include sessions updated within last N days', parseInt)
    .option('--status <statuses>', 'Filter by status token(s), comma-separated (case-insensitive)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await buildAutoGovernanceStats(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(chalk.blue('Autonomous governance stats:'));
        if (result.criteria.days !== null) {
          console.log(chalk.gray(`  Window days: ${result.criteria.days}`));
        }
        if (Array.isArray(result.criteria.status_filter) && result.criteria.status_filter.length > 0) {
          console.log(chalk.gray(`  Status filter: ${result.criteria.status_filter.join(', ')}`));
        }
        console.log(chalk.gray(`  Total sessions: ${result.totals.total_sessions}`));
        console.log(chalk.gray(`  Completion rate: ${result.totals.completion_rate_percent}%`));
        console.log(chalk.gray(`  Failure rate: ${result.totals.failure_rate_percent}%`));
        console.log(chalk.gray(`  Risk level: ${result.health.risk_level}`));
        if (Array.isArray(result.health.concerns) && result.health.concerns.length > 0) {
          console.log(chalk.gray(`  Concerns: ${result.health.concerns.length}`));
        }
        console.log(chalk.gray(`  Recovery signatures: ${result.recovery_memory.signature_count}`));
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoGovernance
    .command('maintain')
    .description('Plan and optionally apply governance maintenance actions for autonomous archives')
    .option('--days <n>', 'Only include sessions updated within last N days for assessment', parseInt)
    .option('--status <statuses>', 'Filter assessment by status token(s), comma-separated (case-insensitive)')
    .option('--session-keep <n>', 'Keep newest N close-loop sessions during maintenance (default: 50)', parseInt)
    .option('--batch-session-keep <n>', 'Keep newest N close-loop-batch sessions during maintenance (default: 50)', parseInt)
    .option('--controller-session-keep <n>', 'Keep newest N close-loop-controller sessions during maintenance (default: 50)', parseInt)
    .option('--recovery-memory-older-than-days <n>', 'Prune recovery-memory entries older than N days (default: 90)', parseInt)
    .option('--apply', 'Apply planned maintenance actions (default: plan-only)')
    .option('--dry-run', 'Preview actions without deleting files')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await runAutoGovernanceMaintenance(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(chalk.blue('Autonomous governance maintenance:'));
        console.log(chalk.gray(`  Apply mode: ${result.apply ? 'enabled' : 'plan-only'}`));
        if (result.dry_run) {
          console.log(chalk.gray('  Dry-run: true'));
        }
        console.log(chalk.gray(`  Planned actions: ${result.summary.planned_actions}`));
        console.log(chalk.gray(`  Applied actions: ${result.summary.applied_actions}`));
        console.log(chalk.gray(`  Failed actions: ${result.summary.failed_actions}`));
        console.log(chalk.gray(`  Risk before: ${result.assessment.health.risk_level}`));
        if (result.after_assessment) {
          console.log(chalk.gray(`  Risk after: ${result.after_assessment.health.risk_level}`));
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoGovernance
    .command('close-loop')
    .description('Run governance maintenance rounds until target risk or stop condition is reached')
    .option('--days <n>', 'Only include sessions updated within last N days for assessment', parseInt)
    .option('--status <statuses>', 'Filter assessment by status token(s), comma-separated (case-insensitive)')
    .option('--session-keep <n>', 'Keep newest N close-loop sessions during maintenance (default: 50)', parseInt)
    .option('--batch-session-keep <n>', 'Keep newest N close-loop-batch sessions during maintenance (default: 50)', parseInt)
    .option('--controller-session-keep <n>', 'Keep newest N close-loop-controller sessions during maintenance (default: 50)', parseInt)
    .option('--recovery-memory-older-than-days <n>', 'Prune recovery-memory entries older than N days (default: 90)', parseInt)
    .option('--max-rounds <n>', 'Max governance rounds (default: 3)', parseInt)
    .option('--target-risk <level>', 'Target risk level: low|medium|high (default: low)', 'low')
    .option('--governance-resume <session>', 'Resume governance close-loop from a prior session id, "latest", or JSON file path')
    .option('--governance-resume-allow-drift', 'Allow overriding persisted governance resume policy (target/advisory settings)')
    .option('--governance-session-id <id>', 'Set explicit governance close-loop session id for persistence')
    .option('--no-governance-session', 'Disable governance close-loop session persistence')
    .option('--governance-session-keep <n>', 'Prune governance close-loop sessions after run and keep newest N snapshots', parseInt)
    .option('--governance-session-older-than-days <n>', 'When pruning governance sessions, only delete sessions older than N days', parseInt)
    .option('--execute-advisory', 'Execute advisory actions (recover/controller resume) when detected')
    .option('--advisory-recover-max-rounds <n>', 'Max rounds for advisory recover execution (default: 3)', parseInt)
    .option('--advisory-controller-max-cycles <n>', 'Max cycles for advisory controller resume execution (default: 20)', parseInt)
    .option('--plan-only', 'Do not apply mutations; run one planning round only')
    .option('--dry-run', 'Preview maintenance actions without deleting files')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options, command) => {
      try {
        const optionSources = getCommandOptionSources(command, [
          'maxRounds',
          'targetRisk',
          'executeAdvisory',
          'advisoryRecoverMaxRounds',
          'advisoryControllerMaxCycles',
          'governanceResumeAllowDrift'
        ]);
        const result = await runAutoGovernanceCloseLoop(process.cwd(), {
          ...options,
          optionSources
        });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(chalk.blue('Autonomous governance close-loop:'));
        console.log(chalk.gray(`  Rounds: ${result.performed_rounds}/${result.max_rounds}`));
        console.log(chalk.gray(`  Target risk: ${result.target_risk}`));
        console.log(chalk.gray(`  Final risk: ${result.final_assessment.health.risk_level}`));
        console.log(chalk.gray(`  Converged: ${result.converged ? 'yes' : 'no'}`));
        console.log(chalk.gray(`  Advisory execution: ${result.execute_advisory ? 'enabled' : 'disabled'}`));
        if (result.execute_advisory && result.advisory_summary) {
          console.log(chalk.gray(`  Advisory executed: ${result.advisory_summary.executed_actions}`));
          console.log(chalk.gray(`  Advisory failed: ${result.advisory_summary.failed_actions}`));
        }
        if (result.resumed_from_governance_session && result.resumed_from_governance_session.id) {
          console.log(chalk.gray(`  Resumed from governance session: ${result.resumed_from_governance_session.id}`));
        }
        if (result.governance_session && result.governance_session.file) {
          console.log(chalk.gray(`  Governance session: ${result.governance_session.file}`));
        }
        console.log(chalk.gray(`  Stop reason: ${result.stop_reason}`));
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  const autoGovernanceSession = autoGovernance
    .command('session')
    .description('Manage governance close-loop sessions');

  autoGovernanceSession
    .command('list')
    .description('List persisted governance close-loop sessions')
    .option('--limit <n>', 'Maximum governance sessions to return (default: 20)', parseInt)
    .option('--status <statuses>', 'Filter by status token(s), comma-separated (case-insensitive)')
    .option('--resume-only', 'Only include sessions resumed from a prior governance session')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await listGovernanceCloseLoopSessions(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (result.total === 0) {
          console.log(chalk.gray('No governance close-loop sessions found.'));
          return;
        }
        console.log(chalk.blue(`Governance close-loop sessions (showing ${result.sessions.length}/${result.total}):`));
        if (result.resume_only) {
          console.log(chalk.gray('  Resume-only filter: enabled'));
        }
        console.log(chalk.gray(`  Resumed sessions: ${result.resumed_sessions}`));
        console.log(chalk.gray(`  Fresh sessions: ${result.fresh_sessions}`));
        for (const session of result.sessions) {
          const rounds = Number.isInteger(Number(session.performed_rounds))
            ? `${session.performed_rounds}/${session.max_rounds}`
            : 'n/a';
          console.log(chalk.gray(
            `- ${session.id} [${session.status}] rounds=${rounds} ` +
            `converged=${session.converged ? 'yes' : 'no'} ` +
            `updated=${session.updated_at || 'unknown'}`
          ));
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoGovernanceSession
    .command('stats')
    .description('Aggregate governance close-loop session telemetry')
    .option('--days <n>', 'Only include sessions updated within last N days', parseInt)
    .option('--status <statuses>', 'Filter by status token(s), comma-separated (case-insensitive)')
    .option('--resume-only', 'Only include sessions resumed from a prior governance session')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await statsGovernanceCloseLoopSessions(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (result.total_sessions === 0) {
          console.log(chalk.gray('No governance close-loop sessions found for the selected stats filter.'));
          return;
        }
        console.log(chalk.blue('Governance close-loop session stats:'));
        if (result.criteria.days !== null) {
          console.log(chalk.gray(`  Window days: ${result.criteria.days}`));
        }
        if (Array.isArray(result.criteria.status_filter) && result.criteria.status_filter.length > 0) {
          console.log(chalk.gray(`  Status filter: ${result.criteria.status_filter.join(', ')}`));
        }
        if (result.criteria.resume_only) {
          console.log(chalk.gray('  Resume-only filter: enabled'));
        }
        console.log(chalk.gray(`  Total sessions: ${result.total_sessions}`));
        console.log(chalk.gray(`  Resumed sessions: ${result.resumed_sessions}`));
        console.log(chalk.gray(`  Fresh sessions: ${result.fresh_sessions}`));
        console.log(chalk.gray(`  Completed: ${result.completed_sessions}`));
        console.log(chalk.gray(`  Failed: ${result.failed_sessions}`));
        console.log(chalk.gray(`  Converged: ${result.converged_sessions}`));
        console.log(chalk.gray(`  Average rounds: ${result.average_performed_rounds}`));
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoGovernanceSession
    .command('prune')
    .description('Prune old governance close-loop sessions by retention policy')
    .option('--keep <n>', 'Keep newest N sessions (default: 20)', parseInt)
    .option('--older-than-days <n>', 'Only prune sessions older than N days', parseInt)
    .option('--dry-run', 'Preview actions without deleting files')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await pruneGovernanceCloseLoopSessions(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.blue('Governance close-loop session prune:'));
        console.log(chalk.gray(`  Candidates: ${result.candidates.length}`));
        console.log(chalk.gray(`  Deleted: ${result.deleted_count}`));
        if (result.dry_run) {
          console.log(chalk.gray('  Dry-run: true'));
        }
        if (result.errors.length > 0) {
          console.log(chalk.yellow(`  Errors: ${result.errors.length}`));
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  const autoRecoveryMemory = auto
    .command('recovery-memory')
    .description('Inspect and maintain close-loop recovery strategy memory');

  autoRecoveryMemory
    .command('show')
    .description('Show persisted recovery memory and summary statistics')
    .option('--scope <scope>', 'Filter memory by scope key')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await showCloseLoopRecoveryMemory(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.blue('Recovery memory summary:'));
        console.log(chalk.gray(`  Signatures: ${result.stats.signature_count}`));
        console.log(chalk.gray(`  Actions: ${result.stats.action_count}`));
        console.log(chalk.gray(`  File: ${result.file}`));
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoRecoveryMemory
    .command('scopes')
    .description('Show aggregated recovery memory statistics by scope')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await showCloseLoopRecoveryMemoryScopes(process.cwd());
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.blue('Recovery memory scopes:'));
        result.scopes.forEach(scope => {
          console.log(
            chalk.gray(
              `  ${scope.scope}: signatures=${scope.signature_count}, actions=${scope.action_count}, ` +
              `attempts=${scope.attempts}, success-rate=${scope.success_rate_percent}%`
            )
          );
        });
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoRecoveryMemory
    .command('prune')
    .description('Prune old recovery memory entries by age')
    .option('--older-than-days <n>', 'Delete memory entries older than N days (default: 30)', parseInt)
    .option('--scope <scope>', 'Only prune entries in this scope')
    .option('--dry-run', 'Preview prune result without writing memory file')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await pruneCloseLoopRecoveryMemory(process.cwd(), options);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.blue('Recovery memory prune summary:'));
        console.log(chalk.gray(`  Signatures before: ${result.signatures_before}`));
        console.log(chalk.gray(`  Signatures after: ${result.signatures_after}`));
        console.log(chalk.gray(`  Actions removed: ${result.actions_removed}`));
        if (result.dry_run) {
          console.log(chalk.gray('  Mode: dry-run (no file updated)'));
        }
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });

  autoRecoveryMemory
    .command('clear')
    .description('Clear persisted recovery memory')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options) => {
      try {
        const result = await clearCloseLoopRecoveryMemory(process.cwd());
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.blue('Recovery memory cleared.'));
        console.log(chalk.gray(`  File: ${result.file}`));
      } catch (error) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
        process.exit(1);
      }
    });
}

/**
 * Load configuration
 * @param {string} mode - Execution mode
 * @returns {Object} - Configuration
 */
async function loadConfig(mode) {
  const globalConfigPath = path.join(process.cwd(), '.sce', 'auto', 'config.json');
  
  let globalConfig = {};
  if (await fs.pathExists(globalConfigPath)) {
    globalConfig = await fs.readJson(globalConfigPath);
  }
  
  if (mode) {
    globalConfig.mode = mode;
  }
  
  return mergeConfigs(globalConfig, {});
}

/**
 * Generate Spec name from description
 * @param {string} description - Feature description
 * @returns {string} - Spec name
 */
function generateSpecName(description) {
  const words = description.toLowerCase().split(/\s+/).slice(0, 3);
  const name = words.join('-').replace(/[^a-z0-9-]/g, '');
  const number = Math.floor(Math.random() * 1000);
  return `${number.toString().padStart(2, '0')}-00-${name}`;
}

function applyCloseLoopOptions(command, options = {}) {
  command
    .option('--subs <n>', 'Number of sub-specs to create (2-5)', parseInt)
    .option('--max-parallel <n>', 'Maximum parallel agents for orchestration', parseInt)
    .option('--prefix <n>', 'Use explicit Spec prefix number', parseInt)
    .option('--dod-tests <command>', 'Run a final DoD test command (for example: "npm run test:smoke")')
    .option('--dod-tests-timeout <ms>', 'Timeout (ms) for --dod-tests command', parseInt)
    .option('--dod-max-risk-level <level>', 'DoD risk gate: maximum derived run risk (low|medium|high)')
    .option('--dod-kpi-min-completion-rate <n>', 'DoD KPI gate: minimum completion rate percent (0-100)', parseFloat)
    .option('--dod-max-success-rate-drop <n>', 'DoD baseline gate: max allowed success-rate drop vs historical baseline (0-100)', parseFloat)
    .option('--dod-baseline-window <n>', 'DoD baseline gate: historical session window size (default: 5)', parseInt)
    .option('--no-dod-docs', 'Skip DoD doc completeness gate (requirements/design/tasks)')
    .option('--no-dod-collab', 'Skip DoD collaboration completed-status gate')
    .option('--dod-tasks-closed', 'Require all generated tasks checklists to be fully closed')
    .option('--no-dod', 'Disable all DoD gates')
    .option('--dod-report <path>', 'Write DoD evidence report JSON (default: .sce/specs/<master>/custom/dod-report.json)')
    .option('--no-dod-report', 'Disable automatic DoD report archive')
    .option('--resume <session-or-file>', 'Resume close-loop from a prior session id, "latest", "interrupted", or a JSON file path')
    .option('--session-id <id>', 'Set explicit close-loop session id for persistence')
    .option('--no-session', 'Disable close-loop session persistence')
    .option('--session-keep <n>', 'After close-loop, keep newest N session snapshots and prune older ones', parseInt)
    .option('--session-older-than-days <n>', 'Only prune sessions older than N days when session retention is enabled', parseInt)
    .option('--replan-strategy <strategy>', 'Replan budget strategy: fixed|adaptive (default: adaptive)')
    .option('--replan-attempts <n>', 'Maximum automatic replan cycles after failed orchestration (default: 1)', parseInt)
    .option('--replan-no-progress-window <n>', 'Stop replan when no progress is detected for N consecutive failed cycles (default: 3)', parseInt)
    .option('--no-replan', 'Disable automatic replan on orchestration failure')
    .option('--no-conflict-governance', 'Disable master/sub lease-conflict prediction and auto-reorder')
    .option('--no-ontology-guidance', 'Disable scene ontology agent-hints guidance for sub-spec scheduling')
    .option('--no-run', 'Generate portfolio and metadata only (skip orchestration run)')
    .option('--no-stream', 'Disable live orchestration status stream during execution')
    .option('--dry-run', 'Preview decomposition without writing files')
    .option('--json', 'Output machine-readable JSON');

  if (options.includeOut) {
    command.option('--out <path>', 'Write result JSON to file');
  }

  return command;
}

function normalizeBatchFormat(formatCandidate) {
  const normalized = typeof formatCandidate === 'string'
    ? formatCandidate.trim().toLowerCase()
    : 'auto';
  if (!['auto', 'json', 'lines'].includes(normalized)) {
    throw new Error('--format must be one of: auto, json, lines');
  }
  return normalized;
}

function parseGoalsFromJsonPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === 'object' && Array.isArray(payload.goals)) {
    return payload.goals;
  }
  throw new Error('JSON goals file must be an array of strings or an object with a "goals" array.');
}

function parseGoalsFromLines(content) {
  return `${content || ''}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

async function loadCloseLoopBatchGoals(projectPath, goalsFile, formatCandidate) {
  const resolvedFile = path.isAbsolute(goalsFile)
    ? goalsFile
    : path.join(projectPath, goalsFile);
  if (!(await fs.pathExists(resolvedFile))) {
    throw new Error(`Goals file not found: ${resolvedFile}`);
  }

  const format = normalizeBatchFormat(formatCandidate);
  const isJsonByExtension = resolvedFile.toLowerCase().endsWith('.json');
  const useJson = format === 'json' || (format === 'auto' && isJsonByExtension);
  let goals = [];

  if (useJson) {
    let payload = null;
    try {
      payload = await fs.readJson(resolvedFile);
    } catch (error) {
      throw new Error(`Invalid JSON goals file: ${resolvedFile} (${error.message})`);
    }
    goals = parseGoalsFromJsonPayload(payload);
  } else {
    const content = await fs.readFile(resolvedFile, 'utf8');
    goals = parseGoalsFromLines(content);
  }

  const normalizedGoals = goals
    .map(item => `${item || ''}`.trim())
    .filter(Boolean);
  if (normalizedGoals.length === 0) {
    throw new Error(`No valid goals found in file: ${resolvedFile}`);
  }

  return {
    file: resolvedFile,
    goals: normalizedGoals
  };
}

const PROGRAM_CATEGORY_GOAL_LIBRARY = {
  closeLoop: 'Build automatic closed-loop progression without manual confirmation waits for the program scope.',
  decomposition: 'Split broad functional scope into coordinated master/sub specs with explicit dependency ownership.',
  orchestration: 'Harden orchestration scheduling, parallel execution, and shared resource governance for multi-spec delivery.',
  quality: 'Enforce quality gates, tests, and observability evidence across all autonomous execution tracks.',
  docs: 'Complete documentation and rollout guidance so autonomous workflows can be repeatedly operated at scale.'
};
const DEFAULT_PROGRAM_DECOMPOSITION_MIN_QUALITY_SCORE = 70;
const PROGRAM_GATE_PROFILE_POLICY = {
  default: {
    minSuccessRate: 100,
    maxRiskLevel: 'high',
    maxElapsedMinutes: null,
    maxAgentBudget: null,
    maxTotalSubSpecs: null
  },
  dev: {
    minSuccessRate: 80,
    maxRiskLevel: 'high',
    maxElapsedMinutes: 240,
    maxAgentBudget: 60,
    maxTotalSubSpecs: 500
  },
  staging: {
    minSuccessRate: 95,
    maxRiskLevel: 'medium',
    maxElapsedMinutes: 120,
    maxAgentBudget: 30,
    maxTotalSubSpecs: 300
  },
  prod: {
    minSuccessRate: 100,
    maxRiskLevel: 'low',
    maxElapsedMinutes: 60,
    maxAgentBudget: 12,
    maxTotalSubSpecs: 120
  }
};

function normalizeProgramGoalCount(programGoalsCandidate, fallbackCount) {
  if (programGoalsCandidate === undefined || programGoalsCandidate === null) {
    return fallbackCount;
  }

  const parsed = Number(programGoalsCandidate);
  if (!Number.isInteger(parsed) || parsed < 2 || parsed > 12) {
    throw new Error('--program-goals must be an integer between 2 and 12.');
  }
  return parsed;
}

function inferProgramGoalCount(semantic) {
  const clauseCount = Array.isArray(semantic && semantic.clauses) ? semantic.clauses.length : 0;
  const activeCategories = semantic && semantic.categoryScores
    ? Object.values(semantic.categoryScores).filter(score => score > 0).length
    : 0;

  if (clauseCount >= 8 || activeCategories >= 4) {
    return 5;
  }
  if (clauseCount >= 5 || activeCategories >= 3) {
    return 4;
  }
  return 3;
}

function normalizeProgramMinQualityScore(scoreCandidate) {
  if (scoreCandidate === undefined || scoreCandidate === null) {
    return DEFAULT_PROGRAM_DECOMPOSITION_MIN_QUALITY_SCORE;
  }
  const parsed = Number(scoreCandidate);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
    throw new Error('--program-min-quality-score must be a number between 0 and 100.');
  }
  return Number(parsed.toFixed(2));
}

function scoreProgramGoalClause(clause) {
  const text = `${clause || ''}`.trim().toLowerCase();
  if (!text) {
    return 0;
  }

  const words = text.split(/\s+/).filter(Boolean).length;
  const connectorSignals = (text.match(/,|;| and | with | plus |并且|以及|并行|同时/g) || []).length;
  const domainSignals = (text.match(
    /orchestrat|integration|migration|observability|quality|security|performance|resilience|compliance|governance|闭环|主从|并行|重规划/g
  ) || []).length;
  return words + (connectorSignals * 2) + (domainSignals * 3);
}

function buildProgramGoalDecompositionQuality(semantic, generatedGoals, targetGoalCount) {
  const goals = Array.isArray(generatedGoals) ? generatedGoals : [];
  const rankedCategories = Array.isArray(semantic && semantic.rankedCategories)
    ? semantic.rankedCategories
    : [];
  const categoryScores = semantic && semantic.categoryScores && typeof semantic.categoryScores === 'object'
    ? semantic.categoryScores
    : {};
  const activeCategoryCount = Object.values(categoryScores)
    .filter(value => Number(value) > 0)
    .length;
  const averageGoalWords = goals.length === 0
    ? 0
    : Number((
      goals
        .map(goal => `${goal || ''}`.trim().split(/\s+/).filter(Boolean).length)
        .reduce((sum, value) => sum + value, 0) / goals.length
    ).toFixed(2));
  const normalizedGoalSeeds = goals
    .map(goal => `${goal || ''}`.toLowerCase().replace(/[0-9]+/g, '#').replace(/[^a-z\u4e00-\u9fff# ]+/g, ' '))
    .map(goal => goal.split(/\s+/).filter(Boolean).slice(0, 8).join(' '))
    .filter(Boolean);
  const uniqueGoalSeeds = new Set(normalizedGoalSeeds);
  const diversityRatio = goals.length === 0
    ? 1
    : Math.min(1, uniqueGoalSeeds.size / goals.length);
  const coverageRatio = targetGoalCount <= 0
    ? 1
    : Math.min(1, goals.length / targetGoalCount);
  const categoryCoverageRatio = activeCategoryCount <= 0
    ? 1
    : Math.min(1, rankedCategories.length / activeCategoryCount);
  const warnings = [];
  if (goals.length < targetGoalCount) {
    warnings.push('under-produced-goals');
  }
  if (averageGoalWords < 6) {
    warnings.push('goals-too-short');
  }
  if (activeCategoryCount >= 3 && rankedCategories.length < 2) {
    warnings.push('category-coverage-low');
  }
  if (diversityRatio < 0.6) {
    warnings.push('goal-diversity-low');
  }

  const score = Number((
    (coverageRatio * 45) +
    (categoryCoverageRatio * 25) +
    (Math.min(1, averageGoalWords / 12) * 20) +
    (diversityRatio * 10)
  ).toFixed(2));
  return {
    score,
    coverage_ratio_percent: Number((coverageRatio * 100).toFixed(2)),
    category_coverage_ratio_percent: Number((categoryCoverageRatio * 100).toFixed(2)),
    diversity_ratio_percent: Number((diversityRatio * 100).toFixed(2)),
    average_goal_words: averageGoalWords,
    warnings
  };
}

function buildRefinedProgramGoalFromClause(clause, contextGoal) {
  const normalizedClause = `${clause || ''}`.replace(/\s+/g, ' ').trim().replace(/[.。;；]+$/g, '');
  if (!normalizedClause) {
    return null;
  }
  return (
    `Deliver ${normalizedClause} as a dedicated execution track with implementation tasks, ` +
    `automated validation, and rollout evidence aligned to: ${contextGoal}`
  );
}

function buildRefinedProgramGoalFromCategory(category, contextGoal) {
  const template = PROGRAM_CATEGORY_GOAL_LIBRARY[category];
  if (!template) {
    return null;
  }
  return (
    `${template} Ensure cross-spec coordination, measurable acceptance criteria, ` +
    `and audit-ready output for: ${contextGoal}`
  );
}

function shouldRefineProgramGoalQuality(quality, minQualityScore) {
  const safeQuality = quality && typeof quality === 'object' ? quality : {};
  const warnings = Array.isArray(safeQuality.warnings) ? safeQuality.warnings : [];
  const score = Number(safeQuality.score);
  if (Number.isFinite(score) && score < minQualityScore) {
    return true;
  }
  return warnings.includes('goals-too-short') || warnings.includes('under-produced-goals');
}

function buildCloseLoopBatchGoalsFromGoal(goalCandidate, programGoalsCandidate, settings = {}) {
  const normalizedGoal = `${goalCandidate || ''}`.trim();
  if (!normalizedGoal) {
    throw new Error('--decompose-goal requires a non-empty goal string.');
  }

  const semantic = analyzeGoalSemantics(normalizedGoal);
  const targetGoalCount = normalizeProgramGoalCount(
    programGoalsCandidate,
    inferProgramGoalCount(semantic)
  );
  const minQualityScore = normalizeProgramMinQualityScore(settings.minQualityScore);
  const enforceQualityGate = Boolean(settings.enforceQualityGate);

  const seenGoals = new Set();
  const generatedGoals = [];
  const pushGoal = goal => {
    const normalized = `${goal || ''}`.trim();
    if (!normalized) {
      return;
    }
    const dedupeKey = normalized.toLowerCase();
    if (seenGoals.has(dedupeKey)) {
      return;
    }
    seenGoals.add(dedupeKey);
    generatedGoals.push(normalized);
  };

  const scoredClauses = (semantic.clauses || [])
    .map(clause => `${clause || ''}`.trim())
    .filter(clause => clause.length >= 8)
    .map(clause => ({
      clause,
      score: scoreProgramGoalClause(clause)
    }))
    .sort((left, right) => right.score - left.score);

  for (const item of scoredClauses) {
    if (generatedGoals.length >= targetGoalCount) {
      break;
    }
    pushGoal(item.clause);
  }

  for (const category of semantic.rankedCategories || []) {
    if (generatedGoals.length >= targetGoalCount) {
      break;
    }

    const template = PROGRAM_CATEGORY_GOAL_LIBRARY[category];
    if (!template) {
      continue;
    }
    pushGoal(`${template} Program goal context: ${normalizedGoal}`);
  }

  if (generatedGoals.length === 0) {
    pushGoal(normalizedGoal);
  }
  let finalGoals = generatedGoals.slice(0, targetGoalCount);
  const initialQuality = buildProgramGoalDecompositionQuality(semantic, finalGoals, targetGoalCount);
  let finalQuality = initialQuality;
  let refinementApplied = false;
  let refinementReason = null;

  if (shouldRefineProgramGoalQuality(initialQuality, minQualityScore)) {
    refinementReason = Number(initialQuality.score) < minQualityScore
      ? 'score-below-threshold'
      : 'quality-warning-triggered';
    const refinedGoals = [];
    const refinedSeen = new Set();
    const pushRefinedGoal = goal => {
      const normalized = `${goal || ''}`.trim();
      if (!normalized) {
        return;
      }
      const dedupeKey = normalized.toLowerCase();
      if (refinedSeen.has(dedupeKey)) {
        return;
      }
      refinedSeen.add(dedupeKey);
      refinedGoals.push(normalized);
    };

    for (const item of scoredClauses) {
      if (refinedGoals.length >= targetGoalCount) {
        break;
      }
      pushRefinedGoal(buildRefinedProgramGoalFromClause(item.clause, normalizedGoal));
    }

    for (const category of semantic.rankedCategories || []) {
      if (refinedGoals.length >= targetGoalCount) {
        break;
      }
      pushRefinedGoal(buildRefinedProgramGoalFromCategory(category, normalizedGoal));
    }

    if (refinedGoals.length === 0) {
      pushRefinedGoal(
        `Execute ${normalizedGoal} with coordinated master/sub specs, quality gates, and completion evidence.`
      );
    }

    while (refinedGoals.length < targetGoalCount) {
      pushRefinedGoal(
        `Track ${refinedGoals.length + 1}: Deliver ${normalizedGoal} with implementation tasks, ` +
        'integration checks, and operational handoff evidence.'
      );
    }

    const refinedFinalGoals = refinedGoals.slice(0, targetGoalCount);
    const refinedQuality = buildProgramGoalDecompositionQuality(semantic, refinedFinalGoals, targetGoalCount);
    const refinedWarnings = Array.isArray(refinedQuality.warnings) ? refinedQuality.warnings.length : 0;
    const initialWarnings = Array.isArray(initialQuality.warnings) ? initialQuality.warnings.length : 0;
    if (
      Number(refinedQuality.score) > Number(initialQuality.score) ||
      (Number(refinedQuality.score) === Number(initialQuality.score) && refinedWarnings < initialWarnings)
    ) {
      finalGoals = refinedFinalGoals;
      finalQuality = refinedQuality;
      refinementApplied = true;
    }
  }

  const quality = {
    ...finalQuality,
    refinement: {
      attempted: shouldRefineProgramGoalQuality(initialQuality, minQualityScore),
      applied: refinementApplied,
      min_score: minQualityScore,
      reason: refinementReason,
      before_score: initialQuality.score,
      after_score: finalQuality.score,
      before_warnings: initialQuality.warnings,
      after_warnings: finalQuality.warnings
    }
  };
  if (enforceQualityGate && Number(quality.score) < minQualityScore) {
    const warningText = Array.isArray(quality.warnings) && quality.warnings.length > 0
      ? ` Warnings: ${quality.warnings.join(', ')}.`
      : '';
    throw new Error(
      `Decomposition quality score ${quality.score} is below required ${minQualityScore}.${warningText}`
    );
  }

  return {
    file: '(generated-from-goal)',
    goals: finalGoals,
    generatedFromGoal: {
      goal: normalizedGoal,
      strategy: 'semantic-clause-and-category',
      target_goal_count: targetGoalCount,
      produced_goal_count: finalGoals.length,
      clauses_considered: Array.isArray(semantic.clauses) ? semantic.clauses.length : 0,
      category_scores: semantic.categoryScores || {},
      ranked_categories: semantic.rankedCategories || [],
      quality
    }
  };
}

function normalizeResumeStrategy(resumeStrategyCandidate) {
  const normalized = typeof resumeStrategyCandidate === 'string'
    ? resumeStrategyCandidate.trim().toLowerCase()
    : 'pending';
  if (!['pending', 'failed-only'].includes(normalized)) {
    throw new Error('--resume-strategy must be one of: pending, failed-only');
  }
  return normalized;
}

function getCloseLoopBatchSummaryDir(projectPath) {
  return path.join(projectPath, '.sce', 'auto', 'close-loop-batch-summaries');
}

async function resolveCloseLoopBatchSummaryFile(projectPath, summaryCandidate) {
  if (typeof summaryCandidate !== 'string' || !summaryCandidate.trim()) {
    throw new Error('--resume-from-summary requires a file path or "latest".');
  }

  const normalizedCandidate = summaryCandidate.trim();
  if (normalizedCandidate.toLowerCase() === 'latest') {
    const summaryDir = getCloseLoopBatchSummaryDir(projectPath);
    if (!(await fs.pathExists(summaryDir))) {
      throw new Error(`No batch summary sessions found in: ${summaryDir}`);
    }
    const candidates = (await fs.readdir(summaryDir))
      .filter(item => item.toLowerCase().endsWith('.json'));
    if (candidates.length === 0) {
      throw new Error(`No batch summary sessions found in: ${summaryDir}`);
    }

    const entries = [];
    for (const file of candidates) {
      const filePath = path.join(summaryDir, file);
      const stats = await fs.stat(filePath);
      entries.push({
        file: filePath,
        mtimeMs: stats.mtimeMs
      });
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return entries[0].file;
  }

  return path.isAbsolute(normalizedCandidate)
    ? normalizedCandidate
    : path.join(projectPath, normalizedCandidate);
}

async function loadCloseLoopBatchSummaryPayload(projectPath, summaryCandidate) {
  const summaryFile = await resolveCloseLoopBatchSummaryFile(projectPath, summaryCandidate);
  if (!(await fs.pathExists(summaryFile))) {
    throw new Error(`Batch summary file not found: ${summaryFile}`);
  }

  let payload = null;
  try {
    payload = await fs.readJson(summaryFile);
  } catch (error) {
    throw new Error(`Invalid batch summary JSON: ${summaryFile} (${error.message})`);
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error(`Invalid batch summary payload: ${summaryFile}`);
  }

  return {
    file: summaryFile,
    payload
  };
}

function normalizeRecoveryActionIndex(actionCandidate, maxActions, optionLabel = '--use-action') {
  if (!Number.isInteger(maxActions) || maxActions <= 0) {
    return 1;
  }

  if (actionCandidate === undefined || actionCandidate === null) {
    return 1;
  }

  const parsed = Number(actionCandidate);
  const upperBound = Math.max(20, maxActions);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > upperBound) {
    throw new Error(`${optionLabel} must be an integer between 1 and ${upperBound}.`);
  }
  if (parsed > maxActions) {
    throw new Error(`${optionLabel} ${parsed} is out of range. Available remediation actions: 1-${maxActions}.`);
  }
  return parsed;
}

function getCloseLoopRecoveryMemoryFile(projectPath) {
  return path.join(projectPath, '.sce', 'auto', 'close-loop-recovery-memory.json');
}

async function loadCloseLoopRecoveryMemory(projectPath) {
  const memoryFile = getCloseLoopRecoveryMemoryFile(projectPath);
  const fallbackPayload = {
    version: 1,
    signatures: {}
  };
  if (!(await fs.pathExists(memoryFile))) {
    return {
      file: memoryFile,
      payload: fallbackPayload
    };
  }

  let payload = null;
  try {
    payload = await fs.readJson(memoryFile);
  } catch (error) {
    return {
      file: memoryFile,
      payload: fallbackPayload
    };
  }

  if (!payload || typeof payload !== 'object') {
    return {
      file: memoryFile,
      payload: fallbackPayload
    };
  }

  return {
    file: memoryFile,
    payload: {
      version: Number(payload.version) || 1,
      signatures: payload.signatures && typeof payload.signatures === 'object'
        ? payload.signatures
        : {}
    }
  };
}

function normalizeRecoveryMemoryToken(value) {
  return `${value || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

async function resolveRecoveryMemoryScope(projectPath, scopeCandidate) {
  const explicitScope = `${scopeCandidate || ''}`.trim();
  if (explicitScope && explicitScope.toLowerCase() !== 'auto') {
    return normalizeRecoveryMemoryToken(explicitScope) || 'default-scope';
  }

  const projectToken = normalizeRecoveryMemoryToken(path.basename(path.resolve(projectPath || '.'))) || 'project';
  const branchToken = await resolveGitBranchToken(projectPath);
  return `${projectToken}|${branchToken || 'default'}`;
}

async function resolveGitBranchToken(projectPath) {
  try {
    const gitMetadataPath = path.join(projectPath, '.git');
    if (!(await fs.pathExists(gitMetadataPath))) {
      return 'no-git';
    }

    let gitDir = gitMetadataPath;
    const gitStat = await fs.stat(gitMetadataPath);
    if (gitStat.isFile()) {
      const pointer = await fs.readFile(gitMetadataPath, 'utf8');
      const match = pointer.match(/gitdir:\s*(.+)/i);
      if (match && match[1]) {
        gitDir = path.resolve(projectPath, match[1].trim());
      }
    }

    const headFile = path.join(gitDir, 'HEAD');
    if (!(await fs.pathExists(headFile))) {
      return 'no-head';
    }
    const headContent = `${await fs.readFile(headFile, 'utf8')}`.trim();
    const refMatch = headContent.match(/^ref:\s+refs\/heads\/(.+)$/i);
    if (refMatch && refMatch[1]) {
      return normalizeRecoveryMemoryToken(refMatch[1]) || 'unknown-branch';
    }
    if (/^[a-f0-9]{7,40}$/i.test(headContent)) {
      return `detached-${headContent.slice(0, 8).toLowerCase()}`;
    }
    return 'unknown-branch';
  } catch (error) {
    return 'unknown-branch';
  }
}

function buildRecoveryMemorySignature(summaryPayload, context = {}) {
  const safeSummary = summaryPayload && typeof summaryPayload === 'object'
    ? summaryPayload
    : {};
  const diagnostics = safeSummary.program_diagnostics && typeof safeSummary.program_diagnostics === 'object'
    ? safeSummary.program_diagnostics
    : buildProgramDiagnostics(safeSummary);
  const clusters = Array.isArray(diagnostics.failure_clusters)
    ? diagnostics.failure_clusters
    : [];
  const clusterSignature = clusters
    .slice(0, 3)
    .map(cluster => normalizeRecoveryMemoryToken(cluster && cluster.signature))
    .filter(Boolean)
    .join('|');
  const scopeToken = normalizeRecoveryMemoryToken(context.scope || 'default-scope') || 'default-scope';
  const modeToken = normalizeRecoveryMemoryToken(safeSummary.mode || 'unknown-mode');
  const failedCount = Number(safeSummary.failed_goals) || 0;
  const seed = clusterSignature || 'no-failure-cluster';
  return `scope-${scopeToken}|${modeToken}|failed-${failedCount}|${seed}`;
}

function getRecoveryActionMemoryKey(action, index) {
  const actionToken = normalizeRecoveryMemoryToken(action && action.action);
  const commandToken = normalizeRecoveryMemoryToken(action && action.suggested_command);
  const fallback = `action-${index}`;
  return actionToken || commandToken
    ? `${fallback}|${actionToken || 'none'}|${commandToken || 'none'}`
    : fallback;
}

function selectRecoveryActionFromMemory(availableActions, recoveryMemoryEntry) {
  if (
    !recoveryMemoryEntry ||
    typeof recoveryMemoryEntry !== 'object' ||
    !recoveryMemoryEntry.actions ||
    typeof recoveryMemoryEntry.actions !== 'object'
  ) {
    return null;
  }

  const candidates = [];
  for (let index = 1; index <= availableActions.length; index += 1) {
    const action = availableActions[index - 1];
    const key = getRecoveryActionMemoryKey(action, index);
    const stats = recoveryMemoryEntry.actions[key];
    if (!stats || typeof stats !== 'object') {
      continue;
    }
    const attempts = Number(stats.attempts) || 0;
    const successes = Number(stats.successes) || 0;
    if (attempts <= 0) {
      continue;
    }
    const successRate = successes / attempts;
    const score = (successRate * 100) + Math.min(25, attempts);
    candidates.push({
      index,
      key,
      score,
      attempts,
      successes,
      failures: Number(stats.failures) || 0,
      success_rate_percent: Number((successRate * 100).toFixed(2))
    });
  }

  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (right.attempts !== left.attempts) {
      return right.attempts - left.attempts;
    }
    return left.index - right.index;
  });
  const best = candidates[0];
  return {
    ...best,
    selection_reason: 'highest memory score: success_rate_percent + bounded_attempt_bonus',
    top_candidates: candidates.slice(0, 5)
  };
}

function getRecoveryMemoryEntry(recoveryMemoryPayload, signature) {
  if (
    !recoveryMemoryPayload ||
    typeof recoveryMemoryPayload !== 'object' ||
    !recoveryMemoryPayload.signatures ||
    typeof recoveryMemoryPayload.signatures !== 'object'
  ) {
    return null;
  }
  const signatureKey = `${signature || ''}`.trim();
  if (!signatureKey) {
    return null;
  }
  const entry = recoveryMemoryPayload.signatures[signatureKey];
  return entry && typeof entry === 'object' ? entry : null;
}

async function updateCloseLoopRecoveryMemory(
  projectPath,
  recoveryMemory,
  signature,
  selectedIndex,
  selectedAction,
  finalStatus,
  metadata = {}
) {
  const memoryFile = recoveryMemory && typeof recoveryMemory.file === 'string'
    ? recoveryMemory.file
    : getCloseLoopRecoveryMemoryFile(projectPath);
  const memoryPayload = recoveryMemory && recoveryMemory.payload && typeof recoveryMemory.payload === 'object'
    ? recoveryMemory.payload
    : {
      version: 1,
      signatures: {}
    };
  if (!memoryPayload.signatures || typeof memoryPayload.signatures !== 'object') {
    memoryPayload.signatures = {};
  }

  const signatureKey = `${signature || ''}`.trim() || 'unknown-signature';
  const selected = Number.isInteger(selectedIndex) && selectedIndex > 0 ? selectedIndex : 1;
  const actionKey = getRecoveryActionMemoryKey(selectedAction || {}, selected);
  const now = new Date().toISOString();
  const scope = normalizeRecoveryMemoryToken(metadata.scope || '') || null;

  if (!memoryPayload.signatures[signatureKey] || typeof memoryPayload.signatures[signatureKey] !== 'object') {
    memoryPayload.signatures[signatureKey] = {
      attempts: 0,
      successes: 0,
      failures: 0,
      scope,
      last_used_at: null,
      last_selected_index: null,
      actions: {}
    };
  }

  const signatureEntry = memoryPayload.signatures[signatureKey];
  if (!signatureEntry.actions || typeof signatureEntry.actions !== 'object') {
    signatureEntry.actions = {};
  }
  if (!signatureEntry.actions[actionKey] || typeof signatureEntry.actions[actionKey] !== 'object') {
    signatureEntry.actions[actionKey] = {
      attempts: 0,
      successes: 0,
      failures: 0,
      last_status: null,
      last_used_at: null,
      last_selected_index: selected
    };
  }

  const actionEntry = signatureEntry.actions[actionKey];
  const succeeded = `${finalStatus || ''}`.trim().toLowerCase() === 'completed';

  signatureEntry.attempts = (Number(signatureEntry.attempts) || 0) + 1;
  signatureEntry.successes = (Number(signatureEntry.successes) || 0) + (succeeded ? 1 : 0);
  signatureEntry.failures = (Number(signatureEntry.failures) || 0) + (succeeded ? 0 : 1);
  signatureEntry.scope = signatureEntry.scope || scope;
  signatureEntry.last_used_at = now;
  signatureEntry.last_selected_index = selected;

  actionEntry.attempts = (Number(actionEntry.attempts) || 0) + 1;
  actionEntry.successes = (Number(actionEntry.successes) || 0) + (succeeded ? 1 : 0);
  actionEntry.failures = (Number(actionEntry.failures) || 0) + (succeeded ? 0 : 1);
  actionEntry.last_status = `${finalStatus || 'unknown'}`;
  actionEntry.last_used_at = now;
  actionEntry.last_selected_index = selected;

  await fs.ensureDir(path.dirname(memoryFile));
  await fs.writeJson(memoryFile, memoryPayload, { spaces: 2 });

  return {
    file: memoryFile,
    signature: signatureKey,
    action_key: actionKey,
    scope: signatureEntry.scope || scope,
    entry: actionEntry
  };
}

function summarizeRecoveryMemory(memoryPayload) {
  const signatures = memoryPayload && memoryPayload.signatures && typeof memoryPayload.signatures === 'object'
    ? memoryPayload.signatures
    : {};
  const signatureKeys = Object.keys(signatures);
  let actionCount = 0;
  const scopeCounts = {};
  for (const key of signatureKeys) {
    const entry = signatures[key];
    if (entry && entry.actions && typeof entry.actions === 'object') {
      actionCount += Object.keys(entry.actions).length;
    }
    const scope = normalizeRecoveryMemoryToken(entry && entry.scope ? entry.scope : 'default-scope') || 'default-scope';
    scopeCounts[scope] = (Number(scopeCounts[scope]) || 0) + 1;
  }
  return {
    signature_count: signatureKeys.length,
    action_count: actionCount,
    scope_count: Object.keys(scopeCounts).length,
    scopes: scopeCounts
  };
}

function filterRecoveryMemoryByScope(memoryPayload, scopeCandidate) {
  const normalizedScope = normalizeRecoveryMemoryToken(scopeCandidate);
  if (!normalizedScope) {
    return {
      scope: null,
      payload: memoryPayload
    };
  }

  const source = memoryPayload && typeof memoryPayload === 'object'
    ? memoryPayload
    : { version: 1, signatures: {} };
  const signatures = source.signatures && typeof source.signatures === 'object'
    ? source.signatures
    : {};
  const filteredSignatures = {};
  for (const [signature, entryRaw] of Object.entries(signatures)) {
    const entry = entryRaw && typeof entryRaw === 'object' ? entryRaw : null;
    if (!entry) {
      continue;
    }
    const entryScope = normalizeRecoveryMemoryToken(entry.scope || 'default-scope') || 'default-scope';
    if (entryScope !== normalizedScope) {
      continue;
    }
    filteredSignatures[signature] = entry;
  }

  return {
    scope: normalizedScope,
    payload: {
      version: Number(source.version) || 1,
      signatures: filteredSignatures
    }
  };
}

function buildRecoveryMemoryScopeStats(memoryPayload) {
  const signatures = memoryPayload && memoryPayload.signatures && typeof memoryPayload.signatures === 'object'
    ? memoryPayload.signatures
    : {};
  const aggregates = new Map();
  for (const entryRaw of Object.values(signatures)) {
    const entry = entryRaw && typeof entryRaw === 'object' ? entryRaw : null;
    if (!entry) {
      continue;
    }
    const scope = normalizeRecoveryMemoryToken(entry.scope || 'default-scope') || 'default-scope';
    if (!aggregates.has(scope)) {
      aggregates.set(scope, {
        scope,
        signature_count: 0,
        action_count: 0,
        attempts: 0,
        successes: 0,
        failures: 0
      });
    }
    const aggregate = aggregates.get(scope);
    aggregate.signature_count += 1;
    aggregate.attempts += Number(entry.attempts) || 0;
    aggregate.successes += Number(entry.successes) || 0;
    aggregate.failures += Number(entry.failures) || 0;
    if (entry.actions && typeof entry.actions === 'object') {
      aggregate.action_count += Object.keys(entry.actions).length;
    }
  }

  return [...aggregates.values()]
    .map(item => ({
      ...item,
      success_rate_percent: item.attempts > 0
        ? Number(((item.successes / item.attempts) * 100).toFixed(2))
        : 0
    }))
    .sort((left, right) => {
      if (right.signature_count !== left.signature_count) {
        return right.signature_count - left.signature_count;
      }
      return `${left.scope}`.localeCompare(`${right.scope}`);
    });
}

function isIsoTimestampOlderThan(timestamp, cutoffMs) {
  if (cutoffMs === null) {
    return false;
  }
  if (typeof timestamp !== 'string' || !timestamp.trim()) {
    return true;
  }
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return true;
  }
  return parsed < cutoffMs;
}

async function showCloseLoopRecoveryMemory(projectPath, options = {}) {
  const recoveryMemory = await loadCloseLoopRecoveryMemory(projectPath);
  const filtered = filterRecoveryMemoryByScope(recoveryMemory.payload, options.scope);
  return {
    mode: 'auto-recovery-memory-show',
    file: recoveryMemory.file,
    scope: filtered.scope,
    stats: summarizeRecoveryMemory(filtered.payload),
    payload: filtered.payload
  };
}

async function showCloseLoopRecoveryMemoryScopes(projectPath) {
  const recoveryMemory = await loadCloseLoopRecoveryMemory(projectPath);
  const scopes = buildRecoveryMemoryScopeStats(recoveryMemory.payload);
  return {
    mode: 'auto-recovery-memory-scopes',
    file: recoveryMemory.file,
    total_scopes: scopes.length,
    scopes
  };
}

async function pruneCloseLoopRecoveryMemory(projectPath, options = {}) {
  const olderThanDays = normalizeRecoveryMemoryTtlDays(options.olderThanDays === undefined ? 30 : options.olderThanDays);
  const scope = normalizeRecoveryMemoryToken(options.scope || '') || null;
  const dryRun = Boolean(options.dryRun);
  const recoveryMemory = await loadCloseLoopRecoveryMemory(projectPath);
  const memoryPayload = recoveryMemory.payload && typeof recoveryMemory.payload === 'object'
    ? recoveryMemory.payload
    : { version: 1, signatures: {} };
  if (!memoryPayload.signatures || typeof memoryPayload.signatures !== 'object') {
    memoryPayload.signatures = {};
  }

  const cutoffMs = olderThanDays === null
    ? null
    : Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
  const filteredBeforePayload = scope
    ? filterRecoveryMemoryByScope(memoryPayload, scope).payload
    : memoryPayload;
  const signaturesBefore = summarizeRecoveryMemory(filteredBeforePayload).signature_count;
  const actionBefore = summarizeRecoveryMemory(filteredBeforePayload).action_count;

  const retainedSignatures = {};
  for (const [signature, entryRaw] of Object.entries(memoryPayload.signatures)) {
    const entry = entryRaw && typeof entryRaw === 'object' ? { ...entryRaw } : null;
    if (!entry) {
      continue;
    }
    const entryScope = normalizeRecoveryMemoryToken(entry.scope || 'default-scope') || 'default-scope';
    if (scope && entryScope !== scope) {
      retainedSignatures[signature] = entry;
      continue;
    }
    const actions = entry.actions && typeof entry.actions === 'object' ? entry.actions : {};
    const retainedActions = {};
    for (const [actionKey, actionStatsRaw] of Object.entries(actions)) {
      const actionStats = actionStatsRaw && typeof actionStatsRaw === 'object' ? actionStatsRaw : null;
      if (!actionStats) {
        continue;
      }
      if (!isIsoTimestampOlderThan(actionStats.last_used_at, cutoffMs)) {
        retainedActions[actionKey] = actionStats;
      }
    }

    if (Object.keys(retainedActions).length > 0 || !isIsoTimestampOlderThan(entry.last_used_at, cutoffMs)) {
      retainedSignatures[signature] = {
        ...entry,
        actions: retainedActions
      };
    }
  }

  const nextPayload = {
    version: Number(memoryPayload.version) || 1,
    signatures: retainedSignatures
  };
  const filteredAfterPayload = scope
    ? filterRecoveryMemoryByScope(nextPayload, scope).payload
    : nextPayload;
  const signaturesAfter = summarizeRecoveryMemory(filteredAfterPayload).signature_count;
  const actionAfter = summarizeRecoveryMemory(filteredAfterPayload).action_count;
  if (!dryRun) {
    await fs.ensureDir(path.dirname(recoveryMemory.file));
    await fs.writeJson(recoveryMemory.file, nextPayload, { spaces: 2 });
  }

  return {
    mode: 'auto-recovery-memory-prune',
    file: recoveryMemory.file,
    scope,
    dry_run: dryRun,
    older_than_days: olderThanDays,
    signatures_before: signaturesBefore,
    signatures_after: signaturesAfter,
    actions_before: actionBefore,
    actions_after: actionAfter,
    signatures_removed: Math.max(0, signaturesBefore - signaturesAfter),
    actions_removed: Math.max(0, actionBefore - actionAfter)
  };
}

async function clearCloseLoopRecoveryMemory(projectPath) {
  const recoveryMemoryFile = getCloseLoopRecoveryMemoryFile(projectPath);
  const existed = await fs.pathExists(recoveryMemoryFile);
  if (existed) {
    await fs.remove(recoveryMemoryFile);
  }
  return {
    mode: 'auto-recovery-memory-clear',
    file: recoveryMemoryFile,
    existed,
    cleared: true
  };
}

function resolveRecoveryActionSelection(summaryPayload, actionCandidate, context = {}) {
  const diagnostics = summaryPayload && summaryPayload.program_diagnostics && typeof summaryPayload.program_diagnostics === 'object'
    ? summaryPayload.program_diagnostics
    : buildProgramDiagnostics(summaryPayload || {});
  const availableActions = Array.isArray(diagnostics.remediation_actions) && diagnostics.remediation_actions.length > 0
    ? diagnostics.remediation_actions
    : buildProgramRemediationActions(summaryPayload || {}, []);
  const optionLabel = typeof context.optionLabel === 'string' && context.optionLabel.trim()
    ? context.optionLabel.trim()
    : '--use-action';
  let selectedIndex = null;
  let selectionSource = 'default';
  let memorySelection = null;
  let selectionExplain = null;
  if (actionCandidate !== undefined && actionCandidate !== null) {
    selectedIndex = normalizeRecoveryActionIndex(actionCandidate, availableActions.length, optionLabel);
    selectionSource = 'explicit';
    selectionExplain = {
      mode: 'explicit',
      reason: `${optionLabel} provided`,
      selected_index: selectedIndex
    };
  } else {
    memorySelection = selectRecoveryActionFromMemory(availableActions, context.recoveryMemoryEntry);
    if (memorySelection) {
      selectedIndex = memorySelection.index;
      selectionSource = 'memory';
      selectionExplain = {
        mode: 'memory',
        reason: memorySelection.selection_reason,
        selected_index: selectedIndex,
        candidate_count: memorySelection.top_candidates.length,
        top_candidates: memorySelection.top_candidates
      };
    } else {
      selectedIndex = normalizeRecoveryActionIndex(undefined, availableActions.length);
      selectionExplain = {
        mode: 'default',
        reason: 'no matching memory entry found for current signature',
        selected_index: selectedIndex
      };
    }
  }
  const selectedAction = availableActions[selectedIndex - 1] || null;
  const appliedPatch = selectedAction && selectedAction.strategy_patch && typeof selectedAction.strategy_patch === 'object'
    ? { ...selectedAction.strategy_patch }
    : {};

  return {
    selectedIndex,
    selectedAction,
    availableActions,
    appliedPatch,
    selectionSource,
    memorySelection,
    selectionExplain
  };
}

function applyRecoveryActionPatch(options, selectedAction) {
  const baseOptions = { ...options };
  const patch = selectedAction && selectedAction.strategy_patch && typeof selectedAction.strategy_patch === 'object'
    ? selectedAction.strategy_patch
    : {};
  const merged = { ...baseOptions };

  if (patch.batchAutonomous !== undefined) {
    merged.batchAutonomous = Boolean(patch.batchAutonomous);
  }
  if (patch.continueOnError !== undefined && merged.continueOnError === undefined) {
    merged.continueOnError = Boolean(patch.continueOnError);
  }
  if (patch.batchParallel !== undefined && (merged.batchParallel === undefined || merged.batchParallel === null)) {
    merged.batchParallel = Number(patch.batchParallel);
  }
  if (patch.batchAgentBudget !== undefined && (merged.batchAgentBudget === undefined || merged.batchAgentBudget === null)) {
    merged.batchAgentBudget = Number(patch.batchAgentBudget);
  }
  if (patch.batchPriority !== undefined && (!merged.batchPriority || `${merged.batchPriority}`.trim().toLowerCase() === 'fifo')) {
    merged.batchPriority = patch.batchPriority;
  }
  if (patch.batchAgingFactor !== undefined && (merged.batchAgingFactor === undefined || merged.batchAgingFactor === null)) {
    merged.batchAgingFactor = Number(patch.batchAgingFactor);
  }
  if (patch.batchRetryRounds !== undefined && (merged.batchRetryRounds === undefined || merged.batchRetryRounds === null)) {
    merged.batchRetryRounds = Number(patch.batchRetryRounds);
  }
  if (patch.batchRetryUntilComplete !== undefined && merged.batchRetryUntilComplete === undefined) {
    merged.batchRetryUntilComplete = Boolean(patch.batchRetryUntilComplete);
  }
  if (patch.batchRetryMaxRounds !== undefined && (merged.batchRetryMaxRounds === undefined || merged.batchRetryMaxRounds === null)) {
    merged.batchRetryMaxRounds = Number(patch.batchRetryMaxRounds);
  }
  if (patch.dodTests !== undefined && !merged.dodTests) {
    merged.dodTests = patch.dodTests;
  }
  if (patch.dodTasksClosed !== undefined && merged.dodTasksClosed === undefined) {
    merged.dodTasksClosed = Boolean(patch.dodTasksClosed);
  }

  return merged;
}

async function buildCloseLoopBatchGoalsFromSummaryPayload(
  summary,
  summaryFile,
  projectPath,
  formatCandidate,
  resumeStrategyCandidate
) {
  const resumeStrategy = normalizeResumeStrategy(resumeStrategyCandidate);
  if (!summary || typeof summary !== 'object') {
    throw new Error(`Invalid batch summary payload: ${summaryFile}`);
  }
  if (!Array.isArray(summary.results)) {
    throw new Error(`Batch summary missing "results" array: ${summaryFile}`);
  }

  const retryStatuses = resumeStrategy === 'failed-only'
    ? new Set(['failed', 'error'])
    : new Set(['failed', 'error', 'unknown', 'stopped', 'planned', 'prepared']);
  const pendingByIndex = new Map();
  for (const item of summary.results) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const status = typeof item.status === 'string' ? item.status.trim().toLowerCase() : '';
    const goal = typeof item.goal === 'string' ? item.goal.trim() : '';
    const index = Number(item.index);
    if (!goal || !retryStatuses.has(status)) {
      continue;
    }
    if (Number.isInteger(index) && index > 0) {
      pendingByIndex.set(index, goal);
    } else {
      pendingByIndex.set(pendingByIndex.size + 1, goal);
    }
  }

  let sourceGoals = null;
  let resolvedGoalsFile = null;
  if (typeof summary.goals_file === 'string' && summary.goals_file.trim()) {
    const goalsFileCandidate = summary.goals_file.trim();
    const isSyntheticGoalsFile = goalsFileCandidate.startsWith('(') && goalsFileCandidate.endsWith(')');
    if (!isSyntheticGoalsFile) {
      const resolvedGoalsCandidate = path.isAbsolute(goalsFileCandidate)
        ? goalsFileCandidate
        : path.join(projectPath, goalsFileCandidate);
      if (await fs.pathExists(resolvedGoalsCandidate)) {
        const loadedSource = await loadCloseLoopBatchGoals(projectPath, goalsFileCandidate, formatCandidate);
        sourceGoals = loadedSource.goals;
        resolvedGoalsFile = loadedSource.file;
      }
    }
  }

  const totalGoals = Number(summary.total_goals);
  const processedGoals = Number(summary.processed_goals);
  if (
    resumeStrategy === 'pending' &&
    sourceGoals &&
    Number.isInteger(totalGoals) &&
    Number.isInteger(processedGoals) &&
    processedGoals < totalGoals
  ) {
    const seenIndexes = new Set(
      summary.results
        .map(item => Number(item && item.index))
        .filter(index => Number.isInteger(index) && index > 0)
    );
    for (let index = 1; index <= sourceGoals.length; index += 1) {
      if (!seenIndexes.has(index)) {
        pendingByIndex.set(index, sourceGoals[index - 1]);
      }
    }
  }

  const orderedPendingEntries = [...pendingByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sourceIndex, goal]) => ({
      goal,
      sourceIndex: Math.max(0, sourceIndex - 1)
    }));
  if (orderedPendingEntries.length === 0) {
    throw new Error(`No pending goals found in batch summary: ${summaryFile}`);
  }

  return {
    file: resolvedGoalsFile || summary.goals_file || '(derived-from-summary)',
    goals: orderedPendingEntries.map(item => item.goal),
    goal_entries: orderedPendingEntries,
    resumedFromSummary: {
      file: summaryFile,
      strategy: resumeStrategy,
      previous_status: summary.status || null,
      previous_total_goals: Number.isInteger(totalGoals) ? totalGoals : null,
      previous_processed_goals: Number.isInteger(processedGoals) ? processedGoals : null
    }
  };
}

async function loadCloseLoopBatchGoalsFromSummary(
  projectPath,
  summaryCandidate,
  formatCandidate,
  resumeStrategyCandidate
) {
  const summaryFile = await resolveCloseLoopBatchSummaryFile(projectPath, summaryCandidate);
  if (!(await fs.pathExists(summaryFile))) {
    throw new Error(`Batch summary file not found: ${summaryFile}`);
  }

  let summary = null;
  try {
    summary = await fs.readJson(summaryFile);
  } catch (error) {
    throw new Error(`Invalid batch summary JSON: ${summaryFile} (${error.message})`);
  }

  return buildCloseLoopBatchGoalsFromSummaryPayload(
    summary,
    summaryFile,
    projectPath,
    formatCandidate,
    resumeStrategyCandidate
  );
}

function buildBatchRunOptions(options) {
  return {
    subs: options.subs,
    maxParallel: options.maxParallel,
    prefix: options.prefix,
    dodTests: options.dodTests,
    dodTestsTimeout: options.dodTestsTimeout,
    dodDocs: options.dodDocs,
    dodCollab: options.dodCollab,
    dodTasksClosed: options.dodTasksClosed,
    dod: options.dod,
    dodReport: options.dodReport,
    session: options.session,
    sessionKeep: options.sessionKeep,
    sessionOlderThanDays: options.sessionOlderThanDays,
    replanStrategy: options.replanStrategy,
    replanAttempts: options.replanAttempts,
    replanNoProgressWindow: options.replanNoProgressWindow,
    replan: options.replan,
    run: options.run,
    stream: false,
    dryRun: options.dryRun,
    quiet: true
  };
}

function resolveBatchAutonomousPolicy(options, goalsCount = 0) {
  const enabled = !options || options.batchAutonomous !== false;
  const baseOptions = { ...options };
  if (!enabled) {
    return {
      options: baseOptions,
      summary: {
        enabled: false
      }
    };
  }

  const computedParallel = Math.max(
    1,
    Math.min(4, Math.min(Number.isInteger(goalsCount) ? goalsCount : 1, 20))
  );
  const effective = { ...baseOptions };

  effective.continueOnError = true;
  if (effective.batchParallel === undefined || effective.batchParallel === null) {
    effective.batchParallel = computedParallel;
  }
  if (
    effective.batchPriority === undefined ||
    effective.batchPriority === null ||
    `${effective.batchPriority}`.trim().toLowerCase() === 'fifo'
  ) {
    effective.batchPriority = 'complex-first';
  }
  if (effective.batchAgingFactor === undefined || effective.batchAgingFactor === null) {
    effective.batchAgingFactor = 2;
  }

  const hasExplicitRetryRounds = effective.batchRetryRounds !== undefined && effective.batchRetryRounds !== null;
  if (!hasExplicitRetryRounds && !effective.batchRetryUntilComplete) {
    effective.batchRetryUntilComplete = true;
  }

  return {
    options: effective,
    summary: {
      enabled: true,
      profile: 'closed-loop',
      auto_overrides: {
        continue_on_error: true,
        batch_parallel: effective.batchParallel,
        batch_priority: effective.batchPriority,
        batch_aging_factor: effective.batchAgingFactor,
        batch_retry_until_complete: Boolean(effective.batchRetryUntilComplete)
      }
    }
  };
}

function normalizeBatchParallel(batchParallelCandidate) {
  if (batchParallelCandidate === undefined || batchParallelCandidate === null) {
    return 1;
  }

  const parsed = Number(batchParallelCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error('--batch-parallel must be an integer between 1 and 20.');
  }
  return parsed;
}

function normalizeBatchAgentBudget(batchAgentBudgetCandidate) {
  if (batchAgentBudgetCandidate === undefined || batchAgentBudgetCandidate === null) {
    return null;
  }

  const parsed = Number(batchAgentBudgetCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error('--batch-agent-budget must be an integer between 1 and 500.');
  }
  return parsed;
}

function normalizeBatchPriorityStrategy(batchPriorityCandidate) {
  const normalized = typeof batchPriorityCandidate === 'string'
    ? batchPriorityCandidate.trim().toLowerCase()
    : 'fifo';
  if (!['fifo', 'complex-first', 'complex-last', 'critical-first'].includes(normalized)) {
    throw new Error('--batch-priority must be one of: fifo, complex-first, complex-last, critical-first.');
  }
  return normalized;
}

function normalizeBatchAgingFactor(batchAgingFactorCandidate) {
  if (batchAgingFactorCandidate === undefined || batchAgingFactorCandidate === null) {
    return 0;
  }

  const parsed = Number(batchAgingFactorCandidate);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error('--batch-aging-factor must be an integer between 0 and 100.');
  }
  return parsed;
}

function normalizeBatchRetryRounds(batchRetryRoundsCandidate) {
  if (batchRetryRoundsCandidate === undefined || batchRetryRoundsCandidate === null) {
    return 0;
  }

  const parsed = Number(batchRetryRoundsCandidate);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 5) {
    throw new Error('--batch-retry-rounds must be an integer between 0 and 5.');
  }
  return parsed;
}

function normalizeBatchRetryMaxRounds(batchRetryMaxRoundsCandidate) {
  if (batchRetryMaxRoundsCandidate === undefined || batchRetryMaxRoundsCandidate === null) {
    return 10;
  }

  const parsed = Number(batchRetryMaxRoundsCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error('--batch-retry-max-rounds must be an integer between 1 and 20.');
  }
  return parsed;
}

function normalizeRecoverMaxRounds(recoverMaxRoundsCandidate) {
  if (recoverMaxRoundsCandidate === undefined || recoverMaxRoundsCandidate === null) {
    return 5;
  }

  const parsed = Number(recoverMaxRoundsCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error('--recover-max-rounds must be an integer between 1 and 20.');
  }
  return parsed;
}

function normalizeRecoverMaxMinutes(recoverMaxMinutesCandidate, flagName = '--recover-max-minutes') {
  if (recoverMaxMinutesCandidate === undefined || recoverMaxMinutesCandidate === null) {
    return null;
  }

  const parsed = Number(recoverMaxMinutesCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10080) {
    throw new Error(`${flagName} must be an integer between 1 and 10080.`);
  }
  return parsed;
}

function normalizeRecoveryMemoryTtlDays(daysCandidate) {
  if (daysCandidate === undefined || daysCandidate === null) {
    return null;
  }
  const parsed = Number(daysCandidate);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 36500) {
    throw new Error('--recovery-memory-ttl-days must be an integer between 0 and 36500.');
  }
  return parsed;
}

function normalizeProgramMinSuccessRate(rateCandidate) {
  if (rateCandidate === undefined || rateCandidate === null) {
    return 100;
  }
  const parsed = Number(rateCandidate);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
    throw new Error('--program-min-success-rate must be a number between 0 and 100.');
  }
  return Number(parsed.toFixed(2));
}

function normalizeProgramGateProfile(profileCandidate) {
  const normalized = typeof profileCandidate === 'string'
    ? profileCandidate.trim().toLowerCase()
    : 'default';
  if (!PROGRAM_GATE_PROFILE_POLICY[normalized]) {
    throw new Error('--program-gate-profile must be one of: default, dev, staging, prod.');
  }
  return normalized;
}

function normalizeProgramGateFallbackProfile(profileCandidate) {
  const normalized = typeof profileCandidate === 'string'
    ? profileCandidate.trim().toLowerCase()
    : 'none';
  if (normalized === 'none') {
    return 'none';
  }
  if (!PROGRAM_GATE_PROFILE_POLICY[normalized]) {
    throw new Error('--program-gate-fallback-profile must be one of: none, default, dev, staging, prod.');
  }
  return normalized;
}

function normalizeProgramGateFallbackChain(chainCandidate) {
  if (chainCandidate === undefined || chainCandidate === null) {
    return null;
  }
  const raw = `${chainCandidate}`.trim();
  if (!raw) {
    return [];
  }
  const tokens = raw
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) {
    return [];
  }
  if (tokens.includes('none')) {
    if (tokens.length > 1) {
      throw new Error('--program-gate-fallback-chain cannot mix "none" with other profiles.');
    }
    return [];
  }
  const normalized = [];
  const seen = new Set();
  for (const token of tokens) {
    if (!PROGRAM_GATE_PROFILE_POLICY[token]) {
      throw new Error('--program-gate-fallback-chain must contain only: none, default, dev, staging, prod.');
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    normalized.push(token);
  }
  return normalized;
}

function resolveProgramGateFallbackChain(chainCandidate, fallbackProfileCandidate) {
  const parsedChain = normalizeProgramGateFallbackChain(chainCandidate);
  if (Array.isArray(parsedChain)) {
    return parsedChain;
  }
  const normalizedSingle = normalizeProgramGateFallbackProfile(fallbackProfileCandidate);
  return normalizedSingle === 'none' ? [] : [normalizedSingle];
}

function normalizeProgramRiskLevel(levelCandidate) {
  const normalized = typeof levelCandidate === 'string'
    ? levelCandidate.trim().toLowerCase()
    : 'high';
  if (!['low', 'medium', 'high'].includes(normalized)) {
    throw new Error('--program-max-risk-level must be one of: low, medium, high.');
  }
  return normalized;
}

function normalizeProgramMaxElapsedMinutes(minutesCandidate) {
  if (minutesCandidate === undefined || minutesCandidate === null) {
    return null;
  }
  const parsed = Number(minutesCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10080) {
    throw new Error('--program-max-elapsed-minutes must be an integer between 1 and 10080.');
  }
  return parsed;
}

function normalizeProgramMaxAgentBudget(budgetCandidate) {
  if (budgetCandidate === undefined || budgetCandidate === null) {
    return null;
  }
  const parsed = Number(budgetCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error('--program-max-agent-budget must be an integer between 1 and 500.');
  }
  return parsed;
}

function normalizeProgramMaxTotalSubSpecs(countCandidate) {
  if (countCandidate === undefined || countCandidate === null) {
    return null;
  }
  const parsed = Number(countCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500000) {
    throw new Error('--program-max-total-sub-specs must be an integer between 1 and 500000.');
  }
  return parsed;
}

function normalizeProgramGovernMaxRounds(roundsCandidate) {
  if (roundsCandidate === undefined || roundsCandidate === null) {
    return 3;
  }
  const parsed = Number(roundsCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error('--program-govern-max-rounds must be an integer between 1 and 20.');
  }
  return parsed;
}

function normalizeProgramGovernMaxMinutes(minutesCandidate) {
  if (minutesCandidate === undefined || minutesCandidate === null) {
    return 60;
  }
  const parsed = Number(minutesCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10080) {
    throw new Error('--program-govern-max-minutes must be an integer between 1 and 10080.');
  }
  return parsed;
}

function normalizeProgramGovernAnomalyWeeks(weeksCandidate) {
  if (weeksCandidate === undefined || weeksCandidate === null) {
    return 8;
  }
  const parsed = Number(weeksCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 260) {
    throw new Error('--program-govern-anomaly-weeks must be an integer between 1 and 260.');
  }
  return parsed;
}

function normalizeProgramGovernUseAction(actionCandidate) {
  if (actionCandidate === undefined || actionCandidate === null) {
    return null;
  }
  const parsed = Number(actionCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error('--program-govern-use-action must be an integer between 1 and 20.');
  }
  return parsed;
}

function normalizeControllerDequeueLimit(limitCandidate) {
  if (limitCandidate === undefined || limitCandidate === null) {
    return null;
  }
  const parsed = Number(limitCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('--dequeue-limit must be an integer between 1 and 100.');
  }
  return parsed;
}

function normalizeControllerPollSeconds(secondsCandidate) {
  if (secondsCandidate === undefined || secondsCandidate === null) {
    return 30;
  }
  const parsed = Number(secondsCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3600) {
    throw new Error('--poll-seconds must be an integer between 1 and 3600.');
  }
  return parsed;
}

function normalizeControllerMaxCycles(cyclesCandidate) {
  if (cyclesCandidate === undefined || cyclesCandidate === null) {
    return 1000;
  }
  const parsed = Number(cyclesCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100000) {
    throw new Error('--max-cycles must be an integer between 1 and 100000.');
  }
  return parsed;
}

function normalizeControllerMaxMinutes(minutesCandidate) {
  if (minutesCandidate === undefined || minutesCandidate === null) {
    return 120;
  }
  const parsed = Number(minutesCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10080) {
    throw new Error('--max-minutes must be an integer between 1 and 10080.');
  }
  return parsed;
}

function normalizeControllerLockTtlSeconds(secondsCandidate) {
  if (secondsCandidate === undefined || secondsCandidate === null) {
    return 1800;
  }
  const parsed = Number(secondsCandidate);
  if (!Number.isInteger(parsed) || parsed < 10 || parsed > 86400) {
    throw new Error('--controller-lock-ttl-seconds must be an integer between 10 and 86400.');
  }
  return parsed;
}

function normalizeControllerSessionKeep(keepCandidate) {
  if (keepCandidate === undefined || keepCandidate === null) {
    return null;
  }
  const parsed = Number(keepCandidate);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
    throw new Error('--controller-session-keep must be an integer between 0 and 1000.');
  }
  return parsed;
}

function normalizeControllerSessionOlderThanDays(daysCandidate) {
  if (daysCandidate === undefined || daysCandidate === null) {
    return null;
  }
  const parsed = Number(daysCandidate);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 36500) {
    throw new Error('--controller-session-older-than-days must be an integer between 0 and 36500.');
  }
  return parsed;
}

function resolveProgramGatePolicy(policy = {}) {
  const profile = normalizeProgramGateProfile(policy.profile);
  const profilePolicy = PROGRAM_GATE_PROFILE_POLICY[profile];
  const minSuccessRate = policy.minSuccessRate === undefined || policy.minSuccessRate === null
    ? normalizeProgramMinSuccessRate(profilePolicy.minSuccessRate)
    : normalizeProgramMinSuccessRate(policy.minSuccessRate);
  const maxRiskLevel = policy.maxRiskLevel === undefined || policy.maxRiskLevel === null
    ? normalizeProgramRiskLevel(profilePolicy.maxRiskLevel)
    : normalizeProgramRiskLevel(policy.maxRiskLevel);
  const maxElapsedMinutes = policy.maxElapsedMinutes === undefined || policy.maxElapsedMinutes === null
    ? normalizeProgramMaxElapsedMinutes(profilePolicy.maxElapsedMinutes)
    : normalizeProgramMaxElapsedMinutes(policy.maxElapsedMinutes);
  const maxAgentBudget = policy.maxAgentBudget === undefined || policy.maxAgentBudget === null
    ? normalizeProgramMaxAgentBudget(profilePolicy.maxAgentBudget)
    : normalizeProgramMaxAgentBudget(policy.maxAgentBudget);
  const maxTotalSubSpecs = policy.maxTotalSubSpecs === undefined || policy.maxTotalSubSpecs === null
    ? normalizeProgramMaxTotalSubSpecs(profilePolicy.maxTotalSubSpecs)
    : normalizeProgramMaxTotalSubSpecs(policy.maxTotalSubSpecs);
  return {
    profile,
    minSuccessRate,
    maxRiskLevel,
    maxElapsedMinutes,
    maxAgentBudget,
    maxTotalSubSpecs
  };
}

function normalizeBatchRetryStrategy(batchRetryStrategyCandidate) {
  const normalized = typeof batchRetryStrategyCandidate === 'string'
    ? batchRetryStrategyCandidate.trim().toLowerCase()
    : 'adaptive';
  if (!['adaptive', 'strict'].includes(normalized)) {
    throw new Error('--batch-retry-strategy must be one of: adaptive, strict.');
  }
  return normalized;
}

function resolveRequestedGoalMaxParallel(runOptions) {
  const parsed = Number(runOptions && runOptions.maxParallel);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function estimateGoalComplexityWeight(goal, runOptions = {}) {
  const explicitSubs = Number(runOptions.subs);
  if (Number.isInteger(explicitSubs) && explicitSubs > 0) {
    if (explicitSubs >= 5) {
      return 3;
    }
    if (explicitSubs >= 3) {
      return 2;
    }
    return 1;
  }

  const text = `${goal || ''}`.trim().toLowerCase();
  if (!text) {
    return 1;
  }

  const words = text.split(/\s+/).filter(Boolean).length;
  const clauseSignals = (text.match(/,|;| and | plus | with |并且|以及|并行|同时/g) || []).length;
  const domainSignals = (text.match(
    /orchestrat|integration|migration|observability|quality|security|performance|resilience|compliance|governance|闭环|主从|并行|重规划/g
  ) || []).length;

  let score = 0;
  if (words >= 25) {
    score += 2;
  } else if (words >= 12) {
    score += 1;
  }

  if (clauseSignals >= 4) {
    score += 2;
  } else if (clauseSignals >= 2) {
    score += 1;
  }

  if (domainSignals >= 4) {
    score += 1;
  }

  if (score >= 4) {
    return 3;
  }
  if (score >= 2) {
    return 2;
  }
  return 1;
}

function estimateGoalCriticalityWeight(goal) {
  const text = `${goal || ''}`.trim().toLowerCase();
  if (!text) {
    return 1;
  }

  const strongSignals = (text.match(
    /foundation|core|platform|infra|schema|migration|dependency|contract|baseline|bootstrap|关键路径|核心|基础|依赖|主干/g
  ) || []).length;
  const mediumSignals = (text.match(
    /orchestrat|integration|security|compliance|quality|governance|observability|性能|稳定|编排/g
  ) || []).length;
  if (strongSignals >= 2 || (strongSignals >= 1 && mediumSignals >= 1)) {
    return 3;
  }
  if (strongSignals >= 1 || mediumSignals >= 2) {
    return 2;
  }
  return 1;
}

function resolveGoalBasePriority(priorityStrategy, complexityWeight, criticalityWeight, index) {
  const inverseIndex = 100000 - index;
  if (priorityStrategy === 'critical-first') {
    return (criticalityWeight * 100000) + (complexityWeight * 1000) + inverseIndex;
  }
  if (priorityStrategy === 'complex-first') {
    return (complexityWeight * 10000) + inverseIndex;
  }
  if (priorityStrategy === 'complex-last') {
    return ((10 - complexityWeight) * 10000) + inverseIndex;
  }
  return inverseIndex;
}

function buildGoalExecutionPlans(goals, runOptions, agentBudget, priorityStrategy, goalEntriesCandidate = null) {
  const goalEntries = Array.isArray(goalEntriesCandidate) && goalEntriesCandidate.length === goals.length
    ? goalEntriesCandidate
    : goals.map((goal, index) => ({
      goal,
      sourceIndex: index,
      attempt: 1
    }));

  return goals.map((goal, index) => {
    const entry = goalEntries[index] || {};
    const sourceIndex = Number.isInteger(entry.sourceIndex) && entry.sourceIndex >= 0
      ? entry.sourceIndex
      : index;
    const attempt = Number.isInteger(entry.attempt) && entry.attempt > 0
      ? entry.attempt
      : 1;
    const complexityWeight = estimateGoalComplexityWeight(goal, runOptions);
    const criticalityWeight = estimateGoalCriticalityWeight(goal);
    const schedulingWeight = agentBudget === null
      ? 1
      : Math.max(1, Math.min(agentBudget, complexityWeight));
    const basePriority = resolveGoalBasePriority(priorityStrategy, complexityWeight, criticalityWeight, index);

    return {
      index,
      goal,
      source_index: sourceIndex,
      attempt,
      complexity_weight: complexityWeight,
      criticality_weight: criticalityWeight,
      scheduling_weight: schedulingWeight,
      base_priority: basePriority,
      wait_ticks: 0
    };
  });
}

function resolveEffectiveGoalParallel(baseParallel, slotBudget, goalPlans) {
  if (goalPlans.length === 0) {
    return 0;
  }

  if (!Number.isFinite(slotBudget)) {
    return Math.min(baseParallel, goalPlans.length);
  }

  const sortedWeights = goalPlans
    .map(plan => plan.scheduling_weight)
    .sort((a, b) => a - b);

  let used = 0;
  let count = 0;
  for (const weight of sortedWeights) {
    if (count >= baseParallel) {
      break;
    }
    if (used + weight > slotBudget) {
      break;
    }
    used += weight;
    count += 1;
  }

  return Math.max(1, Math.min(baseParallel, goalPlans.length, count));
}

function resolvePerGoalMaxParallel(requestedGoalMaxParallel, agentBudget, effectiveParallel) {
  if (agentBudget === null) {
    return requestedGoalMaxParallel;
  }

  const budgetBased = Math.max(1, Math.floor(agentBudget / Math.max(1, effectiveParallel)));
  if (requestedGoalMaxParallel === null) {
    return budgetBased;
  }

  return Math.max(1, Math.min(requestedGoalMaxParallel, budgetBased));
}

function parseSpecPrefixFromId(specId) {
  const match = `${specId || ''}`.match(/^(\d+)-\d{2}-/);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function resolveNextBatchGoalPrefix(projectPath) {
  const specs = await readSpecSessionEntries(projectPath);
  let maxPrefix = 0;
  for (const spec of specs) {
    const parsed = parseSpecPrefixFromId(spec && spec.id);
    if (parsed !== null && parsed > maxPrefix) {
      maxPrefix = parsed;
    }
  }
  return maxPrefix + 1;
}

async function allocateBatchGoalPrefixes(projectPath, goalCount, prefixCandidate) {
  if (!Number.isInteger(goalCount) || goalCount <= 0) {
    return [];
  }

  let startPrefix;
  if (prefixCandidate !== undefined && prefixCandidate !== null) {
    const parsed = Number(prefixCandidate);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error('--prefix must be a positive integer');
    }
    startPrefix = parsed;
  } else {
    startPrefix = await resolveNextBatchGoalPrefix(projectPath);
  }

  return Array.from({ length: goalCount }, (_item, index) => startPrefix + index);
}

function buildBatchResourcePlan(context) {
  const weights = context.goalPlans.map(plan => plan.scheduling_weight);
  const complexityWeights = context.goalPlans.map(plan => plan.complexity_weight);
  const criticalityWeights = context.goalPlans.map(plan => plan.criticality_weight || 1);
  const avgWeight = weights.length === 0
    ? 0
    : Number((weights.reduce((sum, item) => sum + item, 0) / weights.length).toFixed(2));
  const avgComplexityWeight = complexityWeights.length === 0
    ? 0
    : Number((complexityWeights.reduce((sum, item) => sum + item, 0) / complexityWeights.length).toFixed(2));
  const avgCriticalityWeight = criticalityWeights.length === 0
    ? 0
    : Number((criticalityWeights.reduce((sum, item) => sum + item, 0) / criticalityWeights.length).toFixed(2));

  return {
    agent_budget: context.agentBudget,
    weighted_scheduling_enabled: context.agentBudget !== null,
    scheduling_strategy: context.priorityStrategy,
    aging_factor: context.agingFactor,
    slot_budget: Number.isFinite(context.slotBudget) ? context.slotBudget : null,
    requested_goal_max_parallel: context.requestedGoalMaxParallel,
    per_goal_max_parallel: context.perGoalMaxParallel,
    base_goal_parallel: context.baseParallel,
    effective_goal_parallel: context.effectiveParallel,
    goal_weight_summary: {
      min: weights.length === 0 ? 0 : Math.min(...weights),
      max: weights.length === 0 ? 0 : Math.max(...weights),
      average: avgWeight
    },
    goal_complexity_summary: {
      min: complexityWeights.length === 0 ? 0 : Math.min(...complexityWeights),
      max: complexityWeights.length === 0 ? 0 : Math.max(...complexityWeights),
      average: avgComplexityWeight
    },
    goal_criticality_summary: {
      min: criticalityWeights.length === 0 ? 0 : Math.min(...criticalityWeights),
      max: criticalityWeights.length === 0 ? 0 : Math.max(...criticalityWeights),
      average: avgCriticalityWeight
    },
    max_wait_ticks: 0,
    starvation_wait_events: 0,
    max_used_slots: 0,
    max_concurrent_goals: 0
  };
}

function toBatchResultItem(index, goal, runResult, errorMessage = null, goalPlan = null) {
  const status = runResult && typeof runResult.status === 'string'
    ? runResult.status
    : errorMessage
      ? 'error'
      : 'unknown';
  const subSpecs = runResult && runResult.portfolio && Array.isArray(runResult.portfolio.sub_specs)
    ? runResult.portfolio.sub_specs
    : [];
  const sourceIndex = goalPlan && Number.isInteger(goalPlan.source_index)
    ? goalPlan.source_index
    : index;
  const attempt = goalPlan && Number.isInteger(goalPlan.attempt) && goalPlan.attempt > 0
    ? goalPlan.attempt
    : 1;
  const rateLimitTelemetry = extractBatchRateLimitTelemetry(runResult);

  return {
    index: sourceIndex + 1,
    source_index: sourceIndex,
    goal,
    status,
    master_spec: runResult && runResult.portfolio ? runResult.portfolio.master_spec : null,
    sub_spec_count: subSpecs.length,
    goal_weight: goalPlan && Number.isInteger(goalPlan.complexity_weight) ? goalPlan.complexity_weight : 1,
    criticality_weight: goalPlan && Number.isInteger(goalPlan.criticality_weight) ? goalPlan.criticality_weight : 1,
    scheduling_weight: goalPlan && Number.isInteger(goalPlan.scheduling_weight) ? goalPlan.scheduling_weight : 1,
    base_priority: goalPlan && Number.isFinite(goalPlan.base_priority) ? goalPlan.base_priority : null,
    wait_ticks: goalPlan && Number.isInteger(goalPlan.wait_ticks) ? goalPlan.wait_ticks : 0,
    batch_attempt: attempt,
    replan_cycles: runResult && runResult.replan ? Number(runResult.replan.performed || 0) : 0,
    rate_limit_signals: rateLimitTelemetry.signalCount,
    rate_limit_backoff_ms: rateLimitTelemetry.totalBackoffMs,
    rate_limit_launch_hold_ms: rateLimitTelemetry.lastLaunchHoldMs,
    error: errorMessage
  };
}

function extractBatchRateLimitTelemetry(runResult) {
  const orchestration = runResult && runResult.orchestration && typeof runResult.orchestration === 'object'
    ? runResult.orchestration
    : null;
  const rateLimit = orchestration && orchestration.rateLimit && typeof orchestration.rateLimit === 'object'
    ? orchestration.rateLimit
    : (
      orchestration &&
      orchestration.telemetry &&
      orchestration.telemetry.rateLimit &&
      typeof orchestration.telemetry.rateLimit === 'object'
        ? orchestration.telemetry.rateLimit
        : null
    );
  const signalCount = Number(rateLimit && rateLimit.signalCount);
  const totalBackoffMs = Number(rateLimit && rateLimit.totalBackoffMs);
  const lastLaunchHoldMs = Number(rateLimit && rateLimit.lastLaunchHoldMs);

  return {
    signalCount: Number.isFinite(signalCount) && signalCount > 0 ? Math.round(signalCount) : 0,
    totalBackoffMs: Number.isFinite(totalBackoffMs) && totalBackoffMs > 0 ? Math.round(totalBackoffMs) : 0,
    lastLaunchHoldMs: Number.isFinite(lastLaunchHoldMs) && lastLaunchHoldMs > 0 ? Math.round(lastLaunchHoldMs) : 0
  };
}

function toBatchUnprocessedResultItem(entry, attempt, reason) {
  const sourceIndex = Number.isInteger(entry && entry.sourceIndex) ? entry.sourceIndex : 0;
  const goal = entry && typeof entry.goal === 'string' ? entry.goal : '';
  return {
    index: sourceIndex + 1,
    source_index: sourceIndex,
    goal,
    status: 'stopped',
    master_spec: null,
    sub_spec_count: 0,
    goal_weight: 1,
    criticality_weight: 1,
    scheduling_weight: 1,
    base_priority: null,
    wait_ticks: 0,
    batch_attempt: attempt,
    replan_cycles: 0,
    rate_limit_signals: 0,
    rate_limit_backoff_ms: 0,
    rate_limit_launch_hold_ms: 0,
    error: reason
  };
}

function mergeBatchResourcePlans(base, incoming) {
  if (!base) {
    return incoming ? { ...incoming } : null;
  }
  if (!incoming) {
    return { ...base };
  }

  return {
    ...base,
    max_wait_ticks: Math.max(Number(base.max_wait_ticks) || 0, Number(incoming.max_wait_ticks) || 0),
    starvation_wait_events: (Number(base.starvation_wait_events) || 0) + (Number(incoming.starvation_wait_events) || 0),
    max_used_slots: Math.max(Number(base.max_used_slots) || 0, Number(incoming.max_used_slots) || 0),
    max_concurrent_goals: Math.max(Number(base.max_concurrent_goals) || 0, Number(incoming.max_concurrent_goals) || 0)
  };
}

function buildBatchMetrics(results, totalGoals) {
  const statusBreakdown = {};
  let totalSubSpecs = 0;
  let totalReplanCycles = 0;
  let totalGoalWeight = 0;
  let totalRateLimitSignals = 0;
  let totalRateLimitBackoffMs = 0;
  let maxRateLimitLaunchHoldMs = 0;
  for (const item of results) {
    const status = item && typeof item.status === 'string' ? item.status : 'unknown';
    statusBreakdown[status] = (statusBreakdown[status] || 0) + 1;
    totalSubSpecs += Number(item && item.sub_spec_count) || 0;
    totalReplanCycles += Number(item && item.replan_cycles) || 0;
    totalGoalWeight += Number(item && item.goal_weight) || 0;
    totalRateLimitSignals += Number(item && item.rate_limit_signals) || 0;
    totalRateLimitBackoffMs += Number(item && item.rate_limit_backoff_ms) || 0;
    maxRateLimitLaunchHoldMs = Math.max(maxRateLimitLaunchHoldMs, Number(item && item.rate_limit_launch_hold_ms) || 0);
  }

  const processedGoals = results.length;
  const completedGoals = statusBreakdown.completed || 0;
  const denominator = Number.isInteger(totalGoals) && totalGoals > 0 ? totalGoals : processedGoals || 1;
  const successRatePercent = Number(((completedGoals / denominator) * 100).toFixed(2));
  return {
    status_breakdown: statusBreakdown,
    success_rate_percent: successRatePercent,
    total_sub_specs: totalSubSpecs,
    average_sub_specs_per_goal: Number((totalSubSpecs / (processedGoals || 1)).toFixed(2)),
    total_goal_weight: totalGoalWeight,
    average_goal_weight: Number((totalGoalWeight / (processedGoals || 1)).toFixed(2)),
    total_replan_cycles: totalReplanCycles,
    average_replan_cycles_per_goal: Number((totalReplanCycles / (processedGoals || 1)).toFixed(2)),
    total_rate_limit_signals: totalRateLimitSignals,
    average_rate_limit_signals_per_goal: Number((totalRateLimitSignals / (processedGoals || 1)).toFixed(2)),
    total_rate_limit_backoff_ms: totalRateLimitBackoffMs,
    average_rate_limit_backoff_ms_per_goal: Number((totalRateLimitBackoffMs / (processedGoals || 1)).toFixed(2)),
    max_rate_limit_launch_hold_ms: maxRateLimitLaunchHoldMs
  };
}

function applyAdaptiveRateLimitBackpressure({
  currentBatchParallel,
  currentBatchAgentBudget,
  rateLimitSignals,
  rateLimitBackoffMs,
  rateLimitLaunchHoldMs,
  inputGoals
}) {
  const next = {
    batchParallel: Number.isInteger(currentBatchParallel) ? currentBatchParallel : 1,
    batchAgentBudget: currentBatchAgentBudget,
    applied: false,
    level: 'none',
    signalsPerGoal: 0
  };

  const safeGoals = Math.max(1, Number(inputGoals) || 1);
  const normalizedSignals = Math.max(0, Number(rateLimitSignals) || 0);
  const normalizedBackoffMs = Math.max(0, Number(rateLimitBackoffMs) || 0);
  const normalizedLaunchHoldMs = Math.max(0, Number(rateLimitLaunchHoldMs) || 0);
  const signalsPerGoal = normalizedSignals / safeGoals;
  next.signalsPerGoal = Number(signalsPerGoal.toFixed(2));

  if (normalizedSignals <= 0 && normalizedBackoffMs <= 0 && normalizedLaunchHoldMs <= 0) {
    return next;
  }

  const severePressure = (
    signalsPerGoal >= 1.5 ||
    normalizedBackoffMs >= 4000 ||
    normalizedLaunchHoldMs >= 2000
  );
  next.level = severePressure ? 'severe' : 'mild';

  const normalizePositiveInteger = (value, fallback = 1) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return fallback;
    }
    return parsed;
  };

  const currentParallel = normalizePositiveInteger(next.batchParallel, 1);
  const reducedParallel = severePressure
    ? Math.max(1, Math.floor(currentParallel / 2))
    : Math.max(1, currentParallel - 1);
  next.batchParallel = reducedParallel;
  next.applied = reducedParallel !== currentParallel;

  if (currentBatchAgentBudget !== null && currentBatchAgentBudget !== undefined) {
    const currentBudget = normalizePositiveInteger(currentBatchAgentBudget, 1);
    const reducedBudget = severePressure
      ? Math.max(1, Math.floor(currentBudget / 2))
      : Math.max(1, currentBudget - 1);
    next.batchAgentBudget = reducedBudget;
    next.applied = next.applied || reducedBudget !== currentBudget;
  }

  return next;
}

async function runCloseLoopBatchGoals(goals, options) {
  const continueOnError = Boolean(options.continueOnError);
  const batchParallel = normalizeBatchParallel(options.batchParallel);
  const baseParallel = continueOnError ? batchParallel : 1;
  const agentBudget = normalizeBatchAgentBudget(options.batchAgentBudget);
  const priorityStrategy = normalizeBatchPriorityStrategy(options.batchPriority);
  const agingFactor = normalizeBatchAgingFactor(options.batchAgingFactor);
  const runOptions = options.runOptions || {};
  const batchAttempt = Number.isInteger(options.batchAttempt) && options.batchAttempt > 0
    ? options.batchAttempt
    : 1;
  const projectPath = typeof options.projectPath === 'string' && options.projectPath.trim()
    ? options.projectPath
    : process.cwd();
  const requestedGoalMaxParallel = resolveRequestedGoalMaxParallel(runOptions);
  const slotBudget = agentBudget === null ? Number.POSITIVE_INFINITY : agentBudget;
  const goalPlans = buildGoalExecutionPlans(
    goals,
    runOptions,
    agentBudget,
    priorityStrategy,
    options.goalEntries
  );
  const effectiveParallel = resolveEffectiveGoalParallel(baseParallel, slotBudget, goalPlans);
  const perGoalMaxParallel = resolvePerGoalMaxParallel(requestedGoalMaxParallel, agentBudget, effectiveParallel);
  const effectiveRunOptions = { ...runOptions };
  if (perGoalMaxParallel !== null) {
    effectiveRunOptions.maxParallel = perGoalMaxParallel;
  }
  const allocatedPrefixes = await allocateBatchGoalPrefixes(
    projectPath,
    goalPlans.length,
    effectiveRunOptions.prefix
  );
  const goalPlansByIndex = goalPlans.map(plan => ({
    ...plan,
    attempt: batchAttempt,
    run_options: {
      ...effectiveRunOptions,
      prefix: allocatedPrefixes[plan.index]
    }
  }));
  const resourcePlan = buildBatchResourcePlan({
    goalPlans: goalPlansByIndex,
    agentBudget,
    slotBudget,
    requestedGoalMaxParallel,
    perGoalMaxParallel,
    baseParallel,
    effectiveParallel,
    priorityStrategy,
    agingFactor
  });
  const results = new Array(goals.length);
  const pendingIndexes = new Set(goalPlansByIndex.map(plan => plan.index));
  const activeRuns = new Map();
  let usedSlots = 0;
  let stopLaunch = false;

  const scoreGoalPlan = plan => {
    return plan.base_priority + (plan.wait_ticks * agingFactor);
  };

  const pickHighestPriorityPendingPlan = () => {
    const candidates = goalPlansByIndex
      .filter(plan => pendingIndexes.has(plan.index));
    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((left, right) => {
      const scoreDelta = scoreGoalPlan(right) - scoreGoalPlan(left);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      const indexDelta = left.index - right.index;
      if (indexDelta !== 0) {
        return indexDelta;
      }
      return right.scheduling_weight - left.scheduling_weight;
    });

    return candidates[0];
  };

  const pickNextGoalPlan = () => {
    if (stopLaunch) {
      return {
        plan: null,
        blockedByBudget: false
      };
    }

    const topPlan = pickHighestPriorityPendingPlan();
    if (!topPlan) {
      return {
        plan: null,
        blockedByBudget: false
      };
    }

    if (usedSlots + topPlan.scheduling_weight <= slotBudget) {
      return {
        plan: topPlan,
        blockedByBudget: false
      };
    }

    return {
      plan: null,
      blockedByBudget: true
    };
  };

  const agePendingGoalPlans = () => {
    for (const plan of goalPlansByIndex) {
      if (pendingIndexes.has(plan.index)) {
        plan.wait_ticks += 1;
      }
    }
    const pendingWaits = goalPlansByIndex
      .filter(plan => pendingIndexes.has(plan.index))
      .map(plan => plan.wait_ticks);
    if (pendingWaits.length > 0) {
      resourcePlan.max_wait_ticks = Math.max(resourcePlan.max_wait_ticks, ...pendingWaits);
    }
  };

  const launchGoal = plan => {
    pendingIndexes.delete(plan.index);
    usedSlots += plan.scheduling_weight;
    resourcePlan.max_used_slots = Math.max(resourcePlan.max_used_slots, usedSlots);
    resourcePlan.max_concurrent_goals = Math.max(resourcePlan.max_concurrent_goals, activeRuns.size + 1);

    const runPromise = (async () => {
      try {
        const runResult = await runAutoCloseLoop(plan.goal, { ...plan.run_options });
        results[plan.index] = toBatchResultItem(plan.index, plan.goal, runResult, null, plan);
        if (runResult.status === 'failed' && !continueOnError) {
          stopLaunch = true;
        }
      } catch (error) {
        results[plan.index] = toBatchResultItem(plan.index, plan.goal, null, error.message, plan);
        if (!continueOnError) {
          stopLaunch = true;
        }
      } finally {
        usedSlots = Math.max(0, usedSlots - plan.scheduling_weight);
        activeRuns.delete(plan.index);
      }
    })();

    activeRuns.set(plan.index, runPromise);
  };

  while (true) {
    while (activeRuns.size < effectiveParallel) {
      const next = pickNextGoalPlan();
      if (!next.plan) {
        if (next.blockedByBudget && activeRuns.size > 0) {
          resourcePlan.starvation_wait_events += 1;
        }
        break;
      }
      launchGoal(next.plan);
    }

    if (activeRuns.size === 0) {
      break;
    }

    await Promise.race([...activeRuns.values()]);
    agePendingGoalPlans();
  }

  const compactResults = results
    .filter(Boolean)
    .sort((left, right) => {
      const leftIndex = Number.isInteger(left && left.source_index) ? left.source_index : Number(left && left.index) - 1;
      const rightIndex = Number.isInteger(right && right.source_index) ? right.source_index : Number(right && right.index) - 1;
      return leftIndex - rightIndex;
    });
  return {
    effectiveParallel,
    resourcePlan,
    results: compactResults,
    raw_results: results,
    stoppedEarly: !continueOnError && compactResults.length < goals.length
  };
}

async function runCloseLoopBatchWithRetries(goals, options) {
  const retryUntilComplete = Boolean(options.batchRetryUntilComplete);
  const configuredRetryRounds = normalizeBatchRetryRounds(options.batchRetryRounds);
  const retryMaxRounds = retryUntilComplete
    ? normalizeBatchRetryMaxRounds(options.batchRetryMaxRounds)
    : configuredRetryRounds;
  const retryStrategy = normalizeBatchRetryStrategy(options.batchRetryStrategy);
  const initialContinueOnError = Boolean(options.continueOnError);
  const failedStatuses = new Set(['failed', 'error', 'unknown', 'stopped']);
  const finalResultsBySource = new Map();
  const retryHistory = [];
  let aggregateResourcePlan = null;
  let effectiveParallel = 0;
  let stoppedEarly = false;
  const configuredBatchParallel = normalizeBatchParallel(options.batchParallel);
  const configuredBatchAgentBudget = normalizeBatchAgentBudget(options.batchAgentBudget);
  let adaptiveBatchParallel = configuredBatchParallel;
  let adaptiveBatchAgentBudget = configuredBatchAgentBudget;

  let round = 0;
  let pendingEntries = Array.isArray(options.goalEntries) && options.goalEntries.length > 0
    ? options.goalEntries
      .map((entry, index) => ({
        goal: entry && typeof entry.goal === 'string' ? entry.goal : goals[index],
        sourceIndex: Number.isInteger(entry && entry.sourceIndex) && entry.sourceIndex >= 0
          ? entry.sourceIndex
          : index,
        attempt: 1
      }))
      .filter(entry => typeof entry.goal === 'string' && entry.goal.trim().length > 0)
    : goals.map((goal, index) => ({
      goal,
      sourceIndex: index,
      attempt: 1
    }));
  let exhausted = false;

  while (pendingEntries.length > 0) {
    const batchAttempt = round + 1;
    const roundContinueOnError = round === 0
      ? initialContinueOnError
      : retryStrategy === 'adaptive'
        ? true
        : initialContinueOnError;
    const run = await runCloseLoopBatchGoals(
      pendingEntries.map(entry => entry.goal),
      {
        ...options,
        batchParallel: adaptiveBatchParallel,
        batchAgentBudget: adaptiveBatchAgentBudget,
        continueOnError: roundContinueOnError,
        goalEntries: pendingEntries,
        batchAttempt
      }
    );

    effectiveParallel = Math.max(effectiveParallel, Number(run.effectiveParallel) || 0);
    aggregateResourcePlan = mergeBatchResourcePlans(aggregateResourcePlan, run.resourcePlan);
    stoppedEarly = stoppedEarly || Boolean(run.stoppedEarly);

    const retryEntries = [];
    let failedCount = 0;
    let unprocessedCount = 0;
    for (let localIndex = 0; localIndex < pendingEntries.length; localIndex += 1) {
      const entry = pendingEntries[localIndex];
      const runItemRaw = Array.isArray(run.raw_results) ? run.raw_results[localIndex] : null;
      const runItem = runItemRaw
        ? {
          ...runItemRaw,
          index: entry.sourceIndex + 1,
          source_index: entry.sourceIndex,
          goal: entry.goal,
          batch_attempt: batchAttempt
        }
        : null;
      if (!runItem) {
        unprocessedCount += 1;
        retryEntries.push({
          goal: entry.goal,
          sourceIndex: entry.sourceIndex,
          attempt: batchAttempt + 1
        });
        continue;
      }

      const status = typeof runItem.status === 'string' ? runItem.status : 'unknown';
      finalResultsBySource.set(entry.sourceIndex, runItem);
      if (failedStatuses.has(status)) {
        failedCount += 1;
        retryEntries.push({
          goal: entry.goal,
          sourceIndex: entry.sourceIndex,
          attempt: batchAttempt + 1
        });
      }
    }

    const roundMetrics = buildBatchMetrics(run.results, pendingEntries.length);
    const roundRateLimitSignals = Number(roundMetrics.total_rate_limit_signals) || 0;
    const roundRateLimitBackoffMs = Number(roundMetrics.total_rate_limit_backoff_ms) || 0;
    const roundMaxLaunchHoldMs = Number(roundMetrics.max_rate_limit_launch_hold_ms) || 0;
    let nextBatchParallel = adaptiveBatchParallel;
    let nextBatchAgentBudget = adaptiveBatchAgentBudget;
    let adaptiveBackpressureApplied = false;
    let backpressureLevel = 'none';
    let roundRateLimitSignalsPerGoal = Number(
      (roundRateLimitSignals / Math.max(1, pendingEntries.length)).toFixed(2)
    );
    const hasRateLimitPressure = roundRateLimitSignals > 0 || roundRateLimitBackoffMs > 0 || roundMaxLaunchHoldMs > 0;
    if (retryStrategy === 'adaptive' && retryEntries.length > 0 && hasRateLimitPressure) {
      const backpressure = applyAdaptiveRateLimitBackpressure({
        currentBatchParallel: adaptiveBatchParallel,
        currentBatchAgentBudget: adaptiveBatchAgentBudget,
        rateLimitSignals: roundRateLimitSignals,
        rateLimitBackoffMs: roundRateLimitBackoffMs,
        rateLimitLaunchHoldMs: roundMaxLaunchHoldMs,
        inputGoals: pendingEntries.length
      });
      nextBatchParallel = backpressure.batchParallel;
      nextBatchAgentBudget = backpressure.batchAgentBudget;
      adaptiveBackpressureApplied = backpressure.applied;
      backpressureLevel = backpressure.level;
      roundRateLimitSignalsPerGoal = backpressure.signalsPerGoal;
    }

    retryHistory.push({
      round: batchAttempt,
      continue_on_error: roundContinueOnError,
      applied_batch_parallel: adaptiveBatchParallel,
      applied_batch_agent_budget: adaptiveBatchAgentBudget,
      input_goals: pendingEntries.length,
      processed_goals: run.results.length,
      failed_goals: failedCount,
      unprocessed_goals: unprocessedCount,
      stopped_early: Boolean(run.stoppedEarly),
      rate_limit_signals: roundRateLimitSignals,
      rate_limit_signals_per_goal: roundRateLimitSignalsPerGoal,
      rate_limit_backoff_ms: roundRateLimitBackoffMs,
      rate_limit_launch_hold_ms: roundMaxLaunchHoldMs,
      adaptive_backpressure_applied: adaptiveBackpressureApplied,
      backpressure_level: backpressureLevel,
      next_batch_parallel: nextBatchParallel,
      next_batch_agent_budget: nextBatchAgentBudget
    });

    if (retryEntries.length === 0) {
      break;
    }

    if (round >= retryMaxRounds) {
      exhausted = true;
      for (const entry of retryEntries) {
        if (!finalResultsBySource.has(entry.sourceIndex)) {
          finalResultsBySource.set(
            entry.sourceIndex,
            toBatchUnprocessedResultItem(
              entry,
              batchAttempt,
              'Goal was not processed before batch retry budget was exhausted.'
            )
          );
        }
      }
      break;
    }

    round += 1;
    pendingEntries = retryEntries;
    adaptiveBatchParallel = nextBatchParallel;
    adaptiveBatchAgentBudget = nextBatchAgentBudget;
  }

  const orderedResults = goals
    .map((goal, index) => finalResultsBySource.get(index) || toBatchUnprocessedResultItem(
      { goal, sourceIndex: index },
      round + 1,
      'Goal was not processed.'
    ));
  const effectivePerformedRounds = Math.min(retryMaxRounds, Math.max(0, retryHistory.length - 1));
  const totalRateLimitSignals = retryHistory.reduce((sum, item) => {
    return sum + (Number(item && item.rate_limit_signals) || 0);
  }, 0);
  const totalRateLimitBackoffMs = retryHistory.reduce((sum, item) => {
    return sum + (Number(item && item.rate_limit_backoff_ms) || 0);
  }, 0);
  const totalRateLimitLaunchHoldMs = retryHistory.reduce((sum, item) => {
    return sum + (Number(item && item.rate_limit_launch_hold_ms) || 0);
  }, 0);
  const rateLimitPressureDetected =
    totalRateLimitSignals > 0 || totalRateLimitBackoffMs > 0 || totalRateLimitLaunchHoldMs > 0;
  const rateLimitRecoveryRecommended = exhausted && rateLimitPressureDetected;

  const safeBatchParallel = Number.isInteger(configuredBatchParallel)
    ? configuredBatchParallel
    : 1;
  const safeBatchAgentBudget = Number.isInteger(configuredBatchAgentBudget)
    ? configuredBatchAgentBudget
    : null;
  const recommendedBatchParallel = Math.max(1, Math.min(2, safeBatchParallel));
  const recommendedBatchAgentBudget = safeBatchAgentBudget === null
    ? 2
    : Math.max(1, Math.min(2, safeBatchAgentBudget));
  const recommendedRetryMaxRounds = Math.max(2, Math.min(20, retryMaxRounds + 2));
  const recoveryPatch = rateLimitRecoveryRecommended
    ? {
      batch_parallel: recommendedBatchParallel,
      batch_agent_budget: recommendedBatchAgentBudget,
      batch_retry_until_complete: true,
      batch_retry_strategy: 'adaptive',
      batch_retry_max_rounds: recommendedRetryMaxRounds
    }
    : null;
  const recoverySuggestedCommand = rateLimitRecoveryRecommended
    ? [
      'sce auto close-loop-recover latest',
      `--batch-parallel ${recommendedBatchParallel}`,
      `--batch-agent-budget ${recommendedBatchAgentBudget}`,
      '--batch-retry-until-complete',
      '--batch-retry-strategy adaptive',
      `--batch-retry-max-rounds ${recommendedRetryMaxRounds}`,
      '--json'
    ].join(' ')
    : null;

  return {
    effectiveParallel,
    resourcePlan: aggregateResourcePlan,
    results: orderedResults,
    stoppedEarly: stoppedEarly && exhausted,
    retry: {
      enabled: retryMaxRounds > 0,
      strategy: retryStrategy,
      until_complete: retryUntilComplete,
      configured_rounds: configuredRetryRounds,
      max_rounds: retryMaxRounds,
      performed_rounds: effectivePerformedRounds,
      exhausted,
      rate_limit_pressure_detected: rateLimitPressureDetected,
      total_rate_limit_signals: totalRateLimitSignals,
      total_rate_limit_backoff_ms: totalRateLimitBackoffMs,
      total_rate_limit_launch_hold_ms: totalRateLimitLaunchHoldMs,
      recovery_recommended: rateLimitRecoveryRecommended,
      recovery_patch: recoveryPatch,
      recovery_suggested_command: recoverySuggestedCommand,
      history: retryHistory
    }
  };
}

function normalizeGoalFingerprint(goal) {
  return `${goal || ''}`.trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildGoalInputGuard(goals, options = {}) {
  const sourceGoals = Array.isArray(goals) ? goals : [];
  const maxDuplicateGoals = normalizeSpecSessionMaxDuplicateGoals(options.specSessionMaxDuplicateGoals);
  const goalCounts = new Map();
  for (const goal of sourceGoals) {
    const fingerprint = normalizeGoalFingerprint(goal);
    if (!fingerprint) {
      continue;
    }
    goalCounts.set(fingerprint, (goalCounts.get(fingerprint) || 0) + 1);
  }
  const duplicates = [];
  let duplicateGoals = 0;
  for (const [goal, count] of goalCounts.entries()) {
    if (count <= 1) {
      continue;
    }
    duplicates.push({ goal, count });
    duplicateGoals += (count - 1);
  }
  duplicates.sort((left, right) => right.count - left.count || left.goal.localeCompare(right.goal));
  const overLimit = maxDuplicateGoals !== null && duplicateGoals > maxDuplicateGoals;
  return {
    enabled: maxDuplicateGoals !== null,
    max_duplicate_goals: maxDuplicateGoals,
    duplicate_goals: duplicateGoals,
    unique_goals: goalCounts.size,
    duplicate_examples: duplicates.slice(0, 20),
    over_limit: overLimit,
    hard_fail_triggered: Boolean(options.specSessionBudgetHardFail && overLimit)
  };
}

function buildSpecSessionGrowthGuard(summary, options = {}) {
  const maxCreated = normalizeSpecSessionMaxCreated(options.specSessionMaxCreated);
  const maxCreatedPerGoal = normalizeSpecSessionMaxCreatedPerGoal(options.specSessionMaxCreatedPerGoal);
  const budget = summary && summary.spec_session_budget && summary.spec_session_budget.enabled
    ? summary.spec_session_budget
    : null;
  const estimatedCreated = Number(budget && budget.estimated_created) || 0;
  const processedGoals = Number(summary && summary.processed_goals) || 0;
  const createdPerGoal = processedGoals > 0
    ? Number((estimatedCreated / processedGoals).toFixed(2))
    : (estimatedCreated > 0 ? estimatedCreated : 0);
  const reasons = [];
  if (maxCreated !== null && estimatedCreated > maxCreated) {
    reasons.push(`estimated_created ${estimatedCreated} exceeds allowed ${maxCreated}`);
  }
  if (maxCreatedPerGoal !== null && createdPerGoal > maxCreatedPerGoal) {
    reasons.push(`estimated_created_per_goal ${createdPerGoal} exceeds allowed ${maxCreatedPerGoal}`);
  }
  return {
    enabled: maxCreated !== null || maxCreatedPerGoal !== null,
    max_created: maxCreated,
    max_created_per_goal: maxCreatedPerGoal,
    estimated_created: estimatedCreated,
    estimated_created_per_goal: createdPerGoal,
    over_limit: reasons.length > 0,
    reasons,
    hard_fail_triggered: Boolean(options.specSessionBudgetHardFail && reasons.length > 0)
  };
}

function isSpecSessionGrowthGuardHardFailure(summary) {
  return Boolean(
    summary &&
    summary.spec_session_growth_guard &&
    summary.spec_session_growth_guard.enabled &&
    summary.spec_session_growth_guard.hard_fail_triggered
  );
}

async function startSpecSessionBudgetEvaluation(projectPath, options = {}) {
  const maxTotal = normalizeSpecSessionMaxTotal(options.specSessionMaxTotal);
  const maxCreated = normalizeSpecSessionMaxCreated(options.specSessionMaxCreated);
  const maxCreatedPerGoal = normalizeSpecSessionMaxCreatedPerGoal(options.specSessionMaxCreatedPerGoal);
  if (maxTotal === null && maxCreated === null && maxCreatedPerGoal === null) {
    return null;
  }
  const specs = await readSpecSessionEntries(projectPath);
  const totalBefore = specs.length;
  const overLimitBefore = maxTotal !== null ? totalBefore > maxTotal : false;
  return {
    enabled: true,
    max_total: maxTotal,
    max_created: maxCreated,
    max_created_per_goal: maxCreatedPerGoal,
    hard_fail: Boolean(options.specSessionBudgetHardFail),
    total_before: totalBefore,
    over_limit_before: overLimitBefore
  };
}

async function finalizeSpecSessionBudgetEvaluation(projectPath, budgetSnapshot, pruneSummary = null) {
  if (!budgetSnapshot || !budgetSnapshot.enabled) {
    return null;
  }
  const specsAfter = await readSpecSessionEntries(projectPath);
  const totalAfter = specsAfter.length;
  const prunedCount = Number(pruneSummary && pruneSummary.deleted_count) || 0;
  const estimatedCreated = Math.max(0, totalAfter + prunedCount - budgetSnapshot.total_before);
  const overLimitAfter = budgetSnapshot.max_total !== null
    ? totalAfter > budgetSnapshot.max_total
    : false;
  return {
    ...budgetSnapshot,
    total_after: totalAfter,
    pruned_count: prunedCount,
    estimated_created: estimatedCreated,
    over_limit_after: overLimitAfter,
    hard_fail_triggered: Boolean(budgetSnapshot.hard_fail && overLimitAfter)
  };
}

function isSpecSessionBudgetHardFailure(summary) {
  return Boolean(
    summary &&
    summary.spec_session_budget &&
    summary.spec_session_budget.enabled &&
    summary.spec_session_budget.hard_fail_triggered
  );
}

async function executeCloseLoopBatch(goalsResult, options, projectPath, mode = 'auto-close-loop-batch') {
  const goalInputGuard = buildGoalInputGuard(goalsResult && goalsResult.goals, options);
  if (goalInputGuard.over_limit && goalInputGuard.hard_fail_triggered) {
    throw new Error(
      `Goal input duplicate guard exceeded: ${goalInputGuard.duplicate_goals} > ${goalInputGuard.max_duplicate_goals}. ` +
      'Reduce duplicated goals or raise --spec-session-max-duplicate-goals.'
    );
  }
  const specSessionBudget = await startSpecSessionBudgetEvaluation(projectPath, options);
  if (specSessionBudget && specSessionBudget.hard_fail && specSessionBudget.over_limit_before) {
    throw new Error(
      `Spec session budget exceeded before run: ${specSessionBudget.total_before} > ${specSessionBudget.max_total}. ` +
      'Run "sce auto spec-session prune ..." or raise --spec-session-max-total.'
    );
  }
  const batchAutonomousPolicy = resolveBatchAutonomousPolicy(options, goalsResult.goals.length);
  const effectiveBatchOptions = batchAutonomousPolicy.options;
  const batchParallel = normalizeBatchParallel(effectiveBatchOptions.batchParallel);
  const batchRun = await runCloseLoopBatchWithRetries(goalsResult.goals, {
    projectPath,
    continueOnError: Boolean(effectiveBatchOptions.continueOnError),
    batchParallel,
    batchAgentBudget: effectiveBatchOptions.batchAgentBudget,
    batchPriority: effectiveBatchOptions.batchPriority,
    batchAgingFactor: effectiveBatchOptions.batchAgingFactor,
    batchRetryRounds: effectiveBatchOptions.batchRetryRounds,
    batchRetryStrategy: effectiveBatchOptions.batchRetryStrategy,
    batchRetryUntilComplete: effectiveBatchOptions.batchRetryUntilComplete,
    batchRetryMaxRounds: effectiveBatchOptions.batchRetryMaxRounds,
    goalEntries: Array.isArray(goalsResult.goal_entries) ? goalsResult.goal_entries : null,
    runOptions: buildBatchRunOptions(effectiveBatchOptions)
  });

  const results = batchRun.results;
  const stoppedEarly = batchRun.stoppedEarly;
  const failedStatuses = new Set(['failed', 'error', 'unknown', 'stopped']);
  const failedGoals = results.filter(item => failedStatuses.has(item.status)).length;
  const completedGoals = results.length - failedGoals;
  const status = failedGoals === 0
    ? 'completed'
    : completedGoals === 0
      ? 'failed'
      : 'partial-failed';
  const metrics = buildBatchMetrics(results, goalsResult.goals.length);

  const summary = {
    mode,
    status,
    goals_file: goalsResult.file,
    resumed_from_summary: goalsResult.resumedFromSummary || null,
    generated_from_goal: goalsResult.generatedFromGoal || null,
    total_goals: goalsResult.goals.length,
    processed_goals: results.length,
    completed_goals: completedGoals,
    failed_goals: failedGoals,
    batch_parallel: batchRun.effectiveParallel,
    autonomous_policy: batchAutonomousPolicy.summary,
    resource_plan: batchRun.resourcePlan,
    batch_retry: batchRun.retry,
    stopped_early: stoppedEarly,
    metrics,
    goal_input_guard: goalInputGuard,
    results
  };

  const currentRunSpecNames = collectSpecNamesFromBatchSummary(summary);
  summary.spec_session_prune = await maybePruneSpecSessionsWithPolicy(
    projectPath,
    options,
    currentRunSpecNames
  );
  summary.spec_session_budget = await finalizeSpecSessionBudgetEvaluation(
    projectPath,
    specSessionBudget,
    summary.spec_session_prune
  );
  summary.spec_session_growth_guard = buildSpecSessionGrowthGuard(summary, options);

  if (mode === 'auto-close-loop-program' || mode === 'auto-close-loop-recover') {
    summary.program_kpi = buildProgramKpiSnapshot(summary);
    summary.program_diagnostics = buildProgramDiagnostics(summary);
    summary.program_coordination = buildProgramCoordinationSnapshot(summary);
    await maybeWriteProgramKpi(summary, options.programKpiOut, projectPath);
  }

  await maybePersistCloseLoopBatchSummary(summary, options, projectPath);
  await maybeWriteOutput(summary, options.out, projectPath);

  return summary;
}

async function executeCloseLoopProgramGoal(goal, options = {}, context = {}) {
  const programStartedAt = Date.now();
  const projectPath = context.projectPath || process.cwd();
  const shouldPrintSummary = context.printSummary !== false;
  const writeOutputs = context.writeOutputs !== false;
  const programAutonomousEnabled = options.batchAutonomous !== false;
  const programAutoRecoverEnabled = options.programAutoRecover !== false;
  const programRecoverMaxRounds = normalizeRecoverMaxRounds(options.programRecoverMaxRounds);
  const programRecoverMaxMinutes = normalizeRecoverMaxMinutes(options.programRecoverMaxMinutes, '--program-recover-max-minutes');
  const programRecoverResumeStrategy = normalizeResumeStrategy(options.programRecoverResumeStrategy);
  const programGovernUntilStable = Boolean(options.programGovernUntilStable);
  const programGovernMaxRounds = normalizeProgramGovernMaxRounds(options.programGovernMaxRounds);
  const programGovernMaxMinutes = normalizeProgramGovernMaxMinutes(options.programGovernMaxMinutes);
  const programGovernAnomalyEnabled = options.programGovernAnomaly !== false;
  const programGovernAnomalyWeeks = normalizeProgramGovernAnomalyWeeks(options.programGovernAnomalyWeeks);
  const programGovernAnomalyPeriod = normalizeAutoKpiTrendPeriod(options.programGovernAnomalyPeriod);
  const programGovernUseAction = normalizeProgramGovernUseAction(options.programGovernUseAction);
  const programGovernAutoActionEnabled = options.programGovernAutoAction !== false;
  const programGatePolicy = resolveProgramGatePolicy({
    profile: options.programGateProfile,
    minSuccessRate: options.programMinSuccessRate,
    maxRiskLevel: options.programMaxRiskLevel,
    maxElapsedMinutes: options.programMaxElapsedMinutes,
    maxAgentBudget: options.programMaxAgentBudget,
    maxTotalSubSpecs: options.programMaxTotalSubSpecs
  });
  const gateFallbackProfile = normalizeProgramGateFallbackProfile(options.programGateFallbackProfile);
  const gateFallbackChain = resolveProgramGateFallbackChain(options.programGateFallbackChain, gateFallbackProfile);
  const recoveryMemoryScope = await resolveRecoveryMemoryScope(projectPath, options.recoveryMemoryScope);
  if (options.resume) {
    throw new Error('--resume is not supported in close-loop-program. Use close-loop --resume or remove --resume.');
  }
  if (options.sessionId) {
    throw new Error('--session-id is not supported in close-loop-program. Session ids are generated per goal.');
  }
  if (
    options.batchRetryMaxRounds !== undefined &&
    options.batchRetryMaxRounds !== null &&
    !options.batchRetryUntilComplete &&
    !programAutonomousEnabled
  ) {
    throw new Error('--batch-retry-max-rounds requires --batch-retry-until-complete.');
  }
  if (options.batchRetryMaxRounds !== undefined && options.batchRetryMaxRounds !== null) {
    normalizeBatchRetryMaxRounds(options.batchRetryMaxRounds);
  }
  if (options.batchSessionKeep !== undefined && options.batchSessionKeep !== null) {
    normalizeBatchSessionKeep(options.batchSessionKeep);
  }
  if (options.batchSessionOlderThanDays !== undefined && options.batchSessionOlderThanDays !== null) {
    normalizeBatchSessionOlderThanDays(options.batchSessionOlderThanDays);
  }
  if (options.specSessionKeep !== undefined && options.specSessionKeep !== null) {
    normalizeSpecKeep(options.specSessionKeep);
  }
  if (options.specSessionOlderThanDays !== undefined && options.specSessionOlderThanDays !== null) {
    normalizeOlderThanDays(options.specSessionOlderThanDays);
  }
  if (options.specSessionProtectWindowDays !== undefined && options.specSessionProtectWindowDays !== null) {
    normalizeSpecSessionProtectWindowDays(options.specSessionProtectWindowDays);
  }
  if (options.specSessionMaxTotal !== undefined && options.specSessionMaxTotal !== null) {
    normalizeSpecSessionMaxTotal(options.specSessionMaxTotal);
  }
  if (options.specSessionMaxCreated !== undefined && options.specSessionMaxCreated !== null) {
    normalizeSpecSessionMaxCreated(options.specSessionMaxCreated);
  }
  if (options.specSessionMaxCreatedPerGoal !== undefined && options.specSessionMaxCreatedPerGoal !== null) {
    normalizeSpecSessionMaxCreatedPerGoal(options.specSessionMaxCreatedPerGoal);
  }
  if (options.specSessionMaxDuplicateGoals !== undefined && options.specSessionMaxDuplicateGoals !== null) {
    normalizeSpecSessionMaxDuplicateGoals(options.specSessionMaxDuplicateGoals);
  }
  if (options.batchSessionId !== undefined && options.batchSessionId !== null) {
    const sanitizedBatchSessionId = sanitizeBatchSessionId(options.batchSessionId);
    if (!sanitizedBatchSessionId) {
      throw new Error('--batch-session-id is invalid after sanitization.');
    }
  }

  const goalsResult = buildCloseLoopBatchGoalsFromGoal(goal, options.programGoals, {
    minQualityScore: options.programMinQualityScore,
    enforceQualityGate: Boolean(options.programQualityGate)
  });
  const programOptions = {
    ...options,
    batchAutonomous: programAutonomousEnabled
  };
  const initialSummary = await executeCloseLoopBatch(goalsResult, programOptions, projectPath, 'auto-close-loop-program');
  let summary = {
    ...initialSummary,
    auto_recovery: {
      enabled: programAutoRecoverEnabled,
      triggered: false,
      converged: initialSummary.status === 'completed',
      source_status: initialSummary.status
    }
  };

  if (programAutoRecoverEnabled && initialSummary.status !== 'completed') {
    const recoveryResult = await executeCloseLoopRecoveryCycle({
      projectPath,
      sourceSummary: {
        file: initialSummary.batch_session && initialSummary.batch_session.file
          ? initialSummary.batch_session.file
          : '(auto-close-loop-program-in-memory)',
        payload: initialSummary
      },
      baseOptions: {
        ...programOptions,
        useAction: options.programRecoverUseAction
      },
      recoverAutonomousEnabled: true,
      resumeStrategy: programRecoverResumeStrategy,
      recoverUntilComplete: true,
      recoverMaxRounds: programRecoverMaxRounds,
      recoverMaxDurationMs: programRecoverMaxMinutes === null ? null : programRecoverMaxMinutes * 60 * 1000,
      recoveryMemoryScope,
      actionCandidate: options.programRecoverUseAction
    });

    summary = mergeProgramRecoveryIntoProgramSummary(
      initialSummary,
      recoveryResult.summary,
      {
        enabled: true,
        triggered: true,
        recover_until_complete: true,
        recover_max_rounds: programRecoverMaxRounds,
        recover_max_minutes: programRecoverMaxMinutes,
        resume_strategy: programRecoverResumeStrategy
      }
    );
    summary.program_kpi = buildProgramKpiSnapshot(summary);
    summary.program_diagnostics = buildProgramDiagnostics(summary);
    summary.program_coordination = buildProgramCoordinationSnapshot(summary);
    if (writeOutputs) {
      await maybeWriteProgramKpi(summary, options.programKpiOut, projectPath);
      await maybeWriteOutput(summary, options.out, projectPath);
    }
    if (programOptions.batchSession !== false) {
      await maybePersistCloseLoopBatchSummary(summary, programOptions, projectPath);
    }
  }

  const programCompletedAt = Date.now();
  summary.program_started_at = new Date(programStartedAt).toISOString();
  summary.program_completed_at = new Date(programCompletedAt).toISOString();
  summary.program_elapsed_ms = Math.max(0, programCompletedAt - programStartedAt);

  await applyProgramGateOutcome(summary, {
    projectPath,
    options: programOptions,
    programGatePolicy,
    gateFallbackChain,
    enableAutoRemediation: options.programGateAutoRemediate !== false
  });

  if (programGovernUntilStable) {
    const governanceResult = await runProgramGovernanceLoop({
      enabled: true,
      summary,
      projectPath,
      programOptions,
      baseGoalsResult: goalsResult,
      maxRounds: programGovernMaxRounds,
      maxMinutes: programGovernMaxMinutes,
      anomalyEnabled: programGovernAnomalyEnabled,
      anomalyWeeks: programGovernAnomalyWeeks,
      anomalyPeriod: programGovernAnomalyPeriod,
      programGatePolicy,
      gateFallbackChain,
      recoveryMemoryScope,
      recoverResumeStrategy: programRecoverResumeStrategy,
      recoverMaxRounds: programRecoverMaxRounds,
      recoverMaxMinutes: programRecoverMaxMinutes,
      programRecoverUseAction: options.programRecoverUseAction,
      programGateAutoRemediate: options.programGateAutoRemediate !== false,
      governUseAction: programGovernUseAction,
      governAutoActionEnabled: programGovernAutoActionEnabled
    });
    summary = governanceResult.summary;
    summary.program_governance = governanceResult.governance;
  } else {
    summary.program_governance = {
      enabled: false,
      anomaly_enabled: programGovernAnomalyEnabled,
      anomaly_weeks: programGovernAnomalyWeeks,
      anomaly_period: programGovernAnomalyPeriod,
      auto_action_enabled: programGovernAutoActionEnabled,
      action_selection_enabled: false,
      pinned_action_index: programGovernUseAction,
      max_rounds: programGovernMaxRounds,
      max_minutes: programGovernMaxMinutes,
      performed_rounds: 0,
      converged: Boolean(
        summary &&
        summary.program_gate_effective &&
        summary.program_gate_effective.passed &&
        !isSpecSessionBudgetHardFailure(summary) &&
        !isSpecSessionGrowthGuardHardFailure(summary)
      ),
      exhausted: false,
      stop_reason: 'disabled',
      history: []
    };
  }

  const finalProgramCompletedAt = Date.now();
  summary.program_completed_at = new Date(finalProgramCompletedAt).toISOString();
  summary.program_elapsed_ms = Math.max(0, finalProgramCompletedAt - programStartedAt);

  if (writeOutputs) {
    await maybeWriteProgramKpi(summary, options.programKpiOut, projectPath);
    await maybeWriteOutput(summary, options.out, projectPath);
    await maybeWriteProgramAudit(summary, options.programAuditOut, projectPath);
  }

  if (shouldPrintSummary) {
    printCloseLoopBatchSummary(summary, programOptions);
  }

  const exitCode = (
    summary.status !== 'completed' ||
    !summary.program_gate_effective.passed ||
    isSpecSessionBudgetHardFailure(summary) ||
    isSpecSessionGrowthGuardHardFailure(summary)
  ) ? 1 : 0;

  return {
    summary,
    options: programOptions,
    exitCode
  };
}

function resolveResultSourceIndex(item, fallbackIndex = 0) {
  if (Number.isInteger(item && item.source_index) && item.source_index >= 0) {
    return item.source_index;
  }
  const fromIndex = Number(item && item.index);
  if (Number.isInteger(fromIndex) && fromIndex > 0) {
    return fromIndex - 1;
  }
  return Math.max(0, fallbackIndex);
}

function getBatchFailureStatusSet() {
  return new Set(['failed', 'error', 'unknown', 'stopped']);
}

function buildProgramCoordinationSnapshot(summary) {
  const results = Array.isArray(summary && summary.results) ? summary.results : [];
  const failedStatuses = getBatchFailureStatusSet();
  const unresolvedIndexes = [];
  const masterSpecs = new Set();
  let totalSubSpecs = 0;
  for (const item of results) {
    const status = `${item && item.status ? item.status : ''}`.trim().toLowerCase();
    if (failedStatuses.has(status)) {
      unresolvedIndexes.push(resolveResultSourceIndex(item) + 1);
    }
    const masterSpec = item && typeof item.master_spec === 'string' ? item.master_spec.trim() : '';
    if (masterSpec) {
      masterSpecs.add(masterSpec);
    }
    totalSubSpecs += Number(item && item.sub_spec_count) || 0;
  }

  return {
    topology: 'master-sub',
    master_spec_count: masterSpecs.size,
    sub_spec_count: totalSubSpecs,
    unresolved_goal_count: unresolvedIndexes.length,
    unresolved_goal_indexes: unresolvedIndexes.slice(0, 50),
    scheduler: {
      batch_parallel: Number(summary && summary.batch_parallel) || 0,
      agent_budget: summary && summary.resource_plan && summary.resource_plan.agent_budget !== undefined
        ? summary.resource_plan.agent_budget
        : null,
      priority: summary && summary.resource_plan ? summary.resource_plan.scheduling_strategy : null,
      aging_factor: summary && summary.resource_plan ? summary.resource_plan.aging_factor : null
    }
  };
}

function mergeProgramRecoveryIntoProgramSummary(initialSummary, recoverySummary, metadata = {}) {
  const baseSummary = initialSummary && typeof initialSummary === 'object' ? initialSummary : {};
  const recovery = recoverySummary && typeof recoverySummary === 'object' ? recoverySummary : {};
  const failedStatuses = getBatchFailureStatusSet();
  const mergedBySource = new Map();

  const initialResults = Array.isArray(baseSummary.results) ? baseSummary.results : [];
  for (let index = 0; index < initialResults.length; index += 1) {
    const item = initialResults[index];
    const sourceIndex = resolveResultSourceIndex(item, index);
    mergedBySource.set(sourceIndex, {
      ...item,
      source_index: sourceIndex,
      index: sourceIndex + 1
    });
  }

  const recoveryResults = Array.isArray(recovery.results) ? recovery.results : [];
  for (let index = 0; index < recoveryResults.length; index += 1) {
    const item = recoveryResults[index];
    const sourceIndex = resolveResultSourceIndex(item, index);
    mergedBySource.set(sourceIndex, {
      ...item,
      source_index: sourceIndex,
      index: sourceIndex + 1,
      recovered_by_program: true
    });
  }

  const orderedResults = [...mergedBySource.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, item]) => item);
  const totalGoals = Number(baseSummary.total_goals) || orderedResults.length;
  const failedGoals = orderedResults.filter(item => failedStatuses.has(`${item && item.status ? item.status : ''}`.trim().toLowerCase())).length;
  const completedGoals = orderedResults.length - failedGoals;
  const status = failedGoals === 0
    ? 'completed'
    : completedGoals === 0
      ? 'failed'
      : 'partial-failed';
  const mergedResourcePlan = mergeBatchResourcePlans(baseSummary.resource_plan || null, recovery.resource_plan || null);

  return {
    ...baseSummary,
    status,
    total_goals: totalGoals,
    processed_goals: orderedResults.length,
    completed_goals: completedGoals,
    failed_goals: failedGoals,
    batch_parallel: Math.max(Number(baseSummary.batch_parallel) || 0, Number(recovery.batch_parallel) || 0),
    resource_plan: mergedResourcePlan,
    metrics: buildBatchMetrics(orderedResults, totalGoals),
    results: orderedResults,
    auto_recovery: {
      ...metadata,
      source_status: baseSummary.status || null,
      recovery_status: recovery.status || null,
      converged: recovery.status === 'completed',
      selected_action_index: recovery.recovered_from_summary
        ? recovery.recovered_from_summary.selected_action_index
        : null,
      selection_source: recovery.recovery_plan ? recovery.recovery_plan.selection_source : null,
      recovery_cycle: recovery.recovery_cycle || null,
      recovery_memory: recovery.recovery_memory || null
    }
  };
}

async function executeCloseLoopRecoveryCycle({
  projectPath,
  sourceSummary,
  baseOptions,
  recoverAutonomousEnabled,
  resumeStrategy,
  recoverUntilComplete,
  recoverMaxRounds,
  recoverMaxDurationMs,
  recoveryMemoryTtlDays,
  recoveryMemoryScope,
  actionCandidate
}) {
  let resolvedSourceSummary = sourceSummary && typeof sourceSummary === 'object'
    ? {
      file: typeof sourceSummary.file === 'string' && sourceSummary.file.trim()
        ? sourceSummary.file
        : '(in-memory-summary)',
      payload: sourceSummary.payload && typeof sourceSummary.payload === 'object'
        ? sourceSummary.payload
        : {}
    }
    : {
      file: '(in-memory-summary)',
      payload: {}
    };

  if (recoveryMemoryTtlDays !== null && recoveryMemoryTtlDays !== undefined) {
    await pruneCloseLoopRecoveryMemory(projectPath, {
      olderThanDays: recoveryMemoryTtlDays,
      dryRun: false
    });
  }
  const recoveryMemory = await loadCloseLoopRecoveryMemory(projectPath);
  const resolvedRecoveryScope = normalizeRecoveryMemoryToken(recoveryMemoryScope || '') || 'default-scope';
  const recoverySignature = buildRecoveryMemorySignature(resolvedSourceSummary.payload, {
    scope: resolvedRecoveryScope
  });
  const recoveryMemoryEntry = getRecoveryMemoryEntry(recoveryMemory.payload, recoverySignature);
  const pinnedActionSelection = resolveRecoveryActionSelection(
    resolvedSourceSummary.payload,
    actionCandidate,
    { recoveryMemoryEntry }
  );

  let finalSummary = null;
  let finalRecoveryOptions = null;
  const recoveryHistory = [];
  const recoveryStartedAt = Date.now();
  let budgetExhausted = false;
  for (let round = 1; round <= recoverMaxRounds; round += 1) {
    if (recoverMaxDurationMs !== null && recoverMaxDurationMs !== undefined) {
      const elapsedBeforeRound = Date.now() - recoveryStartedAt;
      if (elapsedBeforeRound >= recoverMaxDurationMs && finalSummary) {
        budgetExhausted = true;
        break;
      }
    }

    const recoveryOptions = applyRecoveryActionPatch({
      ...baseOptions,
      batchAutonomous: recoverAutonomousEnabled
    }, pinnedActionSelection.selectedAction);

    if (
      recoverUntilComplete &&
      typeof recoveryOptions.batchSessionId === 'string' &&
      recoveryOptions.batchSessionId.trim()
    ) {
      recoveryOptions.batchSessionId = `${recoveryOptions.batchSessionId.trim()}-r${round}`;
    }

    const goalsResult = await buildCloseLoopBatchGoalsFromSummaryPayload(
      resolvedSourceSummary.payload,
      resolvedSourceSummary.file,
      projectPath,
      'auto',
      resumeStrategy
    );
    const summary = await executeCloseLoopBatch(
      goalsResult,
      recoveryOptions,
      projectPath,
      'auto-close-loop-recover'
    );

    summary.recovered_from_summary = {
      file: resolvedSourceSummary.file,
      source_mode: resolvedSourceSummary.payload.mode || null,
      source_status: resolvedSourceSummary.payload.status || null,
      resume_strategy: resumeStrategy,
      selected_action_index: pinnedActionSelection.selectedIndex,
      selected_action: pinnedActionSelection.selectedAction || null,
      round
    };
    summary.recovery_plan = {
      remediation_actions: pinnedActionSelection.availableActions,
      applied_patch: pinnedActionSelection.appliedPatch,
      selection_source: pinnedActionSelection.selectionSource,
      selection_explain: pinnedActionSelection.selectionExplain || null
    };

    recoveryHistory.push({
      round,
      source_summary: resolvedSourceSummary.file,
      status: summary.status,
      processed_goals: summary.processed_goals,
      completed_goals: summary.completed_goals,
      failed_goals: summary.failed_goals,
      batch_session_file: summary.batch_session && summary.batch_session.file
        ? summary.batch_session.file
        : null
    });

    finalSummary = summary;
    finalRecoveryOptions = recoveryOptions;

    if (!recoverUntilComplete || summary.status === 'completed') {
      break;
    }

    resolvedSourceSummary = summary.batch_session && summary.batch_session.file
      ? await loadCloseLoopBatchSummaryPayload(projectPath, summary.batch_session.file)
      : {
        file: '(derived-from-summary)',
        payload: summary
      };
  }

  if (!finalSummary) {
    throw new Error('Recovery cycle did not produce a summary.');
  }

  finalSummary.recovery_cycle = {
    enabled: recoverUntilComplete,
    max_rounds: recoverMaxRounds,
    performed_rounds: recoveryHistory.length,
    converged: finalSummary.status === 'completed',
    exhausted: (
      (recoverUntilComplete && recoveryHistory.length >= recoverMaxRounds && finalSummary.status !== 'completed') ||
      budgetExhausted
    ),
    time_budget_minutes: recoverMaxDurationMs ? Number((recoverMaxDurationMs / 60000).toFixed(2)) : null,
    elapsed_ms: Date.now() - recoveryStartedAt,
    budget_exhausted: budgetExhausted,
    history: recoveryHistory
  };

  const memoryUpdate = await updateCloseLoopRecoveryMemory(
    projectPath,
    recoveryMemory,
    recoverySignature,
    pinnedActionSelection.selectedIndex,
    pinnedActionSelection.selectedAction,
    finalSummary.status,
    { scope: resolvedRecoveryScope }
  );
  finalSummary.recovery_memory = {
    file: memoryUpdate.file,
    signature: memoryUpdate.signature,
    scope: memoryUpdate.scope,
    action_key: memoryUpdate.action_key,
    selected_action_index: pinnedActionSelection.selectedIndex,
    selection_source: pinnedActionSelection.selectionSource,
    selection_explain: pinnedActionSelection.selectionExplain || null,
    action_stats: memoryUpdate.entry
  };

  return {
    summary: finalSummary,
    options: finalRecoveryOptions || baseOptions,
    pinnedActionSelection
  };
}

function resolveControllerQueueFile(projectPath, queueFileCandidate) {
  const normalized = typeof queueFileCandidate === 'string' && queueFileCandidate.trim()
    ? queueFileCandidate.trim()
    : '.sce/auto/close-loop-controller-goals.lines';
  return path.isAbsolute(normalized)
    ? normalized
    : path.join(projectPath, normalized);
}

function resolveControllerQueueFormat(resolvedQueueFile, formatCandidate) {
  const normalized = normalizeBatchFormat(formatCandidate);
  if (normalized !== 'auto') {
    return normalized;
  }
  return `${resolvedQueueFile}`.toLowerCase().endsWith('.json')
    ? 'json'
    : 'lines';
}

function dedupeControllerGoals(goals) {
  const uniqueGoals = [];
  const seen = new Set();
  let duplicateCount = 0;
  for (const item of Array.isArray(goals) ? goals : []) {
    const normalized = `${item || ''}`.trim();
    if (!normalized) {
      continue;
    }
    const fingerprint = normalized.toLowerCase();
    if (seen.has(fingerprint)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(fingerprint);
    uniqueGoals.push(normalized);
  }
  return {
    goals: uniqueGoals,
    duplicate_count: duplicateCount
  };
}

async function loadControllerGoalQueue(projectPath, queueFileCandidate, formatCandidate, options = {}) {
  const file = resolveControllerQueueFile(projectPath, queueFileCandidate);
  const format = resolveControllerQueueFormat(file, formatCandidate);
  const dedupe = options.dedupe === true;
  if (!(await fs.pathExists(file))) {
    await fs.ensureDir(path.dirname(file));
    if (format === 'json') {
      await fs.writeJson(file, { goals: [] }, { spaces: 2 });
    } else {
      await fs.writeFile(file, '', 'utf8');
    }
  }

  let goals = [];
  if (format === 'json') {
    let payload = null;
    try {
      payload = await fs.readJson(file);
    } catch (error) {
      throw new Error(`Invalid controller queue JSON: ${file} (${error.message})`);
    }
    goals = parseGoalsFromJsonPayload(payload || {});
  } else {
    const content = await fs.readFile(file, 'utf8');
    goals = parseGoalsFromLines(content);
  }

  const normalizedGoals = goals
    .map(item => `${item || ''}`.trim())
    .filter(Boolean);
  const dedupeResult = dedupe
    ? dedupeControllerGoals(normalizedGoals)
    : {
      goals: normalizedGoals,
      duplicate_count: 0
    };

  return {
    file,
    format,
    goals: dedupeResult.goals,
    duplicate_count: dedupeResult.duplicate_count,
    dedupe_applied: dedupe
  };
}

async function writeControllerGoalQueue(file, format, goals) {
  const normalizedGoals = Array.isArray(goals)
    ? goals.map(item => `${item || ''}`.trim()).filter(Boolean)
    : [];
  await fs.ensureDir(path.dirname(file));
  if (format === 'json') {
    await fs.writeJson(file, { goals: normalizedGoals }, { spaces: 2 });
    return;
  }
  const content = normalizedGoals.length > 0
    ? `${normalizedGoals.join('\n')}\n`
    : '';
  await fs.writeFile(file, content, 'utf8');
}

async function appendControllerGoalArchive(fileCandidate, projectPath, goal, metadata = {}) {
  if (!fileCandidate) {
    return null;
  }
  const resolvedFile = path.isAbsolute(fileCandidate)
    ? fileCandidate
    : path.join(projectPath, fileCandidate);
  await fs.ensureDir(path.dirname(resolvedFile));
  const timestamp = new Date().toISOString();
  const normalizedGoal = `${goal || ''}`.replace(/\r?\n/g, ' ').trim();
  const fields = [
    timestamp,
    `${metadata.status || ''}`.trim() || 'unknown',
    `${metadata.program_status || ''}`.trim() || 'unknown',
    `${metadata.gate_passed === true ? 'gate-pass' : 'gate-fail'}`,
    normalizedGoal
  ];
  await fs.appendFile(resolvedFile, `${fields.join('\t')}\n`, 'utf8');
  return resolvedFile;
}

async function sleepForMs(durationMs) {
  return new Promise(resolve => {
    setTimeout(resolve, Math.max(0, durationMs));
  });
}

function resolveControllerLockFile(projectPath, queueFilePath, lockFileCandidate) {
  const normalized = typeof lockFileCandidate === 'string' && lockFileCandidate.trim()
    ? lockFileCandidate.trim()
    : `${queueFilePath}.lock`;
  return path.isAbsolute(normalized)
    ? normalized
    : path.join(projectPath, normalized);
}

async function readControllerLockPayload(lockFile) {
  if (!(await fs.pathExists(lockFile))) {
    return null;
  }
  try {
    return await fs.readJson(lockFile);
  } catch (error) {
    return null;
  }
}

function buildControllerLockPayload(lockToken) {
  return {
    token: lockToken,
    pid: process.pid,
    host: process.env.COMPUTERNAME || process.env.HOSTNAME || null,
    acquired_at: new Date().toISOString(),
    touched_at: new Date().toISOString()
  };
}

async function writeControllerLockPayload(lockFile, payload, mode = 'overwrite') {
  await fs.ensureDir(path.dirname(lockFile));
  if (mode === 'create') {
    await fs.writeFile(lockFile, JSON.stringify(payload, null, 2), {
      encoding: 'utf8',
      flag: 'wx'
    });
    return;
  }
  await fs.writeJson(lockFile, payload, { spaces: 2 });
}

function isControllerLockStale(stats, ttlSeconds) {
  const mtimeMs = Number(stats && stats.mtimeMs) || 0;
  const ttlMs = Math.max(1, ttlSeconds) * 1000;
  return mtimeMs > 0 && (Date.now() - mtimeMs) > ttlMs;
}

async function acquireControllerLock(projectPath, queueFilePath, options = {}) {
  if (options.controllerLock === false) {
    return null;
  }

  const ttlSeconds = normalizeControllerLockTtlSeconds(options.controllerLockTtlSeconds);
  const lockFile = resolveControllerLockFile(projectPath, queueFilePath, options.controllerLockFile);
  const token = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const payload = buildControllerLockPayload(token);

  const attemptAcquire = async () => {
    await writeControllerLockPayload(lockFile, payload, 'create');
    return {
      file: lockFile,
      token,
      ttl_seconds: ttlSeconds
    };
  };

  try {
    return await attemptAcquire();
  } catch (error) {
    if (!error || error.code !== 'EEXIST') {
      throw new Error(`Failed to acquire controller lock: ${lockFile} (${error.message})`);
    }
  }

  let lockStats = null;
  try {
    lockStats = await fs.stat(lockFile);
  } catch (error) {
    return attemptAcquire();
  }

  if (isControllerLockStale(lockStats, ttlSeconds)) {
    try {
      await fs.remove(lockFile);
      return await attemptAcquire();
    } catch (error) {
      throw new Error(`Failed to take over stale controller lock: ${lockFile} (${error.message})`);
    }
  }

  const holder = await readControllerLockPayload(lockFile);
  const holderPid = holder && holder.pid ? holder.pid : 'unknown';
  const holderHost = holder && holder.host ? holder.host : 'unknown-host';
  throw new Error(
    `Controller lock is held by pid=${holderPid} host=${holderHost}: ${lockFile}. ` +
    'Use --no-controller-lock only if you intentionally allow concurrent controllers.'
  );
}

async function refreshControllerLock(lockState) {
  if (!lockState || !lockState.file) {
    return;
  }
  const payload = await readControllerLockPayload(lockState.file);
  if (!payload || payload.token !== lockState.token) {
    throw new Error(`Controller lock ownership lost: ${lockState.file}`);
  }
  payload.touched_at = new Date().toISOString();
  await writeControllerLockPayload(lockState.file, payload, 'overwrite');
}

async function releaseControllerLock(lockState) {
  if (!lockState || !lockState.file) {
    return;
  }
  const payload = await readControllerLockPayload(lockState.file);
  if (!payload || payload.token !== lockState.token) {
    return;
  }
  await fs.remove(lockState.file);
}

async function runCloseLoopController(queueFile, options = {}, context = {}) {
  const projectPath = context.projectPath || process.cwd();
  const resumedSession = context.resumedSession || null;
  const queueInput = typeof queueFile === 'string' && queueFile.trim()
    ? queueFile.trim()
    : resumedSession && resumedSession.payload && typeof resumedSession.payload.queue_file === 'string'
      ? resumedSession.payload.queue_file
      : null;
  const queueFormatCandidate = (
    options.queueFormat === 'auto' &&
    resumedSession &&
    resumedSession.payload &&
    typeof resumedSession.payload.queue_format === 'string' &&
    resumedSession.payload.queue_format.trim()
  )
    ? resumedSession.payload.queue_format
    : options.queueFormat;
  const queuePayload = await loadControllerGoalQueue(projectPath, queueInput, queueFormatCandidate, {
    dedupe: options.controllerDedupe !== false
  });
  const maxCycles = normalizeControllerMaxCycles(options.maxCycles);
  const maxMinutes = normalizeControllerMaxMinutes(options.maxMinutes);
  const maxDurationMs = maxMinutes * 60 * 1000;
  const pollSeconds = normalizeControllerPollSeconds(options.pollSeconds);
  const dequeueLimit = normalizeControllerDequeueLimit(options.dequeueLimit);
  const waitOnEmpty = Boolean(options.waitOnEmpty);
  const stopOnGoalFailure = Boolean(options.stopOnGoalFailure);
  const startedAt = Date.now();
  const history = [];
  const results = [];
  let performedCycles = 0;
  let stopReason = 'completed';
  let exhausted = false;
  let haltRequested = false;
  let doneArchiveFile = null;
  let failedArchiveFile = null;
  let dedupeDroppedGoals = Number(queuePayload.duplicate_count) || 0;
  let lockState = null;

  if (options.controllerDedupe !== false && queuePayload.duplicate_count > 0) {
    await writeControllerGoalQueue(queuePayload.file, queuePayload.format, queuePayload.goals);
  }

  lockState = await acquireControllerLock(projectPath, queuePayload.file, options);

  try {
    for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
      if ((Date.now() - startedAt) >= maxDurationMs) {
        exhausted = true;
        stopReason = 'time-budget-exhausted';
        break;
      }

      await refreshControllerLock(lockState);

      const currentQueue = await loadControllerGoalQueue(projectPath, queuePayload.file, queuePayload.format, {
        dedupe: options.controllerDedupe !== false
      });
      const pendingGoals = currentQueue.goals;
      dedupeDroppedGoals += Number(currentQueue.duplicate_count) || 0;

      if (options.controllerDedupe !== false && currentQueue.duplicate_count > 0) {
        await writeControllerGoalQueue(currentQueue.file, currentQueue.format, pendingGoals);
      }

      if (pendingGoals.length === 0) {
        history.push({
          cycle,
          queue_before: 0,
          dequeued: 0,
          queue_after: 0,
          status: waitOnEmpty ? 'idle-wait' : 'empty-stop'
        });
        performedCycles += 1;
        if (!waitOnEmpty) {
          stopReason = 'queue-empty';
          break;
        }
        await sleepForMs(pollSeconds * 1000);
        continue;
      }

      const effectiveDequeueLimit = dequeueLimit === null ? pendingGoals.length : dequeueLimit;
      const dequeuedGoals = pendingGoals.slice(0, effectiveDequeueLimit);
      const remainingGoals = pendingGoals.slice(dequeuedGoals.length);
      await writeControllerGoalQueue(currentQueue.file, currentQueue.format, remainingGoals);

      const cycleRecord = {
        cycle,
        queue_before: pendingGoals.length,
        dequeued: dequeuedGoals.length,
        queue_after: remainingGoals.length,
        processed: 0,
        completed: 0,
        failed: 0,
        status: 'processed'
      };

      for (let index = 0; index < dequeuedGoals.length; index += 1) {
        const goal = dequeuedGoals[index];
        const goalStartedAt = Date.now();
        let goalResult = {
          cycle,
          queue_index: index + 1,
          goal,
          status: 'failed',
          error: null
        };

        try {
          const perGoalOptions = {
            ...options,
            out: null,
            programKpiOut: null,
            programAuditOut: null,
            json: false
          };
          const programResult = await executeCloseLoopProgramGoal(goal, perGoalOptions, {
            projectPath,
            printSummary: options.controllerPrintProgramSummary === true,
            writeOutputs: false
          });
          const programSummary = programResult.summary || {};
          const failed = programResult.exitCode !== 0;
          goalResult = {
            ...goalResult,
            status: failed ? 'failed' : 'completed',
            program_status: programSummary.status || null,
            program_gate_passed: Boolean(
              programSummary.program_gate_effective &&
              programSummary.program_gate_effective.passed
            ),
            governance_stop_reason: programSummary.program_governance
              ? programSummary.program_governance.stop_reason
              : null,
            batch_session_file: programSummary.batch_session && programSummary.batch_session.file
              ? programSummary.batch_session.file
              : null
          };
        } catch (error) {
          goalResult.error = error.message;
        }

        goalResult.elapsed_ms = Math.max(0, Date.now() - goalStartedAt);
        results.push(goalResult);
        cycleRecord.processed += 1;

        if (goalResult.status === 'completed') {
          cycleRecord.completed += 1;
          doneArchiveFile = await appendControllerGoalArchive(
            options.controllerDoneFile,
            projectPath,
            goal,
            {
              status: 'completed',
              program_status: goalResult.program_status,
              gate_passed: goalResult.program_gate_passed
            }
          ) || doneArchiveFile;
        } else {
          cycleRecord.failed += 1;
          failedArchiveFile = await appendControllerGoalArchive(
            options.controllerFailedFile,
            projectPath,
            goal,
            {
              status: 'failed',
              program_status: goalResult.program_status,
              gate_passed: goalResult.program_gate_passed
            }
          ) || failedArchiveFile;
          if (stopOnGoalFailure) {
            haltRequested = true;
          }
        }

        if (haltRequested) {
          break;
        }
      }

      if (haltRequested) {
        cycleRecord.status = 'stopped-on-goal-failure';
        stopReason = 'goal-failure';
      }
      history.push(cycleRecord);
      performedCycles += 1;

      if (haltRequested) {
        break;
      }
    }
  } finally {
    await releaseControllerLock(lockState);
  }

  const finalQueue = await loadControllerGoalQueue(projectPath, queuePayload.file, queuePayload.format, {
    dedupe: options.controllerDedupe !== false
  });
  const pendingGoals = finalQueue.goals.length;
  dedupeDroppedGoals += Number(finalQueue.duplicate_count) || 0;
  if (options.controllerDedupe !== false && finalQueue.duplicate_count > 0) {
    await writeControllerGoalQueue(finalQueue.file, finalQueue.format, finalQueue.goals);
  }

  if (!exhausted && stopReason === 'completed') {
    if (performedCycles >= maxCycles && (pendingGoals > 0 || waitOnEmpty)) {
      exhausted = true;
      stopReason = 'cycle-limit-reached';
    } else if (pendingGoals === 0 && results.length === 0) {
      stopReason = 'queue-empty';
    }
  }

  const completedGoals = results.filter(item => item.status === 'completed').length;
  const failedGoals = results.filter(item => item.status !== 'completed').length;
  const status = failedGoals === 0
    ? 'completed'
    : completedGoals === 0
      ? 'failed'
      : 'partial-failed';
  const summary = {
    mode: 'auto-close-loop-controller',
    status,
    queue_file: queuePayload.file,
    queue_format: queuePayload.format,
    started_at: new Date(startedAt).toISOString(),
    completed_at: new Date().toISOString(),
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    wait_on_empty: waitOnEmpty,
    poll_seconds: pollSeconds,
    dequeue_limit: dequeueLimit === null ? 'all' : dequeueLimit,
    max_cycles: maxCycles,
    max_minutes: maxMinutes,
    cycles_performed: performedCycles,
    exhausted,
    stop_reason: stopReason,
    processed_goals: results.length,
    completed_goals: completedGoals,
    failed_goals: failedGoals,
    pending_goals: pendingGoals,
    dedupe_enabled: options.controllerDedupe !== false,
    dedupe_dropped_goals: dedupeDroppedGoals,
    lock_enabled: options.controllerLock !== false,
    lock_file: lockState && lockState.file ? lockState.file : null,
    lock_ttl_seconds: lockState && Number.isInteger(lockState.ttl_seconds) ? lockState.ttl_seconds : null,
    resumed_from_controller_session: resumedSession
      ? {
        id: resumedSession.id,
        file: resumedSession.file,
        status: resumedSession.payload && resumedSession.payload.status
          ? resumedSession.payload.status
          : null
      }
      : null,
    history,
    results,
    done_archive_file: doneArchiveFile,
    failed_archive_file: failedArchiveFile
  };

  await maybePersistCloseLoopControllerSummary(summary, options, projectPath);
  await maybeWriteOutput(summary, options.controllerOut, projectPath);
  return summary;
}

function printCloseLoopControllerSummary(summary) {
  console.log(chalk.blue('Autonomous close-loop controller summary'));
  console.log(chalk.gray(`  Status: ${summary.status}`));
  console.log(chalk.gray(`  Cycles: ${summary.cycles_performed}/${summary.max_cycles}`));
  console.log(chalk.gray(`  Processed goals: ${summary.processed_goals}`));
  console.log(chalk.gray(`  Completed: ${summary.completed_goals}`));
  console.log(chalk.gray(`  Failed: ${summary.failed_goals}`));
  console.log(chalk.gray(`  Pending queue goals: ${summary.pending_goals}`));
  if (summary.dedupe_enabled) {
    console.log(chalk.gray(`  Dedupe dropped: ${summary.dedupe_dropped_goals || 0}`));
  }
  console.log(chalk.gray(`  Stop reason: ${summary.stop_reason}`));
  if (summary.lock_enabled && summary.lock_file) {
    console.log(chalk.gray(`  Lock: ${summary.lock_file}`));
  }
  if (summary.controller_session && summary.controller_session.file) {
    console.log(chalk.gray(`  Session: ${summary.controller_session.file}`));
  }
  if (summary.done_archive_file) {
    console.log(chalk.gray(`  Done archive: ${summary.done_archive_file}`));
  }
  if (summary.failed_archive_file) {
    console.log(chalk.gray(`  Failed archive: ${summary.failed_archive_file}`));
  }
  if (summary.output_file) {
    console.log(chalk.gray(`  Output: ${summary.output_file}`));
  }
}

function printCloseLoopBatchSummary(summary, options) {
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const title = summary.mode === 'auto-close-loop-program'
    ? 'Autonomous close-loop program summary'
    : summary.mode === 'auto-close-loop-recover'
      ? 'Autonomous close-loop recovery summary'
    : 'Autonomous close-loop batch summary';
  console.log(chalk.blue(title));
  console.log(chalk.gray(`  Status: ${summary.status}`));
  console.log(chalk.gray(`  Processed: ${summary.processed_goals}/${summary.total_goals}`));
  console.log(chalk.gray(`  Completed: ${summary.completed_goals}`));
  console.log(chalk.gray(`  Failed: ${summary.failed_goals}`));
  console.log(chalk.gray(`  Batch parallel: ${summary.batch_parallel}`));
  if (summary.autonomous_policy && summary.autonomous_policy.enabled) {
    console.log(chalk.gray(`  Autonomous policy: ${summary.autonomous_policy.profile}`));
  }
  if (summary.batch_retry && summary.batch_retry.performed_rounds > 0) {
    console.log(chalk.gray(
      `  Batch retry: ${summary.batch_retry.performed_rounds}/${summary.batch_retry.configured_rounds} extra rounds`
    ));
  }
  if (summary.batch_retry && summary.batch_retry.recovery_recommended) {
    console.log(chalk.yellow(
      `  Rate-limit recovery recommended: signals=${summary.batch_retry.total_rate_limit_signals || 0}, ` +
      `backoff=${summary.batch_retry.total_rate_limit_backoff_ms || 0}ms`
    ));
    if (summary.batch_retry.recovery_suggested_command) {
      console.log(chalk.yellow(`  Suggested command: ${summary.batch_retry.recovery_suggested_command}`));
    }
  }
  if (summary.resource_plan.agent_budget !== null) {
    console.log(chalk.gray(
      `  Agent budget: ${summary.resource_plan.agent_budget} ` +
      `(per-goal maxParallel=${summary.resource_plan.per_goal_max_parallel})`
    ));
  }
  console.log(chalk.gray(`  Success rate: ${summary.metrics.success_rate_percent}%`));
  if (summary.program_kpi) {
    console.log(chalk.gray(
      `  Program KPI: ${summary.program_kpi.convergence_state}, ` +
      `risk=${summary.program_kpi.risk_level}, ` +
      `retry-recovery=${summary.program_kpi.retry_recovery_rate_percent}%`
    ));
  }
  if (summary.program_gate) {
    console.log(chalk.gray(
      `  Program gate: ${summary.program_gate.passed ? 'passed' : 'failed'} ` +
      `(profile=${summary.program_gate.policy.profile || 'default'}, ` +
      `min-success=${summary.program_gate.policy.min_success_rate_percent}%, ` +
      `max-risk=${summary.program_gate.policy.max_risk_level})`
    ));
    const gatePolicy = summary.program_gate.policy || {};
    const gateActual = summary.program_gate.actual || {};
    if (
      gatePolicy.max_elapsed_minutes !== null ||
      gatePolicy.max_agent_budget !== null ||
      gatePolicy.max_total_sub_specs !== null
    ) {
      console.log(chalk.gray(
        `  Program budget gate: elapsed=${gateActual.elapsed_minutes ?? 'n/a'}/${gatePolicy.max_elapsed_minutes ?? 'n/a'} min, ` +
        `agent=${gateActual.agent_budget ?? 'n/a'}/${gatePolicy.max_agent_budget ?? 'n/a'}, ` +
        `sub-specs=${gateActual.total_sub_specs ?? 'n/a'}/${gatePolicy.max_total_sub_specs ?? 'n/a'}`
      ));
    }
    if (
      summary.program_gate_effective &&
      summary.program_gate_effective.source !== 'primary' &&
      summary.program_gate_effective.fallback_profile
    ) {
      console.log(chalk.gray(
        `  Program gate fallback accepted: profile=${summary.program_gate_effective.fallback_profile}`
      ));
    }
  }
  if (
    summary.program_diagnostics &&
    Array.isArray(summary.program_diagnostics.remediation_actions) &&
    summary.program_diagnostics.remediation_actions.length > 0
  ) {
    const topAction = summary.program_diagnostics.remediation_actions[0];
    console.log(chalk.gray(`  Top remediation: ${topAction.action}`));
  }
  if (summary.recovery_cycle && summary.recovery_cycle.enabled) {
    console.log(chalk.gray(
      `  Recovery rounds: ${summary.recovery_cycle.performed_rounds}/${summary.recovery_cycle.max_rounds}`
    ));
    if (summary.recovery_cycle.budget_exhausted) {
      console.log(chalk.gray('  Recovery time budget exhausted before convergence.'));
    }
  }
  if (summary.auto_recovery && summary.auto_recovery.triggered) {
    console.log(chalk.gray(
      `  Program auto-recovery: ${summary.auto_recovery.recovery_status} ` +
      `(action ${summary.auto_recovery.selected_action_index || 'n/a'}, ` +
      `source=${summary.auto_recovery.selection_source || 'default'})`
    ));
  }
  if (summary.program_governance && summary.program_governance.enabled) {
    console.log(chalk.gray(
      `  Program governance: ${summary.program_governance.performed_rounds}/` +
      `${summary.program_governance.max_rounds} rounds, stop=${summary.program_governance.stop_reason}`
    ));
    if (summary.program_governance.action_selection_enabled) {
      console.log(chalk.gray(
        `  Governance action selection: ` +
        `${summary.program_governance.auto_action_enabled ? 'auto' : 'manual-only'}, ` +
        `pinned=${summary.program_governance.pinned_action_index || 'none'}`
      ));
    }
    if (Array.isArray(summary.program_governance.history) && summary.program_governance.history.length > 0) {
      const latestRound = summary.program_governance.history[summary.program_governance.history.length - 1];
      if (latestRound && latestRound.selected_action) {
        console.log(chalk.gray(
          `  Governance selected action: #${latestRound.selected_action_index || 'n/a'} ${latestRound.selected_action}`
        ));
      }
    }
    if (summary.program_governance.exhausted) {
      console.log(chalk.yellow('  Program governance exhausted before reaching stable state.'));
    }
  }
  if (Array.isArray(summary.program_kpi_anomalies) && summary.program_kpi_anomalies.length > 0) {
    const highCount = summary.program_kpi_anomalies
      .filter(item => `${item && item.severity ? item.severity : ''}`.trim().toLowerCase() === 'high')
      .length;
    console.log(chalk.gray(
      `  Program KPI anomalies: total=${summary.program_kpi_anomalies.length}, high=${highCount}`
    ));
  }
  if (summary.program_coordination) {
    console.log(chalk.gray(
      `  Master/Sub sync: masters=${summary.program_coordination.master_spec_count}, ` +
      `sub-specs=${summary.program_coordination.sub_spec_count}, ` +
      `unresolved=${summary.program_coordination.unresolved_goal_count}`
    ));
  }
  if (summary.batch_session && summary.batch_session.file) {
    console.log(chalk.gray(`  Batch session: ${summary.batch_session.file}`));
  }
  if (summary.goal_input_guard && summary.goal_input_guard.enabled) {
    console.log(chalk.gray(
      `  Goal duplicate guard: duplicates=${summary.goal_input_guard.duplicate_goals}/` +
      `${summary.goal_input_guard.max_duplicate_goals}`
    ));
    if (summary.goal_input_guard.over_limit) {
      console.log(chalk.yellow('  Goal duplicate guard exceeded.'));
    }
  }
  if (summary.spec_session_prune && summary.spec_session_prune.enabled) {
    console.log(chalk.gray(
      `  Spec prune: deleted=${summary.spec_session_prune.deleted_count}, ` +
      `protected=${summary.spec_session_prune.protected_count}`
    ));
  }
  if (summary.spec_session_budget && summary.spec_session_budget.enabled) {
    console.log(chalk.gray(
      `  Spec budget: ${summary.spec_session_budget.total_after}/${summary.spec_session_budget.max_total} ` +
      `(created~${summary.spec_session_budget.estimated_created}, pruned=${summary.spec_session_budget.pruned_count})`
    ));
    if (summary.spec_session_budget.over_limit_after) {
      console.log(chalk.yellow(
        `  Spec budget exceeded (${summary.spec_session_budget.total_after} > ${summary.spec_session_budget.max_total})`
      ));
    }
  }
  if (summary.spec_session_growth_guard && summary.spec_session_growth_guard.enabled) {
    console.log(chalk.gray(
      `  Spec growth guard: created~${summary.spec_session_growth_guard.estimated_created}` +
      ` (per-goal=${summary.spec_session_growth_guard.estimated_created_per_goal})`
    ));
    if (summary.spec_session_growth_guard.over_limit) {
      console.log(chalk.yellow(`  Spec growth guard exceeded: ${summary.spec_session_growth_guard.reasons.join('; ')}`));
    }
  }
  if (summary.program_gate_auto_remediation && summary.program_gate_auto_remediation.enabled) {
    const autoRemediationActions = Array.isArray(summary.program_gate_auto_remediation.actions)
      ? summary.program_gate_auto_remediation.actions
      : [];
    console.log(chalk.gray(
      `  Program auto-remediation: actions=${autoRemediationActions.length}, ` +
      `next-patch=${summary.program_gate_auto_remediation.next_run_patch ? 'yes' : 'no'}`
    ));
  }
  if (summary.program_kpi_file) {
    console.log(chalk.gray(`  Program KPI file: ${summary.program_kpi_file}`));
  }
  if (summary.program_audit_file) {
    console.log(chalk.gray(`  Program audit file: ${summary.program_audit_file}`));
  }
  if (summary.output_file) {
    console.log(chalk.gray(`  Output: ${summary.output_file}`));
  }
}

async function maybeWriteOutput(result, outCandidate, projectPath) {
  if (!outCandidate) {
    return;
  }

  const outputPath = path.isAbsolute(outCandidate)
    ? outCandidate
    : path.join(projectPath, outCandidate);
  await fs.ensureDir(path.dirname(outputPath));
  await fs.writeJson(outputPath, result, { spaces: 2 });
  result.output_file = outputPath;
}

async function maybeWriteTextOutput(result, content, outCandidate, projectPath) {
  if (!outCandidate) {
    return;
  }

  const outputPath = path.isAbsolute(outCandidate)
    ? outCandidate
    : path.join(projectPath, outCandidate);
  await fs.ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, content, 'utf8');
  result.output_file = outputPath;
}

function normalizeAutoHandoffManifestPath(projectPath, manifestCandidate) {
  const candidate = typeof manifestCandidate === 'string'
    ? manifestCandidate.trim()
    : '';
  if (!candidate) {
    throw new Error('handoff manifest path is required');
  }
  return path.isAbsolute(candidate)
    ? candidate
    : path.join(projectPath, candidate);
}

function toAutoHandoffCliPath(projectPath, absolutePath) {
  const relative = path.relative(projectPath, absolutePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return absolutePath;
}

function quoteCliArg(value) {
  const raw = `${value || ''}`;
  if (raw.length === 0) {
    return '""';
  }
  if (!/[\s"'`]/.test(raw)) {
    return raw;
  }
  return `"${raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function readHandoffPathValue(input, keyPath) {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const parts = String(keyPath || '')
    .split('.')
    .map(part => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  let cursor = input;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || !(part in cursor)) {
      return null;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function readHandoffFirstPathValue(input, keyPaths = []) {
  const paths = Array.isArray(keyPaths) ? keyPaths : [];
  for (const keyPath of paths) {
    const value = readHandoffPathValue(input, keyPath);
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}

function normalizeHandoffNumber(value, options = {}) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const candidate = Number(value);
  if (!Number.isFinite(candidate)) {
    return null;
  }
  const min = Number.isFinite(options.min) ? Number(options.min) : null;
  const max = Number.isFinite(options.max) ? Number(options.max) : null;
  if (min !== null && candidate < min) {
    return null;
  }
  if (max !== null && candidate > max) {
    return null;
  }
  if (options.integer === true) {
    return Math.trunc(candidate);
  }
  const precision = Number.isInteger(options.precision) && options.precision >= 0
    ? options.precision
    : null;
  if (precision === null) {
    return candidate;
  }
  return Number(candidate.toFixed(precision));
}

function normalizeHandoffOntologyCollection(rawCollection) {
  if (Array.isArray(rawCollection)) {
    return rawCollection.filter(item => item && typeof item === 'object' && !Array.isArray(item));
  }
  if (!rawCollection || typeof rawCollection !== 'object' || Array.isArray(rawCollection)) {
    return [];
  }

  const listCandidate = rawCollection.items || rawCollection.values || rawCollection.list || rawCollection.nodes;
  if (Array.isArray(listCandidate)) {
    return listCandidate.filter(item => item && typeof item === 'object' && !Array.isArray(item));
  }

  return Object.values(rawCollection)
    .filter(item => item && typeof item === 'object' && !Array.isArray(item));
}

function normalizeHandoffOntologyModel(payload) {
  const modelRoot = readHandoffFirstPathValue(payload, [
    'model',
    'ontology_model',
    'semantic_model',
    'ontology.model'
  ]) || payload || {};

  const entityItems = normalizeHandoffOntologyCollection(
    readHandoffFirstPathValue(modelRoot, ['entities', 'entity_model.entities', 'entity_relations.entities'])
  );
  const relationItems = normalizeHandoffOntologyCollection(
    readHandoffFirstPathValue(modelRoot, ['relations', 'entity_relations.relations', 'relation_model.relations'])
  );
  const ruleItems = normalizeHandoffOntologyCollection(
    readHandoffFirstPathValue(modelRoot, ['business_rules', 'rules', 'governance.business_rules'])
  );
  const decisionItems = normalizeHandoffOntologyCollection(
    readHandoffFirstPathValue(modelRoot, ['decision_logic', 'decisions', 'governance.decision_logic'])
  );

  const entities = entityItems.map(item => ({
    id: normalizeHandoffIdentifier(item, ['id', 'ref', 'name', 'entity', 'code']) || null,
    type: normalizeHandoffText(item.type) || null
  }));

  const relations = relationItems.map(item => ({
    source: normalizeHandoffIdentifier(item, ['source', 'from', 'src', 'left', 'parent']) || null,
    target: normalizeHandoffIdentifier(item, ['target', 'to', 'dst', 'right', 'child']) || null,
    type: normalizeHandoffText(item.type || item.relation || item.relation_type) || null
  }));

  const rules = ruleItems.map(item => {
    const statusText = normalizeHandoffText(item.status || item.state || item.result || item.verdict);
    const statusToken = statusText ? statusText.toLowerCase() : null;
    const mapped = item.mapped === true
      || item.bound === true
      || Boolean(
        normalizeHandoffIdentifier(item, [
          'entity',
          'entity_ref',
          'target_ref',
          'bind_to',
          'applies_to',
          'scope_ref'
        ])
      );
    const passed = item.passed === true
      || item.valid === true
      || item.success === true
      || (statusToken
        ? ['passed', 'active', 'implemented', 'enforced', 'success', 'ok', 'valid'].includes(statusToken)
        : false);

    return {
      id: normalizeHandoffIdentifier(item, ['id', 'rule_id', 'name', 'ref']) || null,
      mapped,
      passed
    };
  });

  const decisions = decisionItems.map(item => {
    const statusText = normalizeHandoffText(item.status || item.state || item.result || item.outcome);
    const statusToken = statusText ? statusText.toLowerCase() : null;
    const resolved = item.resolved === true
      || item.applied === true
      || item.decided === true
      || item.completed === true
      || (statusToken
        ? ['resolved', 'decided', 'implemented', 'completed', 'active', 'success'].includes(statusToken)
        : false);
    const automated = item.automated === true
      || item.tested === true
      || item.simulated === true;

    return {
      id: normalizeHandoffIdentifier(item, ['id', 'decision_id', 'name', 'ref']) || null,
      resolved,
      automated
    };
  });

  return {
    entities,
    relations,
    business_rules: rules,
    decision_logic: decisions
  };
}

function normalizeHandoffIdentifier(entry, fieldCandidates = []) {
  const directText = normalizeHandoffText(entry);
  if (directText) {
    return directText;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }

  for (const field of fieldCandidates) {
    const value = readHandoffPathValue(entry, field);
    const normalized = normalizeHandoffText(value);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function collectUniqueIdentifiers(rawEntries, fieldCandidates, label) {
  const warnings = [];
  if (rawEntries === undefined || rawEntries === null) {
    return { values: [], warnings };
  }
  if (!Array.isArray(rawEntries)) {
    return {
      values: [],
      warnings: [`${label} must be an array`]
    };
  }

  const values = [];
  const seen = new Set();
  rawEntries.forEach((entry, index) => {
    const normalized = normalizeHandoffIdentifier(entry, fieldCandidates);
    if (!normalized) {
      warnings.push(`${label}[${index}] is invalid and was ignored`);
      return;
    }
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    values.push(normalized);
  });

  return { values, warnings };
}

function normalizeAutoHandoffTemplateCapabilityCandidate(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const raw = `${value}`.trim();
  if (!raw) {
    return null;
  }
  const normalizedPath = raw.toLowerCase().replace(/\\/g, '/');
  const baseName = normalizedPath.split('/').pop() || normalizedPath;
  let candidate = baseName.replace(/^[a-z0-9-]+\.scene--/, 'scene--');
  candidate = candidate.replace(/^scene--/, '');
  candidate = candidate.replace(
    /--\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/,
    ''
  );
  candidate = candidate.replace(/--\d{4}(?:-\d{2}){1,2}(?:-[a-z0-9-]+)?$/, '');
  return normalizeMoquiCapabilityToken(candidate);
}

function inferManifestCapabilitiesFromTemplates(
  templateIdentifiers = [],
  lexiconIndex = MOQUI_CAPABILITY_LEXICON_INDEX
) {
  const inferred = [];
  const inferredSet = new Set();
  const inferredFrom = [];
  const unresolvedTemplates = [];
  const unresolvedSet = new Set();

  if (!Array.isArray(templateIdentifiers) || templateIdentifiers.length === 0) {
    return {
      capabilities: inferred,
      inferred_from: inferredFrom,
      unresolved_templates: unresolvedTemplates
    };
  }

  for (const templateIdentifier of templateIdentifiers) {
    const candidate = normalizeAutoHandoffTemplateCapabilityCandidate(templateIdentifier);
    if (!candidate) {
      continue;
    }
    const descriptor = resolveMoquiCapabilityDescriptor(candidate, lexiconIndex);
    if (descriptor && descriptor.is_known) {
      if (!inferredSet.has(descriptor.canonical)) {
        inferredSet.add(descriptor.canonical);
        inferred.push(descriptor.canonical);
      }
      inferredFrom.push({
        template: templateIdentifier,
        normalized_template: candidate,
        capability: descriptor.canonical
      });
      continue;
    }
    if (!unresolvedSet.has(templateIdentifier)) {
      unresolvedSet.add(templateIdentifier);
      unresolvedTemplates.push(templateIdentifier);
    }
  }

  return {
    capabilities: inferred,
    inferred_from: inferredFrom,
    unresolved_templates: unresolvedTemplates
  };
}

function normalizeHandoffDependencyEntry(entry) {
  return normalizeHandoffIdentifier(entry, [
    'name',
    'spec',
    'spec_name',
    'spec_id',
    'id',
    'spec.name',
    'spec.id'
  ]);
}

function normalizeHandoffDependencyList(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return [];
  }
  const raw =
    readHandoffPathValue(entry, 'depends_on')
    || readHandoffPathValue(entry, 'dependsOn')
    || readHandoffPathValue(entry, 'dependencies')
    || readHandoffPathValue(entry, 'depends')
    || readHandoffPathValue(entry, 'requires')
    || null;
  if (!raw) {
    return [];
  }

  let candidates = [];
  if (Array.isArray(raw)) {
    candidates = raw;
  } else if (typeof raw === 'string') {
    candidates = raw
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  } else {
    candidates = [raw];
  }

  const values = [];
  const seen = new Set();
  for (const item of candidates) {
    const normalized = normalizeHandoffDependencyEntry(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    values.push(normalized);
  }
  return values;
}

function collectHandoffSpecDescriptors(rawEntries) {
  const warnings = [];
  if (rawEntries === undefined || rawEntries === null) {
    return {
      values: [],
      descriptors: [],
      warnings: ['specs must be an array']
    };
  }
  if (!Array.isArray(rawEntries)) {
    return {
      values: [],
      descriptors: [],
      warnings: ['specs must be an array']
    };
  }

  const values = [];
  const descriptors = [];
  const seen = new Set();
  const descriptorMap = new Map();

  rawEntries.forEach((entry, index) => {
    const name = normalizeHandoffIdentifier(entry, [
      'name',
      'spec',
      'spec_name',
      'spec_id',
      'id',
      'spec.name',
      'spec.id'
    ]);
    if (!name) {
      warnings.push(`specs[${index}] is invalid and was ignored`);
      return;
    }
    const dependsOn = normalizeHandoffDependencyList(entry);
    if (!seen.has(name)) {
      seen.add(name);
      values.push(name);
      const descriptor = {
        name,
        depends_on: dependsOn
      };
      descriptors.push(descriptor);
      descriptorMap.set(name, descriptor);
      return;
    }

    const existing = descriptorMap.get(name);
    const existingSet = new Set(existing.depends_on);
    for (const dep of dependsOn) {
      if (!existingSet.has(dep)) {
        existingSet.add(dep);
        existing.depends_on.push(dep);
      }
    }
  });

  const specSet = new Set(values);
  descriptors.forEach(item => {
    const filtered = [];
    const seenDeps = new Set();
    item.depends_on.forEach(dep => {
      if (dep === item.name) {
        warnings.push(`spec ${item.name} dependency "${dep}" ignored (self reference)`);
        return;
      }
      if (!specSet.has(dep)) {
        warnings.push(`spec ${item.name} dependency "${dep}" ignored (not found in specs list)`);
        return;
      }
      if (seenDeps.has(dep)) {
        return;
      }
      seenDeps.add(dep);
      filtered.push(dep);
    });
    item.depends_on = filtered;
  });

  return { values, descriptors, warnings };
}

function buildAutoHandoffDependencyBatches(specDescriptors = []) {
  const normalized = Array.isArray(specDescriptors)
    ? specDescriptors
      .filter(item => item && typeof item.name === 'string' && item.name.trim().length > 0)
      .map(item => ({
        name: item.name.trim(),
        depends_on: Array.isArray(item.depends_on)
          ? item.depends_on
            .map(dep => `${dep || ''}`.trim())
            .filter(Boolean)
          : []
      }))
    : [];
  const warnings = [];
  if (normalized.length === 0) {
    return {
      enabled: true,
      batch_count: 0,
      batches: [],
      warnings,
      cyclic: false
    };
  }

  const nodeMap = new Map();
  normalized.forEach(item => nodeMap.set(item.name, item));
  normalized.forEach(item => {
    item.depends_on = item.depends_on.filter(dep => nodeMap.has(dep) && dep !== item.name);
  });

  const remaining = new Set(normalized.map(item => item.name));
  const batches = [];
  let cyclic = false;
  while (remaining.size > 0) {
    const ready = [];
    for (const name of remaining) {
      const node = nodeMap.get(name);
      const blocked = node.depends_on.some(dep => remaining.has(dep));
      if (!blocked) {
        ready.push(name);
      }
    }

    if (ready.length === 0) {
      cyclic = true;
      const fallback = Array.from(remaining).sort();
      warnings.push('spec dependency cycle detected; fallback to one final merged batch');
      batches.push({
        index: batches.length + 1,
        specs: fallback
      });
      break;
    }

    ready.sort();
    batches.push({
      index: batches.length + 1,
      specs: ready
    });
    ready.forEach(name => remaining.delete(name));
  }

  return {
    enabled: true,
    batch_count: batches.length,
    batches,
    warnings,
    cyclic
  };
}

function collectKnownGaps(rawKnownGaps) {
  const warnings = [];
  if (rawKnownGaps === undefined || rawKnownGaps === null) {
    return { gaps: [], warnings };
  }
  if (!Array.isArray(rawKnownGaps)) {
    return {
      gaps: [],
      warnings: ['known_gaps must be an array']
    };
  }

  const gaps = [];
  rawKnownGaps.forEach((entry, index) => {
    const normalized = normalizeHandoffIdentifier(entry, [
      'gap',
      'title',
      'description',
      'message',
      'name',
      'id'
    ]);
    if (!normalized) {
      warnings.push(`known_gaps[${index}] is invalid and was ignored`);
      return;
    }
    gaps.push(normalized);
  });
  return { gaps, warnings };
}

function normalizeAutoHandoffManifest(payload = {}) {
  const validationErrors = [];
  const validationWarnings = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('handoff manifest must be a JSON object');
  }

  const sourceProject = normalizeHandoffText(payload.source_project);
  if (!sourceProject) {
    validationWarnings.push('source_project is missing');
  }

  const timestamp = normalizeHandoffText(payload.timestamp);
  if (!timestamp) {
    validationWarnings.push('timestamp is missing');
  }

  const specsCollected = collectHandoffSpecDescriptors(payload.specs);
  validationWarnings.push(...specsCollected.warnings);
  if (specsCollected.values.length === 0) {
    validationErrors.push('specs must include at least one valid spec identifier');
  }
  const dependencyBatches = buildAutoHandoffDependencyBatches(specsCollected.descriptors);
  validationWarnings.push(...dependencyBatches.warnings);

  const templatesCollected = collectUniqueIdentifiers(
    payload.templates,
    ['name', 'template', 'template_name', 'id', 'template.id', 'template.name'],
    'templates'
  );
  validationWarnings.push(...templatesCollected.warnings);
  if (templatesCollected.values.length === 0) {
    validationWarnings.push('templates is empty');
  }

  const capabilitiesCollected = collectUniqueIdentifiers(
    payload.capabilities,
    ['name', 'capability', 'capability_name', 'id', 'capability.id', 'capability.name'],
    'capabilities'
  );
  validationWarnings.push(...capabilitiesCollected.warnings);
  const capabilityInference = inferManifestCapabilitiesFromTemplates(
    templatesCollected.values,
    MOQUI_CAPABILITY_LEXICON_INDEX
  );
  let capabilityValues = capabilitiesCollected.values;
  let capabilitySource = 'manifest';
  if (capabilitiesCollected.values.length === 0) {
    if (capabilityInference.capabilities.length > 0) {
      capabilityValues = capabilityInference.capabilities;
      capabilitySource = 'inferred-from-templates';
      validationWarnings.push(
        `capabilities not declared; inferred ${capabilityValues.length} canonical capabilities from templates`
      );
      if (capabilityInference.unresolved_templates.length > 0) {
        const preview = capabilityInference.unresolved_templates.slice(0, 5).join(', ');
        const suffix = capabilityInference.unresolved_templates.length > 5
          ? ` (+${capabilityInference.unresolved_templates.length - 5} more)`
          : '';
        validationWarnings.push(
          `template capability inference skipped ${capabilityInference.unresolved_templates.length} templates not found in lexicon: ${preview}${suffix}`
        );
      }
    } else {
      capabilitySource = 'none';
      validationWarnings.push('capabilities is empty; capability coverage gate will be skipped unless capabilities are declared');
    }
  }

  const knownGapCollected = collectKnownGaps(payload.known_gaps);
  validationWarnings.push(...knownGapCollected.warnings);

  const ontologyValidation = payload.ontology_validation && typeof payload.ontology_validation === 'object'
    ? payload.ontology_validation
    : null;
  if (!ontologyValidation) {
    validationWarnings.push('ontology_validation is missing');
  }

  const nextBatch = payload.next_batch && typeof payload.next_batch === 'object'
    ? payload.next_batch
    : null;

  return {
    source_project: sourceProject,
    timestamp,
    specs: specsCollected.values,
    spec_descriptors: specsCollected.descriptors,
    dependency_batches: dependencyBatches,
    templates: templatesCollected.values,
    capabilities: capabilityValues,
    capability_source: capabilitySource,
    capability_inference: {
      applied: capabilitySource === 'inferred-from-templates',
      inferred_count: capabilityInference.capabilities.length,
      inferred_capabilities: capabilityInference.capabilities,
      inferred_from_templates: capabilityInference.inferred_from,
      unresolved_template_count: capabilityInference.unresolved_templates.length,
      unresolved_templates: capabilityInference.unresolved_templates
    },
    known_gaps: knownGapCollected.gaps,
    ontology_validation: ontologyValidation,
    next_batch: nextBatch,
    validation: {
      errors: validationErrors,
      warnings: validationWarnings
    }
  };
}

async function loadAutoHandoffManifest(projectPath, manifestCandidate) {
  const manifestPath = normalizeAutoHandoffManifestPath(projectPath, manifestCandidate);
  if (!await fs.pathExists(manifestPath)) {
    throw new Error(`handoff manifest not found: ${manifestPath}`);
  }

  let payload;
  try {
    payload = await fs.readJson(manifestPath);
  } catch (error) {
    throw new Error(`invalid handoff manifest JSON: ${manifestPath} (${error.message})`);
  }

  const normalized = normalizeAutoHandoffManifest(payload);
  return {
    manifest_path: manifestPath,
    manifest_file: toAutoHandoffCliPath(projectPath, manifestPath),
    ...normalized
  };
}

function buildAutoHandoffPhaseCommands(projectPath, manifestPath, specs = []) {
  const manifestCli = quoteCliArg(toAutoHandoffCliPath(projectPath, manifestPath));
  const phases = [];

  phases.push({
    id: 'precheck',
    title: 'Precheck',
    goal: 'Validate handoff manifest integrity and repository readiness',
    commands: [
      `sce auto handoff plan --manifest ${manifestCli} --json`,
      'sce auto governance stats --json'
    ]
  });

  const specCommands = [];
  for (const specName of specs) {
    const specArg = quoteCliArg(specName);
    const specPackagePath = quoteCliArg(`.sce/specs/${specName}/custom`);
    specCommands.push(`sce auto spec status ${specArg} --json`);
    specCommands.push(`sce auto spec instructions ${specArg} --json`);
    specCommands.push(`sce scene package-validate --spec ${specArg} --spec-package custom/scene-package.json --strict --json`);
    specCommands.push(`sce scene ontology validate --package ${specPackagePath} --json`);
  }
  phases.push({
    id: 'spec-validation',
    title: 'Spec Validation',
    goal: 'Validate spec docs, tasks, scene package contract, and ontology consistency',
    commands: specCommands
  });

  const queueCli = quoteCliArg(AUTO_HANDOFF_DEFAULT_QUEUE_FILE);
  phases.push({
    id: 'execution',
    title: 'Autonomous Execution',
    goal: 'Generate queue goals and run autonomous close-loop batch integration',
    commands: [
      `sce auto handoff queue --manifest ${manifestCli} --out ${queueCli} --json`,
      `sce auto close-loop-batch ${queueCli} --format lines --json`
    ]
  });

  phases.push({
    id: 'observability',
    title: 'Observability and Governance',
    goal: 'Snapshot integration evidence and plan remaining governance actions',
    commands: [
      'sce auto observability snapshot --json',
      'sce auto governance maintain --session-keep 50 --batch-session-keep 50 --controller-session-keep 50 --json'
    ]
  });

  return phases;
}

async function buildAutoHandoffPlan(projectPath, options = {}) {
  const handoff = await loadAutoHandoffManifest(projectPath, options.manifest);
  const validationErrors = Array.isArray(handoff.validation.errors) ? handoff.validation.errors : [];
  const validationWarnings = Array.isArray(handoff.validation.warnings) ? handoff.validation.warnings : [];

  if (options.strict && validationErrors.length > 0) {
    throw new Error(`handoff plan validation failed: ${validationErrors.join('; ')}`);
  }
  if (options.strictWarnings && validationWarnings.length > 0) {
    throw new Error(`handoff plan validation warnings: ${validationWarnings.join('; ')}`);
  }

  const phases = buildAutoHandoffPhaseCommands(projectPath, handoff.manifest_path, handoff.specs);
  return {
    mode: 'auto-handoff-plan',
    generated_at: new Date().toISOString(),
    manifest_path: handoff.manifest_path,
    source_project: handoff.source_project,
    handoff: {
      timestamp: handoff.timestamp,
      spec_count: handoff.specs.length,
      template_count: handoff.templates.length,
      capability_count: Array.isArray(handoff.capabilities) ? handoff.capabilities.length : 0,
      known_gap_count: handoff.known_gaps.length,
      specs: handoff.specs,
      spec_descriptors: handoff.spec_descriptors,
      dependency_batches: handoff.dependency_batches,
      templates: handoff.templates,
      capabilities: handoff.capabilities,
      capability_source: handoff.capability_source || 'manifest',
      capability_inference: handoff.capability_inference && typeof handoff.capability_inference === 'object'
        ? handoff.capability_inference
        : {
          applied: false,
          inferred_count: 0,
          inferred_capabilities: [],
          inferred_from_templates: [],
          unresolved_template_count: 0,
          unresolved_templates: []
        },
      known_gaps: handoff.known_gaps,
      ontology_validation: handoff.ontology_validation,
      next_batch: handoff.next_batch
    },
    validation: {
      is_valid: validationErrors.length === 0,
      errors: validationErrors,
      warnings: validationWarnings
    },
    phases,
    recommendations: [
      `sce auto handoff queue --manifest ${quoteCliArg(handoff.manifest_file)} --out ${quoteCliArg(AUTO_HANDOFF_DEFAULT_QUEUE_FILE)} --json`,
      `sce auto close-loop-batch ${quoteCliArg(AUTO_HANDOFF_DEFAULT_QUEUE_FILE)} --format lines --json`
    ]
  };
}

function buildAutoHandoffQueueGoals(handoff, options = {}) {
  const includeKnownGaps = options.includeKnownGaps !== false;
  const goals = [];
  const seen = new Set();
  const pushGoal = value => {
    const normalized = normalizeHandoffText(value);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    goals.push(normalized);
  };

  for (const specName of handoff.specs) {
    pushGoal(`integrate handoff spec ${specName} with scene package validation, ontology consistency checks, and close-loop completion`);
  }

  for (const templateName of handoff.templates) {
    pushGoal(`validate handoff template ${templateName} for template registry compatibility and release readiness`);
  }

  if (includeKnownGaps) {
    for (const gap of handoff.known_gaps) {
      pushGoal(`remediate handoff known gap: ${gap}`);
    }
  }

  pushGoal('generate unified observability snapshot and governance follow-up recommendations for this handoff batch');
  return goals;
}

async function buildAutoHandoffQueue(projectPath, options = {}) {
  const handoff = await loadAutoHandoffManifest(projectPath, options.manifest);
  const validationErrors = Array.isArray(handoff.validation.errors) ? handoff.validation.errors : [];
  if (validationErrors.length > 0) {
    throw new Error(`handoff queue validation failed: ${validationErrors.join('; ')}`);
  }

  const includeKnownGaps = options.includeKnownGaps !== false;
  const goals = buildAutoHandoffQueueGoals(handoff, { includeKnownGaps });
  if (goals.length === 0) {
    throw new Error('handoff queue produced no goals');
  }

  return {
    mode: 'auto-handoff-queue',
    generated_at: new Date().toISOString(),
    manifest_path: handoff.manifest_path,
    dry_run: Boolean(options.dryRun),
    append: Boolean(options.append),
    include_known_gaps: includeKnownGaps,
    goal_count: goals.length,
    goals,
    validation: {
      errors: handoff.validation.errors,
      warnings: handoff.validation.warnings
    },
    recommendations: [
      `sce auto close-loop-batch ${quoteCliArg(options.out || AUTO_HANDOFF_DEFAULT_QUEUE_FILE)} --format lines --json`
    ]
  };
}

async function writeAutoHandoffQueueFile(projectPath, queueResult, options = {}) {
  const outCandidate = typeof options.out === 'string' && options.out.trim().length > 0
    ? options.out.trim()
    : AUTO_HANDOFF_DEFAULT_QUEUE_FILE;
  const outputPath = path.isAbsolute(outCandidate)
    ? outCandidate
    : path.join(projectPath, outCandidate);
  await fs.ensureDir(path.dirname(outputPath));

  const content = `${queueResult.goals.join('\n')}\n`;
  if (options.append && await fs.pathExists(outputPath)) {
    const existing = await fs.readFile(outputPath, 'utf8');
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await fs.appendFile(outputPath, `${separator}${content}`, 'utf8');
  } else {
    await fs.writeFile(outputPath, content, 'utf8');
  }

  queueResult.output_file = outputPath;
}

async function listDirectoryNamesIfExists(baseDir) {
  if (!await fs.pathExists(baseDir)) {
    return [];
  }
  const entries = await fs.readdir(baseDir);
  const names = [];
  for (const entry of entries) {
    const fullPath = path.join(baseDir, entry);
    try {
      const stats = await fs.stat(fullPath);
      if (stats.isDirectory()) {
        names.push(entry);
      }
    } catch (error) {
      // Ignore ephemeral or unreadable entries.
    }
  }
  return names;
}

function collectTemplateNamesFromPayload(payload, sink = new Set(), depth = 0) {
  if (depth > 6 || payload === null || payload === undefined) {
    return sink;
  }
  if (Array.isArray(payload)) {
    payload.forEach(item => collectTemplateNamesFromPayload(item, sink, depth + 1));
    return sink;
  }
  if (typeof payload !== 'object') {
    return sink;
  }

  const directName = normalizeHandoffIdentifier(payload, [
    'name',
    'template',
    'template_name',
    'template.id',
    'template.name'
  ]);
  if (directName) {
    sink.add(directName);
  }

  const candidateKeys = [
    'templates',
    'items',
    'entries',
    'packages',
    'registry',
    'values',
    'data'
  ];
  candidateKeys.forEach(key => {
    if (key in payload) {
      collectTemplateNamesFromPayload(payload[key], sink, depth + 1);
    }
  });

  return sink;
}

async function collectLocalTemplateNames(projectPath) {
  const names = new Set();
  const templateRoot = path.join(projectPath, '.sce', 'templates');
  const exportRoot = path.join(templateRoot, 'exports');
  const sceneTemplateRoot = path.join(templateRoot, 'scene-packages');
  const registryFile = path.join(sceneTemplateRoot, 'registry.json');

  (await listDirectoryNamesIfExists(templateRoot))
    .filter(name => !['exports', 'scene-packages'].includes(name))
    .forEach(name => names.add(name));

  (await listDirectoryNamesIfExists(exportRoot)).forEach(name => names.add(name));
  (await listDirectoryNamesIfExists(sceneTemplateRoot))
    .filter(name => name !== 'archives')
    .forEach(name => names.add(name));

  if (await fs.pathExists(registryFile)) {
    try {
      const payload = await fs.readJson(registryFile);
      collectTemplateNamesFromPayload(payload, names);
    } catch (error) {
      // Ignore parse failures; template diff should still work with filesystem signals.
    }
  }

  return Array.from(names).sort((left, right) => left.localeCompare(right));
}

async function buildAutoHandoffTemplateDiff(projectPath, options = {}) {
  const handoff = options.handoff && typeof options.handoff === 'object'
    ? options.handoff
    : await loadAutoHandoffManifest(projectPath, options.manifest);
  const manifestTemplates = Array.isArray(handoff.templates)
    ? handoff.templates.map(item => `${item || ''}`.trim()).filter(Boolean)
    : [];
  const localTemplates = await collectLocalTemplateNames(projectPath);

  const manifestSet = new Set(manifestTemplates);
  const localSet = new Set(localTemplates);
  const missingInLocal = manifestTemplates.filter(item => !localSet.has(item));
  const extraInLocal = localTemplates.filter(item => !manifestSet.has(item));
  const matched = manifestTemplates.filter(item => localSet.has(item));
  const compatibility = missingInLocal.length === 0 ? 'ready' : 'needs-sync';

  return {
    mode: 'auto-handoff-template-diff',
    generated_at: new Date().toISOString(),
    manifest_path: handoff.manifest_path || null,
    manifest: {
      template_count: manifestTemplates.length,
      templates: manifestTemplates
    },
    local: {
      template_count: localTemplates.length,
      templates: localTemplates
    },
    diff: {
      matched,
      missing_in_local: missingInLocal,
      extra_in_local: extraInLocal
    },
    compatibility,
    recommendations: compatibility === 'ready'
      ? []
      : [
        'sync missing templates from handoff source into .sce/templates/exports or scene-packages registry',
        're-run `sce auto handoff template-diff --manifest <path> --json` after sync'
      ]
  };
}

function buildAutoHandoffSpecGoalLookup(handoff, queueGoals = []) {
  const specs = Array.isArray(handoff && handoff.specs)
    ? handoff.specs.map(item => `${item || ''}`.trim()).filter(Boolean)
    : [];
  const goals = Array.isArray(queueGoals) ? queueGoals : [];
  const goalMap = new Map();
  const usedGoalIndexes = new Set();
  const warnings = [];

  specs.forEach(specName => {
    const prefix = `integrate handoff spec ${specName}`.toLowerCase();
    const goalIndex = goals.findIndex((goal, index) => {
      if (usedGoalIndexes.has(index)) {
        return false;
      }
      const normalizedGoal = `${goal || ''}`.trim().toLowerCase();
      return normalizedGoal.startsWith(prefix);
    });
    if (goalIndex < 0) {
      warnings.push(`spec goal not found in queue for ${specName}`);
      return;
    }
    usedGoalIndexes.add(goalIndex);
    goalMap.set(specName, goals[goalIndex]);
  });

  return {
    goal_map: goalMap,
    used_goal_indexes: usedGoalIndexes,
    warnings
  };
}

function buildAutoHandoffExecutionBatches(handoff, queueGoals = [], dependencyBatching = true) {
  const dependencyPlan = handoff && handoff.dependency_batches && handoff.dependency_batches.enabled
    ? handoff.dependency_batches
    : buildAutoHandoffDependencyBatches(Array.isArray(handoff && handoff.spec_descriptors) ? handoff.spec_descriptors : []);
  const lookup = buildAutoHandoffSpecGoalLookup(handoff, queueGoals);
  const queue = Array.isArray(queueGoals) ? queueGoals : [];
  const used = new Set(lookup.used_goal_indexes);
  const batches = [];

  if (dependencyBatching) {
    const sourceBatches = Array.isArray(dependencyPlan.batches) ? dependencyPlan.batches : [];
    sourceBatches.forEach(batch => {
      const specs = Array.isArray(batch && batch.specs) ? batch.specs : [];
      const goals = specs
        .map(spec => lookup.goal_map.get(spec))
        .filter(Boolean);
      if (goals.length === 0) {
        return;
      }
      batches.push({
        id: `spec-batch-${batch.index}`,
        type: 'spec',
        title: `Spec dependency batch ${batch.index}`,
        specs,
        goals
      });
    });
  } else {
    const allSpecGoals = Array.from(lookup.goal_map.values());
    if (allSpecGoals.length > 0) {
      batches.push({
        id: 'spec-batch-1',
        type: 'spec',
        title: 'Spec integration batch',
        specs: Array.from(lookup.goal_map.keys()),
        goals: allSpecGoals
      });
    }
  }

  const remainingGoals = queue.filter((goal, index) => !used.has(index));
  if (remainingGoals.length > 0) {
    batches.push({
      id: 'post-spec-batch',
      type: 'post-spec',
      title: 'Template, known-gap, and observability goals',
      specs: [],
      goals: remainingGoals
    });
  }

  if (batches.length === 0 && queue.length > 0) {
    batches.push({
      id: 'fallback-batch',
      type: 'fallback',
      title: 'Fallback full queue batch',
      specs: [],
      goals: queue
    });
  }

  return {
    dependency_batching: dependencyBatching,
    dependency_plan: dependencyPlan,
    batches,
    warnings: lookup.warnings
  };
}

function mergeAutoHandoffBatchSummaries(batchSummaries = [], mode = 'auto-handoff-run') {
  const summaries = Array.isArray(batchSummaries) ? batchSummaries.filter(Boolean) : [];
  if (summaries.length === 0) {
    return {
      mode,
      status: 'completed',
      goals_file: null,
      total_goals: 0,
      processed_goals: 0,
      completed_goals: 0,
      failed_goals: 0,
      batch_parallel: 0,
      resource_plan: null,
      batch_retry: {
        enabled: false,
        strategy: 'adaptive',
        until_complete: false,
        configured_rounds: 0,
        max_rounds: 0,
        performed_rounds: 0,
        exhausted: false,
        history: []
      },
      stopped_early: false,
      metrics: buildBatchMetrics([], 0),
      results: []
    };
  }

  const results = [];
  let aggregateResourcePlan = null;
  let batchParallel = 0;
  let stoppedEarly = false;
  let configuredRetryRounds = 0;
  let maxRetryRounds = 0;
  let performedRetryRounds = 0;
  let retryExhausted = false;
  let retryEnabled = false;
  let retryUntilComplete = false;
  const retryHistory = [];
  const retryStrategies = new Set();
  let totalGoals = 0;
  let processedGoals = 0;
  let completedGoals = 0;
  let failedGoals = 0;

  summaries.forEach(summary => {
    results.push(...(Array.isArray(summary.results) ? summary.results : []));
    totalGoals += Number(summary.total_goals) || 0;
    processedGoals += Number(summary.processed_goals) || 0;
    completedGoals += Number(summary.completed_goals) || 0;
    failedGoals += Number(summary.failed_goals) || 0;
    batchParallel = Math.max(batchParallel, Number(summary.batch_parallel) || 0);
    aggregateResourcePlan = mergeBatchResourcePlans(aggregateResourcePlan, summary.resource_plan);
    stoppedEarly = stoppedEarly || Boolean(summary.stopped_early);

    const retry = summary && summary.batch_retry ? summary.batch_retry : {};
    retryEnabled = retryEnabled || Boolean(retry.enabled);
    retryUntilComplete = retryUntilComplete || Boolean(retry.until_complete);
    retryExhausted = retryExhausted || Boolean(retry.exhausted);
    configuredRetryRounds += Number(retry.configured_rounds) || 0;
    maxRetryRounds += Number(retry.max_rounds) || 0;
    performedRetryRounds += Number(retry.performed_rounds) || 0;
    if (retry.strategy) {
      retryStrategies.add(retry.strategy);
    }
    const history = Array.isArray(retry.history) ? retry.history : [];
    retryHistory.push(...history);
  });

  const status = failedGoals === 0
    ? 'completed'
    : completedGoals === 0
      ? 'failed'
      : 'partial-failed';

  return {
    mode,
    status,
    goals_file: summaries[0].goals_file || null,
    resumed_from_summary: null,
    generated_from_goal: null,
    total_goals: totalGoals,
    processed_goals: processedGoals,
    completed_goals: completedGoals,
    failed_goals: failedGoals,
    batch_parallel: batchParallel,
    autonomous_policy: {
      enabled: true,
      source: 'handoff',
      continue_on_error: true,
      batch_parallel: batchParallel,
      batch_retry_rounds: configuredRetryRounds,
      batch_retry_until_complete: retryUntilComplete
    },
    resource_plan: aggregateResourcePlan,
    batch_retry: {
      enabled: retryEnabled,
      strategy: retryStrategies.size === 1 ? Array.from(retryStrategies)[0] : 'mixed',
      until_complete: retryUntilComplete,
      configured_rounds: configuredRetryRounds,
      max_rounds: maxRetryRounds,
      performed_rounds: performedRetryRounds,
      exhausted: retryExhausted,
      history: retryHistory
    },
    stopped_early: stoppedEarly,
    metrics: buildBatchMetrics(results, totalGoals),
    goal_input_guard: {
      enabled: false,
      max_duplicate_goals: null,
      duplicate_goals: 0,
      unique_goals: totalGoals,
      duplicate_examples: [],
      over_limit: false,
      hard_fail_triggered: false
    },
    results
  };
}

async function executeAutoHandoffExecutionBatches(projectPath, handoff, queue, options = {}) {
  const queueGoals = Array.isArray(queue && queue.goals) ? queue.goals : [];
  const executionPlan = buildAutoHandoffExecutionBatches(
    handoff,
    queueGoals,
    options.dependencyBatching !== false
  );
  const executionBatches = [];
  const summaries = [];

  for (const batch of executionPlan.batches) {
    const goals = Array.isArray(batch.goals) ? batch.goals : [];
    if (goals.length === 0) {
      continue;
    }
    const goalsResult = {
      file: queue && queue.output_file
        ? queue.output_file
        : path.join(projectPath, options.queueOut || AUTO_HANDOFF_DEFAULT_QUEUE_FILE),
      goals
    };
    const summary = await executeCloseLoopBatch(goalsResult, {
      continueOnError: options.continueOnError !== false,
      batchAutonomous: options.batchAutonomous !== false,
      batchParallel: options.batchParallel,
      batchAgentBudget: options.batchAgentBudget,
      batchRetryRounds: options.batchRetryRounds,
      batchRetryUntilComplete: options.batchRetryUntilComplete,
      batchRetryMaxRounds: options.batchRetryMaxRounds,
      batchSession: true
    }, projectPath, 'auto-handoff-run');
    summaries.push(summary);
    executionBatches.push({
      id: batch.id,
      type: batch.type,
      title: batch.title,
      specs: batch.specs,
      goal_count: goals.length,
      status: summary.status,
      failed_goals: summary.failed_goals
    });
  }

  return {
    summary: mergeAutoHandoffBatchSummaries(summaries, 'auto-handoff-run'),
    execution_batches: executionBatches,
    execution_plan: executionPlan
  };
}

function normalizeHandoffSessionQuery(sessionCandidate) {
  const normalized = typeof sessionCandidate === 'string'
    ? sessionCandidate.trim()
    : 'latest';
  return normalized || 'latest';
}

function normalizeHandoffRegressionWindow(windowCandidate) {
  if (windowCandidate === undefined || windowCandidate === null) {
    return 2;
  }
  const parsed = Number(windowCandidate);
  if (!Number.isInteger(parsed) || parsed < 2 || parsed > 50) {
    throw new Error('--window must be an integer between 2 and 50.');
  }
  return parsed;
}

function normalizeHandoffEvidenceWindow(windowCandidate) {
  if (windowCandidate === undefined || windowCandidate === null) {
    return 5;
  }
  const parsed = Number(windowCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new Error('--window must be an integer between 1 and 50.');
  }
  return parsed;
}

function normalizeHandoffGateHistoryKeep(keepCandidate) {
  if (keepCandidate === undefined || keepCandidate === null) {
    return 200;
  }
  const parsed = Number(keepCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5000) {
    throw new Error('--keep must be an integer between 1 and 5000.');
  }
  return parsed;
}

function normalizeHandoffRegressionFormat(formatCandidate) {
  const normalized = typeof formatCandidate === 'string'
    ? formatCandidate.trim().toLowerCase()
    : 'json';
  if (!['json', 'markdown'].includes(normalized)) {
    throw new Error('--format must be one of: json, markdown.');
  }
  return normalized;
}

function normalizeHandoffContinueStrategy(strategyCandidate) {
  const normalized = typeof strategyCandidate === 'string'
    ? strategyCandidate.trim().toLowerCase()
    : 'auto';
  if (!['auto', 'pending', 'failed-only'].includes(normalized)) {
    throw new Error('--continue-strategy must be one of: auto, pending, failed-only.');
  }
  return normalized;
}

function resolveAutoHandoffContinueStrategy(requestedStrategy, summary = null) {
  const strategyRequested = normalizeHandoffContinueStrategy(requestedStrategy);
  if (strategyRequested !== 'auto') {
    return {
      strategy: strategyRequested,
      strategy_requested: strategyRequested,
      strategy_reason: 'explicit'
    };
  }

  const payload = summary && typeof summary === 'object' ? summary : {};
  const results = Array.isArray(payload.results) ? payload.results : [];
  const totalGoals = Number(payload.total_goals);
  const processedGoals = Number(payload.processed_goals);
  const hasUnprocessed = Number.isInteger(totalGoals) && Number.isInteger(processedGoals) && processedGoals < totalGoals;
  const hasPlannedLike = results.some(item => {
    const status = `${item && item.status ? item.status : ''}`.trim().toLowerCase();
    return ['unknown', 'stopped', 'planned', 'prepared'].includes(status);
  });
  const hasFailed = results.some(item => {
    const status = `${item && item.status ? item.status : ''}`.trim().toLowerCase();
    return ['failed', 'error'].includes(status);
  });

  if (hasUnprocessed || hasPlannedLike) {
    return {
      strategy: 'pending',
      strategy_requested: 'auto',
      strategy_reason: hasUnprocessed ? 'auto-detected-unprocessed' : 'auto-detected-planned'
    };
  }
  if (hasFailed) {
    return {
      strategy: 'failed-only',
      strategy_requested: 'auto',
      strategy_reason: 'auto-detected-failed-only'
    };
  }
  return {
    strategy: 'pending',
    strategy_requested: 'auto',
    strategy_reason: 'auto-default-pending'
  };
}

async function listAutoHandoffRunReports(projectPath) {
  const dirPath = path.join(projectPath, AUTO_HANDOFF_RUN_REPORT_DIR);
  if (!await fs.pathExists(dirPath)) {
    return [];
  }
  const entries = await fs.readdir(dirPath);
  const reports = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.json')) {
      continue;
    }
    const filePath = path.join(dirPath, entry);
    let stats = null;
    try {
      stats = await fs.stat(filePath);
    } catch (error) {
      continue;
    }
    let payload = null;
    try {
      payload = await fs.readJson(filePath);
    } catch (error) {
      continue;
    }
    if (!payload || payload.mode !== 'auto-handoff-run') {
      continue;
    }
    const ts = Date.parse(
      payload.completed_at
      || payload.generated_at
      || payload.created_at
      || null
    );
    reports.push({
      file: filePath,
      session_id: payload.session_id || path.basename(entry, '.json'),
      payload,
      sort_ts: Number.isFinite(ts) ? ts : (stats ? stats.mtimeMs : 0)
    });
  }

  reports.sort((left, right) => right.sort_ts - left.sort_ts);
  return reports;
}

async function resolveAutoHandoffRunReportFile(projectPath, sessionCandidate, optionName = '--continue-from') {
  if (typeof sessionCandidate !== 'string' || !sessionCandidate.trim()) {
    throw new Error(`${optionName} requires a session id/file or "latest".`);
  }
  const normalizedCandidate = sessionCandidate.trim();
  if (normalizedCandidate.toLowerCase() === 'latest') {
    const reports = await listAutoHandoffRunReports(projectPath);
    if (reports.length === 0) {
      throw new Error(`No handoff run reports found in: ${path.join(projectPath, AUTO_HANDOFF_RUN_REPORT_DIR)}`);
    }
    return reports[0].file;
  }

  if (path.isAbsolute(normalizedCandidate)) {
    return normalizedCandidate;
  }
  if (
    normalizedCandidate.includes('/') ||
    normalizedCandidate.includes('\\') ||
    normalizedCandidate.toLowerCase().endsWith('.json')
  ) {
    return path.join(projectPath, normalizedCandidate);
  }

  const reports = await listAutoHandoffRunReports(projectPath);
  const bySessionId = reports.find(item => item.session_id === normalizedCandidate);
  if (bySessionId) {
    return bySessionId.file;
  }

  const bySessionFile = path.join(
    projectPath,
    AUTO_HANDOFF_RUN_REPORT_DIR,
    `${sanitizeBatchSessionId(normalizedCandidate)}.json`
  );
  if (await fs.pathExists(bySessionFile)) {
    return bySessionFile;
  }
  return path.join(projectPath, normalizedCandidate);
}

async function loadAutoHandoffRunSessionPayload(projectPath, sessionCandidate, optionName = '--continue-from') {
  const reportFile = await resolveAutoHandoffRunReportFile(projectPath, sessionCandidate, optionName);
  if (!(await fs.pathExists(reportFile))) {
    throw new Error(`Handoff run report file not found: ${reportFile}`);
  }

  let payload = null;
  try {
    payload = await fs.readJson(reportFile);
  } catch (error) {
    throw new Error(`Invalid handoff run report JSON: ${reportFile} (${error.message})`);
  }
  if (!payload || typeof payload !== 'object' || payload.mode !== 'auto-handoff-run') {
    throw new Error(`Invalid handoff run report payload: ${reportFile}`);
  }

  return {
    id: typeof payload.session_id === 'string' && payload.session_id.trim()
      ? payload.session_id.trim()
      : path.basename(reportFile, '.json'),
    file: reportFile,
    payload
  };
}

async function buildAutoHandoffQueueFromContinueSource(projectPath, plan, options = {}) {
  const resumedSession = await loadAutoHandoffRunSessionPayload(projectPath, options.continueFrom, '--continue-from');
  const previousManifestPath = typeof (resumedSession.payload && resumedSession.payload.manifest_path) === 'string' &&
    resumedSession.payload.manifest_path.trim()
    ? resumedSession.payload.manifest_path.trim()
    : null;
  if (previousManifestPath) {
    const resolvedPreviousManifest = path.resolve(projectPath, previousManifestPath);
    const resolvedCurrentManifest = path.resolve(plan.manifest_path);
    if (path.normalize(resolvedPreviousManifest) !== path.normalize(resolvedCurrentManifest)) {
      throw new Error(
        `--continue-from manifest mismatch: previous=${resolvedPreviousManifest} current=${resolvedCurrentManifest}.`
      );
    }
  }

  const previousSummary = resumedSession.payload && resumedSession.payload.batch_summary;
  if (!previousSummary || typeof previousSummary !== 'object') {
    throw new Error(`--continue-from report is missing batch_summary: ${resumedSession.file}`);
  }
  const continueStrategy = resolveAutoHandoffContinueStrategy(options.continueStrategy, previousSummary);
  const resumedGoals = await buildCloseLoopBatchGoalsFromSummaryPayload(
    previousSummary,
    resumedSession.file,
    projectPath,
    'lines',
    continueStrategy.strategy
  );

  return {
    mode: 'auto-handoff-queue',
    generated_at: new Date().toISOString(),
    manifest_path: plan.manifest_path,
    dry_run: Boolean(options.dryRun),
    append: Boolean(options.append),
    include_known_gaps: options.includeKnownGaps !== false,
    goal_count: resumedGoals.goals.length,
    goals: resumedGoals.goals,
    validation: {
      errors: [],
      warnings: []
    },
    resume_context: {
      previous_batch_summary: previousSummary
    },
    resumed_from: {
      session_id: resumedSession.id,
      file: resumedSession.file,
      strategy: continueStrategy.strategy,
      strategy_requested: continueStrategy.strategy_requested,
      strategy_reason: continueStrategy.strategy_reason,
      previous_status: resumedSession.payload.status || null,
      previous_total_goals: Number.isInteger(
        Number(resumedGoals.resumedFromSummary && resumedGoals.resumedFromSummary.previous_total_goals)
      )
        ? Number(resumedGoals.resumedFromSummary.previous_total_goals)
        : null,
      previous_processed_goals: Number.isInteger(
        Number(resumedGoals.resumedFromSummary && resumedGoals.resumedFromSummary.previous_processed_goals)
      )
        ? Number(resumedGoals.resumedFromSummary.previous_processed_goals)
        : null
    }
  };
}

function normalizeRiskRank(levelCandidate) {
  const level = `${levelCandidate || 'high'}`.trim().toLowerCase();
  if (level === 'low') {
    return 1;
  }
  if (level === 'medium') {
    return 2;
  }
  return 3;
}

function buildAutoHandoffRegressionSnapshot(report) {
  const payload = report && report.payload ? report.payload : report;
  const specStatus = payload && payload.spec_status ? payload.spec_status : {};
  const gates = payload && payload.gates ? payload.gates : {};
  const gateActual = gates && gates.actual ? gates.actual : {};
  const batchSummary = payload && payload.batch_summary ? payload.batch_summary : {};
  const ontology = payload && payload.ontology_validation ? payload.ontology_validation : {};
  const ontologyMetrics = ontology && ontology.metrics ? ontology.metrics : {};
  const scenePackageBatch = payload && payload.scene_package_batch ? payload.scene_package_batch : {};
  const scenePackageBatchSummary = scenePackageBatch && scenePackageBatch.summary
    ? scenePackageBatch.summary
    : {};

  const riskLevel = gateActual.risk_level
    || (payload && payload.observability_snapshot && payload.observability_snapshot.highlights
      ? payload.observability_snapshot.highlights.governance_risk_level
      : 'high');
  const successRate = Number(specStatus.success_rate_percent);
  const failedGoals = Number(batchSummary.failed_goals);
  const elapsedMs = Number(payload && payload.elapsed_ms);
  const ontologyQualityScore = Number(
    gateActual.ontology_quality_score !== undefined
      ? gateActual.ontology_quality_score
      : ontology.quality_score
  );
  const ontologyUnmappedRules = Number(
    gateActual.ontology_business_rule_unmapped !== undefined
      ? gateActual.ontology_business_rule_unmapped
      : ontologyMetrics.business_rule_unmapped
  );
  const ontologyUndecidedDecisions = Number(
    gateActual.ontology_decision_undecided !== undefined
      ? gateActual.ontology_decision_undecided
      : ontologyMetrics.decision_undecided
  );
  const businessRulePassRate = Number(
    gateActual.ontology_business_rule_pass_rate_percent !== undefined
      ? gateActual.ontology_business_rule_pass_rate_percent
      : ontologyMetrics.business_rule_pass_rate_percent
  );
  const decisionResolvedRate = Number(
    gateActual.ontology_decision_resolved_rate_percent !== undefined
      ? gateActual.ontology_decision_resolved_rate_percent
      : ontologyMetrics.decision_resolved_rate_percent
  );
  const sceneBatchFailureCount = Number(
    scenePackageBatchSummary.batch_gate_failure_count !== undefined
      ? scenePackageBatchSummary.batch_gate_failure_count
      : scenePackageBatchSummary.failed
  );
  const sceneBatchStatus = normalizeHandoffText(
    scenePackageBatch.status !== undefined
      ? scenePackageBatch.status
      : gateActual.scene_package_batch_status
  );
  const moquiBaseline = payload && payload.moqui_baseline ? payload.moqui_baseline : {};
  const moquiCompare = moquiBaseline && moquiBaseline.compare ? moquiBaseline.compare : {};
  const moquiMatrixRegressionCount = Number(
    gateActual.moqui_matrix_regression_count !== undefined
      ? gateActual.moqui_matrix_regression_count
      : buildAutoHandoffMoquiCoverageRegressions(moquiCompare).length
  );
  let sceneBatchPassed = null;
  if (sceneBatchStatus && sceneBatchStatus !== 'skipped') {
    sceneBatchPassed = sceneBatchStatus === 'passed';
  }
  if (gateActual.scene_package_batch_passed === true) {
    sceneBatchPassed = true;
  } else if (gateActual.scene_package_batch_passed === false) {
    sceneBatchPassed = false;
  }

  return {
    session_id: payload && payload.session_id ? payload.session_id : null,
    status: payload && payload.status ? payload.status : null,
    spec_success_rate_percent: Number.isFinite(successRate) ? successRate : null,
    risk_level: `${riskLevel || 'high'}`.trim().toLowerCase(),
    risk_level_rank: normalizeRiskRank(riskLevel),
    failed_goals: Number.isFinite(failedGoals) ? failedGoals : null,
    elapsed_ms: Number.isFinite(elapsedMs) ? elapsedMs : null,
    ontology_quality_score: Number.isFinite(ontologyQualityScore) ? ontologyQualityScore : null,
    ontology_unmapped_rules: Number.isFinite(ontologyUnmappedRules) ? ontologyUnmappedRules : null,
    ontology_undecided_decisions: Number.isFinite(ontologyUndecidedDecisions) ? ontologyUndecidedDecisions : null,
    ontology_business_rule_pass_rate_percent: Number.isFinite(businessRulePassRate) ? businessRulePassRate : null,
    ontology_decision_resolved_rate_percent: Number.isFinite(decisionResolvedRate) ? decisionResolvedRate : null,
    moqui_matrix_regression_count: Number.isFinite(moquiMatrixRegressionCount) ? moquiMatrixRegressionCount : null,
    scene_package_batch_status: sceneBatchStatus || null,
    scene_package_batch_passed: typeof sceneBatchPassed === 'boolean' ? sceneBatchPassed : null,
    scene_package_batch_failure_count: Number.isFinite(sceneBatchFailureCount) ? sceneBatchFailureCount : null,
    generated_at: payload && payload.generated_at ? payload.generated_at : null
  };
}

function buildAutoHandoffRegressionComparison(currentSnapshot, previousSnapshot) {
  const deltaSuccess = (
    Number.isFinite(currentSnapshot.spec_success_rate_percent) &&
    Number.isFinite(previousSnapshot.spec_success_rate_percent)
  )
    ? Number((currentSnapshot.spec_success_rate_percent - previousSnapshot.spec_success_rate_percent).toFixed(2))
    : null;
  const deltaRiskRank = (
    Number.isFinite(currentSnapshot.risk_level_rank) &&
    Number.isFinite(previousSnapshot.risk_level_rank)
  )
    ? currentSnapshot.risk_level_rank - previousSnapshot.risk_level_rank
    : null;
  const deltaFailedGoals = (
    Number.isFinite(currentSnapshot.failed_goals) &&
    Number.isFinite(previousSnapshot.failed_goals)
  )
    ? currentSnapshot.failed_goals - previousSnapshot.failed_goals
    : null;
  const deltaElapsedMs = (
    Number.isFinite(currentSnapshot.elapsed_ms) &&
    Number.isFinite(previousSnapshot.elapsed_ms)
  )
    ? currentSnapshot.elapsed_ms - previousSnapshot.elapsed_ms
    : null;
  const deltaOntologyQualityScore = (
    Number.isFinite(currentSnapshot.ontology_quality_score) &&
    Number.isFinite(previousSnapshot.ontology_quality_score)
  )
    ? Number((currentSnapshot.ontology_quality_score - previousSnapshot.ontology_quality_score).toFixed(2))
    : null;
  const deltaOntologyUnmappedRules = (
    Number.isFinite(currentSnapshot.ontology_unmapped_rules) &&
    Number.isFinite(previousSnapshot.ontology_unmapped_rules)
  )
    ? currentSnapshot.ontology_unmapped_rules - previousSnapshot.ontology_unmapped_rules
    : null;
  const deltaOntologyUndecidedDecisions = (
    Number.isFinite(currentSnapshot.ontology_undecided_decisions) &&
    Number.isFinite(previousSnapshot.ontology_undecided_decisions)
  )
    ? currentSnapshot.ontology_undecided_decisions - previousSnapshot.ontology_undecided_decisions
    : null;
  const deltaBusinessRulePassRate = (
    Number.isFinite(currentSnapshot.ontology_business_rule_pass_rate_percent) &&
    Number.isFinite(previousSnapshot.ontology_business_rule_pass_rate_percent)
  )
    ? Number((
      currentSnapshot.ontology_business_rule_pass_rate_percent -
      previousSnapshot.ontology_business_rule_pass_rate_percent
    ).toFixed(2))
    : null;
  const deltaDecisionResolvedRate = (
    Number.isFinite(currentSnapshot.ontology_decision_resolved_rate_percent) &&
    Number.isFinite(previousSnapshot.ontology_decision_resolved_rate_percent)
  )
    ? Number((
      currentSnapshot.ontology_decision_resolved_rate_percent -
      previousSnapshot.ontology_decision_resolved_rate_percent
    ).toFixed(2))
    : null;
  const deltaSceneBatchFailureCount = (
    Number.isFinite(currentSnapshot.scene_package_batch_failure_count) &&
    Number.isFinite(previousSnapshot.scene_package_batch_failure_count)
  )
    ? currentSnapshot.scene_package_batch_failure_count - previousSnapshot.scene_package_batch_failure_count
    : null;
  const deltaMoquiMatrixRegressionCount = (
    Number.isFinite(currentSnapshot.moqui_matrix_regression_count) &&
    Number.isFinite(previousSnapshot.moqui_matrix_regression_count)
  )
    ? currentSnapshot.moqui_matrix_regression_count - previousSnapshot.moqui_matrix_regression_count
    : null;

  let trend = 'stable';
  if (
    (Number.isFinite(deltaSuccess) && deltaSuccess > 0) &&
    (deltaRiskRank === null || deltaRiskRank <= 0) &&
    (deltaFailedGoals === null || deltaFailedGoals <= 0) &&
    (deltaOntologyQualityScore === null || deltaOntologyQualityScore >= 0) &&
    (deltaOntologyUnmappedRules === null || deltaOntologyUnmappedRules <= 0) &&
    (deltaOntologyUndecidedDecisions === null || deltaOntologyUndecidedDecisions <= 0) &&
    (deltaSceneBatchFailureCount === null || deltaSceneBatchFailureCount <= 0)
  ) {
    trend = 'improved';
  } else if (
    (Number.isFinite(deltaSuccess) && deltaSuccess < 0) ||
    (deltaRiskRank !== null && deltaRiskRank > 0) ||
    (deltaFailedGoals !== null && deltaFailedGoals > 0) ||
    (deltaOntologyQualityScore !== null && deltaOntologyQualityScore < 0) ||
    (deltaOntologyUnmappedRules !== null && deltaOntologyUnmappedRules > 0) ||
    (deltaOntologyUndecidedDecisions !== null && deltaOntologyUndecidedDecisions > 0) ||
    (deltaSceneBatchFailureCount !== null && deltaSceneBatchFailureCount > 0) ||
    (deltaMoquiMatrixRegressionCount !== null && deltaMoquiMatrixRegressionCount > 0)
  ) {
    trend = 'degraded';
  }

  return {
    trend,
    delta: {
      spec_success_rate_percent: deltaSuccess,
      risk_level_rank: deltaRiskRank,
      failed_goals: deltaFailedGoals,
      elapsed_ms: deltaElapsedMs,
      ontology_quality_score: deltaOntologyQualityScore,
      ontology_unmapped_rules: deltaOntologyUnmappedRules,
      ontology_undecided_decisions: deltaOntologyUndecidedDecisions,
      ontology_business_rule_pass_rate_percent: deltaBusinessRulePassRate,
      ontology_decision_resolved_rate_percent: deltaDecisionResolvedRate,
      moqui_matrix_regression_count: deltaMoquiMatrixRegressionCount,
      scene_package_batch_failure_count: deltaSceneBatchFailureCount
    }
  };
}

function buildAutoHandoffRegressionWindowTrend(series = []) {
  const normalized = Array.isArray(series) ? series.filter(Boolean) : [];
  if (normalized.length < 2) {
    return {
      trend: 'baseline',
      delta: {
        spec_success_rate_percent: null,
        risk_level_rank: null,
        failed_goals: null,
        elapsed_ms: null,
        ontology_quality_score: null,
        ontology_unmapped_rules: null,
        ontology_undecided_decisions: null,
        ontology_business_rule_pass_rate_percent: null,
        ontology_decision_resolved_rate_percent: null,
        moqui_matrix_regression_count: null,
        scene_package_batch_failure_count: null
      },
      has_baseline: false
    };
  }
  const latest = normalized[0];
  const oldest = normalized[normalized.length - 1];
  const comparison = buildAutoHandoffRegressionComparison(latest, oldest);
  return {
    trend: comparison.trend,
    delta: comparison.delta,
    has_baseline: true
  };
}

function buildAutoHandoffRegressionAggregates(series = []) {
  const snapshots = Array.isArray(series) ? series.filter(Boolean) : [];
  const successRates = snapshots
    .map(item => Number(item.spec_success_rate_percent))
    .filter(value => Number.isFinite(value));
  const failedGoals = snapshots
    .map(item => Number(item.failed_goals))
    .filter(value => Number.isFinite(value));
  const ontologyScores = snapshots
    .map(item => Number(item.ontology_quality_score))
    .filter(value => Number.isFinite(value));
  const ontologyUnmappedRules = snapshots
    .map(item => Number(item.ontology_unmapped_rules))
    .filter(value => Number.isFinite(value));
  const ontologyUndecidedDecisions = snapshots
    .map(item => Number(item.ontology_undecided_decisions))
    .filter(value => Number.isFinite(value));
  const rulePassRates = snapshots
    .map(item => Number(item.ontology_business_rule_pass_rate_percent))
    .filter(value => Number.isFinite(value));
  const decisionResolvedRates = snapshots
    .map(item => Number(item.ontology_decision_resolved_rate_percent))
    .filter(value => Number.isFinite(value));
  const sceneBatchFailures = snapshots
    .map(item => Number(item.scene_package_batch_failure_count))
    .filter(value => Number.isFinite(value));
  const moquiMatrixRegressions = snapshots
    .map(item => Number(item.moqui_matrix_regression_count))
    .filter(value => Number.isFinite(value));
  const sceneBatchApplicables = snapshots.filter(item => typeof item.scene_package_batch_passed === 'boolean');
  const sceneBatchPassedCount = sceneBatchApplicables.filter(item => item.scene_package_batch_passed === true).length;
  const sceneBatchFailedCount = sceneBatchApplicables.filter(item => item.scene_package_batch_passed === false).length;
  const riskLevels = {
    low: 0,
    medium: 0,
    high: 0,
    unknown: 0
  };
  snapshots.forEach(item => {
    const risk = `${item && item.risk_level ? item.risk_level : 'unknown'}`.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(riskLevels, risk)) {
      riskLevels[risk] += 1;
    } else {
      riskLevels.unknown += 1;
    }
  });

  const averageSuccessRate = successRates.length > 0
    ? Number((successRates.reduce((sum, value) => sum + value, 0) / successRates.length).toFixed(2))
    : null;
  const averageFailedGoals = failedGoals.length > 0
    ? Number((failedGoals.reduce((sum, value) => sum + value, 0) / failedGoals.length).toFixed(2))
    : null;
  const averageOntologyScore = ontologyScores.length > 0
    ? Number((ontologyScores.reduce((sum, value) => sum + value, 0) / ontologyScores.length).toFixed(2))
    : null;
  const averageOntologyUnmappedRules = ontologyUnmappedRules.length > 0
    ? Number((ontologyUnmappedRules.reduce((sum, value) => sum + value, 0) / ontologyUnmappedRules.length).toFixed(2))
    : null;
  const averageOntologyUndecidedDecisions = ontologyUndecidedDecisions.length > 0
    ? Number((ontologyUndecidedDecisions.reduce((sum, value) => sum + value, 0) / ontologyUndecidedDecisions.length).toFixed(2))
    : null;
  const averageRulePassRate = rulePassRates.length > 0
    ? Number((rulePassRates.reduce((sum, value) => sum + value, 0) / rulePassRates.length).toFixed(2))
    : null;
  const averageDecisionResolvedRate = decisionResolvedRates.length > 0
    ? Number((decisionResolvedRates.reduce((sum, value) => sum + value, 0) / decisionResolvedRates.length).toFixed(2))
    : null;
  const averageSceneBatchFailures = sceneBatchFailures.length > 0
    ? Number((sceneBatchFailures.reduce((sum, value) => sum + value, 0) / sceneBatchFailures.length).toFixed(2))
    : null;
  const averageMoquiMatrixRegressions = moquiMatrixRegressions.length > 0
    ? Number((moquiMatrixRegressions.reduce((sum, value) => sum + value, 0) / moquiMatrixRegressions.length).toFixed(2))
    : null;
  const sceneBatchPassRate = sceneBatchApplicables.length > 0
    ? Number(((sceneBatchPassedCount / sceneBatchApplicables.length) * 100).toFixed(2))
    : null;

  return {
    avg_spec_success_rate_percent: averageSuccessRate,
    min_spec_success_rate_percent: successRates.length > 0 ? Math.min(...successRates) : null,
    max_spec_success_rate_percent: successRates.length > 0 ? Math.max(...successRates) : null,
    avg_failed_goals: averageFailedGoals,
    avg_ontology_quality_score: averageOntologyScore,
    min_ontology_quality_score: ontologyScores.length > 0 ? Math.min(...ontologyScores) : null,
    max_ontology_quality_score: ontologyScores.length > 0 ? Math.max(...ontologyScores) : null,
    avg_ontology_unmapped_rules: averageOntologyUnmappedRules,
    max_ontology_unmapped_rules: ontologyUnmappedRules.length > 0 ? Math.max(...ontologyUnmappedRules) : null,
    avg_ontology_undecided_decisions: averageOntologyUndecidedDecisions,
    max_ontology_undecided_decisions: ontologyUndecidedDecisions.length > 0 ? Math.max(...ontologyUndecidedDecisions) : null,
    avg_ontology_business_rule_pass_rate_percent: averageRulePassRate,
    avg_ontology_decision_resolved_rate_percent: averageDecisionResolvedRate,
    scene_package_batch_applicable_count: sceneBatchApplicables.length,
    scene_package_batch_passed_count: sceneBatchPassedCount,
    scene_package_batch_failed_count: sceneBatchFailedCount,
    scene_package_batch_pass_rate_percent: sceneBatchPassRate,
    avg_scene_package_batch_failure_count: averageSceneBatchFailures,
    max_scene_package_batch_failure_count: sceneBatchFailures.length > 0 ? Math.max(...sceneBatchFailures) : null,
    avg_moqui_matrix_regression_count: averageMoquiMatrixRegressions,
    max_moqui_matrix_regression_count: moquiMatrixRegressions.length > 0 ? Math.max(...moquiMatrixRegressions) : null,
    risk_levels: riskLevels
  };
}

function buildAutoHandoffRegressionRiskLayers(series = []) {
  const snapshots = Array.isArray(series) ? series.filter(Boolean) : [];
  const levels = ['low', 'medium', 'high', 'unknown'];
  const result = {};

  levels.forEach(level => {
    const scoped = snapshots.filter(item => {
      const risk = `${item && item.risk_level ? item.risk_level : 'unknown'}`.trim().toLowerCase();
      return risk === level;
    });
    const successRates = scoped
      .map(item => Number(item.spec_success_rate_percent))
      .filter(value => Number.isFinite(value));
    const failedGoals = scoped
      .map(item => Number(item.failed_goals))
      .filter(value => Number.isFinite(value));
    const ontologyScores = scoped
      .map(item => Number(item.ontology_quality_score))
      .filter(value => Number.isFinite(value));
    const sceneBatchFailures = scoped
      .map(item => Number(item.scene_package_batch_failure_count))
      .filter(value => Number.isFinite(value));
    const moquiMatrixRegressions = scoped
      .map(item => Number(item.moqui_matrix_regression_count))
      .filter(value => Number.isFinite(value));
    const sceneBatchApplicable = scoped.filter(item => typeof item.scene_package_batch_passed === 'boolean');
    const sceneBatchPassed = sceneBatchApplicable.filter(item => item.scene_package_batch_passed === true).length;

    const avg = values => (
      values.length > 0
        ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
        : null
    );

    result[level] = {
      count: scoped.length,
      sessions: scoped.map(item => item.session_id).filter(Boolean),
      avg_spec_success_rate_percent: avg(successRates),
      max_spec_success_rate_percent: successRates.length > 0 ? Math.max(...successRates) : null,
      min_spec_success_rate_percent: successRates.length > 0 ? Math.min(...successRates) : null,
      avg_failed_goals: avg(failedGoals),
      avg_ontology_quality_score: avg(ontologyScores),
      avg_scene_package_batch_failure_count: avg(sceneBatchFailures),
      avg_moqui_matrix_regression_count: avg(moquiMatrixRegressions),
      max_moqui_matrix_regression_count: moquiMatrixRegressions.length > 0 ? Math.max(...moquiMatrixRegressions) : null,
      scene_package_batch_pass_rate_percent: sceneBatchApplicable.length > 0
        ? Number(((sceneBatchPassed / sceneBatchApplicable.length) * 100).toFixed(2))
        : null
    };
  });

  return result;
}

function buildAutoHandoffRegressionRecommendations(payload = {}) {
  const recommendations = [];
  const seen = new Set();
  const push = value => {
    const text = `${value || ''}`.trim();
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    recommendations.push(text);
  };

  const current = payload.current || {};
  const trend = `${payload.trend || 'stable'}`.trim().toLowerCase();
  const windowTrend = payload.window_trend && payload.window_trend.trend
    ? `${payload.window_trend.trend}`.trim().toLowerCase()
    : trend;
  const currentFailed = Number(current.failed_goals);
  const currentRisk = `${current.risk_level || 'unknown'}`.trim().toLowerCase();
  const ontologyQuality = Number(current.ontology_quality_score);
  const ontologyUnmappedRules = Number(current.ontology_unmapped_rules);
  const ontologyUndecidedDecisions = Number(current.ontology_undecided_decisions);
  const sceneBatchFailureCount = Number(current.scene_package_batch_failure_count);
  const moquiMatrixRegressionCount = Number(current.moqui_matrix_regression_count);
  const sceneBatchPassed = current.scene_package_batch_passed;

  if (trend === 'degraded' || windowTrend === 'degraded') {
    push(
      `sce auto handoff run --manifest <path> --continue-from ${quoteCliArg(current.session_id || 'latest')} ` +
      '--continue-strategy pending --json'
    );
  } else if (Number.isFinite(currentFailed) && currentFailed > 0) {
    push(
      `sce auto handoff run --manifest <path> --continue-from ${quoteCliArg(current.session_id || 'latest')} ` +
      '--continue-strategy failed-only --json'
    );
  }

  if (currentRisk === 'high') {
    push('sce auto governance stats --days 14 --json');
  }

  if (Number.isFinite(ontologyQuality) && ontologyQuality < 80) {
    push('Strengthen ontology quality gate before next run: `--min-ontology-score 80`.');
  }
  if (Number.isFinite(ontologyUnmappedRules) && ontologyUnmappedRules > 0) {
    push('Drive business-rule closure to zero unmapped rules (`--max-unmapped-rules 0`).');
  }
  if (Number.isFinite(ontologyUndecidedDecisions) && ontologyUndecidedDecisions > 0) {
    push('Resolve pending decision logic entries (`--max-undecided-decisions 0`).');
  }
  if (sceneBatchPassed === false || (Number.isFinite(sceneBatchFailureCount) && sceneBatchFailureCount > 0)) {
    push(
      'Resolve scene package publish-batch gate failures and rerun: ' +
      '`sce scene package-publish-batch --manifest docs/handoffs/handoff-manifest.json --dry-run --json`.'
    );
  }
  if (Number.isFinite(moquiMatrixRegressionCount) && moquiMatrixRegressionCount > 0) {
    push(
      'Recover Moqui matrix regressions and rerun baseline gate: ' +
      '`sce scene moqui-baseline --include-all --compare-with .sce/reports/release-evidence/moqui-template-baseline.json --json`.'
    );
    for (const line of buildMoquiRegressionRecoverySequenceLines({
      wrapCommands: true,
      withPeriod: true
    })) {
      push(line);
    }
  }

  if ((payload.window && Number(payload.window.actual) > 0) && (payload.window.requested !== payload.window.actual)) {
    push('Increase regression coverage with `sce auto handoff regression --window 10 --json`.');
  }

  return recommendations;
}

function formatAutoHandoffRegressionValue(value, fallback = 'n/a') {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return fallback;
  }
  return `${value}`;
}

function getAutoHandoffMoquiCoverageMatrix(summary = {}) {
  if (!summary || typeof summary !== 'object') {
    return {};
  }
  return summary.coverage_matrix && typeof summary.coverage_matrix === 'object'
    ? summary.coverage_matrix
    : {};
}

function getAutoHandoffMoquiCoverageMetric(summary = {}, metricName = '', field = 'rate_percent') {
  const matrix = getAutoHandoffMoquiCoverageMatrix(summary);
  const metric = matrix && matrix[metricName] && typeof matrix[metricName] === 'object'
    ? matrix[metricName]
    : {};
  const value = Number(metric[field]);
  return Number.isFinite(value) ? value : null;
}

function formatAutoHandoffMoquiCoverageMetric(summary = {}, metricName = '', field = 'rate_percent', suffix = '') {
  const value = getAutoHandoffMoquiCoverageMetric(summary, metricName, field);
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return `${value}${suffix}`;
}

function getAutoHandoffMoquiCoverageDeltaMatrix(compare = {}) {
  if (!compare || typeof compare !== 'object') {
    return {};
  }
  return compare.coverage_matrix_deltas && typeof compare.coverage_matrix_deltas === 'object'
    ? compare.coverage_matrix_deltas
    : {};
}

function getAutoHandoffMoquiCoverageDeltaMetric(compare = {}, metricName = '', field = 'rate_percent') {
  const matrix = getAutoHandoffMoquiCoverageDeltaMatrix(compare);
  const metric = matrix && matrix[metricName] && typeof matrix[metricName] === 'object'
    ? matrix[metricName]
    : {};
  const value = Number(metric[field]);
  return Number.isFinite(value) ? value : null;
}

function formatAutoHandoffMoquiCoverageDeltaMetric(compare = {}, metricName = '', field = 'rate_percent', suffix = '') {
  const value = getAutoHandoffMoquiCoverageDeltaMetric(compare, metricName, field);
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return `${value}${suffix}`;
}

function getAutoHandoffMoquiCoverageMetricLabel(metricName = '') {
  const labels = {
    graph_valid: 'graph-valid',
    score_passed: 'score-passed',
    entity_coverage: 'entity-coverage',
    relation_coverage: 'relation-coverage',
    business_rule_coverage: 'business-rule-coverage',
    business_rule_closed: 'business-rule-closed',
    decision_coverage: 'decision-coverage',
    decision_closed: 'decision-closed',
    baseline_passed: 'baseline-passed'
  };
  return labels[metricName] || metricName;
}

function buildAutoHandoffMoquiCoverageRegressions(compare = {}) {
  const source = compare && typeof compare === 'object' ? compare : {};
  const predefined = Array.isArray(source.coverage_matrix_regressions)
    ? source.coverage_matrix_regressions
    : null;
  if (predefined) {
    const normalized = predefined
      .map(item => {
        const metric = normalizeHandoffText(item && item.metric);
        const deltaRate = Number(item && item.delta_rate_percent);
        if (!metric || !Number.isFinite(deltaRate) || deltaRate >= 0) {
          return null;
        }
        return {
          metric,
          label: normalizeHandoffText(item && item.label) || getAutoHandoffMoquiCoverageMetricLabel(metric),
          delta_rate_percent: Number(deltaRate.toFixed(2))
        };
      })
      .filter(Boolean);
    if (normalized.length > 0) {
      return normalized.sort((a, b) => {
        if (a.delta_rate_percent !== b.delta_rate_percent) {
          return a.delta_rate_percent - b.delta_rate_percent;
        }
        return `${a.metric}`.localeCompare(`${b.metric}`);
      });
    }
  }

  const deltaMatrix = getAutoHandoffMoquiCoverageDeltaMatrix(source);
  return Object.entries(deltaMatrix)
    .map(([metric, value]) => {
      const deltaRate = Number(value && value.rate_percent);
      if (!Number.isFinite(deltaRate) || deltaRate >= 0) {
        return null;
      }
      return {
        metric,
        label: getAutoHandoffMoquiCoverageMetricLabel(metric),
        delta_rate_percent: Number(deltaRate.toFixed(2))
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.delta_rate_percent !== b.delta_rate_percent) {
        return a.delta_rate_percent - b.delta_rate_percent;
      }
      return `${a.metric}`.localeCompare(`${b.metric}`);
    });
}

function formatAutoHandoffMoquiCoverageRegressions(compare = {}, limit = 3) {
  const regressions = buildAutoHandoffMoquiCoverageRegressions(compare);
  if (regressions.length === 0) {
    return 'none';
  }
  const maxItems = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : regressions.length;
  return regressions
    .slice(0, maxItems)
    .map(item => `${item.label}:${item.delta_rate_percent}%`)
    .join(' | ');
}

function renderAutoHandoffRegressionAsciiBar(value, max = 100, width = 20) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return `${'.'.repeat(width)} n/a`;
  }
  const bounded = Math.max(0, Math.min(max, parsed));
  const ratio = max > 0 ? bounded / max : 0;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return `${'#'.repeat(filled)}${'.'.repeat(Math.max(0, width - filled))} ${Number(bounded.toFixed(2))}`;
}

function renderAutoHandoffRegressionMarkdown(payload = {}) {
  const current = payload.current || {};
  const previous = payload.previous || null;
  const window = payload.window || { requested: 2, actual: 0 };
  const delta = payload.delta || {};
  const windowTrend = payload.window_trend || { trend: 'baseline', delta: {} };
  const aggregates = payload.aggregates || {};
  const riskLevels = aggregates.risk_levels || {};
  const recommendations = Array.isArray(payload.recommendations) ? payload.recommendations : [];
  const series = Array.isArray(payload.series) ? payload.series : [];
  const riskLayers = payload.risk_layers && typeof payload.risk_layers === 'object'
    ? payload.risk_layers
    : {};
  const trendSeriesLines = series.length > 0
    ? series.map(item => {
      const sessionId = formatAutoHandoffRegressionValue(item.session_id);
      const generatedAt = formatAutoHandoffRegressionValue(item.generated_at);
      const riskLevel = formatAutoHandoffRegressionValue(item.risk_level);
      const failedGoals = formatAutoHandoffRegressionValue(item.failed_goals);
      const sceneBatch = item.scene_package_batch_passed === null || item.scene_package_batch_passed === undefined
        ? 'n/a'
        : (item.scene_package_batch_passed ? 'pass' : 'fail');
      const successBar = renderAutoHandoffRegressionAsciiBar(item.spec_success_rate_percent, 100, 20);
      const ontologyBar = renderAutoHandoffRegressionAsciiBar(item.ontology_quality_score, 100, 20);
      return `- ${sessionId} | ${generatedAt} | risk=${riskLevel} | failed=${failedGoals} | scene-batch=${sceneBatch} | success=${successBar} | ontology=${ontologyBar}`;
    })
    : ['- None'];
  const riskLayerLines = ['low', 'medium', 'high', 'unknown'].map(level => {
    const scoped = riskLayers[level] && typeof riskLayers[level] === 'object'
      ? riskLayers[level]
      : {};
    return (
      `- ${level}: count=${formatAutoHandoffRegressionValue(scoped.count, '0')}, ` +
      `avg_success=${formatAutoHandoffRegressionValue(scoped.avg_spec_success_rate_percent)}, ` +
      `avg_failed_goals=${formatAutoHandoffRegressionValue(scoped.avg_failed_goals)}, ` +
      `avg_ontology_quality=${formatAutoHandoffRegressionValue(scoped.avg_ontology_quality_score)}, ` +
      `scene_batch_pass_rate=${formatAutoHandoffRegressionValue(scoped.scene_package_batch_pass_rate_percent)}%, ` +
      `avg_moqui_matrix_regressions=${formatAutoHandoffRegressionValue(scoped.avg_moqui_matrix_regression_count, '0')}`
    );
  });

  const lines = [
    '# Auto Handoff Regression Report',
    '',
    `- Session: ${formatAutoHandoffRegressionValue(current.session_id)}`,
    `- Compared to: ${previous ? formatAutoHandoffRegressionValue(previous.session_id) : 'none'}`,
    `- Trend: ${formatAutoHandoffRegressionValue(payload.trend)}`,
    `- Window: ${formatAutoHandoffRegressionValue(window.actual)}/${formatAutoHandoffRegressionValue(window.requested)}`,
    '',
    '## Point Delta',
    '',
    `- Spec success rate delta: ${formatAutoHandoffRegressionValue(delta.spec_success_rate_percent)}`,
    `- Risk level rank delta: ${formatAutoHandoffRegressionValue(delta.risk_level_rank)}`,
    `- Failed goals delta: ${formatAutoHandoffRegressionValue(delta.failed_goals)}`,
    `- Elapsed ms delta: ${formatAutoHandoffRegressionValue(delta.elapsed_ms)}`,
    `- Ontology quality delta: ${formatAutoHandoffRegressionValue(delta.ontology_quality_score)}`,
    `- Ontology unmapped rules delta: ${formatAutoHandoffRegressionValue(delta.ontology_unmapped_rules)}`,
    `- Ontology undecided decisions delta: ${formatAutoHandoffRegressionValue(delta.ontology_undecided_decisions)}`,
    `- Moqui matrix regression count delta: ${formatAutoHandoffRegressionValue(delta.moqui_matrix_regression_count)}`,
    `- Scene package batch failure count delta: ${formatAutoHandoffRegressionValue(delta.scene_package_batch_failure_count)}`,
    '',
    '## Window Trend',
    '',
    `- Trend: ${formatAutoHandoffRegressionValue(windowTrend.trend)}`,
    `- Success rate delta: ${formatAutoHandoffRegressionValue(windowTrend.delta && windowTrend.delta.spec_success_rate_percent)}`,
    `- Risk level rank delta: ${formatAutoHandoffRegressionValue(windowTrend.delta && windowTrend.delta.risk_level_rank)}`,
    `- Failed goals delta: ${formatAutoHandoffRegressionValue(windowTrend.delta && windowTrend.delta.failed_goals)}`,
    `- Moqui matrix regression count delta: ${formatAutoHandoffRegressionValue(windowTrend.delta && windowTrend.delta.moqui_matrix_regression_count)}`,
    '',
    '## Aggregates',
    '',
    `- Avg spec success rate: ${formatAutoHandoffRegressionValue(aggregates.avg_spec_success_rate_percent)}`,
    `- Min spec success rate: ${formatAutoHandoffRegressionValue(aggregates.min_spec_success_rate_percent)}`,
    `- Max spec success rate: ${formatAutoHandoffRegressionValue(aggregates.max_spec_success_rate_percent)}`,
    `- Avg failed goals: ${formatAutoHandoffRegressionValue(aggregates.avg_failed_goals)}`,
    `- Avg ontology quality score: ${formatAutoHandoffRegressionValue(aggregates.avg_ontology_quality_score)}`,
    `- Min ontology quality score: ${formatAutoHandoffRegressionValue(aggregates.min_ontology_quality_score)}`,
    `- Max ontology quality score: ${formatAutoHandoffRegressionValue(aggregates.max_ontology_quality_score)}`,
    `- Avg ontology unmapped rules: ${formatAutoHandoffRegressionValue(aggregates.avg_ontology_unmapped_rules)}`,
    `- Max ontology unmapped rules: ${formatAutoHandoffRegressionValue(aggregates.max_ontology_unmapped_rules)}`,
    `- Avg ontology undecided decisions: ${formatAutoHandoffRegressionValue(aggregates.avg_ontology_undecided_decisions)}`,
    `- Max ontology undecided decisions: ${formatAutoHandoffRegressionValue(aggregates.max_ontology_undecided_decisions)}`,
    `- Avg business rule pass rate: ${formatAutoHandoffRegressionValue(aggregates.avg_ontology_business_rule_pass_rate_percent)}`,
    `- Avg decision resolved rate: ${formatAutoHandoffRegressionValue(aggregates.avg_ontology_decision_resolved_rate_percent)}`,
    `- Scene package batch pass rate: ${formatAutoHandoffRegressionValue(aggregates.scene_package_batch_pass_rate_percent)}%`,
    `- Scene package batch failed sessions: ${formatAutoHandoffRegressionValue(aggregates.scene_package_batch_failed_count, '0')}`,
    `- Avg scene package batch failure count: ${formatAutoHandoffRegressionValue(aggregates.avg_scene_package_batch_failure_count)}`,
    `- Avg Moqui matrix regression count: ${formatAutoHandoffRegressionValue(aggregates.avg_moqui_matrix_regression_count)}`,
    `- Max Moqui matrix regression count: ${formatAutoHandoffRegressionValue(aggregates.max_moqui_matrix_regression_count)}`,
    `- Risk levels: low=${formatAutoHandoffRegressionValue(riskLevels.low, '0')}, medium=${formatAutoHandoffRegressionValue(riskLevels.medium, '0')}, high=${formatAutoHandoffRegressionValue(riskLevels.high, '0')}, unknown=${formatAutoHandoffRegressionValue(riskLevels.unknown, '0')}`,
    '',
    '## Trend Series',
    '',
    ...trendSeriesLines,
    '',
    '## Risk Layer View',
    '',
    ...riskLayerLines,
    '',
    '## Recommendations'
  ];

  if (recommendations.length === 0) {
    lines.push('', '- None');
  } else {
    recommendations.forEach(item => {
      lines.push('', `- ${item}`);
    });
  }

  return `${lines.join('\n')}\n`;
}

function resolveAutoHandoffReleaseEvidenceFile(projectPath, fileCandidate) {
  const candidate = typeof fileCandidate === 'string' && fileCandidate.trim()
    ? fileCandidate.trim()
    : AUTO_HANDOFF_RELEASE_EVIDENCE_FILE;
  return path.isAbsolute(candidate)
    ? candidate
    : path.join(projectPath, candidate);
}

function resolveAutoHandoffReleaseEvidenceDir(projectPath, dirCandidate = null) {
  const candidate = typeof dirCandidate === 'string' && dirCandidate.trim()
    ? dirCandidate.trim()
    : AUTO_HANDOFF_RELEASE_EVIDENCE_DIR;
  return path.isAbsolute(candidate)
    ? candidate
    : path.join(projectPath, candidate);
}

function resolveAutoHandoffReleaseGateHistoryFile(projectPath, fileCandidate = null) {
  const candidate = typeof fileCandidate === 'string' && fileCandidate.trim()
    ? fileCandidate.trim()
    : AUTO_HANDOFF_RELEASE_GATE_HISTORY_FILE;
  return path.isAbsolute(candidate)
    ? candidate
    : path.join(projectPath, candidate);
}

function parseAutoHandoffReleaseGateTag(filenameCandidate) {
  const filename = typeof filenameCandidate === 'string'
    ? filenameCandidate.trim()
    : '';
  if (!filename) {
    return null;
  }
  const match = /^release-gate-(.+)\.json$/i.exec(filename);
  if (!match || !match[1]) {
    return null;
  }
  const tag = `${match[1]}`.trim();
  if (!tag || /^history(?:-|$)/i.test(tag)) {
    return null;
  }
  return tag;
}

function parseAutoHandoffGateNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAutoHandoffGateSignalsMap(signals = []) {
  const map = {};
  if (!Array.isArray(signals)) {
    return map;
  }
  signals.forEach(item => {
    if (typeof item !== 'string') {
      return;
    }
    const trimmed = item.trim();
    if (!trimmed) {
      return;
    }
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      return;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!key) {
      return;
    }
    map[key] = value;
  });
  return map;
}

function toAutoHandoffTimestamp(valueCandidate) {
  const value = normalizeHandoffText(valueCandidate);
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildAutoHandoffReleaseGateHistoryEntry(entry = {}, options = {}) {
  const projectPath = options.projectPath || process.cwd();
  const sourceFile = typeof options.file === 'string' && options.file.trim()
    ? options.file.trim()
    : null;
  const signalMap = parseAutoHandoffGateSignalsMap(entry.signals);
  const derivedTag = normalizeHandoffText(options.tag)
    || (sourceFile ? parseAutoHandoffReleaseGateTag(path.basename(sourceFile)) : null)
    || normalizeHandoffText(entry.tag);
  const gatePassed = parseAutoHandoffGateBoolean(
    entry.gate_passed !== undefined ? entry.gate_passed : signalMap.gate_passed,
    null
  );
  const riskLevel = normalizeAutoHandoffGateRiskLevel(
    normalizeHandoffText(entry.risk_level) || signalMap.risk_level
  );
  const specSuccessRate = parseAutoHandoffGateNumber(
    entry.spec_success_rate_percent !== undefined
      ? entry.spec_success_rate_percent
      : signalMap.spec_success_rate
  );
  const sceneBatchStatus = normalizeHandoffText(
    entry.scene_package_batch_status !== undefined
      ? entry.scene_package_batch_status
      : signalMap.scene_package_batch_status
  );
  let sceneBatchPassed = parseAutoHandoffGateBoolean(
    entry.scene_package_batch_passed !== undefined
      ? entry.scene_package_batch_passed
      : signalMap.scene_package_batch_passed,
    null
  );
  if (sceneBatchPassed === null && sceneBatchStatus && sceneBatchStatus !== 'skipped') {
    sceneBatchPassed = sceneBatchStatus === 'passed';
  }
  const sceneBatchFailureCount = parseAutoHandoffGateNumber(
    entry.scene_package_batch_failure_count !== undefined
      ? entry.scene_package_batch_failure_count
      : signalMap.scene_package_batch_failure_count
  );
  const capabilityExpectedUnknownCount = parseAutoHandoffGateNumber(
    entry.capability_expected_unknown_count !== undefined
      ? entry.capability_expected_unknown_count
      : (
        signalMap.capability_expected_unknown_count !== undefined
          ? signalMap.capability_expected_unknown_count
          : signalMap.capability_lexicon_expected_unknown_count
      )
  );
  const capabilityProvidedUnknownCount = parseAutoHandoffGateNumber(
    entry.capability_provided_unknown_count !== undefined
      ? entry.capability_provided_unknown_count
      : (
        signalMap.capability_provided_unknown_count !== undefined
          ? signalMap.capability_provided_unknown_count
          : signalMap.capability_lexicon_provided_unknown_count
      )
  );
  const releaseGatePreflightAvailable = parseAutoHandoffGateBoolean(
    entry.release_gate_preflight_available !== undefined
      ? entry.release_gate_preflight_available
      : signalMap.release_gate_preflight_available,
    null
  );
  const releaseGatePreflightBlocked = parseAutoHandoffGateBoolean(
    entry.release_gate_preflight_blocked !== undefined
      ? entry.release_gate_preflight_blocked
      : signalMap.release_gate_preflight_blocked,
    null
  );
  const requireReleaseGatePreflight = parseAutoHandoffGateBoolean(
    entry.require_release_gate_preflight !== undefined
      ? entry.require_release_gate_preflight
      : (
        signalMap.require_release_gate_preflight !== undefined
          ? signalMap.require_release_gate_preflight
          : signalMap.release_gate_preflight_hard_gate
      ),
    null
  );
  const drift = entry && typeof entry.drift === 'object' && !Array.isArray(entry.drift)
    ? entry.drift
    : {};
  const driftAlerts = Array.isArray(drift.alerts)
    ? drift.alerts
      .map(item => `${item || ''}`.trim())
      .filter(Boolean)
    : [];
  const hasDriftAlertSource = (
    entry.drift_alert_count !== undefined
    || drift.alert_count !== undefined
    || Array.isArray(drift.alerts)
  );
  const driftAlertCount = hasDriftAlertSource
    ? parseAutoHandoffGateNumber(
      entry.drift_alert_count !== undefined
        ? entry.drift_alert_count
        : (drift.alert_count !== undefined ? drift.alert_count : driftAlerts.length)
    )
    : null;
  const driftBlocked = parseAutoHandoffGateBoolean(
    entry.drift_blocked !== undefined
      ? entry.drift_blocked
      : drift.blocked,
    null
  );
  const driftEnforce = parseAutoHandoffGateBoolean(
    entry.drift_enforce !== undefined
      ? entry.drift_enforce
      : drift.enforce,
    null
  );
  const driftEvaluatedAt = normalizeHandoffText(
    entry.drift_evaluated_at !== undefined
      ? entry.drift_evaluated_at
      : drift.evaluated_at
  );
  const weeklyOps = entry && typeof entry.weekly_ops === 'object' && !Array.isArray(entry.weekly_ops)
    ? entry.weekly_ops
    : {};
  const weeklyOpsSignals = weeklyOps && typeof weeklyOps.signals === 'object' && !Array.isArray(weeklyOps.signals)
    ? weeklyOps.signals
    : {};
  const weeklyOpsViolations = Array.isArray(weeklyOps.violations)
    ? weeklyOps.violations.map(item => `${item}`)
    : [];
  const weeklyOpsWarnings = Array.isArray(weeklyOps.warnings)
    ? weeklyOps.warnings.map(item => `${item}`)
    : [];
  const weeklyOpsConfigWarnings = Array.isArray(weeklyOps.config_warnings)
    ? weeklyOps.config_warnings.map(item => `${item}`)
    : [];
  const weeklyOpsAvailable = parseAutoHandoffGateBoolean(entry.weekly_ops_available, null) === true
    || Object.keys(weeklyOps).length > 0;
  const weeklyOpsBlocked = parseAutoHandoffGateBoolean(
    entry.weekly_ops_blocked !== undefined
      ? entry.weekly_ops_blocked
      : weeklyOps.blocked,
    null
  );
  const weeklyOpsRiskRaw = normalizeHandoffText(
    entry.weekly_ops_risk_level !== undefined
      ? entry.weekly_ops_risk_level
      : weeklyOpsSignals.risk
  );
  const weeklyOpsRiskLevel = weeklyOpsRiskRaw
    ? normalizeAutoHandoffGateRiskLevel(weeklyOpsRiskRaw)
    : null;
  const weeklyOpsGovernanceStatus = normalizeHandoffText(
    entry.weekly_ops_governance_status !== undefined
      ? entry.weekly_ops_governance_status
      : weeklyOpsSignals.governance_status
  ) || null;
  const weeklyOpsAuthorizationTierBlockRatePercentCandidate = (
    entry.weekly_ops_authorization_tier_block_rate_percent !== undefined
      ? entry.weekly_ops_authorization_tier_block_rate_percent
      : weeklyOpsSignals.authorization_tier_block_rate_percent
  );
  const weeklyOpsDialogueAuthorizationBlockRatePercentCandidate = (
    entry.weekly_ops_dialogue_authorization_block_rate_percent !== undefined
      ? entry.weekly_ops_dialogue_authorization_block_rate_percent
      : weeklyOpsSignals.dialogue_authorization_block_rate_percent
  );
  const weeklyOpsMatrixRegressionPositiveRatePercentCandidate = (
    entry.weekly_ops_matrix_regression_positive_rate_percent !== undefined
      ? entry.weekly_ops_matrix_regression_positive_rate_percent
      : weeklyOpsSignals.matrix_regression_positive_rate_percent
  );
  const weeklyOpsRuntimeBlockRatePercentCandidate = (
    entry.weekly_ops_runtime_block_rate_percent !== undefined
      ? entry.weekly_ops_runtime_block_rate_percent
      : weeklyOpsSignals.runtime_block_rate_percent
  );
  const weeklyOpsRuntimeUiModeViolationTotalCandidate = (
    entry.weekly_ops_runtime_ui_mode_violation_total !== undefined
      ? entry.weekly_ops_runtime_ui_mode_violation_total
      : weeklyOpsSignals.runtime_ui_mode_violation_total
  );
  const weeklyOpsRuntimeUiModeViolationRatePercentCandidate = (
    entry.weekly_ops_runtime_ui_mode_violation_rate_percent !== undefined
      ? entry.weekly_ops_runtime_ui_mode_violation_rate_percent
      : weeklyOpsSignals.runtime_ui_mode_violation_rate_percent
  );
  const weeklyOpsViolationsCountCandidate = (
    entry.weekly_ops_violations_count !== undefined
      ? entry.weekly_ops_violations_count
      : (
        weeklyOps.violations_count !== undefined
          ? weeklyOps.violations_count
          : (weeklyOpsAvailable ? weeklyOpsViolations.length : null)
      )
  );
  const weeklyOpsWarningCountCandidate = (
    entry.weekly_ops_warning_count !== undefined
      ? entry.weekly_ops_warning_count
      : (
        weeklyOps.warning_count !== undefined
          ? weeklyOps.warning_count
          : (weeklyOpsAvailable ? weeklyOpsWarnings.length : null)
      )
  );
  const weeklyOpsConfigWarningCountCandidate = (
    entry.weekly_ops_config_warning_count !== undefined
      ? entry.weekly_ops_config_warning_count
      : (
        weeklyOps.config_warning_count !== undefined
          ? weeklyOps.config_warning_count
          : (weeklyOpsAvailable ? weeklyOpsConfigWarnings.length : null)
      )
  );
  const weeklyOpsAuthorizationTierBlockRatePercent = (
    weeklyOpsAuthorizationTierBlockRatePercentCandidate === null
    || weeklyOpsAuthorizationTierBlockRatePercentCandidate === undefined
    || weeklyOpsAuthorizationTierBlockRatePercentCandidate === ''
  )
    ? null
    : parseAutoHandoffGateNumber(weeklyOpsAuthorizationTierBlockRatePercentCandidate);
  const weeklyOpsDialogueAuthorizationBlockRatePercent = (
    weeklyOpsDialogueAuthorizationBlockRatePercentCandidate === null
    || weeklyOpsDialogueAuthorizationBlockRatePercentCandidate === undefined
    || weeklyOpsDialogueAuthorizationBlockRatePercentCandidate === ''
  )
    ? null
    : parseAutoHandoffGateNumber(weeklyOpsDialogueAuthorizationBlockRatePercentCandidate);
  const weeklyOpsMatrixRegressionPositiveRatePercent = (
    weeklyOpsMatrixRegressionPositiveRatePercentCandidate === null
    || weeklyOpsMatrixRegressionPositiveRatePercentCandidate === undefined
    || weeklyOpsMatrixRegressionPositiveRatePercentCandidate === ''
  )
    ? null
    : parseAutoHandoffGateNumber(weeklyOpsMatrixRegressionPositiveRatePercentCandidate);
  const weeklyOpsRuntimeBlockRatePercent = (
    weeklyOpsRuntimeBlockRatePercentCandidate === null
    || weeklyOpsRuntimeBlockRatePercentCandidate === undefined
    || weeklyOpsRuntimeBlockRatePercentCandidate === ''
  )
    ? null
    : parseAutoHandoffGateNumber(weeklyOpsRuntimeBlockRatePercentCandidate);
  const weeklyOpsRuntimeUiModeViolationTotal = (
    weeklyOpsRuntimeUiModeViolationTotalCandidate === null
    || weeklyOpsRuntimeUiModeViolationTotalCandidate === undefined
    || weeklyOpsRuntimeUiModeViolationTotalCandidate === ''
  )
    ? null
    : parseAutoHandoffGateNumber(weeklyOpsRuntimeUiModeViolationTotalCandidate);
  const weeklyOpsRuntimeUiModeViolationRatePercent = (
    weeklyOpsRuntimeUiModeViolationRatePercentCandidate === null
    || weeklyOpsRuntimeUiModeViolationRatePercentCandidate === undefined
    || weeklyOpsRuntimeUiModeViolationRatePercentCandidate === ''
  )
    ? null
    : parseAutoHandoffGateNumber(weeklyOpsRuntimeUiModeViolationRatePercentCandidate);
  const weeklyOpsViolationsCount = (
    weeklyOpsViolationsCountCandidate === null
    || weeklyOpsViolationsCountCandidate === undefined
    || weeklyOpsViolationsCountCandidate === ''
  )
    ? null
    : parseAutoHandoffGateNumber(weeklyOpsViolationsCountCandidate);
  const weeklyOpsWarningCount = (
    weeklyOpsWarningCountCandidate === null
    || weeklyOpsWarningCountCandidate === undefined
    || weeklyOpsWarningCountCandidate === ''
  )
    ? null
    : parseAutoHandoffGateNumber(weeklyOpsWarningCountCandidate);
  const weeklyOpsConfigWarningCount = (
    weeklyOpsConfigWarningCountCandidate === null
    || weeklyOpsConfigWarningCountCandidate === undefined
    || weeklyOpsConfigWarningCountCandidate === ''
  )
    ? null
    : parseAutoHandoffGateNumber(weeklyOpsConfigWarningCountCandidate);
  const violations = Array.isArray(entry.violations)
    ? entry.violations.map(item => `${item}`)
    : [];
  const configWarnings = Array.isArray(entry.config_warnings)
    ? entry.config_warnings.map(item => `${item}`)
    : [];
  const signals = Array.isArray(entry.signals)
    ? entry.signals.map(item => `${item}`)
    : [];
  const thresholds = entry.thresholds && typeof entry.thresholds === 'object' && !Array.isArray(entry.thresholds)
    ? { ...entry.thresholds }
    : {};
  const evaluatedAt = normalizeHandoffText(
    entry.evaluated_at || entry.generated_at || entry.updated_at
  );
  const mode = normalizeHandoffText(entry.mode);
  const enforce = parseAutoHandoffGateBoolean(entry.enforce, false);
  const evidenceUsed = parseAutoHandoffGateBoolean(entry.evidence_used, false);
  const requireEvidence = parseAutoHandoffGateBoolean(entry.require_evidence, false);
  const requireGatePass = parseAutoHandoffGateBoolean(entry.require_gate_pass, true);
  const summaryFile = normalizeHandoffText(entry.summary_file);
  const portableFile = sourceFile
    ? toPortablePath(projectPath, sourceFile)
    : normalizeHandoffText(entry.file);
  const violationsCount = Number.isInteger(entry.violations_count)
    ? entry.violations_count
    : violations.length;
  const configWarningCount = Number.isInteger(entry.config_warning_count)
    ? entry.config_warning_count
    : configWarnings.length;

  return {
    tag: derivedTag,
    evaluated_at: evaluatedAt,
    gate_passed: gatePassed,
    mode,
    enforce,
    evidence_used: evidenceUsed,
    require_evidence: requireEvidence,
    require_gate_pass: requireGatePass,
    risk_level: riskLevel,
    spec_success_rate_percent: specSuccessRate,
    scene_package_batch_status: sceneBatchStatus || null,
    scene_package_batch_passed: typeof sceneBatchPassed === 'boolean' ? sceneBatchPassed : null,
    scene_package_batch_failure_count: Number.isFinite(sceneBatchFailureCount) ? sceneBatchFailureCount : null,
    capability_expected_unknown_count: Number.isFinite(capabilityExpectedUnknownCount)
      ? Math.max(0, Number(capabilityExpectedUnknownCount))
      : null,
    capability_provided_unknown_count: Number.isFinite(capabilityProvidedUnknownCount)
      ? Math.max(0, Number(capabilityProvidedUnknownCount))
      : null,
    release_gate_preflight_available: typeof releaseGatePreflightAvailable === 'boolean'
      ? releaseGatePreflightAvailable
      : null,
    release_gate_preflight_blocked: typeof releaseGatePreflightBlocked === 'boolean'
      ? releaseGatePreflightBlocked
      : null,
    require_release_gate_preflight: typeof requireReleaseGatePreflight === 'boolean'
      ? requireReleaseGatePreflight
      : null,
    drift_alert_count: Number.isFinite(driftAlertCount) ? Math.max(0, Number(driftAlertCount)) : null,
    drift_blocked: typeof driftBlocked === 'boolean' ? driftBlocked : null,
    drift_enforce: typeof driftEnforce === 'boolean' ? driftEnforce : null,
    drift_evaluated_at: driftEvaluatedAt || null,
    weekly_ops_available: weeklyOpsAvailable,
    weekly_ops_blocked: typeof weeklyOpsBlocked === 'boolean' ? weeklyOpsBlocked : null,
    weekly_ops_risk_level: weeklyOpsRiskLevel,
    weekly_ops_governance_status: weeklyOpsGovernanceStatus,
    weekly_ops_authorization_tier_block_rate_percent: Number.isFinite(weeklyOpsAuthorizationTierBlockRatePercent)
      ? weeklyOpsAuthorizationTierBlockRatePercent
      : null,
    weekly_ops_dialogue_authorization_block_rate_percent: Number.isFinite(weeklyOpsDialogueAuthorizationBlockRatePercent)
      ? weeklyOpsDialogueAuthorizationBlockRatePercent
      : null,
    weekly_ops_matrix_regression_positive_rate_percent: Number.isFinite(weeklyOpsMatrixRegressionPositiveRatePercent)
      ? weeklyOpsMatrixRegressionPositiveRatePercent
      : null,
    weekly_ops_runtime_block_rate_percent: Number.isFinite(weeklyOpsRuntimeBlockRatePercent)
      ? weeklyOpsRuntimeBlockRatePercent
      : null,
    weekly_ops_runtime_ui_mode_violation_total: Number.isFinite(weeklyOpsRuntimeUiModeViolationTotal)
      ? Math.max(0, Number(weeklyOpsRuntimeUiModeViolationTotal))
      : null,
    weekly_ops_runtime_ui_mode_violation_rate_percent: Number.isFinite(weeklyOpsRuntimeUiModeViolationRatePercent)
      ? Math.max(0, Number(weeklyOpsRuntimeUiModeViolationRatePercent))
      : null,
    weekly_ops_violations_count: Number.isFinite(weeklyOpsViolationsCount)
      ? Math.max(0, Number(weeklyOpsViolationsCount))
      : null,
    weekly_ops_warning_count: Number.isFinite(weeklyOpsWarningCount)
      ? Math.max(0, Number(weeklyOpsWarningCount))
      : null,
    weekly_ops_config_warning_count: Number.isFinite(weeklyOpsConfigWarningCount)
      ? Math.max(0, Number(weeklyOpsConfigWarningCount))
      : null,
    violations_count: Math.max(0, Number(violationsCount) || 0),
    config_warning_count: Math.max(0, Number(configWarningCount) || 0),
    thresholds,
    summary_file: summaryFile,
    file: portableFile,
    signals,
    violations,
    config_warnings: configWarnings
  };
}

async function loadAutoHandoffReleaseGateReports(projectPath, dirCandidate = null) {
  const dirPath = resolveAutoHandoffReleaseEvidenceDir(projectPath, dirCandidate);
  const warnings = [];
  if (!(await fs.pathExists(dirPath))) {
    return {
      dir: dirPath,
      report_files: [],
      entries: [],
      warnings
    };
  }

  const names = await fs.readdir(dirPath);
  const reportFiles = names
    .filter(name => {
      if (typeof name !== 'string') {
        return false;
      }
      const lowered = name.trim().toLowerCase();
      if (!lowered.startsWith('release-gate-') || !lowered.endsWith('.json')) {
        return false;
      }
      if (lowered === 'release-gate-history.json') {
        return false;
      }
      if (lowered.startsWith('release-gate-history-')) {
        return false;
      }
      return parseAutoHandoffReleaseGateTag(name) !== null;
    })
    .map(name => path.join(dirPath, name));

  const entries = [];
  for (const reportFile of reportFiles) {
    let payload = null;
    try {
      payload = await fs.readJson(reportFile);
    } catch (error) {
      warnings.push(`skip invalid release gate report: ${reportFile} (${error.message})`);
      continue;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      warnings.push(`skip invalid release gate payload: ${reportFile}`);
      continue;
    }
    entries.push(buildAutoHandoffReleaseGateHistoryEntry(payload, {
      projectPath,
      file: reportFile,
      tag: parseAutoHandoffReleaseGateTag(path.basename(reportFile))
    }));
  }

  return {
    dir: dirPath,
    report_files: reportFiles,
    entries,
    warnings
  };
}

async function loadAutoHandoffReleaseGateHistorySeed(projectPath, fileCandidate = null) {
  const filePath = resolveAutoHandoffReleaseGateHistoryFile(projectPath, fileCandidate);
  if (!(await fs.pathExists(filePath))) {
    return {
      file: filePath,
      entries: [],
      warnings: []
    };
  }

  let payload = null;
  try {
    payload = await fs.readJson(filePath);
  } catch (error) {
    return {
      file: filePath,
      entries: [],
      warnings: [`skip invalid gate history file: ${filePath} (${error.message})`]
    };
  }
  const list = Array.isArray(payload && payload.entries) ? payload.entries : [];
  const entries = list
    .filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .map(item => buildAutoHandoffReleaseGateHistoryEntry(item, { projectPath }));
  return {
    file: filePath,
    entries,
    warnings: []
  };
}

function mergeAutoHandoffReleaseGateHistoryEntries(entries = []) {
  const merged = new Map();
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const key = normalizeHandoffText(entry.tag)
      || normalizeHandoffText(entry.file)
      || `entry-${index}`;
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, entry);
      return;
    }
    const prevTs = toAutoHandoffTimestamp(previous.evaluated_at);
    const nextTs = toAutoHandoffTimestamp(entry.evaluated_at);
    if (nextTs >= prevTs) {
      merged.set(key, entry);
    }
  });
  return Array.from(merged.values());
}

function buildAutoHandoffReleaseGateHistoryAggregates(entries = []) {
  const riskCounts = {
    low: 0,
    medium: 0,
    high: 0,
    unknown: 0
  };
  const specRates = [];
  let gatePassedCount = 0;
  let gateFailedCount = 0;
  let gateUnknownCount = 0;
  let evidenceUsedCount = 0;
  let enforceCount = 0;
  let advisoryCount = 0;
  let violationsTotal = 0;
  let configWarningsTotal = 0;
  let driftAlertTotal = 0;
  let driftAlertRuns = 0;
  let driftBlockedRuns = 0;
  let driftKnownRuns = 0;
  let weeklyOpsKnownRuns = 0;
  let weeklyOpsBlockedRuns = 0;
  let weeklyOpsViolationsTotal = 0;
  let weeklyOpsWarningsTotal = 0;
  let weeklyOpsConfigWarningsTotal = 0;
  let weeklyOpsConfigWarningRuns = 0;
  let weeklyOpsRuntimeUiModeViolationKnownRuns = 0;
  let weeklyOpsRuntimeUiModeViolationRuns = 0;
  let weeklyOpsRuntimeUiModeViolationTotal = 0;
  const weeklyOpsAuthorizationTierBlockRates = [];
  const weeklyOpsDialogueAuthorizationBlockRates = [];
  const weeklyOpsMatrixRegressionPositiveRates = [];
  const weeklyOpsRuntimeBlockRates = [];
  const weeklyOpsRuntimeUiModeViolationRates = [];
  let preflightKnownRuns = 0;
  let preflightAvailableRuns = 0;
  let preflightBlockedRuns = 0;
  let preflightHardGateRuns = 0;
  let capabilityExpectedUnknownKnownRuns = 0;
  let capabilityExpectedUnknownPositiveRuns = 0;
  let capabilityProvidedUnknownKnownRuns = 0;
  let capabilityProvidedUnknownPositiveRuns = 0;
  const capabilityExpectedUnknownCounts = [];
  const capabilityProvidedUnknownCounts = [];
  const sceneBatchFailureCounts = [];
  let sceneBatchApplicableCount = 0;
  let sceneBatchPassedCount = 0;
  let sceneBatchFailedCount = 0;

  entries.forEach(entry => {
    const gatePassed = parseAutoHandoffGateBoolean(entry && entry.gate_passed, null);
    if (gatePassed === true) {
      gatePassedCount += 1;
    } else if (gatePassed === false) {
      gateFailedCount += 1;
    } else {
      gateUnknownCount += 1;
    }

    const evidenceUsed = parseAutoHandoffGateBoolean(entry && entry.evidence_used, false);
    if (evidenceUsed) {
      evidenceUsedCount += 1;
    }

    const enforce = parseAutoHandoffGateBoolean(entry && entry.enforce, false);
    if (enforce) {
      enforceCount += 1;
    } else {
      advisoryCount += 1;
    }

    const riskLevel = normalizeAutoHandoffGateRiskLevel(entry && entry.risk_level);
    riskCounts[riskLevel] += 1;

    const specRate = parseAutoHandoffGateNumber(entry && entry.spec_success_rate_percent);
    if (Number.isFinite(specRate)) {
      specRates.push(specRate);
    }
    const sceneBatchPassed = parseAutoHandoffGateBoolean(entry && entry.scene_package_batch_passed, null);
    if (sceneBatchPassed === true) {
      sceneBatchApplicableCount += 1;
      sceneBatchPassedCount += 1;
    } else if (sceneBatchPassed === false) {
      sceneBatchApplicableCount += 1;
      sceneBatchFailedCount += 1;
    }
    const sceneBatchFailureCount = parseAutoHandoffGateNumber(
      entry && entry.scene_package_batch_failure_count
    );
    if (Number.isFinite(sceneBatchFailureCount)) {
      sceneBatchFailureCounts.push(sceneBatchFailureCount);
    }
    const capabilityExpectedUnknownCount = parseAutoHandoffGateNumber(
      entry && entry.capability_expected_unknown_count
    );
    if (Number.isFinite(capabilityExpectedUnknownCount)) {
      const normalizedCount = Math.max(0, Number(capabilityExpectedUnknownCount));
      capabilityExpectedUnknownKnownRuns += 1;
      capabilityExpectedUnknownCounts.push(normalizedCount);
      if (normalizedCount > 0) {
        capabilityExpectedUnknownPositiveRuns += 1;
      }
    }
    const capabilityProvidedUnknownCount = parseAutoHandoffGateNumber(
      entry && entry.capability_provided_unknown_count
    );
    if (Number.isFinite(capabilityProvidedUnknownCount)) {
      const normalizedCount = Math.max(0, Number(capabilityProvidedUnknownCount));
      capabilityProvidedUnknownKnownRuns += 1;
      capabilityProvidedUnknownCounts.push(normalizedCount);
      if (normalizedCount > 0) {
        capabilityProvidedUnknownPositiveRuns += 1;
      }
    }
    const preflightAvailable = parseAutoHandoffGateBoolean(
      entry && entry.release_gate_preflight_available,
      null
    );
    const preflightBlocked = parseAutoHandoffGateBoolean(
      entry && entry.release_gate_preflight_blocked,
      null
    );
    const requirePreflight = parseAutoHandoffGateBoolean(
      entry && entry.require_release_gate_preflight,
      null
    );
    const hasPreflightSignal = (
      preflightAvailable === true || preflightAvailable === false ||
      preflightBlocked === true || preflightBlocked === false
    );
    if (hasPreflightSignal) {
      preflightKnownRuns += 1;
      if (preflightAvailable === true) {
        preflightAvailableRuns += 1;
      }
      if (preflightBlocked === true) {
        preflightBlockedRuns += 1;
      }
    }
    if (requirePreflight === true) {
      preflightHardGateRuns += 1;
    }
    const driftAlertRaw = entry && entry.drift_alert_count;
    const driftAlertCount = (
      driftAlertRaw === null
      || driftAlertRaw === undefined
      || driftAlertRaw === ''
    )
      ? null
      : parseAutoHandoffGateNumber(driftAlertRaw);
    if (Number.isFinite(driftAlertCount)) {
      driftKnownRuns += 1;
      const normalizedAlertCount = Math.max(0, Number(driftAlertCount));
      driftAlertTotal += normalizedAlertCount;
      if (normalizedAlertCount > 0) {
        driftAlertRuns += 1;
      }
    }
    const driftBlocked = parseAutoHandoffGateBoolean(entry && entry.drift_blocked, null);
    if (driftBlocked === true) {
      driftBlockedRuns += 1;
      if (!Number.isFinite(driftAlertCount)) {
        driftKnownRuns += 1;
      }
    } else if (driftBlocked === false && !Number.isFinite(driftAlertCount)) {
      driftKnownRuns += 1;
    }

    const weeklyOpsBlocked = parseAutoHandoffGateBoolean(entry && entry.weekly_ops_blocked, null);
    const weeklyOpsViolationsCountRaw = entry && entry.weekly_ops_violations_count;
    const weeklyOpsWarningCountRaw = entry && entry.weekly_ops_warning_count;
    const weeklyOpsConfigWarningCountRaw = entry && entry.weekly_ops_config_warning_count;
    const weeklyOpsAuthorizationTierBlockRateRaw = entry && entry.weekly_ops_authorization_tier_block_rate_percent;
    const weeklyOpsDialogueAuthorizationBlockRateRaw = entry && entry.weekly_ops_dialogue_authorization_block_rate_percent;
    const weeklyOpsMatrixRegressionPositiveRateRaw = entry && entry.weekly_ops_matrix_regression_positive_rate_percent;
    const weeklyOpsRuntimeBlockRateRaw = entry && entry.weekly_ops_runtime_block_rate_percent;
    const weeklyOpsRuntimeUiModeViolationTotalRaw = entry && entry.weekly_ops_runtime_ui_mode_violation_total;
    const weeklyOpsRuntimeUiModeViolationRateRaw = entry && entry.weekly_ops_runtime_ui_mode_violation_rate_percent;
    const weeklyOpsViolationsCount = (
      weeklyOpsViolationsCountRaw === null
      || weeklyOpsViolationsCountRaw === undefined
      || weeklyOpsViolationsCountRaw === ''
    )
      ? null
      : parseAutoHandoffGateNumber(weeklyOpsViolationsCountRaw);
    const weeklyOpsWarningCount = (
      weeklyOpsWarningCountRaw === null
      || weeklyOpsWarningCountRaw === undefined
      || weeklyOpsWarningCountRaw === ''
    )
      ? null
      : parseAutoHandoffGateNumber(weeklyOpsWarningCountRaw);
    const weeklyOpsConfigWarningCount = (
      weeklyOpsConfigWarningCountRaw === null
      || weeklyOpsConfigWarningCountRaw === undefined
      || weeklyOpsConfigWarningCountRaw === ''
    )
      ? null
      : parseAutoHandoffGateNumber(weeklyOpsConfigWarningCountRaw);
    const weeklyOpsAuthorizationTierBlockRate = (
      weeklyOpsAuthorizationTierBlockRateRaw === null
      || weeklyOpsAuthorizationTierBlockRateRaw === undefined
      || weeklyOpsAuthorizationTierBlockRateRaw === ''
    )
      ? null
      : parseAutoHandoffGateNumber(weeklyOpsAuthorizationTierBlockRateRaw);
    const weeklyOpsDialogueAuthorizationBlockRate = (
      weeklyOpsDialogueAuthorizationBlockRateRaw === null
      || weeklyOpsDialogueAuthorizationBlockRateRaw === undefined
      || weeklyOpsDialogueAuthorizationBlockRateRaw === ''
    )
      ? null
      : parseAutoHandoffGateNumber(weeklyOpsDialogueAuthorizationBlockRateRaw);
    const weeklyOpsMatrixRegressionPositiveRate = (
      weeklyOpsMatrixRegressionPositiveRateRaw === null
      || weeklyOpsMatrixRegressionPositiveRateRaw === undefined
      || weeklyOpsMatrixRegressionPositiveRateRaw === ''
    )
      ? null
      : parseAutoHandoffGateNumber(weeklyOpsMatrixRegressionPositiveRateRaw);
    const weeklyOpsRuntimeBlockRate = (
      weeklyOpsRuntimeBlockRateRaw === null
      || weeklyOpsRuntimeBlockRateRaw === undefined
      || weeklyOpsRuntimeBlockRateRaw === ''
    )
      ? null
      : parseAutoHandoffGateNumber(weeklyOpsRuntimeBlockRateRaw);
    const weeklyOpsRuntimeUiModeViolationTotalCount = (
      weeklyOpsRuntimeUiModeViolationTotalRaw === null
      || weeklyOpsRuntimeUiModeViolationTotalRaw === undefined
      || weeklyOpsRuntimeUiModeViolationTotalRaw === ''
    )
      ? null
      : parseAutoHandoffGateNumber(weeklyOpsRuntimeUiModeViolationTotalRaw);
    const weeklyOpsRuntimeUiModeViolationRate = (
      weeklyOpsRuntimeUiModeViolationRateRaw === null
      || weeklyOpsRuntimeUiModeViolationRateRaw === undefined
      || weeklyOpsRuntimeUiModeViolationRateRaw === ''
    )
      ? null
      : parseAutoHandoffGateNumber(weeklyOpsRuntimeUiModeViolationRateRaw);
    const weeklyOpsHasSignal = (
      entry && entry.weekly_ops_available === true
      || weeklyOpsBlocked === true
      || weeklyOpsBlocked === false
      || Number.isFinite(weeklyOpsViolationsCount)
      || Number.isFinite(weeklyOpsWarningCount)
      || Number.isFinite(weeklyOpsConfigWarningCount)
      || Number.isFinite(weeklyOpsAuthorizationTierBlockRate)
      || Number.isFinite(weeklyOpsDialogueAuthorizationBlockRate)
      || Number.isFinite(weeklyOpsMatrixRegressionPositiveRate)
      || Number.isFinite(weeklyOpsRuntimeBlockRate)
      || Number.isFinite(weeklyOpsRuntimeUiModeViolationTotalCount)
      || Number.isFinite(weeklyOpsRuntimeUiModeViolationRate)
    );
    if (weeklyOpsHasSignal) {
      weeklyOpsKnownRuns += 1;
      if (weeklyOpsBlocked === true) {
        weeklyOpsBlockedRuns += 1;
      }
      const normalizedWeeklyViolations = Number.isFinite(weeklyOpsViolationsCount)
        ? Math.max(0, Number(weeklyOpsViolationsCount))
        : 0;
      const normalizedWeeklyWarnings = Number.isFinite(weeklyOpsWarningCount)
        ? Math.max(0, Number(weeklyOpsWarningCount))
        : 0;
      const normalizedWeeklyConfigWarnings = Number.isFinite(weeklyOpsConfigWarningCount)
        ? Math.max(0, Number(weeklyOpsConfigWarningCount))
        : 0;
      weeklyOpsViolationsTotal += normalizedWeeklyViolations;
      weeklyOpsWarningsTotal += normalizedWeeklyWarnings;
      weeklyOpsConfigWarningsTotal += normalizedWeeklyConfigWarnings;
      if (normalizedWeeklyConfigWarnings > 0) {
        weeklyOpsConfigWarningRuns += 1;
      }
      if (Number.isFinite(weeklyOpsAuthorizationTierBlockRate)) {
        weeklyOpsAuthorizationTierBlockRates.push(Math.max(0, Number(weeklyOpsAuthorizationTierBlockRate)));
      }
      if (Number.isFinite(weeklyOpsDialogueAuthorizationBlockRate)) {
        weeklyOpsDialogueAuthorizationBlockRates.push(Math.max(0, Number(weeklyOpsDialogueAuthorizationBlockRate)));
      }
      if (Number.isFinite(weeklyOpsMatrixRegressionPositiveRate)) {
        weeklyOpsMatrixRegressionPositiveRates.push(Math.max(0, Number(weeklyOpsMatrixRegressionPositiveRate)));
      }
      if (Number.isFinite(weeklyOpsRuntimeBlockRate)) {
        weeklyOpsRuntimeBlockRates.push(Math.max(0, Number(weeklyOpsRuntimeBlockRate)));
      }
      const hasRuntimeUiModeSignal = (
        Number.isFinite(weeklyOpsRuntimeUiModeViolationTotalCount) ||
        Number.isFinite(weeklyOpsRuntimeUiModeViolationRate) ||
        Number.isFinite(weeklyOpsRuntimeBlockRate)
      );
      if (hasRuntimeUiModeSignal) {
        weeklyOpsRuntimeUiModeViolationKnownRuns += 1;
      }
      if (Number.isFinite(weeklyOpsRuntimeUiModeViolationTotalCount)) {
        const normalizedRuntimeUiModeViolationTotal = Math.max(0, Number(weeklyOpsRuntimeUiModeViolationTotalCount));
        weeklyOpsRuntimeUiModeViolationTotal += normalizedRuntimeUiModeViolationTotal;
        if (normalizedRuntimeUiModeViolationTotal > 0) {
          weeklyOpsRuntimeUiModeViolationRuns += 1;
        }
      }
      if (Number.isFinite(weeklyOpsRuntimeUiModeViolationRate)) {
        weeklyOpsRuntimeUiModeViolationRates.push(Math.max(0, Number(weeklyOpsRuntimeUiModeViolationRate)));
      }
    }

    violationsTotal += Math.max(0, Number(entry && entry.violations_count) || 0);
    configWarningsTotal += Math.max(0, Number(entry && entry.config_warning_count) || 0);
  });

  const evaluatedGateCount = gatePassedCount + gateFailedCount;
  const passRate = evaluatedGateCount > 0
    ? Number(((gatePassedCount / evaluatedGateCount) * 100).toFixed(2))
    : null;
  const averageSpecRate = specRates.length > 0
    ? Number((specRates.reduce((sum, value) => sum + value, 0) / specRates.length).toFixed(2))
    : null;
  const minSpecRate = specRates.length > 0
    ? Number(Math.min(...specRates).toFixed(2))
    : null;
  const maxSpecRate = specRates.length > 0
    ? Number(Math.max(...specRates).toFixed(2))
    : null;
  const sceneBatchPassRate = sceneBatchApplicableCount > 0
    ? Number(((sceneBatchPassedCount / sceneBatchApplicableCount) * 100).toFixed(2))
    : null;
  const avgSceneBatchFailureCount = sceneBatchFailureCounts.length > 0
    ? Number((sceneBatchFailureCounts.reduce((sum, value) => sum + value, 0) / sceneBatchFailureCounts.length).toFixed(2))
    : null;
  const maxSceneBatchFailureCount = sceneBatchFailureCounts.length > 0
    ? Number(Math.max(...sceneBatchFailureCounts).toFixed(2))
    : null;
  const avgCapabilityExpectedUnknownCount = capabilityExpectedUnknownCounts.length > 0
    ? Number((capabilityExpectedUnknownCounts.reduce((sum, value) => sum + value, 0) / capabilityExpectedUnknownCounts.length).toFixed(2))
    : null;
  const maxCapabilityExpectedUnknownCount = capabilityExpectedUnknownCounts.length > 0
    ? Number(Math.max(...capabilityExpectedUnknownCounts).toFixed(2))
    : null;
  const capabilityExpectedUnknownPositiveRate = capabilityExpectedUnknownKnownRuns > 0
    ? Number(((capabilityExpectedUnknownPositiveRuns / capabilityExpectedUnknownKnownRuns) * 100).toFixed(2))
    : null;
  const avgCapabilityProvidedUnknownCount = capabilityProvidedUnknownCounts.length > 0
    ? Number((capabilityProvidedUnknownCounts.reduce((sum, value) => sum + value, 0) / capabilityProvidedUnknownCounts.length).toFixed(2))
    : null;
  const maxCapabilityProvidedUnknownCount = capabilityProvidedUnknownCounts.length > 0
    ? Number(Math.max(...capabilityProvidedUnknownCounts).toFixed(2))
    : null;
  const capabilityProvidedUnknownPositiveRate = capabilityProvidedUnknownKnownRuns > 0
    ? Number(((capabilityProvidedUnknownPositiveRuns / capabilityProvidedUnknownKnownRuns) * 100).toFixed(2))
    : null;
  const driftAlertRate = driftKnownRuns > 0
    ? Number(((driftAlertRuns / driftKnownRuns) * 100).toFixed(2))
    : null;
  const driftBlockRate = driftKnownRuns > 0
    ? Number(((driftBlockedRuns / driftKnownRuns) * 100).toFixed(2))
    : null;
  const weeklyOpsBlockRate = weeklyOpsKnownRuns > 0
    ? Number(((weeklyOpsBlockedRuns / weeklyOpsKnownRuns) * 100).toFixed(2))
    : null;
  const weeklyOpsConfigWarningRunRate = weeklyOpsKnownRuns > 0
    ? Number(((weeklyOpsConfigWarningRuns / weeklyOpsKnownRuns) * 100).toFixed(2))
    : null;
  const weeklyOpsAuthorizationTierBlockRateAvg = weeklyOpsAuthorizationTierBlockRates.length > 0
    ? Number((weeklyOpsAuthorizationTierBlockRates.reduce((sum, value) => sum + value, 0) / weeklyOpsAuthorizationTierBlockRates.length).toFixed(2))
    : null;
  const weeklyOpsAuthorizationTierBlockRateMax = weeklyOpsAuthorizationTierBlockRates.length > 0
    ? Number(Math.max(...weeklyOpsAuthorizationTierBlockRates).toFixed(2))
    : null;
  const weeklyOpsDialogueAuthorizationBlockRateAvg = weeklyOpsDialogueAuthorizationBlockRates.length > 0
    ? Number((weeklyOpsDialogueAuthorizationBlockRates.reduce((sum, value) => sum + value, 0) / weeklyOpsDialogueAuthorizationBlockRates.length).toFixed(2))
    : null;
  const weeklyOpsDialogueAuthorizationBlockRateMax = weeklyOpsDialogueAuthorizationBlockRates.length > 0
    ? Number(Math.max(...weeklyOpsDialogueAuthorizationBlockRates).toFixed(2))
    : null;
  const weeklyOpsMatrixRegressionPositiveRateAvg = weeklyOpsMatrixRegressionPositiveRates.length > 0
    ? Number((weeklyOpsMatrixRegressionPositiveRates.reduce((sum, value) => sum + value, 0) / weeklyOpsMatrixRegressionPositiveRates.length).toFixed(2))
    : null;
  const weeklyOpsMatrixRegressionPositiveRateMax = weeklyOpsMatrixRegressionPositiveRates.length > 0
    ? Number(Math.max(...weeklyOpsMatrixRegressionPositiveRates).toFixed(2))
    : null;
  const weeklyOpsRuntimeBlockRateAvg = weeklyOpsRuntimeBlockRates.length > 0
    ? Number((weeklyOpsRuntimeBlockRates.reduce((sum, value) => sum + value, 0) / weeklyOpsRuntimeBlockRates.length).toFixed(2))
    : null;
  const weeklyOpsRuntimeBlockRateMax = weeklyOpsRuntimeBlockRates.length > 0
    ? Number(Math.max(...weeklyOpsRuntimeBlockRates).toFixed(2))
    : null;
  const weeklyOpsRuntimeUiModeViolationRateAvg = weeklyOpsRuntimeUiModeViolationRates.length > 0
    ? Number((weeklyOpsRuntimeUiModeViolationRates.reduce((sum, value) => sum + value, 0) / weeklyOpsRuntimeUiModeViolationRates.length).toFixed(2))
    : null;
  const weeklyOpsRuntimeUiModeViolationRateMax = weeklyOpsRuntimeUiModeViolationRates.length > 0
    ? Number(Math.max(...weeklyOpsRuntimeUiModeViolationRates).toFixed(2))
    : null;
  const weeklyOpsRuntimeUiModeViolationRunRate = weeklyOpsRuntimeUiModeViolationKnownRuns > 0
    ? Number(((weeklyOpsRuntimeUiModeViolationRuns / weeklyOpsRuntimeUiModeViolationKnownRuns) * 100).toFixed(2))
    : null;
  const preflightAvailabilityRate = preflightKnownRuns > 0
    ? Number(((preflightAvailableRuns / preflightKnownRuns) * 100).toFixed(2))
    : null;
  const preflightBlockedRate = preflightKnownRuns > 0
    ? Number(((preflightBlockedRuns / preflightKnownRuns) * 100).toFixed(2))
    : null;

  return {
    gate_passed_count: gatePassedCount,
    gate_failed_count: gateFailedCount,
    gate_unknown_count: gateUnknownCount,
    pass_rate_percent: passRate,
    evidence_used_count: evidenceUsedCount,
    enforce_count: enforceCount,
    advisory_count: advisoryCount,
    violations_total: violationsTotal,
    config_warnings_total: configWarningsTotal,
    avg_spec_success_rate_percent: averageSpecRate,
    min_spec_success_rate_percent: minSpecRate,
    max_spec_success_rate_percent: maxSpecRate,
    scene_package_batch_applicable_count: sceneBatchApplicableCount,
    scene_package_batch_passed_count: sceneBatchPassedCount,
    scene_package_batch_failed_count: sceneBatchFailedCount,
    scene_package_batch_pass_rate_percent: sceneBatchPassRate,
    avg_scene_package_batch_failure_count: avgSceneBatchFailureCount,
    max_scene_package_batch_failure_count: maxSceneBatchFailureCount,
    capability_expected_unknown_known_runs: capabilityExpectedUnknownKnownRuns,
    capability_expected_unknown_positive_runs: capabilityExpectedUnknownPositiveRuns,
    capability_expected_unknown_positive_rate_percent: capabilityExpectedUnknownPositiveRate,
    avg_capability_expected_unknown_count: avgCapabilityExpectedUnknownCount,
    max_capability_expected_unknown_count: maxCapabilityExpectedUnknownCount,
    capability_provided_unknown_known_runs: capabilityProvidedUnknownKnownRuns,
    capability_provided_unknown_positive_runs: capabilityProvidedUnknownPositiveRuns,
    capability_provided_unknown_positive_rate_percent: capabilityProvidedUnknownPositiveRate,
    avg_capability_provided_unknown_count: avgCapabilityProvidedUnknownCount,
    max_capability_provided_unknown_count: maxCapabilityProvidedUnknownCount,
    drift_known_runs: driftKnownRuns,
    drift_alert_total: driftAlertTotal,
    drift_alert_runs: driftAlertRuns,
    drift_blocked_runs: driftBlockedRuns,
    drift_alert_rate_percent: driftAlertRate,
    drift_block_rate_percent: driftBlockRate,
    weekly_ops_known_runs: weeklyOpsKnownRuns,
    weekly_ops_blocked_runs: weeklyOpsBlockedRuns,
    weekly_ops_block_rate_percent: weeklyOpsBlockRate,
    weekly_ops_violations_total: weeklyOpsViolationsTotal,
    weekly_ops_warnings_total: weeklyOpsWarningsTotal,
    weekly_ops_config_warnings_total: weeklyOpsConfigWarningsTotal,
    weekly_ops_config_warning_runs: weeklyOpsConfigWarningRuns,
    weekly_ops_config_warning_run_rate_percent: weeklyOpsConfigWarningRunRate,
    weekly_ops_authorization_tier_block_rate_avg_percent: weeklyOpsAuthorizationTierBlockRateAvg,
    weekly_ops_authorization_tier_block_rate_max_percent: weeklyOpsAuthorizationTierBlockRateMax,
    weekly_ops_dialogue_authorization_block_rate_avg_percent: weeklyOpsDialogueAuthorizationBlockRateAvg,
    weekly_ops_dialogue_authorization_block_rate_max_percent: weeklyOpsDialogueAuthorizationBlockRateMax,
    weekly_ops_matrix_regression_positive_rate_avg_percent: weeklyOpsMatrixRegressionPositiveRateAvg,
    weekly_ops_matrix_regression_positive_rate_max_percent: weeklyOpsMatrixRegressionPositiveRateMax,
    weekly_ops_runtime_block_rate_avg_percent: weeklyOpsRuntimeBlockRateAvg,
    weekly_ops_runtime_block_rate_max_percent: weeklyOpsRuntimeBlockRateMax,
    weekly_ops_runtime_ui_mode_violation_known_runs: weeklyOpsRuntimeUiModeViolationKnownRuns,
    weekly_ops_runtime_ui_mode_violation_runs: weeklyOpsRuntimeUiModeViolationRuns,
    weekly_ops_runtime_ui_mode_violation_run_rate_percent: weeklyOpsRuntimeUiModeViolationRunRate,
    weekly_ops_runtime_ui_mode_violation_total: weeklyOpsRuntimeUiModeViolationTotal,
    weekly_ops_runtime_ui_mode_violation_rate_avg_percent: weeklyOpsRuntimeUiModeViolationRateAvg,
    weekly_ops_runtime_ui_mode_violation_rate_max_percent: weeklyOpsRuntimeUiModeViolationRateMax,
    release_gate_preflight_known_runs: preflightKnownRuns,
    release_gate_preflight_available_runs: preflightAvailableRuns,
    release_gate_preflight_blocked_runs: preflightBlockedRuns,
    release_gate_preflight_hard_gate_runs: preflightHardGateRuns,
    release_gate_preflight_availability_rate_percent: preflightAvailabilityRate,
    release_gate_preflight_block_rate_percent: preflightBlockedRate,
    risk_levels: riskCounts
  };
}

async function buildAutoHandoffReleaseGateHistoryIndex(projectPath, options = {}) {
  const keep = normalizeHandoffGateHistoryKeep(options.keep);
  const outFile = resolveAutoHandoffReleaseGateHistoryFile(projectPath, options.out);
  const historySeedFile = typeof options.historyFile === 'string' && options.historyFile.trim()
    ? resolveAutoHandoffReleaseGateHistoryFile(projectPath, options.historyFile)
    : outFile;
  const reportResult = await loadAutoHandoffReleaseGateReports(projectPath, options.dir);
  const historySeed = await loadAutoHandoffReleaseGateHistorySeed(projectPath, historySeedFile);
  const mergedEntries = mergeAutoHandoffReleaseGateHistoryEntries([
    ...reportResult.entries,
    ...historySeed.entries
  ]);

  if (mergedEntries.length === 0) {
    throw new Error(`no release gate reports found: ${reportResult.dir}`);
  }

  mergedEntries.sort((left, right) => {
    const leftTs = toAutoHandoffTimestamp(left && left.evaluated_at);
    const rightTs = toAutoHandoffTimestamp(right && right.evaluated_at);
    if (rightTs !== leftTs) {
      return rightTs - leftTs;
    }
    const leftTag = normalizeHandoffText(left && left.tag) || '';
    const rightTag = normalizeHandoffText(right && right.tag) || '';
    return rightTag.localeCompare(leftTag);
  });

  const entries = mergedEntries.slice(0, keep);
  const latestEntry = entries[0] || null;
  const warnings = [...reportResult.warnings, ...historySeed.warnings];
  const payload = {
    mode: 'auto-handoff-release-gate-history',
    generated_at: new Date().toISOString(),
    source_dir: reportResult.dir,
    report_file_count: reportResult.report_files.length,
    report_entry_count: reportResult.entries.length,
    seed_file: historySeed.file,
    seed_entry_count: historySeed.entries.length,
    keep,
    total_entries: entries.length,
    latest: latestEntry
      ? {
        tag: latestEntry.tag,
        evaluated_at: latestEntry.evaluated_at,
        gate_passed: latestEntry.gate_passed,
        risk_level: latestEntry.risk_level,
        scene_package_batch_passed: latestEntry.scene_package_batch_passed,
        scene_package_batch_failure_count: latestEntry.scene_package_batch_failure_count,
        capability_expected_unknown_count: latestEntry.capability_expected_unknown_count,
        capability_provided_unknown_count: latestEntry.capability_provided_unknown_count,
        release_gate_preflight_available: latestEntry.release_gate_preflight_available,
        release_gate_preflight_blocked: latestEntry.release_gate_preflight_blocked,
        require_release_gate_preflight: latestEntry.require_release_gate_preflight,
        weekly_ops_blocked: latestEntry.weekly_ops_blocked,
        weekly_ops_risk_level: latestEntry.weekly_ops_risk_level,
        weekly_ops_governance_status: latestEntry.weekly_ops_governance_status,
        weekly_ops_authorization_tier_block_rate_percent: latestEntry.weekly_ops_authorization_tier_block_rate_percent,
        weekly_ops_dialogue_authorization_block_rate_percent: latestEntry.weekly_ops_dialogue_authorization_block_rate_percent,
        weekly_ops_matrix_regression_positive_rate_percent: latestEntry.weekly_ops_matrix_regression_positive_rate_percent,
        weekly_ops_runtime_block_rate_percent: latestEntry.weekly_ops_runtime_block_rate_percent,
        weekly_ops_runtime_ui_mode_violation_total: latestEntry.weekly_ops_runtime_ui_mode_violation_total,
        weekly_ops_runtime_ui_mode_violation_rate_percent: latestEntry.weekly_ops_runtime_ui_mode_violation_rate_percent,
        weekly_ops_violations_count: latestEntry.weekly_ops_violations_count,
        weekly_ops_warning_count: latestEntry.weekly_ops_warning_count,
        weekly_ops_config_warning_count: latestEntry.weekly_ops_config_warning_count,
        drift_alert_count: latestEntry.drift_alert_count,
        drift_blocked: latestEntry.drift_blocked
      }
      : null,
    aggregates: buildAutoHandoffReleaseGateHistoryAggregates(entries),
    warnings,
    warnings_count: warnings.length,
    entries
  };
  return payload;
}

function renderAutoHandoffReleaseGateHistoryMarkdown(payload = {}) {
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const aggregates = payload.aggregates && typeof payload.aggregates === 'object'
    ? payload.aggregates
    : {};
  const latest = payload.latest && typeof payload.latest === 'object'
    ? payload.latest
    : null;
  const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  const recentEntries = entries.slice(0, 10);

  const lines = [
    '# Auto Handoff Release Gate History',
    '',
    `- Generated at: ${formatAutoHandoffRegressionValue(payload.generated_at)}`,
    `- Source dir: ${formatAutoHandoffRegressionValue(payload.source_dir)}`,
    `- Total entries: ${formatAutoHandoffRegressionValue(payload.total_entries, '0')}`,
    `- Keep: ${formatAutoHandoffRegressionValue(payload.keep, '0')}`,
    ''
  ];

  if (latest) {
    lines.push('## Latest');
    lines.push('');
    lines.push(`- Tag: ${formatAutoHandoffRegressionValue(latest.tag)}`);
    lines.push(`- Evaluated at: ${formatAutoHandoffRegressionValue(latest.evaluated_at)}`);
    lines.push(`- Gate passed: ${latest.gate_passed === true ? 'yes' : (latest.gate_passed === false ? 'no' : 'n/a')}`);
    lines.push(`- Risk level: ${formatAutoHandoffRegressionValue(latest.risk_level)}`);
    lines.push(`- Scene package batch: ${latest.scene_package_batch_passed === true ? 'pass' : (latest.scene_package_batch_passed === false ? 'fail' : 'n/a')}`);
    lines.push(`- Scene package batch failures: ${formatAutoHandoffRegressionValue(latest.scene_package_batch_failure_count)}`);
    lines.push(`- Capability expected unknown count: ${formatAutoHandoffRegressionValue(latest.capability_expected_unknown_count, '0')}`);
    lines.push(`- Capability provided unknown count: ${formatAutoHandoffRegressionValue(latest.capability_provided_unknown_count, '0')}`);
    lines.push(`- Release preflight available: ${latest.release_gate_preflight_available === true ? 'yes' : (latest.release_gate_preflight_available === false ? 'no' : 'n/a')}`);
    lines.push(`- Release preflight blocked: ${latest.release_gate_preflight_blocked === true ? 'yes' : (latest.release_gate_preflight_blocked === false ? 'no' : 'n/a')}`);
    lines.push(`- Release preflight hard-gate: ${latest.require_release_gate_preflight === true ? 'enabled' : (latest.require_release_gate_preflight === false ? 'advisory' : 'n/a')}`);
    lines.push(`- Weekly ops blocked: ${latest.weekly_ops_blocked === true ? 'yes' : (latest.weekly_ops_blocked === false ? 'no' : 'n/a')}`);
    lines.push(`- Weekly ops risk: ${formatAutoHandoffRegressionValue(latest.weekly_ops_risk_level)}`);
    lines.push(`- Weekly ops governance status: ${formatAutoHandoffRegressionValue(latest.weekly_ops_governance_status)}`);
    lines.push(`- Weekly ops auth-tier block rate: ${formatAutoHandoffRegressionValue(latest.weekly_ops_authorization_tier_block_rate_percent)}%`);
    lines.push(`- Weekly ops dialogue-auth block rate: ${formatAutoHandoffRegressionValue(latest.weekly_ops_dialogue_authorization_block_rate_percent)}%`);
    lines.push(`- Weekly ops matrix regression-positive rate: ${formatAutoHandoffRegressionValue(latest.weekly_ops_matrix_regression_positive_rate_percent)}%`);
    lines.push(`- Weekly ops runtime block rate: ${formatAutoHandoffRegressionValue(latest.weekly_ops_runtime_block_rate_percent)}%`);
    lines.push(`- Weekly ops runtime ui-mode violations: ${formatAutoHandoffRegressionValue(latest.weekly_ops_runtime_ui_mode_violation_total, '0')}`);
    lines.push(`- Weekly ops runtime ui-mode violation rate: ${formatAutoHandoffRegressionValue(latest.weekly_ops_runtime_ui_mode_violation_rate_percent)}%`);
    lines.push(`- Weekly ops violations: ${formatAutoHandoffRegressionValue(latest.weekly_ops_violations_count, '0')}`);
    lines.push(`- Weekly ops warnings: ${formatAutoHandoffRegressionValue(latest.weekly_ops_warning_count, '0')}`);
    lines.push(`- Weekly ops config warnings: ${formatAutoHandoffRegressionValue(latest.weekly_ops_config_warning_count, '0')}`);
    lines.push(`- Drift alerts: ${formatAutoHandoffRegressionValue(latest.drift_alert_count, '0')}`);
    lines.push(`- Drift blocked: ${latest.drift_blocked === true ? 'yes' : (latest.drift_blocked === false ? 'no' : 'n/a')}`);
    lines.push('');
  }

  lines.push('## Aggregates');
  lines.push('');
  lines.push(`- Gate pass rate: ${formatAutoHandoffRegressionValue(aggregates.pass_rate_percent)}%`);
  lines.push(`- Passed: ${formatAutoHandoffRegressionValue(aggregates.gate_passed_count, '0')}`);
  lines.push(`- Failed: ${formatAutoHandoffRegressionValue(aggregates.gate_failed_count, '0')}`);
  lines.push(`- Unknown: ${formatAutoHandoffRegressionValue(aggregates.gate_unknown_count, '0')}`);
  lines.push(`- Evidence used: ${formatAutoHandoffRegressionValue(aggregates.evidence_used_count, '0')}`);
  lines.push(`- Enforce mode runs: ${formatAutoHandoffRegressionValue(aggregates.enforce_count, '0')}`);
  lines.push(`- Advisory mode runs: ${formatAutoHandoffRegressionValue(aggregates.advisory_count, '0')}`);
  lines.push(`- Avg spec success rate: ${formatAutoHandoffRegressionValue(aggregates.avg_spec_success_rate_percent)}`);
  lines.push(`- Scene package batch pass rate: ${formatAutoHandoffRegressionValue(aggregates.scene_package_batch_pass_rate_percent)}%`);
  lines.push(`- Scene package batch failed: ${formatAutoHandoffRegressionValue(aggregates.scene_package_batch_failed_count, '0')}`);
  lines.push(`- Avg scene package batch failures: ${formatAutoHandoffRegressionValue(aggregates.avg_scene_package_batch_failure_count)}`);
  lines.push(`- Capability expected unknown positive rate: ${formatAutoHandoffRegressionValue(aggregates.capability_expected_unknown_positive_rate_percent)}%`);
  lines.push(`- Avg capability expected unknown count: ${formatAutoHandoffRegressionValue(aggregates.avg_capability_expected_unknown_count)}`);
  lines.push(`- Max capability expected unknown count: ${formatAutoHandoffRegressionValue(aggregates.max_capability_expected_unknown_count)}`);
  lines.push(`- Capability provided unknown positive rate: ${formatAutoHandoffRegressionValue(aggregates.capability_provided_unknown_positive_rate_percent)}%`);
  lines.push(`- Avg capability provided unknown count: ${formatAutoHandoffRegressionValue(aggregates.avg_capability_provided_unknown_count)}`);
  lines.push(`- Max capability provided unknown count: ${formatAutoHandoffRegressionValue(aggregates.max_capability_provided_unknown_count)}`);
  lines.push(`- Drift alert runs: ${formatAutoHandoffRegressionValue(aggregates.drift_alert_runs, '0')}`);
  lines.push(`- Drift blocked runs: ${formatAutoHandoffRegressionValue(aggregates.drift_blocked_runs, '0')}`);
  lines.push(`- Drift alert rate: ${formatAutoHandoffRegressionValue(aggregates.drift_alert_rate_percent)}%`);
  lines.push(`- Drift block rate: ${formatAutoHandoffRegressionValue(aggregates.drift_block_rate_percent)}%`);
  lines.push(`- Weekly ops known runs: ${formatAutoHandoffRegressionValue(aggregates.weekly_ops_known_runs, '0')}`);
  lines.push(`- Weekly ops blocked runs: ${formatAutoHandoffRegressionValue(aggregates.weekly_ops_blocked_runs, '0')}`);
  lines.push(`- Weekly ops block rate: ${formatAutoHandoffRegressionValue(aggregates.weekly_ops_block_rate_percent)}%`);
  lines.push(`- Weekly ops violations total: ${formatAutoHandoffRegressionValue(aggregates.weekly_ops_violations_total, '0')}`);
  lines.push(`- Weekly ops warnings total: ${formatAutoHandoffRegressionValue(aggregates.weekly_ops_warnings_total, '0')}`);
  lines.push(`- Weekly ops config warnings total: ${formatAutoHandoffRegressionValue(aggregates.weekly_ops_config_warnings_total, '0')}`);
  lines.push(`- Weekly ops config warning runs: ${formatAutoHandoffRegressionValue(aggregates.weekly_ops_config_warning_runs, '0')}`);
  lines.push(`- Weekly ops config warning run rate: ${formatAutoHandoffRegressionValue(aggregates.weekly_ops_config_warning_run_rate_percent)}%`);
  lines.push(`- Weekly ops auth-tier block rate avg/max: ${formatAutoHandoffRegressionValue(aggregates.weekly_ops_authorization_tier_block_rate_avg_percent)}/${formatAutoHandoffRegressionValue(aggregates.weekly_ops_authorization_tier_block_rate_max_percent)}%`);
  lines.push(`- Weekly ops dialogue-auth block rate avg/max: ${formatAutoHandoffRegressionValue(aggregates.weekly_ops_dialogue_authorization_block_rate_avg_percent)}/${formatAutoHandoffRegressionValue(aggregates.weekly_ops_dialogue_authorization_block_rate_max_percent)}%`);
  lines.push(`- Weekly ops matrix regression-positive rate avg/max: ${formatAutoHandoffRegressionValue(aggregates.weekly_ops_matrix_regression_positive_rate_avg_percent)}/${formatAutoHandoffRegressionValue(aggregates.weekly_ops_matrix_regression_positive_rate_max_percent)}%`);
  lines.push(`- Weekly ops runtime block rate avg/max: ${formatAutoHandoffRegressionValue(aggregates.weekly_ops_runtime_block_rate_avg_percent)}/${formatAutoHandoffRegressionValue(aggregates.weekly_ops_runtime_block_rate_max_percent)}%`);
  lines.push(`- Weekly ops runtime ui-mode known runs: ${formatAutoHandoffRegressionValue(aggregates.weekly_ops_runtime_ui_mode_violation_known_runs, '0')}`);
  lines.push(`- Weekly ops runtime ui-mode violation runs: ${formatAutoHandoffRegressionValue(aggregates.weekly_ops_runtime_ui_mode_violation_runs, '0')}`);
  lines.push(`- Weekly ops runtime ui-mode violation run rate: ${formatAutoHandoffRegressionValue(aggregates.weekly_ops_runtime_ui_mode_violation_run_rate_percent)}%`);
  lines.push(`- Weekly ops runtime ui-mode violations total: ${formatAutoHandoffRegressionValue(aggregates.weekly_ops_runtime_ui_mode_violation_total, '0')}`);
  lines.push(`- Weekly ops runtime ui-mode violation rate avg/max: ${formatAutoHandoffRegressionValue(aggregates.weekly_ops_runtime_ui_mode_violation_rate_avg_percent)}/${formatAutoHandoffRegressionValue(aggregates.weekly_ops_runtime_ui_mode_violation_rate_max_percent)}%`);
  lines.push(`- Release preflight known runs: ${formatAutoHandoffRegressionValue(aggregates.release_gate_preflight_known_runs, '0')}`);
  lines.push(`- Release preflight available runs: ${formatAutoHandoffRegressionValue(aggregates.release_gate_preflight_available_runs, '0')}`);
  lines.push(`- Release preflight blocked runs: ${formatAutoHandoffRegressionValue(aggregates.release_gate_preflight_blocked_runs, '0')}`);
  lines.push(`- Release preflight hard-gate runs: ${formatAutoHandoffRegressionValue(aggregates.release_gate_preflight_hard_gate_runs, '0')}`);
  lines.push(`- Release preflight availability rate: ${formatAutoHandoffRegressionValue(aggregates.release_gate_preflight_availability_rate_percent)}%`);
  lines.push(`- Release preflight block rate: ${formatAutoHandoffRegressionValue(aggregates.release_gate_preflight_block_rate_percent)}%`);
  lines.push(`- Risk levels: low=${formatAutoHandoffRegressionValue(aggregates.risk_levels && aggregates.risk_levels.low, '0')}, medium=${formatAutoHandoffRegressionValue(aggregates.risk_levels && aggregates.risk_levels.medium, '0')}, high=${formatAutoHandoffRegressionValue(aggregates.risk_levels && aggregates.risk_levels.high, '0')}, unknown=${formatAutoHandoffRegressionValue(aggregates.risk_levels && aggregates.risk_levels.unknown, '0')}`);
  lines.push('');
  lines.push('## Recent Entries');
  lines.push('');

  if (recentEntries.length === 0) {
    lines.push('- None');
  } else {
    recentEntries.forEach(entry => {
      const tag = formatAutoHandoffRegressionValue(entry && entry.tag);
      const passed = entry && entry.gate_passed === true ? 'yes' : (entry && entry.gate_passed === false ? 'no' : 'n/a');
      const risk = formatAutoHandoffRegressionValue(entry && entry.risk_level);
      const successRate = formatAutoHandoffRegressionValue(entry && entry.spec_success_rate_percent);
      const evaluatedAt = formatAutoHandoffRegressionValue(entry && entry.evaluated_at);
      const violations = formatAutoHandoffRegressionValue(entry && entry.violations_count, '0');
      const sceneBatch = entry && entry.scene_package_batch_passed === true
        ? 'pass'
        : (entry && entry.scene_package_batch_passed === false ? 'fail' : 'n/a');
      const sceneBatchFailures = formatAutoHandoffRegressionValue(
        entry && entry.scene_package_batch_failure_count
      );
      const capabilityExpectedUnknown = formatAutoHandoffRegressionValue(
        entry && entry.capability_expected_unknown_count,
        '0'
      );
      const capabilityProvidedUnknown = formatAutoHandoffRegressionValue(
        entry && entry.capability_provided_unknown_count,
        '0'
      );
      const preflightBlocked = entry && entry.release_gate_preflight_blocked === true
        ? 'yes'
        : (entry && entry.release_gate_preflight_blocked === false ? 'no' : 'n/a');
      const preflightHardGate = entry && entry.require_release_gate_preflight === true
        ? 'enabled'
        : (entry && entry.require_release_gate_preflight === false ? 'advisory' : 'n/a');
      const driftAlerts = formatAutoHandoffRegressionValue(entry && entry.drift_alert_count, '0');
      const driftBlocked = entry && entry.drift_blocked === true
        ? 'yes'
        : (entry && entry.drift_blocked === false ? 'no' : 'n/a');
      const weeklyOpsBlocked = entry && entry.weekly_ops_blocked === true
        ? 'yes'
        : (entry && entry.weekly_ops_blocked === false ? 'no' : 'n/a');
      const weeklyOpsConfigWarnings = formatAutoHandoffRegressionValue(
        entry && entry.weekly_ops_config_warning_count,
        '0'
      );
      const weeklyOpsDialogueRate = formatAutoHandoffRegressionValue(
        entry && entry.weekly_ops_dialogue_authorization_block_rate_percent
      );
      const weeklyOpsAuthTierRate = formatAutoHandoffRegressionValue(
        entry && entry.weekly_ops_authorization_tier_block_rate_percent
      );
      const weeklyOpsRuntimeBlockRate = formatAutoHandoffRegressionValue(
        entry && entry.weekly_ops_runtime_block_rate_percent
      );
      const weeklyOpsRuntimeUiModeViolationTotal = formatAutoHandoffRegressionValue(
        entry && entry.weekly_ops_runtime_ui_mode_violation_total,
        '0'
      );
      const weeklyOpsRuntimeUiModeViolationRate = formatAutoHandoffRegressionValue(
        entry && entry.weekly_ops_runtime_ui_mode_violation_rate_percent
      );
      lines.push(
        `- ${tag} | passed=${passed} | risk=${risk} | scene-batch=${sceneBatch} | ` +
        `scene-failures=${sceneBatchFailures} | capability-unknown=${capabilityExpectedUnknown}/${capabilityProvidedUnknown} | ` +
        `preflight-blocked=${preflightBlocked} | hard-gate=${preflightHardGate} | ` +
        `drift-alerts=${driftAlerts} | drift-blocked=${driftBlocked} | ` +
        `weekly-blocked=${weeklyOpsBlocked} | weekly-config-warnings=${weeklyOpsConfigWarnings} | ` +
        `weekly-auth-tier-rate=${weeklyOpsAuthTierRate}% | weekly-dialogue-rate=${weeklyOpsDialogueRate}% | ` +
        `weekly-runtime-block-rate=${weeklyOpsRuntimeBlockRate}% | ` +
        `weekly-runtime-ui-mode=${weeklyOpsRuntimeUiModeViolationTotal}/${weeklyOpsRuntimeUiModeViolationRate}% | ` +
        `success=${successRate} | violations=${violations} | at=${evaluatedAt}`
      );
    });
  }

  if (warnings.length > 0) {
    lines.push('');
    lines.push('## Warnings');
    warnings.forEach(item => {
      lines.push('', `- ${item}`);
    });
  }

  return `${lines.join('\n')}\n`;
}

async function loadAutoHandoffReleaseEvidence(projectPath, fileCandidate = null) {
  const filePath = resolveAutoHandoffReleaseEvidenceFile(projectPath, fileCandidate);
  if (!(await fs.pathExists(filePath))) {
    throw new Error(`release evidence file not found: ${filePath}`);
  }

  let payload = null;
  try {
    payload = await fs.readJson(filePath);
  } catch (error) {
    throw new Error(`invalid release evidence JSON: ${filePath} (${error.message})`);
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error(`invalid release evidence payload: ${filePath}`);
  }

  const sessions = Array.isArray(payload.sessions)
    ? payload.sessions.filter(item => item && typeof item === 'object')
    : [];
  sessions.sort((left, right) => {
    const leftTs = Date.parse(
      left && (left.merged_at || left.generated_at || left.updated_at)
        ? (left.merged_at || left.generated_at || left.updated_at)
        : 0
    );
    const rightTs = Date.parse(
      right && (right.merged_at || right.generated_at || right.updated_at)
        ? (right.merged_at || right.generated_at || right.updated_at)
        : 0
    );
    return (Number.isFinite(rightTs) ? rightTs : 0) - (Number.isFinite(leftTs) ? leftTs : 0);
  });

  return {
    file: filePath,
    payload,
    sessions
  };
}

function buildAutoHandoffEvidenceSnapshot(entry = {}) {
  const toNumber = value => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const gate = entry && typeof entry.gate === 'object' ? entry.gate : {};
  const gateActual = gate && typeof gate.actual === 'object' ? gate.actual : {};
  const ontology = entry && typeof entry.ontology_validation === 'object'
    ? entry.ontology_validation
    : {};
  const ontologyMetrics = ontology && typeof ontology.metrics === 'object'
    ? ontology.metrics
    : {};
  const moquiBaseline = entry && typeof entry.moqui_baseline === 'object'
    ? entry.moqui_baseline
    : {};
  const moquiCompare = moquiBaseline && typeof moquiBaseline.compare === 'object'
    ? moquiBaseline.compare
    : {};
  const moquiMatrixRegressions = buildAutoHandoffMoquiCoverageRegressions(moquiCompare);
  const scenePackageBatch = entry && typeof entry.scene_package_batch === 'object'
    ? entry.scene_package_batch
    : {};
  const scenePackageBatchSummary = scenePackageBatch && typeof scenePackageBatch.summary === 'object'
    ? scenePackageBatch.summary
    : {};
  const sceneBatchStatus = normalizeHandoffText(scenePackageBatch.status);
  const sceneBatchPassed = sceneBatchStatus
    ? (sceneBatchStatus === 'skipped' ? null : sceneBatchStatus === 'passed')
    : null;
  const riskLevel = normalizeHandoffText(
    gateActual.risk_level
      || (entry && entry.regression ? entry.regression.risk_level : null)
      || 'high'
  ) || 'high';

  return {
    session_id: normalizeHandoffText(entry.session_id),
    status: normalizeHandoffText(entry.status),
    merged_at: normalizeHandoffText(entry.merged_at),
    manifest_path: normalizeHandoffText(entry.manifest_path),
    gate_passed: gate.passed === true,
    spec_success_rate_percent: toNumber(gateActual.spec_success_rate_percent),
    risk_level: `${riskLevel}`.trim().toLowerCase(),
    risk_level_rank: normalizeRiskRank(riskLevel),
    failed_goals: toNumber(entry && entry.batch_summary ? entry.batch_summary.failed_goals : null),
    elapsed_ms: null,
    ontology_quality_score: toNumber(
      gateActual.ontology_quality_score !== undefined
        ? gateActual.ontology_quality_score
        : ontology.quality_score
    ),
    ontology_unmapped_rules: toNumber(
      gateActual.ontology_business_rule_unmapped !== undefined
        ? gateActual.ontology_business_rule_unmapped
        : ontologyMetrics.business_rule_unmapped
    ),
    ontology_undecided_decisions: toNumber(
      gateActual.ontology_decision_undecided !== undefined
        ? gateActual.ontology_decision_undecided
        : ontologyMetrics.decision_undecided
    ),
    ontology_business_rule_pass_rate_percent: toNumber(ontologyMetrics.business_rule_pass_rate_percent),
    ontology_decision_resolved_rate_percent: toNumber(ontologyMetrics.decision_resolved_rate_percent),
    scene_package_batch_status: sceneBatchStatus,
    scene_package_batch_passed: typeof sceneBatchPassed === 'boolean' ? sceneBatchPassed : null,
    scene_package_batch_failure_count: toNumber(
      scenePackageBatchSummary.batch_gate_failure_count !== undefined
        ? scenePackageBatchSummary.batch_gate_failure_count
        : scenePackageBatchSummary.failed
    ),
    capability_coverage_percent: toNumber(
      entry &&
      entry.capability_coverage &&
      entry.capability_coverage.summary
        ? entry.capability_coverage.summary.coverage_percent
        : null
    ),
    capability_coverage_passed: Boolean(
      entry &&
      entry.capability_coverage &&
      entry.capability_coverage.summary &&
      entry.capability_coverage.summary.passed === true
    ),
    moqui_matrix_regression_count: moquiMatrixRegressions.length,
    generated_at: normalizeHandoffText(entry.merged_at)
  };
}

function buildAutoHandoffEvidenceStatusCounts(entries = []) {
  const counts = {
    completed: 0,
    failed: 0,
    dry_run: 0,
    running: 0,
    other: 0
  };
  entries.forEach(entry => {
    const status = `${entry && entry.status ? entry.status : ''}`.trim().toLowerCase();
    if (status === 'completed') {
      counts.completed += 1;
    } else if (status === 'failed') {
      counts.failed += 1;
    } else if (status === 'dry-run' || status === 'dry_run') {
      counts.dry_run += 1;
    } else if (status === 'running') {
      counts.running += 1;
    } else {
      counts.other += 1;
    }
  });
  return counts;
}

function renderAutoHandoffEvidenceReviewMarkdown(payload = {}) {
  const current = payload.current || {};
  const currentOverview = payload.current_overview || {};
  const gate = currentOverview.gate && typeof currentOverview.gate === 'object'
    ? currentOverview.gate
    : {};
  const gateActual = gate && gate.actual && typeof gate.actual === 'object'
    ? gate.actual
    : {};
  const releaseGatePreflight = currentOverview.release_gate_preflight && typeof currentOverview.release_gate_preflight === 'object'
    ? currentOverview.release_gate_preflight
    : {};
  const failureSummary = currentOverview.failure_summary && typeof currentOverview.failure_summary === 'object'
    ? currentOverview.failure_summary
    : {};
  const currentPolicy = currentOverview.policy && typeof currentOverview.policy === 'object'
    ? currentOverview.policy
    : {};
  const ontology = currentOverview.ontology_validation && typeof currentOverview.ontology_validation === 'object'
    ? currentOverview.ontology_validation
    : {};
  const ontologyMetrics = ontology && ontology.metrics && typeof ontology.metrics === 'object'
    ? ontology.metrics
    : {};
  const regression = currentOverview.regression && typeof currentOverview.regression === 'object'
    ? currentOverview.regression
    : {};
  const moquiBaseline = currentOverview.moqui_baseline && typeof currentOverview.moqui_baseline === 'object'
    ? currentOverview.moqui_baseline
    : {};
  const moquiSummary = moquiBaseline && moquiBaseline.summary && typeof moquiBaseline.summary === 'object'
    ? moquiBaseline.summary
    : {};
  const moquiScopeBreakdown = moquiSummary && moquiSummary.scope_breakdown && typeof moquiSummary.scope_breakdown === 'object'
    ? moquiSummary.scope_breakdown
    : {};
  const moquiGapFrequency = Array.isArray(moquiSummary && moquiSummary.gap_frequency)
    ? moquiSummary.gap_frequency
    : [];
  const moquiCompare = moquiBaseline && moquiBaseline.compare && typeof moquiBaseline.compare === 'object'
    ? moquiBaseline.compare
    : {};
  const moquiMatrixRegressions = buildAutoHandoffMoquiCoverageRegressions(moquiCompare);
  const moquiDeltas = moquiCompare && moquiCompare.deltas && typeof moquiCompare.deltas === 'object'
    ? moquiCompare.deltas
    : {};
  const moquiFailedTemplates = moquiCompare && moquiCompare.failed_templates && typeof moquiCompare.failed_templates === 'object'
    ? moquiCompare.failed_templates
    : {};
  const scenePackageBatch = currentOverview.scene_package_batch && typeof currentOverview.scene_package_batch === 'object'
    ? currentOverview.scene_package_batch
    : {};
  const scenePackageBatchSummary = scenePackageBatch && scenePackageBatch.summary && typeof scenePackageBatch.summary === 'object'
    ? scenePackageBatch.summary
    : {};
  const scenePackageBatchGate = scenePackageBatch && scenePackageBatch.batch_ontology_gate && typeof scenePackageBatch.batch_ontology_gate === 'object'
    ? scenePackageBatch.batch_ontology_gate
    : {};
  const scenePackageBatchFailures = Array.isArray(scenePackageBatchGate.failures)
    ? scenePackageBatchGate.failures
    : [];
  const capabilityCoverage = currentOverview.capability_coverage && typeof currentOverview.capability_coverage === 'object'
    ? currentOverview.capability_coverage
    : {};
  const capabilitySummary = capabilityCoverage && capabilityCoverage.summary && typeof capabilityCoverage.summary === 'object'
    ? capabilityCoverage.summary
    : {};
  const capabilityCompare = capabilityCoverage && capabilityCoverage.compare && typeof capabilityCoverage.compare === 'object'
    ? capabilityCoverage.compare
    : {};
  const capabilityGaps = Array.isArray(capabilityCoverage && capabilityCoverage.gaps)
    ? capabilityCoverage.gaps
    : [];
  const capabilityNormalization = capabilityCoverage && capabilityCoverage.normalization && typeof capabilityCoverage.normalization === 'object'
    ? capabilityCoverage.normalization
    : {};
  const capabilityWarnings = Array.isArray(capabilityCoverage && capabilityCoverage.warnings)
    ? capabilityCoverage.warnings
    : [];
  const window = payload.window || { requested: 5, actual: 0 };
  const series = Array.isArray(payload.series) ? payload.series : [];
  const riskLayers = payload.risk_layers && typeof payload.risk_layers === 'object'
    ? payload.risk_layers
    : {};
  const recommendations = Array.isArray(payload.recommendations) ? payload.recommendations : [];
  const governanceSnapshot = payload.governance_snapshot && typeof payload.governance_snapshot === 'object'
    ? payload.governance_snapshot
    : null;
  const governanceHealth = governanceSnapshot && governanceSnapshot.health &&
    typeof governanceSnapshot.health === 'object'
    ? governanceSnapshot.health
    : {};
  const governanceReleaseGate = governanceHealth.release_gate && typeof governanceHealth.release_gate === 'object'
    ? governanceHealth.release_gate
    : {};
  const governanceHandoffQuality = governanceHealth.handoff_quality && typeof governanceHealth.handoff_quality === 'object'
    ? governanceHealth.handoff_quality
    : {};
  const trendSeriesLines = series.length > 0
    ? series.map(item => {
      const sessionId = formatAutoHandoffRegressionValue(item.session_id);
      const mergedAt = formatAutoHandoffRegressionValue(item.merged_at || item.generated_at);
      const riskLevel = formatAutoHandoffRegressionValue(item.risk_level);
      const failedGoals = formatAutoHandoffRegressionValue(item.failed_goals);
      const sceneBatch = item.scene_package_batch_passed === null || item.scene_package_batch_passed === undefined
        ? 'n/a'
        : (item.scene_package_batch_passed ? 'pass' : 'fail');
      const successBar = renderAutoHandoffRegressionAsciiBar(item.spec_success_rate_percent, 100, 20);
      const ontologyBar = renderAutoHandoffRegressionAsciiBar(item.ontology_quality_score, 100, 20);
      const capabilityBar = renderAutoHandoffRegressionAsciiBar(item.capability_coverage_percent, 100, 20);
      return (
        `- ${sessionId} | ${mergedAt} | risk=${riskLevel} | failed=${failedGoals} | scene-batch=${sceneBatch} | ` +
        `success=${successBar} | ontology=${ontologyBar} | capability=${capabilityBar}`
      );
    })
    : ['- None'];
  const riskLayerLines = ['low', 'medium', 'high', 'unknown'].map(level => {
    const scoped = riskLayers[level] && typeof riskLayers[level] === 'object'
      ? riskLayers[level]
      : {};
    return (
      `- ${level}: count=${formatAutoHandoffRegressionValue(scoped.count, '0')}, ` +
      `avg_success=${formatAutoHandoffRegressionValue(scoped.avg_spec_success_rate_percent)}, ` +
      `avg_failed_goals=${formatAutoHandoffRegressionValue(scoped.avg_failed_goals)}, ` +
      `avg_ontology_quality=${formatAutoHandoffRegressionValue(scoped.avg_ontology_quality_score)}, ` +
      `scene_batch_pass_rate=${formatAutoHandoffRegressionValue(scoped.scene_package_batch_pass_rate_percent)}%, ` +
      `avg_moqui_matrix_regressions=${formatAutoHandoffRegressionValue(scoped.avg_moqui_matrix_regression_count, '0')}`
    );
  });

  const lines = [
    '# Auto Handoff Release Evidence Review',
    '',
    `- Evidence file: ${formatAutoHandoffRegressionValue(payload.evidence_file)}`,
    `- Session: ${formatAutoHandoffRegressionValue(current.session_id)}`,
    `- Status: ${formatAutoHandoffRegressionValue(current.status)}`,
    `- Trend: ${formatAutoHandoffRegressionValue(payload.trend)}`,
    `- Window: ${formatAutoHandoffRegressionValue(window.actual)}/${formatAutoHandoffRegressionValue(window.requested)}`,
    '',
    '## Current Gate',
    '',
    `- Passed: ${gate.passed === true ? 'yes' : 'no'}`,
    `- Spec success rate: ${formatAutoHandoffRegressionValue(gateActual.spec_success_rate_percent)}`,
    `- Risk level: ${formatAutoHandoffRegressionValue(gateActual.risk_level)}`,
    `- Ontology quality score: ${formatAutoHandoffRegressionValue(gateActual.ontology_quality_score)}`,
    `- Unmapped business rules: ${formatAutoHandoffRegressionValue(gateActual.ontology_business_rule_unmapped)}`,
    `- Undecided decisions: ${formatAutoHandoffRegressionValue(gateActual.ontology_decision_undecided)}`,
    '',
    '## Current Release Gate Preflight',
    '',
    `- Available: ${releaseGatePreflight.available === true ? 'yes' : 'no'}`,
    `- Blocked: ${releaseGatePreflight.blocked === true ? 'yes' : 'no'}`,
    `- Latest tag: ${formatAutoHandoffRegressionValue(releaseGatePreflight.latest_tag)}`,
    `- Latest gate passed: ${releaseGatePreflight.latest_gate_passed === true ? 'yes' : (releaseGatePreflight.latest_gate_passed === false ? 'no' : 'n/a')}`,
    `- Pass rate: ${formatAutoHandoffRegressionValue(releaseGatePreflight.pass_rate_percent)}%`,
    `- Scene batch pass rate: ${formatAutoHandoffRegressionValue(releaseGatePreflight.scene_package_batch_pass_rate_percent)}%`,
    `- Drift alert rate: ${formatAutoHandoffRegressionValue(releaseGatePreflight.drift_alert_rate_percent)}%`,
    `- Drift blocked runs: ${formatAutoHandoffRegressionValue(releaseGatePreflight.drift_blocked_runs)}`,
    `- Runtime block rate (latest/max): ${formatAutoHandoffRegressionValue(releaseGatePreflight.latest_weekly_ops_runtime_block_rate_percent)}/${formatAutoHandoffRegressionValue(releaseGatePreflight.weekly_ops_runtime_block_rate_max_percent)}%`,
    `- Runtime ui-mode violations (latest/total): ${formatAutoHandoffRegressionValue(releaseGatePreflight.latest_weekly_ops_runtime_ui_mode_violation_total, '0')}/${formatAutoHandoffRegressionValue(releaseGatePreflight.weekly_ops_runtime_ui_mode_violation_total, '0')}`,
    `- Runtime ui-mode violation rate (latest/run-rate/max): ${formatAutoHandoffRegressionValue(releaseGatePreflight.latest_weekly_ops_runtime_ui_mode_violation_rate_percent)}/${formatAutoHandoffRegressionValue(releaseGatePreflight.weekly_ops_runtime_ui_mode_violation_run_rate_percent)}/${formatAutoHandoffRegressionValue(releaseGatePreflight.weekly_ops_runtime_ui_mode_violation_rate_max_percent)}%`,
    `- Reasons: ${Array.isArray(releaseGatePreflight.reasons) && releaseGatePreflight.reasons.length > 0 ? releaseGatePreflight.reasons.join(' | ') : 'none'}`,
    `- Parse error: ${formatAutoHandoffRegressionValue(releaseGatePreflight.parse_error)}`,
    '',
    '## Current Failure Summary',
    '',
    `- Failed phase: ${formatAutoHandoffRegressionValue(failureSummary.failed_phase && failureSummary.failed_phase.id)}`,
    `- Gate failed: ${failureSummary.gate_failed === true ? 'yes' : 'no'}`,
    `- Release gate preflight blocked: ${failureSummary.release_gate_preflight_blocked === true ? 'yes' : 'no'}`,
    `- Highlights: ${Array.isArray(failureSummary.highlights) && failureSummary.highlights.length > 0 ? failureSummary.highlights.join(' | ') : 'none'}`,
    '',
    '## Current Ontology',
    '',
    `- Status: ${formatAutoHandoffRegressionValue(ontology.status)}`,
    `- Passed: ${ontology.passed === true ? 'yes' : 'no'}`,
    `- Quality score: ${formatAutoHandoffRegressionValue(ontology.quality_score)}`,
    `- Entity total: ${formatAutoHandoffRegressionValue(ontologyMetrics.entity_total)}`,
    `- Relation total: ${formatAutoHandoffRegressionValue(ontologyMetrics.relation_total)}`,
    `- Business rule unmapped: ${formatAutoHandoffRegressionValue(ontologyMetrics.business_rule_unmapped)}`,
    `- Decision undecided: ${formatAutoHandoffRegressionValue(ontologyMetrics.decision_undecided)}`,
    '',
    '## Current Regression',
    '',
    `- Trend: ${formatAutoHandoffRegressionValue(regression.trend)}`,
    `- Delta success rate: ${formatAutoHandoffRegressionValue(regression.delta && regression.delta.spec_success_rate_percent)}`,
    `- Delta risk rank: ${formatAutoHandoffRegressionValue(regression.delta && regression.delta.risk_level_rank)}`,
    `- Delta failed goals: ${formatAutoHandoffRegressionValue(regression.delta && regression.delta.failed_goals)}`,
    '',
    '## Current Moqui Baseline',
    '',
    `- Status: ${formatAutoHandoffRegressionValue(moquiBaseline.status)}`,
    `- Portfolio passed: ${moquiSummary.portfolio_passed === true ? 'yes' : (moquiSummary.portfolio_passed === false ? 'no' : 'n/a')}`,
    `- Avg score: ${formatAutoHandoffRegressionValue(moquiSummary.avg_score)}`,
    `- Valid-rate: ${formatAutoHandoffRegressionValue(moquiSummary.valid_rate_percent)}%`,
    `- Baseline failed templates: ${formatAutoHandoffRegressionValue(moquiSummary.baseline_failed)}`,
    `- Matrix regression count: ${formatAutoHandoffRegressionValue(moquiMatrixRegressions.length, '0')}`,
    `- Matrix regression gate (max): ${formatAutoHandoffRegressionValue(currentPolicy.max_moqui_matrix_regressions)}`,
    `- Scope mix (moqui/suite/other): ${formatAutoHandoffRegressionValue(moquiScopeBreakdown.moqui_erp, '0')}/${formatAutoHandoffRegressionValue(moquiScopeBreakdown.scene_orchestration, '0')}/${formatAutoHandoffRegressionValue(moquiScopeBreakdown.other, '0')}`,
    `- Entity coverage: ${formatAutoHandoffMoquiCoverageMetric(moquiSummary, 'entity_coverage', 'rate_percent', '%')}`,
    `- Relation coverage: ${formatAutoHandoffMoquiCoverageMetric(moquiSummary, 'relation_coverage', 'rate_percent', '%')}`,
    `- Business-rule coverage: ${formatAutoHandoffMoquiCoverageMetric(moquiSummary, 'business_rule_coverage', 'rate_percent', '%')}`,
    `- Business-rule closed: ${formatAutoHandoffMoquiCoverageMetric(moquiSummary, 'business_rule_closed', 'rate_percent', '%')}`,
    `- Decision coverage: ${formatAutoHandoffMoquiCoverageMetric(moquiSummary, 'decision_coverage', 'rate_percent', '%')}`,
    `- Decision closed: ${formatAutoHandoffMoquiCoverageMetric(moquiSummary, 'decision_closed', 'rate_percent', '%')}`,
    `- Delta avg score: ${formatAutoHandoffRegressionValue(moquiDeltas.avg_score)}`,
    `- Delta valid-rate: ${formatAutoHandoffRegressionValue(moquiDeltas.valid_rate_percent)}%`,
    `- Delta entity coverage: ${formatAutoHandoffMoquiCoverageDeltaMetric(moquiCompare, 'entity_coverage', 'rate_percent', '%')}`,
    `- Delta business-rule closed: ${formatAutoHandoffMoquiCoverageDeltaMetric(moquiCompare, 'business_rule_closed', 'rate_percent', '%')}`,
    `- Delta decision closed: ${formatAutoHandoffMoquiCoverageDeltaMetric(moquiCompare, 'decision_closed', 'rate_percent', '%')}`,
    `- Matrix regressions: ${formatAutoHandoffMoquiCoverageRegressions(moquiCompare, 5)}`,
    `- Newly failed templates: ${Array.isArray(moquiFailedTemplates.newly_failed) && moquiFailedTemplates.newly_failed.length > 0 ? moquiFailedTemplates.newly_failed.join(', ') : 'none'}`,
    `- Recovered templates: ${Array.isArray(moquiFailedTemplates.recovered) && moquiFailedTemplates.recovered.length > 0 ? moquiFailedTemplates.recovered.join(', ') : 'none'}`,
    `- Top baseline gaps: ${moquiGapFrequency.length > 0 ? moquiGapFrequency.slice(0, 3).map(item => `${item.gap}:${item.count}`).join(' | ') : 'none'}`,
    `- Baseline JSON: ${formatAutoHandoffRegressionValue(moquiBaseline.output && moquiBaseline.output.json)}`,
    '',
    '## Current Scene Package Batch',
    '',
    `- Status: ${formatAutoHandoffRegressionValue(scenePackageBatch.status)}`,
    `- Generated: ${scenePackageBatch.generated === true ? 'yes' : 'no'}`,
    `- Selected specs: ${formatAutoHandoffRegressionValue(scenePackageBatchSummary.selected)}`,
    `- Failed specs: ${formatAutoHandoffRegressionValue(scenePackageBatchSummary.failed)}`,
    `- Batch gate passed: ${scenePackageBatchSummary.batch_gate_passed === true ? 'yes' : (scenePackageBatchSummary.batch_gate_passed === false ? 'no' : 'n/a')}`,
    `- Batch gate failure count: ${formatAutoHandoffRegressionValue(scenePackageBatchSummary.batch_gate_failure_count)}`,
    `- Ontology average score: ${formatAutoHandoffRegressionValue(scenePackageBatchSummary.ontology_average_score)}`,
    `- Ontology valid-rate: ${formatAutoHandoffRegressionValue(scenePackageBatchSummary.ontology_valid_rate_percent)}%`,
    `- Batch gate failures: ${scenePackageBatchFailures.length > 0 ? scenePackageBatchFailures.map(item => item && item.message ? item.message : '').filter(Boolean).join(' | ') : 'none'}`,
    `- Scene batch JSON: ${formatAutoHandoffRegressionValue(scenePackageBatch.output && scenePackageBatch.output.json)}`,
    '',
    '## Current Capability Coverage',
    '',
    `- Status: ${formatAutoHandoffRegressionValue(capabilityCoverage.status)}`,
    `- Passed: ${capabilitySummary.passed === true ? 'yes' : (capabilitySummary.passed === false ? 'no' : 'n/a')}`,
    `- Coverage: ${formatAutoHandoffRegressionValue(capabilitySummary.coverage_percent)}%`,
    `- Min required: ${formatAutoHandoffRegressionValue(capabilitySummary.min_required_percent)}%`,
    `- Covered capabilities: ${formatAutoHandoffRegressionValue(capabilitySummary.covered_capabilities)}`,
    `- Uncovered capabilities: ${formatAutoHandoffRegressionValue(capabilitySummary.uncovered_capabilities)}`,
    `- Delta coverage: ${formatAutoHandoffRegressionValue(capabilityCompare.delta_coverage_percent)}%`,
    `- Delta covered capabilities: ${formatAutoHandoffRegressionValue(capabilityCompare.delta_covered_capabilities)}`,
    `- Newly covered: ${Array.isArray(capabilityCompare.newly_covered) && capabilityCompare.newly_covered.length > 0 ? capabilityCompare.newly_covered.join(', ') : 'none'}`,
    `- Newly uncovered: ${Array.isArray(capabilityCompare.newly_uncovered) && capabilityCompare.newly_uncovered.length > 0 ? capabilityCompare.newly_uncovered.join(', ') : 'none'}`,
    `- Lexicon version: ${formatAutoHandoffRegressionValue(capabilityNormalization.lexicon_version)}`,
    `- Expected alias mapped: ${formatAutoHandoffRegressionValue(Array.isArray(capabilityNormalization.expected_alias_mapped) ? capabilityNormalization.expected_alias_mapped.length : 0)}`,
    `- Expected deprecated alias: ${formatAutoHandoffRegressionValue(Array.isArray(capabilityNormalization.expected_deprecated_aliases) ? capabilityNormalization.expected_deprecated_aliases.length : 0)}`,
    `- Expected unknown: ${formatAutoHandoffRegressionValue(Array.isArray(capabilityNormalization.expected_unknown) ? capabilityNormalization.expected_unknown.length : 0)}`,
    `- Provided alias mapped: ${formatAutoHandoffRegressionValue(Array.isArray(capabilityNormalization.provided_alias_mapped) ? capabilityNormalization.provided_alias_mapped.length : 0)}`,
    `- Provided deprecated alias: ${formatAutoHandoffRegressionValue(Array.isArray(capabilityNormalization.provided_deprecated_aliases) ? capabilityNormalization.provided_deprecated_aliases.length : 0)}`,
    `- Provided unknown: ${formatAutoHandoffRegressionValue(Array.isArray(capabilityNormalization.provided_unknown) ? capabilityNormalization.provided_unknown.length : 0)}`,
    `- Capability gaps: ${capabilityGaps.length > 0 ? capabilityGaps.join(', ') : 'none'}`,
    `- Coverage warnings: ${capabilityWarnings.length > 0 ? capabilityWarnings.join(' | ') : 'none'}`,
    `- Coverage JSON: ${formatAutoHandoffRegressionValue(capabilityCoverage.output && capabilityCoverage.output.json)}`,
    '',
    '## Trend Series',
    '',
    ...trendSeriesLines,
    '',
    '## Risk Layer View',
    '',
    ...riskLayerLines,
    '',
    '## Governance Snapshot',
    '',
    `- Risk level: ${formatAutoHandoffRegressionValue(governanceHealth.risk_level)}`,
    `- Concern count: ${formatAutoHandoffRegressionValue(Array.isArray(governanceHealth.concerns) ? governanceHealth.concerns.length : 0, '0')}`,
    `- Recommendation count: ${formatAutoHandoffRegressionValue(Array.isArray(governanceHealth.recommendations) ? governanceHealth.recommendations.length : 0, '0')}`,
    `- Release gate available: ${governanceReleaseGate.available === true ? 'yes' : 'no'}`,
    `- Release gate latest passed: ${governanceReleaseGate.latest_gate_passed === true ? 'yes' : (governanceReleaseGate.latest_gate_passed === false ? 'no' : 'n/a')}`,
    `- Handoff quality available: ${governanceHandoffQuality.available === true ? 'yes' : 'no'}`,
    `- Handoff latest status: ${formatAutoHandoffRegressionValue(governanceHandoffQuality.latest_status)}`,
    `- Handoff latest gate passed: ${governanceHandoffQuality.latest_gate_passed === true ? 'yes' : (governanceHandoffQuality.latest_gate_passed === false ? 'no' : 'n/a')}`,
    `- Handoff latest ontology score: ${formatAutoHandoffRegressionValue(governanceHandoffQuality.latest_ontology_quality_score)}`,
    '',
    '## Recommendations'
  ];

  if (recommendations.length === 0) {
    lines.push('', '- None');
  } else {
    recommendations.forEach(item => {
      lines.push('', `- ${item}`);
    });
  }

  return `${lines.join('\n')}\n`;
}

function normalizeHandoffReleaseDate(dateCandidate) {
  const fallbackDate = new Date().toISOString().slice(0, 10);
  if (dateCandidate === undefined || dateCandidate === null || `${dateCandidate}`.trim().length === 0) {
    return fallbackDate;
  }
  const normalized = `${dateCandidate}`.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error('--release-date must be in YYYY-MM-DD format.');
  }
  const parsed = Date.parse(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) {
    throw new Error('--release-date must be a valid calendar date.');
  }
  return normalized;
}

function normalizeHandoffReleaseVersion(versionCandidate, fallbackVersion) {
  const fallback = typeof fallbackVersion === 'string' && fallbackVersion.trim()
    ? fallbackVersion.trim()
    : '0.0.0';
  const normalized = versionCandidate === undefined || versionCandidate === null || `${versionCandidate}`.trim().length === 0
    ? fallback
    : `${versionCandidate}`.trim();
  return normalized.startsWith('v') ? normalized : `v${normalized}`;
}

function toPortablePath(projectPath, absolutePath) {
  const relative = path.relative(projectPath, absolutePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return absolutePath;
}

async function resolveAutoHandoffReleaseDraftContext(projectPath, options = {}) {
  let packageVersion = null;
  try {
    const packagePayload = await fs.readJson(path.join(projectPath, 'package.json'));
    if (packagePayload && typeof packagePayload.version === 'string' && packagePayload.version.trim()) {
      packageVersion = packagePayload.version.trim();
    }
  } catch (error) {
    packageVersion = null;
  }

  return {
    version: normalizeHandoffReleaseVersion(options.releaseVersion, packageVersion || '0.0.0'),
    releaseDate: normalizeHandoffReleaseDate(options.releaseDate)
  };
}

function renderAutoHandoffReleaseNotesDraft(payload = {}, context = {}) {
  const current = payload.current || {};
  const currentOverview = payload.current_overview || {};
  const gate = currentOverview.gate && typeof currentOverview.gate === 'object'
    ? currentOverview.gate
    : {};
  const gateActual = gate && gate.actual && typeof gate.actual === 'object'
    ? gate.actual
    : {};
  const releaseGatePreflight = currentOverview.release_gate_preflight && typeof currentOverview.release_gate_preflight === 'object'
    ? currentOverview.release_gate_preflight
    : {};
  const failureSummary = currentOverview.failure_summary && typeof currentOverview.failure_summary === 'object'
    ? currentOverview.failure_summary
    : {};
  const currentPolicy = currentOverview.policy && typeof currentOverview.policy === 'object'
    ? currentOverview.policy
    : {};
  const ontology = currentOverview.ontology_validation && typeof currentOverview.ontology_validation === 'object'
    ? currentOverview.ontology_validation
    : {};
  const ontologyMetrics = ontology && ontology.metrics && typeof ontology.metrics === 'object'
    ? ontology.metrics
    : {};
  const regression = currentOverview.regression && typeof currentOverview.regression === 'object'
    ? currentOverview.regression
    : {};
  const moquiBaseline = currentOverview.moqui_baseline && typeof currentOverview.moqui_baseline === 'object'
    ? currentOverview.moqui_baseline
    : {};
  const moquiSummary = moquiBaseline && moquiBaseline.summary && typeof moquiBaseline.summary === 'object'
    ? moquiBaseline.summary
    : {};
  const moquiScopeBreakdown = moquiSummary && moquiSummary.scope_breakdown && typeof moquiSummary.scope_breakdown === 'object'
    ? moquiSummary.scope_breakdown
    : {};
  const moquiGapFrequency = Array.isArray(moquiSummary && moquiSummary.gap_frequency)
    ? moquiSummary.gap_frequency
    : [];
  const moquiCompare = moquiBaseline && moquiBaseline.compare && typeof moquiBaseline.compare === 'object'
    ? moquiBaseline.compare
    : {};
  const moquiMatrixRegressions = buildAutoHandoffMoquiCoverageRegressions(moquiCompare);
  const moquiDeltas = moquiCompare && moquiCompare.deltas && typeof moquiCompare.deltas === 'object'
    ? moquiCompare.deltas
    : {};
  const moquiFailedTemplates = moquiCompare && moquiCompare.failed_templates && typeof moquiCompare.failed_templates === 'object'
    ? moquiCompare.failed_templates
    : {};
  const scenePackageBatch = currentOverview.scene_package_batch && typeof currentOverview.scene_package_batch === 'object'
    ? currentOverview.scene_package_batch
    : {};
  const scenePackageBatchSummary = scenePackageBatch && scenePackageBatch.summary && typeof scenePackageBatch.summary === 'object'
    ? scenePackageBatch.summary
    : {};
  const scenePackageBatchGate = scenePackageBatch && scenePackageBatch.batch_ontology_gate && typeof scenePackageBatch.batch_ontology_gate === 'object'
    ? scenePackageBatch.batch_ontology_gate
    : {};
  const scenePackageBatchFailures = Array.isArray(scenePackageBatchGate.failures)
    ? scenePackageBatchGate.failures
    : [];
  const capabilityCoverage = currentOverview.capability_coverage && typeof currentOverview.capability_coverage === 'object'
    ? currentOverview.capability_coverage
    : {};
  const capabilitySummary = capabilityCoverage && capabilityCoverage.summary && typeof capabilityCoverage.summary === 'object'
    ? capabilityCoverage.summary
    : {};
  const capabilityCompare = capabilityCoverage && capabilityCoverage.compare && typeof capabilityCoverage.compare === 'object'
    ? capabilityCoverage.compare
    : {};
  const capabilityGaps = Array.isArray(capabilityCoverage && capabilityCoverage.gaps)
    ? capabilityCoverage.gaps
    : [];
  const capabilityNormalization = capabilityCoverage && capabilityCoverage.normalization && typeof capabilityCoverage.normalization === 'object'
    ? capabilityCoverage.normalization
    : {};
  const capabilityWarnings = Array.isArray(capabilityCoverage && capabilityCoverage.warnings)
    ? capabilityCoverage.warnings
    : [];
  const riskLayers = payload.risk_layers && typeof payload.risk_layers === 'object'
    ? payload.risk_layers
    : {};
  const statusCounts = payload.aggregates && payload.aggregates.status_counts
    ? payload.aggregates.status_counts
    : {};
  const recommendations = Array.isArray(payload.recommendations) ? payload.recommendations : [];
  const governanceSnapshot = payload.governance_snapshot && typeof payload.governance_snapshot === 'object'
    ? payload.governance_snapshot
    : null;
  const governanceHealth = governanceSnapshot && governanceSnapshot.health &&
    typeof governanceSnapshot.health === 'object'
    ? governanceSnapshot.health
    : {};
  const governanceReleaseGate = governanceHealth.release_gate && typeof governanceHealth.release_gate === 'object'
    ? governanceHealth.release_gate
    : {};
  const governanceHandoffQuality = governanceHealth.handoff_quality && typeof governanceHealth.handoff_quality === 'object'
    ? governanceHealth.handoff_quality
    : {};
  const reviewFile = typeof context.reviewFile === 'string' && context.reviewFile.trim()
    ? context.reviewFile.trim()
    : null;
  const version = normalizeHandoffReleaseVersion(context.version, '0.0.0');
  const releaseDate = normalizeHandoffReleaseDate(context.releaseDate);

  const riskLines = ['low', 'medium', 'high', 'unknown'].map(level => {
    const scoped = riskLayers[level] && typeof riskLayers[level] === 'object'
      ? riskLayers[level]
      : {};
    return (
      `- ${level}: count=${formatAutoHandoffRegressionValue(scoped.count, '0')}, ` +
      `avg_success=${formatAutoHandoffRegressionValue(scoped.avg_spec_success_rate_percent)}, ` +
      `avg_failed_goals=${formatAutoHandoffRegressionValue(scoped.avg_failed_goals)}, ` +
      `avg_ontology_quality=${formatAutoHandoffRegressionValue(scoped.avg_ontology_quality_score)}, ` +
      `avg_moqui_matrix_regressions=${formatAutoHandoffRegressionValue(scoped.avg_moqui_matrix_regression_count, '0')}`
    );
  });

  const lines = [
    `# Release Notes Draft: ${version}`,
    '',
    `Release date: ${releaseDate}`,
    '',
    '## Handoff Evidence Summary',
    '',
    `- Evidence file: ${formatAutoHandoffRegressionValue(payload.evidence_file)}`,
    `- Current session: ${formatAutoHandoffRegressionValue(current.session_id)}`,
    `- Current status: ${formatAutoHandoffRegressionValue(current.status)}`,
    `- Gate passed: ${gate.passed === true ? 'yes' : 'no'}`,
    `- Release gate preflight available: ${releaseGatePreflight.available === true ? 'yes' : 'no'}`,
    `- Release gate preflight blocked: ${releaseGatePreflight.blocked === true ? 'yes' : 'no'}`,
    `- Release gate preflight hard-gate: ${currentPolicy.require_release_gate_preflight === true ? 'enabled' : 'advisory'}`,
    `- Release gate preflight reasons: ${Array.isArray(releaseGatePreflight.reasons) && releaseGatePreflight.reasons.length > 0 ? releaseGatePreflight.reasons.join(' | ') : 'none'}`,
    `- Release gate runtime block rate (latest/max): ${formatAutoHandoffRegressionValue(releaseGatePreflight.latest_weekly_ops_runtime_block_rate_percent)}/${formatAutoHandoffRegressionValue(releaseGatePreflight.weekly_ops_runtime_block_rate_max_percent)}%`,
    `- Release gate runtime ui-mode violations (latest/total): ${formatAutoHandoffRegressionValue(releaseGatePreflight.latest_weekly_ops_runtime_ui_mode_violation_total, '0')}/${formatAutoHandoffRegressionValue(releaseGatePreflight.weekly_ops_runtime_ui_mode_violation_total, '0')}`,
    `- Release gate runtime ui-mode violation rate (latest/run-rate/max): ${formatAutoHandoffRegressionValue(releaseGatePreflight.latest_weekly_ops_runtime_ui_mode_violation_rate_percent)}/${formatAutoHandoffRegressionValue(releaseGatePreflight.weekly_ops_runtime_ui_mode_violation_run_rate_percent)}/${formatAutoHandoffRegressionValue(releaseGatePreflight.weekly_ops_runtime_ui_mode_violation_rate_max_percent)}%`,
    `- Failure summary highlights: ${Array.isArray(failureSummary.highlights) && failureSummary.highlights.length > 0 ? failureSummary.highlights.join(' | ') : 'none'}`,
    `- Spec success rate: ${formatAutoHandoffRegressionValue(gateActual.spec_success_rate_percent)}`,
    `- Risk level: ${formatAutoHandoffRegressionValue(gateActual.risk_level)}`,
    `- Ontology quality score: ${formatAutoHandoffRegressionValue(gateActual.ontology_quality_score)}`,
    `- Ontology unmapped rules: ${formatAutoHandoffRegressionValue(gateActual.ontology_business_rule_unmapped, formatAutoHandoffRegressionValue(ontologyMetrics.business_rule_unmapped))}`,
    `- Ontology undecided decisions: ${formatAutoHandoffRegressionValue(gateActual.ontology_decision_undecided, formatAutoHandoffRegressionValue(ontologyMetrics.decision_undecided))}`,
    `- Regression trend: ${formatAutoHandoffRegressionValue(regression.trend, formatAutoHandoffRegressionValue(payload.trend))}`,
    `- Window trend: ${formatAutoHandoffRegressionValue(payload.window_trend && payload.window_trend.trend)}`,
    `- Gate pass rate (window): ${formatAutoHandoffRegressionValue(payload.aggregates && payload.aggregates.gate_pass_rate_percent)}%`,
    `- Moqui baseline portfolio passed: ${moquiSummary.portfolio_passed === true ? 'yes' : (moquiSummary.portfolio_passed === false ? 'no' : 'n/a')}`,
    `- Moqui baseline avg score: ${formatAutoHandoffRegressionValue(moquiSummary.avg_score)}`,
    `- Moqui baseline valid-rate: ${formatAutoHandoffRegressionValue(moquiSummary.valid_rate_percent)}%`,
    `- Moqui baseline failed templates: ${formatAutoHandoffRegressionValue(moquiSummary.baseline_failed)}`,
    `- Moqui matrix regression count: ${formatAutoHandoffRegressionValue(moquiMatrixRegressions.length, '0')}`,
    `- Moqui matrix regression gate (max): ${formatAutoHandoffRegressionValue(currentPolicy.max_moqui_matrix_regressions)}`,
    `- Moqui scope mix (moqui/suite/other): ${formatAutoHandoffRegressionValue(moquiScopeBreakdown.moqui_erp, '0')}/${formatAutoHandoffRegressionValue(moquiScopeBreakdown.scene_orchestration, '0')}/${formatAutoHandoffRegressionValue(moquiScopeBreakdown.other, '0')}`,
    `- Moqui entity coverage: ${formatAutoHandoffMoquiCoverageMetric(moquiSummary, 'entity_coverage', 'rate_percent', '%')}`,
    `- Moqui relation coverage: ${formatAutoHandoffMoquiCoverageMetric(moquiSummary, 'relation_coverage', 'rate_percent', '%')}`,
    `- Moqui business-rule coverage: ${formatAutoHandoffMoquiCoverageMetric(moquiSummary, 'business_rule_coverage', 'rate_percent', '%')}`,
    `- Moqui business-rule closed: ${formatAutoHandoffMoquiCoverageMetric(moquiSummary, 'business_rule_closed', 'rate_percent', '%')}`,
    `- Moqui decision coverage: ${formatAutoHandoffMoquiCoverageMetric(moquiSummary, 'decision_coverage', 'rate_percent', '%')}`,
    `- Moqui decision closed: ${formatAutoHandoffMoquiCoverageMetric(moquiSummary, 'decision_closed', 'rate_percent', '%')}`,
    `- Moqui baseline avg score delta: ${formatAutoHandoffRegressionValue(moquiDeltas.avg_score)}`,
    `- Moqui baseline valid-rate delta: ${formatAutoHandoffRegressionValue(moquiDeltas.valid_rate_percent)}%`,
    `- Moqui entity coverage delta: ${formatAutoHandoffMoquiCoverageDeltaMetric(moquiCompare, 'entity_coverage', 'rate_percent', '%')}`,
    `- Moqui business-rule closed delta: ${formatAutoHandoffMoquiCoverageDeltaMetric(moquiCompare, 'business_rule_closed', 'rate_percent', '%')}`,
    `- Moqui decision closed delta: ${formatAutoHandoffMoquiCoverageDeltaMetric(moquiCompare, 'decision_closed', 'rate_percent', '%')}`,
    `- Moqui matrix regressions: ${formatAutoHandoffMoquiCoverageRegressions(moquiCompare, 5)}`,
    `- Moqui newly failed templates: ${Array.isArray(moquiFailedTemplates.newly_failed) && moquiFailedTemplates.newly_failed.length > 0 ? moquiFailedTemplates.newly_failed.join(', ') : 'none'}`,
    `- Moqui top baseline gaps: ${moquiGapFrequency.length > 0 ? moquiGapFrequency.slice(0, 3).map(item => `${item.gap}:${item.count}`).join(' | ') : 'none'}`,
    `- Scene package batch status: ${formatAutoHandoffRegressionValue(scenePackageBatch.status)}`,
    `- Scene package batch selected: ${formatAutoHandoffRegressionValue(scenePackageBatchSummary.selected)}`,
    `- Scene package batch failed: ${formatAutoHandoffRegressionValue(scenePackageBatchSummary.failed)}`,
    `- Scene package batch gate passed: ${scenePackageBatchSummary.batch_gate_passed === true ? 'yes' : (scenePackageBatchSummary.batch_gate_passed === false ? 'no' : 'n/a')}`,
    `- Scene package batch gate failures: ${scenePackageBatchFailures.length > 0 ? scenePackageBatchFailures.map(item => item && item.message ? item.message : '').filter(Boolean).join(' | ') : 'none'}`,
    `- Capability coverage status: ${formatAutoHandoffRegressionValue(capabilityCoverage.status)}`,
    `- Capability coverage passed: ${capabilitySummary.passed === true ? 'yes' : (capabilitySummary.passed === false ? 'no' : 'n/a')}`,
    `- Capability coverage: ${formatAutoHandoffRegressionValue(capabilitySummary.coverage_percent)}%`,
    `- Capability min required: ${formatAutoHandoffRegressionValue(capabilitySummary.min_required_percent)}%`,
    `- Capability coverage delta: ${formatAutoHandoffRegressionValue(capabilityCompare.delta_coverage_percent)}%`,
    `- Capability newly uncovered: ${Array.isArray(capabilityCompare.newly_uncovered) && capabilityCompare.newly_uncovered.length > 0 ? capabilityCompare.newly_uncovered.join(', ') : 'none'}`,
    `- Capability lexicon version: ${formatAutoHandoffRegressionValue(capabilityNormalization.lexicon_version)}`,
    `- Capability expected alias mapped: ${formatAutoHandoffRegressionValue(Array.isArray(capabilityNormalization.expected_alias_mapped) ? capabilityNormalization.expected_alias_mapped.length : 0)}`,
    `- Capability expected deprecated alias: ${formatAutoHandoffRegressionValue(Array.isArray(capabilityNormalization.expected_deprecated_aliases) ? capabilityNormalization.expected_deprecated_aliases.length : 0)}`,
    `- Capability provided deprecated alias: ${formatAutoHandoffRegressionValue(Array.isArray(capabilityNormalization.provided_deprecated_aliases) ? capabilityNormalization.provided_deprecated_aliases.length : 0)}`,
    `- Capability gaps: ${capabilityGaps.length > 0 ? capabilityGaps.join(', ') : 'none'}`,
    `- Capability warnings: ${capabilityWarnings.length > 0 ? capabilityWarnings.join(' | ') : 'none'}`,
    '',
    '## Status Breakdown',
    '',
    `- completed: ${formatAutoHandoffRegressionValue(statusCounts.completed, '0')}`,
    `- failed: ${formatAutoHandoffRegressionValue(statusCounts.failed, '0')}`,
    `- dry_run: ${formatAutoHandoffRegressionValue(statusCounts.dry_run, '0')}`,
    `- running: ${formatAutoHandoffRegressionValue(statusCounts.running, '0')}`,
    `- other: ${formatAutoHandoffRegressionValue(statusCounts.other, '0')}`,
    '',
    '## Risk Layer Snapshot',
    '',
    ...riskLines,
    '',
    '## Governance Snapshot',
    '',
    `- Risk level: ${formatAutoHandoffRegressionValue(governanceHealth.risk_level)}`,
    `- Concern count: ${formatAutoHandoffRegressionValue(Array.isArray(governanceHealth.concerns) ? governanceHealth.concerns.length : 0, '0')}`,
    `- Recommendation count: ${formatAutoHandoffRegressionValue(Array.isArray(governanceHealth.recommendations) ? governanceHealth.recommendations.length : 0, '0')}`,
    `- Release gate available: ${governanceReleaseGate.available === true ? 'yes' : 'no'}`,
    `- Release gate latest passed: ${governanceReleaseGate.latest_gate_passed === true ? 'yes' : (governanceReleaseGate.latest_gate_passed === false ? 'no' : 'n/a')}`,
    `- Handoff quality available: ${governanceHandoffQuality.available === true ? 'yes' : 'no'}`,
    `- Handoff latest status: ${formatAutoHandoffRegressionValue(governanceHandoffQuality.latest_status)}`,
    `- Handoff latest gate passed: ${governanceHandoffQuality.latest_gate_passed === true ? 'yes' : (governanceHandoffQuality.latest_gate_passed === false ? 'no' : 'n/a')}`,
    `- Handoff latest ontology score: ${formatAutoHandoffRegressionValue(governanceHandoffQuality.latest_ontology_quality_score)}`,
    '',
    '## Release Evidence Artifacts',
    '',
    `- Evidence review report: ${reviewFile || 'n/a'}`,
    `- Handoff report: ${formatAutoHandoffRegressionValue(currentOverview.handoff_report_file)}`,
    `- Release evidence JSON: ${formatAutoHandoffRegressionValue(payload.evidence_file)}`,
    `- Moqui baseline JSON: ${formatAutoHandoffRegressionValue(moquiBaseline.output && moquiBaseline.output.json)}`,
    `- Moqui baseline markdown: ${formatAutoHandoffRegressionValue(moquiBaseline.output && moquiBaseline.output.markdown)}`,
    `- Scene package batch JSON: ${formatAutoHandoffRegressionValue(scenePackageBatch.output && scenePackageBatch.output.json)}`,
    `- Capability coverage JSON: ${formatAutoHandoffRegressionValue(capabilityCoverage.output && capabilityCoverage.output.json)}`,
    `- Capability coverage markdown: ${formatAutoHandoffRegressionValue(capabilityCoverage.output && capabilityCoverage.output.markdown)}`,
    `- Governance snapshot generated at: ${formatAutoHandoffRegressionValue(governanceSnapshot && governanceSnapshot.generated_at)}`,
    '',
    '## Recommendations'
  ];

  if (recommendations.length === 0) {
    lines.push('', '- None');
  } else {
    recommendations.forEach(item => {
      lines.push('', `- ${item}`);
    });
  }

  return `${lines.join('\n')}\n`;
}

async function buildAutoHandoffEvidenceReviewReport(projectPath, options = {}) {
  const releaseEvidence = await loadAutoHandoffReleaseEvidence(projectPath, options.file);
  if (releaseEvidence.sessions.length === 0) {
    throw new Error(`no release evidence sessions found: ${releaseEvidence.file}`);
  }

  const query = normalizeHandoffSessionQuery(options.sessionId);
  const windowSize = normalizeHandoffEvidenceWindow(options.window);
  let currentIndex = 0;
  if (query !== 'latest') {
    currentIndex = releaseEvidence.sessions.findIndex(item => normalizeHandoffText(item.session_id) === query);
    if (currentIndex < 0) {
      throw new Error(`release evidence session not found: ${query}`);
    }
  }

  const selectedEntries = releaseEvidence.sessions.slice(currentIndex, currentIndex + windowSize);
  const series = selectedEntries.map(item => buildAutoHandoffEvidenceSnapshot(item));
  const currentSnapshot = series[0];
  const previousSnapshot = series[1] || null;
  const comparison = previousSnapshot
    ? buildAutoHandoffRegressionComparison(currentSnapshot, previousSnapshot)
    : {
      trend: 'baseline',
      delta: {
        spec_success_rate_percent: null,
        risk_level_rank: null,
        failed_goals: null,
        elapsed_ms: null,
        ontology_quality_score: null,
        ontology_unmapped_rules: null,
        ontology_undecided_decisions: null,
        ontology_business_rule_pass_rate_percent: null,
        ontology_decision_resolved_rate_percent: null,
        scene_package_batch_failure_count: null
      }
    };
  const windowTrend = buildAutoHandoffRegressionWindowTrend(series);
  const aggregates = buildAutoHandoffRegressionAggregates(series);
  const riskLayers = buildAutoHandoffRegressionRiskLayers(series);
  const statusCounts = buildAutoHandoffEvidenceStatusCounts(selectedEntries);
  const gatePassCount = selectedEntries.filter(item => item && item.gate && item.gate.passed === true).length;
  const gatePassRate = selectedEntries.length > 0
    ? Number(((gatePassCount / selectedEntries.length) * 100).toFixed(2))
    : null;
  let governanceSnapshot = null;
  try {
    const governanceStats = await buildAutoGovernanceStats(projectPath, {});
    governanceSnapshot = {
      mode: governanceStats && governanceStats.mode ? governanceStats.mode : 'auto-governance-stats',
      generated_at: governanceStats && governanceStats.generated_at ? governanceStats.generated_at : new Date().toISOString(),
      criteria: governanceStats && governanceStats.criteria ? governanceStats.criteria : null,
      totals: governanceStats && governanceStats.totals ? governanceStats.totals : null,
      health: governanceStats && governanceStats.health ? governanceStats.health : null
    };
  } catch (error) {
    governanceSnapshot = {
      mode: 'auto-governance-stats',
      generated_at: new Date().toISOString(),
      error: error.message
    };
  }

  const payload = {
    mode: 'auto-handoff-evidence-review',
    generated_at: new Date().toISOString(),
    evidence_file: releaseEvidence.file,
    release_evidence_updated_at: normalizeHandoffText(releaseEvidence.payload.updated_at),
    session_query: query,
    current: currentSnapshot,
    current_overview: selectedEntries[0] || null,
    previous: previousSnapshot,
    trend: comparison.trend,
    delta: comparison.delta,
    window: {
      requested: windowSize,
      actual: series.length
    },
    series,
    window_trend: windowTrend,
    aggregates: {
      ...aggregates,
      status_counts: statusCounts,
      gate_pass_rate_percent: gatePassRate
    },
    risk_layers: riskLayers,
    governance_snapshot: governanceSnapshot,
    recommendations: []
  };
  payload.recommendations = buildAutoHandoffRegressionRecommendations(payload);
  return payload;
}

async function buildAutoHandoffRegression(projectPath, currentResult) {
  const reports = await listAutoHandoffRunReports(projectPath);
  const previous = reports.find(item => item.session_id !== currentResult.session_id) || null;
  const currentSnapshot = buildAutoHandoffRegressionSnapshot(currentResult);
  if (!previous) {
    return {
      mode: 'auto-handoff-regression',
      current: currentSnapshot,
      previous: null,
      trend: 'baseline',
      delta: {
        spec_success_rate_percent: null,
        risk_level_rank: null,
        failed_goals: null,
        elapsed_ms: null,
        ontology_quality_score: null,
        ontology_unmapped_rules: null,
        ontology_undecided_decisions: null,
        ontology_business_rule_pass_rate_percent: null,
        ontology_decision_resolved_rate_percent: null,
        scene_package_batch_failure_count: null
      }
    };
  }

  const previousSnapshot = buildAutoHandoffRegressionSnapshot(previous);
  const comparison = buildAutoHandoffRegressionComparison(currentSnapshot, previousSnapshot);
  return {
    mode: 'auto-handoff-regression',
    current: currentSnapshot,
    previous: previousSnapshot,
    trend: comparison.trend,
    delta: comparison.delta
  };
}

async function buildAutoHandoffRegressionReport(projectPath, options = {}) {
  const reports = await listAutoHandoffRunReports(projectPath);
  if (reports.length === 0) {
    throw new Error('no handoff run reports found');
  }
  const query = normalizeHandoffSessionQuery(options.sessionId);
  const windowSize = normalizeHandoffRegressionWindow(options.window);
  let currentIndex = 0;
  if (query !== 'latest') {
    currentIndex = reports.findIndex(item => item.session_id === query);
    if (currentIndex < 0) {
      throw new Error(`handoff run session not found: ${query}`);
    }
  }

  const chainReports = reports.slice(currentIndex, currentIndex + windowSize);
  const series = chainReports.map(item => buildAutoHandoffRegressionSnapshot(item));
  const currentSnapshot = series[0];
  const previousSnapshot = series[1] || null;
  const comparison = previousSnapshot
    ? buildAutoHandoffRegressionComparison(currentSnapshot, previousSnapshot)
    : {
      trend: 'baseline',
      delta: {
        spec_success_rate_percent: null,
        risk_level_rank: null,
        failed_goals: null,
        elapsed_ms: null,
        ontology_quality_score: null,
        ontology_unmapped_rules: null,
        ontology_undecided_decisions: null,
        ontology_business_rule_pass_rate_percent: null,
        ontology_decision_resolved_rate_percent: null,
        scene_package_batch_failure_count: null
      }
    };
  const windowTrend = buildAutoHandoffRegressionWindowTrend(series);
  const aggregates = buildAutoHandoffRegressionAggregates(series);
  const riskLayers = buildAutoHandoffRegressionRiskLayers(series);

  const payload = {
    mode: 'auto-handoff-regression',
    current: currentSnapshot,
    previous: previousSnapshot,
    trend: comparison.trend,
    delta: comparison.delta,
    window: {
      requested: windowSize,
      actual: series.length
    },
    series,
    window_trend: windowTrend,
    aggregates,
    risk_layers: riskLayers,
    recommendations: []
  };
  payload.recommendations = buildAutoHandoffRegressionRecommendations(payload);
  return payload;
}

function normalizeHandoffMinSpecSuccessRate(rateCandidate) {
  if (rateCandidate === undefined || rateCandidate === null) {
    return 100;
  }
  const parsed = Number(rateCandidate);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error('--min-spec-success-rate must be a number between 0 and 100.');
  }
  return Number(parsed.toFixed(2));
}

function normalizeHandoffRiskLevel(levelCandidate) {
  const normalized = typeof levelCandidate === 'string'
    ? levelCandidate.trim().toLowerCase()
    : 'high';
  if (!['low', 'medium', 'high'].includes(normalized)) {
    throw new Error('--max-risk-level must be one of: low, medium, high.');
  }
  return normalized;
}

function normalizeHandoffMinOntologyScore(scoreCandidate) {
  if (scoreCandidate === undefined || scoreCandidate === null) {
    return 0;
  }
  const parsed = Number(scoreCandidate);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error('--min-ontology-score must be a number between 0 and 100.');
  }
  return Number(parsed.toFixed(2));
}

function normalizeHandoffMinCapabilityCoverage(coverageCandidate) {
  if (coverageCandidate === undefined || coverageCandidate === null) {
    return 100;
  }
  const parsed = Number(coverageCandidate);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error('--min-capability-coverage must be a number between 0 and 100.');
  }
  return Number(parsed.toFixed(2));
}

function normalizeHandoffMinCapabilitySemantic(semanticCandidate) {
  if (semanticCandidate === undefined || semanticCandidate === null) {
    return 100;
  }
  const parsed = Number(semanticCandidate);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error('--min-capability-semantic must be a number between 0 and 100.');
  }
  return Number(parsed.toFixed(2));
}

function normalizeHandoffMaxMoquiMatrixRegressions(valueCandidate) {
  if (valueCandidate === undefined || valueCandidate === null || valueCandidate === '') {
    return 0;
  }
  const parsed = Number(valueCandidate);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('--max-moqui-matrix-regressions must be an integer >= 0.');
  }
  return parsed;
}

function normalizeHandoffOptionalNonNegativeInteger(valueCandidate, optionName) {
  if (valueCandidate === undefined || valueCandidate === null || valueCandidate === '') {
    return null;
  }
  const parsed = Number(valueCandidate);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${optionName} must be an integer >= 0.`);
  }
  return parsed;
}

function normalizeHandoffReleaseEvidenceWindow(windowCandidate) {
  if (windowCandidate === undefined || windowCandidate === null || windowCandidate === '') {
    return 5;
  }
  const parsed = Number(windowCandidate);
  if (!Number.isInteger(parsed) || parsed < 2 || parsed > 50) {
    throw new Error('--release-evidence-window must be an integer between 2 and 50.');
  }
  return parsed;
}

function normalizeAutoHandoffPolicyProfile(profileCandidate, optionName = '--profile') {
  const normalized = typeof profileCandidate === 'string'
    ? profileCandidate.trim().toLowerCase()
    : 'default';
  if (!normalized) {
    return 'default';
  }
  if (!AUTO_HANDOFF_POLICY_PROFILE_PRESETS[normalized]) {
    const allowed = Object.keys(AUTO_HANDOFF_POLICY_PROFILE_PRESETS).join(', ');
    throw new Error(`${optionName} must be one of: ${allowed}.`);
  }
  return normalized;
}

function resolveAutoHandoffPolicyPreset(profileCandidate, optionName) {
  const profile = normalizeAutoHandoffPolicyProfile(profileCandidate, optionName);
  const preset = AUTO_HANDOFF_POLICY_PROFILE_PRESETS[profile];
  return {
    profile,
    preset: {
      ...preset
    }
  };
}

function resolveAutoHandoffPolicyOptionNumber(valueCandidate, fallbackValue) {
  if (valueCandidate === undefined || valueCandidate === null || valueCandidate === '') {
    return fallbackValue;
  }
  return valueCandidate;
}

function resolveAutoHandoffPolicyOptionBoolean(valueCandidate, fallbackValue) {
  if (valueCandidate === undefined || valueCandidate === null) {
    return fallbackValue === true;
  }
  return valueCandidate === true;
}

function buildAutoHandoffRunPolicy(options = {}) {
  const { profile, preset } = resolveAutoHandoffPolicyPreset(options.profile, '--profile');
  return {
    profile,
    min_spec_success_rate: normalizeHandoffMinSpecSuccessRate(
      resolveAutoHandoffPolicyOptionNumber(options.minSpecSuccessRate, preset.min_spec_success_rate)
    ),
    max_risk_level: normalizeHandoffRiskLevel(
      resolveAutoHandoffPolicyOptionNumber(options.maxRiskLevel, preset.max_risk_level)
    ),
    min_ontology_score: normalizeHandoffMinOntologyScore(
      resolveAutoHandoffPolicyOptionNumber(options.minOntologyScore, preset.min_ontology_score)
    ),
    min_capability_coverage_percent: normalizeHandoffMinCapabilityCoverage(
      resolveAutoHandoffPolicyOptionNumber(
        options.minCapabilityCoverage,
        preset.min_capability_coverage_percent
      )
    ),
    max_moqui_matrix_regressions: normalizeHandoffMaxMoquiMatrixRegressions(
      resolveAutoHandoffPolicyOptionNumber(
        options.maxMoquiMatrixRegressions,
        preset.max_moqui_matrix_regressions
      )
    ),
    max_unmapped_rules: normalizeHandoffOptionalNonNegativeInteger(
      resolveAutoHandoffPolicyOptionNumber(options.maxUnmappedRules, preset.max_unmapped_rules),
      '--max-unmapped-rules'
    ),
    max_undecided_decisions: normalizeHandoffOptionalNonNegativeInteger(
      resolveAutoHandoffPolicyOptionNumber(options.maxUndecidedDecisions, preset.max_undecided_decisions),
      '--max-undecided-decisions'
    ),
    require_ontology_validation: resolveAutoHandoffPolicyOptionBoolean(
      options.requireOntologyValidation,
      preset.require_ontology_validation
    ),
    require_moqui_baseline: resolveAutoHandoffPolicyOptionBoolean(
      options.requireMoquiBaseline,
      preset.require_moqui_baseline
    ),
    require_scene_package_batch: resolveAutoHandoffPolicyOptionBoolean(
      options.requireScenePackageBatch,
      preset.require_scene_package_batch
    ),
    require_capability_coverage: resolveAutoHandoffPolicyOptionBoolean(
      options.requireCapabilityCoverage,
      preset.require_capability_coverage
    ),
    require_capability_lexicon: resolveAutoHandoffPolicyOptionBoolean(
      options.requireCapabilityLexicon,
      preset.require_capability_lexicon
    ),
    require_release_gate_preflight: resolveAutoHandoffPolicyOptionBoolean(
      options.requireReleaseGatePreflight,
      preset.require_release_gate_preflight
    ),
    dependency_batching: resolveAutoHandoffPolicyOptionBoolean(
      options.dependencyBatching,
      preset.dependency_batching
    ),
    release_evidence_window: normalizeHandoffReleaseEvidenceWindow(
      resolveAutoHandoffPolicyOptionNumber(options.releaseEvidenceWindow, preset.release_evidence_window)
    )
  };
}

function buildAutoHandoffCapabilityMatrixPolicy(options = {}) {
  const { profile, preset } = resolveAutoHandoffPolicyPreset(options.profile, '--profile');
  return {
    profile,
    min_capability_coverage_percent: normalizeHandoffMinCapabilityCoverage(
      resolveAutoHandoffPolicyOptionNumber(
        options.minCapabilityCoverage,
        preset.min_capability_coverage_percent
      )
    ),
    min_capability_semantic_percent: normalizeHandoffMinCapabilitySemantic(
      resolveAutoHandoffPolicyOptionNumber(
        options.minCapabilitySemantic,
        preset.min_capability_semantic_percent
      )
    ),
    require_capability_coverage: resolveAutoHandoffPolicyOptionBoolean(
      options.requireCapabilityCoverage,
      preset.require_capability_coverage
    ),
    require_capability_semantic: resolveAutoHandoffPolicyOptionBoolean(
      options.requireCapabilitySemantic,
      preset.require_capability_semantic
    ),
    require_capability_lexicon: resolveAutoHandoffPolicyOptionBoolean(
      options.requireCapabilityLexicon,
      preset.require_capability_lexicon
    ),
    require_moqui_baseline: resolveAutoHandoffPolicyOptionBoolean(
      options.requireMoquiBaseline,
      preset.require_moqui_baseline
    )
  };
}

function evaluateHandoffOntologyValidation(ontologyValidation) {
  const payload = ontologyValidation && typeof ontologyValidation === 'object'
    ? ontologyValidation
    : null;
  const statusText = normalizeHandoffText(
    readHandoffPathValue(payload, 'status')
      || readHandoffPathValue(payload, 'result')
      || readHandoffPathValue(payload, 'state')
  );
  const statusToken = statusText ? statusText.toLowerCase() : null;
  const boolSignals = [
    readHandoffPathValue(payload, 'passed'),
    readHandoffPathValue(payload, 'valid'),
    readHandoffPathValue(payload, 'success')
  ];
  let passed = false;
  if (boolSignals.some(value => value === true)) {
    passed = true;
  } else if (statusToken && ['passed', 'success', 'ok', 'valid', 'completed', 'complete'].includes(statusToken)) {
    passed = true;
  }

  const model = normalizeHandoffOntologyModel(payload);
  const entityCount = normalizeHandoffNumber(
    readHandoffFirstPathValue(payload, [
      'coverage.entities.total',
      'metrics.entities.total',
      'entities.total',
      'entity_count'
    ]),
    { min: 0, integer: true }
  );
  const relationCount = normalizeHandoffNumber(
    readHandoffFirstPathValue(payload, [
      'coverage.relations.total',
      'metrics.relations.total',
      'relations.total',
      'relation_count'
    ]),
    { min: 0, integer: true }
  );
  const ruleTotal = normalizeHandoffNumber(
    readHandoffFirstPathValue(payload, [
      'business_rules.total',
      'rules.total',
      'coverage.business_rules.total',
      'metrics.business_rules.total',
      'rule_count'
    ]),
    { min: 0, integer: true }
  );
  const mappedRules = normalizeHandoffNumber(
    readHandoffFirstPathValue(payload, [
      'business_rules.mapped',
      'rules.mapped',
      'coverage.business_rules.mapped',
      'metrics.business_rules.mapped'
    ]),
    { min: 0, integer: true }
  );
  const passedRules = normalizeHandoffNumber(
    readHandoffFirstPathValue(payload, [
      'business_rules.passed',
      'rules.passed',
      'coverage.business_rules.passed',
      'metrics.business_rules.passed'
    ]),
    { min: 0, integer: true }
  );
  const failedRules = normalizeHandoffNumber(
    readHandoffFirstPathValue(payload, [
      'business_rules.failed',
      'rules.failed',
      'coverage.business_rules.failed',
      'metrics.business_rules.failed'
    ]),
    { min: 0, integer: true }
  );
  const decisionTotal = normalizeHandoffNumber(
    readHandoffFirstPathValue(payload, [
      'decision_logic.total',
      'decisions.total',
      'coverage.decision_logic.total',
      'metrics.decision_logic.total',
      'decision_count'
    ]),
    { min: 0, integer: true }
  );
  const resolvedDecisions = normalizeHandoffNumber(
    readHandoffFirstPathValue(payload, [
      'decision_logic.resolved',
      'decisions.resolved',
      'coverage.decision_logic.resolved',
      'metrics.decision_logic.resolved'
    ]),
    { min: 0, integer: true }
  );
  const pendingDecisions = normalizeHandoffNumber(
    readHandoffFirstPathValue(payload, [
      'decision_logic.pending',
      'decisions.pending',
      'coverage.decision_logic.pending',
      'metrics.decision_logic.pending'
    ]),
    { min: 0, integer: true }
  );
  const automatedDecisions = normalizeHandoffNumber(
    readHandoffFirstPathValue(payload, [
      'decision_logic.automated',
      'decisions.automated',
      'decision_logic.tested',
      'decisions.tested',
      'coverage.decision_logic.automated',
      'metrics.decision_logic.automated'
    ]),
    { min: 0, integer: true }
  );

  const resolvedEntityCount = entityCount !== null ? entityCount : model.entities.length;
  const resolvedRelationCount = relationCount !== null ? relationCount : model.relations.length;
  const resolvedRuleTotal = ruleTotal !== null ? ruleTotal : model.business_rules.length;
  const resolvedRuleMapped = mappedRules !== null
    ? mappedRules
    : model.business_rules.filter(item => item.mapped).length;
  const resolvedRulePassed = passedRules !== null
    ? passedRules
    : model.business_rules.filter(item => item.passed).length;
  const resolvedRuleFailed = failedRules !== null
    ? failedRules
    : (resolvedRuleTotal !== null && resolvedRulePassed !== null
      ? Math.max(0, resolvedRuleTotal - resolvedRulePassed)
      : null);
  const resolvedDecisionTotal = decisionTotal !== null ? decisionTotal : model.decision_logic.length;
  const resolvedDecisionResolved = resolvedDecisions !== null
    ? resolvedDecisions
    : model.decision_logic.filter(item => item.resolved).length;
  const resolvedDecisionPending = pendingDecisions !== null
    ? pendingDecisions
    : (resolvedDecisionTotal !== null && resolvedDecisionResolved !== null
      ? Math.max(0, resolvedDecisionTotal - resolvedDecisionResolved)
      : null);
  const resolvedDecisionAutomated = automatedDecisions !== null
    ? automatedDecisions
    : model.decision_logic.filter(item => item.automated).length;

  const unmappedRules = (
    Number.isFinite(resolvedRuleTotal) && Number.isFinite(resolvedRuleMapped)
  )
    ? Math.max(0, resolvedRuleTotal - resolvedRuleMapped)
    : null;
  const undecidedDecisions = Number.isFinite(resolvedDecisionPending)
    ? resolvedDecisionPending
    : (
      Number.isFinite(resolvedDecisionTotal) && Number.isFinite(resolvedDecisionResolved)
        ? Math.max(0, resolvedDecisionTotal - resolvedDecisionResolved)
        : null
    );

  const ruleMappingRate = Number.isFinite(resolvedRuleTotal) && resolvedRuleTotal > 0 && Number.isFinite(resolvedRuleMapped)
    ? Number(((resolvedRuleMapped / resolvedRuleTotal) * 100).toFixed(2))
    : null;
  const rulePassRate = Number.isFinite(resolvedRuleTotal) && resolvedRuleTotal > 0 && Number.isFinite(resolvedRulePassed)
    ? Number(((resolvedRulePassed / resolvedRuleTotal) * 100).toFixed(2))
    : null;
  const decisionResolvedRate = Number.isFinite(resolvedDecisionTotal) && resolvedDecisionTotal > 0 && Number.isFinite(resolvedDecisionResolved)
    ? Number(((resolvedDecisionResolved / resolvedDecisionTotal) * 100).toFixed(2))
    : null;

  const qualityScoreFromManifest = normalizeHandoffNumber(
    readHandoffFirstPathValue(payload, [
      'quality.score',
      'quality_score',
      'metrics.quality_score',
      'score'
    ]),
    { min: 0, max: 100, precision: 2 }
  );

  let qualityScore = qualityScoreFromManifest;
  let qualityScoreSource = qualityScoreFromManifest === null ? 'derived' : 'manifest';
  const qualityComponents = {
    structure: 0,
    business_rules: 0,
    decision_logic: 0
  };
  if (qualityScore === null) {
    qualityComponents.structure = (
      (Number.isFinite(resolvedEntityCount) && resolvedEntityCount > 0 ? 20 : 0) +
      (Number.isFinite(resolvedRelationCount) && resolvedRelationCount > 0 ? 20 : 0)
    );
    qualityComponents.business_rules = Number.isFinite(ruleMappingRate)
      ? Number((30 * (ruleMappingRate / 100)).toFixed(2))
      : 15;
    qualityComponents.decision_logic = Number.isFinite(decisionResolvedRate)
      ? Number((30 * (decisionResolvedRate / 100)).toFixed(2))
      : 15;
    qualityScore = Number((
      qualityComponents.structure +
      qualityComponents.business_rules +
      qualityComponents.decision_logic
    ).toFixed(2));
  } else {
    qualityScoreSource = 'manifest';
  }

  return {
    present: Boolean(payload),
    passed,
    status: statusText || null,
    quality_score: qualityScore,
    quality_score_source: qualityScoreSource,
    quality_components: qualityComponents,
    model: {
      entity_relation: {
        entities: resolvedEntityCount,
        relations: resolvedRelationCount
      },
      business_rules: {
        total: resolvedRuleTotal,
        mapped: resolvedRuleMapped,
        passed: resolvedRulePassed,
        failed: resolvedRuleFailed,
        unmapped: unmappedRules
      },
      decision_logic: {
        total: resolvedDecisionTotal,
        resolved: resolvedDecisionResolved,
        pending: resolvedDecisionPending,
        automated: resolvedDecisionAutomated,
        undecided: undecidedDecisions
      }
    },
    metrics: {
      entity_count: resolvedEntityCount,
      relation_count: resolvedRelationCount,
      business_rule_total: resolvedRuleTotal,
      business_rule_mapped: resolvedRuleMapped,
      business_rule_passed: resolvedRulePassed,
      business_rule_failed: resolvedRuleFailed,
      business_rule_unmapped: unmappedRules,
      business_rule_mapping_rate_percent: ruleMappingRate,
      business_rule_pass_rate_percent: rulePassRate,
      decision_total: resolvedDecisionTotal,
      decision_resolved: resolvedDecisionResolved,
      decision_pending: resolvedDecisionPending,
      decision_automated: resolvedDecisionAutomated,
      decision_undecided: undecidedDecisions,
      decision_resolved_rate_percent: decisionResolvedRate
    },
    payload
  };
}

function evaluateAutoHandoffOntologyGateReasons(policy = {}, ontology = {}) {
  const reasons = [];
  if (policy.require_ontology_validation && !ontology.passed) {
    if (!ontology.present) {
      reasons.push('manifest ontology_validation is missing');
    } else {
      reasons.push(`manifest ontology_validation status is not passed (${ontology.status || 'unknown'})`);
    }
  }

  const scoreThreshold = Number(policy.min_ontology_score);
  if (Number.isFinite(scoreThreshold) && scoreThreshold > 0) {
    const qualityScore = Number(ontology.quality_score);
    if (!Number.isFinite(qualityScore)) {
      reasons.push('ontology_quality_score unavailable');
    } else if (qualityScore < scoreThreshold) {
      reasons.push(`ontology_quality_score ${qualityScore} < required ${scoreThreshold}`);
    }
  }

  if (Number.isInteger(policy.max_unmapped_rules)) {
    const unmapped = Number(
      ontology && ontology.metrics ? ontology.metrics.business_rule_unmapped : null
    );
    if (!Number.isFinite(unmapped)) {
      reasons.push('ontology business_rule_unmapped unavailable');
    } else if (unmapped > policy.max_unmapped_rules) {
      reasons.push(`ontology business_rule_unmapped ${unmapped} > allowed ${policy.max_unmapped_rules}`);
    }
  }

  if (Number.isInteger(policy.max_undecided_decisions)) {
    const undecided = Number(
      ontology && ontology.metrics ? ontology.metrics.decision_undecided : null
    );
    if (!Number.isFinite(undecided)) {
      reasons.push('ontology decision_undecided unavailable');
    } else if (undecided > policy.max_undecided_decisions) {
      reasons.push(`ontology decision_undecided ${undecided} > allowed ${policy.max_undecided_decisions}`);
    }
  }

  return reasons;
}

function evaluateAutoHandoffMoquiBaselineGateReasons(policy = {}, moquiBaseline = null) {
  const reasons = [];
  if (policy.require_moqui_baseline !== true) {
    return reasons;
  }

  const baseline = moquiBaseline && typeof moquiBaseline === 'object'
    ? moquiBaseline
    : null;
  const summary = baseline && baseline.summary && typeof baseline.summary === 'object'
    ? baseline.summary
    : {};
  const compare = baseline && baseline.compare && typeof baseline.compare === 'object'
    ? baseline.compare
    : {};
  const matrixRegressions = buildAutoHandoffMoquiCoverageRegressions(compare);
  const status = `${baseline && baseline.status ? baseline.status : 'missing'}`.trim().toLowerCase();
  if (!baseline || baseline.generated !== true) {
    const reason = baseline && baseline.reason ? baseline.reason : 'moqui baseline snapshot missing';
    reasons.push(`moqui baseline unavailable: ${reason}`);
    return reasons;
  }
  if (status === 'error') {
    reasons.push(`moqui baseline errored: ${baseline.error || 'unknown error'}`);
    return reasons;
  }
  if (summary.portfolio_passed !== true) {
    const avgScore = Number(summary.avg_score);
    const validRate = Number(summary.valid_rate_percent);
    reasons.push(
      `moqui baseline portfolio not passed (avg_score=${Number.isFinite(avgScore) ? avgScore : 'n/a'}, ` +
      `valid_rate=${Number.isFinite(validRate) ? `${validRate}%` : 'n/a'})`
    );
  }
  if (Number.isInteger(policy.max_moqui_matrix_regressions)) {
    const limit = Number(policy.max_moqui_matrix_regressions);
    if (matrixRegressions.length > limit) {
      reasons.push(
        `moqui baseline matrix regressions ${matrixRegressions.length} > allowed ${limit} ` +
        `(${matrixRegressions.slice(0, 3).map(item => `${item.label}:${item.delta_rate_percent}%`).join(' | ')})`
      );
    }
  }
  return reasons;
}

function evaluateAutoHandoffScenePackageBatchGateReasons(policy = {}, scenePackageBatch = null) {
  const reasons = [];
  if (policy.require_scene_package_batch !== true) {
    return reasons;
  }

  const batch = scenePackageBatch && typeof scenePackageBatch === 'object'
    ? scenePackageBatch
    : null;
  if (!batch) {
    reasons.push('scene package publish-batch dry-run snapshot missing');
    return reasons;
  }
  if (batch.status === 'skipped') {
    return reasons;
  }
  if (batch.status === 'error') {
    reasons.push(`scene package publish-batch dry-run errored: ${batch.error || 'unknown error'}`);
    return reasons;
  }
  if (batch.status !== 'passed') {
    const summary = batch.summary && typeof batch.summary === 'object' ? batch.summary : {};
    const selected = Number(summary.selected);
    const failed = Number(summary.failed);
    const batchGatePassed = summary.batch_gate_passed === true;
    reasons.push(
      `scene package publish-batch dry-run failed (selected=${Number.isFinite(selected) ? selected : 'n/a'}, ` +
      `failed=${Number.isFinite(failed) ? failed : 'n/a'}, batch_gate=${batchGatePassed ? 'pass' : 'fail'})`
    );
  }
  return reasons;
}

function evaluateAutoHandoffCapabilityCoverageGateReasons(policy = {}, capabilityCoverage = null) {
  const reasons = [];
  if (policy.require_capability_coverage !== true) {
    return reasons;
  }

  const coverage = capabilityCoverage && typeof capabilityCoverage === 'object'
    ? capabilityCoverage
    : null;
  if (!coverage) {
    reasons.push('capability coverage snapshot missing');
    return reasons;
  }
  if (coverage.status === 'error') {
    reasons.push(`capability coverage errored: ${coverage.error || 'unknown error'}`);
    return reasons;
  }
  if (coverage.status === 'skipped') {
    const totalCapabilities = Number(
      coverage &&
      coverage.summary &&
      coverage.summary.total_capabilities !== undefined
        ? coverage.summary.total_capabilities
        : 0
    );
    if (Number.isFinite(totalCapabilities) && totalCapabilities <= 0) {
      return reasons;
    }
    reasons.push(`capability coverage skipped: ${coverage.reason || 'unknown reason'}`);
    return reasons;
  }

  const summary = coverage.summary && typeof coverage.summary === 'object'
    ? coverage.summary
    : {};
  const coveragePercent = Number(summary.coverage_percent);
  const minCoverage = Number(policy.min_capability_coverage_percent);
  if (!Number.isFinite(coveragePercent)) {
    reasons.push('capability_coverage_percent unavailable');
  } else if (Number.isFinite(minCoverage) && coveragePercent < minCoverage) {
    reasons.push(`capability_coverage_percent ${coveragePercent} < required ${minCoverage}`);
  }
  return reasons;
}

function evaluateAutoHandoffCapabilityLexiconGateReasons(policy = {}, capabilityCoverage = null) {
  const reasons = [];
  if (policy.require_capability_lexicon !== true) {
    return reasons;
  }

  const coverage = capabilityCoverage && typeof capabilityCoverage === 'object'
    ? capabilityCoverage
    : null;
  if (!coverage) {
    reasons.push('capability lexicon snapshot missing');
    return reasons;
  }
  if (coverage.status === 'error') {
    reasons.push(`capability lexicon errored: ${coverage.error || 'unknown error'}`);
    return reasons;
  }
  if (coverage.status === 'skipped') {
    const totalCapabilities = Number(
      coverage &&
      coverage.summary &&
      coverage.summary.total_capabilities !== undefined
        ? coverage.summary.total_capabilities
        : 0
    );
    if (Number.isFinite(totalCapabilities) && totalCapabilities <= 0) {
      return reasons;
    }
    reasons.push(`capability lexicon skipped: ${coverage.reason || 'unknown reason'}`);
    return reasons;
  }

  const normalization = coverage.normalization && typeof coverage.normalization === 'object'
    ? coverage.normalization
    : {};
  const expectedUnknownCount = Array.isArray(normalization.expected_unknown)
    ? normalization.expected_unknown.length
    : 0;
  const providedUnknownCount = Array.isArray(normalization.provided_unknown)
    ? normalization.provided_unknown.length
    : 0;
  if (expectedUnknownCount > 0) {
    reasons.push(`capability_lexicon_expected_unknown_count ${expectedUnknownCount} > allowed 0`);
  }
  if (providedUnknownCount > 0) {
    reasons.push(`capability_lexicon_provided_unknown_count ${providedUnknownCount} > allowed 0`);
  }

  return reasons;
}

function evaluateAutoHandoffCapabilitySemanticGateReasons(policy = {}, capabilityCoverage = null) {
  const reasons = [];
  if (policy.require_capability_semantic !== true) {
    return reasons;
  }

  const coverage = capabilityCoverage && typeof capabilityCoverage === 'object'
    ? capabilityCoverage
    : null;
  if (!coverage) {
    reasons.push('capability semantic snapshot missing');
    return reasons;
  }
  if (coverage.status === 'error') {
    reasons.push(`capability semantic errored: ${coverage.error || 'unknown error'}`);
    return reasons;
  }
  if (coverage.status === 'skipped') {
    const totalCapabilities = Number(
      coverage &&
      coverage.summary &&
      coverage.summary.total_capabilities !== undefined
        ? coverage.summary.total_capabilities
        : 0
    );
    if (Number.isFinite(totalCapabilities) && totalCapabilities <= 0) {
      return reasons;
    }
    reasons.push(`capability semantic skipped: ${coverage.reason || 'unknown reason'}`);
    return reasons;
  }

  const summary = coverage.summary && typeof coverage.summary === 'object'
    ? coverage.summary
    : {};
  const semanticPercent = Number(summary.semantic_complete_percent);
  const minSemantic = Number(policy.min_capability_semantic_percent);
  if (!Number.isFinite(semanticPercent)) {
    reasons.push('capability_semantic_percent unavailable');
  } else if (Number.isFinite(minSemantic) && semanticPercent < minSemantic) {
    reasons.push(`capability_semantic_percent ${semanticPercent} < required ${minSemantic}`);
  }
  return reasons;
}

function evaluateAutoHandoffReleaseGatePreflightGateReasons(policy = {}, preflight = null) {
  const reasons = [];
  if (policy.require_release_gate_preflight !== true) {
    return reasons;
  }

  const snapshot = preflight && typeof preflight === 'object' && !Array.isArray(preflight)
    ? preflight
    : null;
  if (!snapshot) {
    reasons.push('release gate preflight snapshot missing');
    return reasons;
  }
  if (snapshot.parse_error) {
    reasons.push(`release gate preflight parse error: ${snapshot.parse_error}`);
    return reasons;
  }
  if (snapshot.available !== true) {
    reasons.push('release gate preflight unavailable');
    return reasons;
  }
  if (snapshot.blocked === true) {
    const reasonText = Array.isArray(snapshot.reasons) && snapshot.reasons.length > 0
      ? snapshot.reasons.join('; ')
      : 'release gate blocked';
    reasons.push(`release gate preflight blocked: ${reasonText}`);
  }

  return reasons;
}

function buildAutoHandoffReleaseGatePreflight(signals = null) {
  const source = signals && typeof signals === 'object' && !Array.isArray(signals)
    ? signals
    : {};
  const toNumber = value => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const blockState = evaluateGovernanceReleaseGateBlockState({
    health: {
      release_gate: source
    }
  });
  return {
    available: source.available === true,
    file: normalizeHandoffText(source.file),
    latest_tag: normalizeHandoffText(source.latest_tag),
    latest_gate_passed: parseAutoHandoffGateBoolean(source.latest_gate_passed, null),
    latest_risk_level: normalizeHandoffText(source.latest_risk_level),
    pass_rate_percent: toNumber(source.pass_rate_percent),
    scene_package_batch_pass_rate_percent: toNumber(source.scene_package_batch_pass_rate_percent),
    scene_package_batch_failed_count: toNumber(source.scene_package_batch_failed_count),
    drift_alert_rate_percent: toNumber(source.drift_alert_rate_percent),
    drift_alert_runs: toNumber(source.drift_alert_runs),
    drift_blocked_runs: toNumber(source.drift_blocked_runs),
    latest_weekly_ops_runtime_block_rate_percent: toNumber(
      source.latest_weekly_ops_runtime_block_rate_percent
    ),
    latest_weekly_ops_runtime_ui_mode_violation_total: toNumber(
      source.latest_weekly_ops_runtime_ui_mode_violation_total
    ),
    latest_weekly_ops_runtime_ui_mode_violation_rate_percent: toNumber(
      source.latest_weekly_ops_runtime_ui_mode_violation_rate_percent
    ),
    weekly_ops_runtime_block_rate_max_percent: toNumber(
      source.weekly_ops_runtime_block_rate_max_percent
    ),
    weekly_ops_runtime_ui_mode_violation_total: toNumber(
      source.weekly_ops_runtime_ui_mode_violation_total
    ),
    weekly_ops_runtime_ui_mode_violation_run_rate_percent: toNumber(
      source.weekly_ops_runtime_ui_mode_violation_run_rate_percent
    ),
    weekly_ops_runtime_ui_mode_violation_rate_max_percent: toNumber(
      source.weekly_ops_runtime_ui_mode_violation_rate_max_percent
    ),
    parse_error: normalizeHandoffText(source.parse_error),
    blocked: blockState.blocked === true,
    reasons: Array.isArray(blockState.reasons) ? blockState.reasons : []
  };
}

function buildAutoHandoffPreflightCheckRecommendations(projectPath, result = {}) {
  const recommendations = [];
  const seen = new Set();
  const push = value => {
    const text = `${value || ''}`.trim();
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    recommendations.push(text);
  };

  const policy = result && result.policy && typeof result.policy === 'object'
    ? result.policy
    : {};
  const preflight = result && result.release_gate_preflight && typeof result.release_gate_preflight === 'object'
    ? result.release_gate_preflight
    : {};
  const reasons = Array.isArray(result.reasons) ? result.reasons : [];
  const windowSize = Number.isInteger(policy.release_evidence_window)
    ? policy.release_evidence_window
    : 5;

  if (preflight.available !== true || preflight.parse_error) {
    push(
      'sce auto handoff gate-index ' +
      '--dir .sce/reports/release-evidence ' +
      '--out .sce/reports/release-evidence/release-gate-history.json --json'
    );
  }
  if (result.status !== 'pass' || preflight.blocked === true) {
    push(`sce auto handoff evidence --window ${windowSize} --json`);
  }

  if (preflight.blocked === true) {
    const governanceRecommendations = buildGovernanceCloseLoopRecommendations(
      {
        health: {
          recommendations: []
        }
      },
      'release-gate-blocked',
      {
        reasons: Array.isArray(preflight.reasons) ? preflight.reasons : []
      }
    );
    for (const item of governanceRecommendations) {
      push(item);
    }
  }

  if (reasons.some(item => `${item}`.includes('parse error'))) {
    push(
      'Review and repair release gate history JSON, then rerun `sce auto handoff preflight-check --json`.'
    );
  }
  if (
    reasons.some(item => `${item}`.includes('unavailable') || `${item}`.includes('snapshot missing'))
  ) {
    push(
      'Ensure release workflow publishes `release-gate-history.json` and rerun preflight check.'
    );
  }

  return recommendations;
}

async function buildAutoHandoffPreflightCheck(projectPath, options = {}) {
  const policy = buildAutoHandoffRunPolicy(options);
  const releaseGateSignals = await loadGovernanceReleaseGateSignals(projectPath, {
    historyFile: options.historyFile
  });
  const releaseGatePreflight = buildAutoHandoffReleaseGatePreflight(releaseGateSignals);
  const hardGateReasons = evaluateAutoHandoffReleaseGatePreflightGateReasons(
    policy,
    releaseGatePreflight
  );

  const advisoryReasons = [];
  if (hardGateReasons.length === 0) {
    if (releaseGatePreflight.parse_error) {
      advisoryReasons.push(`release gate preflight parse error: ${releaseGatePreflight.parse_error}`);
    } else if (releaseGatePreflight.available !== true) {
      advisoryReasons.push('release gate preflight unavailable (advisory mode)');
    } else if (releaseGatePreflight.blocked === true) {
      const reasonText = Array.isArray(releaseGatePreflight.reasons) && releaseGatePreflight.reasons.length > 0
        ? releaseGatePreflight.reasons.join('; ')
        : 'release gate blocked';
      advisoryReasons.push(`release gate preflight blocked (advisory mode): ${reasonText}`);
    }
  }

  const status = hardGateReasons.length > 0
    ? 'blocked'
    : (advisoryReasons.length > 0 ? 'warning' : 'pass');
  const reasons = hardGateReasons.length > 0 ? hardGateReasons : advisoryReasons;
  const result = {
    mode: 'auto-handoff-preflight-check',
    generated_at: new Date().toISOString(),
    status,
    reasons,
    hard_gate_reasons: hardGateReasons,
    policy: {
      profile: policy.profile,
      require_release_gate_preflight: policy.require_release_gate_preflight === true,
      release_evidence_window: policy.release_evidence_window
    },
    release_gate_preflight: releaseGatePreflight,
    signals: {
      history_file: releaseGateSignals.file || releaseGatePreflight.file || null,
      total_entries: releaseGateSignals.total_entries,
      latest: {
        tag: releaseGatePreflight.latest_tag,
        gate_passed: releaseGatePreflight.latest_gate_passed,
        risk_level: releaseGatePreflight.latest_risk_level,
        weekly_ops_runtime_block_rate_percent:
          releaseGatePreflight.latest_weekly_ops_runtime_block_rate_percent,
        weekly_ops_runtime_ui_mode_violation_total:
          releaseGatePreflight.latest_weekly_ops_runtime_ui_mode_violation_total,
        weekly_ops_runtime_ui_mode_violation_rate_percent:
          releaseGatePreflight.latest_weekly_ops_runtime_ui_mode_violation_rate_percent
      },
      aggregates: {
        pass_rate_percent: releaseGatePreflight.pass_rate_percent,
        scene_package_batch_pass_rate_percent: releaseGatePreflight.scene_package_batch_pass_rate_percent,
        drift_alert_rate_percent: releaseGatePreflight.drift_alert_rate_percent,
        drift_blocked_runs: releaseGatePreflight.drift_blocked_runs,
        weekly_ops_runtime_block_rate_max_percent:
          releaseGatePreflight.weekly_ops_runtime_block_rate_max_percent,
        weekly_ops_runtime_ui_mode_violation_total:
          releaseGatePreflight.weekly_ops_runtime_ui_mode_violation_total,
        weekly_ops_runtime_ui_mode_violation_run_rate_percent:
          releaseGatePreflight.weekly_ops_runtime_ui_mode_violation_run_rate_percent,
        weekly_ops_runtime_ui_mode_violation_rate_max_percent:
          releaseGatePreflight.weekly_ops_runtime_ui_mode_violation_rate_max_percent
      }
    },
    recommended_commands: []
  };
  result.recommended_commands = buildAutoHandoffPreflightCheckRecommendations(projectPath, result);
  return result;
}

function extractAutoObservabilityWeeklyOpsStopTelemetry(observabilitySnapshotCandidate) {
  const observabilitySnapshot = observabilitySnapshotCandidate &&
    typeof observabilitySnapshotCandidate === 'object' &&
    !Array.isArray(observabilitySnapshotCandidate)
    ? observabilitySnapshotCandidate
    : null;
  if (!observabilitySnapshot) {
    return null;
  }
  const highlights = observabilitySnapshot.highlights && typeof observabilitySnapshot.highlights === 'object'
    ? observabilitySnapshot.highlights
    : {};
  const snapshots = observabilitySnapshot.snapshots && typeof observabilitySnapshot.snapshots === 'object'
    ? observabilitySnapshot.snapshots
    : {};
  const weeklyOpsStop = snapshots.governance_weekly_ops_stop && typeof snapshots.governance_weekly_ops_stop === 'object'
    ? snapshots.governance_weekly_ops_stop
    : {};
  const toNumber = value => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const pickNumber = (primary, fallback) => (
    Number.isFinite(primary) ? primary : (Number.isFinite(fallback) ? fallback : null)
  );

  const sessions = pickNumber(
    toNumber(highlights.governance_weekly_ops_stop_sessions),
    toNumber(weeklyOpsStop.sessions)
  );
  const sessionRatePercent = pickNumber(
    toNumber(highlights.governance_weekly_ops_stop_session_rate_percent),
    toNumber(weeklyOpsStop.session_rate_percent)
  );
  const highPressureSessions = pickNumber(
    toNumber(highlights.governance_weekly_ops_high_pressure_sessions),
    toNumber(weeklyOpsStop.high_pressure_sessions)
  );
  const highPressureRatePercent = pickNumber(
    toNumber(highlights.governance_weekly_ops_high_pressure_rate_percent),
    toNumber(weeklyOpsStop.high_pressure_session_rate_percent)
  );
  const configWarningPositiveSessions = pickNumber(
    toNumber(highlights.governance_weekly_ops_config_warning_positive_sessions),
    toNumber(weeklyOpsStop.config_warning_positive_sessions)
  );
  const authTierPressureSessions = pickNumber(
    toNumber(highlights.governance_weekly_ops_auth_tier_pressure_sessions),
    toNumber(weeklyOpsStop.auth_tier_pressure_sessions)
  );
  const dialogueAuthorizationPressureSessions = pickNumber(
    toNumber(highlights.governance_weekly_ops_dialogue_authorization_pressure_sessions),
    toNumber(weeklyOpsStop.dialogue_authorization_pressure_sessions)
  );
  const runtimeBlockRateHighSessions = pickNumber(
    toNumber(highlights.governance_weekly_ops_runtime_block_rate_high_sessions),
    toNumber(weeklyOpsStop.runtime_block_rate_high_sessions)
  );
  const runtimeUiModeViolationHighSessions = pickNumber(
    toNumber(highlights.governance_weekly_ops_runtime_ui_mode_violation_high_sessions),
    toNumber(weeklyOpsStop.runtime_ui_mode_violation_high_sessions)
  );
  const runtimeUiModeViolationTotalSum = pickNumber(
    toNumber(highlights.governance_weekly_ops_runtime_ui_mode_violation_total_sum),
    toNumber(weeklyOpsStop.runtime_ui_mode_violation_total_sum)
  );
  const hasSignal = (
    Number.isFinite(sessions) ||
    Number.isFinite(sessionRatePercent) ||
    Number.isFinite(highPressureSessions) ||
    Number.isFinite(highPressureRatePercent) ||
    Number.isFinite(configWarningPositiveSessions) ||
    Number.isFinite(authTierPressureSessions) ||
    Number.isFinite(dialogueAuthorizationPressureSessions) ||
    Number.isFinite(runtimeBlockRateHighSessions) ||
    Number.isFinite(runtimeUiModeViolationHighSessions) ||
    Number.isFinite(runtimeUiModeViolationTotalSum)
  );
  if (!hasSignal) {
    return null;
  }
  return {
    sessions,
    session_rate_percent: sessionRatePercent,
    high_pressure_sessions: highPressureSessions,
    high_pressure_rate_percent: highPressureRatePercent,
    config_warning_positive_sessions: configWarningPositiveSessions,
    auth_tier_pressure_sessions: authTierPressureSessions,
    dialogue_authorization_pressure_sessions: dialogueAuthorizationPressureSessions,
    runtime_block_rate_high_sessions: runtimeBlockRateHighSessions,
    runtime_ui_mode_violation_high_sessions: runtimeUiModeViolationHighSessions,
    runtime_ui_mode_violation_total_sum: runtimeUiModeViolationTotalSum
  };
}

function buildAutoHandoffRunFailureSummary(result = {}) {
  const phases = Array.isArray(result && result.phases) ? result.phases : [];
  const failedPhase = phases.find(item => item && item.status === 'failed') || null;
  const gates = result && result.gates && typeof result.gates === 'object'
    ? result.gates
    : {};
  const gateReasons = Array.isArray(gates.reasons) ? gates.reasons : [];
  const releaseGatePreflight = result && result.release_gate_preflight && typeof result.release_gate_preflight === 'object'
    ? result.release_gate_preflight
    : null;
  const releaseGateReasons = releaseGatePreflight && Array.isArray(releaseGatePreflight.reasons)
    ? releaseGatePreflight.reasons
    : [];
  const moquiBaseline = result && result.moqui_baseline && typeof result.moqui_baseline === 'object'
    ? result.moqui_baseline
    : null;
  const moquiCompare = moquiBaseline && moquiBaseline.compare && typeof moquiBaseline.compare === 'object'
    ? moquiBaseline.compare
    : {};
  const moquiMatrixRegressions = buildAutoHandoffMoquiCoverageRegressions(moquiCompare);
  const observabilityWeeklyOps = extractAutoObservabilityWeeklyOpsStopTelemetry(
    result && result.observability_snapshot
  );
  const highlights = [];
  if (typeof result.error === 'string' && result.error.trim()) {
    highlights.push(`error: ${result.error.trim()}`);
  }
  if (gateReasons.length > 0) {
    highlights.push(`gate: ${gateReasons.join('; ')}`);
  }
  if (releaseGatePreflight && releaseGatePreflight.blocked === true) {
    highlights.push(
      `release_gate_preflight: ${releaseGateReasons.length > 0 ? releaseGateReasons.join('; ') : 'blocked'}`
    );
  }
  if (failedPhase && failedPhase.id) {
    highlights.push(`phase: ${failedPhase.id}${failedPhase.error ? ` (${failedPhase.error})` : ''}`);
  }
  if (moquiMatrixRegressions.length > 0) {
    highlights.push(
      `moqui_matrix_regression: ${moquiMatrixRegressions.slice(0, 3).map(item => `${item.label}:${item.delta_rate_percent}%`).join(' | ')}`
    );
  }
  if (
    observabilityWeeklyOps &&
    Number.isFinite(observabilityWeeklyOps.sessions) &&
    observabilityWeeklyOps.sessions > 0
  ) {
    highlights.push(
      `observability_weekly_ops_stop: sessions=${observabilityWeeklyOps.sessions}, ` +
      `high_pressure=${Number.isFinite(observabilityWeeklyOps.high_pressure_sessions) ? observabilityWeeklyOps.high_pressure_sessions : 0}, ` +
      `config_warning=${Number.isFinite(observabilityWeeklyOps.config_warning_positive_sessions) ? observabilityWeeklyOps.config_warning_positive_sessions : 0}, ` +
      `auth_tier=${Number.isFinite(observabilityWeeklyOps.auth_tier_pressure_sessions) ? observabilityWeeklyOps.auth_tier_pressure_sessions : 0}, ` +
      `dialogue=${Number.isFinite(observabilityWeeklyOps.dialogue_authorization_pressure_sessions) ? observabilityWeeklyOps.dialogue_authorization_pressure_sessions : 0}, ` +
      `runtime_block=${Number.isFinite(observabilityWeeklyOps.runtime_block_rate_high_sessions) ? observabilityWeeklyOps.runtime_block_rate_high_sessions : 0}, ` +
      `runtime_ui_mode=${Number.isFinite(observabilityWeeklyOps.runtime_ui_mode_violation_high_sessions) ? observabilityWeeklyOps.runtime_ui_mode_violation_high_sessions : 0}, ` +
      `runtime_ui_mode_total=${Number.isFinite(observabilityWeeklyOps.runtime_ui_mode_violation_total_sum) ? observabilityWeeklyOps.runtime_ui_mode_violation_total_sum : 0}`
    );
  }
  return {
    status: normalizeHandoffText(result && result.status),
    failed_phase: failedPhase
      ? {
        id: normalizeHandoffText(failedPhase.id),
        title: normalizeHandoffText(failedPhase.title),
        error: normalizeHandoffText(failedPhase.error)
      }
      : null,
    gate_failed: gates.passed === false,
    gate_reasons: gateReasons,
    moqui_matrix_regressions: moquiMatrixRegressions,
    release_gate_preflight_blocked: Boolean(releaseGatePreflight && releaseGatePreflight.blocked === true),
    release_gate_preflight_reasons: releaseGateReasons,
    highlights
  };
}

function collectHandoffBlockers(resultItem) {
  const blockers = [];
  if (!resultItem) {
    return blockers;
  }
  if (typeof resultItem.error === 'string' && resultItem.error.trim().length > 0) {
    blockers.push(resultItem.error.trim());
  }
  const status = typeof resultItem.status === 'string' ? resultItem.status.trim().toLowerCase() : 'unknown';
  if (status !== 'completed' && blockers.length === 0) {
    blockers.push(`close-loop-batch status: ${status || 'unknown'}`);
  }
  return blockers;
}

function buildAutoHandoffSpecStatus(handoffSpecs = [], batchSummary = null, baselineSummary = null) {
  const specs = Array.isArray(handoffSpecs)
    ? handoffSpecs.map(item => `${item || ''}`.trim()).filter(Boolean)
    : [];
  const results = Array.isArray(batchSummary && batchSummary.results) ? batchSummary.results : [];
  const baselineResults = Array.isArray(baselineSummary && baselineSummary.results) ? baselineSummary.results : [];

  const statuses = specs.map(specName => {
    const expectedPrefix = `integrate handoff spec ${specName}`.toLowerCase();
    const currentResult = results.find(item => {
      const goal = `${item && item.goal ? item.goal : ''}`.trim().toLowerCase();
      return goal.startsWith(expectedPrefix);
    }) || null;
    const baselineResult = currentResult ? null : baselineResults.find(item => {
      const goal = `${item && item.goal ? item.goal : ''}`.trim().toLowerCase();
      return goal.startsWith(expectedPrefix);
    }) || null;
    const effectiveResult = currentResult || baselineResult;
    const status = effectiveResult && typeof effectiveResult.status === 'string'
      ? effectiveResult.status
      : 'missing';
    const blockers = effectiveResult
      ? collectHandoffBlockers(effectiveResult)
      : ['missing close-loop-batch result for spec integration goal'];
    const success = status === 'completed';
    return {
      spec: specName,
      status,
      success,
      blockers,
      source: currentResult
        ? 'current-run'
        : (baselineResult ? 'continued-from' : 'missing')
    };
  });

  const total = statuses.length;
  const successful = statuses.filter(item => item.success).length;
  const blocked = statuses.filter(item => item.blockers.length > 0).length;
  const successRate = total > 0
    ? Number(((successful / total) * 100).toFixed(2))
    : 100;

  return {
    total_specs: total,
    successful_specs: successful,
    blocked_specs: blocked,
    success_rate_percent: successRate,
    items: statuses
  };
}

function evaluateAutoHandoffRunGates(context = {}) {
  const policy = context.policy || {
    min_spec_success_rate: 100,
    max_risk_level: 'high',
    min_ontology_score: 0,
    max_moqui_matrix_regressions: 0,
    max_unmapped_rules: null,
    max_undecided_decisions: null,
    require_ontology_validation: true,
    require_scene_package_batch: true,
    require_capability_coverage: true,
    require_capability_lexicon: true
  };
  const dryRun = Boolean(context.dryRun);
  const specStatus = context.specStatus || {
    success_rate_percent: 100
  };
  const ontology = context.ontology || {
    present: false,
    passed: false
  };
  const moquiBaseline = context.moquiBaseline && typeof context.moquiBaseline === 'object'
    ? context.moquiBaseline
    : null;
  const moquiCompare = moquiBaseline && moquiBaseline.compare && typeof moquiBaseline.compare === 'object'
    ? moquiBaseline.compare
    : {};
  const moquiMatrixRegressions = buildAutoHandoffMoquiCoverageRegressions(moquiCompare);
  const scenePackageBatch = context.scenePackageBatch && typeof context.scenePackageBatch === 'object'
    ? context.scenePackageBatch
    : null;
  const capabilityCoverage = context.capabilityCoverage && typeof context.capabilityCoverage === 'object'
    ? context.capabilityCoverage
    : null;
  const kpi = context.programKpi || {
    risk_level: 'high'
  };
  const riskLevel = `${kpi.risk_level || 'high'}`.trim().toLowerCase();
  const riskRank = {
    low: 1,
    medium: 2,
    high: 3
  };

  const reasons = [];
  if (!dryRun) {
    const successRate = Number(specStatus.success_rate_percent);
    if (!Number.isFinite(successRate)) {
      reasons.push('spec_success_rate_percent unavailable');
    } else if (successRate < policy.min_spec_success_rate) {
      reasons.push(`spec_success_rate_percent ${successRate} < required ${policy.min_spec_success_rate}`);
    }

    if ((riskRank[riskLevel] || 3) > (riskRank[policy.max_risk_level] || 3)) {
      reasons.push(`risk_level ${riskLevel} exceeds allowed ${policy.max_risk_level}`);
    }
  }

  reasons.push(...evaluateAutoHandoffOntologyGateReasons(policy, ontology));
  reasons.push(...evaluateAutoHandoffMoquiBaselineGateReasons(policy, moquiBaseline));
  reasons.push(...evaluateAutoHandoffScenePackageBatchGateReasons(policy, scenePackageBatch));
  reasons.push(...evaluateAutoHandoffCapabilityCoverageGateReasons(policy, capabilityCoverage));
  reasons.push(...evaluateAutoHandoffCapabilityLexiconGateReasons(policy, capabilityCoverage));

  return {
    passed: reasons.length === 0,
    dry_run: dryRun,
    policy,
    actual: {
      spec_success_rate_percent: Number(specStatus.success_rate_percent),
      risk_level: riskLevel,
      ontology_validation_present: Boolean(ontology.present),
      ontology_validation_passed: Boolean(ontology.passed),
      ontology_validation_status: ontology.status || null,
      ontology_quality_score: Number.isFinite(Number(ontology.quality_score))
        ? Number(ontology.quality_score)
        : null,
      ontology_business_rule_unmapped: Number.isFinite(
        Number(ontology && ontology.metrics ? ontology.metrics.business_rule_unmapped : null)
      )
        ? Number(ontology.metrics.business_rule_unmapped)
        : null,
      ontology_decision_undecided: Number.isFinite(
        Number(ontology && ontology.metrics ? ontology.metrics.decision_undecided : null)
      )
        ? Number(ontology.metrics.decision_undecided)
        : null,
      ontology_business_rule_pass_rate_percent: Number.isFinite(
        Number(ontology && ontology.metrics ? ontology.metrics.business_rule_pass_rate_percent : null)
      )
        ? Number(ontology.metrics.business_rule_pass_rate_percent)
        : null,
      ontology_decision_resolved_rate_percent: Number.isFinite(
        Number(ontology && ontology.metrics ? ontology.metrics.decision_resolved_rate_percent : null)
      )
        ? Number(ontology.metrics.decision_resolved_rate_percent)
        : null,
      moqui_baseline_status: normalizeHandoffText(moquiBaseline && moquiBaseline.status),
      moqui_baseline_portfolio_passed: Boolean(
        moquiBaseline &&
        moquiBaseline.summary &&
        moquiBaseline.summary.portfolio_passed === true
      ),
      moqui_matrix_regression_count: moquiMatrixRegressions.length,
      max_moqui_matrix_regressions: Number.isInteger(policy.max_moqui_matrix_regressions)
        ? Number(policy.max_moqui_matrix_regressions)
        : null,
      scene_package_batch_status: normalizeHandoffText(scenePackageBatch && scenePackageBatch.status),
      scene_package_batch_passed: Boolean(scenePackageBatch && scenePackageBatch.status === 'passed'),
      capability_coverage_status: normalizeHandoffText(capabilityCoverage && capabilityCoverage.status),
      capability_coverage_percent: Number.isFinite(
        Number(capabilityCoverage && capabilityCoverage.summary ? capabilityCoverage.summary.coverage_percent : null)
      )
        ? Number(capabilityCoverage.summary.coverage_percent)
        : null,
      capability_expected_unknown_count: Array.isArray(
        capabilityCoverage && capabilityCoverage.normalization
          ? capabilityCoverage.normalization.expected_unknown
          : null
      )
        ? capabilityCoverage.normalization.expected_unknown.length
        : null,
      capability_provided_unknown_count: Array.isArray(
        capabilityCoverage && capabilityCoverage.normalization
          ? capabilityCoverage.normalization.provided_unknown
          : null
      )
        ? capabilityCoverage.normalization.provided_unknown.length
        : null,
      require_capability_lexicon: policy.require_capability_lexicon === true
    },
    reasons
  };
}

function buildAutoHandoffRunRecommendations(projectPath, result) {
  const recommendations = [];
  const seen = new Set();
  const push = value => {
    const text = `${value || ''}`.trim();
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    recommendations.push(text);
  };

  const manifestPath = typeof result.manifest_path === 'string' && result.manifest_path.trim().length > 0
    ? result.manifest_path
    : null;
  const manifestCli = manifestPath
    ? quoteCliArg(toAutoHandoffCliPath(projectPath, manifestPath))
    : '<manifest>';
  const summary = result && result.batch_summary && typeof result.batch_summary === 'object'
    ? result.batch_summary
    : null;
  const totalGoals = Number(summary && summary.total_goals) || 0;
  const processedGoals = Number(summary && summary.processed_goals) || 0;
  const failedGoals = Number(summary && summary.failed_goals) || 0;
  const hasPendingOrFailed = totalGoals > 0 && (failedGoals > 0 || processedGoals < totalGoals);
  const moquiBaseline = result && result.moqui_baseline && typeof result.moqui_baseline === 'object'
    ? result.moqui_baseline
    : null;
  const moquiSummary = moquiBaseline && moquiBaseline.summary && typeof moquiBaseline.summary === 'object'
    ? moquiBaseline.summary
    : null;
  const moquiCompare = moquiBaseline && moquiBaseline.compare && typeof moquiBaseline.compare === 'object'
    ? moquiBaseline.compare
    : {};
  const moquiCoverageRegressions = buildAutoHandoffMoquiCoverageRegressions(moquiCompare);
  const observabilityWeeklyOps = extractAutoObservabilityWeeklyOpsStopTelemetry(
    result && result.observability_snapshot
  );
  const pushMoquiClusterFirstRecoverySequence = () => {
    const lines = buildMoquiRegressionRecoverySequenceLines({
      clusterGoalsArg: quoteCliArg(AUTO_HANDOFF_MOQUI_CLUSTER_REMEDIATION_FILE),
      baselineArg: quoteCliArg(AUTO_HANDOFF_MOQUI_BASELINE_JSON_FILE),
      wrapCommands: false,
      withPeriod: false
    });
    for (const line of lines) {
      push(line);
    }
  };

  if (manifestPath && result.session_id && hasPendingOrFailed) {
    push(
      `sce auto handoff run --manifest ${manifestCli} ` +
      `--continue-from ${quoteCliArg(result.session_id)} --continue-strategy auto --json`
    );
  }

  if (
    result.status === 'failed' &&
    typeof result.error === 'string' &&
    result.error.toLowerCase().includes('ontology validation gate failed') &&
    manifestPath
  ) {
    push(
      `Ensure manifest ontology_validation is present and passed, then rerun: ` +
      `sce auto handoff run --manifest ${manifestCli} --json`
    );
    if (result.error.toLowerCase().includes('ontology_quality_score')) {
      push(`sce auto handoff run --manifest ${manifestCli} --min-ontology-score 80 --json`);
    }
    if (result.error.toLowerCase().includes('business_rule_unmapped')) {
      push(`sce auto handoff run --manifest ${manifestCli} --max-unmapped-rules 0 --json`);
    }
    if (result.error.toLowerCase().includes('decision_undecided')) {
      push(`sce auto handoff run --manifest ${manifestCli} --max-undecided-decisions 0 --json`);
    }
  }

  const gateActual = result && result.gates && result.gates.actual ? result.gates.actual : {};
  const ontologyScore = Number(gateActual.ontology_quality_score);
  if (manifestPath && Number.isFinite(ontologyScore) && ontologyScore < 80) {
    push(`sce auto handoff run --manifest ${manifestCli} --min-ontology-score 80 --json`);
  }
  const unmappedRules = Number(gateActual.ontology_business_rule_unmapped);
  if (manifestPath && Number.isFinite(unmappedRules) && unmappedRules > 0) {
    push(`sce auto handoff run --manifest ${manifestCli} --max-unmapped-rules 0 --json`);
  }
  const undecidedDecisions = Number(gateActual.ontology_decision_undecided);
  if (manifestPath && Number.isFinite(undecidedDecisions) && undecidedDecisions > 0) {
    push(`sce auto handoff run --manifest ${manifestCli} --max-undecided-decisions 0 --json`);
  }

  if (result.template_diff && result.template_diff.compatibility === 'needs-sync' && manifestPath) {
    push(`sce auto handoff template-diff --manifest ${manifestCli} --json`);
  }

  if (result.session_id) {
    push(`sce auto handoff regression --session-id ${quoteCliArg(result.session_id)} --json`);
  }

  const releaseGatePreflight = result && result.release_gate_preflight && typeof result.release_gate_preflight === 'object'
    ? result.release_gate_preflight
    : null;
  if (releaseGatePreflight && releaseGatePreflight.blocked === true) {
    push('sce auto handoff evidence --window 5 --json');
    if (
      Array.isArray(releaseGatePreflight.reasons) &&
      releaseGatePreflight.reasons.some(item => (
        `${item}`.includes('scene-batch') || `${item}`.includes('drift')
      ))
    ) {
      push(
        'sce scene package-publish-batch --manifest docs/handoffs/handoff-manifest.json ' +
        '--dry-run --ontology-task-queue-out .sce/auto/ontology-remediation.lines --json'
      );
    }
  }
  if (
    releaseGatePreflight &&
    releaseGatePreflight.available !== true &&
    releaseGatePreflight.file
  ) {
    push(
      'sce auto handoff gate-index ' +
      '--dir .sce/reports/release-evidence ' +
      '--out .sce/reports/release-evidence/release-gate-history.json --json'
    );
  }

  const riskLevel = result && result.gates && result.gates.actual && typeof result.gates.actual.risk_level === 'string'
    ? result.gates.actual.risk_level.trim().toLowerCase()
    : null;
  if (riskLevel === 'high') {
    push('sce auto governance stats --days 14 --json');
  }
  if (
    observabilityWeeklyOps &&
    Number.isFinite(observabilityWeeklyOps.sessions) &&
    observabilityWeeklyOps.sessions > 0
  ) {
    push('node scripts/release-ops-weekly-summary.js --json');
    push('node scripts/release-weekly-ops-gate.js');
    if (
      Number.isFinite(observabilityWeeklyOps.config_warning_positive_sessions) &&
      observabilityWeeklyOps.config_warning_positive_sessions > 0
    ) {
      push(
        'Fix invalid weekly ops threshold variables (`KSE_RELEASE_WEEKLY_OPS_*`) and rerun release gates ' +
        'to clear config warnings.'
      );
    }
    if (
      Number.isFinite(observabilityWeeklyOps.auth_tier_pressure_sessions) &&
      observabilityWeeklyOps.auth_tier_pressure_sessions > 0
    ) {
      push(
        'node scripts/interactive-authorization-tier-evaluate.js ' +
        '--policy docs/interactive-customization/authorization-tier-policy-baseline.json --json'
      );
    }
    if (
      Number.isFinite(observabilityWeeklyOps.dialogue_authorization_pressure_sessions) &&
      observabilityWeeklyOps.dialogue_authorization_pressure_sessions > 0
    ) {
      push(
        'node scripts/interactive-dialogue-governance.js ' +
        '--policy docs/interactive-customization/dialogue-governance-policy-baseline.json ' +
        '--authorization-dialogue-policy docs/interactive-customization/authorization-dialogue-policy-baseline.json --json'
      );
    }
    if (
      Number.isFinite(observabilityWeeklyOps.runtime_ui_mode_violation_high_sessions) &&
      observabilityWeeklyOps.runtime_ui_mode_violation_high_sessions > 0
    ) {
      push('node scripts/interactive-governance-report.js --period weekly --fail-on-alert --json');
      push(
        'Review runtime ui-mode contract in docs/interactive-customization/runtime-mode-policy-baseline.json ' +
        'to keep user-app suggestion-only and route apply actions to ops-console.'
      );
    }
    if (
      Number.isFinite(observabilityWeeklyOps.runtime_block_rate_high_sessions) &&
      observabilityWeeklyOps.runtime_block_rate_high_sessions > 0
    ) {
      push(
        'Tune runtime deny/review pressure and rerun ' +
        'node scripts/interactive-governance-report.js --period weekly --json'
      );
    }
  }

  if (result && result.remediation_queue && result.remediation_queue.file) {
    push(
      `sce auto close-loop-batch ${quoteCliArg(
        toAutoHandoffCliPath(projectPath, result.remediation_queue.file)
      )} --format lines --json`
    );
    if (moquiCoverageRegressions.length > 0) {
      pushMoquiClusterFirstRecoverySequence();
    }
  }

  if (moquiBaseline && moquiBaseline.status === 'error') {
    push('sce scene moqui-baseline --json');
  } else if (moquiSummary && moquiSummary.portfolio_passed === false) {
    push(
      'sce scene moqui-baseline --include-all ' +
      '--compare-with .sce/reports/release-evidence/moqui-template-baseline.json --json'
    );
    push(
      'sce scene package-publish-batch --manifest docs/handoffs/handoff-manifest.json ' +
      '--dry-run --ontology-task-queue-out .sce/auto/ontology-remediation.lines --json'
    );
  }
  if (moquiCoverageRegressions.length > 0) {
    push(
      `Recover Moqui matrix regressions before next handoff run: ` +
      `${moquiCoverageRegressions.slice(0, 3).map(item => `${item.label}:${item.delta_rate_percent}%`).join(' | ')}`
    );
    push(
      'sce scene moqui-baseline --include-all ' +
      '--compare-with .sce/reports/release-evidence/moqui-template-baseline.json --json'
    );
    pushMoquiClusterFirstRecoverySequence();
    if (manifestPath) {
      push(
        `sce auto handoff run --manifest ${manifestCli} ` +
        '--max-moqui-matrix-regressions 0 --json'
      );
      push(
        `sce scene package-publish-batch --manifest ${manifestCli} ` +
        '--dry-run --ontology-task-queue-out .sce/auto/ontology-remediation.lines --json'
      );
    }
  }

  const scenePackageBatch = result && result.scene_package_batch && typeof result.scene_package_batch === 'object'
    ? result.scene_package_batch
    : null;
  if (
    scenePackageBatch &&
    scenePackageBatch.status &&
    ['failed', 'error'].includes(`${scenePackageBatch.status}`.toLowerCase())
  ) {
    push(
      `sce scene package-publish-batch --manifest ${manifestCli} ` +
      '--dry-run --ontology-task-queue-out .sce/auto/ontology-remediation.lines --json'
    );
  }

  const capabilityCoverage = result && result.moqui_capability_coverage && typeof result.moqui_capability_coverage === 'object'
    ? result.moqui_capability_coverage
    : null;
  const capabilitySummary = capabilityCoverage && capabilityCoverage.summary && typeof capabilityCoverage.summary === 'object'
    ? capabilityCoverage.summary
    : null;
  const capabilityNormalization = capabilityCoverage && capabilityCoverage.normalization && typeof capabilityCoverage.normalization === 'object'
    ? capabilityCoverage.normalization
    : null;
  if (capabilityCoverage && capabilityCoverage.status === 'error') {
    push('declare manifest capabilities and rerun `sce auto handoff run` to rebuild capability coverage evidence');
  } else if (capabilitySummary && capabilitySummary.passed === false) {
    push('complete uncovered moqui capabilities and rerun `sce auto handoff run --json`');
  } else if (capabilityCoverage && capabilityCoverage.status === 'skipped') {
    push('declare `capabilities` in handoff manifest to enable machine-checkable moqui capability coverage');
  }
  if (
    capabilityNormalization &&
    Array.isArray(capabilityNormalization.expected_deprecated_aliases) &&
    capabilityNormalization.expected_deprecated_aliases.length > 0
  ) {
    push('replace deprecated manifest capabilities with canonical Moqui capability ids and rerun `sce auto handoff run --json`');
  }
  if (
    capabilityNormalization &&
    Array.isArray(capabilityNormalization.expected_unknown) &&
    capabilityNormalization.expected_unknown.length > 0
  ) {
    push(
      'normalize unknown manifest capabilities and rerun strict gates via ' +
      '`sce auto handoff capability-matrix --manifest docs/handoffs/handoff-manifest.json --fail-on-gap --json`'
    );
  }
  if (
    capabilityNormalization &&
    Array.isArray(capabilityNormalization.provided_unknown) &&
    capabilityNormalization.provided_unknown.length > 0
  ) {
    push(
      'normalize unknown template capabilities via ' +
      '`node scripts/moqui-lexicon-audit.js --manifest docs/handoffs/handoff-manifest.json --template-dir .sce/templates/scene-packages --fail-on-gap --json`'
    );
  }

  return recommendations;
}

function buildAutoHandoffRunSessionId() {
  const now = new Date();
  const stamp = [
    now.getUTCFullYear(),
    `${now.getUTCMonth() + 1}`.padStart(2, '0'),
    `${now.getUTCDate()}`.padStart(2, '0'),
    `${now.getUTCHours()}`.padStart(2, '0'),
    `${now.getUTCMinutes()}`.padStart(2, '0'),
    `${now.getUTCSeconds()}`.padStart(2, '0')
  ].join('');
  const suffix = Math.floor(Math.random() * 100000)
    .toString()
    .padStart(5, '0');
  return `handoff-${stamp}-${suffix}`;
}

function beginAutoHandoffRunPhase(result, id, title) {
  const phase = {
    id,
    title,
    status: 'running',
    started_at: new Date().toISOString(),
    completed_at: null,
    elapsed_ms: null
  };
  result.phases.push(phase);
  return {
    phase,
    startedAt: Date.now()
  };
}

function completeAutoHandoffRunPhase(phaseState, details = null) {
  phaseState.phase.status = 'completed';
  if (details && typeof details === 'object') {
    phaseState.phase.details = details;
  }
  phaseState.phase.completed_at = new Date().toISOString();
  phaseState.phase.elapsed_ms = Math.max(0, Date.now() - phaseState.startedAt);
}

function failAutoHandoffRunPhase(phaseState, error) {
  phaseState.phase.status = 'failed';
  phaseState.phase.error = error && error.message ? error.message : `${error}`;
  phaseState.phase.completed_at = new Date().toISOString();
  phaseState.phase.elapsed_ms = Math.max(0, Date.now() - phaseState.startedAt);
}

function skipAutoHandoffRunPhase(result, id, title, reason) {
  result.phases.push({
    id,
    title,
    status: 'skipped',
    reason,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    elapsed_ms: 0
  });
}

function buildAutoHandoffReleaseEvidenceEntry(projectPath, result, reportFile = null, trendWindow = null) {
  const toNumber = value => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const gate = result && result.gates && typeof result.gates === 'object'
    ? result.gates
    : {};
  const gateActual = gate && gate.actual && typeof gate.actual === 'object'
    ? gate.actual
    : {};
  const ontology = result && result.ontology_validation && typeof result.ontology_validation === 'object'
    ? result.ontology_validation
    : {};
  const ontologyMetrics = ontology && ontology.metrics && typeof ontology.metrics === 'object'
    ? ontology.metrics
    : {};
  const regression = result && result.regression && typeof result.regression === 'object'
    ? result.regression
    : {};
  const regressionDelta = regression && regression.delta && typeof regression.delta === 'object'
    ? regression.delta
    : {};
  const moquiBaseline = result && result.moqui_baseline && typeof result.moqui_baseline === 'object'
    ? result.moqui_baseline
    : {};
  const moquiSummary = moquiBaseline && moquiBaseline.summary && typeof moquiBaseline.summary === 'object'
    ? moquiBaseline.summary
    : {};
  const moquiCompare = moquiBaseline && moquiBaseline.compare && typeof moquiBaseline.compare === 'object'
    ? moquiBaseline.compare
    : {};
  const moquiDeltas = moquiCompare && moquiCompare.deltas && typeof moquiCompare.deltas === 'object'
    ? moquiCompare.deltas
    : {};
  const moquiFailedTemplates = moquiCompare && moquiCompare.failed_templates && typeof moquiCompare.failed_templates === 'object'
    ? moquiCompare.failed_templates
    : {};
  const moquiScopeBreakdown = moquiSummary && moquiSummary.scope_breakdown && typeof moquiSummary.scope_breakdown === 'object'
    ? moquiSummary.scope_breakdown
    : {};
  const moquiCoverageMatrix = moquiSummary && moquiSummary.coverage_matrix && typeof moquiSummary.coverage_matrix === 'object'
    ? moquiSummary.coverage_matrix
    : {};
  const moquiCoverageMatrixDeltas = moquiCompare && moquiCompare.coverage_matrix_deltas
    && typeof moquiCompare.coverage_matrix_deltas === 'object'
    ? moquiCompare.coverage_matrix_deltas
    : {};
  const moquiCoverageMatrixRegressions = buildAutoHandoffMoquiCoverageRegressions(moquiCompare);
  const moquiGapFrequency = Array.isArray(moquiSummary && moquiSummary.gap_frequency)
    ? moquiSummary.gap_frequency
    : [];
  const scenePackageBatch = result && result.scene_package_batch && typeof result.scene_package_batch === 'object'
    ? result.scene_package_batch
    : {};
  const scenePackageBatchSummary = scenePackageBatch && scenePackageBatch.summary && typeof scenePackageBatch.summary === 'object'
    ? scenePackageBatch.summary
    : {};
  const scenePackageBatchGate = scenePackageBatch && scenePackageBatch.batch_ontology_gate && typeof scenePackageBatch.batch_ontology_gate === 'object'
    ? scenePackageBatch.batch_ontology_gate
    : {};
  const capabilityCoverage = result && result.moqui_capability_coverage && typeof result.moqui_capability_coverage === 'object'
    ? result.moqui_capability_coverage
    : {};
  const capabilitySummary = capabilityCoverage && capabilityCoverage.summary && typeof capabilityCoverage.summary === 'object'
    ? capabilityCoverage.summary
    : {};
  const capabilityCompare = capabilityCoverage && capabilityCoverage.compare && typeof capabilityCoverage.compare === 'object'
    ? capabilityCoverage.compare
    : {};
  const capabilityGaps = Array.isArray(capabilityCoverage && capabilityCoverage.gaps)
    ? capabilityCoverage.gaps
    : [];
  const capabilityNormalization = capabilityCoverage && capabilityCoverage.normalization && typeof capabilityCoverage.normalization === 'object'
    ? capabilityCoverage.normalization
    : {};
  const capabilityWarnings = Array.isArray(capabilityCoverage && capabilityCoverage.warnings)
    ? capabilityCoverage.warnings
    : [];
  const batchSummary = result && result.batch_summary && typeof result.batch_summary === 'object'
    ? result.batch_summary
    : {};
  const reportPath = typeof reportFile === 'string' && reportFile.trim().length > 0
    ? reportFile.trim()
    : (
      result && typeof result.output_file === 'string' && result.output_file.trim().length > 0
        ? result.output_file.trim()
        : null
    );

  return {
    session_id: result && result.session_id ? result.session_id : null,
    merged_at: new Date().toISOString(),
    status: result && result.status ? result.status : null,
    dry_run: Boolean(result && result.dry_run),
    manifest_path: result && result.manifest_path ? result.manifest_path : null,
    source_project: result && result.source_project ? result.source_project : null,
    handoff_report_file: reportPath ? toAutoHandoffCliPath(projectPath, reportPath) : null,
    gate: {
      passed: gate.passed === true,
      reasons: Array.isArray(gate.reasons) ? gate.reasons : [],
      actual: {
        spec_success_rate_percent: toNumber(gateActual.spec_success_rate_percent),
        risk_level: normalizeHandoffText(gateActual.risk_level),
        ontology_quality_score: toNumber(gateActual.ontology_quality_score),
        ontology_business_rule_unmapped: toNumber(gateActual.ontology_business_rule_unmapped),
        ontology_decision_undecided: toNumber(gateActual.ontology_decision_undecided),
        capability_expected_unknown_count: toNumber(gateActual.capability_expected_unknown_count),
        capability_provided_unknown_count: toNumber(gateActual.capability_provided_unknown_count)
      }
    },
    release_gate_preflight: result && result.release_gate_preflight && typeof result.release_gate_preflight === 'object'
      ? result.release_gate_preflight
      : null,
    failure_summary: result && result.failure_summary && typeof result.failure_summary === 'object'
      ? result.failure_summary
      : null,
    ontology_validation: {
      status: normalizeHandoffText(ontology.status),
      passed: ontology.passed === true,
      quality_score: toNumber(ontology.quality_score),
      metrics: {
        entity_total: toNumber(ontologyMetrics.entity_total),
        relation_total: toNumber(ontologyMetrics.relation_total),
        business_rule_total: toNumber(ontologyMetrics.business_rule_total),
        business_rule_mapped: toNumber(ontologyMetrics.business_rule_mapped),
        business_rule_unmapped: toNumber(ontologyMetrics.business_rule_unmapped),
        decision_total: toNumber(ontologyMetrics.decision_total),
        decision_resolved: toNumber(ontologyMetrics.decision_resolved),
        decision_undecided: toNumber(ontologyMetrics.decision_undecided),
        business_rule_pass_rate_percent: toNumber(ontologyMetrics.business_rule_pass_rate_percent),
        decision_resolved_rate_percent: toNumber(ontologyMetrics.decision_resolved_rate_percent)
      }
    },
    regression: {
      trend: normalizeHandoffText(regression.trend),
      delta: {
        spec_success_rate_percent: toNumber(regressionDelta.spec_success_rate_percent),
        risk_level_rank: toNumber(regressionDelta.risk_level_rank),
        failed_goals: toNumber(regressionDelta.failed_goals),
        ontology_quality_score: toNumber(regressionDelta.ontology_quality_score),
        ontology_unmapped_rules: toNumber(regressionDelta.ontology_unmapped_rules),
        ontology_undecided_decisions: toNumber(regressionDelta.ontology_undecided_decisions)
      }
    },
    moqui_baseline: {
      status: normalizeHandoffText(moquiBaseline.status),
      generated: moquiBaseline.generated === true,
      reason: normalizeHandoffText(moquiBaseline.reason),
      error: normalizeHandoffText(moquiBaseline.error),
      summary: {
        total_templates: toNumber(moquiSummary.total_templates),
        scoped_templates: toNumber(moquiSummary.scoped_templates),
        avg_score: toNumber(moquiSummary.avg_score),
        valid_rate_percent: toNumber(moquiSummary.valid_rate_percent),
        baseline_passed: toNumber(moquiSummary.baseline_passed),
        baseline_failed: toNumber(moquiSummary.baseline_failed),
        portfolio_passed: moquiSummary.portfolio_passed === true,
        scope_breakdown: {
          moqui_erp: toNumber(moquiScopeBreakdown.moqui_erp),
          scene_orchestration: toNumber(moquiScopeBreakdown.scene_orchestration),
          other: toNumber(moquiScopeBreakdown.other)
        },
        coverage_matrix: moquiCoverageMatrix,
        gap_frequency: moquiGapFrequency
      },
      compare: Object.keys(moquiCompare).length === 0
        ? null
        : {
          previous_generated_at: normalizeHandoffText(moquiCompare.previous_generated_at),
          previous_template_root: normalizeHandoffText(moquiCompare.previous_template_root),
          deltas: {
            scoped_templates: toNumber(moquiDeltas.scoped_templates),
            avg_score: toNumber(moquiDeltas.avg_score),
            valid_rate_percent: toNumber(moquiDeltas.valid_rate_percent),
            baseline_passed: toNumber(moquiDeltas.baseline_passed),
            baseline_failed: toNumber(moquiDeltas.baseline_failed)
          },
          coverage_matrix_deltas: moquiCoverageMatrixDeltas,
          coverage_matrix_regressions: moquiCoverageMatrixRegressions,
          failed_templates: {
            newly_failed: Array.isArray(moquiFailedTemplates.newly_failed) ? moquiFailedTemplates.newly_failed : [],
            recovered: Array.isArray(moquiFailedTemplates.recovered) ? moquiFailedTemplates.recovered : []
          }
        },
      output: {
        json: normalizeHandoffText(moquiBaseline && moquiBaseline.output ? moquiBaseline.output.json : null),
        markdown: normalizeHandoffText(moquiBaseline && moquiBaseline.output ? moquiBaseline.output.markdown : null)
      }
    },
    scene_package_batch: {
      status: normalizeHandoffText(scenePackageBatch.status),
      generated: scenePackageBatch.generated === true,
      reason: normalizeHandoffText(scenePackageBatch.reason),
      error: normalizeHandoffText(scenePackageBatch.error),
      summary: {
        selected: toNumber(scenePackageBatchSummary.selected),
        failed: toNumber(scenePackageBatchSummary.failed),
        skipped: toNumber(scenePackageBatchSummary.skipped),
        batch_gate_passed: scenePackageBatchSummary.batch_gate_passed === true,
        batch_gate_failure_count: toNumber(scenePackageBatchSummary.batch_gate_failure_count),
        ontology_average_score: toNumber(scenePackageBatchSummary.ontology_average_score),
        ontology_valid_rate_percent: toNumber(scenePackageBatchSummary.ontology_valid_rate_percent)
      },
      batch_ontology_gate: {
        passed: scenePackageBatchGate.passed === true,
        failures: Array.isArray(scenePackageBatchGate.failures) ? scenePackageBatchGate.failures : []
      },
      output: {
        json: normalizeHandoffText(scenePackageBatch && scenePackageBatch.output ? scenePackageBatch.output.json : null)
      }
    },
    capability_coverage: {
      status: normalizeHandoffText(capabilityCoverage.status),
      generated: capabilityCoverage.generated === true,
      reason: normalizeHandoffText(capabilityCoverage.reason),
      error: normalizeHandoffText(capabilityCoverage.error),
      summary: {
        total_capabilities: toNumber(capabilitySummary.total_capabilities),
        covered_capabilities: toNumber(capabilitySummary.covered_capabilities),
        uncovered_capabilities: toNumber(capabilitySummary.uncovered_capabilities),
        coverage_percent: toNumber(capabilitySummary.coverage_percent),
        min_required_percent: toNumber(capabilitySummary.min_required_percent),
        passed: capabilitySummary.passed === true
      },
      compare: Object.keys(capabilityCompare).length === 0
        ? null
        : {
          previous_generated_at: normalizeHandoffText(capabilityCompare.previous_generated_at),
          delta_coverage_percent: toNumber(capabilityCompare.delta_coverage_percent),
          delta_covered_capabilities: toNumber(capabilityCompare.delta_covered_capabilities),
          newly_covered: Array.isArray(capabilityCompare.newly_covered) ? capabilityCompare.newly_covered : [],
          newly_uncovered: Array.isArray(capabilityCompare.newly_uncovered) ? capabilityCompare.newly_uncovered : []
        },
      normalization: {
        lexicon_version: normalizeHandoffText(capabilityNormalization.lexicon_version),
        expected_alias_mapped: Array.isArray(capabilityNormalization.expected_alias_mapped) ? capabilityNormalization.expected_alias_mapped : [],
        expected_deprecated_aliases: Array.isArray(capabilityNormalization.expected_deprecated_aliases) ? capabilityNormalization.expected_deprecated_aliases : [],
        expected_unknown: Array.isArray(capabilityNormalization.expected_unknown) ? capabilityNormalization.expected_unknown : [],
        provided_alias_mapped: Array.isArray(capabilityNormalization.provided_alias_mapped) ? capabilityNormalization.provided_alias_mapped : [],
        provided_deprecated_aliases: Array.isArray(capabilityNormalization.provided_deprecated_aliases) ? capabilityNormalization.provided_deprecated_aliases : [],
        provided_unknown: Array.isArray(capabilityNormalization.provided_unknown) ? capabilityNormalization.provided_unknown : []
      },
      gaps: capabilityGaps,
      warnings: capabilityWarnings,
      output: {
        json: normalizeHandoffText(capabilityCoverage && capabilityCoverage.output ? capabilityCoverage.output.json : null),
        markdown: normalizeHandoffText(capabilityCoverage && capabilityCoverage.output ? capabilityCoverage.output.markdown : null)
      }
    },
    batch_summary: {
      status: normalizeHandoffText(batchSummary.status),
      total_goals: toNumber(batchSummary.total_goals),
      processed_goals: toNumber(batchSummary.processed_goals),
      completed_goals: toNumber(batchSummary.completed_goals),
      failed_goals: toNumber(batchSummary.failed_goals)
    },
    continued_from: result && result.continued_from ? result.continued_from : null,
    policy: {
      max_moqui_matrix_regressions: Number.isFinite(
        Number(result && result.policy ? result.policy.max_moqui_matrix_regressions : null)
      )
        ? Number(result.policy.max_moqui_matrix_regressions)
        : null,
      require_capability_lexicon: Boolean(
        result &&
        result.policy &&
        result.policy.require_capability_lexicon === true
      ),
      require_release_gate_preflight: Boolean(
        result &&
        result.policy &&
        result.policy.require_release_gate_preflight === true
      )
    },
    trend_window: trendWindow && typeof trendWindow === 'object'
      ? trendWindow
      : null
  };
}

async function mergeAutoHandoffRunIntoReleaseEvidence(projectPath, result, reportFile = null) {
  const evidenceFile = path.join(projectPath, AUTO_HANDOFF_RELEASE_EVIDENCE_FILE);
  const nowIso = new Date().toISOString();
  let existing = null;
  if (await fs.pathExists(evidenceFile)) {
    try {
      existing = await fs.readJson(evidenceFile);
    } catch (error) {
      throw new Error(`failed to read release evidence JSON: ${evidenceFile} (${error.message})`);
    }
  }

  const existingSessions = existing && Array.isArray(existing.sessions)
    ? existing.sessions.filter(item => item && typeof item === 'object')
    : [];
  let trendWindow = null;
  const trendWindowSize = Number(
    result &&
    result.policy &&
    result.policy.release_evidence_window !== undefined &&
    result.policy.release_evidence_window !== null
      ? result.policy.release_evidence_window
      : 5
  );
  if (Number.isInteger(trendWindowSize) && trendWindowSize >= 2 && trendWindowSize <= 50) {
    try {
      const regressionSnapshot = await buildAutoHandoffRegressionReport(projectPath, {
        sessionId: result && result.session_id ? result.session_id : 'latest',
        window: trendWindowSize
      });
      trendWindow = {
        generated_at: nowIso,
        window: regressionSnapshot.window || {
          requested: trendWindowSize,
          actual: null
        },
        trend: normalizeHandoffText(regressionSnapshot.trend),
        window_trend: regressionSnapshot.window_trend || null,
        aggregates: regressionSnapshot.aggregates || null,
        risk_layers: regressionSnapshot.risk_layers || null
      };
    } catch (error) {
      trendWindow = {
        generated_at: nowIso,
        window: {
          requested: trendWindowSize,
          actual: null
        },
        error: error && error.message ? error.message : `${error}`
      };
    }
  }

  const nextEntry = buildAutoHandoffReleaseEvidenceEntry(projectPath, result, reportFile, trendWindow);
  const sessionId = normalizeHandoffText(nextEntry.session_id);
  let updatedExisting = false;
  const mergedSessions = existingSessions.slice();

  if (sessionId) {
    const existingIndex = mergedSessions.findIndex(item => normalizeHandoffText(item.session_id) === sessionId);
    if (existingIndex >= 0) {
      mergedSessions[existingIndex] = {
        ...mergedSessions[existingIndex],
        ...nextEntry
      };
      updatedExisting = true;
    } else {
      mergedSessions.push(nextEntry);
    }
  } else {
    mergedSessions.push(nextEntry);
  }

  mergedSessions.sort((left, right) => {
    const leftTs = Date.parse(left && (left.merged_at || left.generated_at || left.updated_at) ? (left.merged_at || left.generated_at || left.updated_at) : 0);
    const rightTs = Date.parse(right && (right.merged_at || right.generated_at || right.updated_at) ? (right.merged_at || right.generated_at || right.updated_at) : 0);
    return (Number.isFinite(rightTs) ? rightTs : 0) - (Number.isFinite(leftTs) ? leftTs : 0);
  });

  const generatedAt = existing && typeof existing.generated_at === 'string' && existing.generated_at.trim()
    ? existing.generated_at
    : nowIso;
  const payload = {
    mode: 'auto-handoff-release-evidence',
    generated_at: generatedAt,
    updated_at: nowIso,
    latest_session_id: sessionId || (
      mergedSessions.length > 0 && normalizeHandoffText(mergedSessions[0].session_id)
        ? normalizeHandoffText(mergedSessions[0].session_id)
        : null
    ),
    total_runs: mergedSessions.length,
    latest_trend_window: mergedSessions.length > 0 && mergedSessions[0] && mergedSessions[0].trend_window
      ? mergedSessions[0].trend_window
      : null,
    sessions: mergedSessions
  };

  await fs.ensureDir(path.dirname(evidenceFile));
  await fs.writeJson(evidenceFile, payload, { spaces: 2 });
  return {
    mode: 'auto-handoff-release-evidence',
    merged: true,
    updated_existing: updatedExisting,
    file: evidenceFile,
    latest_session_id: payload.latest_session_id,
    total_runs: payload.total_runs,
    trend_window: nextEntry.trend_window
  };
}

async function writeAutoHandoffRunReport(projectPath, result, outCandidate = null) {
  if (typeof outCandidate === 'string' && outCandidate.trim().length > 0) {
    await maybeWriteOutput(result, outCandidate.trim(), projectPath);
    return;
  }
  const defaultFile = path.join(AUTO_HANDOFF_RUN_REPORT_DIR, `${result.session_id}.json`);
  await maybeWriteOutput(result, defaultFile, projectPath);
}

function buildAutoHandoffMoquiBaselinePhaseDetails(payload) {
  const baseline = payload && typeof payload === 'object' ? payload : {};
  const summary = baseline.summary && typeof baseline.summary === 'object' ? baseline.summary : null;
  const compare = baseline.compare && typeof baseline.compare === 'object' ? baseline.compare : {};
  const regressions = buildAutoHandoffMoquiCoverageRegressions(compare);
  const scopeBreakdown = summary && summary.scope_breakdown && typeof summary.scope_breakdown === 'object'
    ? summary.scope_breakdown
    : null;
  const coverageMatrix = summary && summary.coverage_matrix && typeof summary.coverage_matrix === 'object'
    ? summary.coverage_matrix
    : null;
  const gapFrequency = summary && Array.isArray(summary.gap_frequency)
    ? summary.gap_frequency
    : [];
  return {
    status: baseline.status || 'unknown',
    generated: baseline.generated === true,
    output: baseline.output || null,
    portfolio_passed: summary ? summary.portfolio_passed === true : null,
    avg_score: summary && Number.isFinite(Number(summary.avg_score))
      ? Number(summary.avg_score)
      : null,
    valid_rate_percent: summary && Number.isFinite(Number(summary.valid_rate_percent))
      ? Number(summary.valid_rate_percent)
      : null,
    scope_breakdown: scopeBreakdown,
    coverage_matrix: coverageMatrix,
    gap_frequency_top: gapFrequency.slice(0, 5),
    entity_coverage_rate_percent: getAutoHandoffMoquiCoverageMetric(summary, 'entity_coverage', 'rate_percent'),
    relation_coverage_rate_percent: getAutoHandoffMoquiCoverageMetric(summary, 'relation_coverage', 'rate_percent'),
    business_rule_closed_rate_percent: getAutoHandoffMoquiCoverageMetric(summary, 'business_rule_closed', 'rate_percent'),
    decision_closed_rate_percent: getAutoHandoffMoquiCoverageMetric(summary, 'decision_closed', 'rate_percent'),
    coverage_matrix_deltas: getAutoHandoffMoquiCoverageDeltaMatrix(compare),
    coverage_matrix_regressions: regressions,
    entity_coverage_delta_rate_percent: getAutoHandoffMoquiCoverageDeltaMetric(compare, 'entity_coverage', 'rate_percent'),
    business_rule_closed_delta_rate_percent: getAutoHandoffMoquiCoverageDeltaMetric(compare, 'business_rule_closed', 'rate_percent'),
    decision_closed_delta_rate_percent: getAutoHandoffMoquiCoverageDeltaMetric(compare, 'decision_closed', 'rate_percent'),
    matrix_regression_count: regressions.length
  };
}

function parseAutoHandoffJsonFromCommandStdout(stdoutText = '') {
  const text = `${stdoutText || ''}`.trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    // continue
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch (_error) {
      return null;
    }
  }
  return null;
}

async function buildAutoHandoffMoquiBaselineSnapshot(projectPath) {
  const scriptPath = path.join(projectPath, 'scripts', 'moqui-template-baseline-report.js');
  if (!(await fs.pathExists(scriptPath))) {
    return {
      status: 'skipped',
      generated: false,
      reason: `baseline script missing: ${toAutoHandoffCliPath(projectPath, scriptPath)}`
    };
  }

  const outputJsonPath = path.join(projectPath, AUTO_HANDOFF_MOQUI_BASELINE_JSON_FILE);
  const outputMarkdownPath = path.join(projectPath, AUTO_HANDOFF_MOQUI_BASELINE_MARKDOWN_FILE);
  await fs.ensureDir(path.dirname(outputJsonPath));

  const scriptArgs = [
    scriptPath,
    '--out', outputJsonPath,
    '--markdown-out', outputMarkdownPath,
    '--json'
  ];

  if (await fs.pathExists(outputJsonPath)) {
    scriptArgs.push('--compare-with', outputJsonPath);
  }

  const execution = spawnSync(process.execPath, scriptArgs, {
    cwd: projectPath,
    encoding: 'utf8'
  });

  const stdout = typeof execution.stdout === 'string' ? execution.stdout.trim() : '';
  const stderr = typeof execution.stderr === 'string' ? execution.stderr.trim() : '';

  if (execution.error) {
    return {
      status: 'error',
      generated: false,
      error: execution.error.message
    };
  }

  if (execution.status !== 0) {
    return {
      status: 'error',
      generated: false,
      error: stderr || stdout || `baseline script exited with code ${execution.status}`
    };
  }

  let reportPayload = null;
  try {
    reportPayload = stdout ? JSON.parse(stdout) : await fs.readJson(outputJsonPath);
  } catch (error) {
    return {
      status: 'error',
      generated: false,
      error: `failed to parse baseline payload: ${error.message}`
    };
  }

  const summary = reportPayload && reportPayload.summary && typeof reportPayload.summary === 'object'
    ? reportPayload.summary
    : {};
  const compare = reportPayload && reportPayload.compare && typeof reportPayload.compare === 'object'
    ? reportPayload.compare
    : null;
  const failedTemplates = compare && compare.failed_templates && typeof compare.failed_templates === 'object'
    ? compare.failed_templates
    : {};
  const scopeBreakdown = summary && summary.scope_breakdown && typeof summary.scope_breakdown === 'object'
    ? summary.scope_breakdown
    : {};
  const coverageMatrix = summary && summary.coverage_matrix && typeof summary.coverage_matrix === 'object'
    ? summary.coverage_matrix
    : {};
  const gapFrequency = summary && Array.isArray(summary.gap_frequency)
    ? summary.gap_frequency
    : [];

  return {
    status: summary.portfolio_passed === true ? 'passed' : 'failed',
    generated: true,
    summary: {
      total_templates: Number(summary.total_templates) || 0,
      scoped_templates: Number(summary.scoped_templates) || 0,
      avg_score: Number.isFinite(Number(summary.avg_score)) ? Number(summary.avg_score) : null,
      valid_rate_percent: Number.isFinite(Number(summary.valid_rate_percent)) ? Number(summary.valid_rate_percent) : null,
      baseline_passed: Number(summary.baseline_passed) || 0,
      baseline_failed: Number(summary.baseline_failed) || 0,
      portfolio_passed: summary.portfolio_passed === true,
      scope_breakdown: {
        moqui_erp: Number(scopeBreakdown.moqui_erp) || 0,
        scene_orchestration: Number(scopeBreakdown.scene_orchestration) || 0,
        other: Number(scopeBreakdown.other) || 0
      },
      coverage_matrix: coverageMatrix,
      gap_frequency: gapFrequency
    },
    compare: compare
      ? {
        previous_generated_at: compare.previous_generated_at || null,
        previous_template_root: compare.previous_template_root || null,
        deltas: compare.deltas || null,
        coverage_matrix_deltas: compare.coverage_matrix_deltas || null,
        coverage_matrix_regressions: buildAutoHandoffMoquiCoverageRegressions(compare),
        failed_templates: {
          previous: Array.isArray(failedTemplates.previous) ? failedTemplates.previous : [],
          current: Array.isArray(failedTemplates.current) ? failedTemplates.current : [],
          newly_failed: Array.isArray(failedTemplates.newly_failed) ? failedTemplates.newly_failed : [],
          recovered: Array.isArray(failedTemplates.recovered) ? failedTemplates.recovered : []
        }
      }
      : null,
    output: {
      json: toAutoHandoffCliPath(projectPath, outputJsonPath),
      markdown: toAutoHandoffCliPath(projectPath, outputMarkdownPath)
    },
    warnings: stderr ? [stderr] : []
  };
}

function buildAutoHandoffScenePackageBatchPhaseDetails(payload) {
  const batch = payload && typeof payload === 'object' ? payload : {};
  const summary = batch.summary && typeof batch.summary === 'object' ? batch.summary : null;
  return {
    status: batch.status || 'unknown',
    generated: batch.generated === true,
    output: batch.output || null,
    selected: summary && Number.isFinite(Number(summary.selected))
      ? Number(summary.selected)
      : null,
    failed: summary && Number.isFinite(Number(summary.failed))
      ? Number(summary.failed)
      : null,
    batch_gate_passed: summary ? summary.batch_gate_passed === true : null
  };
}

async function buildAutoHandoffScenePackageBatchSnapshot(projectPath, manifestPath) {
  const manifestFile = normalizeHandoffText(manifestPath);
  if (!manifestFile) {
    return {
      status: 'skipped',
      generated: false,
      reason: 'manifest path unavailable for scene package batch gate'
    };
  }
  if (!(await fs.pathExists(AUTO_HANDOFF_CLI_SCRIPT_FILE))) {
    return {
      status: 'skipped',
      generated: false,
      reason: `sce cli script missing: ${toAutoHandoffCliPath(projectPath, AUTO_HANDOFF_CLI_SCRIPT_FILE)}`
    };
  }

  const outputJsonPath = path.join(projectPath, AUTO_HANDOFF_SCENE_PACKAGE_BATCH_JSON_FILE);
  const taskQueuePath = path.join(projectPath, AUTO_HANDOFF_SCENE_PACKAGE_BATCH_TASK_QUEUE_FILE);
  await fs.ensureDir(path.dirname(outputJsonPath));

  const execution = spawnSync(
    process.execPath,
    [
      AUTO_HANDOFF_CLI_SCRIPT_FILE,
      'scene',
      'package-publish-batch',
      '--manifest', manifestFile,
      '--dry-run',
      '--ontology-report-out', outputJsonPath,
      '--ontology-task-queue-out', taskQueuePath,
      '--json'
    ],
    {
      cwd: projectPath,
      encoding: 'utf8'
    }
  );

  const stdout = typeof execution.stdout === 'string' ? execution.stdout.trim() : '';
  const stderr = typeof execution.stderr === 'string' ? execution.stderr.trim() : '';

  if (execution.error) {
    return {
      status: 'error',
      generated: false,
      error: execution.error.message
    };
  }

  const payload = parseAutoHandoffJsonFromCommandStdout(stdout);
  if (!payload || typeof payload !== 'object') {
    const missingSpecArray = /manifest spec array (not found|is empty)/i.test(stderr);
    if (missingSpecArray) {
      return {
        status: 'skipped',
        generated: false,
        reason: 'manifest specs are not scene package batch compatible',
        warnings: stderr ? [stderr] : []
      };
    }
    return {
      status: 'error',
      generated: false,
      error: stderr || stdout || `scene package publish-batch exited with code ${execution.status}`,
      warnings: stderr ? [stderr] : []
    };
  }

  const summary = payload.summary && typeof payload.summary === 'object'
    ? payload.summary
    : {};
  const ontologySummary = payload.ontology_summary && typeof payload.ontology_summary === 'object'
    ? payload.ontology_summary
    : {};
  const batchGate = payload.batch_ontology_gate && typeof payload.batch_ontology_gate === 'object'
    ? payload.batch_ontology_gate
    : {};
  const batchGateFailures = Array.isArray(batchGate.failures) ? batchGate.failures : [];
  const selected = Number(summary.selected) || 0;
  const failed = Number(summary.failed) || 0;

  if (selected <= 0 && failed <= 0) {
    return {
      status: 'skipped',
      generated: false,
      reason: 'no scene package publish candidates were selected from handoff manifest',
      summary: {
        selected,
        published: Number(summary.published) || 0,
        planned: Number(summary.planned) || 0,
        failed,
        skipped: Number(summary.skipped) || 0,
        batch_gate_passed: batchGate.passed === true,
        batch_gate_failure_count: batchGateFailures.length
      },
      output: {
        json: toAutoHandoffCliPath(projectPath, outputJsonPath)
      },
      warnings: stderr ? [stderr] : []
    };
  }

  return {
    status: payload.success === true ? 'passed' : 'failed',
    generated: true,
    mode: payload.mode || 'dry-run',
    success: payload.success === true,
    manifest: normalizeHandoffText(payload.manifest),
    summary: {
      selected,
      published: Number(summary.published) || 0,
      planned: Number(summary.planned) || 0,
      failed,
      skipped: Number(summary.skipped) || 0,
      batch_gate_passed: batchGate.passed === true,
      batch_gate_failure_count: batchGateFailures.length,
      ontology_average_score: Number.isFinite(Number(ontologySummary.average_score))
        ? Number(ontologySummary.average_score)
        : null,
      ontology_valid_rate_percent: Number.isFinite(Number(ontologySummary.valid_rate_percent))
        ? Number(ontologySummary.valid_rate_percent)
        : null
    },
    failures: Array.isArray(payload.failures)
      ? payload.failures.map(item => ({
        spec: normalizeHandoffText(item && item.spec),
        error: normalizeHandoffText(item && item.error)
      }))
      : [],
    batch_ontology_gate: {
      passed: batchGate.passed === true,
      failures: batchGateFailures.map(item => ({
        id: normalizeHandoffText(item && item.id),
        message: normalizeHandoffText(item && item.message)
      }))
    },
    task_queue: payload.ontology_task_queue && typeof payload.ontology_task_queue === 'object'
      ? {
        output_path: normalizeHandoffText(payload.ontology_task_queue.output_path),
        task_count: Number(payload.ontology_task_queue.task_count) || 0
      }
      : null,
    output: {
      json: toAutoHandoffCliPath(projectPath, outputJsonPath)
    },
    warnings: stderr ? [stderr] : []
  };
}

function normalizeMoquiCapabilityToken(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = `${value}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : null;
}

function buildMoquiCapabilityLexiconIndex(rawLexicon = {}) {
  const aliasToCanonical = new Map();
  const deprecatedAliasToCanonical = new Map();
  const canonicalSet = new Set();
  const entries = Array.isArray(rawLexicon && rawLexicon.capabilities)
    ? rawLexicon.capabilities
    : [];

  for (const entry of entries) {
    const canonical = normalizeMoquiCapabilityToken(entry && entry.canonical);
    if (!canonical) {
      continue;
    }
    canonicalSet.add(canonical);
    aliasToCanonical.set(canonical, canonical);

    const aliases = Array.isArray(entry && entry.aliases) ? entry.aliases : [];
    for (const alias of aliases) {
      const normalizedAlias = normalizeMoquiCapabilityToken(alias);
      if (!normalizedAlias) {
        continue;
      }
      aliasToCanonical.set(normalizedAlias, canonical);
    }

    const deprecatedAliases = Array.isArray(entry && entry.deprecated_aliases)
      ? entry.deprecated_aliases
      : [];
    for (const deprecatedAlias of deprecatedAliases) {
      const normalizedDeprecatedAlias = normalizeMoquiCapabilityToken(deprecatedAlias);
      if (!normalizedDeprecatedAlias) {
        continue;
      }
      aliasToCanonical.set(normalizedDeprecatedAlias, canonical);
      deprecatedAliasToCanonical.set(normalizedDeprecatedAlias, canonical);
    }
  }

  return {
    version: rawLexicon && rawLexicon.version ? `${rawLexicon.version}` : null,
    source: rawLexicon && rawLexicon.source ? `${rawLexicon.source}` : null,
    canonical_set: canonicalSet,
    alias_to_canonical: aliasToCanonical,
    deprecated_alias_to_canonical: deprecatedAliasToCanonical
  };
}

function resolveMoquiCapabilityDescriptor(value, lexiconIndex = MOQUI_CAPABILITY_LEXICON_INDEX) {
  const normalized = normalizeMoquiCapabilityToken(value);
  if (!normalized) {
    return null;
  }

  const aliasToCanonical = lexiconIndex && lexiconIndex.alias_to_canonical instanceof Map
    ? lexiconIndex.alias_to_canonical
    : new Map();
  const deprecatedAliasToCanonical = lexiconIndex && lexiconIndex.deprecated_alias_to_canonical instanceof Map
    ? lexiconIndex.deprecated_alias_to_canonical
    : new Map();
  const canonicalSet = lexiconIndex && lexiconIndex.canonical_set instanceof Set
    ? lexiconIndex.canonical_set
    : new Set();

  const canonical = aliasToCanonical.get(normalized) || normalized;
  const deprecatedCanonical = deprecatedAliasToCanonical.get(normalized) || null;
  const isDeprecatedAlias = Boolean(deprecatedCanonical);
  const isAlias = !isDeprecatedAlias && normalized !== canonical;
  const isKnown = canonicalSet.has(canonical);

  return {
    raw: `${value}`,
    normalized,
    canonical,
    is_known: isKnown,
    is_alias: isAlias,
    is_deprecated_alias: isDeprecatedAlias,
    deprecated_replacement: isDeprecatedAlias ? deprecatedCanonical : null
  };
}

function tokenizeMoquiCapability(value) {
  const normalized = normalizeMoquiCapabilityToken(value);
  if (!normalized) {
    return [];
  }
  return normalized.split('-').map(item => item.trim()).filter(Boolean);
}

function moquiCapabilityMatch(expected, provided) {
  const leftInfo = resolveMoquiCapabilityDescriptor(expected, MOQUI_CAPABILITY_LEXICON_INDEX);
  const rightInfo = resolveMoquiCapabilityDescriptor(provided, MOQUI_CAPABILITY_LEXICON_INDEX);
  const left = leftInfo ? leftInfo.canonical : null;
  const right = rightInfo ? rightInfo.canonical : null;
  if (!left || !right) {
    return false;
  }
  if (leftInfo && rightInfo && leftInfo.is_known && rightInfo.is_known) {
    return left === right;
  }
  if (left === right) {
    return true;
  }
  if ((left.length >= 8 && left.includes(right)) || (right.length >= 8 && right.includes(left))) {
    return true;
  }
  const leftTokens = tokenizeMoquiCapability(left);
  const rightTokens = tokenizeMoquiCapability(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return false;
  }
  const rightSet = new Set(rightTokens);
  const overlap = leftTokens.filter(item => rightSet.has(item)).length;
  return overlap >= 2;
}

function renderMoquiCapabilityCoverageMarkdown(report = {}) {
  const summary = report.summary && typeof report.summary === 'object'
    ? report.summary
    : {};
  const normalization = report.normalization && typeof report.normalization === 'object'
    ? report.normalization
    : {};
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const coverage = Array.isArray(report.coverage) ? report.coverage : [];
  const compare = report.compare && typeof report.compare === 'object' ? report.compare : null;
  const lines = [
    '# Moqui Capability Coverage Report',
    '',
    `- Generated at: ${report.generated_at || 'n/a'}`,
    `- Expected capabilities: ${summary.total_capabilities !== undefined ? summary.total_capabilities : 'n/a'}`,
    `- Covered capabilities: ${summary.covered_capabilities !== undefined ? summary.covered_capabilities : 'n/a'}`,
    `- Uncovered capabilities: ${summary.uncovered_capabilities !== undefined ? summary.uncovered_capabilities : 'n/a'}`,
    `- Coverage: ${summary.coverage_percent !== undefined && summary.coverage_percent !== null ? `${summary.coverage_percent}%` : 'n/a'}`,
    `- Min required: ${summary.min_required_percent !== undefined && summary.min_required_percent !== null ? `${summary.min_required_percent}%` : 'n/a'}`,
    `- Passed: ${summary.passed === true ? 'yes' : 'no'}`,
    `- Semantic complete: ${summary.semantic_complete_percent !== undefined && summary.semantic_complete_percent !== null ? `${summary.semantic_complete_percent}%` : 'n/a'}`,
    `- Semantic min required: ${summary.min_semantic_required_percent !== undefined && summary.min_semantic_required_percent !== null ? `${summary.min_semantic_required_percent}%` : 'n/a'}`,
    `- Semantic passed: ${summary.semantic_passed === true ? 'yes' : 'no'}`,
    `- Lexicon version: ${normalization.lexicon_version || 'n/a'}`,
    `- Expected alias mapped: ${Array.isArray(normalization.expected_alias_mapped) ? normalization.expected_alias_mapped.length : 0}`,
    `- Expected deprecated alias: ${Array.isArray(normalization.expected_deprecated_aliases) ? normalization.expected_deprecated_aliases.length : 0}`,
    `- Expected unknown: ${Array.isArray(normalization.expected_unknown) ? normalization.expected_unknown.length : 0}`,
    `- Provided alias mapped: ${Array.isArray(normalization.provided_alias_mapped) ? normalization.provided_alias_mapped.length : 0}`,
    `- Provided deprecated alias: ${Array.isArray(normalization.provided_deprecated_aliases) ? normalization.provided_deprecated_aliases.length : 0}`,
    `- Provided unknown: ${Array.isArray(normalization.provided_unknown) ? normalization.provided_unknown.length : 0}`,
    '',
    '## Capability Matrix',
    '',
    '| Capability | Covered | Semantic Complete | Missing Semantic Dimensions | Matched Templates |',
    '| --- | --- | --- | --- | --- |'
  ];

  for (const item of coverage) {
    const matchedTemplates = Array.isArray(item.matched_templates) && item.matched_templates.length > 0
      ? item.matched_templates.join(', ')
      : 'none';
    const semanticMissing = Array.isArray(item.semantic_missing_dimensions) && item.semantic_missing_dimensions.length > 0
      ? item.semantic_missing_dimensions.join(', ')
      : 'none';
    lines.push(
      `| ${item.capability} | ${item.covered ? 'yes' : 'no'} | ${item.semantic_complete ? 'yes' : 'no'} | ${semanticMissing} | ${matchedTemplates} |`
    );
  }

  lines.push('');
  lines.push('## Normalization Warnings');
  lines.push('');
  if (warnings.length === 0) {
    lines.push('- none');
  } else {
    for (const warning of warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (compare) {
    lines.push('');
    lines.push('## Trend vs Previous');
    lines.push('');
    lines.push(`- Previous generated at: ${compare.previous_generated_at || 'n/a'}`);
    lines.push(`- Delta coverage: ${compare.delta_coverage_percent !== null && compare.delta_coverage_percent !== undefined ? `${compare.delta_coverage_percent}%` : 'n/a'}`);
    lines.push(`- Delta covered capabilities: ${compare.delta_covered_capabilities !== null && compare.delta_covered_capabilities !== undefined ? compare.delta_covered_capabilities : 'n/a'}`);
    lines.push(`- Newly covered: ${Array.isArray(compare.newly_covered) && compare.newly_covered.length > 0 ? compare.newly_covered.join(', ') : 'none'}`);
    lines.push(`- Newly uncovered: ${Array.isArray(compare.newly_uncovered) && compare.newly_uncovered.length > 0 ? compare.newly_uncovered.join(', ') : 'none'}`);
  }

  return `${lines.join('\n')}\n`;
}

function buildCapabilityCoverageComparison(currentPayload, previousPayload) {
  const currentSummary = currentPayload && currentPayload.summary ? currentPayload.summary : {};
  const previousSummary = previousPayload && previousPayload.summary ? previousPayload.summary : {};
  const currentCoverage = Array.isArray(currentPayload && currentPayload.coverage) ? currentPayload.coverage : [];
  const previousCoverage = Array.isArray(previousPayload && previousPayload.coverage) ? previousPayload.coverage : [];
  const currentCovered = new Set(
    currentCoverage.filter(item => item && item.covered === true).map(item => item.capability)
  );
  const previousCovered = new Set(
    previousCoverage.filter(item => item && item.covered === true).map(item => item.capability)
  );
  const newlyCovered = Array.from(currentCovered).filter(item => !previousCovered.has(item)).sort();
  const newlyUncovered = Array.from(previousCovered).filter(item => !currentCovered.has(item)).sort();
  const toDelta = (current, previous) => {
    if (!Number.isFinite(Number(current)) || !Number.isFinite(Number(previous))) {
      return null;
    }
    return Number((Number(current) - Number(previous)).toFixed(2));
  };
  return {
    previous_generated_at: previousPayload && previousPayload.generated_at ? previousPayload.generated_at : null,
    delta_coverage_percent: toDelta(currentSummary.coverage_percent, previousSummary.coverage_percent),
    delta_covered_capabilities: toDelta(currentSummary.covered_capabilities, previousSummary.covered_capabilities),
    newly_covered: newlyCovered,
    newly_uncovered: newlyUncovered
  };
}

async function loadLatestMoquiCapabilityCoverageReport(projectPath) {
  const reportPath = path.join(projectPath, AUTO_HANDOFF_MOQUI_CAPABILITY_COVERAGE_JSON_FILE);
  if (!(await fs.pathExists(reportPath))) {
    return null;
  }
  try {
    const payload = await fs.readJson(reportPath);
    return payload && typeof payload === 'object' ? payload : null;
  } catch (_error) {
    return null;
  }
}

async function buildAutoHandoffCapabilityCoverageSnapshot(projectPath, handoff = null, policy = {}) {
  const expectedRaw = Array.isArray(handoff && handoff.capabilities)
    ? handoff.capabilities
    : [];
  const normalization = {
    lexicon_version: MOQUI_CAPABILITY_LEXICON_INDEX && MOQUI_CAPABILITY_LEXICON_INDEX.version
      ? MOQUI_CAPABILITY_LEXICON_INDEX.version
      : null,
    expected_alias_mapped: [],
    expected_deprecated_aliases: [],
    expected_unknown: [],
    provided_alias_mapped: [],
    provided_deprecated_aliases: [],
    provided_unknown: []
  };
  const warnings = [];
  const minRequiredPercentPolicy = Number(policy.min_capability_coverage_percent);
  const minRequiredPercentValue = Number.isFinite(minRequiredPercentPolicy)
    ? Number(minRequiredPercentPolicy.toFixed(2))
    : 100;
  const minSemanticRequiredPolicy = Number(policy.min_capability_semantic_percent);
  const minSemanticRequiredValue = Number.isFinite(minSemanticRequiredPolicy)
    ? Number(minSemanticRequiredPolicy.toFixed(2))
    : 100;
  const addNormalizationRecord = (target, descriptor) => {
    const list = Array.isArray(normalization[target]) ? normalization[target] : [];
    const item = {
      raw: descriptor.raw,
      normalized: descriptor.normalized,
      canonical: descriptor.canonical
    };
    const key = `${item.raw}|${item.normalized}|${item.canonical}`;
    if (!list.some(existing => `${existing.raw}|${existing.normalized}|${existing.canonical}` === key)) {
      list.push(item);
    }
    normalization[target] = list;
  };
  const expectedMap = new Map();
  for (const rawCapability of expectedRaw) {
    const descriptor = resolveMoquiCapabilityDescriptor(rawCapability, MOQUI_CAPABILITY_LEXICON_INDEX);
    if (!descriptor) {
      continue;
    }
    if (descriptor.is_alias) {
      addNormalizationRecord('expected_alias_mapped', descriptor);
    }
    if (descriptor.is_deprecated_alias) {
      addNormalizationRecord('expected_deprecated_aliases', descriptor);
      warnings.push(
        `manifest capability "${descriptor.raw}" is deprecated; use "${descriptor.deprecated_replacement || descriptor.canonical}" instead`
      );
    }
    if (!descriptor.is_known) {
      addNormalizationRecord('expected_unknown', descriptor);
      warnings.push(`manifest capability "${descriptor.raw}" is unknown to Moqui lexicon`);
    }
    if (!expectedMap.has(descriptor.canonical)) {
      expectedMap.set(descriptor.canonical, {
        capability: descriptor.canonical,
        source_values: [descriptor.normalized]
      });
    } else {
      const existing = expectedMap.get(descriptor.canonical);
      if (!existing.source_values.includes(descriptor.normalized)) {
        existing.source_values.push(descriptor.normalized);
      }
    }
  }
  const expected = Array.from(expectedMap.keys());
  if (expected.length === 0) {
    return {
      status: 'skipped',
      generated: false,
      reason: 'manifest capabilities not declared',
      summary: {
        total_capabilities: 0,
        covered_capabilities: 0,
        uncovered_capabilities: 0,
        coverage_percent: null,
        min_required_percent: minRequiredPercentValue,
        semantic_complete_capabilities: 0,
        semantic_incomplete_capabilities: 0,
        semantic_complete_percent: null,
        min_semantic_required_percent: minSemanticRequiredValue,
        semantic_passed: true,
        passed: true
      },
      coverage: [],
      gaps: [],
      normalization,
      warnings
    };
  }

  const templateRoot = path.join(projectPath, '.sce', 'templates', 'scene-packages');
  if (!(await fs.pathExists(templateRoot))) {
    return {
      status: 'skipped',
      generated: false,
      reason: `template library not found: ${toAutoHandoffCliPath(projectPath, templateRoot)}`,
      summary: {
        total_capabilities: expected.length,
        covered_capabilities: 0,
        uncovered_capabilities: expected.length,
        coverage_percent: 0,
        min_required_percent: minRequiredPercentValue,
        semantic_complete_capabilities: 0,
        semantic_incomplete_capabilities: expected.length,
        semantic_complete_percent: 0,
        min_semantic_required_percent: minSemanticRequiredValue,
        semantic_passed: false,
        passed: false
      },
      coverage: expected.map(item => ({
        capability: item,
        covered: false,
        matched_templates: [],
        matched_provides: [],
        matched_template_semantics: [],
        semantic_complete: false,
        semantic_missing_dimensions: [
          'ontology.entities',
          'ontology.relations',
          'governance.business_rules',
          'governance.decision_logic'
        ],
        source_values: expectedMap.get(item).source_values
      })),
      gaps: expected,
      normalization,
      warnings
    };
  }

  const templateEntries = await fs.readdir(templateRoot);
  const templates = [];
  for (const entry of templateEntries) {
    const templateDir = path.join(templateRoot, entry);
    let stat = null;
    try {
      stat = await fs.stat(templateDir);
    } catch (_error) {
      stat = null;
    }
    if (!stat || !stat.isDirectory()) {
      continue;
    }
    const contractFile = path.join(templateDir, 'scene-package.json');
    if (!(await fs.pathExists(contractFile))) {
      continue;
    }
    try {
      const payload = await fs.readJson(contractFile);
      const providesRaw = [];
      const contractProvides = payload && payload.contract && payload.contract.capabilities && payload.contract.capabilities.provides;
      const rootProvides = payload && payload.capabilities && payload.capabilities.provides;
      if (Array.isArray(contractProvides)) {
        providesRaw.push(...contractProvides);
      }
      if (Array.isArray(rootProvides)) {
        providesRaw.push(...rootProvides);
      }
      const provides = [];
      for (const providedCapability of providesRaw) {
        const descriptor = resolveMoquiCapabilityDescriptor(providedCapability, MOQUI_CAPABILITY_LEXICON_INDEX);
        if (!descriptor) {
          continue;
        }
        if (descriptor.is_alias) {
          addNormalizationRecord('provided_alias_mapped', descriptor);
        }
        if (descriptor.is_deprecated_alias) {
          addNormalizationRecord('provided_deprecated_aliases', descriptor);
          warnings.push(
            `template "${entry}" uses deprecated capability "${descriptor.raw}" (canonical "${descriptor.deprecated_replacement || descriptor.canonical}")`
          );
        }
        if (!descriptor.is_known) {
          addNormalizationRecord('provided_unknown', descriptor);
        }
        provides.push(descriptor.canonical);
      }
      const governanceContract = payload && payload.governance_contract && typeof payload.governance_contract === 'object'
        ? payload.governance_contract
        : {};
      const ontologyModel = payload && payload.ontology_model && typeof payload.ontology_model === 'object'
        ? payload.ontology_model
        : {};
      const businessRules = Array.isArray(governanceContract.business_rules)
        ? governanceContract.business_rules
        : [];
      const decisionLogic = Array.isArray(governanceContract.decision_logic)
        ? governanceContract.decision_logic
        : [];
      const ontologyEntities = Array.isArray(ontologyModel.entities)
        ? ontologyModel.entities
        : [];
      const ontologyRelations = Array.isArray(ontologyModel.relations)
        ? ontologyModel.relations
        : [];
      const semanticMissingDimensions = [];
      if (ontologyEntities.length <= 0) {
        semanticMissingDimensions.push('ontology.entities');
      }
      if (ontologyRelations.length <= 0) {
        semanticMissingDimensions.push('ontology.relations');
      }
      if (businessRules.length <= 0) {
        semanticMissingDimensions.push('governance.business_rules');
      }
      if (decisionLogic.length <= 0) {
        semanticMissingDimensions.push('governance.decision_logic');
      }
      const uniqueProvides = Array.from(new Set(provides));
      if (uniqueProvides.length > 0 && semanticMissingDimensions.length > 0) {
        warnings.push(
          `template "${entry}" semantic coverage missing: ${semanticMissingDimensions.join(', ')}`
        );
      }
      templates.push({
        template_id: entry,
        provides: uniqueProvides,
        semantic: {
          ontology_entities_count: ontologyEntities.length,
          ontology_relations_count: ontologyRelations.length,
          business_rules_count: businessRules.length,
          decision_logic_count: decisionLogic.length,
          missing_dimensions: semanticMissingDimensions,
          complete: semanticMissingDimensions.length === 0
        }
      });
    } catch (_error) {
      // Ignore malformed template package entries.
    }
  }

  const coverage = expected.map(capability => {
    const matchedTemplates = [];
    const matchedProvides = [];
    const matchedTemplateSemantics = [];
    let hasOntologyEntities = false;
    let hasOntologyRelations = false;
    let hasBusinessRules = false;
    let hasDecisionLogic = false;
    for (const template of templates) {
      const providedMatched = template.provides.filter(item => moquiCapabilityMatch(capability, item));
      if (providedMatched.length > 0) {
        matchedTemplates.push(template.template_id);
        matchedProvides.push(...providedMatched);
        const semantic = template.semantic && typeof template.semantic === 'object'
          ? template.semantic
          : {};
        const templateSemantic = {
          template_id: template.template_id,
          ontology_entities_count: Number(semantic.ontology_entities_count) || 0,
          ontology_relations_count: Number(semantic.ontology_relations_count) || 0,
          business_rules_count: Number(semantic.business_rules_count) || 0,
          decision_logic_count: Number(semantic.decision_logic_count) || 0,
          missing_dimensions: Array.isArray(semantic.missing_dimensions) ? semantic.missing_dimensions : [],
          complete: semantic.complete === true
        };
        matchedTemplateSemantics.push(templateSemantic);
        hasOntologyEntities = hasOntologyEntities || templateSemantic.ontology_entities_count > 0;
        hasOntologyRelations = hasOntologyRelations || templateSemantic.ontology_relations_count > 0;
        hasBusinessRules = hasBusinessRules || templateSemantic.business_rules_count > 0;
        hasDecisionLogic = hasDecisionLogic || templateSemantic.decision_logic_count > 0;
      }
    }
    const semanticMissingDimensions = [];
    if (!hasOntologyEntities) {
      semanticMissingDimensions.push('ontology.entities');
    }
    if (!hasOntologyRelations) {
      semanticMissingDimensions.push('ontology.relations');
    }
    if (!hasBusinessRules) {
      semanticMissingDimensions.push('governance.business_rules');
    }
    if (!hasDecisionLogic) {
      semanticMissingDimensions.push('governance.decision_logic');
    }
    const uniqueProvides = Array.from(new Set(matchedProvides)).sort();
    return {
      capability,
      covered: matchedTemplates.length > 0,
      source_values: expectedMap.has(capability) ? expectedMap.get(capability).source_values : [],
      matched_templates: Array.from(new Set(matchedTemplates)).sort(),
      matched_provides: uniqueProvides,
      matched_template_semantics: matchedTemplateSemantics,
      semantic_complete: semanticMissingDimensions.length === 0,
      semantic_missing_dimensions: semanticMissingDimensions
    };
  });

  const coveredCount = coverage.filter(item => item.covered).length;
  const semanticCompleteCount = coverage.filter(item => item.semantic_complete).length;
  const uncovered = coverage.filter(item => !item.covered).map(item => item.capability);
  const coveragePercent = expected.length > 0
    ? Number(((coveredCount / expected.length) * 100).toFixed(2))
    : null;
  const semanticCompletePercent = expected.length > 0
    ? Number(((semanticCompleteCount / expected.length) * 100).toFixed(2))
    : null;
  const minRequiredPercent = minRequiredPercentValue;
  const minSemanticRequiredPercent = minSemanticRequiredValue;
  const passed = Number.isFinite(coveragePercent) && Number.isFinite(minRequiredPercent)
    ? coveragePercent >= minRequiredPercent
    : false;
  const semanticPassed = Number.isFinite(semanticCompletePercent) && Number.isFinite(minSemanticRequiredPercent)
    ? semanticCompletePercent >= minSemanticRequiredPercent
    : false;

  const payload = {
    mode: 'moqui-capability-coverage',
    generated_at: new Date().toISOString(),
    expected_capabilities: expected,
    summary: {
      total_capabilities: expected.length,
      covered_capabilities: coveredCount,
      uncovered_capabilities: expected.length - coveredCount,
      coverage_percent: coveragePercent,
      min_required_percent: minRequiredPercent,
      semantic_complete_capabilities: semanticCompleteCount,
      semantic_incomplete_capabilities: expected.length - semanticCompleteCount,
      semantic_complete_percent: semanticCompletePercent,
      min_semantic_required_percent: minSemanticRequiredPercent,
      semantic_passed: semanticPassed,
      passed
    },
    coverage,
    gaps: uncovered,
    normalization,
    warnings: Array.from(new Set(warnings))
  };

  const previousPayload = await loadLatestMoquiCapabilityCoverageReport(projectPath);
  if (previousPayload) {
    payload.compare = buildCapabilityCoverageComparison(payload, previousPayload);
  }

  const outputJsonPath = path.join(projectPath, AUTO_HANDOFF_MOQUI_CAPABILITY_COVERAGE_JSON_FILE);
  const outputMarkdownPath = path.join(projectPath, AUTO_HANDOFF_MOQUI_CAPABILITY_COVERAGE_MARKDOWN_FILE);
  await fs.ensureDir(path.dirname(outputJsonPath));
  await fs.writeJson(outputJsonPath, payload, { spaces: 2 });
  await fs.writeFile(outputMarkdownPath, renderMoquiCapabilityCoverageMarkdown(payload), 'utf8');

  return {
    status: 'evaluated',
    generated: true,
    summary: payload.summary,
    coverage: payload.coverage,
    gaps: payload.gaps,
    normalization: payload.normalization,
    warnings: payload.warnings,
    compare: payload.compare || null,
    output: {
      json: toAutoHandoffCliPath(projectPath, outputJsonPath),
      markdown: toAutoHandoffCliPath(projectPath, outputMarkdownPath)
    }
  };
}

function buildAutoHandoffCapabilityMatrixRecommendations(result = {}) {
  const recommendations = [];
  const push = value => {
    const text = `${value || ''}`.trim();
    if (!text || recommendations.includes(text)) {
      return;
    }
    recommendations.push(text);
  };

  const manifestPath = normalizeHandoffText(result && result.manifest_path);
  const manifestCli = manifestPath ? quoteCliArg(manifestPath) : '<path>';
  const templateDiff = result && result.template_diff && typeof result.template_diff === 'object'
    ? result.template_diff
    : {};
  const capabilityCoverage = result && result.capability_coverage && typeof result.capability_coverage === 'object'
    ? result.capability_coverage
    : {};
  const coverageSummary = capabilityCoverage && capabilityCoverage.summary && typeof capabilityCoverage.summary === 'object'
    ? capabilityCoverage.summary
    : {};
  const coverageNormalization = capabilityCoverage && capabilityCoverage.normalization &&
    typeof capabilityCoverage.normalization === 'object'
    ? capabilityCoverage.normalization
    : {};
  const expectedUnknownCount = Array.isArray(coverageNormalization.expected_unknown)
    ? coverageNormalization.expected_unknown.length
    : 0;
  const providedUnknownCount = Array.isArray(coverageNormalization.provided_unknown)
    ? coverageNormalization.provided_unknown.length
    : 0;
  const baseline = result && result.moqui_baseline && typeof result.moqui_baseline === 'object'
    ? result.moqui_baseline
    : {};
  const baselineCompare = baseline && baseline.compare && typeof baseline.compare === 'object'
    ? baseline.compare
    : {};
  const baselineRegressions = buildAutoHandoffMoquiCoverageRegressions(baselineCompare);

  if (templateDiff.compatibility === 'needs-sync') {
    push(`Sync template library and rerun: sce auto handoff template-diff --manifest ${manifestCli} --json`);
  }
  if (baseline.status === 'error' || (baseline.summary && baseline.summary.portfolio_passed === false)) {
    push('Rebuild Moqui baseline: sce scene moqui-baseline --json');
  }
  if (baselineRegressions.length > 0) {
    push(
      `Recover Moqui matrix regressions: ` +
      `${baselineRegressions.slice(0, 3).map(item => `${item.label}:${item.delta_rate_percent}%`).join(' | ')}`
    );
    for (const line of buildMoquiRegressionRecoverySequenceLines({
      clusterGoalsArg: quoteCliArg(AUTO_HANDOFF_MOQUI_CLUSTER_REMEDIATION_FILE),
      baselineArg: quoteCliArg(AUTO_HANDOFF_MOQUI_BASELINE_JSON_FILE),
      wrapCommands: false,
      withPeriod: false
    })) {
      push(line);
    }
  }
  if (capabilityCoverage.status === 'skipped') {
    push('Declare `capabilities` in handoff manifest to enable capability matrix coverage gates.');
  }
  if (coverageSummary && coverageSummary.passed === false) {
    push(
      `Close capability gaps with strict gate: ` +
      `sce auto handoff run --manifest ${manifestCli} --min-capability-coverage ${coverageSummary.min_required_percent} --json`
    );
  }
  if (coverageSummary && coverageSummary.semantic_passed === false) {
    push(
      `Backfill capability ontology semantics and rerun matrix: ` +
      `sce scene package-ontology-backfill-batch --manifest ${manifestCli} --json`
    );
  }
  if (expectedUnknownCount > 0 || providedUnknownCount > 0) {
    push(
      `Normalize capability lexicon gaps with strict audit: ` +
      `node scripts/moqui-lexicon-audit.js --manifest ${manifestCli} ` +
      '--template-dir .sce/templates/scene-packages --fail-on-gap --json'
    );
  }
  if (result.remediation_queue && result.remediation_queue.file) {
    push(
      `Replay remediation queue: sce auto close-loop-batch ${quoteCliArg(result.remediation_queue.file)} --format lines --json`
    );
  }

  return recommendations;
}

function renderAutoHandoffCapabilityMatrixMarkdown(payload = {}) {
  const handoff = payload && payload.handoff && typeof payload.handoff === 'object'
    ? payload.handoff
    : {};
  const policy = payload && payload.policy && typeof payload.policy === 'object'
    ? payload.policy
    : {};
  const gates = payload && payload.gates && typeof payload.gates === 'object'
    ? payload.gates
    : {};
  const templateDiff = payload && payload.template_diff && typeof payload.template_diff === 'object'
    ? payload.template_diff
    : {};
  const diff = templateDiff && templateDiff.diff && typeof templateDiff.diff === 'object'
    ? templateDiff.diff
    : {};
  const moquiBaseline = payload && payload.moqui_baseline && typeof payload.moqui_baseline === 'object'
    ? payload.moqui_baseline
    : {};
  const baselineSummary = moquiBaseline && moquiBaseline.summary && typeof moquiBaseline.summary === 'object'
    ? moquiBaseline.summary
    : {};
  const baselineCompare = moquiBaseline && moquiBaseline.compare && typeof moquiBaseline.compare === 'object'
    ? moquiBaseline.compare
    : {};
  const baselineScopeBreakdown = baselineSummary && baselineSummary.scope_breakdown && typeof baselineSummary.scope_breakdown === 'object'
    ? baselineSummary.scope_breakdown
    : {};
  const baselineGapFrequency = Array.isArray(baselineSummary && baselineSummary.gap_frequency)
    ? baselineSummary.gap_frequency
    : [];
  const capabilityCoverage = payload && payload.capability_coverage && typeof payload.capability_coverage === 'object'
    ? payload.capability_coverage
    : {};
  const coverageSummary = capabilityCoverage && capabilityCoverage.summary && typeof capabilityCoverage.summary === 'object'
    ? capabilityCoverage.summary
    : {};
  const coverageNormalization = capabilityCoverage && capabilityCoverage.normalization &&
    typeof capabilityCoverage.normalization === 'object'
    ? capabilityCoverage.normalization
    : {};
  const expectedUnknownCount = Array.isArray(coverageNormalization.expected_unknown)
    ? coverageNormalization.expected_unknown.length
    : 0;
  const providedUnknownCount = Array.isArray(coverageNormalization.provided_unknown)
    ? coverageNormalization.provided_unknown.length
    : 0;
  const coverage = Array.isArray(capabilityCoverage && capabilityCoverage.coverage)
    ? capabilityCoverage.coverage
    : [];
  const recommendations = Array.isArray(payload.recommendations)
    ? payload.recommendations
    : [];

  const lines = [
    '# Auto Handoff Capability Matrix',
    '',
    `- Generated at: ${payload.generated_at || 'n/a'}`,
    `- Status: ${payload.status || 'unknown'}`,
    `- Manifest: ${payload.manifest_path || 'n/a'}`,
    `- Source project: ${payload.source_project || 'n/a'}`,
    `- Specs: ${handoff.spec_count !== undefined ? handoff.spec_count : 'n/a'}`,
    `- Templates: ${handoff.template_count !== undefined ? handoff.template_count : 'n/a'}`,
    `- Capabilities: ${handoff.capability_count !== undefined ? handoff.capability_count : 'n/a'}`,
    `- Policy profile: ${policy.profile || 'default'}`,
    `- Min capability coverage: ${policy.min_capability_coverage_percent !== undefined ? `${policy.min_capability_coverage_percent}%` : 'n/a'}`,
    `- Min capability semantic completeness: ${policy.min_capability_semantic_percent !== undefined ? `${policy.min_capability_semantic_percent}%` : 'n/a'}`,
    `- Capability lexicon gate: ${policy.require_capability_lexicon === false ? 'disabled' : 'enabled'}`,
    '',
    '## Gates',
    '',
    `- Passed: ${gates.passed === true ? 'yes' : 'no'}`,
    `- Reasons: ${Array.isArray(gates.reasons) && gates.reasons.length > 0 ? gates.reasons.join(' | ') : 'none'}`,
    '',
    '## Template Sync',
    '',
    `- Compatibility: ${templateDiff.compatibility || 'unknown'}`,
    `- Missing in local: ${Array.isArray(diff.missing_in_local) ? diff.missing_in_local.length : 0}`,
    `- Extra in local: ${Array.isArray(diff.extra_in_local) ? diff.extra_in_local.length : 0}`,
    '',
    '## Moqui Baseline',
    '',
    `- Status: ${moquiBaseline.status || 'unknown'}`,
    `- Portfolio passed: ${baselineSummary.portfolio_passed === true ? 'yes' : (baselineSummary.portfolio_passed === false ? 'no' : 'n/a')}`,
    `- Avg score: ${formatAutoHandoffRegressionValue(baselineSummary.avg_score)}`,
    `- Valid-rate: ${formatAutoHandoffRegressionValue(baselineSummary.valid_rate_percent)}%`,
    `- Scope mix (moqui/suite/other): ${formatAutoHandoffRegressionValue(baselineScopeBreakdown.moqui_erp, '0')}/${formatAutoHandoffRegressionValue(baselineScopeBreakdown.scene_orchestration, '0')}/${formatAutoHandoffRegressionValue(baselineScopeBreakdown.other, '0')}`,
    `- Entity coverage: ${formatAutoHandoffMoquiCoverageMetric(baselineSummary, 'entity_coverage', 'rate_percent', '%')}`,
    `- Relation coverage: ${formatAutoHandoffMoquiCoverageMetric(baselineSummary, 'relation_coverage', 'rate_percent', '%')}`,
    `- Business-rule coverage: ${formatAutoHandoffMoquiCoverageMetric(baselineSummary, 'business_rule_coverage', 'rate_percent', '%')}`,
    `- Business-rule closed: ${formatAutoHandoffMoquiCoverageMetric(baselineSummary, 'business_rule_closed', 'rate_percent', '%')}`,
    `- Decision coverage: ${formatAutoHandoffMoquiCoverageMetric(baselineSummary, 'decision_coverage', 'rate_percent', '%')}`,
    `- Decision closed: ${formatAutoHandoffMoquiCoverageMetric(baselineSummary, 'decision_closed', 'rate_percent', '%')}`,
    `- Entity coverage delta: ${formatAutoHandoffMoquiCoverageDeltaMetric(baselineCompare, 'entity_coverage', 'rate_percent', '%')}`,
    `- Business-rule closed delta: ${formatAutoHandoffMoquiCoverageDeltaMetric(baselineCompare, 'business_rule_closed', 'rate_percent', '%')}`,
    `- Decision closed delta: ${formatAutoHandoffMoquiCoverageDeltaMetric(baselineCompare, 'decision_closed', 'rate_percent', '%')}`,
    `- Matrix regressions: ${formatAutoHandoffMoquiCoverageRegressions(baselineCompare, 5)}`,
    `- Top baseline gaps: ${baselineGapFrequency.length > 0 ? baselineGapFrequency.slice(0, 3).map(item => `${item.gap}:${item.count}`).join(' | ') : 'none'}`,
    '',
    '## Capability Coverage',
    '',
    `- Status: ${capabilityCoverage.status || 'unknown'}`,
    `- Passed: ${coverageSummary.passed === true ? 'yes' : (coverageSummary.passed === false ? 'no' : 'n/a')}`,
    `- Coverage: ${formatAutoHandoffRegressionValue(coverageSummary.coverage_percent)}%`,
    `- Covered capabilities: ${formatAutoHandoffRegressionValue(coverageSummary.covered_capabilities, '0')}`,
    `- Uncovered capabilities: ${formatAutoHandoffRegressionValue(coverageSummary.uncovered_capabilities, '0')}`,
    `- Semantic complete: ${formatAutoHandoffRegressionValue(coverageSummary.semantic_complete_percent)}%`,
    `- Semantic passed: ${coverageSummary.semantic_passed === true ? 'yes' : (coverageSummary.semantic_passed === false ? 'no' : 'n/a')}`,
    `- Expected unknown capability aliases: ${expectedUnknownCount}`,
    `- Provided unknown capability aliases: ${providedUnknownCount}`,
    '',
    '| Capability | Covered | Semantic Complete | Missing Semantic Dimensions | Matched Templates |',
    '| --- | --- | --- | --- | --- |'
  ];

  if (coverage.length === 0) {
    lines.push('| none | n/a | n/a | n/a | n/a |');
  } else {
    for (const item of coverage) {
      const matchedTemplates = Array.isArray(item && item.matched_templates) && item.matched_templates.length > 0
        ? item.matched_templates.join(', ')
        : 'none';
      const semanticMissing = Array.isArray(item && item.semantic_missing_dimensions)
        && item.semantic_missing_dimensions.length > 0
        ? item.semantic_missing_dimensions.join(', ')
        : 'none';
      lines.push(
        `| ${item && item.capability ? item.capability : 'n/a'} | ${item && item.covered === true ? 'yes' : 'no'} | ${item && item.semantic_complete === true ? 'yes' : 'no'} | ${semanticMissing} | ${matchedTemplates} |`
      );
    }
  }

  if (payload.remediation_queue && payload.remediation_queue.file) {
    lines.push('');
    lines.push('## Remediation Queue');
    lines.push('');
    lines.push(`- File: ${payload.remediation_queue.file}`);
    lines.push(`- Goal count: ${payload.remediation_queue.goal_count}`);
  }

  lines.push('');
  lines.push('## Recommendations');
  lines.push('');
  if (recommendations.length === 0) {
    lines.push('- none');
  } else {
    recommendations.forEach(item => lines.push(`- ${item}`));
  }

  return `${lines.join('\n')}\n`;
}

async function buildAutoHandoffCapabilityMatrix(projectPath, options = {}) {
  const plan = await buildAutoHandoffPlan(projectPath, {
    manifest: options.manifest,
    strict: options.strict,
    strictWarnings: options.strictWarnings
  });

  const policy = buildAutoHandoffCapabilityMatrixPolicy(options);

  const [templateDiff, moquiBaseline, capabilityCoverage] = await Promise.all([
    buildAutoHandoffTemplateDiff(projectPath, { handoff: plan.handoff }),
    buildAutoHandoffMoquiBaselineSnapshot(projectPath),
    buildAutoHandoffCapabilityCoverageSnapshot(projectPath, plan.handoff, policy)
  ]);

  const templateSyncReasons = templateDiff.compatibility === 'ready'
    ? []
    : [`template-sync:${templateDiff.compatibility}`];
  const baselineGateReasons = evaluateAutoHandoffMoquiBaselineGateReasons(
    { require_moqui_baseline: true },
    moquiBaseline
  );
  const capabilityGateReasons = evaluateAutoHandoffCapabilityCoverageGateReasons(
    policy,
    capabilityCoverage
  );
  const semanticGateReasons = evaluateAutoHandoffCapabilitySemanticGateReasons(
    policy,
    capabilityCoverage
  );
  const lexiconGateReasons = evaluateAutoHandoffCapabilityLexiconGateReasons(
    policy,
    capabilityCoverage
  );
  const reasons = [
    ...templateSyncReasons,
    ...baselineGateReasons.map(item => `moqui-baseline:${item}`),
    ...capabilityGateReasons.map(item => `capability-coverage:${item}`),
    ...semanticGateReasons.map(item => `capability-semantic:${item}`),
    ...lexiconGateReasons.map(item => `capability-lexicon:${item}`)
  ];

  const result = {
    mode: 'auto-handoff-capability-matrix',
    generated_at: new Date().toISOString(),
    status: reasons.length === 0 ? 'ready' : 'needs-remediation',
    manifest_path: plan.manifest_path,
    source_project: plan.source_project || null,
    handoff: {
      spec_count: plan.handoff && Number.isFinite(Number(plan.handoff.spec_count))
        ? Number(plan.handoff.spec_count)
        : 0,
      template_count: plan.handoff && Number.isFinite(Number(plan.handoff.template_count))
        ? Number(plan.handoff.template_count)
        : 0,
      capability_count: Array.isArray(plan.handoff && plan.handoff.capabilities)
        ? plan.handoff.capabilities.length
        : 0,
      capability_source: normalizeHandoffText(plan.handoff && plan.handoff.capability_source) || 'manifest',
      capability_inference: plan.handoff && plan.handoff.capability_inference &&
        typeof plan.handoff.capability_inference === 'object'
        ? plan.handoff.capability_inference
        : {
          applied: false,
          inferred_count: 0,
          inferred_capabilities: [],
          inferred_from_templates: [],
          unresolved_template_count: 0,
          unresolved_templates: []
        },
      capabilities: Array.isArray(plan.handoff && plan.handoff.capabilities)
        ? plan.handoff.capabilities
        : []
    },
    policy,
    template_diff: templateDiff,
    moqui_baseline: moquiBaseline,
    capability_coverage: capabilityCoverage,
    gates: {
      passed: reasons.length === 0,
      reasons,
      template_sync: {
        passed: templateSyncReasons.length === 0,
        reasons: templateSyncReasons
      },
      moqui_baseline: {
        passed: baselineGateReasons.length === 0,
        reasons: baselineGateReasons
      },
      capability_coverage: {
        passed: capabilityGateReasons.length === 0,
        reasons: capabilityGateReasons
      },
      capability_semantic: {
        passed: semanticGateReasons.length === 0,
        reasons: semanticGateReasons
      },
      capability_lexicon: {
        passed: lexiconGateReasons.length === 0,
        reasons: lexiconGateReasons
      }
    },
    remediation_queue: null,
    recommendations: []
  };

  result.remediation_queue = await maybeWriteAutoHandoffMoquiRemediationQueue(
    projectPath,
    {
      moqui_baseline: moquiBaseline,
      moqui_capability_coverage: capabilityCoverage
    },
    options.remediationQueueOut
  );
  result.recommendations = buildAutoHandoffCapabilityMatrixRecommendations(result);

  return result;
}

function collectAutoHandoffMoquiRemediationGoals(result) {
  const goals = [];
  const seen = new Set();
  const pushGoal = value => {
    const text = `${value || ''}`.trim();
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    goals.push(text);
  };

  const moquiBaseline = result && result.moqui_baseline && typeof result.moqui_baseline === 'object'
    ? result.moqui_baseline
    : null;
  const baselineSummary = moquiBaseline && moquiBaseline.summary && typeof moquiBaseline.summary === 'object'
    ? moquiBaseline.summary
    : null;
  const baselineCompare = moquiBaseline && moquiBaseline.compare && typeof moquiBaseline.compare === 'object'
    ? moquiBaseline.compare
    : null;
  const baselineRegressions = buildAutoHandoffMoquiCoverageRegressions(baselineCompare || {});
  const baselineFailedTemplates = baselineCompare && baselineCompare.failed_templates && typeof baselineCompare.failed_templates === 'object'
    ? baselineCompare.failed_templates
    : {};

  if (moquiBaseline && moquiBaseline.status === 'error') {
    pushGoal('repair moqui baseline generation pipeline and regenerate baseline evidence');
  } else if (baselineSummary && baselineSummary.portfolio_passed === false) {
    pushGoal(
      `raise moqui baseline portfolio score (avg=${baselineSummary.avg_score || 'n/a'}, ` +
      `valid-rate=${baselineSummary.valid_rate_percent || 'n/a'}%) to pass thresholds`
    );
    const targetTemplates = Array.isArray(baselineFailedTemplates.current)
      ? baselineFailedTemplates.current
      : [];
    for (const templateId of targetTemplates) {
      pushGoal(`remediate moqui template ${templateId} ontology semantics and close baseline gaps`);
    }
  }
  if (baselineRegressions.length > 0) {
    for (const item of baselineRegressions.slice(0, 5)) {
      pushGoal(
        `recover moqui matrix regression ${item.label} (${item.delta_rate_percent}%) by closing ontology semantic gaps`
      );
      if (item.metric === 'business_rule_closed') {
        pushGoal('remap governance_contract.business_rules for Moqui templates until closure regression is recovered');
      }
      if (item.metric === 'decision_closed') {
        pushGoal('resolve undecided governance_contract.decision_logic entries in Moqui templates');
      }
      if (item.metric === 'entity_coverage' || item.metric === 'relation_coverage') {
        pushGoal('backfill ontology_model entities/relations for regressed Moqui templates');
      }
    }
  }

  const scenePackageBatch = result && result.scene_package_batch && typeof result.scene_package_batch === 'object'
    ? result.scene_package_batch
    : null;
  const sceneBatchSummary = scenePackageBatch && scenePackageBatch.summary && typeof scenePackageBatch.summary === 'object'
    ? scenePackageBatch.summary
    : null;
  const sceneBatchFailures = Array.isArray(scenePackageBatch && scenePackageBatch.failures)
    ? scenePackageBatch.failures
    : [];
  const sceneBatchGateFailures = scenePackageBatch
    && scenePackageBatch.batch_ontology_gate
    && Array.isArray(scenePackageBatch.batch_ontology_gate.failures)
    ? scenePackageBatch.batch_ontology_gate.failures
    : [];
  if (scenePackageBatch && scenePackageBatch.status === 'error') {
    pushGoal('repair scene package publish-batch dry-run gate pipeline and rerun handoff gate');
  } else if (scenePackageBatch && scenePackageBatch.status === 'failed') {
    pushGoal('fix scene package publish-batch dry-run failures before autonomous handoff execution');
    if (sceneBatchSummary) {
      pushGoal(
        `improve scene package batch ontology gate metrics ` +
        `(avg=${sceneBatchSummary.ontology_average_score || 'n/a'}, valid-rate=${sceneBatchSummary.ontology_valid_rate_percent || 'n/a'}%)`
      );
    }
    for (const item of sceneBatchFailures) {
      const spec = item && item.spec ? item.spec : '(unknown)';
      const reason = item && item.error ? item.error : 'publish failed';
      pushGoal(`repair scene package contract for ${spec}: ${reason}`);
    }
    for (const item of sceneBatchGateFailures) {
      const message = item && item.message ? item.message : null;
      if (message) {
        pushGoal(`resolve scene package batch ontology gate failure: ${message}`);
      }
    }
  }

  const capabilityCoverage = result && result.moqui_capability_coverage && typeof result.moqui_capability_coverage === 'object'
    ? result.moqui_capability_coverage
    : null;
  const capabilitySummary = capabilityCoverage && capabilityCoverage.summary && typeof capabilityCoverage.summary === 'object'
    ? capabilityCoverage.summary
    : null;
  const capabilityGaps = capabilityCoverage && Array.isArray(capabilityCoverage.gaps)
    ? capabilityCoverage.gaps
    : [];
  const capabilityNormalization = capabilityCoverage && capabilityCoverage.normalization && typeof capabilityCoverage.normalization === 'object'
    ? capabilityCoverage.normalization
    : null;
  if (
    capabilityCoverage &&
    capabilityCoverage.status === 'evaluated' &&
    capabilitySummary &&
    capabilitySummary.passed === false
  ) {
    pushGoal(
      `increase moqui capability coverage to >=${capabilitySummary.min_required_percent}% ` +
      `(current=${capabilitySummary.coverage_percent || 0}%)`
    );
    for (const capability of capabilityGaps) {
      pushGoal(`implement scene template or ontology mapping for moqui capability ${capability}`);
    }
  }
  if (
    capabilityCoverage &&
    capabilityCoverage.status === 'evaluated' &&
    capabilitySummary &&
    capabilitySummary.semantic_passed === false
  ) {
    pushGoal(
      `increase moqui capability semantic completeness to >=${capabilitySummary.min_semantic_required_percent}% ` +
      `(current=${capabilitySummary.semantic_complete_percent || 0}%)`
    );
    const semanticGaps = Array.isArray(capabilityCoverage.coverage)
      ? capabilityCoverage.coverage.filter(item => item && item.semantic_complete !== true)
      : [];
    for (const item of semanticGaps) {
      const capability = item && item.capability ? item.capability : '(unknown)';
      const missingDimensions = Array.isArray(item && item.semantic_missing_dimensions)
        && item.semantic_missing_dimensions.length > 0
        ? item.semantic_missing_dimensions.join(', ')
        : 'ontology semantic dimensions';
      pushGoal(
        `complete capability semantic dimensions for ${capability}: ${missingDimensions}`
      );
    }
  }
  if (
    capabilityNormalization &&
    Array.isArray(capabilityNormalization.expected_deprecated_aliases) &&
    capabilityNormalization.expected_deprecated_aliases.length > 0
  ) {
    for (const item of capabilityNormalization.expected_deprecated_aliases) {
      const raw = item && item.raw ? item.raw : '(unknown)';
      const canonical = item && item.canonical ? item.canonical : '(unknown)';
      pushGoal(`replace deprecated manifest capability alias ${raw} with canonical ${canonical}`);
    }
  }
  if (
    capabilityNormalization &&
    Array.isArray(capabilityNormalization.expected_unknown) &&
    capabilityNormalization.expected_unknown.length > 0
  ) {
    for (const item of capabilityNormalization.expected_unknown) {
      const raw = item && item.raw ? item.raw : '(unknown)';
      pushGoal(`align unknown manifest capability ${raw} with Moqui capability lexicon`);
    }
  }
  if (
    capabilityNormalization &&
    Array.isArray(capabilityNormalization.provided_unknown) &&
    capabilityNormalization.provided_unknown.length > 0
  ) {
    for (const item of capabilityNormalization.provided_unknown) {
      const raw = item && item.raw ? item.raw : '(unknown)';
      pushGoal(`align unknown template capability ${raw} with Moqui capability lexicon`);
    }
  }

  return goals;
}

async function maybeWriteAutoHandoffMoquiRemediationQueue(projectPath, result, outCandidate) {
  const goals = collectAutoHandoffMoquiRemediationGoals(result);
  if (goals.length === 0) {
    return null;
  }
  const outputCandidate = typeof outCandidate === 'string' && outCandidate.trim().length > 0
    ? outCandidate.trim()
    : AUTO_HANDOFF_MOQUI_REMEDIATION_QUEUE_FILE;
  const queuePath = path.isAbsolute(outputCandidate)
    ? outputCandidate
    : path.join(projectPath, outputCandidate);
  await fs.ensureDir(path.dirname(queuePath));
  await fs.writeFile(queuePath, `${goals.join('\n')}\n`, 'utf8');
  return {
    file: queuePath,
    goal_count: goals.length,
    goals
  };
}

async function runAutoHandoff(projectPath, options = {}) {
  const startedAtMs = Date.now();
  const result = {
    mode: 'auto-handoff-run',
    status: 'running',
    generated_at: new Date().toISOString(),
    session_id: buildAutoHandoffRunSessionId(),
    manifest_path: null,
    source_project: null,
    policy: buildAutoHandoffRunPolicy(options),
    dry_run: Boolean(options.dryRun),
    phases: [],
    handoff: null,
    template_diff: null,
    queue: null,
    continued_from: null,
    dependency_execution: null,
    batch_summary: null,
    observability_snapshot: null,
    spec_status: null,
    ontology_validation: null,
    moqui_baseline: null,
    scene_package_batch: null,
    moqui_capability_coverage: null,
    release_gate_preflight: null,
    remediation_queue: null,
    gates: null,
    regression: null,
    release_evidence: null,
    failure_summary: null,
    recommendations: [],
    warnings: [],
    error: null
  };

  try {
    const precheckPhase = beginAutoHandoffRunPhase(result, 'precheck', 'Plan and precheck');
    let plan = null;
    try {
      plan = await buildAutoHandoffPlan(projectPath, {
        manifest: options.manifest,
        strict: options.strict,
        strictWarnings: options.strictWarnings
      });
      result.manifest_path = plan.manifest_path;
      result.source_project = plan.source_project || null;
      result.handoff = plan.handoff;
      result.ontology_validation = evaluateHandoffOntologyValidation(
        plan && plan.handoff ? plan.handoff.ontology_validation : null
      );
      result.template_diff = await buildAutoHandoffTemplateDiff(projectPath, { manifest: options.manifest });
      result.release_gate_preflight = buildAutoHandoffReleaseGatePreflight(
        await loadGovernanceReleaseGateSignals(projectPath)
      );
      if (result.release_gate_preflight.parse_error) {
        result.warnings.push(
          `release gate preflight parse failed: ${result.release_gate_preflight.parse_error}`
        );
      }
      if (result.release_gate_preflight.blocked === true) {
        const reasonText = result.release_gate_preflight.reasons.length > 0
          ? result.release_gate_preflight.reasons.join('; ')
          : 'release gate blocked';
        result.warnings.push(`release gate preflight is blocked: ${reasonText}`);
      }
      completeAutoHandoffRunPhase(precheckPhase, {
        validation: plan.validation,
        phase_count: Array.isArray(plan.phases) ? plan.phases.length : 0,
        template_compatibility: result.template_diff.compatibility,
        release_gate_preflight: {
          available: result.release_gate_preflight.available,
          blocked: result.release_gate_preflight.blocked,
          latest_tag: result.release_gate_preflight.latest_tag,
          latest_gate_passed: result.release_gate_preflight.latest_gate_passed,
          latest_weekly_ops_runtime_block_rate_percent:
            result.release_gate_preflight.latest_weekly_ops_runtime_block_rate_percent,
          latest_weekly_ops_runtime_ui_mode_violation_total:
            result.release_gate_preflight.latest_weekly_ops_runtime_ui_mode_violation_total,
          latest_weekly_ops_runtime_ui_mode_violation_rate_percent:
            result.release_gate_preflight.latest_weekly_ops_runtime_ui_mode_violation_rate_percent,
          weekly_ops_runtime_block_rate_max_percent:
            result.release_gate_preflight.weekly_ops_runtime_block_rate_max_percent,
          weekly_ops_runtime_ui_mode_violation_total:
            result.release_gate_preflight.weekly_ops_runtime_ui_mode_violation_total,
          weekly_ops_runtime_ui_mode_violation_run_rate_percent:
            result.release_gate_preflight.weekly_ops_runtime_ui_mode_violation_run_rate_percent,
          weekly_ops_runtime_ui_mode_violation_rate_max_percent:
            result.release_gate_preflight.weekly_ops_runtime_ui_mode_violation_rate_max_percent
        }
      });
      const ontologyGateReasons = evaluateAutoHandoffOntologyGateReasons(
        result.policy,
        result.ontology_validation
      );
      if (ontologyGateReasons.length > 0) {
        throw new Error(`handoff ontology validation gate failed: ${ontologyGateReasons.join('; ')}`);
      }
      const releaseGatePreflightReasons = evaluateAutoHandoffReleaseGatePreflightGateReasons(
        result.policy,
        result.release_gate_preflight
      );
      if (releaseGatePreflightReasons.length > 0) {
        throw new Error(`handoff release gate preflight failed: ${releaseGatePreflightReasons.join('; ')}`);
      }
    } catch (error) {
      failAutoHandoffRunPhase(precheckPhase, error);
      throw error;
    }

    const baselinePhase = beginAutoHandoffRunPhase(result, 'moqui-baseline', 'Moqui template baseline scorecard');
    try {
      result.moqui_baseline = await buildAutoHandoffMoquiBaselineSnapshot(projectPath);
      completeAutoHandoffRunPhase(
        baselinePhase,
        buildAutoHandoffMoquiBaselinePhaseDetails(result.moqui_baseline)
      );
      if (result.moqui_baseline && result.moqui_baseline.status === 'error') {
        result.warnings.push(`moqui baseline generation failed: ${result.moqui_baseline.error || 'unknown error'}`);
      }
      const moquiBaselineGateReasons = evaluateAutoHandoffMoquiBaselineGateReasons(
        result.policy,
        result.moqui_baseline
      );
      if (moquiBaselineGateReasons.length > 0) {
        throw new Error(`handoff moqui baseline gate failed: ${moquiBaselineGateReasons.join('; ')}`);
      }
    } catch (baselineError) {
      failAutoHandoffRunPhase(baselinePhase, baselineError);
      if (!result.moqui_baseline) {
        result.moqui_baseline = {
          status: 'error',
          generated: false,
          error: baselineError && baselineError.message ? baselineError.message : `${baselineError}`
        };
      }
      throw baselineError;
    }

    const sceneBatchPhase = beginAutoHandoffRunPhase(
      result,
      'scene-package-batch',
      'Scene package publish-batch dry-run gate'
    );
    try {
      result.scene_package_batch = await buildAutoHandoffScenePackageBatchSnapshot(
        projectPath,
        result.manifest_path
      );
      completeAutoHandoffRunPhase(
        sceneBatchPhase,
        buildAutoHandoffScenePackageBatchPhaseDetails(result.scene_package_batch)
      );
      if (result.scene_package_batch && result.scene_package_batch.status === 'error') {
        result.warnings.push(
          `scene package publish-batch dry-run failed: ${result.scene_package_batch.error || 'unknown error'}`
        );
      }
      const sceneBatchGateReasons = evaluateAutoHandoffScenePackageBatchGateReasons(
        result.policy,
        result.scene_package_batch
      );
      if (sceneBatchGateReasons.length > 0) {
        throw new Error(`handoff scene package batch gate failed: ${sceneBatchGateReasons.join('; ')}`);
      }
    } catch (sceneBatchError) {
      failAutoHandoffRunPhase(sceneBatchPhase, sceneBatchError);
      if (!result.scene_package_batch) {
        result.scene_package_batch = {
          status: 'error',
          generated: false,
          error: sceneBatchError && sceneBatchError.message ? sceneBatchError.message : `${sceneBatchError}`
        };
      }
      throw sceneBatchError;
    }

    const capabilityCoveragePhase = beginAutoHandoffRunPhase(
      result,
      'moqui-capability-coverage',
      'Moqui capability coverage matrix'
    );
    try {
      result.moqui_capability_coverage = await buildAutoHandoffCapabilityCoverageSnapshot(
        projectPath,
        result.handoff,
        result.policy
      );
      completeAutoHandoffRunPhase(capabilityCoveragePhase, {
        status: result.moqui_capability_coverage.status || 'unknown',
        coverage_percent: Number.isFinite(
          Number(
            result.moqui_capability_coverage &&
            result.moqui_capability_coverage.summary
              ? result.moqui_capability_coverage.summary.coverage_percent
              : null
          )
        )
          ? Number(result.moqui_capability_coverage.summary.coverage_percent)
          : null,
        passed: Boolean(
          result.moqui_capability_coverage &&
          result.moqui_capability_coverage.summary &&
          result.moqui_capability_coverage.summary.passed === true
        )
      });
      const capabilityCoverageGateReasons = evaluateAutoHandoffCapabilityCoverageGateReasons(
        result.policy,
        result.moqui_capability_coverage
      );
      if (capabilityCoverageGateReasons.length > 0) {
        throw new Error(`handoff capability coverage gate failed: ${capabilityCoverageGateReasons.join('; ')}`);
      }
      const capabilityLexiconGateReasons = evaluateAutoHandoffCapabilityLexiconGateReasons(
        result.policy,
        result.moqui_capability_coverage
      );
      if (capabilityLexiconGateReasons.length > 0) {
        throw new Error(`handoff capability lexicon gate failed: ${capabilityLexiconGateReasons.join('; ')}`);
      }
    } catch (capabilityCoverageError) {
      failAutoHandoffRunPhase(capabilityCoveragePhase, capabilityCoverageError);
      if (!result.moqui_capability_coverage) {
        result.moqui_capability_coverage = {
          status: 'error',
          generated: false,
          error: capabilityCoverageError && capabilityCoverageError.message
            ? capabilityCoverageError.message
            : `${capabilityCoverageError}`
        };
      }
      throw capabilityCoverageError;
    }

    const queuePhase = beginAutoHandoffRunPhase(result, 'queue', 'Queue generation');
    let queue = null;
    try {
      if (options.continueFrom) {
        queue = await buildAutoHandoffQueueFromContinueSource(projectPath, plan, options);
      } else {
        queue = await buildAutoHandoffQueue(projectPath, {
          manifest: options.manifest,
          out: options.queueOut,
          append: options.append,
          includeKnownGaps: options.includeKnownGaps,
          dryRun: options.dryRun
        });
      }
      if (!queue.dry_run) {
        await writeAutoHandoffQueueFile(projectPath, queue, {
          out: options.queueOut,
          append: options.append
        });
      }
      result.queue = {
        goal_count: queue.goal_count,
        include_known_gaps: queue.include_known_gaps,
        output_file: queue.output_file || null,
        dependency_batching: result.policy.dependency_batching,
        resumed_from: queue.resumed_from || null
      };
      result.continued_from = queue.resumed_from || null;
      completeAutoHandoffRunPhase(queuePhase, {
        goal_count: queue.goal_count,
        output_file: queue.output_file || null,
        resumed_from: queue.resumed_from
          ? {
            session_id: queue.resumed_from.session_id,
            strategy: queue.resumed_from.strategy
          }
          : null
      });
    } catch (error) {
      failAutoHandoffRunPhase(queuePhase, error);
      throw error;
    }

    const continuationBaselineSummary = queue && queue.resume_context && queue.resume_context.previous_batch_summary
      ? queue.resume_context.previous_batch_summary
      : null;

    if (result.dry_run) {
      skipAutoHandoffRunPhase(result, 'execution', 'Autonomous close-loop-batch', 'dry-run');
      skipAutoHandoffRunPhase(result, 'observability', 'Observability snapshot', 'dry-run');
      result.dependency_execution = buildAutoHandoffExecutionBatches(
        result.handoff,
        Array.isArray(queue && queue.goals) ? queue.goals : [],
        result.policy.dependency_batching
      );
      result.spec_status = buildAutoHandoffSpecStatus(
        result.handoff && Array.isArray(result.handoff.specs) ? result.handoff.specs : [],
        null,
        continuationBaselineSummary
      );
      result.gates = evaluateAutoHandoffRunGates({
        policy: result.policy,
        dryRun: true,
        specStatus: result.spec_status,
        ontology: result.ontology_validation,
        moquiBaseline: result.moqui_baseline,
        scenePackageBatch: result.scene_package_batch,
        capabilityCoverage: result.moqui_capability_coverage,
        programKpi: {
          risk_level: 'low'
        }
      });
      result.status = 'dry-run';
      return result;
    }

    const executionPhase = beginAutoHandoffRunPhase(result, 'execution', 'Autonomous close-loop-batch');
    let executionResult = null;
    try {
      executionResult = await executeAutoHandoffExecutionBatches(projectPath, result.handoff, queue, {
        queueOut: options.queueOut,
        continueOnError: options.continueOnError,
        batchAutonomous: options.batchAutonomous,
        batchParallel: options.batchParallel,
        batchAgentBudget: options.batchAgentBudget,
        batchRetryRounds: options.batchRetryRounds,
        batchRetryUntilComplete: options.batchRetryUntilComplete,
        batchRetryMaxRounds: options.batchRetryMaxRounds,
        dependencyBatching: result.policy.dependency_batching
      });
      result.dependency_execution = executionResult.execution_plan;
      result.batch_summary = executionResult.summary;
      result.spec_status = buildAutoHandoffSpecStatus(
        result.handoff && Array.isArray(result.handoff.specs) ? result.handoff.specs : [],
        result.batch_summary,
        continuationBaselineSummary
      );
      completeAutoHandoffRunPhase(executionPhase, {
        status: result.batch_summary.status,
        processed_goals: result.batch_summary.processed_goals,
        failed_goals: result.batch_summary.failed_goals,
        execution_batches: Array.isArray(executionResult.execution_batches)
          ? executionResult.execution_batches.length
          : 0
      });
    } catch (error) {
      failAutoHandoffRunPhase(executionPhase, error);
      throw error;
    }

    const observabilityPhase = beginAutoHandoffRunPhase(result, 'observability', 'Observability snapshot');
    try {
      result.observability_snapshot = await buildAutoObservabilitySnapshot(projectPath, options);
      const observabilityWeeklyOps = extractAutoObservabilityWeeklyOpsStopTelemetry(result.observability_snapshot);
      completeAutoHandoffRunPhase(observabilityPhase, {
        risk_level: result.observability_snapshot && result.observability_snapshot.highlights
          ? result.observability_snapshot.highlights.governance_risk_level
          : null,
        weekly_ops_stop_sessions: Number(
          observabilityWeeklyOps && observabilityWeeklyOps.sessions
        ) || 0,
        weekly_ops_high_pressure_sessions: Number(
          observabilityWeeklyOps && observabilityWeeklyOps.high_pressure_sessions
        ) || 0,
        weekly_ops_config_warning_positive_sessions: Number(
          observabilityWeeklyOps && observabilityWeeklyOps.config_warning_positive_sessions
        ) || 0,
        weekly_ops_auth_tier_pressure_sessions: Number(
          observabilityWeeklyOps && observabilityWeeklyOps.auth_tier_pressure_sessions
        ) || 0,
        weekly_ops_dialogue_authorization_pressure_sessions: Number(
          observabilityWeeklyOps && observabilityWeeklyOps.dialogue_authorization_pressure_sessions
        ) || 0,
        weekly_ops_runtime_block_rate_high_sessions: Number(
          observabilityWeeklyOps && observabilityWeeklyOps.runtime_block_rate_high_sessions
        ) || 0,
        weekly_ops_runtime_ui_mode_violation_high_sessions: Number(
          observabilityWeeklyOps && observabilityWeeklyOps.runtime_ui_mode_violation_high_sessions
        ) || 0,
        weekly_ops_runtime_ui_mode_violation_total_sum: Number(
          observabilityWeeklyOps && observabilityWeeklyOps.runtime_ui_mode_violation_total_sum
        ) || 0
      });
    } catch (error) {
      failAutoHandoffRunPhase(observabilityPhase, error);
      throw error;
    }

    result.gates = evaluateAutoHandoffRunGates({
      policy: result.policy,
      dryRun: false,
      specStatus: result.spec_status,
      ontology: result.ontology_validation,
      moquiBaseline: result.moqui_baseline,
      scenePackageBatch: result.scene_package_batch,
      capabilityCoverage: result.moqui_capability_coverage,
      programKpi: buildProgramKpiSnapshot(result.batch_summary || {})
    });
    if (!result.gates.passed) {
      throw new Error(`handoff run gate failed: ${result.gates.reasons.join('; ')}`);
    }
    result.status = 'completed';
  } catch (error) {
    result.status = 'failed';
    result.error = error && error.message ? error.message : `${error}`;
  } finally {
    result.completed_at = new Date().toISOString();
    result.elapsed_ms = Math.max(0, Date.now() - startedAtMs);
    result.regression = await buildAutoHandoffRegression(projectPath, result);
    result.remediation_queue = await maybeWriteAutoHandoffMoquiRemediationQueue(projectPath, result);
    result.failure_summary = buildAutoHandoffRunFailureSummary(result);
    result.recommendations = buildAutoHandoffRunRecommendations(projectPath, result);
    await writeAutoHandoffRunReport(projectPath, result, options.out);
    if (result.dry_run) {
      result.release_evidence = {
        mode: 'auto-handoff-release-evidence',
        merged: false,
        skipped: true,
        reason: 'dry-run',
        file: path.join(projectPath, AUTO_HANDOFF_RELEASE_EVIDENCE_FILE)
      };
    } else {
      try {
        result.release_evidence = await mergeAutoHandoffRunIntoReleaseEvidence(projectPath, result, result.output_file);
      } catch (mergeError) {
        const message = mergeError && mergeError.message ? mergeError.message : `${mergeError}`;
        result.release_evidence = {
          mode: 'auto-handoff-release-evidence',
          merged: false,
          file: path.join(projectPath, AUTO_HANDOFF_RELEASE_EVIDENCE_FILE),
          error: message
        };
        result.warnings.push(`release evidence merge failed: ${message}`);
      }
    }
    try {
      await writeAutoHandoffRunReport(projectPath, result, options.out);
    } catch (refreshError) {
      const message = refreshError && refreshError.message ? refreshError.message : `${refreshError}`;
      result.warnings.push(`handoff run report refresh failed: ${message}`);
    }
  }

  return result;
}

function buildProgramKpiSnapshot(summary) {
  const results = Array.isArray(summary && summary.results) ? summary.results : [];
  const totalGoals = Number(summary && summary.total_goals) || results.length || 1;
  const completedGoals = Number(summary && summary.completed_goals) || 0;
  const failedGoals = Number(summary && summary.failed_goals) || 0;
  const processedGoals = Number(summary && summary.processed_goals) || results.length;
  const completionRate = Number(((completedGoals / totalGoals) * 100).toFixed(2));
  const failureRate = Number(((failedGoals / totalGoals) * 100).toFixed(2));
  const averageWaitTicks = Number(
    (
      results.reduce((sum, item) => sum + (Number(item && item.wait_ticks) || 0), 0) /
      (results.length || 1)
    ).toFixed(2)
  );
  const highComplexityGoals = results.filter(item => (Number(item && item.goal_weight) || 0) >= 3).length;
  const highComplexityRatioPercent = Number(((highComplexityGoals / totalGoals) * 100).toFixed(2));
  const retry = summary && summary.batch_retry ? summary.batch_retry : {};
  const retryHistory = Array.isArray(retry.history) ? retry.history : [];
  const firstRoundUnresolved = retryHistory.length > 0
    ? (Number(retryHistory[0].failed_goals) || 0) + (Number(retryHistory[0].unprocessed_goals) || 0)
    : failedGoals;
  const recoveredGoals = Math.max(0, firstRoundUnresolved - failedGoals);
  const retryRecoveryRatePercent = firstRoundUnresolved > 0
    ? Number(((recoveredGoals / firstRoundUnresolved) * 100).toFixed(2))
    : 100;

  let convergenceState = 'converged';
  if (summary && summary.status === 'partial-failed') {
    convergenceState = 'at-risk';
  } else if (summary && summary.status === 'failed') {
    convergenceState = 'blocked';
  }

  let riskLevel = 'low';
  if (failureRate > 20 || convergenceState === 'blocked') {
    riskLevel = 'high';
  } else if (failureRate > 0 || (Number(retry.performed_rounds) || 0) > 0) {
    riskLevel = 'medium';
  }

  return {
    generated_at: new Date().toISOString(),
    completion_rate_percent: completionRate,
    failure_rate_percent: failureRate,
    processed_goals: processedGoals,
    high_complexity_goal_ratio_percent: highComplexityRatioPercent,
    average_wait_ticks: averageWaitTicks,
    retry_rounds_performed: Number(retry.performed_rounds) || 0,
    retry_recovery_rate_percent: retryRecoveryRatePercent,
    convergence_state: convergenceState,
    risk_level: riskLevel
  };
}

function evaluateProgramConvergenceGate(summary, policy = {}) {
  const metrics = summary && summary.metrics && typeof summary.metrics === 'object'
    ? summary.metrics
    : {};
  const programKpi = summary && summary.program_kpi && typeof summary.program_kpi === 'object'
    ? summary.program_kpi
    : buildProgramKpiSnapshot(summary || {});
  const resolvedPolicy = resolveProgramGatePolicy(policy);
  const minSuccessRate = resolvedPolicy.minSuccessRate;
  const maxRiskLevel = resolvedPolicy.maxRiskLevel;
  const maxElapsedMinutes = resolvedPolicy.maxElapsedMinutes;
  const maxAgentBudget = resolvedPolicy.maxAgentBudget;
  const maxTotalSubSpecs = resolvedPolicy.maxTotalSubSpecs;
  const completionRateFromKpi = Number(programKpi.completion_rate_percent);
  const successRateFromMetrics = Number(metrics.success_rate_percent);
  const successRate = Number.isFinite(completionRateFromKpi)
    ? completionRateFromKpi
    : (Number.isFinite(successRateFromMetrics) ? successRateFromMetrics : null);
  const elapsedMsCandidate = Number(summary && summary.program_elapsed_ms);
  const elapsedMs = Number.isFinite(elapsedMsCandidate) && elapsedMsCandidate >= 0
    ? elapsedMsCandidate
    : null;
  const elapsedMinutes = elapsedMs === null
    ? null
    : Number((elapsedMs / 60000).toFixed(2));
  const resourcePlan = summary && summary.resource_plan && typeof summary.resource_plan === 'object'
    ? summary.resource_plan
    : {};
  const agentBudgetCandidate = Number(resourcePlan.agent_budget);
  const effectiveParallelCandidate = Number(resourcePlan.effective_goal_parallel);
  const batchParallelCandidate = Number(summary && summary.batch_parallel);
  const actualAgentBudget = Number.isFinite(agentBudgetCandidate) && agentBudgetCandidate > 0
    ? agentBudgetCandidate
    : Number.isFinite(effectiveParallelCandidate) && effectiveParallelCandidate > 0
      ? effectiveParallelCandidate
      : Number.isFinite(batchParallelCandidate) && batchParallelCandidate > 0
        ? batchParallelCandidate
        : null;
  const totalSubSpecsFromMetrics = Number(metrics.total_sub_specs);
  const totalSubSpecs = Number.isFinite(totalSubSpecsFromMetrics)
    ? totalSubSpecsFromMetrics
    : (
      Array.isArray(summary && summary.results)
        ? summary.results.reduce((sum, item) => sum + (Number(item && item.sub_spec_count) || 0), 0)
        : null
    );
  const riskLevel = `${programKpi.risk_level || 'high'}`.trim().toLowerCase();
  const riskRank = {
    low: 1,
    medium: 2,
    high: 3
  };
  const reasons = [];
  if (!Number.isFinite(successRate)) {
    reasons.push('success_rate_percent unavailable');
  } else if (successRate < minSuccessRate) {
    reasons.push(`success_rate_percent ${successRate} < required ${minSuccessRate}`);
  }
  if ((riskRank[riskLevel] || 3) > (riskRank[maxRiskLevel] || 3)) {
    reasons.push(`risk_level ${riskLevel} exceeds allowed ${maxRiskLevel}`);
  }
  if (maxElapsedMinutes !== null) {
    if (!Number.isFinite(elapsedMinutes)) {
      reasons.push('program_elapsed_minutes unavailable');
    } else if (elapsedMinutes > maxElapsedMinutes) {
      reasons.push(`program_elapsed_minutes ${elapsedMinutes} exceeds allowed ${maxElapsedMinutes}`);
    }
  }
  if (maxAgentBudget !== null) {
    if (!Number.isFinite(actualAgentBudget)) {
      reasons.push('agent_budget unavailable');
    } else if (actualAgentBudget > maxAgentBudget) {
      reasons.push(`agent_budget ${actualAgentBudget} exceeds allowed ${maxAgentBudget}`);
    }
  }
  if (maxTotalSubSpecs !== null) {
    if (!Number.isFinite(totalSubSpecs)) {
      reasons.push('total_sub_specs unavailable');
    } else if (totalSubSpecs > maxTotalSubSpecs) {
      reasons.push(`total_sub_specs ${totalSubSpecs} exceeds allowed ${maxTotalSubSpecs}`);
    }
  }

  return {
    passed: reasons.length === 0,
    policy: {
      profile: resolvedPolicy.profile,
      min_success_rate_percent: minSuccessRate,
      max_risk_level: maxRiskLevel,
      max_elapsed_minutes: maxElapsedMinutes,
      max_agent_budget: maxAgentBudget,
      max_total_sub_specs: maxTotalSubSpecs
    },
    actual: {
      success_rate_percent: Number.isFinite(successRate) ? successRate : null,
      risk_level: riskLevel,
      elapsed_minutes: Number.isFinite(elapsedMinutes) ? elapsedMinutes : null,
      agent_budget: Number.isFinite(actualAgentBudget) ? actualAgentBudget : null,
      total_sub_specs: Number.isFinite(totalSubSpecs) ? totalSubSpecs : null
    },
    reasons
  };
}

async function applyProgramGateOutcome(summary, context = {}) {
  const projectPath = context && context.projectPath ? context.projectPath : process.cwd();
  const options = context && context.options && typeof context.options === 'object'
    ? context.options
    : {};
  const resolvedPolicy = resolveProgramGatePolicy(context && context.programGatePolicy ? context.programGatePolicy : {});
  const gateFallbackChain = Array.isArray(context && context.gateFallbackChain)
    ? context.gateFallbackChain
    : [];
  const enableAutoRemediation = context && context.enableAutoRemediation !== undefined
    ? Boolean(context.enableAutoRemediation)
    : true;

  summary.program_gate = evaluateProgramConvergenceGate(summary, {
    profile: resolvedPolicy.profile,
    minSuccessRate: resolvedPolicy.minSuccessRate,
    maxRiskLevel: resolvedPolicy.maxRiskLevel,
    maxElapsedMinutes: resolvedPolicy.maxElapsedMinutes,
    maxAgentBudget: resolvedPolicy.maxAgentBudget,
    maxTotalSubSpecs: resolvedPolicy.maxTotalSubSpecs
  });

  let effectiveGatePassed = summary.program_gate.passed;
  let effectiveGateSource = 'primary';
  let matchedFallbackProfile = null;
  summary.program_gate_fallbacks = [];
  if (!effectiveGatePassed && gateFallbackChain.length > 0) {
    for (const fallbackProfile of gateFallbackChain) {
      const fallbackResult = evaluateProgramConvergenceGate(summary, {
        profile: fallbackProfile,
        maxElapsedMinutes: resolvedPolicy.maxElapsedMinutes,
        maxAgentBudget: resolvedPolicy.maxAgentBudget,
        maxTotalSubSpecs: resolvedPolicy.maxTotalSubSpecs
      });
      summary.program_gate_fallbacks.push(fallbackResult);
      if (fallbackResult.passed) {
        effectiveGatePassed = true;
        effectiveGateSource = 'fallback-chain';
        matchedFallbackProfile = fallbackProfile;
        break;
      }
    }
  }
  summary.program_gate_fallback = summary.program_gate_fallbacks.length > 0
    ? summary.program_gate_fallbacks[0]
    : null;
  summary.program_gate_effective = {
    passed: effectiveGatePassed,
    source: effectiveGateSource,
    primary_passed: Boolean(summary.program_gate && summary.program_gate.passed),
    fallback_profile: matchedFallbackProfile,
    fallback_chain: gateFallbackChain,
    fallback_passed: matchedFallbackProfile !== null,
    attempted_fallback_count: summary.program_gate_fallbacks.length
  };

  if (
    enableAutoRemediation &&
    (
      !summary.program_gate_effective.passed ||
      isSpecSessionBudgetHardFailure(summary) ||
      isSpecSessionGrowthGuardHardFailure(summary)
    )
  ) {
    summary.program_gate_auto_remediation = await applyProgramGateAutoRemediation(summary, {
      projectPath,
      options
    });
  }

  return summary;
}

function hasRecoverableProgramGoals(summary) {
  const failedStatuses = getBatchFailureStatusSet();
  const results = Array.isArray(summary && summary.results) ? summary.results : [];
  return results.some(item => failedStatuses.has(`${item && item.status ? item.status : ''}`.trim().toLowerCase()));
}

function applyAnomalyBatchConcurrencyReductionPatch(summary, patch, reasons, options, anomalyType) {
  const currentParallelCandidate = patch.batchParallel !== undefined && patch.batchParallel !== null
    ? patch.batchParallel
    : (
      options.batchParallel !== undefined && options.batchParallel !== null
        ? options.batchParallel
        : (summary && summary.batch_parallel ? summary.batch_parallel : 1)
    );
  const currentParallel = normalizeBatchParallel(currentParallelCandidate);
  if (currentParallel > 1) {
    patch.batchParallel = currentParallel - 1;
    reasons.push(`reduce batch parallel from ${currentParallel} to ${patch.batchParallel} due to ${anomalyType}`);
  }

  const currentAgentBudgetCandidate = patch.batchAgentBudget !== undefined && patch.batchAgentBudget !== null
    ? patch.batchAgentBudget
    : (
      options.batchAgentBudget !== undefined && options.batchAgentBudget !== null
        ? options.batchAgentBudget
        : (summary && summary.resource_plan ? summary.resource_plan.agent_budget : null)
    );
  const currentAgentBudget = normalizeBatchAgentBudget(currentAgentBudgetCandidate);
  if (currentAgentBudget !== null && currentAgentBudget > 1) {
    patch.batchAgentBudget = currentAgentBudget - 1;
    reasons.push(`reduce batch agent budget from ${currentAgentBudget} to ${patch.batchAgentBudget} due to ${anomalyType}`);
  }
}

function buildProgramAnomalyGovernancePatch(summary, anomalies, options = {}) {
  const sourceAnomalies = Array.isArray(anomalies) ? anomalies : [];
  const highAnomalies = sourceAnomalies.filter(item => `${item && item.severity ? item.severity : ''}`.trim().toLowerCase() === 'high');
  const patch = {};
  const reasons = [];

  const anomalyTypes = new Set(highAnomalies.map(item => `${item && item.type ? item.type : ''}`.trim().toLowerCase()));
  if (anomalyTypes.has('success-rate-drop')) {
    const currentRetryRounds = normalizeBatchRetryRounds(options.batchRetryRounds);
    patch.batchRetryRounds = Math.min(5, Math.max(1, currentRetryRounds + 1));
    patch.batchRetryUntilComplete = true;
    reasons.push('increase retry rounds due to success-rate-drop anomaly');
  }

  if (anomalyTypes.has('failed-goals-spike')) {
    applyAnomalyBatchConcurrencyReductionPatch(summary, patch, reasons, options, 'failed-goals-spike');
  }

  if (anomalyTypes.has('rate-limit-spike')) {
    applyAnomalyBatchConcurrencyReductionPatch(summary, patch, reasons, options, 'rate-limit-spike');
  }

  if (anomalyTypes.has('spec-growth-spike')) {
    patch.specSessionBudgetHardFail = true;
    reasons.push('enable spec-session budget hard-fail due to spec-growth-spike');
    if (options.specSessionMaxCreated === undefined || options.specSessionMaxCreated === null) {
      const estimatedCreated = Number(summary && summary.spec_session_budget && summary.spec_session_budget.estimated_created) || 0;
      patch.specSessionMaxCreated = Math.max(1, Math.ceil(estimatedCreated * 0.8));
      reasons.push(`set specSessionMaxCreated=${patch.specSessionMaxCreated} due to spec-growth-spike`);
    }
  }

  return {
    patch,
    reasons,
    anomaly_count: highAnomalies.length,
    anomaly_types: [...anomalyTypes]
  };
}

function applyProgramGovernancePatch(baseOptions, patch) {
  const merged = { ...baseOptions };
  const sourcePatch = patch && typeof patch === 'object' ? patch : {};
  for (const [key, value] of Object.entries(sourcePatch)) {
    if (value === undefined) {
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function buildProgramGovernanceReplayGoalsResult(baseGoalsResult, round, summary) {
  const source = baseGoalsResult && typeof baseGoalsResult === 'object'
    ? baseGoalsResult
    : { file: '(generated-from-goal)', goals: [] };
  const sourceSummary = summary && typeof summary === 'object' ? summary : {};
  return {
    ...source,
    file: source.file || '(generated-from-goal)',
    resumedFromSummary: {
      file: sourceSummary.batch_session && sourceSummary.batch_session.file
        ? sourceSummary.batch_session.file
        : '(program-governance-replay)',
      strategy: 'program-governance-replay',
      round,
      previous_status: sourceSummary.status || null,
      previous_total_goals: Number(sourceSummary.total_goals) || null,
      previous_processed_goals: Number(sourceSummary.processed_goals) || null
    }
  };
}

async function runProgramGovernanceLoop(context = {}) {
  let summary = context.summary && typeof context.summary === 'object' ? context.summary : {};
  const projectPath = context.projectPath || process.cwd();
  const baseProgramOptions = context.programOptions && typeof context.programOptions === 'object'
    ? context.programOptions
    : {};
  const baseGoalsResult = context.baseGoalsResult && typeof context.baseGoalsResult === 'object'
    ? context.baseGoalsResult
    : { file: '(generated-from-goal)', goals: [] };
  const enabled = Boolean(context.enabled);
  const maxRounds = normalizeProgramGovernMaxRounds(context.maxRounds);
  const maxDurationMinutes = normalizeProgramGovernMaxMinutes(context.maxMinutes);
  const maxDurationMs = maxDurationMinutes * 60 * 1000;
  const anomalyEnabled = context.anomalyEnabled !== false;
  const anomalyWeeks = normalizeProgramGovernAnomalyWeeks(context.anomalyWeeks);
  const anomalyPeriod = normalizeAutoKpiTrendPeriod(context.anomalyPeriod);
  const governUseAction = normalizeProgramGovernUseAction(context.governUseAction);
  const governAutoActionEnabled = context.governAutoActionEnabled !== false;
  const governActionEnabled = governAutoActionEnabled || governUseAction !== null;
  const programGatePolicy = resolveProgramGatePolicy(context.programGatePolicy || {});
  const gateFallbackChain = Array.isArray(context.gateFallbackChain) ? context.gateFallbackChain : [];
  const recoveryMemoryScope = context.recoveryMemoryScope || null;
  const normalizedRecoveryScope = normalizeRecoveryMemoryToken(recoveryMemoryScope || '') || 'default-scope';
  const recoverResumeStrategy = normalizeResumeStrategy(context.recoverResumeStrategy || 'pending');
  const recoverMaxRounds = normalizeRecoverMaxRounds(context.recoverMaxRounds);
  const recoverMaxMinutes = normalizeRecoverMaxMinutes(
    context.recoverMaxMinutes,
    '--program-recover-max-minutes'
  );
  const recoverMaxDurationMs = recoverMaxMinutes === null ? null : recoverMaxMinutes * 60 * 1000;
  const governanceStartedAt = Date.now();
  const history = [];
  let exhausted = false;
  let stopReason = enabled ? 'stable' : 'disabled';
  let settled = false;

  if (!enabled) {
    return {
      summary,
      governance: {
        enabled: false,
        anomaly_enabled: anomalyEnabled,
        anomaly_weeks: anomalyWeeks,
        anomaly_period: anomalyPeriod,
        auto_action_enabled: governAutoActionEnabled,
        action_selection_enabled: false,
        pinned_action_index: governUseAction,
        max_rounds: maxRounds,
        max_minutes: maxDurationMinutes,
        performed_rounds: 0,
        converged: Boolean(
          summary &&
          summary.program_gate_effective &&
          summary.program_gate_effective.passed &&
          !isSpecSessionBudgetHardFailure(summary) &&
          !isSpecSessionGrowthGuardHardFailure(summary)
        ),
        exhausted: false,
        stop_reason: 'disabled',
        history: []
      }
    };
  }

  for (let round = 1; round <= maxRounds; round += 1) {
    const elapsedBeforeRound = Date.now() - governanceStartedAt;
    if (elapsedBeforeRound >= maxDurationMs) {
      exhausted = true;
      stopReason = 'time-budget-exhausted';
      break;
    }

    let trendResult = null;
    let anomalies = [];
    if (anomalyEnabled) {
      trendResult = await buildAutoKpiTrend(projectPath, {
        weeks: anomalyWeeks,
        mode: 'program',
        period: anomalyPeriod
      });
      anomalies = Array.isArray(trendResult.anomalies) ? trendResult.anomalies : [];
      summary.program_kpi_trend = {
        generated_at: trendResult.generated_at,
        weeks: trendResult.weeks,
        period_unit: trendResult.period_unit,
        total_runs: trendResult.total_runs,
        overall: trendResult.overall,
        anomaly_detection: trendResult.anomaly_detection || null
      };
      summary.program_kpi_anomalies = anomalies;
    }

    const gateFailed = Boolean(
      !summary.program_gate_effective ||
      !summary.program_gate_effective.passed ||
      isSpecSessionBudgetHardFailure(summary) ||
      isSpecSessionGrowthGuardHardFailure(summary)
    );
    const highSeverityAnomalies = anomalies.filter(item => `${item && item.severity ? item.severity : ''}`.trim().toLowerCase() === 'high');
    const anomalyFailed = anomalyEnabled && highSeverityAnomalies.length > 0;
    if (!gateFailed && !anomalyFailed) {
      stopReason = 'stable';
      settled = true;
      break;
    }

    const gatePatch = summary && summary.program_gate_auto_remediation && summary.program_gate_auto_remediation.next_run_patch
      ? summary.program_gate_auto_remediation.next_run_patch
      : {};
    const anomalyPatch = buildProgramAnomalyGovernancePatch(summary, highSeverityAnomalies, baseProgramOptions);
    let governanceActionSelection = null;
    let governanceActionPatch = {};
    if (governActionEnabled) {
      const recoveryMemory = await loadCloseLoopRecoveryMemory(projectPath);
      const recoverySignature = buildRecoveryMemorySignature(summary, {
        scope: normalizedRecoveryScope
      });
      const recoveryMemoryEntry = getRecoveryMemoryEntry(recoveryMemory.payload, recoverySignature);
      governanceActionSelection = resolveRecoveryActionSelection(summary, governUseAction, {
        recoveryMemoryEntry,
        optionLabel: '--program-govern-use-action'
      });
      governanceActionPatch = governanceActionSelection &&
        governanceActionSelection.appliedPatch &&
        typeof governanceActionSelection.appliedPatch === 'object'
        ? governanceActionSelection.appliedPatch
        : {};
    }
    const roundPatch = {
      ...(governanceActionPatch && typeof governanceActionPatch === 'object' ? governanceActionPatch : {}),
      ...(anomalyPatch.patch || {}),
      ...(gatePatch && typeof gatePatch === 'object' ? gatePatch : {})
    };
    if (Object.keys(roundPatch).length === 0) {
      stopReason = 'no-actionable-patch';
      history.push({
        round,
        status_before: summary.status,
        status_after: summary.status,
        trigger: {
          gate_failed: gateFailed,
          anomaly_failed: anomalyFailed,
          anomaly_count: highSeverityAnomalies.length
        },
        selected_action_index: governanceActionSelection ? governanceActionSelection.selectedIndex : null,
        selected_action: governanceActionSelection && governanceActionSelection.selectedAction
          ? governanceActionSelection.selectedAction.action
          : null,
        selected_action_priority: governanceActionSelection && governanceActionSelection.selectedAction
          ? governanceActionSelection.selectedAction.priority
          : null,
        action_selection_source: governanceActionSelection ? governanceActionSelection.selectionSource : null,
        action_selection_explain: governanceActionSelection ? governanceActionSelection.selectionExplain || null : null,
        execution_mode: 'none',
        applied_patch: null,
        notes: [
          'No actionable governance patch generated.'
        ]
      });
      break;
    }

    const roundOptions = applyProgramGovernancePatch(baseProgramOptions, roundPatch);
    roundOptions.out = null;
    roundOptions.programKpiOut = null;
    roundOptions.programAuditOut = null;

    const statusBefore = summary.status;
    const failedGoalsBefore = Number(summary.failed_goals) || 0;
    const selectedGovernanceActionIndex = governanceActionSelection ? governanceActionSelection.selectedIndex : null;
    let executionMode = 'program-replay';
    let roundSummary = null;
    if (hasRecoverableProgramGoals(summary)) {
      executionMode = 'recover-cycle';
      const roundSourceSummary = summary.batch_session && summary.batch_session.file
        ? await loadCloseLoopBatchSummaryPayload(projectPath, summary.batch_session.file)
        : {
          file: '(program-governance-derived-summary)',
          payload: summary
        };
      const recoveryResult = await executeCloseLoopRecoveryCycle({
        projectPath,
        sourceSummary: roundSourceSummary,
        baseOptions: {
          ...roundOptions,
          useAction: selectedGovernanceActionIndex || context.programRecoverUseAction
        },
        recoverAutonomousEnabled: true,
        resumeStrategy: recoverResumeStrategy,
        recoverUntilComplete: true,
        recoverMaxRounds,
        recoverMaxDurationMs,
        recoveryMemoryScope,
        actionCandidate: selectedGovernanceActionIndex || context.programRecoverUseAction
      });
      roundSummary = mergeProgramRecoveryIntoProgramSummary(summary, recoveryResult.summary, {
        enabled: true,
        triggered: true,
        governance_round: round,
        recover_until_complete: true,
        source: 'governance-recover-cycle'
      });
      roundSummary.resource_plan = recoveryResult.summary && recoveryResult.summary.resource_plan
        ? recoveryResult.summary.resource_plan
        : roundSummary.resource_plan;
      roundSummary.batch_parallel = Number(recoveryResult.summary && recoveryResult.summary.batch_parallel) || roundSummary.batch_parallel;
    } else {
      const replayGoalsResult = buildProgramGovernanceReplayGoalsResult(baseGoalsResult, round, summary);
      const replaySummary = await executeCloseLoopBatch(
        replayGoalsResult,
        roundOptions,
        projectPath,
        'auto-close-loop-program'
      );
      roundSummary = {
        ...replaySummary,
        auto_recovery: summary && summary.auto_recovery ? summary.auto_recovery : null
      };
    }

    roundSummary.program_kpi = buildProgramKpiSnapshot(roundSummary);
    roundSummary.program_diagnostics = buildProgramDiagnostics(roundSummary);
    roundSummary.program_coordination = buildProgramCoordinationSnapshot(roundSummary);
    await applyProgramGateOutcome(roundSummary, {
      projectPath,
      options: roundOptions,
      programGatePolicy,
      gateFallbackChain,
      enableAutoRemediation: context.programGateAutoRemediate !== false
    });

    const failedGoalsAfter = Number(roundSummary.failed_goals) || 0;
    history.push({
      round,
      status_before: statusBefore,
      status_after: roundSummary.status,
      trigger: {
        gate_failed: gateFailed,
        anomaly_failed: anomalyFailed,
        anomaly_count: highSeverityAnomalies.length
      },
      selected_action_index: selectedGovernanceActionIndex,
      selected_action: governanceActionSelection && governanceActionSelection.selectedAction
        ? governanceActionSelection.selectedAction.action
        : null,
      selected_action_priority: governanceActionSelection && governanceActionSelection.selectedAction
        ? governanceActionSelection.selectedAction.priority
        : null,
      action_selection_source: governanceActionSelection ? governanceActionSelection.selectionSource : null,
      action_selection_explain: governanceActionSelection ? governanceActionSelection.selectionExplain || null : null,
      execution_mode: executionMode,
      applied_patch: roundPatch,
      patch_reasons: [
        ...(governanceActionSelection && governanceActionSelection.selectionExplain
          ? [`governance-action: ${governanceActionSelection.selectionExplain.reason}`]
          : []),
        ...(Array.isArray(anomalyPatch.reasons) ? anomalyPatch.reasons : []),
        ...(summary.program_gate_auto_remediation && Array.isArray(summary.program_gate_auto_remediation.reasons)
          ? summary.program_gate_auto_remediation.reasons
          : [])
      ],
      failed_goals_before: failedGoalsBefore,
      failed_goals_after: failedGoalsAfter
    });

    summary = roundSummary;
    if (
      summary.program_gate_effective &&
      summary.program_gate_effective.passed &&
      !isSpecSessionBudgetHardFailure(summary) &&
      !isSpecSessionGrowthGuardHardFailure(summary)
    ) {
      if (!anomalyEnabled) {
        stopReason = 'gate-stable';
        break;
      }
      const postTrend = await buildAutoKpiTrend(projectPath, {
        weeks: anomalyWeeks,
        mode: 'program',
        period: anomalyPeriod
      });
      const postAnomalies = Array.isArray(postTrend.anomalies) ? postTrend.anomalies : [];
      summary.program_kpi_trend = {
        generated_at: postTrend.generated_at,
        weeks: postTrend.weeks,
        period_unit: postTrend.period_unit,
        total_runs: postTrend.total_runs,
        overall: postTrend.overall,
        anomaly_detection: postTrend.anomaly_detection || null
      };
      summary.program_kpi_anomalies = postAnomalies;
      const hasHighPostAnomaly = postAnomalies.some(item => `${item && item.severity ? item.severity : ''}`.trim().toLowerCase() === 'high');
      if (!hasHighPostAnomaly) {
        stopReason = 'stable';
        settled = true;
        break;
      }
    }
  }

  if (!settled && history.length >= maxRounds && stopReason === 'stable') {
    stopReason = 'round-limit-reached';
    exhausted = true;
  }
  if (!settled && history.length >= maxRounds && stopReason !== 'stable') {
    exhausted = true;
  }

  return {
    summary,
    governance: {
      enabled: true,
      anomaly_enabled: anomalyEnabled,
      anomaly_weeks: anomalyWeeks,
      anomaly_period: anomalyPeriod,
      auto_action_enabled: governAutoActionEnabled,
      action_selection_enabled: governActionEnabled,
      pinned_action_index: governUseAction,
      max_rounds: maxRounds,
      max_minutes: maxDurationMinutes,
      performed_rounds: history.length,
      converged: Boolean(
        summary &&
        summary.program_gate_effective &&
        summary.program_gate_effective.passed &&
        !isSpecSessionBudgetHardFailure(summary) &&
        !isSpecSessionGrowthGuardHardFailure(summary)
      ),
      exhausted,
      stop_reason: stopReason,
      history
    }
  };
}

async function applyProgramGateAutoRemediation(summary, context = {}) {
  const projectPath = context && context.projectPath ? context.projectPath : process.cwd();
  const options = context && context.options && typeof context.options === 'object'
    ? context.options
    : {};
  const gate = summary && summary.program_gate && typeof summary.program_gate === 'object'
    ? summary.program_gate
    : null;
  const policy = gate && gate.policy && typeof gate.policy === 'object' ? gate.policy : {};
  const reasons = Array.isArray(gate && gate.reasons) ? gate.reasons : [];
  const actions = [];
  const nextRunPatch = {};

  const maxAgentBudget = Number(policy.max_agent_budget);
  if (
    reasons.some(reason => `${reason || ''}`.includes('agent_budget')) &&
    Number.isFinite(maxAgentBudget) &&
    maxAgentBudget > 0
  ) {
    const currentAgentBudget = Number(options.batchAgentBudget || (summary && summary.batch_parallel) || 0);
    nextRunPatch.batchAgentBudget = maxAgentBudget;
    nextRunPatch.batchParallel = Math.max(1, Math.min(currentAgentBudget || maxAgentBudget, maxAgentBudget));
    actions.push({
      type: 'reduce-agent-budget',
      applied: true,
      details: `Set batchAgentBudget=${nextRunPatch.batchAgentBudget}, batchParallel=${nextRunPatch.batchParallel}.`
    });
  }

  const maxTotalSubSpecs = Number(policy.max_total_sub_specs);
  if (
    reasons.some(reason => `${reason || ''}`.includes('total_sub_specs')) &&
    Number.isFinite(maxTotalSubSpecs) &&
    maxTotalSubSpecs > 0
  ) {
    const avgSubSpecs = Number(summary && summary.metrics && summary.metrics.average_sub_specs_per_goal) || 1;
    const totalGoals = Number(summary && summary.total_goals) || 2;
    const suggestedProgramGoals = Math.max(2, Math.min(totalGoals, Math.floor(maxTotalSubSpecs / Math.max(1, avgSubSpecs))));
    nextRunPatch.programGoals = suggestedProgramGoals;
    actions.push({
      type: 'shrink-goal-width',
      applied: true,
      details: `Set programGoals=${suggestedProgramGoals} using max_total_sub_specs=${maxTotalSubSpecs}.`
    });
  }

  const maxElapsedMinutes = Number(policy.max_elapsed_minutes);
  if (
    reasons.some(reason => `${reason || ''}`.includes('program_elapsed_minutes')) &&
    Number.isFinite(maxElapsedMinutes) &&
    maxElapsedMinutes > 0
  ) {
    const totalGoals = Number(summary && summary.total_goals) || 2;
    const reducedProgramGoals = Math.max(2, Math.min(totalGoals, Math.ceil(totalGoals * 0.8)));
    nextRunPatch.programGoals = Math.min(
      Number(nextRunPatch.programGoals) || reducedProgramGoals,
      reducedProgramGoals
    );
    nextRunPatch.batchRetryRounds = 0;
    actions.push({
      type: 'time-budget-constrain',
      applied: true,
      details: `Set programGoals=${nextRunPatch.programGoals}, batchRetryRounds=0 for elapsed budget ${maxElapsedMinutes}m.`
    });
  }

  let appliedSpecPrune = null;
  const specBudget = summary && summary.spec_session_budget && summary.spec_session_budget.enabled
    ? summary.spec_session_budget
    : null;
  if (specBudget && specBudget.over_limit_after && Number.isFinite(Number(specBudget.max_total))) {
    try {
      const currentRunSpecNames = collectSpecNamesFromBatchSummary(summary || {});
      appliedSpecPrune = await pruneSpecSessions(projectPath, {
        keep: Number(specBudget.max_total),
        olderThanDays: null,
        dryRun: false,
        protectActive: true,
        protectWindowDays: options.specSessionProtectWindowDays,
        additionalProtectedSpecs: currentRunSpecNames
      });
      summary.spec_session_auto_prune = appliedSpecPrune;
      const specsAfter = await readSpecSessionEntries(projectPath);
      const totalAfter = specsAfter.length;
      const prunedCount = Number(appliedSpecPrune && appliedSpecPrune.deleted_count) || 0;
      summary.spec_session_budget = {
        ...specBudget,
        total_after: totalAfter,
        pruned_count: (Number(specBudget.pruned_count) || 0) + prunedCount,
        estimated_created: Math.max(0, totalAfter + ((Number(specBudget.pruned_count) || 0) + prunedCount) - specBudget.total_before),
        over_limit_after: totalAfter > specBudget.max_total,
        hard_fail_triggered: Boolean(specBudget.hard_fail && totalAfter > specBudget.max_total)
      };
      actions.push({
        type: 'trigger-spec-prune',
        applied: true,
        details: `Pruned specs to enforce max_total=${specBudget.max_total}. deleted=${appliedSpecPrune.deleted_count}`
      });
    } catch (error) {
      actions.push({
        type: 'trigger-spec-prune',
        applied: false,
        error: error.message
      });
    }
  }

  const hasPatch = Object.keys(nextRunPatch).length > 0;
  return {
    enabled: true,
    attempted_at: new Date().toISOString(),
    reason_count: reasons.length,
    reasons,
    actions,
    next_run_patch: hasPatch ? nextRunPatch : null,
    applied_spec_prune: appliedSpecPrune
  };
}

function normalizeFailureSignatureFromError(errorMessage) {
  if (typeof errorMessage !== 'string' || !errorMessage.trim()) {
    return 'no-error-details';
  }

  return errorMessage
    .toLowerCase()
    .replace(/[0-9]+/g, '#')
    .replace(/[a-z]:\\[^ ]+/gi, '<path>')
    .replace(/\/[^ ]+/g, '<path>')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

async function maybeWriteProgramKpi(summary, outCandidate, projectPath) {
  if (!outCandidate) {
    return;
  }

  const outputPath = path.isAbsolute(outCandidate)
    ? outCandidate
    : path.join(projectPath, outCandidate);
  await fs.ensureDir(path.dirname(outputPath));
  await fs.writeJson(outputPath, {
    mode: summary.mode === 'auto-close-loop-recover'
      ? 'auto-close-loop-recover-kpi'
      : 'auto-close-loop-program-kpi',
    program_mode: summary.mode,
    status: summary.status,
    program_started_at: summary.program_started_at || null,
    program_completed_at: summary.program_completed_at || null,
    program_elapsed_ms: Number.isFinite(Number(summary.program_elapsed_ms))
      ? Number(summary.program_elapsed_ms)
      : null,
    total_goals: summary.total_goals,
    processed_goals: summary.processed_goals,
    completed_goals: summary.completed_goals,
    failed_goals: summary.failed_goals,
    metrics: summary.metrics,
    program_kpi: summary.program_kpi,
    program_diagnostics: summary.program_diagnostics,
    program_coordination: summary.program_coordination || null,
    auto_recovery: summary.auto_recovery || null,
    program_governance: summary.program_governance || null,
    program_kpi_trend: summary.program_kpi_trend || null,
    program_kpi_anomalies: Array.isArray(summary.program_kpi_anomalies) ? summary.program_kpi_anomalies : [],
    goal_input_guard: summary.goal_input_guard || null,
    spec_session_budget: summary.spec_session_budget || null,
    spec_session_growth_guard: summary.spec_session_growth_guard || null,
    spec_session_auto_prune: summary.spec_session_auto_prune || null,
    program_gate_auto_remediation: summary.program_gate_auto_remediation || null,
    program_gate: summary.program_gate || null,
    program_gate_fallback: summary.program_gate_fallback || null,
    program_gate_fallbacks: summary.program_gate_fallbacks || [],
    program_gate_effective: summary.program_gate_effective || null
  }, { spaces: 2 });
  summary.program_kpi_file = outputPath;
}

async function maybeWriteProgramAudit(summary, outCandidate, projectPath) {
  if (!outCandidate) {
    return;
  }
  const outputPath = path.isAbsolute(outCandidate)
    ? outCandidate
    : path.join(projectPath, outCandidate);
  await fs.ensureDir(path.dirname(outputPath));
  await fs.writeJson(outputPath, {
    mode: 'auto-close-loop-program-audit',
    generated_at: new Date().toISOString(),
    summary_mode: summary && summary.mode ? summary.mode : null,
    status: summary && summary.status ? summary.status : null,
    program_started_at: summary && summary.program_started_at ? summary.program_started_at : null,
    program_completed_at: summary && summary.program_completed_at ? summary.program_completed_at : null,
    program_elapsed_ms: Number.isFinite(Number(summary && summary.program_elapsed_ms))
      ? Number(summary && summary.program_elapsed_ms)
      : null,
    totals: {
      total_goals: Number(summary && summary.total_goals) || 0,
      processed_goals: Number(summary && summary.processed_goals) || 0,
      completed_goals: Number(summary && summary.completed_goals) || 0,
      failed_goals: Number(summary && summary.failed_goals) || 0
    },
    metrics: summary && summary.metrics ? summary.metrics : null,
    batch_retry: summary && summary.batch_retry ? summary.batch_retry : null,
    program_kpi: summary && summary.program_kpi ? summary.program_kpi : null,
    program_diagnostics: summary && summary.program_diagnostics ? summary.program_diagnostics : null,
    program_coordination: summary && summary.program_coordination ? summary.program_coordination : null,
    program_gate: summary && summary.program_gate ? summary.program_gate : null,
    program_gate_fallback: summary && summary.program_gate_fallback ? summary.program_gate_fallback : null,
    program_gate_fallbacks: Array.isArray(summary && summary.program_gate_fallbacks) ? summary.program_gate_fallbacks : [],
    program_gate_effective: summary && summary.program_gate_effective ? summary.program_gate_effective : null,
    auto_recovery: summary && summary.auto_recovery ? summary.auto_recovery : null,
    program_governance: summary && summary.program_governance ? summary.program_governance : null,
    program_kpi_trend: summary && summary.program_kpi_trend ? summary.program_kpi_trend : null,
    program_kpi_anomalies: Array.isArray(summary && summary.program_kpi_anomalies) ? summary.program_kpi_anomalies : [],
    recovery_cycle: summary && summary.recovery_cycle ? summary.recovery_cycle : null,
    recovery_plan: summary && summary.recovery_plan ? summary.recovery_plan : null,
    recovery_memory: summary && summary.recovery_memory ? summary.recovery_memory : null,
    goal_input_guard: summary && summary.goal_input_guard ? summary.goal_input_guard : null,
    spec_session_prune: summary && summary.spec_session_prune ? summary.spec_session_prune : null,
    spec_session_budget: summary && summary.spec_session_budget ? summary.spec_session_budget : null,
    spec_session_growth_guard: summary && summary.spec_session_growth_guard ? summary.spec_session_growth_guard : null,
    spec_session_auto_prune: summary && summary.spec_session_auto_prune ? summary.spec_session_auto_prune : null,
    program_gate_auto_remediation: summary && summary.program_gate_auto_remediation ? summary.program_gate_auto_remediation : null,
    resource_plan: summary && summary.resource_plan ? summary.resource_plan : null,
    results: Array.isArray(summary && summary.results) ? summary.results : []
  }, { spaces: 2 });
  summary.program_audit_file = outputPath;
}

function normalizeBatchSessionKeep(keepCandidate) {
  if (keepCandidate === undefined || keepCandidate === null) {
    return null;
  }

  const parsed = Number(keepCandidate);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
    throw new Error('--batch-session-keep must be an integer between 0 and 1000.');
  }
  return parsed;
}

function normalizeBatchSessionOlderThanDays(daysCandidate) {
  if (daysCandidate === undefined || daysCandidate === null) {
    return null;
  }

  const parsed = Number(daysCandidate);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 36500) {
    throw new Error('--batch-session-older-than-days must be an integer between 0 and 36500.');
  }
  return parsed;
}

function sanitizeBatchSessionId(value) {
  return `${value || ''}`
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function createBatchSessionId() {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  return `batch-${timestamp}`;
}

function getCloseLoopControllerSessionDir(projectPath) {
  return path.join(projectPath, '.sce', 'auto', 'close-loop-controller-sessions');
}

function createControllerSessionId() {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  return `controller-${timestamp}`;
}

function getGovernanceCloseLoopSessionDir(projectPath) {
  return path.join(projectPath, '.sce', 'auto', 'governance-close-loop-sessions');
}

function createGovernanceCloseLoopSessionId() {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  return `governance-${timestamp}`;
}

function deriveGovernanceWeeklyOpsReasonFlags(reasonsCandidate) {
  const reasons = Array.isArray(reasonsCandidate)
    ? reasonsCandidate.map(item => `${item || ''}`.trim().toLowerCase()).filter(Boolean)
    : [];
  const hasWeeklyOpsReason = reasons.some(reason => reason.startsWith('weekly-ops-'));
  const hasBlockedReason = reasons.some(reason => (
    reason === 'weekly-ops-latest-blocked' ||
    reason.startsWith('weekly-ops-blocked-runs-positive:') ||
    reason.startsWith('weekly-ops-block-rate-positive:')
  ));
  const hasHighReason = reasons.some(reason => (
    reason === 'weekly-ops-latest-risk-high' ||
    reason.startsWith('weekly-ops-auth-tier-block-rate-high:') ||
    reason.startsWith('weekly-ops-dialogue-authorization-block-rate-high:') ||
    reason.startsWith('weekly-ops-latest-auth-tier-block-rate-high:') ||
    reason.startsWith('weekly-ops-latest-dialogue-authorization-block-rate-high:') ||
    reason.startsWith('weekly-ops-latest-runtime-block-rate-high:') ||
    reason.startsWith('weekly-ops-runtime-block-rate-high:') ||
    reason.startsWith('weekly-ops-latest-runtime-ui-mode-violations-positive:') ||
    reason.startsWith('weekly-ops-runtime-ui-mode-violations-positive:') ||
    reason.startsWith('weekly-ops-latest-runtime-ui-mode-violation-rate-positive:') ||
    reason.startsWith('weekly-ops-runtime-ui-mode-violation-run-rate-positive:') ||
    reason.startsWith('weekly-ops-runtime-ui-mode-violation-rate-high:')
  ));
  const hasConfigWarningReason = reasons.some(reason => (
    reason.startsWith('weekly-ops-config-warnings-positive:') ||
    reason.startsWith('weekly-ops-latest-config-warnings-positive:')
  ));
  const hasAuthTierHighReason = reasons.some(reason => (
    reason.startsWith('weekly-ops-auth-tier-block-rate-high:') ||
    reason.startsWith('weekly-ops-latest-auth-tier-block-rate-high:')
  ));
  const hasDialogueHighReason = reasons.some(reason => (
    reason.startsWith('weekly-ops-dialogue-authorization-block-rate-high:') ||
    reason.startsWith('weekly-ops-latest-dialogue-authorization-block-rate-high:')
  ));
  const hasRuntimeBlockRateHighReason = reasons.some(reason => (
    reason.startsWith('weekly-ops-latest-runtime-block-rate-high:') ||
    reason.startsWith('weekly-ops-runtime-block-rate-high:')
  ));
  const hasRuntimeUiModeViolationReason = reasons.some(reason => (
    reason.startsWith('weekly-ops-latest-runtime-ui-mode-violations-positive:') ||
    reason.startsWith('weekly-ops-runtime-ui-mode-violations-positive:') ||
    reason.startsWith('weekly-ops-latest-runtime-ui-mode-violation-rate-positive:') ||
    reason.startsWith('weekly-ops-runtime-ui-mode-violation-run-rate-positive:') ||
    reason.startsWith('weekly-ops-runtime-ui-mode-violation-rate-high:')
  ));
  return {
    has_weekly_ops_reason: hasWeeklyOpsReason,
    blocked: hasBlockedReason,
    high: hasHighReason,
    config_warning_positive: hasConfigWarningReason,
    auth_tier_block_rate_high: hasAuthTierHighReason,
    dialogue_authorization_block_rate_high: hasDialogueHighReason,
    runtime_block_rate_high: hasRuntimeBlockRateHighReason,
    runtime_ui_mode_violation_high: hasRuntimeUiModeViolationReason
  };
}

function normalizeGovernanceHandoffQualitySnapshot(snapshotCandidate) {
  if (!snapshotCandidate || typeof snapshotCandidate !== 'object' || Array.isArray(snapshotCandidate)) {
    return null;
  }
  return {
    available: snapshotCandidate.available === true,
    total_runs: toGovernanceReleaseGateNumber(snapshotCandidate.total_runs),
    latest_status: normalizeHandoffText(snapshotCandidate.latest_status),
    latest_gate_passed: parseAutoHandoffGateBoolean(snapshotCandidate.latest_gate_passed, null),
    latest_ontology_quality_score: toGovernanceReleaseGateNumber(snapshotCandidate.latest_ontology_quality_score),
    latest_capability_coverage_percent: toGovernanceReleaseGateNumber(snapshotCandidate.latest_capability_coverage_percent),
    latest_capability_coverage_passed: parseAutoHandoffGateBoolean(snapshotCandidate.latest_capability_coverage_passed, null),
    latest_capability_expected_unknown_count: toGovernanceReleaseGateNumber(
      snapshotCandidate.latest_capability_expected_unknown_count
    ),
    latest_capability_provided_unknown_count: toGovernanceReleaseGateNumber(
      snapshotCandidate.latest_capability_provided_unknown_count
    ),
    latest_moqui_matrix_regression_count: toGovernanceReleaseGateNumber(
      snapshotCandidate.latest_moqui_matrix_regression_count
    ),
    latest_moqui_matrix_regression_gate_max: toGovernanceReleaseGateNumber(
      snapshotCandidate.latest_moqui_matrix_regression_gate_max
    ),
    latest_release_gate_preflight_blocked: parseAutoHandoffGateBoolean(
      snapshotCandidate.latest_release_gate_preflight_blocked,
      null
    ),
    failure_rate_percent: toGovernanceReleaseGateNumber(snapshotCandidate.failure_rate_percent),
    gate_pass_rate_percent: toGovernanceReleaseGateNumber(snapshotCandidate.gate_pass_rate_percent),
    capability_coverage_pass_rate_percent: toGovernanceReleaseGateNumber(
      snapshotCandidate.capability_coverage_pass_rate_percent
    ),
    capability_expected_unknown_positive_rate_percent: toGovernanceReleaseGateNumber(
      snapshotCandidate.capability_expected_unknown_positive_rate_percent
    ),
    capability_provided_unknown_positive_rate_percent: toGovernanceReleaseGateNumber(
      snapshotCandidate.capability_provided_unknown_positive_rate_percent
    ),
    avg_moqui_matrix_regression_count: toGovernanceReleaseGateNumber(
      snapshotCandidate.avg_moqui_matrix_regression_count
    ),
    max_moqui_matrix_regression_count: toGovernanceReleaseGateNumber(
      snapshotCandidate.max_moqui_matrix_regression_count
    ),
    moqui_matrix_regression_positive_rate_percent: toGovernanceReleaseGateNumber(
      snapshotCandidate.moqui_matrix_regression_positive_rate_percent
    )
  };
}

function areGovernanceReleaseGateSnapshotsEqual(leftSnapshot, rightSnapshot) {
  if (!leftSnapshot && !rightSnapshot) {
    return true;
  }
  if (!leftSnapshot || !rightSnapshot) {
    return false;
  }
  return (
    leftSnapshot.available === rightSnapshot.available &&
    leftSnapshot.latest_gate_passed === rightSnapshot.latest_gate_passed &&
    leftSnapshot.pass_rate_percent === rightSnapshot.pass_rate_percent &&
    leftSnapshot.scene_package_batch_pass_rate_percent === rightSnapshot.scene_package_batch_pass_rate_percent &&
    leftSnapshot.drift_alert_rate_percent === rightSnapshot.drift_alert_rate_percent &&
    leftSnapshot.drift_blocked_runs === rightSnapshot.drift_blocked_runs
  );
}

function summarizeGovernanceRoundReleaseGateTelemetry(roundsCandidate) {
  const rounds = Array.isArray(roundsCandidate) ? roundsCandidate : [];
  let observedRounds = 0;
  let changedRounds = 0;

  for (const round of rounds) {
    const before = normalizeGovernanceReleaseGateSnapshot(round && round.release_gate_before);
    const after = normalizeGovernanceReleaseGateSnapshot(round && round.release_gate_after);
    if (!before && !after) {
      continue;
    }
    observedRounds += 1;
    if (!areGovernanceReleaseGateSnapshotsEqual(before, after)) {
      changedRounds += 1;
    }
  }

  return {
    observed_rounds: observedRounds,
    changed_rounds: changedRounds
  };
}

async function readGovernanceCloseLoopSessionEntries(projectPath) {
  const sessionDir = getGovernanceCloseLoopSessionDir(projectPath);
  if (!(await fs.pathExists(sessionDir))) {
    return [];
  }

  const files = (await fs.readdir(sessionDir))
    .filter(item => item.toLowerCase().endsWith('.json'));
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
    const stopDetail = payload && payload.stop_detail && typeof payload.stop_detail === 'object'
      ? payload.stop_detail
      : null;
    const stopDetailReasons = Array.isArray(stopDetail && stopDetail.reasons)
      ? stopDetail.reasons
      : [];
    const stopDetailWeeklyOps = normalizeGovernanceWeeklyOpsStopDetail(
      stopDetail && stopDetail.weekly_ops
    );
    const stopDetailWeeklyOpsReasonFlags = deriveGovernanceWeeklyOpsReasonFlags(stopDetailReasons);
    const stopDetailWeeklyOpsAuthTierBlockRatePercent = (
      stopDetailWeeklyOps &&
      stopDetailWeeklyOps.latest &&
      Number.isFinite(stopDetailWeeklyOps.latest.authorization_tier_block_rate_percent)
    )
      ? stopDetailWeeklyOps.latest.authorization_tier_block_rate_percent
      : (
        stopDetailWeeklyOps &&
        stopDetailWeeklyOps.aggregates &&
        Number.isFinite(stopDetailWeeklyOps.aggregates.authorization_tier_block_rate_max_percent)
      )
        ? stopDetailWeeklyOps.aggregates.authorization_tier_block_rate_max_percent
        : null;
    const stopDetailWeeklyOpsDialogueAuthorizationBlockRatePercent = (
      stopDetailWeeklyOps &&
      stopDetailWeeklyOps.latest &&
      Number.isFinite(stopDetailWeeklyOps.latest.dialogue_authorization_block_rate_percent)
    )
      ? stopDetailWeeklyOps.latest.dialogue_authorization_block_rate_percent
      : (
        stopDetailWeeklyOps &&
        stopDetailWeeklyOps.aggregates &&
        Number.isFinite(stopDetailWeeklyOps.aggregates.dialogue_authorization_block_rate_max_percent)
      )
        ? stopDetailWeeklyOps.aggregates.dialogue_authorization_block_rate_max_percent
        : null;
    const stopDetailWeeklyOpsRuntimeBlockRatePercent = (
      stopDetailWeeklyOps &&
      stopDetailWeeklyOps.latest &&
      Number.isFinite(stopDetailWeeklyOps.latest.runtime_block_rate_percent)
    )
      ? stopDetailWeeklyOps.latest.runtime_block_rate_percent
      : (
        stopDetailWeeklyOps &&
        stopDetailWeeklyOps.aggregates &&
        Number.isFinite(stopDetailWeeklyOps.aggregates.runtime_block_rate_max_percent)
      )
        ? stopDetailWeeklyOps.aggregates.runtime_block_rate_max_percent
        : null;
    const stopDetailWeeklyOpsRuntimeUiModeViolationTotal = (
      stopDetailWeeklyOps &&
      stopDetailWeeklyOps.latest &&
      Number.isFinite(stopDetailWeeklyOps.latest.runtime_ui_mode_violation_total)
    )
      ? stopDetailWeeklyOps.latest.runtime_ui_mode_violation_total
      : (
        stopDetailWeeklyOps &&
        stopDetailWeeklyOps.aggregates &&
        Number.isFinite(stopDetailWeeklyOps.aggregates.runtime_ui_mode_violation_total)
      )
        ? stopDetailWeeklyOps.aggregates.runtime_ui_mode_violation_total
        : null;
    const stopDetailWeeklyOpsRuntimeUiModeViolationRatePercent = (
      stopDetailWeeklyOps &&
      stopDetailWeeklyOps.latest &&
      Number.isFinite(stopDetailWeeklyOps.latest.runtime_ui_mode_violation_rate_percent)
    )
      ? stopDetailWeeklyOps.latest.runtime_ui_mode_violation_rate_percent
      : (
        stopDetailWeeklyOps &&
        stopDetailWeeklyOps.aggregates &&
        Number.isFinite(stopDetailWeeklyOps.aggregates.runtime_ui_mode_violation_rate_max_percent)
      )
        ? stopDetailWeeklyOps.aggregates.runtime_ui_mode_violation_rate_max_percent
        : (
          stopDetailWeeklyOps &&
          stopDetailWeeklyOps.aggregates &&
          Number.isFinite(stopDetailWeeklyOps.aggregates.runtime_ui_mode_violation_run_rate_percent)
        )
          ? stopDetailWeeklyOps.aggregates.runtime_ui_mode_violation_run_rate_percent
          : null;
    const stopDetailWeeklyOpsAvailable = Boolean(
      stopDetailWeeklyOps ||
      stopDetailWeeklyOpsReasonFlags.has_weekly_ops_reason
    );

    sessions.push({
      id: payload && payload.governance_session && payload.governance_session.id
        ? payload.governance_session.id
        : fallbackId,
      file: filePath,
      mode: payload && typeof payload.mode === 'string'
        ? payload.mode
        : parseError
          ? 'invalid'
          : 'unknown',
      status: payload && typeof payload.status === 'string'
        ? payload.status
        : parseError
          ? 'invalid'
          : 'unknown',
      target_risk: payload && typeof payload.target_risk === 'string' ? payload.target_risk : null,
      final_risk: payload && payload.final_assessment && payload.final_assessment.health &&
        typeof payload.final_assessment.health.risk_level === 'string'
        ? payload.final_assessment.health.risk_level
        : null,
      performed_rounds: payload && Number.isInteger(Number(payload.performed_rounds))
        ? Number(payload.performed_rounds)
        : null,
      max_rounds: payload && Number.isInteger(Number(payload.max_rounds))
        ? Number(payload.max_rounds)
        : null,
      converged: payload && typeof payload.converged === 'boolean'
        ? payload.converged
        : null,
      execute_advisory: payload && typeof payload.execute_advisory === 'boolean'
        ? payload.execute_advisory
        : null,
      advisory_failed_actions: payload && payload.advisory_summary &&
        Number.isInteger(Number(payload.advisory_summary.failed_actions))
        ? Number(payload.advisory_summary.failed_actions)
        : null,
      release_gate_available: finalReleaseGate ? finalReleaseGate.available : null,
      release_gate_latest_gate_passed: finalReleaseGate ? finalReleaseGate.latest_gate_passed : null,
      release_gate_pass_rate_percent: finalReleaseGate ? finalReleaseGate.pass_rate_percent : null,
      release_gate_scene_package_batch_pass_rate_percent: finalReleaseGate
        ? finalReleaseGate.scene_package_batch_pass_rate_percent
        : null,
      release_gate_drift_alert_rate_percent: finalReleaseGate ? finalReleaseGate.drift_alert_rate_percent : null,
      release_gate_drift_blocked_runs: finalReleaseGate ? finalReleaseGate.drift_blocked_runs : null,
      round_release_gate_observed: roundReleaseGateTelemetry.observed_rounds,
      round_release_gate_changed: roundReleaseGateTelemetry.changed_rounds,
      stop_detail_weekly_ops_available: stopDetailWeeklyOpsAvailable,
      stop_detail_weekly_ops_blocked: stopDetailWeeklyOps
        ? stopDetailWeeklyOps.pressure.blocked
        : (stopDetailWeeklyOpsReasonFlags.blocked ? true : null),
      stop_detail_weekly_ops_high_pressure: stopDetailWeeklyOps
        ? stopDetailWeeklyOps.pressure.high
        : (stopDetailWeeklyOpsReasonFlags.high ? true : null),
      stop_detail_weekly_ops_config_warning_positive: stopDetailWeeklyOps
        ? stopDetailWeeklyOps.pressure.config_warning_positive
        : (stopDetailWeeklyOpsReasonFlags.config_warning_positive ? true : null),
      stop_detail_weekly_ops_auth_tier_block_rate_high: stopDetailWeeklyOps
        ? stopDetailWeeklyOps.pressure.auth_tier_block_rate_high
        : (stopDetailWeeklyOpsReasonFlags.auth_tier_block_rate_high ? true : null),
      stop_detail_weekly_ops_dialogue_authorization_block_rate_high: stopDetailWeeklyOps
        ? stopDetailWeeklyOps.pressure.dialogue_authorization_block_rate_high
        : (stopDetailWeeklyOpsReasonFlags.dialogue_authorization_block_rate_high ? true : null),
      stop_detail_weekly_ops_runtime_block_rate_high: stopDetailWeeklyOps
        ? stopDetailWeeklyOps.pressure.runtime_block_rate_high
        : (stopDetailWeeklyOpsReasonFlags.runtime_block_rate_high ? true : null),
      stop_detail_weekly_ops_runtime_ui_mode_violation_high: stopDetailWeeklyOps
        ? stopDetailWeeklyOps.pressure.runtime_ui_mode_violation_high
        : (stopDetailWeeklyOpsReasonFlags.runtime_ui_mode_violation_high ? true : null),
      stop_detail_weekly_ops_blocked_runs: stopDetailWeeklyOps && stopDetailWeeklyOps.aggregates
        ? stopDetailWeeklyOps.aggregates.blocked_runs
        : null,
      stop_detail_weekly_ops_block_rate_percent: stopDetailWeeklyOps && stopDetailWeeklyOps.aggregates
        ? stopDetailWeeklyOps.aggregates.block_rate_percent
        : null,
      stop_detail_weekly_ops_config_warnings_total: stopDetailWeeklyOps && stopDetailWeeklyOps.aggregates
        ? stopDetailWeeklyOps.aggregates.config_warnings_total
        : null,
      stop_detail_weekly_ops_auth_tier_block_rate_percent: stopDetailWeeklyOpsAuthTierBlockRatePercent,
      stop_detail_weekly_ops_dialogue_authorization_block_rate_percent:
        stopDetailWeeklyOpsDialogueAuthorizationBlockRatePercent,
      stop_detail_weekly_ops_runtime_block_rate_percent: stopDetailWeeklyOpsRuntimeBlockRatePercent,
      stop_detail_weekly_ops_runtime_ui_mode_violation_total: stopDetailWeeklyOpsRuntimeUiModeViolationTotal,
      stop_detail_weekly_ops_runtime_ui_mode_violation_rate_percent:
        stopDetailWeeklyOpsRuntimeUiModeViolationRatePercent,
      stop_reason: payload && typeof payload.stop_reason === 'string'
        ? payload.stop_reason
        : null,
      resumed_from_governance_session_id:
        payload &&
        payload.resumed_from_governance_session &&
        typeof payload.resumed_from_governance_session.id === 'string'
          ? payload.resumed_from_governance_session.id
          : null,
      updated_at: payload && typeof payload.updated_at === 'string'
        ? payload.updated_at
        : fallbackTimestamp,
      parse_error: parseError ? parseError.message : null,
      mtime_ms: stats.mtimeMs
    });
  }

  sessions.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return sessions;
}

async function resolveGovernanceCloseLoopSessionFile(projectPath, sessionCandidate) {
  if (typeof sessionCandidate !== 'string' || !sessionCandidate.trim()) {
    throw new Error('--governance-resume requires a session id/file or "latest".');
  }
  const normalizedCandidate = sessionCandidate.trim();

  if (normalizedCandidate.toLowerCase() === 'latest') {
    const sessions = await readGovernanceCloseLoopSessionEntries(projectPath);
    if (sessions.length === 0) {
      throw new Error(`No governance close-loop sessions found in: ${getGovernanceCloseLoopSessionDir(projectPath)}`);
    }
    return sessions[0].file;
  }

  if (path.isAbsolute(normalizedCandidate)) {
    return normalizedCandidate;
  }
  if (
    normalizedCandidate.includes('/') ||
    normalizedCandidate.includes('\\') ||
    normalizedCandidate.toLowerCase().endsWith('.json')
  ) {
    return path.join(projectPath, normalizedCandidate);
  }

  const byId = path.join(
    getGovernanceCloseLoopSessionDir(projectPath),
    `${sanitizeBatchSessionId(normalizedCandidate)}.json`
  );
  if (await fs.pathExists(byId)) {
    return byId;
  }
  return path.join(projectPath, normalizedCandidate);
}

async function loadGovernanceCloseLoopSessionPayload(projectPath, sessionCandidate) {
  const sessionFile = await resolveGovernanceCloseLoopSessionFile(projectPath, sessionCandidate);
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
  return {
    id: sessionId,
    file: sessionFile,
    payload
  };
}

async function persistGovernanceCloseLoopSession(projectPath, sessionId, payload, status = 'running') {
  const safeSessionId = sanitizeBatchSessionId(sessionId);
  if (!safeSessionId) {
    return null;
  }
  const sessionDir = getGovernanceCloseLoopSessionDir(projectPath);
  const sessionFile = path.join(sessionDir, `${safeSessionId}.json`);
  const persisted = {
    ...payload,
    schema_version: AUTO_ARCHIVE_SCHEMA_VERSION,
    status,
    governance_session: {
      id: safeSessionId,
      file: sessionFile
    },
    updated_at: new Date().toISOString()
  };
  await fs.ensureDir(sessionDir);
  await fs.writeJson(sessionFile, persisted, { spaces: 2 });
  return {
    id: safeSessionId,
    file: sessionFile
  };
}

async function readCloseLoopControllerSessionEntries(projectPath) {
  const sessionDir = getCloseLoopControllerSessionDir(projectPath);
  if (!(await fs.pathExists(sessionDir))) {
    return [];
  }

  const files = (await fs.readdir(sessionDir))
    .filter(item => item.toLowerCase().endsWith('.json'));
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

    sessions.push({
      id: payload && typeof payload.controller_session === 'object' && typeof payload.controller_session.id === 'string'
        ? payload.controller_session.id
        : fallbackId,
      file: filePath,
      status: payload && typeof payload.status === 'string'
        ? payload.status
        : parseError
          ? 'invalid'
          : 'unknown',
      queue_file: payload && typeof payload.queue_file === 'string' ? payload.queue_file : null,
      queue_format: payload && typeof payload.queue_format === 'string' ? payload.queue_format : null,
      processed_goals: payload && Number.isFinite(Number(payload.processed_goals))
        ? Number(payload.processed_goals)
        : null,
      pending_goals: payload && Number.isFinite(Number(payload.pending_goals))
        ? Number(payload.pending_goals)
        : null,
      updated_at: payload && typeof payload.updated_at === 'string'
        ? payload.updated_at
        : fallbackTimestamp,
      parse_error: parseError ? parseError.message : null,
      mtime_ms: stats.mtimeMs
    });
  }

  sessions.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return sessions;
}

async function resolveCloseLoopControllerSessionFile(projectPath, sessionCandidate) {
  if (typeof sessionCandidate !== 'string' || !sessionCandidate.trim()) {
    throw new Error('--controller-resume requires a session id/file or "latest".');
  }

  const normalizedCandidate = sessionCandidate.trim();
  if (normalizedCandidate.toLowerCase() === 'latest') {
    const sessions = await readCloseLoopControllerSessionEntries(projectPath);
    if (sessions.length === 0) {
      throw new Error(`No controller sessions found in: ${getCloseLoopControllerSessionDir(projectPath)}`);
    }
    return sessions[0].file;
  }

  if (path.isAbsolute(normalizedCandidate)) {
    return normalizedCandidate;
  }
  if (
    normalizedCandidate.includes('/') ||
    normalizedCandidate.includes('\\') ||
    normalizedCandidate.toLowerCase().endsWith('.json')
  ) {
    return path.join(projectPath, normalizedCandidate);
  }

  const byId = path.join(
    getCloseLoopControllerSessionDir(projectPath),
    `${sanitizeBatchSessionId(normalizedCandidate)}.json`
  );
  if (await fs.pathExists(byId)) {
    return byId;
  }
  return path.join(projectPath, normalizedCandidate);
}

async function loadCloseLoopControllerSessionPayload(projectPath, sessionCandidate) {
  const sessionFile = await resolveCloseLoopControllerSessionFile(projectPath, sessionCandidate);
  if (!(await fs.pathExists(sessionFile))) {
    throw new Error(`Controller session file not found: ${sessionFile}`);
  }
  let payload = null;
  try {
    payload = await fs.readJson(sessionFile);
  } catch (error) {
    throw new Error(`Invalid controller session JSON: ${sessionFile} (${error.message})`);
  }
  const sessionId = payload && payload.controller_session && payload.controller_session.id
    ? payload.controller_session.id
    : path.basename(sessionFile, '.json');
  return {
    id: sessionId,
    file: sessionFile,
    payload: payload || {}
  };
}

async function pruneCloseLoopControllerSessions(projectPath, policy = {}) {
  const keep = policy.keep;
  const olderThanDays = policy.olderThanDays;
  const currentFile = policy.currentFile || null;
  const dryRun = Boolean(policy.dryRun);
  const sessions = await readCloseLoopControllerSessionEntries(projectPath);
  const cutoffMs = olderThanDays === null
    ? null
    : Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);

  const keepLimit = Number.isInteger(keep) ? keep : Number.POSITIVE_INFINITY;
  const deletable = [];
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    if (session.file === currentFile) {
      continue;
    }
    const beyondKeep = Number.isFinite(keepLimit) ? index >= keepLimit : true;
    const beyondAge = cutoffMs === null || session.mtime_ms < cutoffMs;
    if (beyondKeep && beyondAge) {
      deletable.push(session);
    }
  }

  const deleted = [];
  const errors = [];
  if (!dryRun) {
    for (const session of deletable) {
      try {
        await fs.remove(session.file);
        deleted.push(session);
      } catch (error) {
        errors.push({
          id: session.id,
          file: session.file,
          error: error.message
        });
      }
    }
  }

  return {
    enabled: true,
    session_dir: getCloseLoopControllerSessionDir(projectPath),
    dry_run: dryRun,
    criteria: {
      keep: Number.isFinite(keepLimit) ? keepLimit : null,
      older_than_days: olderThanDays
    },
    total_sessions: sessions.length,
    kept_sessions: sessions.length - deletable.length,
    deleted_count: dryRun ? deletable.length : deleted.length,
    candidates: deletable.map(item => ({
      id: item.id,
      file: item.file,
      status: item.status,
      updated_at: item.updated_at
    })),
    errors
  };
}

async function maybePersistCloseLoopControllerSummary(summary, options, projectPath) {
  if (options.controllerSession === false) {
    return;
  }

  const keep = normalizeControllerSessionKeep(options.controllerSessionKeep);
  const olderThanDays = normalizeControllerSessionOlderThanDays(options.controllerSessionOlderThanDays);
  const requestedId = typeof options.controllerSessionId === 'string' && options.controllerSessionId.trim()
    ? sanitizeBatchSessionId(options.controllerSessionId.trim())
    : null;
  const sessionId = requestedId || createControllerSessionId();
  if (!sessionId) {
    throw new Error('--controller-session-id is invalid after sanitization.');
  }

  const sessionDir = getCloseLoopControllerSessionDir(projectPath);
  const sessionFile = path.join(sessionDir, `${sessionId}.json`);
  summary.controller_session = {
    id: sessionId,
    file: sessionFile
  };
  summary.schema_version = AUTO_ARCHIVE_SCHEMA_VERSION;

  await fs.ensureDir(sessionDir);
  await fs.writeJson(sessionFile, {
    ...summary,
    schema_version: AUTO_ARCHIVE_SCHEMA_VERSION,
    controller_session: {
      id: sessionId,
      file: sessionFile
    },
    updated_at: new Date().toISOString()
  }, { spaces: 2 });

  if (keep !== null || olderThanDays !== null) {
    summary.controller_session_prune = await pruneCloseLoopControllerSessions(projectPath, {
      keep: keep === null ? null : keep,
      olderThanDays,
      currentFile: sessionFile,
      dryRun: false
    });
  }
}

async function readCloseLoopBatchSummaryEntries(projectPath) {
  const summaryDir = getCloseLoopBatchSummaryDir(projectPath);
  if (!(await fs.pathExists(summaryDir))) {
    return [];
  }

  const files = (await fs.readdir(summaryDir))
    .filter(item => item.toLowerCase().endsWith('.json'));
  const sessions = [];
  for (const file of files) {
    const filePath = path.join(summaryDir, file);
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

    sessions.push({
      id: payload && typeof payload.batch_session === 'object' && typeof payload.batch_session.id === 'string'
        ? payload.batch_session.id
        : fallbackId,
      file: filePath,
      status: payload && typeof payload.status === 'string'
        ? payload.status
        : parseError
          ? 'invalid'
          : 'unknown',
      goals_file: payload && typeof payload.goals_file === 'string' ? payload.goals_file : null,
      total_goals: payload && Number.isInteger(Number(payload.total_goals)) ? Number(payload.total_goals) : null,
      processed_goals: payload && Number.isInteger(Number(payload.processed_goals)) ? Number(payload.processed_goals) : null,
      updated_at: payload && typeof payload.updated_at === 'string'
        ? payload.updated_at
        : fallbackTimestamp,
      parse_error: parseError ? parseError.message : null,
      mtime_ms: stats.mtimeMs
    });
  }

  sessions.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return sessions;
}

function normalizeAutoKpiTrendWeeks(weeksCandidate) {
  if (weeksCandidate === undefined || weeksCandidate === null) {
    return 8;
  }
  const parsed = Number(weeksCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 260) {
    throw new Error('--weeks must be an integer between 1 and 260.');
  }
  return parsed;
}

function normalizeAutoKpiTrendPeriod(periodCandidate) {
  const normalized = typeof periodCandidate === 'string'
    ? periodCandidate.trim().toLowerCase()
    : 'week';
  if (!['week', 'day'].includes(normalized)) {
    throw new Error('--period must be one of: week, day.');
  }
  return normalized;
}

function normalizeAutoKpiTrendMode(modeCandidate) {
  const normalized = typeof modeCandidate === 'string'
    ? modeCandidate.trim().toLowerCase()
    : 'all';
  if (!['all', 'batch', 'program', 'recover', 'controller'].includes(normalized)) {
    throw new Error('--mode must be one of: all, batch, program, recover, controller.');
  }
  return normalized;
}

function summaryModeMatchesFilter(summaryMode, filterMode) {
  const normalizedMode = `${summaryMode || ''}`.trim().toLowerCase();
  if (filterMode === 'all') {
    return true;
  }
  if (filterMode === 'batch') {
    return normalizedMode === 'auto-close-loop-batch';
  }
  if (filterMode === 'program') {
    return normalizedMode === 'auto-close-loop-program';
  }
  if (filterMode === 'recover') {
    return normalizedMode === 'auto-close-loop-recover';
  }
  if (filterMode === 'controller') {
    return normalizedMode === 'auto-close-loop-controller';
  }
  return false;
}

function resolveAutoKpiSummaryModeCategory(summaryMode) {
  const normalizedMode = `${summaryMode || ''}`.trim().toLowerCase();
  if (normalizedMode === 'auto-close-loop-batch') {
    return 'batch';
  }
  if (normalizedMode === 'auto-close-loop-program') {
    return 'program';
  }
  if (normalizedMode === 'auto-close-loop-recover') {
    return 'recover';
  }
  if (normalizedMode === 'auto-close-loop-controller') {
    return 'controller';
  }
  return 'other';
}

function normalizeAutoKpiTrendControllerMetrics(payload, nestedMetrics) {
  const status = `${payload && payload.status ? payload.status : ''}`.trim().toLowerCase();
  const processedGoals = Number(payload && payload.processed_goals);
  const completedGoals = Number(payload && payload.completed_goals);
  const failedGoals = Number(payload && payload.failed_goals);
  const pendingGoals = Number(payload && payload.pending_goals);
  const processed = Number.isFinite(processedGoals) ? processedGoals : 0;
  const completed = Number.isFinite(completedGoals) ? completedGoals : 0;
  const failed = Number.isFinite(failedGoals) ? failedGoals : 0;
  const pending = Number.isFinite(pendingGoals) ? pendingGoals : 0;
  const successRate = processed > 0
    ? Number(((completed / processed) * 100).toFixed(2))
    : status === 'completed'
      ? 100
      : 0;
  const completionRate = (processed + pending) > 0
    ? Number(((processed / (processed + pending)) * 100).toFixed(2))
    : status === 'completed'
      ? 100
      : 0;
  return {
    status,
    completed: status === 'completed',
    gate_passed: status === 'completed' && failed === 0,
    success_rate_percent: successRate,
    completion_rate_percent: completionRate,
    failed_goals: failed,
    total_sub_specs: nestedMetrics.total_sub_specs,
    estimated_spec_created: nestedMetrics.estimated_spec_created,
    rate_limit_signals: nestedMetrics.total_rate_limit_signals,
    rate_limit_backoff_ms: nestedMetrics.total_rate_limit_backoff_ms
  };
}

async function loadAutoKpiTrendControllerNestedMetrics(projectPath, payload) {
  const results = Array.isArray(payload && payload.results) ? payload.results : [];
  let totalSubSpecs = 0;
  let estimatedSpecCreated = 0;
  let totalRateLimitSignals = 0;
  let totalRateLimitBackoffMs = 0;
  for (const item of results) {
    if (!item || typeof item.batch_session_file !== 'string' || !item.batch_session_file.trim()) {
      continue;
    }
    const nestedFile = path.isAbsolute(item.batch_session_file)
      ? item.batch_session_file
      : path.join(projectPath, item.batch_session_file);
    if (!(await fs.pathExists(nestedFile))) {
      continue;
    }
    try {
      const nested = await fs.readJson(nestedFile);
      const nestedTotalSubSpecs = Number(nested && nested.metrics && nested.metrics.total_sub_specs);
      const nestedEstimatedCreated = Number(
        nested && nested.spec_session_budget && nested.spec_session_budget.estimated_created
      );
      const nestedRateLimitSignals = Number(nested && nested.metrics && nested.metrics.total_rate_limit_signals);
      const nestedRateLimitBackoffMs = Number(nested && nested.metrics && nested.metrics.total_rate_limit_backoff_ms);
      totalSubSpecs += Number.isFinite(nestedTotalSubSpecs) ? nestedTotalSubSpecs : 0;
      estimatedSpecCreated += Number.isFinite(nestedEstimatedCreated) ? nestedEstimatedCreated : 0;
      totalRateLimitSignals += Number.isFinite(nestedRateLimitSignals) ? nestedRateLimitSignals : 0;
      totalRateLimitBackoffMs += Number.isFinite(nestedRateLimitBackoffMs) ? nestedRateLimitBackoffMs : 0;
    } catch (error) {
      continue;
    }
  }
  return {
    total_sub_specs: totalSubSpecs,
    estimated_spec_created: estimatedSpecCreated,
    total_rate_limit_signals: totalRateLimitSignals,
    total_rate_limit_backoff_ms: totalRateLimitBackoffMs
  };
}

async function readAutoKpiTrendSessionEntries(projectPath) {
  const [batchSessions, controllerSessions] = await Promise.all([
    readCloseLoopBatchSummaryEntries(projectPath),
    readCloseLoopControllerSessionEntries(projectPath)
  ]);
  const sessions = [
    ...batchSessions.map(session => ({ ...session, source: 'batch-summary' })),
    ...controllerSessions.map(session => ({ ...session, source: 'controller-session' }))
  ];
  sessions.sort((left, right) => Number(right.mtime_ms || 0) - Number(left.mtime_ms || 0));
  return sessions;
}

function getIsoWeekPeriodKey(dateCandidate) {
  const date = new Date(dateCandidate || Date.now());
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((utcDate - yearStart) / 86400000) + 1) / 7);
  return `${utcDate.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function getIsoDayPeriodKey(dateCandidate) {
  const date = new Date(dateCandidate || Date.now());
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function resolveAutoKpiTrendPeriodKey(dateCandidate, periodUnit) {
  if (periodUnit === 'day') {
    return getIsoDayPeriodKey(dateCandidate);
  }
  return getIsoWeekPeriodKey(dateCandidate);
}

function calculateAverage(items, field) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return 0;
  }
  const sum = list.reduce((acc, item) => {
    const value = Number(item && item[field]);
    return acc + (Number.isFinite(value) ? value : 0);
  }, 0);
  return Number((sum / list.length).toFixed(2));
}

function evaluateAutoKpiTrendAnomalies(trend) {
  const buckets = Array.isArray(trend) ? trend : [];
  const thresholds = {
    success_rate_drop_percent: 20,
    failed_goals_spike: 2,
    spec_growth_spike: 3,
    rate_limit_signal_spike: 1
  };
  if (buckets.length < 2) {
    return {
      enabled: true,
      latest_period: null,
      baseline_window: 0,
      thresholds,
      baseline: {
        success_rate_percent: 0,
        average_failed_goals: 0,
        average_estimated_spec_created: 0,
        average_rate_limit_signals: 0
      },
      anomalies: []
    };
  }

  const latest = buckets[buckets.length - 1];
  const baselineBuckets = buckets.slice(0, -1);
  const baseline = {
    success_rate_percent: calculateAverage(baselineBuckets, 'success_rate_percent'),
    average_failed_goals: calculateAverage(baselineBuckets, 'average_failed_goals'),
    average_estimated_spec_created: calculateAverage(baselineBuckets, 'average_estimated_spec_created'),
    average_rate_limit_signals: calculateAverage(baselineBuckets, 'average_rate_limit_signals')
  };
  const anomalies = [];

  const successRateDrop = Number((baseline.success_rate_percent - Number(latest.success_rate_percent || 0)).toFixed(2));
  if (successRateDrop >= thresholds.success_rate_drop_percent) {
    anomalies.push({
      type: 'success-rate-drop',
      severity: successRateDrop >= 35 ? 'high' : 'medium',
      period: latest.period,
      metric: 'success_rate_percent',
      baseline_value: baseline.success_rate_percent,
      latest_value: Number(latest.success_rate_percent || 0),
      delta: Number((-successRateDrop).toFixed(2)),
      explain: `Latest success rate dropped by ${successRateDrop}% compared to baseline.`
    });
  }

  const failedGoalsSpike = Number((Number(latest.average_failed_goals || 0) - baseline.average_failed_goals).toFixed(2));
  if (failedGoalsSpike >= thresholds.failed_goals_spike) {
    anomalies.push({
      type: 'failed-goals-spike',
      severity: failedGoalsSpike >= 4 ? 'high' : 'medium',
      period: latest.period,
      metric: 'average_failed_goals',
      baseline_value: baseline.average_failed_goals,
      latest_value: Number(latest.average_failed_goals || 0),
      delta: failedGoalsSpike,
      explain: `Latest failed-goal average increased by ${failedGoalsSpike} compared to baseline.`
    });
  }

  const specGrowthSpike = Number(
    (Number(latest.average_estimated_spec_created || 0) - baseline.average_estimated_spec_created).toFixed(2)
  );
  if (specGrowthSpike >= thresholds.spec_growth_spike) {
    anomalies.push({
      type: 'spec-growth-spike',
      severity: specGrowthSpike >= 6 ? 'high' : 'medium',
      period: latest.period,
      metric: 'average_estimated_spec_created',
      baseline_value: baseline.average_estimated_spec_created,
      latest_value: Number(latest.average_estimated_spec_created || 0),
      delta: specGrowthSpike,
      explain: `Latest spec growth increased by ${specGrowthSpike} compared to baseline.`
    });
  }

  const rateLimitSignalSpike = Number(
    (Number(latest.average_rate_limit_signals || 0) - baseline.average_rate_limit_signals).toFixed(2)
  );
  if (rateLimitSignalSpike >= thresholds.rate_limit_signal_spike) {
    anomalies.push({
      type: 'rate-limit-spike',
      severity: rateLimitSignalSpike >= 2 ? 'high' : 'medium',
      period: latest.period,
      metric: 'average_rate_limit_signals',
      baseline_value: baseline.average_rate_limit_signals,
      latest_value: Number(latest.average_rate_limit_signals || 0),
      delta: rateLimitSignalSpike,
      explain: `Latest rate-limit pressure increased by ${rateLimitSignalSpike} signal(s) per run compared to baseline.`
    });
  }

  return {
    enabled: true,
    latest_period: latest.period,
    baseline_window: baselineBuckets.length,
    thresholds,
    baseline,
    anomalies
  };
}

function formatAutoKpiTrendCsvRow(values) {
  return values.map(value => {
    if (value === null || value === undefined) {
      return '';
    }
    const stringValue = `${value}`;
    if (!/[",\r\n]/.test(stringValue)) {
      return stringValue;
    }
    return `"${stringValue.replace(/"/g, '""')}"`;
  }).join(',');
}

function formatAutoKpiTrendCsv(result) {
  const header = [
    'period',
    'runs',
    'completed_runs',
    'non_completed_runs',
    'gate_passed_runs',
    'success_rate_percent',
    'completion_rate_percent',
    'average_failed_goals',
    'average_total_sub_specs',
    'average_estimated_spec_created',
    'average_rate_limit_signals',
    'average_rate_limit_backoff_ms',
    'is_overall'
  ];
  const rows = [formatAutoKpiTrendCsvRow(header)];
  const trendRows = Array.isArray(result && result.trend) ? result.trend : [];
  for (const item of trendRows) {
    rows.push(
      formatAutoKpiTrendCsvRow([
        item.period,
        item.runs,
        item.completed_runs,
        item.non_completed_runs,
        item.gate_passed_runs,
        item.success_rate_percent,
        item.completion_rate_percent,
        item.average_failed_goals,
        item.average_total_sub_specs,
        item.average_estimated_spec_created,
        item.average_rate_limit_signals,
        item.average_rate_limit_backoff_ms,
        false
      ])
    );
  }
  const overall = result && result.overall && typeof result.overall === 'object' ? result.overall : {};
  rows.push(
    formatAutoKpiTrendCsvRow([
      'overall',
      overall.runs,
      overall.completed_runs,
      overall.non_completed_runs,
      overall.gate_passed_runs,
      overall.success_rate_percent,
      overall.completion_rate_percent,
      overall.average_failed_goals,
      overall.average_total_sub_specs,
      overall.average_estimated_spec_created,
      overall.average_rate_limit_signals,
      overall.average_rate_limit_backoff_ms,
      true
    ])
  );
  return `${rows.join('\n')}\n`;
}

function finalizeAutoKpiTrendBucket(period, bucket) {
  const runs = bucket.runs || 0;
  const successRate = runs > 0
    ? Number((bucket.success_rate_sum / runs).toFixed(2))
    : 0;
  const completionRate = runs > 0
    ? Number((bucket.completion_rate_sum / runs).toFixed(2))
    : 0;
  const avgFailedGoals = runs > 0
    ? Number((bucket.failed_goals_sum / runs).toFixed(2))
    : 0;
  const avgTotalSubSpecs = runs > 0
    ? Number((bucket.total_sub_specs_sum / runs).toFixed(2))
    : 0;
  const avgEstimatedSpecCreated = runs > 0
    ? Number((bucket.estimated_spec_created_sum / runs).toFixed(2))
    : 0;
  const avgRateLimitSignals = runs > 0
    ? Number((bucket.rate_limit_signals_sum / runs).toFixed(2))
    : 0;
  const avgRateLimitBackoffMs = runs > 0
    ? Number((bucket.rate_limit_backoff_ms_sum / runs).toFixed(2))
    : 0;
  return {
    period,
    runs,
    completed_runs: bucket.completed_runs,
    non_completed_runs: bucket.non_completed_runs,
    gate_passed_runs: bucket.gate_passed_runs,
    success_rate_percent: successRate,
    completion_rate_percent: completionRate,
    average_failed_goals: avgFailedGoals,
    average_total_sub_specs: avgTotalSubSpecs,
    average_estimated_spec_created: avgEstimatedSpecCreated,
    average_rate_limit_signals: avgRateLimitSignals,
    average_rate_limit_backoff_ms: avgRateLimitBackoffMs
  };
}

async function buildAutoKpiTrend(projectPath, options = {}) {
  const weeks = normalizeAutoKpiTrendWeeks(options.weeks);
  const mode = normalizeAutoKpiTrendMode(options.mode);
  const periodUnit = normalizeAutoKpiTrendPeriod(options.period);
  const sessions = await readAutoKpiTrendSessionEntries(projectPath);
  const cutoffMs = Date.now() - (weeks * 7 * 24 * 60 * 60 * 1000);
  const buckets = new Map();
  let totalRuns = 0;
  const overall = {
    runs: 0,
    completed_runs: 0,
    non_completed_runs: 0,
    gate_passed_runs: 0,
    success_rate_sum: 0,
    completion_rate_sum: 0,
    failed_goals_sum: 0,
    total_sub_specs_sum: 0,
    estimated_spec_created_sum: 0,
    rate_limit_signals_sum: 0,
    rate_limit_backoff_ms_sum: 0
  };
  const modeBreakdown = {
    batch: 0,
    program: 0,
    recover: 0,
    controller: 0,
    other: 0
  };

  for (const session of sessions) {
    if (Number(session && session.mtime_ms) < cutoffMs) {
      continue;
    }
    let payload = null;
    try {
      payload = await fs.readJson(session.file);
    } catch (error) {
      continue;
    }
    if (!summaryModeMatchesFilter(payload && payload.mode, mode)) {
      continue;
    }
    const modeCategory = resolveAutoKpiSummaryModeCategory(payload && payload.mode);
    modeBreakdown[modeCategory] += 1;

    const timestamp = payload.program_completed_at || payload.updated_at || session.updated_at;
    const period = resolveAutoKpiTrendPeriodKey(timestamp, periodUnit);
    if (!period) {
      continue;
    }

    if (!buckets.has(period)) {
      buckets.set(period, {
        runs: 0,
        completed_runs: 0,
        non_completed_runs: 0,
        gate_passed_runs: 0,
        success_rate_sum: 0,
        completion_rate_sum: 0,
        failed_goals_sum: 0,
        total_sub_specs_sum: 0,
        estimated_spec_created_sum: 0,
        rate_limit_signals_sum: 0,
        rate_limit_backoff_ms_sum: 0
      });
    }
    const bucket = buckets.get(period);
    const normalizedSummaryMode = `${payload && payload.mode ? payload.mode : ''}`.trim().toLowerCase();
    let metrics = null;
    if (normalizedSummaryMode === 'auto-close-loop-controller') {
      const nestedMetrics = await loadAutoKpiTrendControllerNestedMetrics(projectPath, payload);
      metrics = normalizeAutoKpiTrendControllerMetrics(payload, nestedMetrics);
    } else {
      const status = `${payload && payload.status ? payload.status : ''}`.trim().toLowerCase();
      const completed = status === 'completed';
      metrics = {
        status,
        completed,
        gate_passed: Boolean(
          payload &&
          payload.program_gate_effective &&
          payload.program_gate_effective.passed !== undefined
            ? payload.program_gate_effective.passed
            : payload && payload.program_gate
              ? payload.program_gate.passed
              : completed
        ),
        success_rate_percent: Number(payload && payload.metrics && payload.metrics.success_rate_percent),
        completion_rate_percent: Number(payload && payload.program_kpi && payload.program_kpi.completion_rate_percent),
        failed_goals: Number(payload && payload.failed_goals),
        total_sub_specs: Number(payload && payload.metrics && payload.metrics.total_sub_specs),
        estimated_spec_created: Number(payload && payload.spec_session_budget && payload.spec_session_budget.estimated_created),
        rate_limit_signals: Number(payload && payload.metrics && payload.metrics.total_rate_limit_signals),
        rate_limit_backoff_ms: Number(payload && payload.metrics && payload.metrics.total_rate_limit_backoff_ms)
      };
    }
    const completed = Boolean(metrics.completed);
    const gatePassed = Boolean(metrics.gate_passed);
    const successRate = Number(metrics.success_rate_percent);
    const completionRate = Number(metrics.completion_rate_percent);
    const failedGoals = Number(metrics.failed_goals);
    const totalSubSpecs = Number(metrics.total_sub_specs);
    const estimatedSpecCreated = Number(metrics.estimated_spec_created);
    const rateLimitSignals = Number(metrics.rate_limit_signals);
    const rateLimitBackoffMs = Number(metrics.rate_limit_backoff_ms);

    bucket.runs += 1;
    bucket.completed_runs += completed ? 1 : 0;
    bucket.non_completed_runs += completed ? 0 : 1;
    bucket.gate_passed_runs += gatePassed ? 1 : 0;
    bucket.success_rate_sum += Number.isFinite(successRate) ? successRate : 0;
    bucket.completion_rate_sum += Number.isFinite(completionRate) ? completionRate : (Number.isFinite(successRate) ? successRate : 0);
    bucket.failed_goals_sum += Number.isFinite(failedGoals) ? failedGoals : 0;
    bucket.total_sub_specs_sum += Number.isFinite(totalSubSpecs) ? totalSubSpecs : 0;
    bucket.estimated_spec_created_sum += Number.isFinite(estimatedSpecCreated) ? estimatedSpecCreated : 0;
    bucket.rate_limit_signals_sum += Number.isFinite(rateLimitSignals) ? rateLimitSignals : 0;
    bucket.rate_limit_backoff_ms_sum += Number.isFinite(rateLimitBackoffMs) ? rateLimitBackoffMs : 0;

    overall.runs += 1;
    overall.completed_runs += completed ? 1 : 0;
    overall.non_completed_runs += completed ? 0 : 1;
    overall.gate_passed_runs += gatePassed ? 1 : 0;
    overall.success_rate_sum += Number.isFinite(successRate) ? successRate : 0;
    overall.completion_rate_sum += Number.isFinite(completionRate) ? completionRate : (Number.isFinite(successRate) ? successRate : 0);
    overall.failed_goals_sum += Number.isFinite(failedGoals) ? failedGoals : 0;
    overall.total_sub_specs_sum += Number.isFinite(totalSubSpecs) ? totalSubSpecs : 0;
    overall.estimated_spec_created_sum += Number.isFinite(estimatedSpecCreated) ? estimatedSpecCreated : 0;
    overall.rate_limit_signals_sum += Number.isFinite(rateLimitSignals) ? rateLimitSignals : 0;
    overall.rate_limit_backoff_ms_sum += Number.isFinite(rateLimitBackoffMs) ? rateLimitBackoffMs : 0;
    totalRuns += 1;
  }

  const trend = [...buckets.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([period, bucket]) => finalizeAutoKpiTrendBucket(period, bucket));
  const overallSummary = finalizeAutoKpiTrendBucket('overall', overall);
  const { period: _overallPeriod, ...overallSnapshot } = overallSummary;
  const anomalyDetection = evaluateAutoKpiTrendAnomalies(trend);

  return {
    mode: 'auto-kpi-trend',
    generated_at: new Date().toISOString(),
    weeks,
    window_days: weeks * 7,
    period_unit: periodUnit,
    mode_filter: mode,
    total_runs: totalRuns,
    mode_breakdown: modeBreakdown,
    trend,
    overall: overallSnapshot,
    anomaly_detection: anomalyDetection,
    anomalies: anomalyDetection.anomalies
  };
}

async function pruneCloseLoopBatchSummarySessions(projectPath, policy = {}) {
  const keep = policy.keep;
  const olderThanDays = policy.olderThanDays;
  const currentFile = policy.currentFile || null;
  const dryRun = Boolean(policy.dryRun);
  const sessions = await readCloseLoopBatchSummaryEntries(projectPath);
  const cutoffMs = olderThanDays === null
    ? null
    : Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);

  const keepLimit = Number.isInteger(keep) ? keep : Number.POSITIVE_INFINITY;
  const deletable = [];
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    if (session.file === currentFile) {
      continue;
    }

    const beyondKeep = Number.isFinite(keepLimit) ? index >= keepLimit : true;
    const beyondAge = cutoffMs === null || session.mtime_ms < cutoffMs;
    if (beyondKeep && beyondAge) {
      deletable.push(session);
    }
  }

  const deleted = [];
  const errors = [];
  if (!dryRun) {
    for (const session of deletable) {
      try {
        await fs.remove(session.file);
        deleted.push(session);
      } catch (error) {
        errors.push({
          id: session.id,
          file: session.file,
          error: error.message
        });
      }
    }
  }

  return {
    enabled: true,
    session_dir: getCloseLoopBatchSummaryDir(projectPath),
    dry_run: dryRun,
    criteria: {
      keep: Number.isFinite(keepLimit) ? keepLimit : null,
      older_than_days: olderThanDays
    },
    total_sessions: sessions.length,
    kept_sessions: sessions.length - deletable.length,
    deleted_count: dryRun ? deletable.length : deleted.length,
    candidates: deletable.map(item => ({
      id: item.id,
      file: item.file,
      status: item.status,
      updated_at: item.updated_at
    })),
    errors
  };
}

async function maybePersistCloseLoopBatchSummary(summary, options, projectPath) {
  if (options.batchSession === false) {
    return;
  }

  const keep = normalizeBatchSessionKeep(options.batchSessionKeep);
  const olderThanDays = normalizeBatchSessionOlderThanDays(options.batchSessionOlderThanDays);
  const requestedId = typeof options.batchSessionId === 'string' && options.batchSessionId.trim()
    ? sanitizeBatchSessionId(options.batchSessionId.trim())
    : null;
  const sessionId = requestedId || createBatchSessionId();
  if (!sessionId) {
    throw new Error('--batch-session-id is invalid after sanitization.');
  }

  const summaryDir = getCloseLoopBatchSummaryDir(projectPath);
  const summaryFile = path.join(summaryDir, `${sessionId}.json`);
  summary.batch_session = {
    id: sessionId,
    file: summaryFile
  };
  summary.schema_version = AUTO_ARCHIVE_SCHEMA_VERSION;

  await fs.ensureDir(summaryDir);
  await fs.writeJson(summaryFile, {
    ...summary,
    schema_version: AUTO_ARCHIVE_SCHEMA_VERSION,
    batch_session: {
      id: sessionId,
      file: summaryFile
    },
    updated_at: new Date().toISOString()
  }, { spaces: 2 });

  if (keep !== null || olderThanDays !== null) {
    summary.batch_session_prune = await pruneCloseLoopBatchSummarySessions(projectPath, {
      keep: keep === null ? null : keep,
      olderThanDays,
      currentFile: summaryFile,
      dryRun: false
    });
  }
}

function getCloseLoopSessionDir(projectPath) {
  return path.join(projectPath, '.sce', 'auto', 'close-loop-sessions');
}

function getSpecSessionDir(projectPath) {
  return path.join(projectPath, '.sce', 'specs');
}

function normalizeLimit(limitCandidate, fallback) {
  if (limitCandidate === undefined || limitCandidate === null) {
    return fallback;
  }

  const parsed = Number(limitCandidate);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
    throw new Error('Limit must be an integer between 0 and 1000.');
  }
  return parsed;
}

function normalizeStatusFilter(statusCandidate) {
  if (statusCandidate === undefined || statusCandidate === null) {
    return [];
  }
  const raw = `${statusCandidate}`.trim();
  if (!raw) {
    throw new Error('--status must include at least one non-empty status token.');
  }

  const seen = new Set();
  const normalized = [];
  const tokens = raw.split(',');
  for (const token of tokens) {
    const parsed = normalizeStatusToken(token);
    if (!parsed || seen.has(parsed)) {
      continue;
    }
    seen.add(parsed);
    normalized.push(parsed);
  }

  if (normalized.length === 0) {
    throw new Error('--status must include at least one non-empty status token.');
  }
  if (normalized.length > 20) {
    throw new Error('--status supports at most 20 status tokens.');
  }
  return normalized;
}

async function readSpecSessionEntries(projectPath) {
  const specDir = getSpecSessionDir(projectPath);
  if (!(await fs.pathExists(specDir))) {
    return [];
  }

  const entries = await fs.readdir(specDir, { withFileTypes: true });
  const specs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    const specPath = path.join(specDir, entry.name);
    const stats = await fs.stat(specPath);
    specs.push({
      id: entry.name,
      file: specPath,
      created_at: new Date(stats.birthtimeMs || stats.ctimeMs).toISOString(),
      updated_at: new Date(stats.mtimeMs).toISOString(),
      mtime_ms: stats.mtimeMs
    });
  }
  specs.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return specs;
}

async function readCloseLoopSessionEntries(projectPath) {
  const sessionDir = getCloseLoopSessionDir(projectPath);
  if (!(await fs.pathExists(sessionDir))) {
    return [];
  }

  const files = (await fs.readdir(sessionDir))
    .filter(item => item.toLowerCase().endsWith('.json'));
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

    const id = payload && typeof payload.session_id === 'string' && payload.session_id.trim()
      ? payload.session_id.trim()
      : fallbackId;
    const status = payload && typeof payload.status === 'string'
      ? payload.status
      : parseError
        ? 'invalid'
        : 'unknown';
    const goal = payload && typeof payload.goal === 'string'
      ? payload.goal
      : null;
    const createdAt = payload && typeof payload.created_at === 'string'
      ? payload.created_at
      : null;
    const updatedAt = payload && typeof payload.updated_at === 'string'
      ? payload.updated_at
      : fallbackTimestamp;
    const portfolio = payload && payload.portfolio && typeof payload.portfolio === 'object'
      ? payload.portfolio
      : {};
    const subSpecs = Array.isArray(portfolio.sub_specs) ? portfolio.sub_specs : [];

    sessions.push({
      id,
      file: filePath,
      status,
      goal,
      created_at: createdAt,
      updated_at: updatedAt,
      master_spec: typeof portfolio.master_spec === 'string' ? portfolio.master_spec : null,
      sub_spec_count: subSpecs.length,
      sub_specs: subSpecs,
      parse_error: parseError ? parseError.message : null,
      mtime_ms: stats.mtimeMs
    });
  }

  sessions.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return sessions;
}

async function listSpecSessions(projectPath, options = {}) {
  const specs = await readSpecSessionEntries(projectPath);
  const limit = normalizeLimit(options.limit, 20);
  return {
    mode: 'auto-spec-session-list',
    spec_dir: getSpecSessionDir(projectPath),
    total: specs.length,
    specs: specs.slice(0, limit)
  };
}

async function listCloseLoopSessions(projectPath, options = {}) {
  return listCloseLoopSessionsService(projectPath, options, {
    readCloseLoopSessionEntries,
    normalizeStatusFilter,
    filterEntriesByStatus,
    normalizeLimit,
    presentCloseLoopSessionList,
    buildStatusCounts,
    getCloseLoopSessionDir
  });
}

async function statsCloseLoopSessions(projectPath, options = {}) {
  return statsCloseLoopSessionsService(projectPath, options, {
    readCloseLoopSessionEntries,
    normalizeStatsWindowDays,
    normalizeStatusFilter,
    filterEntriesByStatus,
    presentCloseLoopSessionStats,
    buildStatusCounts,
    buildMasterSpecCounts,
    isFailedStatus,
    getCloseLoopSessionDir
  });
}

async function listGovernanceCloseLoopSessions(projectPath, options = {}) {
  return listGovernanceCloseLoopSessionsService(projectPath, options, {
    readGovernanceCloseLoopSessionEntries,
    normalizeStatusFilter,
    filterEntriesByStatus,
    filterGovernanceEntriesByResumeMode,
    normalizeLimit,
    presentGovernanceSessionList,
    buildStatusCounts,
    getGovernanceCloseLoopSessionDir
  });
}

async function statsGovernanceCloseLoopSessions(projectPath, options = {}) {
  return statsGovernanceCloseLoopSessionsService(projectPath, options, {
    readGovernanceCloseLoopSessionEntries,
    normalizeStatsWindowDays,
    normalizeStatusFilter,
    filterEntriesByStatus,
    filterGovernanceEntriesByResumeMode,
    presentGovernanceSessionStats,
    normalizeStatusToken,
    isCompletedStatus,
    isFailedStatus,
    calculatePercent,
    toGovernanceReleaseGateNumber,
    getGovernanceCloseLoopSessionDir,
    buildStatusCounts,
    parseAutoHandoffGateBoolean
  });
}

async function pruneGovernanceCloseLoopSessions(projectPath, options = {}) {
  const keep = normalizeKeep(options.keep);
  const olderThanDays = normalizeOlderThanDays(options.olderThanDays);
  const dryRun = Boolean(options.dryRun);
  const currentFile = typeof options.currentFile === 'string' && options.currentFile.trim()
    ? path.resolve(options.currentFile.trim())
    : null;
  const sessions = await readGovernanceCloseLoopSessionEntries(projectPath);
  const cutoffMs = olderThanDays === null
    ? null
    : Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);

  const keepSet = new Set(
    sessions.slice(0, keep).map(session => path.resolve(session.file))
  );
  if (currentFile) {
    keepSet.add(currentFile);
  }
  const deletable = sessions.filter(session => {
    const resolvedFile = path.resolve(session.file);
    if (keepSet.has(resolvedFile)) {
      return false;
    }
    if (cutoffMs === null) {
      return true;
    }
    return session.mtime_ms < cutoffMs;
  });

  const deleted = [];
  const errors = [];
  if (!dryRun) {
    for (const session of deletable) {
      try {
        await fs.remove(session.file);
        deleted.push(session);
      } catch (error) {
        errors.push({
          id: session.id,
          file: session.file,
          error: error.message
        });
      }
    }
  }

  return {
    mode: 'auto-governance-session-prune',
    session_dir: getGovernanceCloseLoopSessionDir(projectPath),
    dry_run: dryRun,
    criteria: {
      keep,
      older_than_days: olderThanDays
    },
    total_sessions: sessions.length,
    kept_sessions: sessions.length - deletable.length,
    deleted_count: dryRun ? deletable.length : deleted.length,
    candidates: deletable.map(item => ({
      id: item.id,
      file: item.file,
      status: item.status,
      updated_at: item.updated_at
    })),
    errors
  };
}

async function pruneSpecSessions(projectPath, options = {}) {
  const specs = await readSpecSessionEntries(projectPath);
  const keep = normalizeSpecKeep(
    options.keep,
    Object.prototype.hasOwnProperty.call(options, 'defaultKeep') ? options.defaultKeep : 200
  );
  const olderThanDays = normalizeOlderThanDays(options.olderThanDays);
  const dryRun = Boolean(options.dryRun);
  const protectActive = options.protectActive !== false;
  const showProtectionReasons = Boolean(options.showProtectionReasons);
  const protectWindowDays = normalizeSpecSessionProtectWindowDays(options.protectWindowDays);
  const cutoffMs = olderThanDays === null
    ? null
    : Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
  const protectionProfile = protectActive
    ? await collectProtectedSpecNames(projectPath, options.additionalProtectedSpecs, { protectWindowDays })
    : {
      names: new Set(
        (Array.isArray(options.additionalProtectedSpecs) ? options.additionalProtectedSpecs : [])
          .map(item => `${item || ''}`.trim())
          .filter(Boolean)
      ),
      reason_map: new Map(),
      ranking: [],
      breakdown: {
        additional: new Set(
          (Array.isArray(options.additionalProtectedSpecs) ? options.additionalProtectedSpecs : [])
            .map(item => `${item || ''}`.trim())
            .filter(Boolean)
        ).size,
        collaboration_active: 0,
        close_loop_session_recent_or_incomplete: 0,
        batch_summary_recent_or_incomplete: 0
      }
    };
  const protectedSpecSet = protectionProfile.names;
  const protectionRanking = Array.isArray(protectionProfile.ranking)
    ? protectionProfile.ranking
    : [];

  const deletable = [];
  const protectedSpecs = [];
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    const beyondKeep = keep === null ? true : index >= keep;
    const beyondAge = cutoffMs === null || spec.mtime_ms < cutoffMs;
    if (protectedSpecSet.has(spec.id)) {
      if (beyondKeep && beyondAge) {
        protectedSpecs.push(spec);
      }
      continue;
    }
    if (beyondKeep && beyondAge) {
      deletable.push(spec);
    }
  }

  const deleted = [];
  const errors = [];
  if (!dryRun) {
    for (const spec of deletable) {
      try {
        await fs.remove(spec.file);
        deleted.push(spec);
      } catch (error) {
        errors.push({
          id: spec.id,
          file: spec.file,
          error: error.message
        });
      }
    }
  }

  return {
    mode: 'auto-spec-session-prune',
    spec_dir: getSpecSessionDir(projectPath),
    dry_run: dryRun,
    protect_active: protectActive,
    protect_window_days: protectWindowDays,
    protection_sources: protectionProfile.breakdown,
    criteria: {
      keep,
      older_than_days: olderThanDays
    },
    total_specs: specs.length,
    kept_specs: specs.length - deletable.length,
    protected_count: protectedSpecs.length,
    deleted_count: dryRun ? deletable.length : deleted.length,
    protected_specs: protectedSpecs.slice(0, 200).map(item => ({
      id: item.id,
      file: item.file,
      updated_at: item.updated_at,
      reasons: showProtectionReasons
        ? buildSpecProtectionReasonPayload(item.id, protectionProfile.reason_map)
        : undefined
    })),
    protection_ranking_top: protectionRanking.slice(0, 20),
    protection_ranking: showProtectionReasons ? protectionRanking.slice(0, 500) : undefined,
    candidates: deletable.map(item => ({
      id: item.id,
      file: item.file,
      updated_at: item.updated_at
    })),
    errors
  };
}

async function collectProtectedSpecNamesFromCollaboration(projectPath) {
  const reasonCounts = new Map();
  const specEntries = await readSpecSessionEntries(projectPath);
  for (const spec of specEntries) {
    const collaborationFile = path.join(spec.file, 'collaboration.json');
    if (!(await fs.pathExists(collaborationFile))) {
      continue;
    }
    try {
      const payload = await fs.readJson(collaborationFile);
      const status = normalizeStatusToken(payload && payload.status);
      if (!status || !isCompletedStatus(status)) {
        incrementProtectionReason(reasonCounts, spec.id, 'collaboration_active', 1);
      }
    } catch (error) {
      // Treat unreadable collaboration metadata as active to avoid unsafe deletion.
      incrementProtectionReason(reasonCounts, spec.id, 'collaboration_active', 1);
    }
  }
  return reasonCounts;
}

async function collectProtectedSpecNamesFromCloseLoopSessions(projectPath, recentWindowMs) {
  const reasonCounts = new Map();
  const sessions = await readCloseLoopSessionEntries(projectPath);
  for (const session of sessions) {
    const isRecent = Number(session && session.mtime_ms) >= (Date.now() - recentWindowMs);
    const isIncomplete = !isCompletedStatus(session && session.status);
    if (!isRecent && !isIncomplete) {
      continue;
    }
    const referencedSpecs = new Set();
    const masterSpec = `${session && session.master_spec ? session.master_spec : ''}`.trim();
    if (masterSpec) {
      referencedSpecs.add(masterSpec);
    }
    const subSpecs = Array.isArray(session && session.sub_specs) ? session.sub_specs : [];
    for (const item of subSpecs) {
      const specName = `${item || ''}`.trim();
      if (specName) {
        referencedSpecs.add(specName);
      }
    }
    for (const specName of referencedSpecs) {
      incrementProtectionReason(reasonCounts, specName, 'close_loop_session_recent_or_incomplete', 1);
    }
  }
  return reasonCounts;
}

async function collectProtectedSpecNamesFromBatchSummaries(projectPath, recentWindowMs) {
  const reasonCounts = new Map();
  const sessions = await readCloseLoopBatchSummaryEntries(projectPath);
  for (const session of sessions) {
    const isRecent = Number(session && session.mtime_ms) >= (Date.now() - recentWindowMs);
    const isIncompleteSummary = !isCompletedStatus(session && session.status);
    if (!isRecent && !isIncompleteSummary) {
      continue;
    }
    try {
      const payload = await fs.readJson(session.file);
      const includeCompleted = isRecent;
      const names = collectSpecNamesFromBatchSummaryPayload(payload, includeCompleted);
      for (const name of names) {
        incrementProtectionReason(reasonCounts, name, 'batch_summary_recent_or_incomplete', 1);
      }
    } catch (error) {
      // Ignore unreadable summary payloads for protection derivation.
    }
  }
  return reasonCounts;
}

async function collectProtectedSpecNamesFromControllerSessions(projectPath, recentWindowMs) {
  const reasonCounts = new Map();
  const sessions = await readCloseLoopControllerSessionEntries(projectPath);
  for (const session of sessions) {
    const isRecent = Number(session && session.mtime_ms) >= (Date.now() - recentWindowMs);
    const isIncompleteSummary = !isCompletedStatus(session && session.status);
    if (!isRecent && !isIncompleteSummary) {
      continue;
    }
    let payload = null;
    try {
      payload = await fs.readJson(session.file);
    } catch (error) {
      continue;
    }
    const includeCompleted = isRecent;
    const results = Array.isArray(payload && payload.results) ? payload.results : [];
    for (const item of results) {
      const nestedSummaryCandidate = `${item && item.batch_session_file ? item.batch_session_file : ''}`.trim();
      if (!nestedSummaryCandidate) {
        continue;
      }
      const nestedSummaryFile = path.isAbsolute(nestedSummaryCandidate)
        ? nestedSummaryCandidate
        : path.join(projectPath, nestedSummaryCandidate);
      if (!(await fs.pathExists(nestedSummaryFile))) {
        continue;
      }
      try {
        const nestedSummary = await fs.readJson(nestedSummaryFile);
        const names = collectSpecNamesFromBatchSummaryPayload(nestedSummary, includeCompleted);
        for (const name of names) {
          incrementProtectionReason(reasonCounts, name, 'controller_session_recent_or_incomplete', 1);
        }
      } catch (error) {
        // Ignore unreadable nested summaries for protection derivation.
      }
    }
  }
  return reasonCounts;
}

async function collectProtectedSpecNames(projectPath, additionalProtectedSpecs = [], options = {}) {
  const protectWindowDays = normalizeSpecSessionProtectWindowDays(options.protectWindowDays);
  const normalizedAdditionalSpecs = (Array.isArray(additionalProtectedSpecs) ? additionalProtectedSpecs : [])
    .map(item => `${item || ''}`.trim())
    .filter(Boolean);
  const reasonMap = new Map();
  for (const specName of normalizedAdditionalSpecs) {
    incrementProtectionReason(reasonMap, specName, 'additional', 1);
  }
  const recentWindowMs = protectWindowDays * 24 * 60 * 60 * 1000;
  const fromCollaboration = await collectProtectedSpecNamesFromCollaboration(projectPath);
  const fromSessions = await collectProtectedSpecNamesFromCloseLoopSessions(projectPath, recentWindowMs);
  const fromBatchSessions = await collectProtectedSpecNamesFromBatchSummaries(projectPath, recentWindowMs);
  const fromControllerSessions = await collectProtectedSpecNamesFromControllerSessions(projectPath, recentWindowMs);
  for (const [specName, record] of fromCollaboration.entries()) {
    incrementProtectionReason(
      reasonMap,
      specName,
      'collaboration_active',
      Number(record && record.collaboration_active) || 0
    );
  }
  for (const [specName, record] of fromSessions.entries()) {
    incrementProtectionReason(
      reasonMap,
      specName,
      'close_loop_session_recent_or_incomplete',
      Number(record && record.close_loop_session_recent_or_incomplete) || 0
    );
  }
  for (const [specName, record] of fromBatchSessions.entries()) {
    incrementProtectionReason(
      reasonMap,
      specName,
      'batch_summary_recent_or_incomplete',
      Number(record && record.batch_summary_recent_or_incomplete) || 0
    );
  }
  for (const [specName, record] of fromControllerSessions.entries()) {
    incrementProtectionReason(
      reasonMap,
      specName,
      'controller_session_recent_or_incomplete',
      Number(record && record.controller_session_recent_or_incomplete) || 0
    );
  }
  const protectedNames = new Set([...reasonMap.keys()]);
  const ranking = buildProtectionRanking(reasonMap);
  return {
    names: protectedNames,
    reason_map: reasonMap,
    ranking,
    breakdown: {
      additional: new Set(normalizedAdditionalSpecs).size,
      collaboration_active: fromCollaboration.size,
      close_loop_session_recent_or_incomplete: fromSessions.size,
      batch_summary_recent_or_incomplete: fromBatchSessions.size,
      controller_session_recent_or_incomplete: fromControllerSessions.size
    }
  };
}

async function maybePruneSpecSessionsWithPolicy(projectPath, options = {}, additionalProtectedSpecs = []) {
  const keepProvided = options.specSessionKeep !== undefined && options.specSessionKeep !== null;
  const ageProvided = options.specSessionOlderThanDays !== undefined && options.specSessionOlderThanDays !== null;
  if (!keepProvided && !ageProvided) {
    return null;
  }

  return pruneSpecSessions(projectPath, {
    keep: keepProvided ? options.specSessionKeep : null,
    olderThanDays: ageProvided ? options.specSessionOlderThanDays : null,
    dryRun: false,
    protectActive: options.specSessionProtectActive !== false,
    protectWindowDays: options.specSessionProtectWindowDays,
    additionalProtectedSpecs,
    defaultKeep: null
  });
}

async function listCloseLoopBatchSummarySessions(projectPath, options = {}) {
  const sessions = await readCloseLoopBatchSummaryEntries(projectPath);
  const statusFilter = normalizeStatusFilter(options.status);
  const filteredSessions = filterEntriesByStatus(sessions, statusFilter);
  const limit = normalizeLimit(options.limit, 20);
  return {
    mode: 'auto-batch-session-list',
    session_dir: getCloseLoopBatchSummaryDir(projectPath),
    total: filteredSessions.length,
    status_filter: statusFilter,
    status_counts: buildStatusCounts(filteredSessions),
    sessions: filteredSessions.slice(0, limit).map(item => ({
      id: item.id,
      file: item.file,
      status: item.status,
      goals_file: item.goals_file,
      total_goals: item.total_goals,
      processed_goals: item.processed_goals,
      updated_at: item.updated_at,
      parse_error: item.parse_error
    }))
  };
}

async function statsCloseLoopBatchSummarySessions(projectPath, options = {}) {
  const sessions = await readCloseLoopBatchSummaryEntries(projectPath);
  const days = normalizeStatsWindowDays(options.days);
  const statusFilter = normalizeStatusFilter(options.status);
  const cutoffMs = days === null
    ? null
    : Date.now() - (days * 24 * 60 * 60 * 1000);
  const withinWindow = sessions.filter(session => (
    cutoffMs === null || Number(session && session.mtime_ms) >= cutoffMs
  ));
  const filteredSessions = filterEntriesByStatus(withinWindow, statusFilter);

  let completedSessions = 0;
  let failedSessions = 0;
  let totalGoalsSum = 0;
  let processedGoalsSum = 0;
  let sessionsWithTotalGoals = 0;
  let sessionsWithProcessedGoals = 0;
  for (const session of filteredSessions) {
    const status = normalizeStatusToken(session && session.status) || 'unknown';
    if (status === 'completed') {
      completedSessions += 1;
    }
    if (isFailedStatus(status)) {
      failedSessions += 1;
    }

    const totalGoals = Number(session && session.total_goals);
    if (Number.isFinite(totalGoals)) {
      totalGoalsSum += totalGoals;
      sessionsWithTotalGoals += 1;
    }
    const processedGoals = Number(session && session.processed_goals);
    if (Number.isFinite(processedGoals)) {
      processedGoalsSum += processedGoals;
      sessionsWithProcessedGoals += 1;
    }
  }

  const totalSessions = filteredSessions.length;
  const completionRate = totalSessions > 0
    ? Number(((completedSessions / totalSessions) * 100).toFixed(2))
    : 0;
  const failureRate = totalSessions > 0
    ? Number(((failedSessions / totalSessions) * 100).toFixed(2))
    : 0;
  const processedRatio = totalGoalsSum > 0
    ? Number(((processedGoalsSum / totalGoalsSum) * 100).toFixed(2))
    : 0;
  const latestSession = totalSessions > 0 ? filteredSessions[0] : null;
  const oldestSession = totalSessions > 0 ? filteredSessions[totalSessions - 1] : null;

  return {
    mode: 'auto-batch-session-stats',
    session_dir: getCloseLoopBatchSummaryDir(projectPath),
    criteria: {
      days,
      status_filter: statusFilter,
      since: cutoffMs === null ? null : new Date(cutoffMs).toISOString()
    },
    total_sessions: totalSessions,
    completed_sessions: completedSessions,
    failed_sessions: failedSessions,
    completion_rate_percent: completionRate,
    failure_rate_percent: failureRate,
    total_goals_sum: totalGoalsSum,
    processed_goals_sum: processedGoalsSum,
    unprocessed_goals_sum: Math.max(0, totalGoalsSum - processedGoalsSum),
    average_total_goals_per_session: sessionsWithTotalGoals > 0
      ? Number((totalGoalsSum / sessionsWithTotalGoals).toFixed(2))
      : 0,
    average_processed_goals_per_session: sessionsWithProcessedGoals > 0
      ? Number((processedGoalsSum / sessionsWithProcessedGoals).toFixed(2))
      : 0,
    average_processed_ratio_percent: processedRatio,
    status_counts: buildStatusCounts(filteredSessions),
    latest_updated_at: latestSession ? latestSession.updated_at : null,
    oldest_updated_at: oldestSession ? oldestSession.updated_at : null,
    latest_sessions: filteredSessions.slice(0, 10).map(item => ({
      id: item.id,
      status: item.status,
      goals_file: item.goals_file,
      total_goals: item.total_goals,
      processed_goals: item.processed_goals,
      updated_at: item.updated_at,
      parse_error: item.parse_error
    }))
  };
}

async function listCloseLoopControllerSessions(projectPath, options = {}) {
  return listCloseLoopControllerSessionsService(projectPath, options, {
    readCloseLoopControllerSessionEntries,
    normalizeStatusFilter,
    filterEntriesByStatus,
    normalizeLimit,
    presentControllerSessionList,
    buildStatusCounts,
    getCloseLoopControllerSessionDir
  });
}

async function statsCloseLoopControllerSessions(projectPath, options = {}) {
  return statsCloseLoopControllerSessionsService(projectPath, options, {
    readCloseLoopControllerSessionEntries,
    normalizeStatsWindowDays,
    normalizeStatusFilter,
    filterEntriesByStatus,
    normalizeStatusToken,
    isFailedStatus,
    buildStatusCounts,
    buildQueueFormatCounts,
    getCloseLoopControllerSessionDir
  });
}

function buildTopCountEntries(counterMap, limit = 10) {
  const source = counterMap && typeof counterMap === 'object'
    ? counterMap
    : {};
  const maxItems = Number.isInteger(limit) && limit > 0 ? limit : 10;
  return Object.entries(source)
    .map(([key, count]) => ({
      key,
      count: Number(count) || 0
    }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return left.key.localeCompare(right.key);
    })
    .slice(0, maxItems);
}

async function loadGovernanceReleaseGateSignals(projectPath, options = {}) {
  const historyFileCandidate = typeof options.historyFile === 'string' && options.historyFile.trim().length > 0
    ? options.historyFile.trim()
    : null;
  const historyFile = historyFileCandidate
    ? (path.isAbsolute(historyFileCandidate)
      ? historyFileCandidate
      : path.join(projectPath, historyFileCandidate))
    : resolveAutoHandoffReleaseGateHistoryFile(projectPath);
  const toNumber = value => {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const base = {
    available: false,
    file: historyFile,
    total_entries: 0,
    latest_tag: null,
    latest_gate_passed: null,
    latest_risk_level: null,
    pass_rate_percent: null,
    scene_package_batch_pass_rate_percent: null,
    scene_package_batch_failed_count: null,
    drift_alert_rate_percent: null,
    drift_alert_runs: null,
    drift_blocked_runs: null,
    latest_weekly_ops_blocked: null,
    latest_weekly_ops_risk_level: null,
    latest_weekly_ops_governance_status: null,
    latest_weekly_ops_authorization_tier_block_rate_percent: null,
    latest_weekly_ops_dialogue_authorization_block_rate_percent: null,
    latest_weekly_ops_config_warning_count: null,
    latest_weekly_ops_runtime_block_rate_percent: null,
    latest_weekly_ops_runtime_ui_mode_violation_total: null,
    latest_weekly_ops_runtime_ui_mode_violation_rate_percent: null,
    weekly_ops_known_runs: null,
    weekly_ops_blocked_runs: null,
    weekly_ops_block_rate_percent: null,
    weekly_ops_violations_total: null,
    weekly_ops_warnings_total: null,
    weekly_ops_config_warnings_total: null,
    weekly_ops_authorization_tier_block_rate_max_percent: null,
    weekly_ops_dialogue_authorization_block_rate_max_percent: null,
    weekly_ops_runtime_block_rate_avg_percent: null,
    weekly_ops_runtime_block_rate_max_percent: null,
    weekly_ops_runtime_ui_mode_violation_known_runs: null,
    weekly_ops_runtime_ui_mode_violation_runs: null,
    weekly_ops_runtime_ui_mode_violation_run_rate_percent: null,
    weekly_ops_runtime_ui_mode_violation_total: null,
    weekly_ops_runtime_ui_mode_violation_rate_avg_percent: null,
    weekly_ops_runtime_ui_mode_violation_rate_max_percent: null,
    parse_error: null
  };
  if (!(await fs.pathExists(historyFile))) {
    return base;
  }
  let payload = null;
  try {
    payload = await fs.readJson(historyFile);
  } catch (error) {
    return {
      ...base,
      parse_error: `${error.message}`
    };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ...base,
      parse_error: 'invalid release gate history payload'
    };
  }
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const latest = payload.latest && typeof payload.latest === 'object'
    ? payload.latest
    : (entries.length > 0 ? entries[0] : null);
  const aggregates = payload.aggregates && typeof payload.aggregates === 'object'
    ? payload.aggregates
    : {};
  const latestRiskLevel = normalizeHandoffText(latest && latest.risk_level);
  const latestWeeklyOpsRiskLevel = normalizeHandoffText(latest && latest.weekly_ops_risk_level);
  return {
    ...base,
    available: true,
    total_entries: toNumber(payload.total_entries) || entries.length,
    latest_tag: normalizeHandoffText(latest && latest.tag) || null,
    latest_gate_passed: parseAutoHandoffGateBoolean(latest && latest.gate_passed, null),
    latest_risk_level: latestRiskLevel
      ? normalizeAutoHandoffGateRiskLevel(latestRiskLevel)
      : null,
    pass_rate_percent: toNumber(aggregates.pass_rate_percent),
    scene_package_batch_pass_rate_percent: toNumber(aggregates.scene_package_batch_pass_rate_percent),
    scene_package_batch_failed_count: toNumber(aggregates.scene_package_batch_failed_count),
    drift_alert_rate_percent: toNumber(aggregates.drift_alert_rate_percent),
    drift_alert_runs: toNumber(aggregates.drift_alert_runs),
    drift_blocked_runs: toNumber(aggregates.drift_blocked_runs),
    latest_weekly_ops_blocked: parseAutoHandoffGateBoolean(latest && latest.weekly_ops_blocked, null),
    latest_weekly_ops_risk_level: latestWeeklyOpsRiskLevel
      ? normalizeAutoHandoffGateRiskLevel(latestWeeklyOpsRiskLevel)
      : null,
    latest_weekly_ops_governance_status: normalizeHandoffText(
      latest && latest.weekly_ops_governance_status
    ) || null,
    latest_weekly_ops_authorization_tier_block_rate_percent: toNumber(
      latest && latest.weekly_ops_authorization_tier_block_rate_percent
    ),
    latest_weekly_ops_dialogue_authorization_block_rate_percent: toNumber(
      latest && latest.weekly_ops_dialogue_authorization_block_rate_percent
    ),
    latest_weekly_ops_config_warning_count: toNumber(
      latest && latest.weekly_ops_config_warning_count
    ),
    latest_weekly_ops_runtime_block_rate_percent: toNumber(
      latest && latest.weekly_ops_runtime_block_rate_percent
    ),
    latest_weekly_ops_runtime_ui_mode_violation_total: toNumber(
      latest && latest.weekly_ops_runtime_ui_mode_violation_total
    ),
    latest_weekly_ops_runtime_ui_mode_violation_rate_percent: toNumber(
      latest && latest.weekly_ops_runtime_ui_mode_violation_rate_percent
    ),
    weekly_ops_known_runs: toNumber(aggregates.weekly_ops_known_runs),
    weekly_ops_blocked_runs: toNumber(aggregates.weekly_ops_blocked_runs),
    weekly_ops_block_rate_percent: toNumber(aggregates.weekly_ops_block_rate_percent),
    weekly_ops_violations_total: toNumber(aggregates.weekly_ops_violations_total),
    weekly_ops_warnings_total: toNumber(aggregates.weekly_ops_warnings_total),
    weekly_ops_config_warnings_total: toNumber(aggregates.weekly_ops_config_warnings_total),
    weekly_ops_authorization_tier_block_rate_max_percent: toNumber(
      aggregates.weekly_ops_authorization_tier_block_rate_max_percent
    ),
    weekly_ops_dialogue_authorization_block_rate_max_percent: toNumber(
      aggregates.weekly_ops_dialogue_authorization_block_rate_max_percent
    ),
    weekly_ops_runtime_block_rate_avg_percent: toNumber(
      aggregates.weekly_ops_runtime_block_rate_avg_percent
    ),
    weekly_ops_runtime_block_rate_max_percent: toNumber(
      aggregates.weekly_ops_runtime_block_rate_max_percent
    ),
    weekly_ops_runtime_ui_mode_violation_known_runs: toNumber(
      aggregates.weekly_ops_runtime_ui_mode_violation_known_runs
    ),
    weekly_ops_runtime_ui_mode_violation_runs: toNumber(
      aggregates.weekly_ops_runtime_ui_mode_violation_runs
    ),
    weekly_ops_runtime_ui_mode_violation_run_rate_percent: toNumber(
      aggregates.weekly_ops_runtime_ui_mode_violation_run_rate_percent
    ),
    weekly_ops_runtime_ui_mode_violation_total: toNumber(
      aggregates.weekly_ops_runtime_ui_mode_violation_total
    ),
    weekly_ops_runtime_ui_mode_violation_rate_avg_percent: toNumber(
      aggregates.weekly_ops_runtime_ui_mode_violation_rate_avg_percent
    ),
    weekly_ops_runtime_ui_mode_violation_rate_max_percent: toNumber(
      aggregates.weekly_ops_runtime_ui_mode_violation_rate_max_percent
    ),
    parse_error: null
  };
}

async function loadGovernanceHandoffQualitySignals(projectPath) {
  const evidenceFile = path.join(projectPath, AUTO_HANDOFF_RELEASE_EVIDENCE_FILE);
  const toNumber = value => {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const toPercent = (numerator, denominator) => {
    const safeNumerator = Number(numerator) || 0;
    const safeDenominator = Number(denominator) || 0;
    if (safeDenominator <= 0) {
      return null;
    }
    return Number(((safeNumerator / safeDenominator) * 100).toFixed(2));
  };
  const base = {
    available: false,
    file: evidenceFile,
    total_runs: 0,
    latest_session_id: null,
    latest_status: null,
    latest_gate_passed: null,
    latest_spec_success_rate_percent: null,
    latest_risk_level: null,
    latest_ontology_quality_score: null,
    latest_capability_coverage_percent: null,
    latest_capability_coverage_passed: null,
    latest_capability_expected_unknown_count: null,
    latest_capability_provided_unknown_count: null,
    latest_moqui_matrix_regression_count: null,
    latest_moqui_matrix_regression_gate_max: null,
    latest_scene_package_batch_passed: null,
    latest_release_gate_preflight_blocked: null,
    latest_failure_highlights: [],
    failure_rate_percent: null,
    gate_pass_rate_percent: null,
    capability_coverage_pass_rate_percent: null,
    scene_package_batch_pass_rate_percent: null,
    avg_ontology_quality_score: null,
    capability_expected_unknown_positive_rate_percent: null,
    capability_provided_unknown_positive_rate_percent: null,
    avg_moqui_matrix_regression_count: null,
    max_moqui_matrix_regression_count: null,
    moqui_matrix_regression_positive_rate_percent: null,
    parse_error: null
  };
  if (!(await fs.pathExists(evidenceFile))) {
    return base;
  }
  let payload = null;
  try {
    payload = await fs.readJson(evidenceFile);
  } catch (error) {
    return {
      ...base,
      parse_error: `${error.message}`
    };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ...base,
      parse_error: 'invalid handoff release evidence payload'
    };
  }

  const sessions = Array.isArray(payload.sessions)
    ? payload.sessions.filter(item => item && typeof item === 'object')
    : [];
  sessions.sort((left, right) => {
    const leftTs = Date.parse(
      left && (left.merged_at || left.generated_at || left.updated_at)
        ? (left.merged_at || left.generated_at || left.updated_at)
        : 0
    );
    const rightTs = Date.parse(
      right && (right.merged_at || right.generated_at || right.updated_at)
        ? (right.merged_at || right.generated_at || right.updated_at)
        : 0
    );
    return (Number.isFinite(rightTs) ? rightTs : 0) - (Number.isFinite(leftTs) ? leftTs : 0);
  });

  const latest = sessions[0] || null;
  const latestGate = latest && latest.gate && typeof latest.gate === 'object'
    ? latest.gate
    : {};
  const latestGateActual = latestGate && latestGate.actual && typeof latestGate.actual === 'object'
    ? latestGate.actual
    : {};
  const latestCapabilitySummary = latest && latest.capability_coverage && latest.capability_coverage.summary &&
    typeof latest.capability_coverage.summary === 'object'
    ? latest.capability_coverage.summary
    : {};
  const latestSceneSummary = latest && latest.scene_package_batch && latest.scene_package_batch.summary &&
    typeof latest.scene_package_batch.summary === 'object'
    ? latest.scene_package_batch.summary
    : {};
  const latestPreflight = latest && latest.release_gate_preflight && typeof latest.release_gate_preflight === 'object'
    ? latest.release_gate_preflight
    : {};
  const latestFailureSummary = latest && latest.failure_summary && typeof latest.failure_summary === 'object'
    ? latest.failure_summary
    : {};
  const latestStatus = normalizeHandoffText(latest && latest.status);
  const latestRiskLevel = normalizeHandoffText(latestGateActual.risk_level);
  const latestFailureHighlights = Array.isArray(latestFailureSummary.highlights)
    ? latestFailureSummary.highlights.map(item => `${item || ''}`.trim()).filter(Boolean).slice(0, 5)
    : [];
  const deriveMoquiMatrixRegressionCount = entry => {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    const gate = entry.gate && typeof entry.gate === 'object'
      ? entry.gate
      : {};
    const gateActual = gate.actual && typeof gate.actual === 'object'
      ? gate.actual
      : {};
    const explicit = toNumber(gateActual.moqui_matrix_regression_count);
    if (Number.isFinite(explicit)) {
      return Math.max(0, explicit);
    }
    const moquiBaseline = entry.moqui_baseline && typeof entry.moqui_baseline === 'object'
      ? entry.moqui_baseline
      : {};
    const compare = moquiBaseline.compare && typeof moquiBaseline.compare === 'object'
      ? moquiBaseline.compare
      : null;
    if (!compare) {
      return null;
    }
    return buildAutoHandoffMoquiCoverageRegressions(compare).length;
  };
  const deriveMoquiMatrixRegressionGateMax = entry => {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    const gate = entry.gate && typeof entry.gate === 'object'
      ? entry.gate
      : {};
    const gateActual = gate.actual && typeof gate.actual === 'object'
      ? gate.actual
      : {};
    const explicit = toNumber(gateActual.max_moqui_matrix_regressions);
    if (Number.isFinite(explicit)) {
      return Math.max(0, explicit);
    }
    const policy = entry.policy && typeof entry.policy === 'object'
      ? entry.policy
      : {};
    const fromPolicy = toNumber(policy.max_moqui_matrix_regressions);
    return Number.isFinite(fromPolicy) ? Math.max(0, fromPolicy) : null;
  };
  const deriveCapabilityExpectedUnknownCount = entry => {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    const gate = entry.gate && typeof entry.gate === 'object'
      ? entry.gate
      : {};
    const gateActual = gate.actual && typeof gate.actual === 'object'
      ? gate.actual
      : {};
    const explicit = toNumber(gateActual.capability_expected_unknown_count);
    if (Number.isFinite(explicit)) {
      return Math.max(0, explicit);
    }
    const coverage = entry.capability_coverage && typeof entry.capability_coverage === 'object'
      ? entry.capability_coverage
      : {};
    const normalization = coverage.normalization && typeof coverage.normalization === 'object'
      ? coverage.normalization
      : {};
    const list = Array.isArray(normalization.expected_unknown) ? normalization.expected_unknown : null;
    return list ? list.length : null;
  };
  const deriveCapabilityProvidedUnknownCount = entry => {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    const gate = entry.gate && typeof entry.gate === 'object'
      ? entry.gate
      : {};
    const gateActual = gate.actual && typeof gate.actual === 'object'
      ? gate.actual
      : {};
    const explicit = toNumber(gateActual.capability_provided_unknown_count);
    if (Number.isFinite(explicit)) {
      return Math.max(0, explicit);
    }
    const coverage = entry.capability_coverage && typeof entry.capability_coverage === 'object'
      ? entry.capability_coverage
      : {};
    const normalization = coverage.normalization && typeof coverage.normalization === 'object'
      ? coverage.normalization
      : {};
    const list = Array.isArray(normalization.provided_unknown) ? normalization.provided_unknown : null;
    return list ? list.length : null;
  };
  const latestMoquiMatrixRegressionCount = deriveMoquiMatrixRegressionCount(latest);
  const latestMoquiMatrixRegressionGateMax = deriveMoquiMatrixRegressionGateMax(latest);
  const latestCapabilityExpectedUnknownCount = deriveCapabilityExpectedUnknownCount(latest);
  const latestCapabilityProvidedUnknownCount = deriveCapabilityProvidedUnknownCount(latest);

  let failedRuns = 0;
  let gateKnownRuns = 0;
  let gatePassedRuns = 0;
  let capabilityKnownRuns = 0;
  let capabilityPassedRuns = 0;
  let sceneBatchKnownRuns = 0;
  let sceneBatchPassedRuns = 0;
  let capabilityExpectedUnknownKnownRuns = 0;
  let capabilityExpectedUnknownPositiveRuns = 0;
  let capabilityProvidedUnknownKnownRuns = 0;
  let capabilityProvidedUnknownPositiveRuns = 0;
  let moquiMatrixKnownRuns = 0;
  let moquiMatrixPositiveRuns = 0;
  const ontologyScores = [];
  const moquiMatrixRegressionCounts = [];
  for (const entry of sessions) {
    const status = normalizeHandoffText(entry && entry.status);
    if (status && !['completed', 'dry-run', 'dry_run'].includes(status)) {
      failedRuns += 1;
    }

    const gate = entry && entry.gate && typeof entry.gate === 'object'
      ? entry.gate
      : {};
    if (typeof gate.passed === 'boolean') {
      gateKnownRuns += 1;
      if (gate.passed === true) {
        gatePassedRuns += 1;
      }
    }

    const capabilitySummary = entry && entry.capability_coverage && entry.capability_coverage.summary &&
      typeof entry.capability_coverage.summary === 'object'
      ? entry.capability_coverage.summary
      : {};
    if (typeof capabilitySummary.passed === 'boolean') {
      capabilityKnownRuns += 1;
      if (capabilitySummary.passed === true) {
        capabilityPassedRuns += 1;
      }
    }

    const sceneSummary = entry && entry.scene_package_batch && entry.scene_package_batch.summary &&
      typeof entry.scene_package_batch.summary === 'object'
      ? entry.scene_package_batch.summary
      : {};
    if (typeof sceneSummary.batch_gate_passed === 'boolean') {
      sceneBatchKnownRuns += 1;
      if (sceneSummary.batch_gate_passed === true) {
        sceneBatchPassedRuns += 1;
      }
    }

    const gateActual = gate && gate.actual && typeof gate.actual === 'object'
      ? gate.actual
      : {};
    const ontology = entry && entry.ontology_validation && typeof entry.ontology_validation === 'object'
      ? entry.ontology_validation
      : {};
    const ontologyScore = toNumber(
      gateActual.ontology_quality_score !== undefined
        ? gateActual.ontology_quality_score
        : ontology.quality_score
    );
    if (Number.isFinite(ontologyScore)) {
      ontologyScores.push(ontologyScore);
    }
    const capabilityExpectedUnknownCount = deriveCapabilityExpectedUnknownCount(entry);
    if (Number.isFinite(capabilityExpectedUnknownCount)) {
      capabilityExpectedUnknownKnownRuns += 1;
      if (capabilityExpectedUnknownCount > 0) {
        capabilityExpectedUnknownPositiveRuns += 1;
      }
    }
    const capabilityProvidedUnknownCount = deriveCapabilityProvidedUnknownCount(entry);
    if (Number.isFinite(capabilityProvidedUnknownCount)) {
      capabilityProvidedUnknownKnownRuns += 1;
      if (capabilityProvidedUnknownCount > 0) {
        capabilityProvidedUnknownPositiveRuns += 1;
      }
    }
    const moquiMatrixRegressionCount = deriveMoquiMatrixRegressionCount(entry);
    if (Number.isFinite(moquiMatrixRegressionCount)) {
      moquiMatrixKnownRuns += 1;
      moquiMatrixRegressionCounts.push(Math.max(0, moquiMatrixRegressionCount));
      if (moquiMatrixRegressionCount > 0) {
        moquiMatrixPositiveRuns += 1;
      }
    }
  }

  return {
    ...base,
    available: true,
    total_runs: sessions.length,
    latest_session_id: normalizeHandoffText(latest && latest.session_id) || null,
    latest_status: latestStatus || null,
    latest_gate_passed: parseAutoHandoffGateBoolean(latestGate.passed, null),
    latest_spec_success_rate_percent: toNumber(latestGateActual.spec_success_rate_percent),
    latest_risk_level: latestRiskLevel
      ? normalizeAutoHandoffGateRiskLevel(latestRiskLevel)
      : null,
    latest_ontology_quality_score: toNumber(
      latestGateActual.ontology_quality_score !== undefined
        ? latestGateActual.ontology_quality_score
        : (latest && latest.ontology_validation ? latest.ontology_validation.quality_score : null)
    ),
    latest_capability_coverage_percent: toNumber(latestCapabilitySummary.coverage_percent),
    latest_capability_coverage_passed: parseAutoHandoffGateBoolean(latestCapabilitySummary.passed, null),
    latest_capability_expected_unknown_count: Number.isFinite(latestCapabilityExpectedUnknownCount)
      ? latestCapabilityExpectedUnknownCount
      : null,
    latest_capability_provided_unknown_count: Number.isFinite(latestCapabilityProvidedUnknownCount)
      ? latestCapabilityProvidedUnknownCount
      : null,
    latest_moqui_matrix_regression_count: Number.isFinite(latestMoquiMatrixRegressionCount)
      ? latestMoquiMatrixRegressionCount
      : null,
    latest_moqui_matrix_regression_gate_max: Number.isFinite(latestMoquiMatrixRegressionGateMax)
      ? latestMoquiMatrixRegressionGateMax
      : null,
    latest_scene_package_batch_passed: parseAutoHandoffGateBoolean(latestSceneSummary.batch_gate_passed, null),
    latest_release_gate_preflight_blocked: parseAutoHandoffGateBoolean(latestPreflight.blocked, null),
    latest_failure_highlights: latestFailureHighlights,
    failure_rate_percent: toPercent(failedRuns, sessions.length),
    gate_pass_rate_percent: toPercent(gatePassedRuns, gateKnownRuns),
    capability_coverage_pass_rate_percent: toPercent(capabilityPassedRuns, capabilityKnownRuns),
    scene_package_batch_pass_rate_percent: toPercent(sceneBatchPassedRuns, sceneBatchKnownRuns),
    avg_ontology_quality_score: ontologyScores.length > 0
      ? Number((ontologyScores.reduce((sum, item) => sum + item, 0) / ontologyScores.length).toFixed(2))
      : null,
    capability_expected_unknown_positive_rate_percent: toPercent(
      capabilityExpectedUnknownPositiveRuns,
      capabilityExpectedUnknownKnownRuns
    ),
    capability_provided_unknown_positive_rate_percent: toPercent(
      capabilityProvidedUnknownPositiveRuns,
      capabilityProvidedUnknownKnownRuns
    ),
    avg_moqui_matrix_regression_count: moquiMatrixRegressionCounts.length > 0
      ? Number((
        moquiMatrixRegressionCounts.reduce((sum, item) => sum + item, 0) /
        moquiMatrixRegressionCounts.length
      ).toFixed(2))
      : null,
    max_moqui_matrix_regression_count: moquiMatrixRegressionCounts.length > 0
      ? Number(Math.max(...moquiMatrixRegressionCounts).toFixed(2))
      : null,
    moqui_matrix_regression_positive_rate_percent: toPercent(
      moquiMatrixPositiveRuns,
      moquiMatrixKnownRuns
    ),
    parse_error: null
  };
}

async function buildAutoGovernanceStats(projectPath, options = {}) {
  return buildAutoGovernanceStatsService(projectPath, options, {
    normalizeStatsWindowDays,
    normalizeStatusFilter,
    statsCloseLoopSessions,
    statsCloseLoopBatchSummarySessions,
    statsCloseLoopControllerSessions,
    showCloseLoopRecoveryMemory,
    loadGovernanceReleaseGateSignals,
    loadGovernanceHandoffQualitySignals,
    calculatePercent,
    deriveGovernanceRiskLevel,
    buildGovernanceConcerns,
    buildGovernanceRecommendations,
    buildTopCountEntries
  });
}

async function buildAutoObservabilitySnapshot(projectPath, options = {}) {
  const days = normalizeStatsWindowDays(options.days);
  const statusFilter = normalizeStatusFilter(options.status);
  const normalizedStatsOptions = {
    days,
    status: statusFilter.length > 0 ? statusFilter.join(',') : undefined
  };
  const normalizedTrendOptions = {
    weeks: options.weeks,
    mode: options.trendMode,
    period: options.trendPeriod
  };

  const [
    sessionStats,
    batchStats,
    controllerStats,
    governanceSessionStats,
    governanceHealth,
    trend
  ] = await Promise.all([
    statsCloseLoopSessions(projectPath, normalizedStatsOptions),
    statsCloseLoopBatchSummarySessions(projectPath, normalizedStatsOptions),
    statsCloseLoopControllerSessions(projectPath, normalizedStatsOptions),
    statsGovernanceCloseLoopSessions(projectPath, normalizedStatsOptions),
    buildAutoGovernanceStats(projectPath, normalizedStatsOptions),
    buildAutoKpiTrend(projectPath, normalizedTrendOptions)
  ]);

  const totalSessions =
    (Number(sessionStats.total_sessions) || 0) +
    (Number(batchStats.total_sessions) || 0) +
    (Number(controllerStats.total_sessions) || 0) +
    (Number(governanceSessionStats.total_sessions) || 0);
  const completedSessions =
    (Number(sessionStats.completed_sessions) || 0) +
    (Number(batchStats.completed_sessions) || 0) +
    (Number(controllerStats.completed_sessions) || 0) +
    (Number(governanceSessionStats.completed_sessions) || 0);
  const failedSessions =
    (Number(sessionStats.failed_sessions) || 0) +
    (Number(batchStats.failed_sessions) || 0) +
    (Number(controllerStats.failed_sessions) || 0) +
    (Number(governanceSessionStats.failed_sessions) || 0);
  const governanceWeeklyOpsStop = governanceSessionStats &&
    governanceSessionStats.release_gate &&
    governanceSessionStats.release_gate.weekly_ops_stop &&
    typeof governanceSessionStats.release_gate.weekly_ops_stop === 'object'
    ? governanceSessionStats.release_gate.weekly_ops_stop
    : null;

  return {
    mode: 'auto-observability-snapshot',
    generated_at: new Date().toISOString(),
    schema_version: AUTO_ARCHIVE_SCHEMA_VERSION,
    criteria: {
      days,
      status_filter: statusFilter,
      trend_weeks: trend.weeks,
      trend_mode: trend.mode,
      trend_period: trend.period_unit
    },
    highlights: {
      total_sessions: totalSessions,
      completed_sessions: completedSessions,
      failed_sessions: failedSessions,
      completion_rate_percent: calculatePercent(completedSessions, totalSessions),
      failure_rate_percent: calculatePercent(failedSessions, totalSessions),
      governance_risk_level: governanceHealth && governanceHealth.health
        ? governanceHealth.health.risk_level
        : 'unknown',
      governance_weekly_ops_stop_sessions: Number(
        governanceWeeklyOpsStop && governanceWeeklyOpsStop.sessions
      ) || 0,
      governance_weekly_ops_stop_session_rate_percent: Number(
        governanceWeeklyOpsStop && governanceWeeklyOpsStop.session_rate_percent
      ) || 0,
      governance_weekly_ops_high_pressure_sessions: Number(
        governanceWeeklyOpsStop && governanceWeeklyOpsStop.high_pressure_sessions
      ) || 0,
      governance_weekly_ops_high_pressure_rate_percent: Number(
        governanceWeeklyOpsStop && governanceWeeklyOpsStop.high_pressure_session_rate_percent
      ) || 0,
      governance_weekly_ops_config_warning_positive_sessions: Number(
        governanceWeeklyOpsStop && governanceWeeklyOpsStop.config_warning_positive_sessions
      ) || 0,
      governance_weekly_ops_auth_tier_pressure_sessions: Number(
        governanceWeeklyOpsStop && governanceWeeklyOpsStop.auth_tier_pressure_sessions
      ) || 0,
      governance_weekly_ops_dialogue_authorization_pressure_sessions: Number(
        governanceWeeklyOpsStop && governanceWeeklyOpsStop.dialogue_authorization_pressure_sessions
      ) || 0,
      governance_weekly_ops_runtime_block_rate_high_sessions: Number(
        governanceWeeklyOpsStop && governanceWeeklyOpsStop.runtime_block_rate_high_sessions
      ) || 0,
      governance_weekly_ops_runtime_ui_mode_violation_high_sessions: Number(
        governanceWeeklyOpsStop && governanceWeeklyOpsStop.runtime_ui_mode_violation_high_sessions
      ) || 0,
      governance_weekly_ops_runtime_ui_mode_violation_total_sum: Number(
        governanceWeeklyOpsStop && governanceWeeklyOpsStop.runtime_ui_mode_violation_total_sum
      ) || 0,
      kpi_anomaly_count: Array.isArray(trend.anomalies) ? trend.anomalies.length : 0
    },
    snapshots: {
      close_loop_session: sessionStats,
      batch_session: batchStats,
      controller_session: controllerStats,
      governance_session: governanceSessionStats,
      governance_weekly_ops_stop: governanceWeeklyOpsStop,
      governance_health: governanceHealth,
      kpi_trend: trend
    }
  };
}

function normalizeSpecName(specNameCandidate) {
  const specName = `${specNameCandidate || ''}`.trim();
  if (!specName) {
    throw new Error('Spec name is required.');
  }
  if (specName.includes('..')) {
    throw new Error('Spec name is invalid.');
  }
  return specName;
}

async function resolveSpecDirectory(projectPath, specNameCandidate) {
  const specName = normalizeSpecName(specNameCandidate);
  const specPath = path.join(projectPath, '.sce', 'specs', specName);
  if (!(await fs.pathExists(specPath))) {
    throw new Error(`Spec not found: ${specName}`);
  }
  const stats = await fs.stat(specPath);
  if (!stats.isDirectory()) {
    throw new Error(`Spec is not a directory: ${specName}`);
  }
  return {
    name: specName,
    path: specPath
  };
}

async function readOptionalJson(filePath) {
  if (!(await fs.pathExists(filePath))) {
    return {
      exists: false,
      payload: null,
      error: null
    };
  }
  try {
    return {
      exists: true,
      payload: await fs.readJson(filePath),
      error: null
    };
  } catch (error) {
    return {
      exists: true,
      payload: null,
      error: error.message
    };
  }
}

async function readOptionalText(filePath) {
  if (!(await fs.pathExists(filePath))) {
    return {
      exists: false,
      content: '',
      error: null
    };
  }
  try {
    return {
      exists: true,
      content: await fs.readFile(filePath, 'utf8'),
      error: null
    };
  } catch (error) {
    return {
      exists: true,
      content: '',
      error: error.message
    };
  }
}

function parseTaskChecklist(content) {
  const lines = `${content || ''}`.split(/\r?\n/);
  let total = 0;
  let closed = 0;
  const openTasks = [];
  for (const line of lines) {
    const match = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)\s*$/);
    if (!match) {
      continue;
    }
    total += 1;
    const isClosed = `${match[1]}`.toLowerCase() === 'x';
    if (isClosed) {
      closed += 1;
      continue;
    }
    openTasks.push(match[2].trim());
  }
  return {
    total,
    closed,
    open: Math.max(0, total - closed),
    completion_rate_percent: total > 0
      ? Number(((closed / total) * 100).toFixed(2))
      : 0,
    open_tasks: openTasks
  };
}

function summarizeDocExcerpt(content, maxLines = 12) {
  const lines = `${content || ''}`
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return '';
  }
  return lines.slice(0, maxLines).join('\n');
}

async function buildAutoSpecStatus(projectPath, specNameCandidate) {
  const spec = await resolveSpecDirectory(projectPath, specNameCandidate);
  const requirementsFile = path.join(spec.path, 'requirements.md');
  const designFile = path.join(spec.path, 'design.md');
  const tasksFile = path.join(spec.path, 'tasks.md');
  const collaborationFile = path.join(spec.path, 'collaboration.json');

  const [requirements, design, tasks, collaboration] = await Promise.all([
    readOptionalText(requirementsFile),
    readOptionalText(designFile),
    readOptionalText(tasksFile),
    readOptionalJson(collaborationFile)
  ]);

  const taskProgress = parseTaskChecklist(tasks.content);
  const collaborationPayload = collaboration.payload && typeof collaboration.payload === 'object'
    ? collaboration.payload
    : null;
  const collaborationStatus =
    collaborationPayload &&
    collaborationPayload.status &&
    typeof collaborationPayload.status === 'object' &&
    typeof collaborationPayload.status.current === 'string'
      ? collaborationPayload.status.current
      : collaborationPayload && typeof collaborationPayload.status === 'string'
        ? collaborationPayload.status
        : collaboration.exists && collaboration.error
          ? 'invalid'
          : 'unknown';
  const dependencies = Array.isArray(collaborationPayload && collaborationPayload.dependencies)
    ? collaborationPayload.dependencies
      .map(item => (item && typeof item.spec === 'string' ? item.spec.trim() : ''))
      .filter(Boolean)
    : [];

  const docs = {
    requirements: requirements.exists,
    design: design.exists,
    tasks: tasks.exists,
    all_required_present: requirements.exists && design.exists && tasks.exists
  };

  const blockers = [];
  if (!docs.all_required_present) {
    blockers.push('missing-required-docs');
  }
  if (collaboration.exists && collaboration.error) {
    blockers.push('invalid-collaboration-json');
  }
  if (`${collaborationStatus || ''}`.trim().toLowerCase() === 'blocked') {
    blockers.push('collaboration-blocked');
  }

  return {
    mode: 'auto-spec-status',
    generated_at: new Date().toISOString(),
    spec,
    docs,
    task_progress: {
      total: taskProgress.total,
      closed: taskProgress.closed,
      open: taskProgress.open,
      completion_rate_percent: taskProgress.completion_rate_percent
    },
    collaboration: {
      file: collaborationFile,
      exists: collaboration.exists,
      status: collaborationStatus,
      type: collaborationPayload && typeof collaborationPayload.type === 'string'
        ? collaborationPayload.type
        : null,
      master_spec: collaborationPayload && typeof collaborationPayload.masterSpec === 'string'
        ? collaborationPayload.masterSpec
        : null,
      dependencies,
      parse_error: collaboration.error
    },
    health: {
      ready_for_execution: blockers.length === 0,
      blockers
    }
  };
}

async function buildAutoSpecInstructions(projectPath, specNameCandidate) {
  const specStatus = await buildAutoSpecStatus(projectPath, specNameCandidate);
  const specPath = specStatus.spec.path;
  const tasksFile = path.join(specPath, 'tasks.md');
  const requirementsFile = path.join(specPath, 'requirements.md');
  const designFile = path.join(specPath, 'design.md');

  const [requirements, design, tasks] = await Promise.all([
    readOptionalText(requirementsFile),
    readOptionalText(designFile),
    readOptionalText(tasksFile)
  ]);

  const taskChecklist = parseTaskChecklist(tasks.content);
  const dependencyLine = specStatus.collaboration.dependencies.length > 0
    ? `Resolve dependencies first: ${specStatus.collaboration.dependencies.join(', ')}.`
    : 'No explicit dependencies detected; this spec can execute immediately.';
  const nextActions = [
    dependencyLine,
    taskChecklist.open_tasks.length > 0
      ? `Execute open tasks in order and keep checklist in sync (open: ${taskChecklist.open}).`
      : 'No open checklist tasks detected; verify completion evidence and close out collaboration status.',
    'Update collaboration status after each milestone and before handoff.'
  ];

  return {
    mode: 'auto-spec-instructions',
    generated_at: new Date().toISOString(),
    spec: specStatus.spec,
    status: {
      collaboration_status: specStatus.collaboration.status,
      docs_complete: specStatus.docs.all_required_present,
      task_completion_rate_percent: specStatus.task_progress.completion_rate_percent
    },
    instructions: {
      next_actions: nextActions,
      priority_open_tasks: taskChecklist.open_tasks.slice(0, 20),
      recommended_commands: [
        `sce auto spec status ${specStatus.spec.name} --json`,
        `sce orchestrate ${specStatus.spec.name} --json`
      ],
      document_excerpts: {
        requirements: summarizeDocExcerpt(requirements.content),
        design: summarizeDocExcerpt(design.content),
        tasks: summarizeDocExcerpt(tasks.content)
      }
    }
  };
}

function normalizeSchemaScope(scopeCandidate) {
  const allowed = new Set([
    'close-loop-session',
    'batch-session',
    'controller-session',
    'governance-session'
  ]);
  const raw = `${scopeCandidate || 'all'}`.trim().toLowerCase();
  const tokens = raw.split(',').map(item => item.trim()).filter(Boolean);
  if (tokens.length === 0 || tokens.includes('all')) {
    return [...allowed];
  }
  const normalized = [];
  for (const token of tokens) {
    if (!allowed.has(token)) {
      throw new Error('--only must be one of: all, close-loop-session, batch-session, controller-session, governance-session');
    }
    if (!normalized.includes(token)) {
      normalized.push(token);
    }
  }
  return normalized;
}

function normalizeTargetSchemaVersion(targetVersionCandidate) {
  const normalized = `${targetVersionCandidate || ''}`.trim();
  if (!normalized) {
    throw new Error('--target-version is required.');
  }
  if (normalized.length > 32) {
    throw new Error('--target-version must be 32 characters or fewer.');
  }
  return normalized;
}

function getAutoArchiveSchemaTargets(projectPath, scope) {
  const allTargets = [
    {
      id: 'close-loop-session',
      directory: getCloseLoopSessionDir(projectPath)
    },
    {
      id: 'batch-session',
      directory: getCloseLoopBatchSummaryDir(projectPath)
    },
    {
      id: 'controller-session',
      directory: getCloseLoopControllerSessionDir(projectPath)
    },
    {
      id: 'governance-session',
      directory: getGovernanceCloseLoopSessionDir(projectPath)
    }
  ];
  const scopeSet = new Set(scope);
  return allTargets.filter(item => scopeSet.has(item.id));
}

function classifyArchiveSchemaCompatibility(schemaVersion) {
  const normalized = typeof schemaVersion === 'string' ? schemaVersion.trim() : '';
  if (!normalized) {
    return 'missing_schema_version';
  }
  if (AUTO_ARCHIVE_SCHEMA_SUPPORTED_VERSIONS.has(normalized)) {
    return 'compatible';
  }
  return 'incompatible';
}

async function checkAutoArchiveSchema(projectPath, options = {}) {
  const scope = normalizeSchemaScope(options.only);
  const targets = getAutoArchiveSchemaTargets(projectPath, scope);
  const archives = [];

  for (const target of targets) {
    const archiveSummary = {
      id: target.id,
      directory: target.directory,
      total_files: 0,
      compatible_files: 0,
      missing_schema_version_files: 0,
      incompatible_files: 0,
      parse_error_files: 0,
      issues: []
    };
    if (!(await fs.pathExists(target.directory))) {
      archives.push(archiveSummary);
      continue;
    }
    const files = (await fs.readdir(target.directory))
      .filter(item => item.toLowerCase().endsWith('.json'))
      .sort((left, right) => left.localeCompare(right));
    archiveSummary.total_files = files.length;

    for (const file of files) {
      const filePath = path.join(target.directory, file);
      let payload = null;
      try {
        payload = await fs.readJson(filePath);
      } catch (error) {
        archiveSummary.parse_error_files += 1;
        archiveSummary.issues.push({
          file: filePath,
          compatibility: 'parse_error',
          error: error.message
        });
        continue;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        archiveSummary.parse_error_files += 1;
        archiveSummary.issues.push({
          file: filePath,
          compatibility: 'parse_error',
          error: 'invalid JSON root type'
        });
        continue;
      }
      const schemaVersion = typeof payload.schema_version === 'string'
        ? payload.schema_version.trim()
        : '';
      const compatibility = classifyArchiveSchemaCompatibility(schemaVersion);
      if (compatibility === 'compatible') {
        archiveSummary.compatible_files += 1;
      } else if (compatibility === 'missing_schema_version') {
        archiveSummary.missing_schema_version_files += 1;
        archiveSummary.issues.push({
          file: filePath,
          compatibility,
          schema_version: null
        });
      } else {
        archiveSummary.incompatible_files += 1;
        archiveSummary.issues.push({
          file: filePath,
          compatibility,
          schema_version: schemaVersion
        });
      }
    }
    archives.push(archiveSummary);
  }

  const totals = archives.reduce((acc, item) => ({
    total_files: acc.total_files + item.total_files,
    compatible_files: acc.compatible_files + item.compatible_files,
    missing_schema_version_files: acc.missing_schema_version_files + item.missing_schema_version_files,
    incompatible_files: acc.incompatible_files + item.incompatible_files,
    parse_error_files: acc.parse_error_files + item.parse_error_files
  }), {
    total_files: 0,
    compatible_files: 0,
    missing_schema_version_files: 0,
    incompatible_files: 0,
    parse_error_files: 0
  });

  return {
    mode: 'auto-schema-check',
    generated_at: new Date().toISOString(),
    supported_versions: [...AUTO_ARCHIVE_SCHEMA_SUPPORTED_VERSIONS],
    scope,
    summary: {
      ...totals,
      compatibility_rate_percent: calculatePercent(totals.compatible_files, totals.total_files)
    },
    archives
  };
}

async function migrateAutoArchiveSchema(projectPath, options = {}) {
  const scope = normalizeSchemaScope(options.only);
  const targetVersion = normalizeTargetSchemaVersion(options.targetVersion || AUTO_ARCHIVE_SCHEMA_VERSION);
  const dryRun = !options.apply;
  const targets = getAutoArchiveSchemaTargets(projectPath, scope);
  const archives = [];

  for (const target of targets) {
    const archiveSummary = {
      id: target.id,
      directory: target.directory,
      total_files: 0,
      candidate_files: 0,
      updated_files: 0,
      skipped_compatible_files: 0,
      parse_error_files: 0,
      updates: [],
      errors: []
    };
    if (!(await fs.pathExists(target.directory))) {
      archives.push(archiveSummary);
      continue;
    }

    const files = (await fs.readdir(target.directory))
      .filter(item => item.toLowerCase().endsWith('.json'))
      .sort((left, right) => left.localeCompare(right));
    archiveSummary.total_files = files.length;

    for (const file of files) {
      const filePath = path.join(target.directory, file);
      let payload = null;
      try {
        payload = await fs.readJson(filePath);
      } catch (error) {
        archiveSummary.parse_error_files += 1;
        archiveSummary.errors.push({
          file: filePath,
          error: error.message
        });
        continue;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        archiveSummary.parse_error_files += 1;
        archiveSummary.errors.push({
          file: filePath,
          error: 'invalid JSON root type'
        });
        continue;
      }

      const previousVersion = typeof payload.schema_version === 'string'
        ? payload.schema_version.trim()
        : '';
      if (previousVersion === targetVersion) {
        archiveSummary.skipped_compatible_files += 1;
        continue;
      }

      archiveSummary.candidate_files += 1;
      if (dryRun) {
        archiveSummary.updates.push({
          file: filePath,
          from: previousVersion || null,
          to: targetVersion
        });
        continue;
      }

      payload.schema_version = targetVersion;
      await fs.writeJson(filePath, payload, { spaces: 2 });
      archiveSummary.updated_files += 1;
      archiveSummary.updates.push({
        file: filePath,
        from: previousVersion || null,
        to: targetVersion
      });
    }
    archives.push(archiveSummary);
  }

  const totals = archives.reduce((acc, item) => ({
    total_files: acc.total_files + item.total_files,
    candidate_files: acc.candidate_files + item.candidate_files,
    updated_files: acc.updated_files + item.updated_files,
    skipped_compatible_files: acc.skipped_compatible_files + item.skipped_compatible_files,
    parse_error_files: acc.parse_error_files + item.parse_error_files
  }), {
    total_files: 0,
    candidate_files: 0,
    updated_files: 0,
    skipped_compatible_files: 0,
    parse_error_files: 0
  });

  return {
    mode: 'auto-schema-migrate',
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    target_version: targetVersion,
    scope,
    summary: totals,
    archives
  };
}

function normalizeGovernanceKeepOption(keepCandidate, flagName, fallback = 50) {
  if (keepCandidate === undefined || keepCandidate === null) {
    return fallback;
  }
  const parsed = Number(keepCandidate);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
    throw new Error(`${flagName} must be an integer between 0 and 1000.`);
  }
  return parsed;
}

function normalizeGovernanceRecoveryOlderThanDays(daysCandidate, fallback = 90) {
  if (daysCandidate === undefined || daysCandidate === null) {
    return fallback;
  }
  const parsed = Number(daysCandidate);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 36500) {
    throw new Error('--recovery-memory-older-than-days must be an integer between 0 and 36500.');
  }
  return parsed;
}

function normalizeGovernanceTargetRiskLevel(levelCandidate) {
  const normalized = `${levelCandidate || 'low'}`.trim().toLowerCase();
  if (!['low', 'medium', 'high'].includes(normalized)) {
    throw new Error('--target-risk must be one of: low, medium, high.');
  }
  return normalized;
}

function normalizeGovernanceMaxRounds(roundsCandidate, fallback = 3) {
  if (roundsCandidate === undefined || roundsCandidate === null) {
    return fallback;
  }
  const parsed = Number(roundsCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error('--max-rounds must be an integer between 1 and 20.');
  }
  return parsed;
}

function normalizeGovernanceSessionKeep(keepCandidate) {
  if (keepCandidate === undefined || keepCandidate === null) {
    return null;
  }
  const parsed = Number(keepCandidate);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
    throw new Error('--governance-session-keep must be an integer between 0 and 1000.');
  }
  return parsed;
}

function normalizeGovernanceSessionOlderThanDays(daysCandidate) {
  if (daysCandidate === undefined || daysCandidate === null) {
    return null;
  }
  const parsed = Number(daysCandidate);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 36500) {
    throw new Error('--governance-session-older-than-days must be an integer between 0 and 36500.');
  }
  return parsed;
}

function normalizeGovernanceAdvisoryRecoverMaxRounds(roundsCandidate, fallback = 3) {
  if (roundsCandidate === undefined || roundsCandidate === null) {
    return fallback;
  }
  const parsed = Number(roundsCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error('--advisory-recover-max-rounds must be an integer between 1 and 20.');
  }
  return parsed;
}

function normalizeGovernanceAdvisoryControllerMaxCycles(cyclesCandidate, fallback = 20) {
  if (cyclesCandidate === undefined || cyclesCandidate === null) {
    return fallback;
  }
  const parsed = Number(cyclesCandidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100000) {
    throw new Error('--advisory-controller-max-cycles must be an integer between 1 and 100000.');
  }
  return parsed;
}

function getCommandOptionSources(command, optionNames = []) {
  if (!command || typeof command.getOptionValueSource !== 'function') {
    return {};
  }
  const sources = {};
  for (const optionName of optionNames) {
    if (typeof optionName !== 'string' || !optionName.trim()) {
      continue;
    }
    sources[optionName] = command.getOptionValueSource(optionName);
  }
  return sources;
}

function isExplicitOptionSource(source) {
  return Boolean(source) && source !== 'default';
}

function compareRiskLevel(left, right) {
  const rank = { low: 1, medium: 2, high: 3 };
  const leftRank = rank[`${left || ''}`.trim().toLowerCase()] || 99;
  const rightRank = rank[`${right || ''}`.trim().toLowerCase()] || 99;
  return leftRank - rightRank;
}

async function runAutoGovernanceMaintenance(projectPath, options = {}) {
  return runAutoGovernanceMaintenanceService(projectPath, options, {
    normalizeStatsWindowDays,
    normalizeStatusFilter,
    normalizeGovernanceKeepOption,
    normalizeGovernanceRecoveryOlderThanDays,
    buildAutoGovernanceStats,
    buildAutoGovernanceMaintenancePlan,
    evaluateGovernanceReleaseGateBlockState,
    pruneCloseLoopSessions,
    pruneCloseLoopBatchSummarySessionsCli,
    pruneCloseLoopControllerSessionsCli,
    pruneCloseLoopRecoveryMemory,
    summarizeGovernanceMaintenanceExecution
  });
}

async function resolveLatestRecoverableBatchSummary(projectPath, resumeStrategy = 'pending') {
  const entries = await readCloseLoopBatchSummaryEntries(projectPath);
  for (const entry of entries) {
    if (!entry || !entry.file) {
      continue;
    }
    let loaded = null;
    try {
      loaded = await loadCloseLoopBatchSummaryPayload(projectPath, entry.file);
      const goalsResult = await buildCloseLoopBatchGoalsFromSummaryPayload(
        loaded.payload,
        loaded.file,
        projectPath,
        'auto',
        resumeStrategy
      );
      if (Array.isArray(goalsResult.goals) && goalsResult.goals.length > 0) {
        return loaded;
      }
    } catch (error) {
      continue;
    }
  }
  return null;
}

async function resolveLatestPendingControllerSession(projectPath) {
  const sessions = await readCloseLoopControllerSessionEntries(projectPath);
  const pendingSession = sessions.find(session => Number(session && session.pending_goals) > 0);
  if (!pendingSession || !pendingSession.file) {
    return null;
  }
  try {
    return await loadCloseLoopControllerSessionPayload(projectPath, pendingSession.file);
  } catch (error) {
    return null;
  }
}

async function executeGovernanceAdvisoryRecover(projectPath, options = {}) {
  return executeGovernanceAdvisoryRecoverService(projectPath, options, {
    normalizeGovernanceAdvisoryRecoverMaxRounds,
    loadCloseLoopBatchSummaryPayload,
    resolveRecoveryMemoryScope,
    executeCloseLoopRecoveryCycle,
    readCloseLoopBatchSummaryEntries,
    buildCloseLoopBatchGoalsFromSummaryPayload
  });
}

async function executeGovernanceAdvisoryControllerResume(projectPath, options = {}) {
  return executeGovernanceAdvisoryControllerResumeService(projectPath, options, {
    normalizeGovernanceAdvisoryControllerMaxCycles,
    loadCloseLoopControllerSessionPayload,
    runCloseLoopController,
    readCloseLoopControllerSessionEntries
  });
}

function resolveGovernanceCloseLoopRunStatus(stopReason, converged) {
  if (converged) {
    return 'completed';
  }
  if ([
    'maintenance-action-failed',
    'advisory-action-failed',
    'release-gate-blocked'
  ].includes(`${stopReason || ''}`.trim().toLowerCase())) {
    return 'failed';
  }
  return 'stopped';
}

function evaluateGovernanceReleaseGateBlockState(assessment) {
  const releaseGate = assessment && assessment.health && assessment.health.release_gate &&
    typeof assessment.health.release_gate === 'object'
    ? assessment.health.release_gate
    : {};
  const snapshot = normalizeGovernanceReleaseGateSnapshot(
    releaseGate
  );
  const handoffSnapshot = normalizeGovernanceHandoffQualitySnapshot(
    assessment && assessment.health ? assessment.health.handoff_quality : null
  );
  if (!snapshot || snapshot.available !== true) {
    if (
      !handoffSnapshot ||
      handoffSnapshot.available !== true ||
      !Number.isFinite(Number(handoffSnapshot.total_runs)) ||
      Number(handoffSnapshot.total_runs) <= 0
    ) {
      return {
        blocked: false,
        reasons: [],
        snapshot,
        handoff_snapshot: handoffSnapshot
      };
    }
  }

  const reasons = [];
  if (snapshot && snapshot.available === true) {
    const weeklyOpsLatestBlocked = parseAutoHandoffGateBoolean(releaseGate.latest_weekly_ops_blocked, null);
    const weeklyOpsLatestRiskLevel = `${releaseGate.latest_weekly_ops_risk_level || ''}`.trim().toLowerCase();
    const weeklyOpsLatestGovernanceStatus = `${releaseGate.latest_weekly_ops_governance_status || ''}`.trim().toLowerCase();
    const weeklyOpsLatestConfigWarningCount = Number(releaseGate.latest_weekly_ops_config_warning_count);
    const weeklyOpsLatestAuthorizationTierBlockRate = Number(
      releaseGate.latest_weekly_ops_authorization_tier_block_rate_percent
    );
    const weeklyOpsLatestDialogueAuthorizationBlockRate = Number(
      releaseGate.latest_weekly_ops_dialogue_authorization_block_rate_percent
    );
    const weeklyOpsLatestRuntimeBlockRate = Number(
      releaseGate.latest_weekly_ops_runtime_block_rate_percent
    );
    const weeklyOpsLatestRuntimeUiModeViolationTotal = Number(
      releaseGate.latest_weekly_ops_runtime_ui_mode_violation_total
    );
    const weeklyOpsLatestRuntimeUiModeViolationRate = Number(
      releaseGate.latest_weekly_ops_runtime_ui_mode_violation_rate_percent
    );
    const weeklyOpsBlockedRuns = Number(releaseGate.weekly_ops_blocked_runs);
    const weeklyOpsBlockRate = Number(releaseGate.weekly_ops_block_rate_percent);
    const weeklyOpsViolationsTotal = Number(releaseGate.weekly_ops_violations_total);
    const weeklyOpsWarningsTotal = Number(releaseGate.weekly_ops_warnings_total);
    const weeklyOpsConfigWarningsTotal = Number(releaseGate.weekly_ops_config_warnings_total);
    const weeklyOpsAuthorizationTierBlockRateMax = Number(
      releaseGate.weekly_ops_authorization_tier_block_rate_max_percent
    );
    const weeklyOpsDialogueAuthorizationBlockRateMax = Number(
      releaseGate.weekly_ops_dialogue_authorization_block_rate_max_percent
    );
    const weeklyOpsRuntimeBlockRateMax = Number(
      releaseGate.weekly_ops_runtime_block_rate_max_percent
    );
    const weeklyOpsRuntimeUiModeViolationTotal = Number(
      releaseGate.weekly_ops_runtime_ui_mode_violation_total
    );
    const weeklyOpsRuntimeUiModeViolationRunRate = Number(
      releaseGate.weekly_ops_runtime_ui_mode_violation_run_rate_percent
    );
    const weeklyOpsRuntimeUiModeViolationRateMax = Number(
      releaseGate.weekly_ops_runtime_ui_mode_violation_rate_max_percent
    );

    if (snapshot.latest_gate_passed === false) {
      reasons.push('latest-release-gate-failed');
    }
    if (Number.isFinite(snapshot.pass_rate_percent) && snapshot.pass_rate_percent < 85) {
      reasons.push(`release-gate-pass-rate-low:${snapshot.pass_rate_percent}`);
    }
    if (
      Number.isFinite(snapshot.scene_package_batch_pass_rate_percent) &&
      snapshot.scene_package_batch_pass_rate_percent < 85
    ) {
      reasons.push(`scene-batch-pass-rate-low:${snapshot.scene_package_batch_pass_rate_percent}`);
    }
    if (Number.isFinite(snapshot.drift_alert_rate_percent) && snapshot.drift_alert_rate_percent > 0) {
      reasons.push(`drift-alert-rate-positive:${snapshot.drift_alert_rate_percent}`);
    }
    if (Number.isFinite(snapshot.drift_blocked_runs) && snapshot.drift_blocked_runs > 0) {
      reasons.push(`drift-blocked-runs-positive:${snapshot.drift_blocked_runs}`);
    }
    if (weeklyOpsLatestBlocked === true) {
      reasons.push('weekly-ops-latest-blocked');
    }
    if (weeklyOpsLatestRiskLevel === 'high') {
      reasons.push('weekly-ops-latest-risk-high');
    }
    if (weeklyOpsLatestGovernanceStatus && ['alert', 'blocked', 'degraded'].includes(weeklyOpsLatestGovernanceStatus)) {
      reasons.push(`weekly-ops-governance-status:${weeklyOpsLatestGovernanceStatus}`);
    }
    if (Number.isFinite(weeklyOpsLatestConfigWarningCount) && weeklyOpsLatestConfigWarningCount > 0) {
      reasons.push(`weekly-ops-latest-config-warnings-positive:${weeklyOpsLatestConfigWarningCount}`);
    }
    if (
      Number.isFinite(weeklyOpsLatestAuthorizationTierBlockRate) &&
      weeklyOpsLatestAuthorizationTierBlockRate > 40
    ) {
      reasons.push(
        `weekly-ops-latest-auth-tier-block-rate-high:${weeklyOpsLatestAuthorizationTierBlockRate}`
      );
    }
    if (
      Number.isFinite(weeklyOpsLatestDialogueAuthorizationBlockRate) &&
      weeklyOpsLatestDialogueAuthorizationBlockRate > 40
    ) {
      reasons.push(
        `weekly-ops-latest-dialogue-authorization-block-rate-high:` +
        `${weeklyOpsLatestDialogueAuthorizationBlockRate}`
      );
    }
    if (Number.isFinite(weeklyOpsLatestRuntimeBlockRate) && weeklyOpsLatestRuntimeBlockRate > 40) {
      reasons.push(`weekly-ops-latest-runtime-block-rate-high:${weeklyOpsLatestRuntimeBlockRate}`);
    }
    if (
      Number.isFinite(weeklyOpsLatestRuntimeUiModeViolationTotal) &&
      weeklyOpsLatestRuntimeUiModeViolationTotal > 0
    ) {
      reasons.push(
        `weekly-ops-latest-runtime-ui-mode-violations-positive:${weeklyOpsLatestRuntimeUiModeViolationTotal}`
      );
    }
    if (
      Number.isFinite(weeklyOpsLatestRuntimeUiModeViolationRate) &&
      weeklyOpsLatestRuntimeUiModeViolationRate > 0
    ) {
      reasons.push(
        `weekly-ops-latest-runtime-ui-mode-violation-rate-positive:${weeklyOpsLatestRuntimeUiModeViolationRate}`
      );
    }
    if (Number.isFinite(weeklyOpsBlockedRuns) && weeklyOpsBlockedRuns > 0) {
      reasons.push(`weekly-ops-blocked-runs-positive:${weeklyOpsBlockedRuns}`);
    }
    if (Number.isFinite(weeklyOpsBlockRate) && weeklyOpsBlockRate > 0) {
      reasons.push(`weekly-ops-block-rate-positive:${weeklyOpsBlockRate}`);
    }
    if (Number.isFinite(weeklyOpsViolationsTotal) && weeklyOpsViolationsTotal > 0) {
      reasons.push(`weekly-ops-violations-positive:${weeklyOpsViolationsTotal}`);
    }
    if (Number.isFinite(weeklyOpsWarningsTotal) && weeklyOpsWarningsTotal > 0) {
      reasons.push(`weekly-ops-warnings-positive:${weeklyOpsWarningsTotal}`);
    }
    if (Number.isFinite(weeklyOpsConfigWarningsTotal) && weeklyOpsConfigWarningsTotal > 0) {
      reasons.push(`weekly-ops-config-warnings-positive:${weeklyOpsConfigWarningsTotal}`);
    }
    if (
      Number.isFinite(weeklyOpsAuthorizationTierBlockRateMax) &&
      weeklyOpsAuthorizationTierBlockRateMax > 40
    ) {
      reasons.push(
        `weekly-ops-auth-tier-block-rate-high:${weeklyOpsAuthorizationTierBlockRateMax}`
      );
    }
    if (
      Number.isFinite(weeklyOpsDialogueAuthorizationBlockRateMax) &&
      weeklyOpsDialogueAuthorizationBlockRateMax > 40
    ) {
      reasons.push(
        `weekly-ops-dialogue-authorization-block-rate-high:${weeklyOpsDialogueAuthorizationBlockRateMax}`
      );
    }
    if (Number.isFinite(weeklyOpsRuntimeBlockRateMax) && weeklyOpsRuntimeBlockRateMax > 40) {
      reasons.push(`weekly-ops-runtime-block-rate-high:${weeklyOpsRuntimeBlockRateMax}`);
    }
    if (Number.isFinite(weeklyOpsRuntimeUiModeViolationTotal) && weeklyOpsRuntimeUiModeViolationTotal > 0) {
      reasons.push(`weekly-ops-runtime-ui-mode-violations-positive:${weeklyOpsRuntimeUiModeViolationTotal}`);
    }
    if (
      Number.isFinite(weeklyOpsRuntimeUiModeViolationRunRate) &&
      weeklyOpsRuntimeUiModeViolationRunRate > 0
    ) {
      reasons.push(
        `weekly-ops-runtime-ui-mode-violation-run-rate-positive:${weeklyOpsRuntimeUiModeViolationRunRate}`
      );
    }
    if (
      Number.isFinite(weeklyOpsRuntimeUiModeViolationRateMax) &&
      weeklyOpsRuntimeUiModeViolationRateMax > 0
    ) {
      reasons.push(
        `weekly-ops-runtime-ui-mode-violation-rate-high:${weeklyOpsRuntimeUiModeViolationRateMax}`
      );
    }
  }

  if (
    handoffSnapshot &&
    handoffSnapshot.available === true &&
    Number.isFinite(Number(handoffSnapshot.total_runs)) &&
    Number(handoffSnapshot.total_runs) > 0
  ) {
    const latestStatus = `${handoffSnapshot.latest_status || ''}`.trim().toLowerCase();
    if (latestStatus && !['completed', 'dry-run', 'dry_run'].includes(latestStatus)) {
      reasons.push(`handoff-latest-status:${latestStatus}`);
    }
    if (handoffSnapshot.latest_gate_passed === false) {
      reasons.push('handoff-latest-gate-failed');
    }
    if (
      Number.isFinite(handoffSnapshot.latest_ontology_quality_score) &&
      handoffSnapshot.latest_ontology_quality_score < 70
    ) {
      reasons.push(`handoff-ontology-score-low:${handoffSnapshot.latest_ontology_quality_score}`);
    }
    if (handoffSnapshot.latest_capability_coverage_passed === false) {
      reasons.push('handoff-capability-coverage-failed');
    }
    if (
      Number.isFinite(handoffSnapshot.latest_capability_expected_unknown_count) &&
      handoffSnapshot.latest_capability_expected_unknown_count > 0
    ) {
      reasons.push(
        `handoff-capability-expected-unknown-positive:${handoffSnapshot.latest_capability_expected_unknown_count}`
      );
    }
    if (
      Number.isFinite(handoffSnapshot.latest_capability_provided_unknown_count) &&
      handoffSnapshot.latest_capability_provided_unknown_count > 0
    ) {
      reasons.push(
        `handoff-capability-provided-unknown-positive:${handoffSnapshot.latest_capability_provided_unknown_count}`
      );
    }
    if (
      Number.isFinite(handoffSnapshot.capability_expected_unknown_positive_rate_percent) &&
      handoffSnapshot.capability_expected_unknown_positive_rate_percent > 0
    ) {
      reasons.push(
        `handoff-capability-expected-unknown-positive-rate:` +
        `${handoffSnapshot.capability_expected_unknown_positive_rate_percent}`
      );
    }
    if (
      Number.isFinite(handoffSnapshot.capability_provided_unknown_positive_rate_percent) &&
      handoffSnapshot.capability_provided_unknown_positive_rate_percent > 0
    ) {
      reasons.push(
        `handoff-capability-provided-unknown-positive-rate:` +
        `${handoffSnapshot.capability_provided_unknown_positive_rate_percent}`
      );
    }
    if (handoffSnapshot.latest_release_gate_preflight_blocked === true) {
      reasons.push('handoff-release-preflight-blocked');
    }
    if (Number.isFinite(handoffSnapshot.failure_rate_percent) && handoffSnapshot.failure_rate_percent > 0) {
      reasons.push(`handoff-failure-rate-positive:${handoffSnapshot.failure_rate_percent}`);
    }
    const handoffLatestMoquiMatrixRegressionCount = Number(handoffSnapshot.latest_moqui_matrix_regression_count);
    const handoffLatestMoquiMatrixRegressionGateMax = Number(handoffSnapshot.latest_moqui_matrix_regression_gate_max);
    if (
      Number.isFinite(handoffLatestMoquiMatrixRegressionCount) &&
      handoffLatestMoquiMatrixRegressionCount > 0
    ) {
      reasons.push(`handoff-moqui-matrix-regressions-positive:${handoffLatestMoquiMatrixRegressionCount}`);
    }
    if (
      Number.isFinite(handoffLatestMoquiMatrixRegressionCount) &&
      Number.isFinite(handoffLatestMoquiMatrixRegressionGateMax) &&
      handoffLatestMoquiMatrixRegressionCount > handoffLatestMoquiMatrixRegressionGateMax
    ) {
      reasons.push(
        `handoff-moqui-matrix-regressions-over-gate:` +
        `${handoffLatestMoquiMatrixRegressionCount}/${handoffLatestMoquiMatrixRegressionGateMax}`
      );
    }
  }

  const blockedByReleaseGate = Boolean(
    snapshot &&
    snapshot.available === true &&
    (
      snapshot.latest_gate_passed === false ||
      (Number.isFinite(snapshot.drift_alert_rate_percent) && snapshot.drift_alert_rate_percent > 0) ||
      (Number.isFinite(snapshot.drift_blocked_runs) && snapshot.drift_blocked_runs > 0)
    )
  );
  const blockedByWeeklyOps = reasons.some(item => (
    `${item}` === 'weekly-ops-latest-blocked'
    || `${item}` === 'weekly-ops-latest-risk-high'
    || `${item}`.startsWith('weekly-ops-governance-status:')
    || `${item}`.startsWith('weekly-ops-latest-config-warnings-positive:')
    || `${item}`.startsWith('weekly-ops-config-warnings-positive:')
    || `${item}`.startsWith('weekly-ops-blocked-runs-positive:')
    || `${item}`.startsWith('weekly-ops-block-rate-positive:')
    || `${item}`.startsWith('weekly-ops-latest-auth-tier-block-rate-high:')
    || `${item}`.startsWith('weekly-ops-auth-tier-block-rate-high:')
    || `${item}`.startsWith('weekly-ops-latest-dialogue-authorization-block-rate-high:')
    || `${item}`.startsWith('weekly-ops-dialogue-authorization-block-rate-high:')
    || `${item}`.startsWith('weekly-ops-latest-runtime-block-rate-high:')
    || `${item}`.startsWith('weekly-ops-runtime-block-rate-high:')
    || `${item}`.startsWith('weekly-ops-latest-runtime-ui-mode-violations-positive:')
    || `${item}`.startsWith('weekly-ops-runtime-ui-mode-violations-positive:')
    || `${item}`.startsWith('weekly-ops-latest-runtime-ui-mode-violation-rate-positive:')
    || `${item}`.startsWith('weekly-ops-runtime-ui-mode-violation-run-rate-positive:')
    || `${item}`.startsWith('weekly-ops-runtime-ui-mode-violation-rate-high:')
  ));
  const blockedByHandoffQuality = reasons.some(item => (
    `${item}`.startsWith('handoff-latest-status:')
    || `${item}` === 'handoff-latest-gate-failed'
    || `${item}`.startsWith('handoff-ontology-score-low:')
    || `${item}` === 'handoff-capability-coverage-failed'
    || `${item}`.startsWith('handoff-capability-expected-unknown-positive:')
    || `${item}`.startsWith('handoff-capability-provided-unknown-positive:')
    || `${item}`.startsWith('handoff-capability-expected-unknown-positive-rate:')
    || `${item}`.startsWith('handoff-capability-provided-unknown-positive-rate:')
    || `${item}` === 'handoff-release-preflight-blocked'
    || `${item}`.startsWith('handoff-moqui-matrix-regressions-positive:')
    || `${item}`.startsWith('handoff-moqui-matrix-regressions-over-gate:')
  ));
  const blocked = reasons.length > 0 && (blockedByReleaseGate || blockedByWeeklyOps || blockedByHandoffQuality);
  return {
    blocked,
    reasons,
    snapshot,
    handoff_snapshot: handoffSnapshot
  };
}

function buildGovernanceCloseLoopRecommendations(finalAssessment, stopReason, stopDetail) {
  const base = Array.isArray(
    finalAssessment &&
    finalAssessment.health &&
    finalAssessment.health.recommendations
  )
    ? [...finalAssessment.health.recommendations]
    : [];
  if (`${stopReason || ''}`.trim().toLowerCase() !== 'release-gate-blocked') {
    return Array.from(new Set(base));
  }

  base.push(
    'Release gate trend is blocking governance convergence; fix handoff release evidence before next governance round.'
  );
  const reasons = Array.isArray(stopDetail && stopDetail.reasons) ? stopDetail.reasons : [];
  if (reasons.some(item => `${item}`.includes('drift'))) {
    base.push('Review drift blockers with `sce auto handoff evidence --window 5 --json`.');
  }
  if (reasons.some(item => `${item}`.includes('scene-batch'))) {
    base.push(
      'Rerun and stabilize scene batch quality: `sce scene package-publish-batch --manifest docs/handoffs/handoff-manifest.json --dry-run --json`.'
    );
  }
  if (reasons.some(item => `${item}`.startsWith('weekly-ops-'))) {
    base.push(
      'Rebuild weekly release pressure signals with `node scripts/release-ops-weekly-summary.js --json` + ' +
      '`node scripts/release-weekly-ops-gate.js`.'
    );
  }
  if (reasons.some(item => `${item}`.includes('weekly-ops-config-warnings'))) {
    base.push(
      'Fix invalid weekly ops threshold variables (`KSE_RELEASE_WEEKLY_OPS_*`) and rerun release gates ' +
      'to clear config warnings.'
    );
  }
  if (reasons.some(item => `${item}`.includes('weekly-ops-auth-tier-block-rate'))) {
    base.push(
      'Tune authorization-tier policy pressure with ' +
      '`node scripts/interactive-authorization-tier-evaluate.js --policy docs/interactive-customization/authorization-tier-policy-baseline.json --json`.'
    );
  }
  if (reasons.some(item => `${item}`.includes('weekly-ops-dialogue-authorization-block-rate'))) {
    base.push(
      'Tune dialogue authorization policy pressure with ' +
      '`node scripts/interactive-dialogue-governance.js --policy docs/interactive-customization/dialogue-governance-policy-baseline.json --authorization-dialogue-policy docs/interactive-customization/authorization-dialogue-policy-baseline.json --json`.'
    );
  }
  if (reasons.some(item => `${item}`.includes('runtime-ui-mode'))) {
    base.push(
      'Regenerate runtime governance evidence with ' +
      '`node scripts/interactive-governance-report.js --period weekly --fail-on-alert --json`.'
    );
    base.push(
      'Review runtime ui-mode contract in `docs/interactive-customization/runtime-mode-policy-baseline.json` ' +
      'to keep `user-app` suggestion-only and route apply actions to `ops-console`.'
    );
  }
  if (reasons.some(item => `${item}`.includes('runtime-block-rate'))) {
    base.push(
      'Reduce runtime deny/review pressure by tuning runtime mode policy and rerunning ' +
      '`node scripts/interactive-governance-report.js --period weekly --json`.'
    );
  }
  if (reasons.some(item => `${item}`.startsWith('handoff-'))) {
    base.push('Review handoff quality with `sce auto handoff evidence --window 5 --json`.');
    base.push(
      'Replay failed handoff goals with ' +
      '`sce auto handoff run --manifest docs/handoffs/handoff-manifest.json --continue-from latest --continue-strategy failed-only --json`.'
    );
  }
  if (reasons.some(item => `${item}`.startsWith('handoff-moqui-matrix-regressions-'))) {
    base.push(
      'Recover Moqui matrix regressions with ' +
      '`sce auto handoff run --manifest docs/handoffs/handoff-manifest.json ' +
      '--dry-run --max-moqui-matrix-regressions 0 --json`.'
    );
    base.push(
      'Inspect Moqui matrix drift with ' +
      '`sce scene moqui-baseline --include-all ' +
      '--compare-with .sce/reports/release-evidence/moqui-template-baseline.json --json`.'
    );
    base.push(...buildMoquiRegressionRecoverySequenceLines({
      wrapCommands: true,
      withPeriod: true
    }));
  }
  if (reasons.some(item => `${item}`.startsWith('handoff-capability-') && `${item}`.includes('unknown'))) {
    base.push(
      'Normalize capability lexicon gaps with ' +
      '`node scripts/moqui-lexicon-audit.js --manifest docs/handoffs/handoff-manifest.json ' +
      '--template-dir .sce/templates/scene-packages --fail-on-gap --json`.'
    );
    base.push(
      'Re-run strict handoff gates after lexicon normalization with ' +
      '`sce auto handoff run --manifest docs/handoffs/handoff-manifest.json --dry-run --json`.'
    );
  }
  return Array.from(new Set(base));
}

function extractGovernanceReleaseGateSnapshot(assessment) {
  const releaseGate = assessment && assessment.health && assessment.health.release_gate &&
    typeof assessment.health.release_gate === 'object'
    ? assessment.health.release_gate
    : null;
  if (!releaseGate) {
    return null;
  }
  return {
    ...releaseGate
  };
}

function extractGovernanceWeeklyOpsStopDetail(releaseGateCandidate) {
  const releaseGate = releaseGateCandidate && typeof releaseGateCandidate === 'object' && !Array.isArray(releaseGateCandidate)
    ? releaseGateCandidate
    : null;
  if (!releaseGate) {
    return null;
  }

  const latestRiskLevelRaw = normalizeHandoffText(releaseGate.latest_weekly_ops_risk_level);
  const latestRiskLevel = latestRiskLevelRaw
    ? normalizeAutoHandoffGateRiskLevel(latestRiskLevelRaw)
    : null;
  const latestGovernanceStatus = normalizeHandoffText(releaseGate.latest_weekly_ops_governance_status);
  const latestBlocked = parseAutoHandoffGateBoolean(releaseGate.latest_weekly_ops_blocked, null);
  const latestAuthorizationTierBlockRatePercent = toGovernanceReleaseGateNumber(
    releaseGate.latest_weekly_ops_authorization_tier_block_rate_percent
  );
  const latestDialogueAuthorizationBlockRatePercent = toGovernanceReleaseGateNumber(
    releaseGate.latest_weekly_ops_dialogue_authorization_block_rate_percent
  );
  const latestConfigWarningCount = toGovernanceReleaseGateNumber(
    releaseGate.latest_weekly_ops_config_warning_count
  );
  const latestRuntimeBlockRatePercent = toGovernanceReleaseGateNumber(
    releaseGate.latest_weekly_ops_runtime_block_rate_percent
  );
  const latestRuntimeUiModeViolationTotal = toGovernanceReleaseGateNumber(
    releaseGate.latest_weekly_ops_runtime_ui_mode_violation_total
  );
  const latestRuntimeUiModeViolationRatePercent = toGovernanceReleaseGateNumber(
    releaseGate.latest_weekly_ops_runtime_ui_mode_violation_rate_percent
  );
  const blockedRuns = toGovernanceReleaseGateNumber(releaseGate.weekly_ops_blocked_runs);
  const blockRatePercent = toGovernanceReleaseGateNumber(releaseGate.weekly_ops_block_rate_percent);
  const violationsTotal = toGovernanceReleaseGateNumber(releaseGate.weekly_ops_violations_total);
  const warningsTotal = toGovernanceReleaseGateNumber(releaseGate.weekly_ops_warnings_total);
  const configWarningsTotal = toGovernanceReleaseGateNumber(releaseGate.weekly_ops_config_warnings_total);
  const authorizationTierBlockRateMaxPercent = toGovernanceReleaseGateNumber(
    releaseGate.weekly_ops_authorization_tier_block_rate_max_percent
  );
  const dialogueAuthorizationBlockRateMaxPercent = toGovernanceReleaseGateNumber(
    releaseGate.weekly_ops_dialogue_authorization_block_rate_max_percent
  );
  const runtimeBlockRateMaxPercent = toGovernanceReleaseGateNumber(
    releaseGate.weekly_ops_runtime_block_rate_max_percent
  );
  const runtimeUiModeViolationTotal = toGovernanceReleaseGateNumber(
    releaseGate.weekly_ops_runtime_ui_mode_violation_total
  );
  const runtimeUiModeViolationRunRatePercent = toGovernanceReleaseGateNumber(
    releaseGate.weekly_ops_runtime_ui_mode_violation_run_rate_percent
  );
  const runtimeUiModeViolationRateMaxPercent = toGovernanceReleaseGateNumber(
    releaseGate.weekly_ops_runtime_ui_mode_violation_rate_max_percent
  );

  const hasSignal = (
    typeof latestBlocked === 'boolean' ||
    !!latestRiskLevel ||
    !!latestGovernanceStatus ||
    Number.isFinite(latestAuthorizationTierBlockRatePercent) ||
    Number.isFinite(latestDialogueAuthorizationBlockRatePercent) ||
    Number.isFinite(latestConfigWarningCount) ||
    Number.isFinite(latestRuntimeBlockRatePercent) ||
    Number.isFinite(latestRuntimeUiModeViolationTotal) ||
    Number.isFinite(latestRuntimeUiModeViolationRatePercent) ||
    Number.isFinite(blockedRuns) ||
    Number.isFinite(blockRatePercent) ||
    Number.isFinite(violationsTotal) ||
    Number.isFinite(warningsTotal) ||
    Number.isFinite(configWarningsTotal) ||
    Number.isFinite(authorizationTierBlockRateMaxPercent) ||
    Number.isFinite(dialogueAuthorizationBlockRateMaxPercent) ||
    Number.isFinite(runtimeBlockRateMaxPercent) ||
    Number.isFinite(runtimeUiModeViolationTotal) ||
    Number.isFinite(runtimeUiModeViolationRunRatePercent) ||
    Number.isFinite(runtimeUiModeViolationRateMaxPercent)
  );
  if (!hasSignal) {
    return null;
  }

  const latestAuthTierPressureRate = Number.isFinite(latestAuthorizationTierBlockRatePercent)
    ? latestAuthorizationTierBlockRatePercent
    : authorizationTierBlockRateMaxPercent;
  const latestDialoguePressureRate = Number.isFinite(latestDialogueAuthorizationBlockRatePercent)
    ? latestDialogueAuthorizationBlockRatePercent
    : dialogueAuthorizationBlockRateMaxPercent;
  const highPressure = (
    latestBlocked === true ||
    latestRiskLevel === 'high' ||
    (Number.isFinite(blockedRuns) && blockedRuns > 0) ||
    (Number.isFinite(blockRatePercent) && blockRatePercent >= 40) ||
    (Number.isFinite(latestAuthTierPressureRate) && latestAuthTierPressureRate >= 60) ||
    (Number.isFinite(latestDialoguePressureRate) && latestDialoguePressureRate >= 60) ||
    (Number.isFinite(latestRuntimeUiModeViolationTotal) && latestRuntimeUiModeViolationTotal > 0) ||
    (Number.isFinite(runtimeUiModeViolationTotal) && runtimeUiModeViolationTotal > 0) ||
    (Number.isFinite(latestRuntimeUiModeViolationRatePercent) && latestRuntimeUiModeViolationRatePercent > 0) ||
    (Number.isFinite(runtimeUiModeViolationRunRatePercent) && runtimeUiModeViolationRunRatePercent > 0) ||
    (Number.isFinite(runtimeUiModeViolationRateMaxPercent) && runtimeUiModeViolationRateMaxPercent > 0) ||
    (Number.isFinite(latestRuntimeBlockRatePercent) && latestRuntimeBlockRatePercent >= 40) ||
    (Number.isFinite(runtimeBlockRateMaxPercent) && runtimeBlockRateMaxPercent >= 40)
  );

  return {
    latest: {
      blocked: latestBlocked,
      risk_level: latestRiskLevel,
      governance_status: latestGovernanceStatus || null,
      authorization_tier_block_rate_percent: latestAuthorizationTierBlockRatePercent,
      dialogue_authorization_block_rate_percent: latestDialogueAuthorizationBlockRatePercent,
      config_warning_count: latestConfigWarningCount,
      runtime_block_rate_percent: latestRuntimeBlockRatePercent,
      runtime_ui_mode_violation_total: latestRuntimeUiModeViolationTotal,
      runtime_ui_mode_violation_rate_percent: latestRuntimeUiModeViolationRatePercent
    },
    aggregates: {
      blocked_runs: blockedRuns,
      block_rate_percent: blockRatePercent,
      violations_total: violationsTotal,
      warnings_total: warningsTotal,
      config_warnings_total: configWarningsTotal,
      authorization_tier_block_rate_max_percent: authorizationTierBlockRateMaxPercent,
      dialogue_authorization_block_rate_max_percent: dialogueAuthorizationBlockRateMaxPercent,
      runtime_block_rate_max_percent: runtimeBlockRateMaxPercent,
      runtime_ui_mode_violation_total: runtimeUiModeViolationTotal,
      runtime_ui_mode_violation_run_rate_percent: runtimeUiModeViolationRunRatePercent,
      runtime_ui_mode_violation_rate_max_percent: runtimeUiModeViolationRateMaxPercent
    },
    pressure: {
      blocked: latestBlocked === true || (Number.isFinite(blockedRuns) && blockedRuns > 0),
      high: highPressure,
      config_warning_positive: (
        (Number.isFinite(latestConfigWarningCount) && latestConfigWarningCount > 0) ||
        (Number.isFinite(configWarningsTotal) && configWarningsTotal > 0)
      ),
      auth_tier_block_rate_high: Number.isFinite(latestAuthTierPressureRate) && latestAuthTierPressureRate > 40,
      dialogue_authorization_block_rate_high: (
        Number.isFinite(latestDialoguePressureRate) && latestDialoguePressureRate > 40
      ),
      runtime_block_rate_high: (
        (Number.isFinite(latestRuntimeBlockRatePercent) && latestRuntimeBlockRatePercent > 40) ||
        (Number.isFinite(runtimeBlockRateMaxPercent) && runtimeBlockRateMaxPercent > 40)
      ),
      runtime_ui_mode_violation_high: (
        (Number.isFinite(latestRuntimeUiModeViolationTotal) && latestRuntimeUiModeViolationTotal > 0) ||
        (Number.isFinite(runtimeUiModeViolationTotal) && runtimeUiModeViolationTotal > 0) ||
        (Number.isFinite(latestRuntimeUiModeViolationRatePercent) && latestRuntimeUiModeViolationRatePercent > 0) ||
        (Number.isFinite(runtimeUiModeViolationRunRatePercent) && runtimeUiModeViolationRunRatePercent > 0) ||
        (Number.isFinite(runtimeUiModeViolationRateMaxPercent) && runtimeUiModeViolationRateMaxPercent > 0)
      )
    }
  };
}

async function runAutoGovernanceCloseLoop(projectPath, options = {}) {
  return runAutoGovernanceCloseLoopService(projectPath, options, {
    loadGovernanceCloseLoopSessionPayload,
    isExplicitOptionSource,
    normalizeStatsWindowDays,
    normalizeStatusFilter,
    normalizeGovernanceMaxRounds,
    normalizeGovernanceTargetRiskLevel,
    normalizeGovernanceAdvisoryRecoverMaxRounds,
    normalizeGovernanceAdvisoryControllerMaxCycles,
    normalizeGovernanceSessionKeep,
    normalizeGovernanceSessionOlderThanDays,
    sanitizeBatchSessionId,
    createGovernanceCloseLoopSessionId,
    buildAutoGovernanceStats,
    runAutoGovernanceMaintenance,
    executeGovernanceAdvisoryRecover,
    executeGovernanceAdvisoryControllerResume,
    evaluateGovernanceReleaseGateBlockState,
    extractGovernanceWeeklyOpsStopDetail,
    compareRiskLevel,
    buildGovernanceCloseLoopRecommendations,
    persistGovernanceCloseLoopSession,
    resolveGovernanceCloseLoopRunStatus,
    pruneGovernanceCloseLoopSessions,
    getGovernanceCloseLoopSessionDir,
    extractGovernanceReleaseGateSnapshot
  });
}

async function pruneCloseLoopBatchSummarySessionsCli(projectPath, options = {}) {
  const keep = normalizeKeep(options.keep);
  const olderThanDays = normalizeOlderThanDays(options.olderThanDays);
  const dryRun = Boolean(options.dryRun);
  const result = await pruneCloseLoopBatchSummarySessions(projectPath, {
    keep,
    olderThanDays,
    currentFile: null,
    dryRun
  });

  return {
    mode: 'auto-batch-session-prune',
    ...result
  };
}

async function pruneCloseLoopControllerSessionsCli(projectPath, options = {}) {
  const keep = normalizeKeep(options.keep);
  const olderThanDays = normalizeOlderThanDays(options.olderThanDays);
  const dryRun = Boolean(options.dryRun);
  const result = await pruneCloseLoopControllerSessions(projectPath, {
    keep,
    olderThanDays,
    currentFile: null,
    dryRun
  });

  return {
    mode: 'auto-controller-session-prune',
    ...result
  };
}

async function pruneCloseLoopSessions(projectPath, options = {}) {
  const keep = normalizeKeep(options.keep);
  const olderThanDays = normalizeOlderThanDays(options.olderThanDays);
  const dryRun = Boolean(options.dryRun);
  const sessions = await readCloseLoopSessionEntries(projectPath);
  const cutoffMs = olderThanDays === null
    ? null
    : Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);

  const keepSet = new Set(
    sessions.slice(0, keep).map(session => session.file)
  );
  const deletable = sessions.filter(session => {
    if (keepSet.has(session.file)) {
      return false;
    }
    if (cutoffMs === null) {
      return true;
    }
    return session.mtime_ms < cutoffMs;
  });

  const deleted = [];
  const errors = [];
  if (!dryRun) {
    for (const session of deletable) {
      try {
        await fs.remove(session.file);
        deleted.push(session);
      } catch (error) {
        errors.push({
          id: session.id,
          file: session.file,
          error: error.message
        });
      }
    }
  }

  return {
    mode: 'auto-session-prune',
    session_dir: getCloseLoopSessionDir(projectPath),
    dry_run: dryRun,
    criteria: {
      keep,
      older_than_days: olderThanDays
    },
    total_sessions: sessions.length,
    kept_sessions: sessions.length - deletable.length,
    deleted_count: dryRun ? deletable.length : deleted.length,
    candidates: deletable.map(item => ({
      id: item.id,
      file: item.file,
      status: item.status,
      updated_at: item.updated_at
    })),
    errors
  };
}

module.exports = {
  registerAutoCommands,
  listCloseLoopSessions,
  pruneCloseLoopSessions,
  listCloseLoopBatchSummarySessions,
  pruneCloseLoopBatchSummarySessionsCli,
  loadCloseLoopBatchGoals,
  loadCloseLoopBatchGoalsFromSummary
};




