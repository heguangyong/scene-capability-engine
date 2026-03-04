const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  DEFAULT_BACKEND,
  SceStateStore,
  resolveBackend
} = require('../../../lib/state/sce-state-store');

describe('sce-state-store', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-state-store-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  test('enforces sqlite-only backend resolution', () => {
    expect(DEFAULT_BACKEND).toBe('sqlite');
    expect(resolveBackend('', {})).toBe('sqlite');
    expect(resolveBackend('sqlite', {})).toBe('sqlite');
    expect(resolveBackend('file', {})).toBe('sqlite');
    expect(resolveBackend('unsupported', {})).toBe('sqlite');
  });

  test('blocks runtime writes when sqlite is unavailable and memory fallback is disabled', async () => {
    const store = new SceStateStore(tempDir, {
      fileSystem: fs,
      env: { NODE_ENV: 'production' },
      sqliteModule: {}
    });

    const ref = await store.resolveOrCreateTaskRef({
      sceneId: 'scene.blocked',
      specId: 'spec.blocked',
      taskKey: '1'
    });
    expect(ref).toBeNull();

    const appended = await store.appendStudioEvent({
      event_id: 'evt-blocked',
      job_id: 'job-blocked',
      event_type: 'stage.plan.completed',
      timestamp: '2026-03-04T00:00:00.000Z'
    });
    expect(appended).toBe(false);

    const events = await store.listStudioEvents('job-blocked', { limit: 10 });
    expect(events).toBeNull();
  });

  test('uses in-memory fallback in test mode when sqlite is unavailable', async () => {
    const store = new SceStateStore(tempDir, {
      fileSystem: fs,
      env: { NODE_ENV: 'test' },
      sqliteModule: {}
    });

    const ref = await store.resolveOrCreateTaskRef({
      sceneId: 'scene.alpha',
      specId: 'spec.alpha',
      taskKey: 'task-1',
      source: 'unit-test',
      metadata: { fixture: true }
    });
    expect(ref).toEqual(expect.objectContaining({
      task_ref: '01.01.01',
      scene_id: 'scene.alpha',
      spec_id: 'spec.alpha',
      task_key: 'task-1'
    }));

    const appended = await store.appendStudioEvent({
      event_id: 'evt-memory',
      job_id: 'job-memory',
      event_type: 'stage.plan.completed',
      timestamp: '2026-03-04T00:00:00.000Z',
      metadata: { fixture: true }
    });
    expect(appended).toBe(true);

    const events = await store.listStudioEvents('job-memory', { limit: 10 });
    expect(Array.isArray(events)).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({
      event_id: 'evt-memory',
      job_id: 'job-memory',
      event_type: 'stage.plan.completed'
    }));
  });

  test('allows explicit in-memory fallback outside test mode', async () => {
    const store = new SceStateStore(tempDir, {
      fileSystem: fs,
      env: {
        NODE_ENV: 'production',
        SCE_STATE_ALLOW_MEMORY_FALLBACK: '1'
      },
      sqliteModule: {}
    });

    const ref = await store.resolveOrCreateTaskRef({
      sceneId: 'scene.prod',
      specId: 'spec.prod',
      taskKey: 'task-1'
    });

    expect(ref).toEqual(expect.objectContaining({
      task_ref: '01.01.01',
      scene_id: 'scene.prod',
      spec_id: 'spec.prod',
      task_key: 'task-1'
    }));
  });
});
