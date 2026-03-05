const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { runCliWithRetry } = require('./cli-runner');

function runCli(args, options = {}) {
  return runCliWithRetry(args, {
    cwd: options.cwd || process.cwd(),
    timeoutMs: options.timeoutMs || 15000,
    maxTransientRetries: options.maxTransientRetries || 1
  });
}

describe('legacy migration guard CLI integration', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sce-legacy-guard-cli-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  test('blocks non-migration commands when legacy .kiro directories exist', async () => {
    await fs.ensureDir(path.join(tempDir, '.kiro/steering'));
    await fs.writeFile(path.join(tempDir, '.kiro/steering/ENVIRONMENT.md'), '# legacy', 'utf8');

    const result = await runCli(['status'], { cwd: tempDir });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Legacy workspace migration required');
    expect(await fs.pathExists(path.join(tempDir, '.kiro'))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.sce'))).toBe(false);
  });

  test('allows legacy workspace scan and manual migration commands', async () => {
    await fs.ensureDir(path.join(tempDir, '.kiro/steering'));
    await fs.writeFile(path.join(tempDir, '.kiro/steering/ENVIRONMENT.md'), '# legacy', 'utf8');

    const scanResult = await runCli(['workspace', 'legacy-scan', '--json'], { cwd: tempDir });
    expect(scanResult.exitCode).toBe(0);
    const scanPayload = JSON.parse(`${scanResult.stdout}`.trim());
    expect(scanPayload.count).toBe(1);

    const blockedMigrate = await runCli(['workspace', 'legacy-migrate', '--json'], { cwd: tempDir });
    expect(blockedMigrate.exitCode).toBe(2);
    const blockedPayload = JSON.parse(`${blockedMigrate.stdout}`.trim());
    expect(blockedPayload.success).toBe(false);
    expect(blockedPayload.error).toContain('--confirm');
    expect(await fs.pathExists(path.join(tempDir, '.kiro'))).toBe(true);

    const migrateResult = await runCli(['workspace', 'legacy-migrate', '--confirm', '--json'], { cwd: tempDir });
    expect(migrateResult.exitCode).toBe(0);
    const migratePayload = JSON.parse(`${migrateResult.stdout}`.trim());
    expect(migratePayload.scanned).toBe(1);
    expect(migratePayload.migrated).toBe(1);
    expect(await fs.pathExists(path.join(tempDir, '.kiro'))).toBe(false);
    expect(await fs.pathExists(path.join(tempDir, '.sce/steering/ENVIRONMENT.md'))).toBe(true);
  });
});
