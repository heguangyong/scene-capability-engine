const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  runAuthGrantCommand,
  runAuthStatusCommand,
  runAuthRevokeCommand
} = require('../../../lib/commands/auth');

describe('auth command', () => {
  let tempDir;
  let originalLog;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-auth-cmd-'));
    originalLog = console.log;
    console.log = jest.fn();
  });

  afterEach(async () => {
    console.log = originalLog;
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  test('grants/status/revokes lease using sqlite-backed state store', async () => {
    const policyPath = path.join(tempDir, '.sce', 'config', 'authorization-policy.json');
    await fs.ensureDir(path.dirname(policyPath));
    await fs.writeJson(policyPath, {
      enabled: true,
      enforce_actions: ['studio:apply', 'task:rerun'],
      require_password_for_grant: true,
      password_env: 'SCE_AUTH_PASSWORD',
      allow_test_bypass: false
    }, { spaces: 2 });

    const env = {
      NODE_ENV: 'test',
      SCE_AUTH_PASSWORD: 'secret'
    };

    const granted = await runAuthGrantCommand({
      subject: 'alice',
      scope: 'studio:*,task:rerun',
      ttlMinutes: '15',
      reason: 'command-test',
      authPassword: 'secret',
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      env
    });

    expect(granted.mode).toBe('auth-grant');
    expect(granted.lease.lease_id).toMatch(/^lease-/);

    const status = await runAuthStatusCommand({
      lease: granted.lease.lease_id,
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      env
    });
    expect(status.mode).toBe('auth-status');
    expect(status.lease).toEqual(expect.objectContaining({
      lease_id: granted.lease.lease_id,
      subject: 'alice'
    }));

    const revoked = await runAuthRevokeCommand({
      lease: granted.lease.lease_id,
      reason: 'command-finished',
      json: true
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      env
    });
    expect(revoked.mode).toBe('auth-revoke');
    expect(revoked.lease.revoked_at).toBeTruthy();
  });
});
