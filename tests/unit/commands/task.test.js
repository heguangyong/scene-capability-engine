const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  runTaskRefCommand,
  runTaskShowCommand,
  runTaskRerunCommand
} = require('../../../lib/commands/task');
const { runStudioPlanCommand } = require('../../../lib/commands/studio');

describe('task command ref/show/rerun', () => {
  let tempDir;
  let originalLog;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-task-cmd-'));
    originalLog = console.log;
    console.log = jest.fn();
  });

  afterEach(async () => {
    console.log = originalLog;
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  test('resolves ref, shows mapping, and reruns spec task by resetting status', async () => {
    const specId = '01-00-demo';
    const specDir = path.join(tempDir, '.sce', 'specs', specId);
    await fs.ensureDir(specDir);
    await fs.writeFile(
      path.join(specDir, 'tasks.md'),
      '- [x] 1 Demo task [@alice, claimed: 2026-03-01T00:00:00.000Z]\n',
      'utf8'
    );

    const refPayload = await runTaskRefCommand({
      scene: 'scene.demo',
      spec: specId,
      task: '1',
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs
    });

    expect(refPayload.task_ref).toBe('01.01.01');

    const showPayload = await runTaskShowCommand({
      ref: refPayload.task_ref,
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs
    });

    expect(showPayload.target.source).toBe('spec-task');
    expect(showPayload.task).toEqual(expect.objectContaining({
      kind: 'spec-task',
      task_id: '1',
      status: 'completed'
    }));

    const rerunDry = await runTaskRerunCommand({
      ref: refPayload.task_ref,
      dryRun: true,
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs
    });
    expect(rerunDry.dry_run).toBe(true);
    expect(rerunDry.command).toBe(`sce task claim ${specId} 1`);

    const rerun = await runTaskRerunCommand({
      ref: refPayload.task_ref,
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs
    });

    expect(rerun.success).toBe(true);
    const updatedTasks = await fs.readFile(path.join(specDir, 'tasks.md'), 'utf8');
    expect(updatedTasks).toContain('- [ ] 1 Demo task');
    expect(updatedTasks).not.toContain('claimed:');
  });

  test('shows studio-stage refs and prepares rerun command', async () => {
    const planned = await runStudioPlanCommand({
      scene: 'scene.task-ref-studio',
      fromChat: 'session-task-ref-studio',
      goal: 'prepare studio mapping fixture',
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs
    });

    expect(planned.taskRef).toMatch(/^\d{2,}\.\d{2,}\.\d{2,}$/);

    const showPayload = await runTaskShowCommand({
      ref: planned.taskRef,
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs
    });

    expect(showPayload.target.source).toBe('studio-stage');
    expect(showPayload.task).toEqual(expect.objectContaining({
      kind: 'studio-stage',
      stage: 'plan'
    }));
    expect(showPayload.rerun_command).toContain('sce studio plan');

    const rerunPreview = await runTaskRerunCommand({
      ref: planned.taskRef,
      dryRun: true,
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs
    });

    expect(rerunPreview.rerun_type).toBe('studio-stage');
    expect(rerunPreview.command).toContain('sce studio plan');
    expect(rerunPreview.dry_run).toBe(true);
  });
});
