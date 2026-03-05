const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  runTaskDraftCommand,
  runTaskConsolidateCommand,
  runTaskScoreCommand,
  runTaskPromoteCommand
} = require('../../../lib/commands/task');

describe('task quality governance', () => {
  let tempDir;
  let originalCwd;
  let stdoutSpy;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-task-quality-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await fs.ensureDir(path.join(tempDir, '.sce', 'specs', '01-00-demo'));
    await fs.writeFile(
      path.join(tempDir, '.sce', 'specs', '01-00-demo', 'tasks.md'),
      '- [ ] 1. Existing task\n',
      'utf8'
    );
  });

  afterEach(async () => {
    if (stdoutSpy) {
      stdoutSpy.mockRestore();
    }
    process.chdir(originalCwd);
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  test('creates and consolidates drafts', async () => {
    await runTaskDraftCommand({
      scene: 'scene.demo',
      spec: '01-00-demo',
      input: 'Fix checkout timeout and add retry dashboard',
      json: true
    });

    await runTaskDraftCommand({
      scene: 'scene.demo',
      spec: '01-00-demo',
      input: 'Fix checkout timeout and add retry dashboard',
      json: true
    });

    await runTaskConsolidateCommand({
      scene: 'scene.demo',
      spec: '01-00-demo',
      json: true
    });

    const store = await fs.readJson(path.join(tempDir, '.sce', 'task-governance', 'drafts.json'));
    expect(store.drafts.length).toBe(1);
    expect(store.drafts[0].status).toBe('consolidated');
  });

  test('scores and promotes draft to tasks.md', async () => {
    await runTaskDraftCommand({
      scene: 'scene.demo',
      spec: '01-00-demo',
      input: 'Fix checkout timeout',
      acceptance: 'Latency < 2s|Retry dashboard visible',
      json: true
    });

    const store = await fs.readJson(path.join(tempDir, '.sce', 'task-governance', 'drafts.json'));
    const draftId = store.drafts[0].draft_id;

    await runTaskScoreCommand({
      draft: draftId,
      json: true
    });

    await runTaskPromoteCommand({
      draft: draftId,
      spec: '01-00-demo',
      json: true
    });

    const tasks = await fs.readFile(path.join(tempDir, '.sce', 'specs', '01-00-demo', 'tasks.md'), 'utf8');
    expect(tasks).toContain('2. Fix checkout timeout');
  });
});
