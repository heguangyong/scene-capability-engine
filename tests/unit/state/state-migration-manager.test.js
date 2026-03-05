const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  SceStateStore
} = require('../../../lib/state/sce-state-store');
const {
  buildStateMigrationPlan,
  runStateMigration,
  runStateDoctor,
  runStateExport
} = require('../../../lib/state/state-migration-manager');

describe('state-migration-manager', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-state-migration-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  async function seedFileBasedState() {
    await fs.ensureDir(path.join(tempDir, '.sce', 'config'));
    await fs.writeJson(path.join(tempDir, '.sce', 'config', 'agent-registry.json'), {
      version: '1.0.0',
      agents: {
        'machine-a:0': {
          agentId: 'machine-a:0',
          machineId: 'machine-a',
          instanceIndex: 0,
          hostname: 'host-a',
          registeredAt: '2026-03-05T00:00:00.000Z',
          lastHeartbeat: '2026-03-05T00:05:00.000Z',
          status: 'active',
          currentTask: {
            spec: 'spec-a',
            task: '1'
          }
        },
        'machine-b:0': {
          agentId: 'machine-b:0',
          machineId: 'machine-b',
          instanceIndex: 0,
          hostname: 'host-b',
          registeredAt: '2026-03-05T00:00:00.000Z',
          lastHeartbeat: '2026-03-05T00:04:00.000Z',
          status: 'inactive',
          currentTask: null
        }
      }
    }, { spaces: 2 });

    await fs.ensureDir(path.join(tempDir, '.sce', 'timeline'));
    await fs.writeJson(path.join(tempDir, '.sce', 'timeline', 'index.json'), {
      schema_version: '1.0',
      snapshots: [
        {
          snapshot_id: 'tl-1',
          created_at: '2026-03-05T00:10:00.000Z',
          trigger: 'manual',
          event: 'manual.save',
          summary: 'checkpoint',
          scene_id: 'scene.demo',
          session_id: 'sess-1',
          command: 'sce timeline save',
          file_count: 10,
          total_bytes: 1200,
          path: '.sce/timeline/snapshots/tl-1',
          git: {
            branch: 'main'
          }
        }
      ]
    }, { spaces: 2 });

    await fs.ensureDir(path.join(tempDir, '.sce', 'session-governance'));
    await fs.writeJson(path.join(tempDir, '.sce', 'session-governance', 'scene-index.json'), {
      schema_version: '1.0',
      scenes: {
        'scene.demo': {
          scene_id: 'scene.demo',
          cycles: [
            {
              cycle: 1,
              session_id: 'scene-demo-c1',
              status: 'completed',
              started_at: '2026-03-05T00:00:00.000Z',
              completed_at: '2026-03-05T00:20:00.000Z'
            },
            {
              cycle: 2,
              session_id: 'scene-demo-c2',
              status: 'active',
              started_at: '2026-03-05T00:30:00.000Z',
              completed_at: null
            }
          ]
        }
      }
    }, { spaces: 2 });
  }

  test('builds migration plan from file-based state artifacts', async () => {
    await seedFileBasedState();

    const plan = await buildStateMigrationPlan({}, {
      projectPath: tempDir,
      fileSystem: fs,
      env: { NODE_ENV: 'test' }
    });

    expect(plan.mode).toBe('state-plan');
    expect(plan.components).toHaveLength(3);
    expect(plan.components.find((item) => item.id === 'collab.agent-registry')).toEqual(expect.objectContaining({
      source_record_count: 2,
      status: 'ready'
    }));
    expect(plan.components.find((item) => item.id === 'runtime.timeline-index')).toEqual(expect.objectContaining({
      source_record_count: 1,
      status: 'ready'
    }));
    expect(plan.components.find((item) => item.id === 'runtime.scene-session-index')).toEqual(expect.objectContaining({
      source_record_count: 2,
      status: 'ready'
    }));
  });

  test('supports dry-run and apply migration, then exports sqlite indexes', async () => {
    await seedFileBasedState();

    const stateStore = new SceStateStore(tempDir, {
      fileSystem: fs,
      env: { NODE_ENV: 'test' },
      sqliteModule: {}
    });

    const dryRun = await runStateMigration({
      all: true,
      apply: false
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      env: { NODE_ENV: 'test' },
      stateStore
    });
    expect(dryRun.mode).toBe('state-migrate');
    expect(dryRun.apply).toBe(false);
    expect(dryRun.operations.every((item) => item.status === 'planned')).toBe(true);

    const applied = await runStateMigration({
      all: true,
      apply: true
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      env: { NODE_ENV: 'test' },
      stateStore
    });
    expect(applied.success).toBe(true);
    expect(applied.summary.migrated_components).toBe(3);
    expect(applied.summary.migrated_records).toBe(5);

    const doctor = await runStateDoctor({}, {
      projectPath: tempDir,
      fileSystem: fs,
      env: { NODE_ENV: 'test' },
      stateStore
    });
    expect(doctor.mode).toBe('state-doctor');
    expect(doctor.checks.every((item) => item.sync_status === 'synced')).toBe(true);
    expect(doctor.summary).toEqual(expect.objectContaining({
      total_components: 3,
      pending_components: 0,
      total_source_records: 5,
      total_sqlite_records: 5
    }));
    expect(doctor.runtime).toEqual(expect.objectContaining({
      timeline: expect.objectContaining({
        read_source: expect.any(String),
        consistency: expect.objectContaining({
          status: expect.any(String)
        })
      }),
      scene_session: expect.objectContaining({
        read_preference: expect.any(String),
        consistency: expect.objectContaining({
          status: expect.any(String)
        })
      })
    }));

    const exportPayload = await runStateExport({
      out: '.sce/reports/state-migration/export.json'
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      env: { NODE_ENV: 'test' },
      stateStore
    });
    expect(exportPayload.mode).toBe('state-export');
    expect(exportPayload.summary.agent_runtime_registry).toBe(2);
    expect(exportPayload.summary.timeline_snapshot_registry).toBe(1);
    expect(exportPayload.summary.scene_session_cycle_registry).toBe(2);
    expect(await fs.pathExists(path.join(tempDir, '.sce', 'reports', 'state-migration', 'export.json'))).toBe(true);
  });
});
