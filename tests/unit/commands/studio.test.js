const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  resolveStudioPaths,
  readLatestJob,
  readStudioEvents,
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
  loadStudioSecurityPolicy,
  ensureStudioAuthorization,
  buildReleaseGateSteps
} = require('../../../lib/commands/studio');
const { ensureSpecDomainArtifacts } = require('../../../lib/spec/domain-modeling');
const { resolveErrorbookPaths } = require('../../../lib/commands/errorbook');

describe('studio command workflow', () => {
  let tempDir;
  let originalLog;
  let successRunner;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-studio-cmd-'));
    originalLog = console.log;
    console.log = jest.fn();
    successRunner = jest.fn(async () => ({
      status: 0,
      stdout: 'ok',
      stderr: '',
      duration_ms: 1
    }));
  });

  afterEach(async () => {
    console.log = originalLog;
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  test('creates a plan job and writes latest pointer', async () => {
    const payload = await runStudioPlanCommand({
      scene: 'scene.customer-order-inventory',
      fromChat: 'session-001',
      goal: 'Build customer-order-inventory demo',
      json: true
    }, {
      projectPath: tempDir
    });

    expect(payload.mode).toBe('studio-plan');
    expect(payload.status).toBe('planned');
    expect(payload.job_id).toContain('studio-');
    expect(payload.next_action).toContain('sce studio generate');
    expect(payload.sceneId).toBe('scene.customer-order-inventory');
    expect(payload.sessionId).toBeTruthy();
    expect(payload.specId).toBeTruthy();
    expect(payload.taskId).toBe(`${payload.job_id}:plan`);
    expect(payload.taskRef).toMatch(/^\d{2,}\.\d{2,}\.\d{2,}$/);
    expect(payload.eventId).toMatch(/^evt-/);
    expect(payload.task).toEqual(expect.objectContaining({
      goal: 'Build customer-order-inventory demo',
      status: 'completed',
      ref: payload.taskRef,
      task_ref: payload.taskRef,
      title_norm: 'Build customer-order-inventory demo',
      raw_request: 'Build customer-order-inventory demo',
      next_action: expect.stringContaining('sce studio generate')
    }));
    expect(payload.task.needs_split).toBe(false);
    expect(payload.task.sub_goals).toEqual([]);
    expect(Array.isArray(payload.task.acceptance_criteria)).toBe(true);
    expect(payload.task.acceptance_criteria.length).toBeGreaterThan(0);
    expect(typeof payload.task.confidence).toBe('number');
    expect(Array.isArray(payload.task.summary)).toBe(true);
    expect(payload.task.summary).toHaveLength(3);
    expect(Array.isArray(payload.task.file_changes)).toBe(true);
    expect(Array.isArray(payload.task.commands)).toBe(true);
    expect(Array.isArray(payload.task.errors)).toBe(true);
    expect(Array.isArray(payload.task.evidence)).toBe(true);
    expect(
      payload.task.evidence.some((item) => item.type === 'event-log' && item.ref === '.sce/state/sce-state.sqlite')
    ).toBe(true);
    expect(Array.isArray(payload.event)).toBe(true);
    expect(payload.event).toHaveLength(1);
    expect(payload.event[0].event_id).toBe(payload.eventId);

    const paths = resolveStudioPaths(tempDir);
    const latestJobId = await readLatestJob(paths);
    expect(latestJobId).toBe(payload.job_id);

    const jobPath = path.join(paths.jobsDir, `${payload.job_id}.json`);
    expect(await fs.pathExists(jobPath)).toBe(true);
  });

  test('normalizes multi-intent goal into structured task fields', async () => {
    const payload = await runStudioPlanCommand({
      scene: 'scene.multi-intent',
      fromChat: 'session-multi-intent-001',
      goal: 'Fix checkout timeout and add retry dashboard then update release notes',
      json: true
    }, {
      projectPath: tempDir
    });

    expect(payload.task.raw_request).toBe('Fix checkout timeout and add retry dashboard then update release notes');
    expect(payload.task.title_norm).toBe('Fix checkout timeout');
    expect(payload.task.needs_split).toBe(true);
    expect(payload.task.sub_goals).toEqual([
      'Fix checkout timeout',
      'add retry dashboard',
      'update release notes'
    ]);
    expect(Array.isArray(payload.task.acceptance_criteria)).toBe(true);
    expect(payload.task.acceptance_criteria.length).toBeGreaterThan(0);
    expect(payload.task.confidence).toBeLessThan(0.9);
  });

  test('plan auto-intake creates and binds spec when scene has no matching spec', async () => {
    const payload = await runStudioPlanCommand({
      scene: 'scene.auto-intake',
      fromChat: 'session-auto-intake-001',
      goal: 'Implement order approval retry workflow',
      json: true
    }, {
      projectPath: tempDir
    });

    const paths = resolveStudioPaths(tempDir);
    const job = await fs.readJson(path.join(paths.jobsDir, `${payload.job_id}.json`));
    const specId = `${job.source.spec_id || ''}`.trim();

    expect(specId).toBeTruthy();
    expect(job.source.intake).toEqual(expect.objectContaining({
      enabled: true,
      decision: expect.objectContaining({
        action: 'create_spec'
      }),
      selected_spec_id: specId
    }));
    expect(job.scene.spec_id).toBe(specId);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'specs', specId, 'requirements.md'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'specs', specId, 'custom', 'problem-domain-chain.json'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'spec-governance', 'scene-portfolio.latest.json'))).toBe(true);
  });

  test('studio intake supports dry decision without materializing spec', async () => {
    const intake = await runStudioIntakeCommand({
      scene: 'scene.intake-preview',
      fromChat: 'session-intake-preview-001',
      goal: 'Build warehouse anomaly reconciliation feature',
      json: true
    }, {
      projectPath: tempDir
    });

    expect(intake.mode).toBe('studio-auto-intake');
    expect(intake.decision.action).toBe('create_spec');
    expect(intake.selected_spec_id).toBeTruthy();
    expect(intake.created_spec).toBeNull();
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'specs', intake.selected_spec_id))).toBe(false);
  });

  test('plan blocks manual-spec bypass by default policy', async () => {
    await expect(runStudioPlanCommand({
      scene: 'scene.manual-block',
      fromChat: 'session-manual-block-001',
      goal: 'Implement checkout patch',
      manualSpec: true,
      json: true
    }, {
      projectPath: tempDir
    })).rejects.toThrow('--manual-spec is disabled');
  });

  test('plan blocks no-spec-governance bypass by default policy', async () => {
    await expect(runStudioPlanCommand({
      scene: 'scene.governance-block',
      fromChat: 'session-governance-block-001',
      goal: 'Implement checkout patch',
      specGovernance: false,
      json: true
    }, {
      projectPath: tempDir
    })).rejects.toThrow('--no-spec-governance is disabled');
  });

  test('studio portfolio groups specs by scene and emits governance summary', async () => {
    const specA = 'auto-scene-order-a';
    const specB = 'auto-scene-order-b';
    const specARoot = path.join(tempDir, '.sce', 'specs', specA);
    const specBRoot = path.join(tempDir, '.sce', 'specs', specB);
    await fs.ensureDir(specARoot);
    await fs.ensureDir(specBRoot);
    await fs.writeFile(path.join(specARoot, 'tasks.md'), '- [ ] task a\n', 'utf8');
    await fs.writeFile(path.join(specBRoot, 'tasks.md'), '- [ ] task b\n', 'utf8');
    await ensureSpecDomainArtifacts(tempDir, specA, {
      fileSystem: fs,
      force: true,
      sceneId: 'scene.order-governance',
      problemStatement: 'Order approval retry policy mismatch in checkout flow',
      verificationPlan: 'Run checkout approval regression tests'
    });
    await ensureSpecDomainArtifacts(tempDir, specB, {
      fileSystem: fs,
      force: true,
      sceneId: 'scene.order-governance',
      problemStatement: 'Order approval retry policy mismatch for checkout process',
      verificationPlan: 'Run checkout approval regression tests'
    });

    const portfolio = await runStudioPortfolioCommand({
      json: true
    }, {
      projectPath: tempDir
    });

    expect(portfolio.mode).toBe('studio-spec-governance');
    expect(portfolio.summary.scene_count).toBeGreaterThanOrEqual(1);
    expect(portfolio.summary.total_specs).toBeGreaterThanOrEqual(2);
    expect(portfolio.summary.duplicate_pairs).toBeGreaterThanOrEqual(1);
    expect(portfolio.report_file).toBe('.sce/spec-governance/scene-portfolio.latest.json');
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'spec-governance', 'scene-portfolio.latest.json'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'spec-governance', 'scene-index.json'))).toBe(true);
  });

  test('studio backfill command writes scene override map for unassigned active specs', async () => {
    await fs.ensureDir(path.join(tempDir, '.sce', 'specs', '101-00-moqui-service'));
    await fs.ensureDir(path.join(tempDir, '.sce', 'specs', '105-00-orchestrate-plan-preview'));
    await fs.writeFile(path.join(tempDir, '.sce', 'specs', '101-00-moqui-service', 'tasks.md'), '- [ ] pending\n', 'utf8');
    await fs.writeFile(path.join(tempDir, '.sce', 'specs', '105-00-orchestrate-plan-preview', 'tasks.md'), '- [ ] pending\n', 'utf8');

    const payload = await runStudioBackfillSpecScenesCommand({
      apply: true,
      json: true
    }, {
      projectPath: tempDir
    });

    expect(payload.mode).toBe('studio-scene-backfill');
    expect(payload.summary.changed_count).toBeGreaterThanOrEqual(2);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'spec-governance', 'spec-scene-overrides.json'))).toBe(true);
  });

  test('studio backfill command defaults to active-only policy', async () => {
    await fs.ensureDir(path.join(tempDir, '.sce', 'specs', '101-00-moqui-active'));
    await fs.ensureDir(path.join(tempDir, '.sce', 'specs', '102-00-moqui-completed'));
    await fs.writeFile(path.join(tempDir, '.sce', 'specs', '101-00-moqui-active', 'tasks.md'), '- [ ] pending\n', 'utf8');
    await fs.writeFile(path.join(tempDir, '.sce', 'specs', '102-00-moqui-completed', 'tasks.md'), '- [x] done\n', 'utf8');

    const payload = await runStudioBackfillSpecScenesCommand({
      json: true
    }, {
      projectPath: tempDir
    });

    expect(payload.mode).toBe('studio-scene-backfill');
    expect(payload.active_only).toBe(true);
    expect(payload.summary.candidate_count).toBe(1);
    expect(payload.assignments[0].spec_id).toBe('101-00-moqui-active');
  });

  test('plan with --spec ingests domain-chain and carries it through generate/verify/release reports', async () => {
    const specId = '01-00-domain-aware';
    const specRoot = path.join(tempDir, '.sce', 'specs', specId);
    await fs.ensureDir(specRoot);
    await ensureSpecDomainArtifacts(tempDir, specId, {
      fileSystem: fs,
      sceneId: 'scene.customer-order-inventory',
      problemStatement: 'Customer-order-inventory flow has reconciliation drift',
      primaryFlow: 'Customer order should reserve inventory before confirmation',
      verificationPlan: 'Run order+inventory consistency checks'
    });

    const planned = await runStudioPlanCommand({
      scene: 'scene.customer-order-inventory',
      spec: specId,
      fromChat: 'session-domain-001',
      goal: 'stabilize customer order inventory lifecycle',
      json: true
    }, {
      projectPath: tempDir
    });

    const paths = resolveStudioPaths(tempDir);
    const plannedJob = await fs.readJson(path.join(paths.jobsDir, `${planned.job_id}.json`));
    expect(plannedJob.source.spec_id).toBe(specId);
    expect(plannedJob.source.domain_chain).toEqual(expect.objectContaining({
      resolved: true,
      source: 'explicit-spec',
      spec_id: specId
    }));
    expect(plannedJob.stages.plan.metadata.domain_chain_resolved).toBe(true);

    await runStudioGenerateCommand({
      job: planned.job_id,
      json: true
    }, {
      projectPath: tempDir
    });

    const generatedJob = await fs.readJson(path.join(paths.jobsDir, `${planned.job_id}.json`));
    expect(generatedJob.stages.generate.metadata.domain_chain).toEqual(expect.objectContaining({
      resolved: true,
      source: 'explicit-spec',
      spec_id: specId
    }));
    expect(generatedJob.artifacts.generate_report).toContain(`generate-${planned.job_id}.json`);
    const generateReport = await fs.readJson(path.join(tempDir, generatedJob.artifacts.generate_report));
    expect(generateReport.domain_chain).toEqual(expect.objectContaining({
      resolved: true,
      source: 'explicit-spec',
      spec_id: specId
    }));

    await runStudioApplyCommand({
      job: planned.job_id,
      json: true
    }, {
      projectPath: tempDir
    });
    await runStudioVerifyCommand({
      job: planned.job_id,
      profile: 'standard',
      json: true
    }, {
      projectPath: tempDir,
      commandRunner: successRunner
    });
    await runStudioReleaseCommand({
      job: planned.job_id,
      profile: 'standard',
      channel: 'dev',
      json: true
    }, {
      projectPath: tempDir,
      commandRunner: successRunner
    });

    const releasedJob = await fs.readJson(path.join(paths.jobsDir, `${planned.job_id}.json`));
    const verifyReport = await fs.readJson(path.join(tempDir, releasedJob.artifacts.verify_report));
    const releaseReport = await fs.readJson(path.join(tempDir, releasedJob.artifacts.release_report));
    expect(verifyReport.domain_chain).toEqual(expect.objectContaining({
      resolved: true,
      source: 'explicit-spec',
      spec_id: specId
    }));
    expect(releaseReport.domain_chain).toEqual(expect.objectContaining({
      resolved: true,
      source: 'explicit-spec',
      spec_id: specId
    }));
  });

  test('plan without --spec auto-binds latest scene domain-chain candidate', async () => {
    const specId = '01-01-domain-auto';
    const relatedSpecId = '01-02-domain-auto-related';
    const specRoot = path.join(tempDir, '.sce', 'specs', specId);
    const relatedSpecRoot = path.join(tempDir, '.sce', 'specs', relatedSpecId);
    await fs.ensureDir(specRoot);
    await fs.ensureDir(relatedSpecRoot);
    await ensureSpecDomainArtifacts(tempDir, specId, {
      fileSystem: fs,
      sceneId: 'scene.auto-bind',
      problemStatement: 'Auto bind domain chain for scene',
      verificationPlan: 'Smoke checks'
    });
    await ensureSpecDomainArtifacts(tempDir, relatedSpecId, {
      fileSystem: fs,
      sceneId: 'scene.auto-bind',
      problemStatement: 'Related scene spec for lookup',
      verificationPlan: 'Regression checks'
    });
    await ensureSpecDomainArtifacts(tempDir, specId, {
      fileSystem: fs,
      force: true,
      sceneId: 'scene.auto-bind',
      problemStatement: 'Auto bind domain chain for scene',
      verificationPlan: 'Smoke checks'
    });

    const planned = await runStudioPlanCommand({
      scene: 'scene.auto-bind',
      fromChat: 'session-domain-002',
      json: true
    }, {
      projectPath: tempDir
    });

    const paths = resolveStudioPaths(tempDir);
    const plannedJob = await fs.readJson(path.join(paths.jobsDir, `${planned.job_id}.json`));
    expect(plannedJob.source.domain_chain).toEqual(expect.objectContaining({
      resolved: true,
      source: 'scene-auto-latest',
      spec_id: specId
    }));
    expect(plannedJob.source.related_specs.total_candidates).toBeGreaterThanOrEqual(1);
    expect(
      plannedJob.source.related_specs.items.some((item) => item.spec_id === relatedSpecId)
    ).toBe(true);
  });

  test('supports end-to-end stage flow from generate to release', async () => {
    const planned = await runStudioPlanCommand({
      scene: 'scene.customer-order-inventory',
      fromChat: 'session-002',
      json: true
    }, {
      projectPath: tempDir
    });

    const generated = await runStudioGenerateCommand({
      scene: 'scene.customer-order-inventory',
      json: true
    }, {
      projectPath: tempDir
    });

    expect(generated.status).toBe('generated');
    expect(generated.artifacts.patch_bundle_id).toContain('patch-scene.customer-order-inventory-');

    const applied = await runStudioApplyCommand({
      job: planned.job_id,
      json: true
    }, {
      projectPath: tempDir
    });
    expect(applied.status).toBe('applied');

    const verified = await runStudioVerifyCommand({
      profile: 'standard',
      json: true
    }, {
      projectPath: tempDir,
      commandRunner: successRunner
    });
    expect(verified.status).toBe('verified');
    expect(verified.artifacts.verify_report).toContain(`verify-${planned.job_id}.json`);
    expect(verified.taskId).toBe(`${planned.job_id}:verify`);
    expect(verified.taskRef).toMatch(/^\d{2,}\.\d{2,}\.\d{2,}$/);
    expect(Array.isArray(verified.task.commands)).toBe(true);
    expect(verified.task.commands.length).toBeGreaterThan(0);

    const released = await runStudioReleaseCommand({
      channel: 'prod',
      json: true
    }, {
      projectPath: tempDir,
      commandRunner: successRunner
    });
    expect(released.status).toBe('released');
    expect(released.next_action).toBe('complete');

    const resumed = await runStudioResumeCommand({
      job: planned.job_id,
      json: true
    }, {
      projectPath: tempDir
    });
    expect(resumed.status).toBe('released');
    expect(resumed.progress.percent).toBe(100);
  });

  test('fails generate when no plan job exists', async () => {
    await expect(runStudioGenerateCommand({
      scene: 'scene.demo',
      json: true
    }, {
      projectPath: tempDir
    })).rejects.toThrow('No studio job found');
  });

  test('fails release on invalid channel', async () => {
    await runStudioPlanCommand({
      scene: 'scene.release-channel-check',
      fromChat: 'session-003',
      json: true
    }, {
      projectPath: tempDir
    });

    await expect(runStudioReleaseCommand({
      channel: 'staging',
      json: true
    }, {
      projectPath: tempDir
    })).rejects.toThrow('Invalid --channel');
  });

  test('fails verify when required gate command fails', async () => {
    const packageJsonPath = path.join(tempDir, 'package.json');
    await fs.writeJson(packageJsonPath, {
      name: 'studio-verify-fixture',
      version: '1.0.0',
      scripts: {
        'test:unit': 'echo test'
      }
    }, { spaces: 2 });

    const planned = await runStudioPlanCommand({
      scene: 'scene.verify-fail',
      fromChat: 'session-006',
      json: true
    }, {
      projectPath: tempDir
    });
    await runStudioGenerateCommand({
      job: planned.job_id,
      scene: 'scene.verify-fail',
      json: true
    }, {
      projectPath: tempDir
    });
    await runStudioApplyCommand({
      job: planned.job_id,
      json: true
    }, {
      projectPath: tempDir
    });

    const failRunner = jest.fn(async () => ({
      status: 2,
      stdout: '',
      stderr: 'boom',
      duration_ms: 3
    }));

    await expect(runStudioVerifyCommand({
      job: planned.job_id,
      json: true
    }, {
      projectPath: tempDir,
      commandRunner: failRunner
    })).rejects.toThrow('studio verify failed');

    const paths = resolveStudioPaths(tempDir);
    const job = await fs.readJson(path.join(paths.jobsDir, `${planned.job_id}.json`));
    expect(job.status).toBe('verify_failed');
    expect(job.stages.verify.status).toBe('failed');

    const errorbookPaths = resolveErrorbookPaths(tempDir);
    const errorbookIndex = await fs.readJson(errorbookPaths.indexFile);
    expect(errorbookIndex.total_entries).toBeGreaterThanOrEqual(1);
    const entry = await fs.readJson(path.join(errorbookPaths.entriesDir, `${errorbookIndex.entries[0].id}.json`));
    expect(entry.status).toBe('candidate');
    expect(entry.tags).toEqual(expect.arrayContaining(['release-blocker', 'stage-verify']));
  });

  test('enforces stage order constraints', async () => {
    const planned = await runStudioPlanCommand({
      scene: 'scene.order',
      fromChat: 'session-004',
      json: true
    }, {
      projectPath: tempDir
    });

    await expect(runStudioApplyCommand({
      job: planned.job_id,
      json: true
    }, {
      projectPath: tempDir
    })).rejects.toThrow('stage "generate" is not completed');

    await runStudioGenerateCommand({
      job: planned.job_id,
      scene: 'scene.order',
      json: true
    }, {
      projectPath: tempDir
    });

    await expect(runStudioReleaseCommand({
      job: planned.job_id,
      channel: 'dev',
      json: true
    }, {
      projectPath: tempDir
    })).rejects.toThrow('stage "verify" is not completed');
  });

  test('records studio events and supports rollback', async () => {
    const planned = await runStudioPlanCommand({
      scene: 'scene.inventory',
      fromChat: 'session-005',
      json: true
    }, {
      projectPath: tempDir
    });

    await runStudioGenerateCommand({
      job: planned.job_id,
      scene: 'scene.inventory',
      json: true
    }, {
      projectPath: tempDir
    });
    await runStudioApplyCommand({
      job: planned.job_id,
      json: true
    }, {
      projectPath: tempDir
    });

    const rolledBack = await runStudioRollbackCommand({
      job: planned.job_id,
      reason: 'manual-check-failed',
      json: true
    }, {
      projectPath: tempDir
    });
    expect(rolledBack.status).toBe('rolled_back');
    expect(rolledBack.next_action).toContain('sce studio plan');

    const eventsPayload = await runStudioEventsCommand({
      job: planned.job_id,
      limit: '10',
      json: true
    }, {
      projectPath: tempDir
    });
    expect(eventsPayload.sceneId).toBe('scene.inventory');
    expect(eventsPayload.taskId).toBe(`${planned.job_id}:rollback`);
    expect(eventsPayload.taskRef).toMatch(/^\d{2,}\.\d{2,}\.\d{2,}$/);
    expect(Array.isArray(eventsPayload.event)).toBe(true);
    expect(eventsPayload.event).toHaveLength(eventsPayload.events.length);
    expect(eventsPayload.eventId).toBe(eventsPayload.events[eventsPayload.events.length - 1].event_id);
    expect(eventsPayload.task.handoff).toEqual(expect.objectContaining({
      stage: 'rollback'
    }));
    expect(eventsPayload.events.length).toBeGreaterThanOrEqual(4);
    expect(eventsPayload.events[eventsPayload.events.length - 1].event_type).toBe('job.rolled_back');

    const paths = resolveStudioPaths(tempDir);
    const rawEvents = await readStudioEvents(paths, planned.job_id, { limit: 100 });
    expect(rawEvents.some((event) => event.event_type === 'stage.apply.completed')).toBe(true);

    await expect(runStudioVerifyCommand({
      job: planned.job_id,
      json: true
    }, {
      projectPath: tempDir
    })).rejects.toThrow('is rolled back');
  });

  test('maps OpenHands raw events into task-stream contract for UI consumption', async () => {
    const planned = await runStudioPlanCommand({
      scene: 'scene.openhands-ui',
      fromChat: 'session-openhands-001',
      goal: 'repair flaky orchestration suite',
      json: true
    }, {
      projectPath: tempDir
    });

    const openhandsEventsPath = path.join(tempDir, 'openhands-events.json');
    await fs.writeJson(openhandsEventsPath, [
      {
        id: 'oh-1',
        type: 'tool_call',
        timestamp: '2026-03-03T00:00:00.000Z',
        tool_name: 'run_command',
        arguments: {
          command: 'npm run test:full'
        }
      },
      {
        id: 'oh-2',
        type: 'tool_result',
        timestamp: '2026-03-03T00:00:02.000Z',
        command: 'npm run test:full',
        exit_code: 1,
        stderr: 'Jest worker encountered 4 child process exceptions',
        changed_files: ['lib/commands/studio.js']
      },
      {
        id: 'oh-3',
        type: 'file_edit',
        timestamp: '2026-03-03T00:00:05.000Z',
        file: {
          path: 'lib/commands/studio.js',
          line: 640
        },
        diff: '+++ b/lib/commands/studio.js\n@@'
      }
    ], { spaces: 2 });

    const payload = await runStudioEventsCommand({
      job: planned.job_id,
      openhandsEvents: openhandsEventsPath,
      json: true
    }, {
      projectPath: tempDir
    });

    expect(payload.source_stream).toBe('openhands');
    expect(payload.openhands_events_file).toBe('openhands-events.json');
    expect(payload.sceneId).toBe('scene.openhands-ui');
    expect(payload.specId).toBeTruthy();
    expect(payload.taskId).toBe(`${planned.job_id}:plan`);
    expect(payload.taskRef).toMatch(/^\d{2,}\.\d{2,}\.\d{2,}$/);
    expect(payload.eventId).toBe('oh-3');
    expect(payload.event).toHaveLength(3);
    expect(payload.events).toHaveLength(3);
    expect(payload.task.summary).toHaveLength(3);
    expect(payload.task.handoff).toEqual(expect.objectContaining({
      source_stream: 'openhands',
      openhands_event_count: 3
    }));
    expect(payload.task.commands.length).toBeGreaterThanOrEqual(1);
    expect(payload.task.file_changes.some((item) => item.path === 'lib/commands/studio.js')).toBe(true);
    expect(payload.task.errors.length).toBeGreaterThanOrEqual(1);
    expect(payload.task.errors[0].error_bundle).toContain('exit_code: 1');
  });

  test('requires authorization for protected actions when policy is enabled', async () => {
    const secureEnv = {
      ...process.env,
      SCE_STUDIO_REQUIRE_AUTH: '1',
      SCE_STUDIO_AUTH_PASSWORD: 'top-secret'
    };

    const planned = await runStudioPlanCommand({
      scene: 'scene.secure',
      fromChat: 'session-007',
      json: true
    }, {
      projectPath: tempDir
    });

    await runStudioGenerateCommand({
      job: planned.job_id,
      scene: 'scene.secure',
      json: true
    }, {
      projectPath: tempDir
    });

    await expect(runStudioApplyCommand({
      job: planned.job_id,
      json: true
    }, {
      projectPath: tempDir,
      env: secureEnv
    })).rejects.toThrow('Authorization required for studio apply');

    const applied = await runStudioApplyCommand({
      job: planned.job_id,
      authPassword: 'top-secret',
      json: true
    }, {
      projectPath: tempDir,
      env: secureEnv
    });
    expect(applied.status).toBe('applied');

    await expect(runStudioRollbackCommand({
      job: planned.job_id,
      json: true
    }, {
      projectPath: tempDir,
      env: secureEnv
    })).rejects.toThrow('Authorization required for studio rollback');

    const rolledBack = await runStudioRollbackCommand({
      job: planned.job_id,
      authPassword: 'top-secret',
      reason: 'auth-test',
      json: true
    }, {
      projectPath: tempDir,
      env: secureEnv
    });
    expect(rolledBack.status).toBe('rolled_back');
  });

  test('loads studio security policy from .sce/config and supports env override', async () => {
    const policyPath = path.join(tempDir, '.sce', 'config', 'studio-security.json');
    await fs.ensureDir(path.dirname(policyPath));
    await fs.writeJson(policyPath, {
      enabled: true,
      require_auth_for: ['apply'],
      password_env: 'SCE_STUDIO_AUTH_PASSWORD_LOCAL'
    }, { spaces: 2 });

    const policy = await loadStudioSecurityPolicy(tempDir, fs, {
      SCE_STUDIO_PASSWORD_ENV: 'SCE_STUDIO_AUTH_PASSWORD_OVERRIDE'
    });

    expect(policy.enabled).toBe(true);
    expect(policy.require_auth_for).toEqual(['apply']);
    expect(policy.password_env).toBe('SCE_STUDIO_AUTH_PASSWORD_OVERRIDE');
  });

  test('ensureStudioAuthorization honors policy file configuration', async () => {
    const policyPath = path.join(tempDir, '.sce', 'config', 'studio-security.json');
    await fs.ensureDir(path.dirname(policyPath));
    await fs.writeJson(policyPath, {
      enabled: true,
      require_auth_for: ['release'],
      password_env: 'SCE_STUDIO_AUTH_PASSWORD_LOCAL'
    }, { spaces: 2 });

    await expect(ensureStudioAuthorization('release', {}, {
      projectPath: tempDir,
      fileSystem: fs,
      env: {
        SCE_STUDIO_AUTH_PASSWORD_LOCAL: 'secret'
      }
    })).rejects.toThrow('Authorization required for studio release');

    const result = await ensureStudioAuthorization('release', {
      authPassword: 'secret'
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      env: {
        SCE_STUDIO_AUTH_PASSWORD_LOCAL: 'secret'
      }
    });

    expect(result.required).toBe(true);
    expect(result.password_env).toBe('SCE_STUDIO_AUTH_PASSWORD_LOCAL');
  });

  test('strict verify fails when required gates are unavailable', async () => {
    const planned = await runStudioPlanCommand({
      scene: 'scene.strict-verify',
      fromChat: 'session-008',
      json: true
    }, {
      projectPath: tempDir
    });

    await runStudioGenerateCommand({
      job: planned.job_id,
      scene: 'scene.strict-verify',
      json: true
    }, {
      projectPath: tempDir
    });

    await runStudioApplyCommand({
      job: planned.job_id,
      json: true
    }, {
      projectPath: tempDir
    });

    await expect(runStudioVerifyCommand({
      job: planned.job_id,
      profile: 'strict',
      json: true
    }, {
      projectPath: tempDir,
      commandRunner: successRunner
    })).rejects.toThrow('studio verify failed');

    const paths = resolveStudioPaths(tempDir);
    const job = await fs.readJson(path.join(paths.jobsDir, `${planned.job_id}.json`));
    expect(job.status).toBe('verify_failed');
  });

  test('strict release fails when required release evidence gates are unavailable', async () => {
    const planned = await runStudioPlanCommand({
      scene: 'scene.strict-release',
      fromChat: 'session-009',
      json: true
    }, {
      projectPath: tempDir
    });

    await runStudioGenerateCommand({
      job: planned.job_id,
      scene: 'scene.strict-release',
      json: true
    }, {
      projectPath: tempDir
    });

    await runStudioApplyCommand({
      job: planned.job_id,
      json: true
    }, {
      projectPath: tempDir
    });

    await runStudioVerifyCommand({
      job: planned.job_id,
      profile: 'standard',
      json: true
    }, {
      projectPath: tempDir,
      commandRunner: successRunner
    });

    await expect(runStudioReleaseCommand({
      job: planned.job_id,
      profile: 'strict',
      channel: 'dev',
      json: true
    }, {
      projectPath: tempDir,
      commandRunner: successRunner
    })).rejects.toThrow('studio release failed');

    const paths = resolveStudioPaths(tempDir);
    const job = await fs.readJson(path.join(paths.jobsDir, `${planned.job_id}.json`));
    expect(job.status).toBe('release_failed');

    const errorbookPaths = resolveErrorbookPaths(tempDir);
    const errorbookIndex = await fs.readJson(errorbookPaths.indexFile);
    expect(errorbookIndex.total_entries).toBeGreaterThanOrEqual(1);
  });

  test('release gate includes ontology and capability matrix checks when handoff manifest exists', async () => {
    const handoffDir = path.join(tempDir, 'docs', 'handoffs');
    await fs.ensureDir(handoffDir);
    await fs.writeJson(path.join(handoffDir, 'handoff-manifest.json'), {
      project: 'studio-release-gate-fixture',
      entries: []
    }, { spaces: 2 });
    const scriptsDir = path.join(tempDir, 'scripts');
    await fs.ensureDir(scriptsDir);
    await fs.writeFile(
      path.join(scriptsDir, 'git-managed-gate.js'),
      "console.log(JSON.stringify({ mode: 'git-managed-gate', passed: true }));\n",
      'utf8'
    );
    await fs.writeFile(
      path.join(scriptsDir, 'errorbook-release-gate.js'),
      "console.log(JSON.stringify({ mode: 'errorbook-release-gate', passed: true }));\n",
      'utf8'
    );

    const steps = await buildReleaseGateSteps({
      profile: 'standard'
    }, {
      projectPath: tempDir,
      fileSystem: fs
    });

    const byId = new Map(steps.map((item) => [item.id, item]));
    expect(byId.get('git-managed-gate')).toEqual(expect.objectContaining({
      enabled: true,
      required: true
    }));
    expect(byId.get('errorbook-release-gate')).toEqual(expect.objectContaining({
      enabled: true,
      required: true
    }));
    expect(byId.get('scene-package-publish-batch-dry-run')).toEqual(expect.objectContaining({
      enabled: true,
      required: true
    }));
    expect(byId.get('handoff-capability-matrix-gate')).toEqual(expect.objectContaining({
      enabled: true,
      required: true
    }));
  });
});
