const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const { TaskRefRegistry } = require('../../../lib/task/task-ref-registry');

describe('TaskRefRegistry', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-task-ref-reg-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  test('assigns stable refs for same scene/spec/task tuple', async () => {
    const registry = new TaskRefRegistry(tempDir, { fileSystem: fs });

    const first = await registry.resolveOrCreateRef({
      sceneId: 'scene.alpha',
      specId: '01-00-alpha',
      taskKey: '1.1',
      source: 'spec-task'
    });

    const second = await registry.resolveOrCreateRef({
      sceneId: 'scene.alpha',
      specId: '01-00-alpha',
      taskKey: '1.1',
      source: 'spec-task'
    });

    expect(first.task_ref).toBe('01.01.01');
    expect(second.task_ref).toBe('01.01.01');
    expect(first.registry_path).toContain('sce-state.sqlite');
  });

  test('increments task/spec/scene counters hierarchically', async () => {
    const registry = new TaskRefRegistry(tempDir, { fileSystem: fs });

    const a = await registry.resolveOrCreateRef({
      sceneId: 'scene.alpha',
      specId: '01-00-alpha',
      taskKey: '1',
      source: 'spec-task'
    });
    const b = await registry.resolveOrCreateRef({
      sceneId: 'scene.alpha',
      specId: '01-00-alpha',
      taskKey: '2',
      source: 'spec-task'
    });
    const c = await registry.resolveOrCreateRef({
      sceneId: 'scene.alpha',
      specId: '01-01-beta',
      taskKey: '1',
      source: 'spec-task'
    });
    const d = await registry.resolveOrCreateRef({
      sceneId: 'scene.beta',
      specId: '02-00-gamma',
      taskKey: '1',
      source: 'spec-task'
    });

    expect(a.task_ref).toBe('01.01.01');
    expect(b.task_ref).toBe('01.01.02');
    expect(c.task_ref).toBe('01.02.01');
    expect(d.task_ref).toBe('02.01.01');
  });

  test('supports reverse lookup by task ref', async () => {
    const registry = new TaskRefRegistry(tempDir, { fileSystem: fs });
    const assigned = await registry.resolveOrCreateRef({
      sceneId: 'scene.lookup',
      specId: '03-00-lookup',
      taskKey: '3.2',
      source: 'spec-task',
      metadata: { note: 'fixture' }
    });

    const lookup = await registry.lookupByRef(assigned.task_ref);
    expect(lookup).toEqual(expect.objectContaining({
      task_ref: assigned.task_ref,
      scene_id: 'scene.lookup',
      spec_id: '03-00-lookup',
      task_key: '3.2',
      source: 'spec-task'
    }));
    expect(lookup.metadata).toEqual(expect.objectContaining({ note: 'fixture' }));
  });

  test('expands numbering beyond two digits without truncation', async () => {
    const registry = new TaskRefRegistry(tempDir, { fileSystem: fs });
    let last = null;

    for (let index = 1; index <= 100; index += 1) {
      last = await registry.resolveOrCreateRef({
        sceneId: `scene-${index}`,
        specId: 'spec-01',
        taskKey: '1',
        source: 'spec-task'
      });
    }

    expect(last.task_ref).toBe('100.01.01');
  });
});
