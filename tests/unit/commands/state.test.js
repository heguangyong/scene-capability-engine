const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  runStatePlanCommand,
  runStateDoctorCommand,
  runStateMigrateCommand,
  runStateExportCommand
} = require('../../../lib/commands/state');
const { SceStateStore } = require('../../../lib/state/sce-state-store');

describe('state command', () => {
  let tempDir;
  let originalLog;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-state-command-'));
    originalLog = console.log;
    console.log = jest.fn();

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
          status: 'active'
        }
      }
    }, { spaces: 2 });
  });

  afterEach(async () => {
    console.log = originalLog;
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  test('runs plan/doctor/migrate/export command handlers', async () => {
    const stateStore = new SceStateStore(tempDir, {
      fileSystem: fs,
      env: { NODE_ENV: 'test' },
      sqliteModule: {}
    });

    const plan = await runStatePlanCommand({
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      env: { NODE_ENV: 'test' },
      stateStore
    });
    expect(plan.mode).toBe('state-plan');
    expect(plan.components.find((item) => item.id === 'collab.agent-registry')).toEqual(expect.objectContaining({
      source_record_count: 1
    }));

    const dryRun = await runStateMigrateCommand({
      all: true,
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      env: { NODE_ENV: 'test' },
      stateStore
    });
    expect(dryRun.apply).toBe(false);

    const applied = await runStateMigrateCommand({
      all: true,
      apply: true,
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      env: { NODE_ENV: 'test' },
      stateStore
    });
    expect(applied.success).toBe(true);

    const doctor = await runStateDoctorCommand({
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      env: { NODE_ENV: 'test' },
      stateStore
    });
    expect(doctor.mode).toBe('state-doctor');
    expect(doctor.summary).toEqual(expect.objectContaining({
      total_components: 3,
      alert_count: expect.any(Number)
    }));
    expect(doctor.runtime).toEqual(expect.objectContaining({
      timeline: expect.objectContaining({
        consistency: expect.objectContaining({
          status: expect.any(String)
        })
      }),
      scene_session: expect.objectContaining({
        consistency: expect.objectContaining({
          status: expect.any(String)
        })
      })
    }));

    const exported = await runStateExportCommand({
      out: '.sce/reports/state-migration/export.json',
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      env: { NODE_ENV: 'test' },
      stateStore
    });
    expect(exported.mode).toBe('state-export');
    expect(exported.summary.agent_runtime_registry).toBeGreaterThanOrEqual(1);
  });
});
