const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { runCliWithRetry } = require('./cli-runner');

function runCli(args, options = {}) {
  return runCliWithRetry(args, {
    cwd: options.cwd || process.cwd(),
    timeoutMs: options.timeoutMs || 60000,
    nodeArgs: Array.isArray(options.nodeArgs) ? options.nodeArgs : [],
    env: options.env,
    maxTransientRetries: options.maxTransientRetries || 1
  });
}

function parseJsonOutput(stdout) {
  return JSON.parse((stdout || '').trim());
}

describe('auto close-loop CLI integration', () => {
  let tempDir;
  let originalCwd;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-auto-close-loop-cli-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.remove(tempDir);
  });

  test('supports close-loop no-run and resume latest end-to-end', async () => {
    const firstRun = await runCli([
      'auto',
      'close-loop',
      'build autonomous close loop resume e2e',
      '--no-run',
      '--json'
    ], { cwd: tempDir });

    expect(firstRun.exitCode).toBe(0);
    const firstPayload = parseJsonOutput(firstRun.stdout);
    expect(firstPayload.mode).toBe('auto-close-loop');
    expect(firstPayload.resumed).toBe(false);
    expect(firstPayload.session).toBeDefined();
    expect(await fs.pathExists(firstPayload.session.file)).toBe(true);

    const resumedRun = await runCli([
      'auto',
      'close-loop',
      '--resume',
      'latest',
      '--no-run',
      '--json'
    ], { cwd: tempDir });

    expect(resumedRun.exitCode).toBe(0);
    const resumedPayload = parseJsonOutput(resumedRun.stdout);
    expect(resumedPayload.resumed).toBe(true);
    expect(resumedPayload.resumed_from_session.id).toBe(firstPayload.session.id);
    expect(resumedPayload.portfolio.master_spec).toBe(firstPayload.portfolio.master_spec);
  });

  test('supports session list and prune lifecycle through CLI', async () => {
    const firstRun = await runCli([
      'auto',
      'close-loop',
      'build autonomous close loop session lifecycle one',
      '--no-run',
      '--json'
    ], { cwd: tempDir });
    expect(firstRun.exitCode).toBe(0);

    await new Promise(resolve => setTimeout(resolve, 20));

    const secondRun = await runCli([
      'auto',
      'close-loop',
      'build autonomous close loop session lifecycle two',
      '--no-run',
      '--json'
    ], { cwd: tempDir });
    expect(secondRun.exitCode).toBe(0);

    const listed = await runCli([
      'auto',
      'session',
      'list',
      '--limit',
      '1',
      '--json'
    ], { cwd: tempDir });
    expect(listed.exitCode).toBe(0);
    const listPayload = parseJsonOutput(listed.stdout);
    expect(listPayload.mode).toBe('auto-session-list');
    expect(listPayload.total).toBe(2);
    expect(listPayload.sessions).toHaveLength(1);

    const stats = await runCli([
      'auto',
      'session',
      'stats',
      '--json'
    ], { cwd: tempDir });
    expect(stats.exitCode).toBe(0);
    const statsPayload = parseJsonOutput(stats.stdout);
    expect(statsPayload.mode).toBe('auto-session-stats');
    expect(statsPayload.total_sessions).toBe(2);
    expect(statsPayload.latest_sessions).toHaveLength(2);

    const pruned = await runCli([
      'auto',
      'session',
      'prune',
      '--keep',
      '1',
      '--json'
    ], { cwd: tempDir });
    expect(pruned.exitCode).toBe(0);
    const prunePayload = parseJsonOutput(pruned.stdout);
    expect(prunePayload.mode).toBe('auto-session-prune');
    expect(prunePayload.deleted_count).toBe(1);
    expect(prunePayload.errors).toEqual([]);

    const listedAfter = await runCli([
      'auto',
      'session',
      'list',
      '--json'
    ], { cwd: tempDir });
    expect(listedAfter.exitCode).toBe(0);
    const listAfterPayload = parseJsonOutput(listedAfter.stdout);
    expect(listAfterPayload.total).toBe(1);
  });

  test('supports automatic session retention policy in close-loop CLI', async () => {
    const firstRun = await runCli([
      'auto',
      'close-loop',
      'build autonomous close loop auto retention one',
      '--no-run',
      '--json'
    ], { cwd: tempDir });
    expect(firstRun.exitCode).toBe(0);

    await new Promise(resolve => setTimeout(resolve, 20));

    const secondRun = await runCli([
      'auto',
      'close-loop',
      'build autonomous close loop auto retention two',
      '--no-run',
      '--session-keep',
      '1',
      '--json'
    ], { cwd: tempDir });
    expect(secondRun.exitCode).toBe(0);

    const secondPayload = parseJsonOutput(secondRun.stdout);
    expect(secondPayload.session_prune).toEqual(expect.objectContaining({
      enabled: true,
      keep: 1
    }));

    const listed = await runCli([
      'auto',
      'session',
      'list',
      '--json'
    ], { cwd: tempDir });
    expect(listed.exitCode).toBe(0);
    const listPayload = parseJsonOutput(listed.stdout);
    expect(listPayload.total).toBe(1);
  });

  test('supports spec-session list and prune lifecycle through CLI', async () => {
    const specsDir = path.join(tempDir, '.sce', 'specs');
    const oldSpec = path.join(specsDir, '121-00-old');
    const newSpec = path.join(specsDir, '122-00-new');
    await fs.ensureDir(oldSpec);
    await fs.ensureDir(newSpec);
    await fs.utimes(oldSpec, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));
    await fs.utimes(newSpec, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));

    const listed = await runCli([
      'auto',
      'spec-session',
      'list',
      '--limit',
      '1',
      '--json'
    ], { cwd: tempDir });
    expect(listed.exitCode).toBe(0);
    const listPayload = parseJsonOutput(listed.stdout);
    expect(listPayload.mode).toBe('auto-spec-session-list');
    expect(listPayload.total).toBe(2);
    expect(listPayload.specs).toHaveLength(1);
    expect(listPayload.specs[0].id).toBe('122-00-new');

    const pruned = await runCli([
      'auto',
      'spec-session',
      'prune',
      '--keep',
      '1',
      '--json'
    ], { cwd: tempDir });
    expect(pruned.exitCode).toBe(0);
    const prunePayload = parseJsonOutput(pruned.stdout);
    expect(prunePayload.mode).toBe('auto-spec-session-prune');
    expect(prunePayload.deleted_count).toBe(1);
    expect(prunePayload.errors).toEqual([]);
    expect(await fs.pathExists(newSpec)).toBe(true);
    expect(await fs.pathExists(oldSpec)).toBe(false);
  });

  test('exposes protection reason details for spec-session prune through CLI', async () => {
    const specsDir = path.join(tempDir, '.sce', 'specs');
    const activeSpec = path.join(specsDir, '121-00-active');
    const staleSpec = path.join(specsDir, '121-01-stale');
    await fs.ensureDir(activeSpec);
    await fs.ensureDir(staleSpec);
    await fs.writeJson(path.join(activeSpec, 'collaboration.json'), {
      status: 'in-progress'
    }, { spaces: 2 });
    await fs.utimes(activeSpec, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));
    await fs.utimes(staleSpec, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));

    const pruned = await runCli([
      'auto',
      'spec-session',
      'prune',
      '--keep',
      '0',
      '--older-than-days',
      '1',
      '--show-protection-reasons',
      '--json'
    ], { cwd: tempDir });
    expect(pruned.exitCode).toBe(0);
    const prunePayload = parseJsonOutput(pruned.stdout);
    expect(prunePayload.protection_ranking_top).toEqual(expect.arrayContaining([
      expect.objectContaining({
        spec: '121-00-active',
        total_references: 1
      })
    ]));
    expect(prunePayload.protected_specs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: '121-00-active',
        reasons: expect.objectContaining({
          collaboration_active: 1
        })
      })
    ]));
    expect(await fs.pathExists(activeSpec)).toBe(true);
    expect(await fs.pathExists(staleSpec)).toBe(false);
  });

  test('protects controller-referenced specs in spec-session prune through CLI', async () => {
    const specsDir = path.join(tempDir, '.sce', 'specs');
    const activeSpec = path.join(specsDir, '121-00-controller-active');
    const staleSpec = path.join(specsDir, '121-01-stale');
    await fs.ensureDir(activeSpec);
    await fs.ensureDir(staleSpec);
    await fs.utimes(activeSpec, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));
    await fs.utimes(staleSpec, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));

    const batchSessionDir = path.join(tempDir, '.sce', 'auto', 'close-loop-batch-summaries');
    await fs.ensureDir(batchSessionDir);
    const nestedBatchSummary = path.join(batchSessionDir, 'controller-protected-summary.json');
    await fs.writeJson(nestedBatchSummary, {
      mode: 'auto-close-loop-program',
      status: 'partial-failed',
      results: [
        {
          index: 1,
          goal: 'controller derived goal',
          status: 'failed',
          master_spec: '121-00-controller-active'
        }
      ]
    }, { spaces: 2 });

    const controllerSessionDir = path.join(tempDir, '.sce', 'auto', 'close-loop-controller-sessions');
    await fs.ensureDir(controllerSessionDir);
    const controllerSessionFile = path.join(controllerSessionDir, 'controller-protected-session.json');
    await fs.writeJson(controllerSessionFile, {
      mode: 'auto-close-loop-controller',
      status: 'partial-failed',
      results: [
        {
          goal: 'controller goal',
          status: 'failed',
          batch_session_file: nestedBatchSummary
        }
      ],
      controller_session: {
        id: 'controller-protected-session',
        file: controllerSessionFile
      }
    }, { spaces: 2 });

    const pruned = await runCli([
      'auto',
      'spec-session',
      'prune',
      '--keep',
      '0',
      '--older-than-days',
      '1',
      '--show-protection-reasons',
      '--json'
    ], { cwd: tempDir });
    expect(pruned.exitCode).toBe(0);
    const prunePayload = parseJsonOutput(pruned.stdout);
    expect(prunePayload.protected_specs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: '121-00-controller-active',
        reasons: expect.objectContaining({
          controller_session_recent_or_incomplete: 1
        })
      })
    ]));
    expect(await fs.pathExists(activeSpec)).toBe(true);
    expect(await fs.pathExists(staleSpec)).toBe(false);
  });

  test('applies automatic spec-session retention policy in close-loop-batch CLI', async () => {
    const specsDir = path.join(tempDir, '.sce', 'specs');
    const oldSpec = path.join(specsDir, '121-00-old');
    const newSpec = path.join(specsDir, '122-00-new');
    await fs.ensureDir(oldSpec);
    await fs.ensureDir(newSpec);
    await fs.utimes(oldSpec, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));
    await fs.utimes(newSpec, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));

    const goalsPath = path.join(tempDir, 'batch-goals.json');
    await fs.writeJson(goalsPath, {
      goals: ['retention policy goal']
    }, { spaces: 2 });

    const run = await runCli([
      'auto',
      'close-loop-batch',
      goalsPath,
      '--dry-run',
      '--spec-session-keep',
      '1',
      '--spec-session-older-than-days',
      '1',
      '--spec-session-protect-window-days',
      '0',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.spec_session_prune).toEqual(expect.objectContaining({
      mode: 'auto-spec-session-prune',
      deleted_count: 1,
      protect_active: true,
      protect_window_days: 0
    }));
    expect(await fs.pathExists(newSpec)).toBe(true);
    expect(await fs.pathExists(oldSpec)).toBe(false);
  });

  test('fails close-loop-batch when spec-session budget hard-fail threshold is exceeded', async () => {
    const specsDir = path.join(tempDir, '.sce', 'specs');
    await fs.ensureDir(path.join(specsDir, '121-00-existing-a'));
    await fs.ensureDir(path.join(specsDir, '121-01-existing-b'));

    const goalsPath = path.join(tempDir, 'batch-goals.json');
    await fs.writeJson(goalsPath, {
      goals: ['budget guard goal']
    }, { spaces: 2 });

    const run = await runCli([
      'auto',
      'close-loop-batch',
      goalsPath,
      '--dry-run',
      '--spec-session-max-total',
      '1',
      '--spec-session-budget-hard-fail',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(1);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('Spec session budget exceeded before run');
  });

  test('auto-scales to five sub-specs for highly complex goals in dry-run mode', async () => {
    const complexGoal = [
      'sce should deliver closed-loop automation and master/sub decomposition,',
      'parallel orchestration runtime and scheduler resilience,',
      'quality gate with observability KPI plus test evidence,',
      'and documentation rollout with migration and operator enablement.'
    ].join(' ');

    const run = await runCli([
      'auto',
      'close-loop',
      complexGoal,
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.status).toBe('planned');
    expect(payload.portfolio.sub_specs).toHaveLength(5);
    expect(payload.strategy.subSpecCount).toBe(5);
  });

  test('supports close-loop-batch in dry-run mode through CLI', async () => {
    const goalsPath = path.join(tempDir, 'batch-goals.json');
    await fs.writeJson(goalsPath, {
      goals: [
        'deliver autonomous close-loop for scenario one',
        'deliver autonomous close-loop for scenario two'
      ]
    }, { spaces: 2 });

    const run = await runCli([
      'auto',
      'close-loop-batch',
      goalsPath,
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.mode).toBe('auto-close-loop-batch');
    expect(payload.status).toBe('completed');
    expect(payload.total_goals).toBe(2);
    expect(payload.processed_goals).toBe(2);
    expect(payload.batch_parallel).toBe(2);
    expect(payload.results).toHaveLength(2);
    expect(payload.results[0]).toEqual(expect.objectContaining({
      index: 1,
      status: 'planned'
    }));
    expect(payload.results[1]).toEqual(expect.objectContaining({
      index: 2,
      status: 'planned'
    }));
  });

  test('supports close-loop-batch goal decomposition from one broad goal through CLI', async () => {
    const run = await runCli([
      'auto',
      'close-loop-batch',
      '--decompose-goal',
      'sce should deliver autonomous close-loop progression, master/sub decomposition, parallel orchestration, quality gate and observability rollout',
      '--program-goals',
      '3',
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.mode).toBe('auto-close-loop-batch');
    expect(payload.status).toBe('completed');
    expect(payload.total_goals).toBe(3);
    expect(payload.generated_from_goal).toEqual(expect.objectContaining({
      strategy: 'semantic-clause-and-category',
      target_goal_count: 3,
      produced_goal_count: 3
    }));
    expect(payload.results).toHaveLength(3);
  });

  test('supports close-loop-program autonomous execution through CLI', async () => {
    const run = await runCli([
      'auto',
      'close-loop-program',
      'sce should deliver autonomous close-loop progression, master/sub decomposition, parallel orchestration, quality gate and observability rollout',
      '--program-goals',
      '3',
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.mode).toBe('auto-close-loop-program');
    expect(payload.status).toBe('completed');
    expect(payload.total_goals).toBe(3);
    expect(payload.generated_from_goal).toEqual(expect.objectContaining({
      strategy: 'semantic-clause-and-category',
      target_goal_count: 3,
      produced_goal_count: 3
    }));
    expect(payload.autonomous_policy).toEqual(expect.objectContaining({
      enabled: true,
      profile: 'closed-loop'
    }));
    expect(payload.batch_retry).toEqual(expect.objectContaining({
      until_complete: true,
      max_rounds: 10
    }));
    expect(payload.program_kpi).toEqual(expect.objectContaining({
      convergence_state: 'converged',
      risk_level: 'low'
    }));
    expect(payload.program_diagnostics).toEqual(expect.objectContaining({
      failed_goal_count: 0
    }));
    expect(payload.program_coordination).toEqual(expect.objectContaining({
      topology: 'master-sub'
    }));
    expect(payload.auto_recovery).toEqual(expect.objectContaining({
      enabled: true,
      triggered: false,
      converged: true
    }));
    expect(payload.program_gate).toEqual(expect.objectContaining({
      passed: true
    }));
  });

  test('supports close-loop-program gate profile policy through CLI', async () => {
    const run = await runCli([
      'auto',
      'close-loop-program',
      'sce should deliver autonomous close-loop progression, master/sub decomposition and quality rollout',
      '--program-goals',
      '2',
      '--program-gate-profile',
      'staging',
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.program_gate).toEqual(expect.objectContaining({
      passed: true,
      policy: expect.objectContaining({
        profile: 'staging',
        max_risk_level: 'medium'
      })
    }));
  });

  test('fails close-loop-program gate on strict agent budget policy through CLI', async () => {
    const run = await runCli([
      'auto',
      'close-loop-program',
      'sce should deliver autonomous close-loop progression, master/sub decomposition and quality rollout',
      '--program-goals',
      '2',
      '--batch-agent-budget',
      '4',
      '--program-max-agent-budget',
      '2',
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(1);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.program_gate).toEqual(expect.objectContaining({
      passed: false,
      policy: expect.objectContaining({
        max_agent_budget: 2
      }),
      actual: expect.objectContaining({
        agent_budget: 4
      })
    }));
  });

  test('stabilizes close-loop-program via governance replay loop through CLI', async () => {
    const run = await runCli([
      'auto',
      'close-loop-program',
      'sce should deliver autonomous close-loop progression, master/sub decomposition and quality rollout',
      '--program-goals',
      '2',
      '--batch-agent-budget',
      '4',
      '--program-max-agent-budget',
      '2',
      '--program-govern-until-stable',
      '--program-govern-max-rounds',
      '2',
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.program_gate_effective).toEqual(expect.objectContaining({
      passed: true
    }));
    expect(payload.program_governance).toEqual(expect.objectContaining({
      enabled: true,
      performed_rounds: 1,
      converged: true
    }));
    expect(payload.program_governance.history[0]).toEqual(expect.objectContaining({
      execution_mode: 'program-replay'
    }));
  });

  test('applies governance remediation action selection through recover cycle via CLI', async () => {
    const hookPath = path.join(__dirname, 'fixtures', 'program-gate-fallback-hook.js');
    const run = await runCli([
      'auto',
      'close-loop-program',
      'sce should deliver autonomous close-loop progression, master/sub decomposition and quality rollout',
      '--program-goals',
      '2',
      '--batch-retry-rounds',
      '0',
      '--no-program-auto-recover',
      '--program-govern-until-stable',
      '--program-govern-use-action',
      '1',
      '--program-govern-max-rounds',
      '2',
      '--json'
    ], {
      cwd: tempDir,
      nodeArgs: ['--require', hookPath],
      env: {
        KSE_TEST_MOCK_CLOSE_LOOP_RUNNER: '1'
      }
    });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.program_governance).toEqual(expect.objectContaining({
      enabled: true,
      action_selection_enabled: true,
      pinned_action_index: 1,
      performed_rounds: 1
    }));
    expect(payload.program_governance.history[0]).toEqual(expect.objectContaining({
      execution_mode: 'recover-cycle',
      selected_action_index: 1,
      selected_action: expect.stringContaining('Resume unresolved goals'),
      applied_patch: expect.objectContaining({
        batchRetryUntilComplete: true
      })
    }));
  });

  test('drains close-loop-controller queue through CLI in one cycle by default', async () => {
    const queueFile = path.join(tempDir, 'controller-goals.lines');
    await fs.writeFile(queueFile, [
      'deliver autonomous controller goal one',
      'deliver autonomous controller goal two'
    ].join('\n'), 'utf8');

    const run = await runCli([
      'auto',
      'close-loop-controller',
      queueFile,
      '--program-goals',
      '2',
      '--max-cycles',
      '1',
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload).toEqual(expect.objectContaining({
      mode: 'auto-close-loop-controller',
      status: 'completed',
      dequeue_limit: 'all',
      processed_goals: 2,
      completed_goals: 2,
      failed_goals: 0,
      pending_goals: 0
    }));

    const queueAfter = await fs.readFile(queueFile, 'utf8');
    expect(queueAfter.trim()).toBe('');
  });

  test('supports close-loop-controller --controller-resume latest through CLI', async () => {
    const queueFile = path.join(tempDir, 'controller-resume-goals.lines');
    await fs.writeFile(queueFile, 'deliver autonomous resumed controller goal\n', 'utf8');
    const controllerSessionDir = path.join(tempDir, '.sce', 'auto', 'close-loop-controller-sessions');
    await fs.ensureDir(controllerSessionDir);
    const controllerSessionFile = path.join(controllerSessionDir, 'controller-resume.json');
    await fs.writeJson(controllerSessionFile, {
      mode: 'auto-close-loop-controller',
      status: 'partial-failed',
      queue_file: queueFile,
      queue_format: 'lines',
      controller_session: {
        id: 'controller-resume',
        file: controllerSessionFile
      },
      updated_at: new Date().toISOString()
    }, { spaces: 2 });

    const run = await runCli([
      'auto',
      'close-loop-controller',
      '--controller-resume',
      'latest',
      '--dequeue-limit',
      '1',
      '--max-cycles',
      '1',
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload).toEqual(expect.objectContaining({
      mode: 'auto-close-loop-controller',
      status: 'completed',
      processed_goals: 1,
      pending_goals: 0
    }));
    expect(payload.resumed_from_controller_session).toEqual(expect.objectContaining({
      id: 'controller-resume'
    }));
  });

  test('supports auto kpi trend controller mode through CLI', async () => {
    const batchSessionDir = path.join(tempDir, '.sce', 'auto', 'close-loop-batch-summaries');
    const controllerSessionDir = path.join(tempDir, '.sce', 'auto', 'close-loop-controller-sessions');
    await fs.ensureDir(batchSessionDir);
    await fs.ensureDir(controllerSessionDir);

    const nestedProgramSummary = path.join(batchSessionDir, 'nested-program-summary.json');
    await fs.writeJson(nestedProgramSummary, {
      mode: 'auto-close-loop-program',
      status: 'completed',
      metrics: {
        total_sub_specs: 4
      },
      spec_session_budget: {
        estimated_created: 2
      }
    }, { spaces: 2 });

    const controllerSummary = path.join(controllerSessionDir, 'controller-kpi-summary.json');
    await fs.writeJson(controllerSummary, {
      mode: 'auto-close-loop-controller',
      status: 'partial-failed',
      updated_at: '2026-02-14T10:00:00.000Z',
      processed_goals: 2,
      completed_goals: 1,
      failed_goals: 1,
      pending_goals: 0,
      results: [
        {
          goal: 'controller-kpi-goal',
          status: 'failed',
          batch_session_file: nestedProgramSummary
        }
      ]
    }, { spaces: 2 });
    await fs.utimes(controllerSummary, new Date('2026-02-14T10:00:00.000Z'), new Date('2026-02-14T10:00:00.000Z'));

    const run = await runCli([
      'auto',
      'kpi',
      'trend',
      '--weeks',
      '52',
      '--mode',
      'controller',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload).toEqual(expect.objectContaining({
      mode: 'auto-kpi-trend',
      mode_filter: 'controller',
      total_runs: 1
    }));
    expect(payload.mode_breakdown).toEqual(expect.objectContaining({
      controller: 1
    }));
    expect(payload.overall).toEqual(expect.objectContaining({
      success_rate_percent: 50,
      average_total_sub_specs: 4,
      average_estimated_spec_created: 2
    }));
  });

  test('supports close-loop-program gate fallback profile through CLI', async () => {
    const run = await runCli([
      'auto',
      'close-loop-program',
      'sce should deliver autonomous close-loop progression, master/sub decomposition and quality rollout',
      '--program-goals',
      '2',
      '--program-gate-profile',
      'prod',
      '--program-gate-fallback-profile',
      'staging',
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.program_gate_effective).toEqual(expect.objectContaining({
      passed: true,
      source: 'primary',
      attempted_fallback_count: 0
    }));
    expect(payload.program_gate_effective.fallback_chain).toEqual(['staging']);
    expect(payload.program_gate_effective.fallback_profile).toBeNull();
  });

  test('supports close-loop-program gate fallback chain through CLI', async () => {
    const run = await runCli([
      'auto',
      'close-loop-program',
      'sce should deliver autonomous close-loop progression, master/sub decomposition and quality rollout',
      '--program-goals',
      '2',
      '--program-gate-profile',
      'prod',
      '--program-gate-fallback-chain',
      'prod,staging',
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.program_gate_effective).toEqual(expect.objectContaining({
      passed: true,
      source: 'primary',
      attempted_fallback_count: 0
    }));
    expect(payload.program_gate_fallbacks).toHaveLength(0);
    expect(payload.program_gate_effective.fallback_chain).toEqual(['prod', 'staging']);
    expect(payload.program_gate_effective.fallback_profile).toBeNull();
  });

  test('supports non-dry-run fallback-chain acceptance when primary gate fails on risk policy', async () => {
    const hookPath = path.join(__dirname, 'fixtures', 'program-gate-fallback-hook.js');
    const run = await runCli([
      'auto',
      'close-loop-program',
      'deliver autonomous close-loop progression, master/sub decomposition and quality rollout',
      '--program-goals',
      '2',
      '--program-gate-profile',
      'prod',
      '--program-gate-fallback-chain',
      'staging',
      '--batch-retry-rounds',
      '1',
      '--json'
    ], {
      cwd: tempDir,
      nodeArgs: ['--require', hookPath],
      env: {
        KSE_TEST_MOCK_CLOSE_LOOP_RUNNER: '1'
      }
    });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.status).toBe('completed');
    expect(payload.batch_retry).toEqual(expect.objectContaining({
      performed_rounds: 1
    }));
    expect(payload.program_kpi).toEqual(expect.objectContaining({
      risk_level: 'medium'
    }));
    expect(payload.program_gate).toEqual(expect.objectContaining({
      passed: false,
      policy: expect.objectContaining({
        profile: 'prod',
        max_risk_level: 'low'
      }),
      actual: expect.objectContaining({
        risk_level: 'medium'
      })
    }));
    expect(payload.program_gate_effective).toEqual(expect.objectContaining({
      passed: true,
      source: 'fallback-chain',
      fallback_profile: 'staging',
      attempted_fallback_count: 1
    }));
  });

  test('writes close-loop-program KPI snapshot file through CLI', async () => {
    const kpiOutPath = path.join(tempDir, 'program-kpi.json');
    const run = await runCli([
      'auto',
      'close-loop-program',
      'sce should deliver autonomous close-loop progression, master/sub decomposition, parallel orchestration and quality gate rollout',
      '--program-goals',
      '2',
      '--program-kpi-out',
      kpiOutPath,
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.program_kpi_file).toBe(kpiOutPath);
    expect(await fs.pathExists(kpiOutPath)).toBe(true);

    const kpiPayload = await fs.readJson(kpiOutPath);
    expect(kpiPayload.mode).toBe('auto-close-loop-program-kpi');
    expect(kpiPayload.program_kpi).toEqual(expect.objectContaining({
      convergence_state: 'converged'
    }));
    expect(kpiPayload.program_diagnostics).toEqual(expect.objectContaining({
      failed_goal_count: 0
    }));
  });

  test('writes close-loop-program audit file through CLI', async () => {
    const auditOutPath = path.join(tempDir, 'program-audit.json');
    const run = await runCli([
      'auto',
      'close-loop-program',
      'sce should deliver autonomous close-loop progression and master/sub orchestration',
      '--program-goals',
      '2',
      '--program-audit-out',
      auditOutPath,
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.program_audit_file).toBe(auditOutPath);
    expect(await fs.pathExists(auditOutPath)).toBe(true);
    const auditPayload = await fs.readJson(auditOutPath);
    expect(auditPayload.mode).toBe('auto-close-loop-program-audit');
    expect(auditPayload.program_coordination).toEqual(expect.objectContaining({
      topology: 'master-sub'
    }));
  });

  test('reports decomposition quality refinement metadata through CLI', async () => {
    const run = await runCli([
      'auto',
      'close-loop-batch',
      '--decompose-goal',
      'orchestration, quality, docs',
      '--program-goals',
      '12',
      '--program-min-quality-score',
      '99',
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.generated_from_goal.quality.refinement).toEqual(expect.objectContaining({
      attempted: true,
      min_score: 99
    }));
  });

  test('fails decomposition quality gate when threshold is enforced through CLI', async () => {
    const run = await runCli([
      'auto',
      'close-loop-batch',
      '--decompose-goal',
      'orchestration, quality, docs',
      '--program-goals',
      '12',
      '--program-min-quality-score',
      '99',
      '--program-quality-gate',
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(1);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('Decomposition quality score');
  });

  test('supports close-loop-recover through CLI with remediation action selection', async () => {
    const summaryPath = path.join(tempDir, 'failed-program-summary.json');
    await fs.writeJson(summaryPath, {
      mode: 'auto-close-loop-program',
      status: 'failed',
      total_goals: 2,
      processed_goals: 2,
      completed_goals: 0,
      failed_goals: 2,
      results: [
        {
          index: 1,
          goal: 'recover goal one',
          status: 'failed',
          error: 'orchestration timeout while waiting for agent response'
        },
        {
          index: 2,
          goal: 'recover goal two',
          status: 'error',
          error: 'agent timed out before completion'
        }
      ]
    }, { spaces: 2 });

    const run = await runCli([
      'auto',
      'close-loop-recover',
      summaryPath,
      '--use-action',
      '2',
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.mode).toBe('auto-close-loop-recover');
    expect(payload.recovered_from_summary).toEqual(expect.objectContaining({
      file: summaryPath,
      selected_action_index: 2
    }));
    expect(payload.recovery_plan).toEqual(expect.objectContaining({
      applied_patch: expect.objectContaining({
        batchParallel: 2,
        batchAgentBudget: 2
      })
    }));
  });

  test('supports close-loop-recover until-complete mode metadata through CLI', async () => {
    const summaryPath = path.join(tempDir, 'failed-program-summary.json');
    await fs.writeJson(summaryPath, {
      mode: 'auto-close-loop-program',
      status: 'failed',
      total_goals: 1,
      processed_goals: 1,
      completed_goals: 0,
      failed_goals: 1,
      results: [
        {
          index: 1,
          goal: 'recover goal one',
          status: 'failed',
          error: 'orchestration timeout while waiting for agent response'
        }
      ]
    }, { spaces: 2 });

    const run = await runCli([
      'auto',
      'close-loop-recover',
      summaryPath,
      '--recover-until-complete',
      '--recover-max-rounds',
      '2',
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.mode).toBe('auto-close-loop-recover');
    expect(payload.recovery_cycle).toEqual(expect.objectContaining({
      enabled: true,
      max_rounds: 2,
      performed_rounds: 1,
      converged: true,
      exhausted: false
    }));
  });

  test('applies program gate budget policy in close-loop-recover through CLI', async () => {
    const summaryPath = path.join(tempDir, 'failed-program-summary.json');
    await fs.writeJson(summaryPath, {
      mode: 'auto-close-loop-program',
      status: 'failed',
      total_goals: 1,
      processed_goals: 1,
      completed_goals: 0,
      failed_goals: 1,
      results: [
        {
          index: 1,
          goal: 'recover goal one',
          status: 'failed',
          error: 'orchestration timeout while waiting for agent response'
        }
      ]
    }, { spaces: 2 });

    const run = await runCli([
      'auto',
      'close-loop-recover',
      summaryPath,
      '--batch-agent-budget',
      '2',
      '--program-max-agent-budget',
      '1',
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(1);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.program_gate).toEqual(expect.objectContaining({
      passed: false,
      policy: expect.objectContaining({
        max_agent_budget: 1
      }),
      actual: expect.objectContaining({
        agent_budget: 2
      })
    }));
  });

  test('supports batch session persistence and --resume-from-summary latest through CLI', async () => {
    const goalsPath = path.join(tempDir, 'batch-goals.json');
    await fs.writeJson(goalsPath, {
      goals: ['latest resume goal one', 'latest resume goal two']
    }, { spaces: 2 });

    const firstRun = await runCli([
      'auto',
      'close-loop-batch',
      goalsPath,
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(firstRun.exitCode).toBe(0);
    const firstPayload = parseJsonOutput(firstRun.stdout);
    expect(firstPayload.batch_session).toBeDefined();
    expect(await fs.pathExists(firstPayload.batch_session.file)).toBe(true);

    const resumedRun = await runCli([
      'auto',
      'close-loop-batch',
      '--resume-from-summary',
      'latest',
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(resumedRun.exitCode).toBe(0);
    const resumedPayload = parseJsonOutput(resumedRun.stdout);
    expect(resumedPayload.resumed_from_summary).toEqual(expect.objectContaining({
      file: firstPayload.batch_session.file
    }));
    expect(resumedPayload.total_goals).toBe(2);
  });

  test('emits batch retry metadata in close-loop-batch CLI summary', async () => {
    const goalsPath = path.join(tempDir, 'batch-goals.json');
    await fs.writeJson(goalsPath, {
      goals: ['retry metadata goal one', 'retry metadata goal two']
    }, { spaces: 2 });

    const run = await runCli([
      'auto',
      'close-loop-batch',
      goalsPath,
      '--dry-run',
      '--batch-retry-rounds',
      '2',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.mode).toBe('auto-close-loop-batch');
    expect(payload.batch_retry).toEqual(expect.objectContaining({
      enabled: true,
      strategy: 'adaptive',
      until_complete: false,
      configured_rounds: 2,
      max_rounds: 2,
      performed_rounds: 0,
      exhausted: false
    }));
  });

  test('supports until-complete retry mode metadata in close-loop-batch CLI summary', async () => {
    const goalsPath = path.join(tempDir, 'batch-goals.json');
    await fs.writeJson(goalsPath, {
      goals: ['until-complete goal one', 'until-complete goal two']
    }, { spaces: 2 });

    const run = await runCli([
      'auto',
      'close-loop-batch',
      goalsPath,
      '--dry-run',
      '--batch-retry-until-complete',
      '--batch-retry-max-rounds',
      '4',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.batch_retry).toEqual(expect.objectContaining({
      enabled: true,
      strategy: 'adaptive',
      until_complete: true,
      configured_rounds: 0,
      max_rounds: 4,
      performed_rounds: 0,
      exhausted: false
    }));
  });

  test('applies autonomous batch policy in close-loop-batch CLI summary by default', async () => {
    const goalsPath = path.join(tempDir, 'batch-goals.json');
    await fs.writeJson(goalsPath, {
      goals: ['autonomous goal one', 'autonomous goal two']
    }, { spaces: 2 });

    const run = await runCli([
      'auto',
      'close-loop-batch',
      goalsPath,
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.mode).toBe('auto-close-loop-batch');
    expect(payload.autonomous_policy).toEqual(expect.objectContaining({
      enabled: true,
      profile: 'closed-loop'
    }));
    expect(payload.batch_parallel).toBe(2);
    expect(payload.resource_plan).toEqual(expect.objectContaining({
      scheduling_strategy: 'complex-first',
      aging_factor: 2
    }));
    expect(payload.batch_retry).toEqual(expect.objectContaining({
      until_complete: true,
      max_rounds: 10
    }));
  });

  test('applies batch agent budget in close-loop-batch CLI', async () => {
    const goalsPath = path.join(tempDir, 'batch-goals.json');
    await fs.writeJson(goalsPath, {
      goals: [
        'budget goal one',
        'budget goal two',
        'budget goal three'
      ]
    }, { spaces: 2 });

    const run = await runCli([
      'auto',
      'close-loop-batch',
      goalsPath,
      '--dry-run',
      '--continue-on-error',
      '--batch-parallel',
      '3',
      '--batch-agent-budget',
      '2',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.mode).toBe('auto-close-loop-batch');
    expect(payload.status).toBe('completed');
    expect(payload.batch_parallel).toBe(2);
    expect(payload.resource_plan).toEqual(expect.objectContaining({
      agent_budget: 2,
      base_goal_parallel: 3,
      effective_goal_parallel: 2,
      per_goal_max_parallel: 1
    }));
  });

  test('exposes batch priority and aging strategy in CLI summary resource plan', async () => {
    const goalsPath = path.join(tempDir, 'batch-goals.json');
    await fs.writeJson(goalsPath, {
      goals: [
        [
          'deliver orchestration integration migration observability and security resilience,',
          'plus quality compliance governance and performance hardening,',
          'with closed-loop remediation and parallel master sub coordination.'
        ].join(' '),
        'simple goal'
      ]
    }, { spaces: 2 });

    const run = await runCli([
      'auto',
      'close-loop-batch',
      goalsPath,
      '--dry-run',
      '--continue-on-error',
      '--batch-priority',
      'complex-first',
      '--batch-aging-factor',
      '4',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.mode).toBe('auto-close-loop-batch');
    expect(payload.resource_plan).toEqual(expect.objectContaining({
      scheduling_strategy: 'complex-first',
      aging_factor: 4
    }));
  });

  test('supports close-loop-batch resume-from-summary through CLI', async () => {
    const goalsPath = path.join(tempDir, 'batch-goals.json');
    const summaryPath = path.join(tempDir, 'batch-old-summary.json');
    await fs.writeJson(goalsPath, {
      goals: [
        'resume goal one',
        'resume goal two',
        'resume goal three'
      ]
    }, { spaces: 2 });
    await fs.writeJson(summaryPath, {
      mode: 'auto-close-loop-batch',
      status: 'failed',
      goals_file: goalsPath,
      total_goals: 3,
      processed_goals: 1,
      stopped_early: true,
      results: [
        {
          index: 1,
          goal: 'resume goal one',
          status: 'failed',
          master_spec: '121-00-resume-one',
          sub_spec_count: 2,
          error: null
        }
      ]
    }, { spaces: 2 });

    const run = await runCli([
      'auto',
      'close-loop-batch',
      '--resume-from-summary',
      summaryPath,
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.mode).toBe('auto-close-loop-batch');
    expect(payload.status).toBe('completed');
    expect(payload.processed_goals).toBe(3);
    expect(payload.total_goals).toBe(3);
    expect(payload.resumed_from_summary).toEqual(expect.objectContaining({
      file: summaryPath,
      strategy: 'pending'
    }));
    expect(payload.results).toHaveLength(3);
    expect(payload.results[0].goal).toBe('resume goal one');
    expect(payload.results[1].goal).toBe('resume goal two');
    expect(payload.results[2].goal).toBe('resume goal three');
  });

  test('supports failed-only resume strategy in close-loop-batch CLI', async () => {
    const goalsPath = path.join(tempDir, 'batch-goals.json');
    const summaryPath = path.join(tempDir, 'batch-old-summary.json');
    await fs.writeJson(goalsPath, {
      goals: [
        'resume goal one',
        'resume goal two',
        'resume goal three'
      ]
    }, { spaces: 2 });
    await fs.writeJson(summaryPath, {
      mode: 'auto-close-loop-batch',
      status: 'failed',
      goals_file: goalsPath,
      total_goals: 3,
      processed_goals: 1,
      stopped_early: true,
      results: [
        {
          index: 1,
          goal: 'resume goal one',
          status: 'failed',
          master_spec: '121-00-resume-one',
          sub_spec_count: 2,
          error: null
        }
      ]
    }, { spaces: 2 });

    const run = await runCli([
      'auto',
      'close-loop-batch',
      '--resume-from-summary',
      summaryPath,
      '--resume-strategy',
      'failed-only',
      '--dry-run',
      '--json'
    ], { cwd: tempDir });

    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.mode).toBe('auto-close-loop-batch');
    expect(payload.status).toBe('completed');
    expect(payload.processed_goals).toBe(1);
    expect(payload.total_goals).toBe(1);
    expect(payload.resumed_from_summary).toEqual(expect.objectContaining({
      file: summaryPath,
      strategy: 'failed-only'
    }));
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].goal).toBe('resume goal one');
  });

  test('aggregates autonomous KPI trend through CLI', async () => {
    const summaryDir = path.join(tempDir, '.sce', 'auto', 'close-loop-batch-summaries');
    await fs.ensureDir(summaryDir);
    const fileA = path.join(summaryDir, 'trend-a.json');
    const fileB = path.join(summaryDir, 'trend-b.json');
    await fs.writeJson(fileA, {
      mode: 'auto-close-loop-program',
      status: 'completed',
      updated_at: '2026-02-14T10:00:00.000Z',
      failed_goals: 0,
      metrics: { success_rate_percent: 100, total_sub_specs: 6 },
      program_kpi: { completion_rate_percent: 100 },
      program_gate_effective: { passed: true },
      spec_session_budget: { estimated_created: 2 }
    }, { spaces: 2 });
    await fs.writeJson(fileB, {
      mode: 'auto-close-loop-recover',
      status: 'partial-failed',
      updated_at: '2026-02-13T10:00:00.000Z',
      failed_goals: 1,
      metrics: { success_rate_percent: 50, total_sub_specs: 2 },
      program_kpi: { completion_rate_percent: 50 },
      program_gate_effective: { passed: false },
      spec_session_budget: { estimated_created: 1 }
    }, { spaces: 2 });
    await fs.utimes(fileA, new Date('2026-02-14T10:00:00.000Z'), new Date('2026-02-14T10:00:00.000Z'));
    await fs.utimes(fileB, new Date('2026-02-13T10:00:00.000Z'), new Date('2026-02-13T10:00:00.000Z'));

    const run = await runCli([
      'auto',
      'kpi',
      'trend',
      '--weeks',
      '52',
      '--json'
    ], { cwd: tempDir });
    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.mode).toBe('auto-kpi-trend');
    expect(payload.total_runs).toBe(2);
    expect(payload.overall).toEqual(expect.objectContaining({
      runs: 2,
      success_rate_percent: 75
    }));
    expect(payload.period_unit).toBe('week');
    expect(Array.isArray(payload.anomalies)).toBe(true);
  });

  test('supports daily KPI trend csv output through CLI', async () => {
    const summaryDir = path.join(tempDir, '.sce', 'auto', 'close-loop-batch-summaries');
    await fs.ensureDir(summaryDir);
    const outputPath = path.join(tempDir, 'kpi-trend.csv');
    const fileA = path.join(summaryDir, 'trend-day-a.json');
    const fileB = path.join(summaryDir, 'trend-day-b.json');
    await fs.writeJson(fileA, {
      mode: 'auto-close-loop-program',
      status: 'completed',
      updated_at: '2026-02-12T10:00:00.000Z',
      failed_goals: 0,
      metrics: { success_rate_percent: 100, total_sub_specs: 6 },
      program_kpi: { completion_rate_percent: 100 },
      program_gate_effective: { passed: true },
      spec_session_budget: { estimated_created: 2 }
    }, { spaces: 2 });
    await fs.writeJson(fileB, {
      mode: 'auto-close-loop-recover',
      status: 'partial-failed',
      updated_at: '2026-02-13T10:00:00.000Z',
      failed_goals: 2,
      metrics: { success_rate_percent: 40, total_sub_specs: 3 },
      program_kpi: { completion_rate_percent: 40 },
      program_gate_effective: { passed: false },
      spec_session_budget: { estimated_created: 5 }
    }, { spaces: 2 });
    await fs.utimes(fileA, new Date('2026-02-12T10:00:00.000Z'), new Date('2026-02-12T10:00:00.000Z'));
    await fs.utimes(fileB, new Date('2026-02-13T10:00:00.000Z'), new Date('2026-02-13T10:00:00.000Z'));

    const run = await runCli([
      'auto',
      'kpi',
      'trend',
      '--weeks',
      '52',
      '--period',
      'day',
      '--csv',
      '--out',
      outputPath
    ], { cwd: tempDir });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('period,runs,completed_runs');
    expect(run.stdout).toContain('overall');
    expect(await fs.pathExists(outputPath)).toBe(true);
    const outputFile = await fs.readFile(outputPath, 'utf8');
    expect(outputFile).toContain('period,runs,completed_runs');
    expect(outputFile).toContain('overall');
  });

  test('supports batch-session list and prune lifecycle through CLI', async () => {
    const goalsPath = path.join(tempDir, 'batch-goals.json');
    await fs.writeJson(goalsPath, {
      goals: ['batch session lifecycle one']
    }, { spaces: 2 });

    const firstRun = await runCli([
      'auto',
      'close-loop-batch',
      goalsPath,
      '--dry-run',
      '--json'
    ], { cwd: tempDir });
    expect(firstRun.exitCode).toBe(0);

    await new Promise(resolve => setTimeout(resolve, 20));

    await fs.writeJson(goalsPath, {
      goals: ['batch session lifecycle two']
    }, { spaces: 2 });
    const secondRun = await runCli([
      'auto',
      'close-loop-batch',
      goalsPath,
      '--dry-run',
      '--json'
    ], { cwd: tempDir });
    expect(secondRun.exitCode).toBe(0);

    const listed = await runCli([
      'auto',
      'batch-session',
      'list',
      '--limit',
      '1',
      '--json'
    ], { cwd: tempDir });
    expect(listed.exitCode).toBe(0);
    const listPayload = parseJsonOutput(listed.stdout);
    expect(listPayload.mode).toBe('auto-batch-session-list');
    expect(listPayload.total).toBe(2);
    expect(listPayload.sessions).toHaveLength(1);

    const stats = await runCli([
      'auto',
      'batch-session',
      'stats',
      '--json'
    ], { cwd: tempDir });
    expect(stats.exitCode).toBe(0);
    const statsPayload = parseJsonOutput(stats.stdout);
    expect(statsPayload.mode).toBe('auto-batch-session-stats');
    expect(statsPayload.total_sessions).toBe(2);
    expect(statsPayload.latest_sessions).toHaveLength(2);

    const pruned = await runCli([
      'auto',
      'batch-session',
      'prune',
      '--keep',
      '1',
      '--json'
    ], { cwd: tempDir });
    expect(pruned.exitCode).toBe(0);
    const prunePayload = parseJsonOutput(pruned.stdout);
    expect(prunePayload.mode).toBe('auto-batch-session-prune');
    expect(prunePayload.deleted_count).toBe(1);
    expect(prunePayload.errors).toEqual([]);

    const listedAfter = await runCli([
      'auto',
      'batch-session',
      'list',
      '--json'
    ], { cwd: tempDir });
    expect(listedAfter.exitCode).toBe(0);
    const listAfterPayload = parseJsonOutput(listedAfter.stdout);
    expect(listAfterPayload.total).toBe(1);
  });

  test('supports controller-session list and prune lifecycle through CLI', async () => {
    const sessionDir = path.join(tempDir, '.sce', 'auto', 'close-loop-controller-sessions');
    await fs.ensureDir(sessionDir);
    const oldSession = path.join(sessionDir, 'old-controller-session.json');
    const newSession = path.join(sessionDir, 'new-controller-session.json');
    await fs.writeJson(oldSession, {
      mode: 'auto-close-loop-controller',
      status: 'completed',
      processed_goals: 1,
      pending_goals: 0,
      controller_session: {
        id: 'old-controller-session',
        file: oldSession
      }
    }, { spaces: 2 });
    await fs.writeJson(newSession, {
      mode: 'auto-close-loop-controller',
      status: 'partial-failed',
      processed_goals: 1,
      pending_goals: 0,
      controller_session: {
        id: 'new-controller-session',
        file: newSession
      }
    }, { spaces: 2 });
    await fs.utimes(oldSession, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));
    await fs.utimes(newSession, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));

    const listed = await runCli([
      'auto',
      'controller-session',
      'list',
      '--status',
      'partial-failed',
      '--limit',
      '1',
      '--json'
    ], { cwd: tempDir });
    expect(listed.exitCode).toBe(0);
    const listPayload = parseJsonOutput(listed.stdout);
    expect(listPayload.mode).toBe('auto-controller-session-list');
    expect(listPayload.total).toBe(1);
    expect(listPayload.status_filter).toEqual(['partial-failed']);
    expect(listPayload.status_counts).toEqual(expect.objectContaining({
      'partial-failed': 1
    }));
    expect(listPayload.sessions).toHaveLength(1);
    expect(listPayload.sessions[0].id).toBe('new-controller-session');

    const stats = await runCli([
      'auto',
      'controller-session',
      'stats',
      '--status',
      'partial-failed',
      '--json'
    ], { cwd: tempDir });
    expect(stats.exitCode).toBe(0);
    const statsPayload = parseJsonOutput(stats.stdout);
    expect(statsPayload.mode).toBe('auto-controller-session-stats');
    expect(statsPayload.total_sessions).toBe(1);
    expect(statsPayload.status_counts).toEqual(expect.objectContaining({
      'partial-failed': 1
    }));
    expect(statsPayload.latest_sessions).toHaveLength(1);
    expect(statsPayload.latest_sessions[0].id).toBe('new-controller-session');

    const pruned = await runCli([
      'auto',
      'controller-session',
      'prune',
      '--keep',
      '1',
      '--json'
    ], { cwd: tempDir });
    expect(pruned.exitCode).toBe(0);
    const prunePayload = parseJsonOutput(pruned.stdout);
    expect(prunePayload.mode).toBe('auto-controller-session-prune');
    expect(prunePayload.deleted_count).toBe(1);
    expect(prunePayload.errors).toEqual([]);

    const listedAfter = await runCli([
      'auto',
      'controller-session',
      'list',
      '--json'
    ], { cwd: tempDir });
    expect(listedAfter.exitCode).toBe(0);
    const listAfterPayload = parseJsonOutput(listedAfter.stdout);
    expect(listAfterPayload.total).toBe(1);
  });

  test('aggregates governance stats across archives through CLI', async () => {
    const closeLoopSessionDir = path.join(tempDir, '.sce', 'auto', 'close-loop-sessions');
    const batchSessionDir = path.join(tempDir, '.sce', 'auto', 'close-loop-batch-summaries');
    const controllerSessionDir = path.join(tempDir, '.sce', 'auto', 'close-loop-controller-sessions');
    await fs.ensureDir(closeLoopSessionDir);
    await fs.ensureDir(batchSessionDir);
    await fs.ensureDir(controllerSessionDir);

    const closeLoopFile = path.join(closeLoopSessionDir, 'integration-governance-session.json');
    await fs.writeJson(closeLoopFile, {
      session_id: 'integration-governance-session',
      status: 'completed',
      portfolio: {
        master_spec: '121-00-integration',
        sub_specs: ['121-01-integration-a']
      }
    }, { spaces: 2 });

    const batchFile = path.join(batchSessionDir, 'integration-governance-batch.json');
    await fs.writeJson(batchFile, {
      mode: 'auto-close-loop-batch',
      status: 'failed',
      total_goals: 3,
      processed_goals: 1,
      batch_session: {
        id: 'integration-governance-batch',
        file: batchFile
      }
    }, { spaces: 2 });

    const controllerFile = path.join(controllerSessionDir, 'integration-governance-controller.json');
    await fs.writeJson(controllerFile, {
      mode: 'auto-close-loop-controller',
      status: 'completed',
      queue_format: 'lines',
      processed_goals: 2,
      pending_goals: 0,
      controller_session: {
        id: 'integration-governance-controller',
        file: controllerFile
      }
    }, { spaces: 2 });

    const recoveryMemoryFile = path.join(tempDir, '.sce', 'auto', 'close-loop-recovery-memory.json');
    await fs.ensureDir(path.dirname(recoveryMemoryFile));
    await fs.writeJson(recoveryMemoryFile, {
      version: 1,
      signatures: {
        'integration-signature': {
          signature: 'integration-signature',
          scope: 'integration',
          attempts: 1,
          successes: 1,
          failures: 0,
          last_used_at: '2026-02-14T10:00:00.000Z',
          actions: {
            '1': {
              index: 1,
              title: 'retry once',
              attempts: 1,
              successes: 1,
              failures: 0,
              last_used_at: '2026-02-14T10:00:00.000Z'
            }
          }
        }
      }
    }, { spaces: 2 });

    const stats = await runCli([
      'auto',
      'governance',
      'stats',
      '--json'
    ], { cwd: tempDir });
    expect(stats.exitCode).toBe(0);
    const statsPayload = parseJsonOutput(stats.stdout);
    expect(statsPayload.mode).toBe('auto-governance-stats');
    expect(statsPayload.totals).toEqual(expect.objectContaining({
      total_sessions: 3,
      completed_sessions: 2,
      failed_sessions: 1
    }));
    expect(statsPayload.recovery_memory).toEqual(expect.objectContaining({
      signature_count: 1,
      action_count: 1
    }));
    expect(statsPayload.archives.session.total_sessions).toBe(1);
    expect(statsPayload.archives.batch_session.total_sessions).toBe(1);
    expect(statsPayload.archives.controller_session.total_sessions).toBe(1);
    expect(statsPayload.health.risk_level).toBe('medium');
  });

  test('applies governance maintenance actions through CLI', async () => {
    const closeLoopSessionDir = path.join(tempDir, '.sce', 'auto', 'close-loop-sessions');
    const batchSessionDir = path.join(tempDir, '.sce', 'auto', 'close-loop-batch-summaries');
    const controllerSessionDir = path.join(tempDir, '.sce', 'auto', 'close-loop-controller-sessions');
    await fs.ensureDir(closeLoopSessionDir);
    await fs.ensureDir(batchSessionDir);
    await fs.ensureDir(controllerSessionDir);

    const sessionOld = path.join(closeLoopSessionDir, 'integration-maintain-old-session.json');
    const sessionNew = path.join(closeLoopSessionDir, 'integration-maintain-new-session.json');
    await fs.writeJson(sessionOld, {
      session_id: 'integration-maintain-old-session',
      status: 'completed',
      portfolio: { master_spec: '121-00-old', sub_specs: [] }
    }, { spaces: 2 });
    await fs.writeJson(sessionNew, {
      session_id: 'integration-maintain-new-session',
      status: 'completed',
      portfolio: { master_spec: '121-00-new', sub_specs: [] }
    }, { spaces: 2 });

    const batchOld = path.join(batchSessionDir, 'integration-maintain-old-batch.json');
    const batchNew = path.join(batchSessionDir, 'integration-maintain-new-batch.json');
    await fs.writeJson(batchOld, {
      mode: 'auto-close-loop-batch',
      status: 'completed',
      total_goals: 2,
      processed_goals: 2,
      batch_session: { id: 'integration-maintain-old-batch', file: batchOld }
    }, { spaces: 2 });
    await fs.writeJson(batchNew, {
      mode: 'auto-close-loop-batch',
      status: 'completed',
      total_goals: 2,
      processed_goals: 2,
      batch_session: { id: 'integration-maintain-new-batch', file: batchNew }
    }, { spaces: 2 });

    const controllerOld = path.join(controllerSessionDir, 'integration-maintain-old-controller.json');
    const controllerNew = path.join(controllerSessionDir, 'integration-maintain-new-controller.json');
    await fs.writeJson(controllerOld, {
      mode: 'auto-close-loop-controller',
      status: 'completed',
      processed_goals: 1,
      pending_goals: 0,
      controller_session: { id: 'integration-maintain-old-controller', file: controllerOld }
    }, { spaces: 2 });
    await fs.writeJson(controllerNew, {
      mode: 'auto-close-loop-controller',
      status: 'completed',
      processed_goals: 1,
      pending_goals: 0,
      controller_session: { id: 'integration-maintain-new-controller', file: controllerNew }
    }, { spaces: 2 });

    const oldDate = new Date('2020-01-01T00:00:00.000Z');
    await fs.utimes(sessionOld, oldDate, oldDate);
    await fs.utimes(batchOld, oldDate, oldDate);
    await fs.utimes(controllerOld, oldDate, oldDate);
    const now = new Date();
    await fs.utimes(sessionNew, now, now);
    await fs.utimes(batchNew, now, now);
    await fs.utimes(controllerNew, now, now);

    const recoveryMemoryFile = path.join(tempDir, '.sce', 'auto', 'close-loop-recovery-memory.json');
    await fs.ensureDir(path.dirname(recoveryMemoryFile));
    await fs.writeJson(recoveryMemoryFile, {
      version: 1,
      signatures: {
        'integration-maintain-signature': {
          signature: 'integration-maintain-signature',
          scope: 'integration-maintain',
          attempts: 1,
          successes: 0,
          failures: 1,
          last_used_at: '2020-01-01T00:00:00.000Z',
          actions: {
            '1': {
              index: 1,
              title: 'legacy',
              attempts: 1,
              successes: 0,
              failures: 1,
              last_used_at: '2020-01-01T00:00:00.000Z'
            }
          }
        }
      }
    }, { spaces: 2 });

    const maintained = await runCli([
      'auto',
      'governance',
      'maintain',
      '--apply',
      '--session-keep',
      '1',
      '--batch-session-keep',
      '1',
      '--controller-session-keep',
      '1',
      '--recovery-memory-older-than-days',
      '30',
      '--json'
    ], { cwd: tempDir });
    expect(maintained.exitCode).toBe(0);
    const maintainPayload = parseJsonOutput(maintained.stdout);
    expect(maintainPayload.mode).toBe('auto-governance-maintain');
    expect(maintainPayload.apply).toBe(true);
    expect(maintainPayload.summary.applied_actions).toBe(4);
    expect(maintainPayload.after_assessment.archives.session.total_sessions).toBe(1);
    expect(maintainPayload.after_assessment.archives.batch_session.total_sessions).toBe(1);
    expect(maintainPayload.after_assessment.archives.controller_session.total_sessions).toBe(1);
    expect(maintainPayload.after_assessment.recovery_memory.signature_count).toBe(0);

    expect(await fs.pathExists(sessionOld)).toBe(false);
    expect(await fs.pathExists(batchOld)).toBe(false);
    expect(await fs.pathExists(controllerOld)).toBe(false);
    expect(await fs.pathExists(sessionNew)).toBe(true);
    expect(await fs.pathExists(batchNew)).toBe(true);
    expect(await fs.pathExists(controllerNew)).toBe(true);
  });

  test('runs governance close-loop in plan-only mode through CLI', async () => {
    const closeLoopSessionDir = path.join(tempDir, '.sce', 'auto', 'close-loop-sessions');
    await fs.ensureDir(closeLoopSessionDir);
    const failedSession = path.join(closeLoopSessionDir, 'integration-governance-close-loop-plan-failed.json');
    await fs.writeJson(failedSession, {
      session_id: 'integration-governance-close-loop-plan-failed',
      status: 'failed',
      portfolio: { master_spec: '121-00-integration-plan', sub_specs: [] }
    }, { spaces: 2 });

    const closedLoop = await runCli([
      'auto',
      'governance',
      'close-loop',
      '--plan-only',
      '--max-rounds',
      '3',
      '--target-risk',
      'low',
      '--json'
    ], { cwd: tempDir });
    expect(closedLoop.exitCode).toBe(0);
    const payload = parseJsonOutput(closedLoop.stdout);
    expect(payload.mode).toBe('auto-governance-close-loop');
    expect(payload.plan_only).toBe(true);
    expect(payload.apply).toBe(false);
    expect(payload.performed_rounds).toBe(1);
    expect(payload.stop_reason).toBe('non-mutating-mode');
    expect(Array.isArray(payload.rounds)).toBe(true);
    expect(payload.rounds).toHaveLength(1);
  });

  test('runs governance close-loop with advisory execution through CLI', async () => {
    const closeLoopSessionDir = path.join(tempDir, '.sce', 'auto', 'close-loop-sessions');
    const controllerSessionDir = path.join(tempDir, '.sce', 'auto', 'close-loop-controller-sessions');
    const controllerQueueFile = path.join(tempDir, '.sce', 'auto', 'integration-governance-controller-queue.lines');
    await fs.ensureDir(closeLoopSessionDir);
    await fs.ensureDir(controllerSessionDir);
    await fs.ensureDir(path.dirname(controllerQueueFile));

    const completedSession = path.join(closeLoopSessionDir, 'integration-governance-advisory-session.json');
    await fs.writeJson(completedSession, {
      session_id: 'integration-governance-advisory-session',
      status: 'completed',
      portfolio: { master_spec: '121-00-integration-advisory', sub_specs: [] }
    }, { spaces: 2 });

    const controllerSessionFile = path.join(controllerSessionDir, 'integration-governance-advisory-controller.json');
    await fs.writeJson(controllerSessionFile, {
      mode: 'auto-close-loop-controller',
      status: 'completed',
      queue_file: controllerQueueFile,
      queue_format: 'lines',
      processed_goals: 0,
      pending_goals: 1,
      controller_session: {
        id: 'integration-governance-advisory-controller',
        file: controllerSessionFile
      }
    }, { spaces: 2 });
    await fs.writeFile(controllerQueueFile, '', 'utf8');

    const closedLoop = await runCli([
      'auto',
      'governance',
      'close-loop',
      '--max-rounds',
      '1',
      '--target-risk',
      'high',
      '--execute-advisory',
      '--advisory-controller-max-cycles',
      '1',
      '--dry-run',
      '--json'
    ], { cwd: tempDir });
    expect(closedLoop.exitCode).toBe(0);
    const payload = parseJsonOutput(closedLoop.stdout);
    expect(payload.mode).toBe('auto-governance-close-loop');
    expect(payload.execute_advisory).toBe(true);
    expect(payload.stop_reason).toBe('non-mutating-mode');
    expect(payload.advisory_policy).toEqual(expect.objectContaining({
      controller_max_cycles: 1
    }));
    expect(payload.advisory_summary).toEqual(expect.objectContaining({
      planned_actions: 1,
      executed_actions: 1,
      failed_actions: 0
    }));
    expect(Array.isArray(payload.rounds)).toBe(true);
    expect(payload.rounds).toHaveLength(1);
    expect(payload.rounds[0]).toEqual(expect.objectContaining({
      advisory_planned_actions: 1,
      advisory_executed_actions: 1,
      advisory_failed_actions: 0
    }));
    expect(payload.rounds[0].advisory_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'controller-resume-latest', status: 'applied' })
    ]));
  });

  test('persists and resumes governance close-loop session through CLI', async () => {
    const closeLoopSessionDir = path.join(tempDir, '.sce', 'auto', 'close-loop-sessions');
    await fs.ensureDir(closeLoopSessionDir);
    await fs.writeJson(path.join(closeLoopSessionDir, 'integration-governance-resume-failed-session.json'), {
      session_id: 'integration-governance-resume-failed-session',
      status: 'failed',
      portfolio: { master_spec: '121-00-integration-governance-resume', sub_specs: [] }
    }, { spaces: 2 });

    const firstRun = await runCli([
      'auto',
      'governance',
      'close-loop',
      '--plan-only',
      '--max-rounds',
      '3',
      '--governance-session-id',
      'integration-gov-resume',
      '--json'
    ], { cwd: tempDir });
    expect(firstRun.exitCode).toBe(0);
    const firstPayload = parseJsonOutput(firstRun.stdout);
    expect(firstPayload.mode).toBe('auto-governance-close-loop');
    expect(firstPayload.governance_session).toEqual(expect.objectContaining({
      id: 'integration-gov-resume'
    }));
    expect(firstPayload.performed_rounds).toBe(1);
    expect(await fs.pathExists(firstPayload.governance_session.file)).toBe(true);

    const resumedRun = await runCli([
      'auto',
      'governance',
      'close-loop',
      '--governance-resume',
      'integration-gov-resume',
      '--plan-only',
      '--max-rounds',
      '3',
      '--json'
    ], { cwd: tempDir });
    expect(resumedRun.exitCode).toBe(0);
    const resumedPayload = parseJsonOutput(resumedRun.stdout);
    expect(resumedPayload.mode).toBe('auto-governance-close-loop');
    expect(resumedPayload.resumed_from_governance_session).toEqual(expect.objectContaining({
      id: 'integration-gov-resume'
    }));
    expect(resumedPayload.governance_session).toEqual(expect.objectContaining({
      id: 'integration-gov-resume'
    }));
    expect(resumedPayload.performed_rounds).toBe(2);
    expect(Array.isArray(resumedPayload.rounds)).toBe(true);
    expect(resumedPayload.rounds).toHaveLength(2);
    expect(resumedPayload.stop_reason).toBe('non-mutating-mode');
  });

  test('guards governance resume option drift through CLI unless override is enabled', async () => {
    const firstRun = await runCli([
      'auto',
      'governance',
      'close-loop',
      '--plan-only',
      '--max-rounds',
      '3',
      '--target-risk',
      'low',
      '--governance-session-id',
      'integration-governance-resume-drift',
      '--json'
    ], { cwd: tempDir });
    expect(firstRun.exitCode).toBe(0);

    const rejected = await runCli([
      'auto',
      'governance',
      'close-loop',
      '--governance-resume',
      'integration-governance-resume-drift',
      '--plan-only',
      '--target-risk',
      'high',
      '--json'
    ], { cwd: tempDir });
    expect(rejected.exitCode).toBe(1);
    const rejectedPayload = parseJsonOutput(rejected.stdout);
    expect(rejectedPayload.success).toBe(false);
    expect(rejectedPayload.error).toContain('Governance resume option drift detected');
    expect(rejectedPayload.error).toContain('--governance-resume-allow-drift');

    const overridden = await runCli([
      'auto',
      'governance',
      'close-loop',
      '--governance-resume',
      'integration-governance-resume-drift',
      '--governance-resume-allow-drift',
      '--plan-only',
      '--target-risk',
      'high',
      '--json'
    ], { cwd: tempDir });
    expect(overridden.exitCode).toBe(0);
    const overriddenPayload = parseJsonOutput(overridden.stdout);
    expect(overriddenPayload.mode).toBe('auto-governance-close-loop');
    expect(overriddenPayload.target_risk).toBe('high');
  });

  test('applies governance session retention policy through CLI', async () => {
    const governanceSessionDir = path.join(tempDir, '.sce', 'auto', 'governance-close-loop-sessions');
    await fs.ensureDir(governanceSessionDir);
    const staleFile = path.join(governanceSessionDir, 'integration-governance-retention-stale.json');
    await fs.writeJson(staleFile, {
      mode: 'auto-governance-close-loop',
      status: 'stopped',
      governance_session: {
        id: 'integration-governance-retention-stale',
        file: staleFile
      }
    }, { spaces: 2 });
    const oldDate = new Date('2020-01-01T00:00:00.000Z');
    await fs.utimes(staleFile, oldDate, oldDate);

    const run = await runCli([
      'auto',
      'governance',
      'close-loop',
      '--plan-only',
      '--governance-session-id',
      'integration-governance-retention-current',
      '--governance-session-keep',
      '0',
      '--json'
    ], { cwd: tempDir });
    expect(run.exitCode).toBe(0);
    const payload = parseJsonOutput(run.stdout);
    expect(payload.mode).toBe('auto-governance-close-loop');
    expect(payload.governance_session_prune).toEqual(expect.objectContaining({
      mode: 'auto-governance-session-prune',
      deleted_count: 1
    }));
    expect(payload.governance_session_prune.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'integration-governance-retention-stale' })
    ]));
    expect(await fs.pathExists(staleFile)).toBe(false);
    const currentFile = path.join(governanceSessionDir, 'integration-governance-retention-current.json');
    expect(await fs.pathExists(currentFile)).toBe(true);
  });

  test('supports governance session list/stats/prune lifecycle through CLI', async () => {
    const governanceSessionDir = path.join(tempDir, '.sce', 'auto', 'governance-close-loop-sessions');
    await fs.ensureDir(governanceSessionDir);

    const oldSession = path.join(governanceSessionDir, 'integration-governance-session-old.json');
    const newSession = path.join(governanceSessionDir, 'integration-governance-session-new.json');
    await fs.writeJson(oldSession, {
      mode: 'auto-governance-close-loop',
      status: 'failed',
      target_risk: 'low',
      max_rounds: 3,
      performed_rounds: 3,
      converged: false,
      stop_reason: 'max-rounds-exhausted',
      execute_advisory: true,
      advisory_summary: {
        planned_actions: 2,
        executed_actions: 1,
        failed_actions: 1,
        skipped_actions: 0
      },
      final_assessment: { health: { risk_level: 'high' } },
      governance_session: {
        id: 'integration-governance-session-old',
        file: oldSession
      }
    }, { spaces: 2 });
    await fs.writeJson(newSession, {
      mode: 'auto-governance-close-loop',
      status: 'completed',
      target_risk: 'low',
      max_rounds: 3,
      performed_rounds: 1,
      converged: true,
      stop_reason: 'target-risk-reached',
      execute_advisory: false,
      advisory_summary: {
        planned_actions: 0,
        executed_actions: 0,
        failed_actions: 0,
        skipped_actions: 0
      },
      final_assessment: { health: { risk_level: 'low' } },
      governance_session: {
        id: 'integration-governance-session-new',
        file: newSession
      },
      resumed_from_governance_session: {
        id: 'integration-governance-session-old',
        file: oldSession
      }
    }, { spaces: 2 });

    const oldDate = new Date('2020-01-01T00:00:00.000Z');
    await fs.utimes(oldSession, oldDate, oldDate);
    await fs.utimes(newSession, new Date(), new Date());

    const listed = await runCli([
      'auto',
      'governance',
      'session',
      'list',
      '--status',
      'failed',
      '--json'
    ], { cwd: tempDir });
    expect(listed.exitCode).toBe(0);
    const listPayload = parseJsonOutput(listed.stdout);
    expect(listPayload.mode).toBe('auto-governance-session-list');
    expect(listPayload.total).toBe(1);
    expect(listPayload.resume_only).toBe(false);
    expect(listPayload.resumed_sessions).toBe(0);
    expect(listPayload.fresh_sessions).toBe(1);
    expect(listPayload.sessions).toHaveLength(1);
    expect(listPayload.sessions[0].id).toBe('integration-governance-session-old');

    const resumedListed = await runCli([
      'auto',
      'governance',
      'session',
      'list',
      '--resume-only',
      '--json'
    ], { cwd: tempDir });
    expect(resumedListed.exitCode).toBe(0);
    const resumedListPayload = parseJsonOutput(resumedListed.stdout);
    expect(resumedListPayload.mode).toBe('auto-governance-session-list');
    expect(resumedListPayload.total).toBe(1);
    expect(resumedListPayload.resume_only).toBe(true);
    expect(resumedListPayload.resumed_sessions).toBe(1);
    expect(resumedListPayload.fresh_sessions).toBe(0);
    expect(resumedListPayload.sessions).toHaveLength(1);
    expect(resumedListPayload.sessions[0].id).toBe('integration-governance-session-new');

    const stats = await runCli([
      'auto',
      'governance',
      'session',
      'stats',
      '--json'
    ], { cwd: tempDir });
    expect(stats.exitCode).toBe(0);
    const statsPayload = parseJsonOutput(stats.stdout);
    expect(statsPayload.mode).toBe('auto-governance-session-stats');
    expect(statsPayload.total_sessions).toBe(2);
    expect(statsPayload.resumed_sessions).toBe(1);
    expect(statsPayload.fresh_sessions).toBe(1);
    expect(statsPayload.resumed_rate_percent).toBe(50);
    expect(statsPayload.completed_sessions).toBe(1);
    expect(statsPayload.failed_sessions).toBe(1);
    expect(statsPayload.converged_sessions).toBe(1);
    expect(statsPayload.resumed_from_counts).toEqual(expect.objectContaining({
      'integration-governance-session-old': 1
    }));
    expect(statsPayload.final_risk_counts).toEqual(expect.objectContaining({
      high: 1,
      low: 1
    }));

    const pruned = await runCli([
      'auto',
      'governance',
      'session',
      'prune',
      '--keep',
      '1',
      '--json'
    ], { cwd: tempDir });
    expect(pruned.exitCode).toBe(0);
    const prunePayload = parseJsonOutput(pruned.stdout);
    expect(prunePayload.mode).toBe('auto-governance-session-prune');
    expect(prunePayload.deleted_count).toBe(1);
    expect(prunePayload.errors).toEqual([]);
    expect(await fs.pathExists(oldSession)).toBe(false);
    expect(await fs.pathExists(newSession)).toBe(true);
  });
});
