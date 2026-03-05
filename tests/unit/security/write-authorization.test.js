const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  grantWriteAuthorizationLease,
  ensureWriteAuthorization,
  revokeWriteAuthorizationLease,
  collectWriteAuthorizationStatus
} = require('../../../lib/security/write-authorization');

describe('write-authorization', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-write-auth-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  test('requires lease for enforced action, then allows with granted lease', async () => {
    const policyPath = path.join(tempDir, '.sce', 'config', 'authorization-policy.json');
    await fs.ensureDir(path.dirname(policyPath));
    await fs.writeJson(policyPath, {
      enabled: true,
      enforce_actions: ['studio:apply'],
      require_password_for_grant: true,
      password_env: 'SCE_AUTH_PASSWORD',
      default_ttl_minutes: 15,
      max_ttl_minutes: 60,
      default_scope: ['project:*'],
      allow_test_bypass: false
    }, { spaces: 2 });

    const env = {
      NODE_ENV: 'test',
      SCE_AUTH_PASSWORD: 'top-secret'
    };

    await expect(ensureWriteAuthorization('studio:apply', {}, {
      projectPath: tempDir,
      fileSystem: fs,
      env
    })).rejects.toThrow('Write authorization required for studio:apply');

    const granted = await grantWriteAuthorizationLease({
      subject: 'alice',
      role: 'maintainer',
      scope: ['studio:*'],
      reason: 'unit-test',
      authPassword: 'top-secret'
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      env
    });
    expect(granted.lease.lease_id).toMatch(/^lease-/);

    const checked = await ensureWriteAuthorization('studio:apply', {
      authLease: granted.lease.lease_id
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      env
    });
    expect(checked.passed).toBe(true);
    expect(checked.lease_id).toBe(granted.lease.lease_id);

    const revoked = await revokeWriteAuthorizationLease(granted.lease.lease_id, {
      reason: 'done'
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      env
    });
    expect(revoked.lease.revoked_at).toBeTruthy();

    await expect(ensureWriteAuthorization('studio:apply', {
      authLease: granted.lease.lease_id
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      env
    })).rejects.toThrow('lease_revoked');
  });

  test('denies when lease scope does not match enforced action', async () => {
    const policyPath = path.join(tempDir, '.sce', 'config', 'authorization-policy.json');
    await fs.ensureDir(path.dirname(policyPath));
    await fs.writeJson(policyPath, {
      enabled: true,
      enforce_actions: ['studio:release'],
      require_password_for_grant: false,
      default_scope: ['project:*'],
      allow_test_bypass: false
    }, { spaces: 2 });

    const env = {
      NODE_ENV: 'test'
    };

    const granted = await grantWriteAuthorizationLease({
      subject: 'bob',
      role: 'maintainer',
      scope: ['task:rerun'],
      reason: 'unit-test'
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      env
    });

    await expect(ensureWriteAuthorization('studio:release', {
      authLease: granted.lease.lease_id
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      env
    })).rejects.toThrow('scope mismatch');

    const status = await collectWriteAuthorizationStatus({
      activeOnly: false,
      limit: 10,
      eventsLimit: 20
    }, {
      projectPath: tempDir,
      fileSystem: fs,
      env
    });

    expect(status.leases.length).toBeGreaterThanOrEqual(1);
    expect(status.events.some((event) => event.event_type === 'authorization.denied')).toBe(true);
  });
});
